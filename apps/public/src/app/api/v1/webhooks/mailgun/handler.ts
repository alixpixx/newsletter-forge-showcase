import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalMessageId } from "@nf/config";
import type { Db } from "@/lib/supabase";
import { outboxRefFromEvent } from "@/lib/webhook-ref";

/**
 * Retours d'envoi Mailgun (rebonds, plaintes, livraisons, ouvertures, clics).
 *
 * ⛔ POURQUOI CETTE ROUTE EST INDISPENSABLE AVANT LE PREMIER ENVOI RÉEL. Sans elle, la liste de
 * suppression ne se remplit jamais : on continue d'écrire à des boîtes qui n'existent plus, chaque
 * passe accumule des rebonds durs, et la réputation du domaine expéditeur se dégrade jusqu'à ce que
 * les messages n'arrivent plus — y compris ceux des gens joignables. Une plainte pour spam non
 * traitée est pire encore : c'est le signal que les fournisseurs regardent en premier.
 *
 * ⛔ FAIL-CLOSED : SANS CLÉ DE SIGNATURE, ON REFUSE TOUT. La tentation serait d'accepter les
 * événements « en attendant » — ce serait ouvrir un point d'entrée public capable de SUPPRIMER
 * n'importe quelle adresse de la base : il suffirait de poster un faux rebond permanent pour empêcher
 * quelqu'un de recevoir la newsletter, silencieusement et sans trace. On répond donc 503 tant que la
 * clé manque, et le message le dit.
 *
 * ⛔ ON NE FAIT CONFIANCE À AUCUN CHAMP AVANT LA SIGNATURE. Le corps est lu, la signature vérifiée,
 * et seulement ensuite les données sont regardées. La comparaison est à temps constant : un `===`
 * sur une signature fuit sa valeur octet par octet à qui mesure les temps de réponse.
 *
 * ⚠️ CE QU'ON RÉPOND À UNE SIGNATURE INVALIDE : 406, et pas 401. Mailgun REJOUE tout ce qui n'est pas
 * un 2xx ou un 406 — répondre 401 lui ferait retenter un événement qui ne sera jamais valide, en
 * boucle, pendant huit heures. Le code qui dit « n'insiste pas » est 406.
 *
 * Module séparé de `route.ts` : la clé, la base et l'horloge y sont injectées, pour qu'un banc mesure
 * la route sans variable d'environnement ni réseau.
 */

export interface WebhookDeps {
  signingKey: string | undefined;
  /** Appelée seulement après la signature : une requête non signée ne touche jamais la base. */
  getDb: () => Db | null;
  /** Secondes Unix. */
  now: () => number;
}

/** Fenêtre de rejeu acceptée. Au-delà, une capture d'un événement ancien ne peut plus être rejouée. */
const MAX_AGE_SECONDS = 15 * 60;

/** Correspondance vocabulaire Mailgun → vocabulaire du produit (contrainte `email_event_type_check`). */
const TYPE: Record<string, string> = {
  delivered: "delivered",
  opened: "opened",
  clicked: "clicked",
  failed: "failed",
  complained: "complained",
  unsubscribed: "unsubscribed",
};

interface Signature {
  timestamp?: unknown;
  token?: unknown;
  signature?: unknown;
}

interface EventData {
  id?: unknown;
  event?: unknown;
  severity?: unknown;
  timestamp?: unknown;
  reason?: unknown;
  message?: { headers?: { "message-id"?: unknown } };
  "delivery-status"?: { message?: unknown; description?: unknown; code?: unknown };
  url?: unknown;
  "client-info"?: {
    "client-type"?: unknown;
    "client-name"?: unknown;
    "client-os"?: unknown;
    "device-type"?: unknown;
    bot?: unknown;
  };
  geolocation?: { country?: unknown; region?: unknown; city?: unknown };
}

/** Le détail d'un événement, tel qu'il est rangé dans `email_event` (0092). */
export interface DetailEvenement {
  url: string | null;
  device_type: string | null;
  client_type: string | null;
  client_name: string | null;
  client_os: string | null;
  bot: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
}

/** Texte court et propre, ou null : Mailgun écrit « Unknown » quand il ne sait pas, ce n'est pas une valeur. */
function texte(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t === "" || /^unknown$/i.test(t)) return null;
  return t.slice(0, max);
}

/**
 * Le détail d'une ouverture ou d'un clic (0092, demande d'Alix du 07/10/2026 : « le maximum d'info sur
 * tous mes envois ») : lien cliqué, appareil, client mail, système, marqueur de robot, géolocalisation.
 *
 * ⛔ JAMAIS L'IP (`event-data.ip`) ni l'user-agent complet : la ville et le client suffisent à
 * l'analyse, et chaque champ de plus est une donnée personnelle de plus à protéger et à effacer.
 * ⛔ Un lien n'est gardé que s'il est http(s) : une valeur arbitraire dans `url` ne doit pas finir
 * cliquable dans l'admin.
 */
export function detailEvenement(data: EventData): DetailEvenement {
  const ci = data["client-info"] ?? {};
  const geo = data.geolocation ?? {};
  const url = texte(data.url, 2000);
  return {
    url: url && /^https?:\/\//i.test(url) ? url : null,
    device_type: texte(ci["device-type"], 40)?.toLowerCase() ?? null,
    client_type: texte(ci["client-type"], 40)?.toLowerCase() ?? null,
    client_name: texte(ci["client-name"], 80),
    client_os: texte(ci["client-os"], 80),
    bot: texte(ci.bot, 40),
    country: texte(geo.country, 8)?.toUpperCase() ?? null,
    region: texte(geo.region, 80),
    city: texte(geo.city, 80),
  };
}

/** La colonne de détail manque-t-elle (base d'avant 0092) ? Forme de PostgREST, cf. `colonneRefusAbsente`. */
function colonneDetailAbsente(message: string): boolean {
  return /column/i.test(message) && /schema cache|does not exist/i.test(message)
    && /(url|device_type|client_type|client_name|client_os|bot|country|region|city)/.test(message);
}

/**
 * Cet échec dit-il « la boîte du destinataire est pleine » ?
 *
 * ⭐ Décision d'Alix (22/09/2026) : une boîte pleine est un rebond TEMPORAIRE, même quand Mailgun
 * l'annonce en `permanent`. Une boîte se vide ; une adresse qui n'existe pas, non.
 *
 * ⛔ LA LISTE EST VOLONTAIREMENT ÉTROITE. Elle ne reconnaît que la saturation, par le mot de Mailgun
 * (`overquota`), par les formulations des serveurs distants, et par les deux codes SMTP de la boîte
 * pleine (`4.2.2` temporaire, `5.2.2` que Hotmail et consorts renvoient pour la même chose).
 * Élargir ce filtre (« mailbox unavailable », « user unknown »…) ferait garder en liste des adresses
 * MORTES, et c'est exactement ce qui détruit la réputation d'envoi.
 */
export function boitePleine(reason: string | null, code?: unknown): boolean {
  const r = (reason ?? "").toLowerCase();
  // ⛔ Le code de réponse SMTP SEUL (452, 552) ne dit pas le motif : 552 sert aussi au message trop
  // gros. Seul le code ÉTENDU x.2.2 désigne la boîte pleine, et il vit dans le texte du refus.
  const codeEtendu = /(^|[^0-9])[45]\.2\.2([^0-9]|$)/.test(`${r} ${String(code ?? "")}`);
  return (
    codeEtendu ||
    r.includes("overquota") ||
    r.includes("over quota") ||
    r.includes("quota exceeded") ||
    r.includes("exceeded storage") ||
    r.includes("mailbox full") ||
    r.includes("mailbox is full") ||
    r.includes("insufficient storage")
  );
}

/**
 * ⭐ SEUIL DE REBONDS MOUS (migration 0081) : 4 MESSAGES distincts en échec temporaire, sans aucune
 * livraison réussie entre eux, suppriment l'adresse POUR CETTE MARQUE (valeur par défaut du plan
 * Automations, 24/09/2026).
 *
 * ⛔ DES MESSAGES, PAS DES ÉVÉNEMENTS. Mailgun retente un même message pendant des heures et émet un
 * échec temporaire à CHAQUE tentative : compter les événements supprimerait quelqu'un pour une seule
 * panne d'une nuit. Un rejeu du webhook, lui, ne crée même pas de ligne (doublon `23505`).
 *
 * ⭐ La suppression est LEVÉE par une réinscription CONFIRMÉE sur cette marque (0081 §4) : la
 * personne ne peut confirmer qu'en recevant le lien, donc son clic prouve que la boîte reçoit de
 * nouveau. Le motif commence par `soft_bounce:` — c'est ce préfixe exact que la base reconnaît.
 */
export const SEUIL_REBONDS_MOUS = 4;

/**
 * Lignes relues au plus pour compter. Au-delà du seuil le détail n'importe plus : 200 échecs
 * couvrent au moins une quinzaine de messages même à 12 tentatives chacun, bien plus que 4.
 */
const LECTURE_REBONDS_MAX = 200;

/**
 * Recalcule le compteur de rebonds mous d'une souscription, l'écrit, et supprime au seuil.
 *
 * ⛔ LE COMPTEUR EST DÉRIVÉ, JAMAIS INCRÉMENTÉ. Il vaut le nombre de messages distincts en échec
 * temporaire DEPUIS LA DERNIÈRE LIVRAISON, relu dans `email_event` à chaque échec. Un `+1` compterait
 * deux fois un événement rejoué (après un 500 de notre part, Mailgun renvoie le même) et ne saurait
 * pas qu'une livraison a eu lieu entre-temps ; le recalcul donne le même résultat autant de fois
 * qu'on le rejoue. C'est aussi lui seul qui décide la suppression : la valeur stockée n'est qu'une
 * lecture commode pour l'admin et les automations.
 *
 * ⭐ REMISE À ZÉRO — TRANCHÉ LE 24/09/2026 :
 *   — une LIVRAISON remet à zéro : elle prouve que la boîte reçoit de nouveau, et quatre pannes
 *     espacées de plusieurs mois ne disent pas qu'une adresse est morte ;
 *   — un rebond DUR ne remet PAS à zéro : c'est un échec de plus, pas une preuve de vie, et l'adresse
 *     vient de toute façon d'être supprimée par le chemin des rebonds durs.
 */
async function compterRebondsMous(
  db: Db,
  outbox: { subscription_id: string; asset_id: string | null; to_email: string },
  reason: string | null,
): Promise<string | null> {
  const sub = outbox.subscription_id;
  const { data: livraisons, error: e1 } = await db
    .from("email_event")
    .select("occurred_at")
    .eq("subscription_id", sub)
    .eq("type", "delivered")
    .order("occurred_at", { ascending: false })
    .limit(1);
  if (e1) return `soft bounce count failed: ${e1.message}`;
  // Aucune livraison : NaN, et tout échec compte.
  const depuis = Date.parse(String((livraisons as { occurred_at?: unknown }[] | null)?.[0]?.occurred_at ?? ""));

  const { data: echecs, error: e2 } = await db
    .from("email_event")
    .select("outbox_id, occurred_at")
    .eq("subscription_id", sub)
    .eq("type", "failed")
    .eq("severity", "temporary")
    .order("occurred_at", { ascending: false })
    .limit(LECTURE_REBONDS_MAX);
  if (e2) return `soft bounce count failed: ${e2.message}`;

  // ⚠️ Les dates sont comparées en valeur, jamais en texte : la base les rend en `+00:00`, le
  // webhook les écrit en `Z` — deux écritures d'un même instant qui ne se trient pas pareil.
  const messages = new Set<string>();
  for (const e of (echecs as { outbox_id?: unknown; occurred_at?: unknown }[] | null) ?? []) {
    if (Number.isFinite(depuis) && !(Date.parse(String(e.occurred_at)) > depuis)) continue;
    // `outbox_id` et `subscription_id` viennent de la même ligne d'origine : l'un n'existe pas sans l'autre.
    messages.add(String(e.outbox_id));
  }
  const n = messages.size;

  const { error: e3 } = await db.from("subscription").update({ soft_bounce_count: n }).eq("id", sub);
  if (e3) return `soft bounce count write failed: ${e3.message}`;

  if (n >= SEUIL_REBONDS_MOUS && outbox.to_email) {
    const { error: e4 } = await db.rpc("suppress", {
      p_email: outbox.to_email,
      p_asset_id: outbox.asset_id,
      p_reason: `soft_bounce:${n}:${reason ?? "unknown"}`.slice(0, 200),
      // Comme le rebond dur : l'échec tient au domaine d'envoi de CETTE marque.
      p_scope: "asset",
    });
    if (e4) return `soft bounce suppression failed: ${e4.message}`;
  }
  return null;
}

/**
 * Une livraison remet le compteur à zéro. Écriture CONDITIONNELLE : presque toutes les souscriptions
 * sont déjà à zéro, et la requête ne touche alors aucune ligne.
 *
 * ⚠️ Une livraison qui arrive APRÈS un échec plus récent qu'elle (ordre d'arrivée ≠ ordre des faits)
 * remet la valeur affichée à zéro un peu tôt ; le prochain échec la recalcule depuis les faits, et la
 * suppression, qui ne décide que sur ce recalcul, n'en est jamais faussée.
 */
async function remettreRebondsMousAZero(db: Db, subscriptionId: string): Promise<string | null> {
  const { error } = await db
    .from("subscription")
    .update({ soft_bounce_count: 0 })
    .eq("id", subscriptionId)
    .neq("soft_bounce_count", 0);
  return error ? `soft bounce reset failed: ${error.message}` : null;
}

function ok() {
  // 200 SEC, sans corps utile : Mailgun ne lit que le code, et tout ce qu'on renverrait d'autre
  // finirait dans les journaux d'un tiers.
  return NextResponse.json({ ok: true });
}

/** Comparaison à temps constant, longueurs incluses. */
function sameSignature(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export async function handleMailgunWebhook(req: Request, deps: WebhookDeps): Promise<Response> {
  const key = deps.signingKey;
  if (!key || key.trim() === "") {
    return NextResponse.json(
      {
        error:
          "MAILGUN_WEBHOOK_SIGNING_KEY is not set — this endpoint can suppress addresses, so it refuses " +
          "unsigned traffic. Set the signing key from the Mailgun dashboard and redeploy.",
      },
      { status: 503 },
    );
  }

  let body: { signature?: Signature; "event-data"?: EventData };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const sig = body.signature ?? {};
  const timestamp = String(sig.timestamp ?? "");
  const token = String(sig.token ?? "");
  const signature = String(sig.signature ?? "");
  if (timestamp === "" || token === "" || signature === "") {
    return NextResponse.json({ error: "missing signature block" }, { status: 406 });
  }

  // Rejeu : un événement capturé hier ne doit pas pouvoir être renvoyé aujourd'hui.
  const age = Math.abs(deps.now() - Number(timestamp));
  if (!Number.isFinite(age) || age > MAX_AGE_SECONDS) {
    return NextResponse.json({ error: "signature timestamp is outside the accepted window" }, { status: 406 });
  }

  const expected = createHmac("sha256", key).update(timestamp + token).digest("hex");
  if (!sameSignature(expected, signature)) {
    return NextResponse.json({ error: "signature mismatch" }, { status: 406 });
  }

  const data = body["event-data"] ?? {};
  const raw = String(data.event ?? "");
  const severity = String(data.severity ?? "");
  const reason =
    String(data.reason ?? "") ||
    String(data["delivery-status"]?.message ?? "") ||
    String(data["delivery-status"]?.description ?? "") ||
    null;
  // Mailgun n'a pas d'événement « bounced » : il envoie `failed` avec une sévérité. Un échec
  // PERMANENT est un rebond dur (la boîte n'existe pas) ; un échec temporaire est un serveur
  // indisponible, et supprimer quelqu'un pour ça le priverait de la newsletter pour toujours à
  // cause d'une panne d'une heure.
  //
  // ⭐ SAUF LA BOÎTE PLEINE, DÉCISION D'ALIX DU 22/09/2026 (« oui traite ca comme un rebond
  // temporaire »), après un cas réel : une adresse hotmail bloquée définitivement sur Northwind Sports pour
  // `overquota`. Mailgun annonce parfois ce cas en `permanent` — le serveur distant répond 552 5.2.2
  // au lieu de 452 4.2.2 — alors qu'une boîte saturée se vide : c'est le seul motif « permanent »
  // qu'on rétrograde. ⛔ Conséquence si on ne le fait pas : la personne ne reçoit plus rien ET ne
  // peut plus se réinscrire elle-même, un rebond dur restant DUR pour `is_hard_suppressed` (0073,
  // 0081 : seuls l'effacement, la désinscription globale et les rebonds mous sont levables).
  const permanent = severity === "permanent" && !boitePleine(reason, data["delivery-status"]?.code);
  const type = raw === "failed" && permanent ? "bounced" : (TYPE[raw] ?? null);
  if (!type) {
    // Un événement qu'on ne sait pas nommer est ACQUITTÉ (sinon Mailgun le rejoue huit heures) mais
    // pas inventé : on ne l'écrit pas sous un type approchant.
    return ok();
  }

  const eventId = String(data.id ?? `${timestamp}:${token}`);
  // ⛔ MÊME NORMALISATION QU'À L'ÉCRITURE (`@nf/config`), sinon l'égalité ci-dessous ne mord jamais.
  const messageId = canonicalMessageId(data.message?.headers?.["message-id"]);
  const occurredAt = new Date((Number(data.timestamp) || deps.now()) * 1000).toISOString();

  const db = deps.getDb();
  if (!db) return NextResponse.json({ error: "database unavailable" }, { status: 503 });

  /*
   * La ligne d'origine porte le destinataire, la marque et la campagne : c'est elle qui donne son
   * contexte à l'événement, et c'est pour ça qu'aucune adresse n'est stockée dans `email_event`.
   *
   * ⛔ ON CHERCHE D'ABORD PAR CE QU'ON A ÉCRIT SOI-MÊME. Le worker envoie l'identifiant de la ligne
   * à Mailgun (`process.ts`, `vars.outbox_id` → `mailgun.ts`, champ `v:outbox_id`) et Mailgun le
   * renvoie dans `user-variables` : c'est une clé primaire, pas une chaîne recopiée. Le message-id
   * reste le repli, pour les envois antérieurs à cette variable et pour tout ce qui n'en porte pas.
   * La décision est prise par `outboxRefFromEvent`, à part et sous banc — voir le pourquoi là-bas.
   *
   * ⛔ ON CHERCHE LES DEUX FORMES du message-id. La normalisation à l'écriture ne vaut que pour les
   * envois postérieurs au correctif de 5C.0 ; les lignes plus anciennes portent la forme brute avec
   * ses chevrons. Chercher la seule forme canonique perdrait leur contexte en silence — l'événement
   * s'écrirait quand même, rattaché à personne.
   *
   * ⛔ Et on ne cherche RIEN quand il n'y a aucune clé : `provider_message_id = ''` a l'air d'une
   * requête légitime et ramènerait n'importe quelle ligne future dont la colonne serait vide.
   */
  const ref = outboxRefFromEvent(data, messageId);
  const COLS = "id, asset_id, subscription_id, campaign_id, occurrence_id, to_email";
  const { data: outboxRows } = ref
    ? ref.by === "user_variable"
      ? await db.from("email_outbox").select(COLS).eq("id", ref.outboxId).limit(1)
      : await db
          .from("email_outbox")
          .select(COLS)
          .or(`provider_message_id.eq.${ref.messageId},provider_message_id.eq.<${ref.messageId}>`)
          .limit(1)
    : { data: null };
  const outbox = ((outboxRows as unknown[]) ?? [])[0] as
    | {
        id: string;
        asset_id: string | null;
        subscription_id: string | null;
        campaign_id: string | null;
        occurrence_id: string | null;
        to_email: string;
      }
    | undefined;

  const ligne = {
    outbox_id: outbox?.id ?? null,
    subscription_id: outbox?.subscription_id ?? null,
    asset_id: outbox?.asset_id ?? null,
    campaign_id: outbox?.campaign_id ?? null,
    occurrence_id: outbox?.occurrence_id ?? null,
    type,
    // ⛔ LA MÊME DÉCISION QUE CI-DESSUS, PAS LA SÉVÉRITÉ BRUTE : sinon l'écran de délivrabilité
    // compterait en rebond dur une boîte pleine qu'on vient de traiter comme passagère.
    severity: raw === "failed" ? (permanent ? "permanent" : "temporary") : null,
    provider_event_id: eventId,
    provider_message_id: messageId || null,
    reason,
    occurred_at: occurredAt,
    payload: { event: raw, severity: severity || null },
  };
  let { error: insertError } = await db.from("email_event").insert({ ...ligne, ...detailEvenement(data) });
  // ⛔ Base d'avant 0092 : on écrit l'événement SANS son détail plutôt que de le perdre (un 500 ici
  // ferait rejouer Mailgun huit heures sur une colonne qui n'existera pas plus au huitième essai).
  if (insertError && colonneDetailAbsente(insertError.message)) {
    ({ error: insertError } = await db.from("email_event").insert(ligne));
  }

  // Toute erreur autre qu'un doublon doit faire réessayer : perdre un rebond en silence, c'est garder
  // une adresse morte dans la base.
  if (insertError && insertError.code !== "23505") {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  /*
   * ⛔ UN DOUBLON N'EST PAS UNE ERREUR — ET IL NE DISPENSE PAS DE LA SUPPRESSION. Mailgun rejoue un
   * événement déjà enregistré dans deux cas : il l'a doublé de lui-même, ou NOTRE réponse précédente
   * était un 500 parce que la suppression avait échoué. Acquitter le doublon avant d'arriver ici
   * (comme jusqu'au 16/09/2026) rendait ce second cas définitif : l'événement était archivé, la
   * suppression jamais rejouée, et l'adresse resservie à la campagne suivante. `suppress()` est
   * idempotente depuis 0070 : la rejouer sur un doublon ne crée rien de plus.
   *
   * Ce qui suit un REBOND DUR ou une PLAINTE : la suppression — la seule partie de ce fichier qui
   * protège la réputation d'envoi. Un rebond TEMPORAIRE ne supprime personne.
   */
  if ((type === "bounced" || type === "complained") && outbox?.to_email) {
    const { error: suppressError } = await db.rpc("suppress", {
      p_email: outbox.to_email,
      p_asset_id: outbox.asset_id,
      p_reason: type === "complained" ? "spam_complaint" : `hard_bounce:${reason ?? "unknown"}`.slice(0, 200),
      // Une PLAINTE vaut pour toutes les marques : quelqu'un qui nous signale comme spam ne veut
      // plus rien recevoir de nous, pas seulement de ce titre-là. Un rebond, lui, est propre au
      // domaine d'envoi utilisé.
      p_scope: type === "complained" ? "global" : "asset",
    });
    // La suppression a échoué : on renvoie une erreur pour que Mailgun REJOUE. Le rejeu retombera
    // sur le doublon ci-dessus, et repassera ici.
    if (suppressError) {
      return NextResponse.json({ error: `event stored but suppression failed: ${suppressError.message}` }, { status: 500 });
    }
  }

  /*
   * REBONDS MOUS (0081). Un échec TEMPORAIRE ne supprime personne à lui seul, mais il compte : voir
   * `compterRebondsMous` pour la règle et `SEUIL_REBONDS_MOUS` pour le seuil. `failed` n'arrive ici
   * que non permanent — le permanent est devenu `bounced` plus haut.
   *
   * ⛔ Même doctrine que la suppression ci-dessus : un échec rend 500 pour que Mailgun REJOUE, et le
   * rejeu, qui retombe sur le doublon, recalcule le même nombre — aucun effet n'est appliqué deux fois.
   */
  if (outbox?.subscription_id && (type === "failed" || type === "delivered")) {
    const echec =
      type === "failed"
        ? await compterRebondsMous(db, { ...outbox, subscription_id: outbox.subscription_id }, reason)
        : await remettreRebondsMousAZero(db, outbox.subscription_id);
    if (echec) return NextResponse.json({ error: `event stored but ${echec}` }, { status: 500 });
  }

  return ok();
}
