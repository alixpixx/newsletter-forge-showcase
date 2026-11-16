import { NextResponse } from "next/server";
import type { Db } from "@/lib/supabase";
import { isUuid } from "@/lib/uuid";
import { ALL_PURPOSES } from "@nf/config";
import { choisirAccuseGlobal, mettreEnFileAccuse } from "@/lib/accuse-desabonnement";
import { resoudreAbonnePrefs } from "@/lib/abonne-prefs";

/**
 * Centre de préférences + droits DSAR (chantier C3 du plan compliance).
 * Identité prouvée par un token HMAC signé par abonné (émis dans le footer des emails).
 * Actions :
 *  - set_asset   : (dés)activer une marque (opt-in/opt-out réversible par marque)
 *  - unsub_all   : opt-out GLOBAL (toutes marques) + suppression permanente
 *  - export      : droit d'accès / portabilité → renvoie les données de l'abonné
 *  - erase       : droit à l'oubli → pseudonymise (preuve de consentement préservée) + suppression
 *
 * Module séparé de `route.ts` (22/09/2026) : la base et la vérification du jeton y sont injectées,
 * pour qu'un banc mesure qui reçoit l'accusé de désinscription sans secret ni réseau — même partage
 * que le webhook Mailgun. `@/lib/tokens` n'est pas importé ici : il vérifie le secret au chargement.
 */
export interface PreferencesDeps {
  getDb: () => Db | null;
  verifyPrefs: (token: string | undefined | null) => string | null;
}

/**
 * ⛔ LA DÉSINSCRIPTION D'UNE MARQUE SE DÉCIDE DANS L'ÉCRITURE (22/09/2026). Même doctrine que
 * `lib/desabonnement.ts` : un `select` puis un `update` laisse deux clics croisés lire `active` et
 * gagner tous les deux — soit, depuis que ce geste met en file un accusé, DEUX accusés. La condition
 * vit donc dans l'instruction ; Postgres ré-évalue le WHERE après le premier UPDATE, un seul
 * appelant voit une ligne revenir, et lui seul accuse.
 *
 * ⛔ `deleted` N'EST JAMAIS RÉÉCRIT. Une personne effacée garde un jeton de préférences valide dans
 * ses vieux e-mails ; sans ce `.neq`, couper « Newsletter » la faisait repasser `unsubscribed`, et
 * l'accusé serait parti vers `erased+…@deleted.invalid`, qu'aucune suppression ne couvre.
 *
 * Rend vrai quand CE geste a fait passer la souscription à `unsubscribed`.
 */
async function desinscrireSiActive(db: Db, subscriptionId: string, champs: Record<string, unknown>): Promise<boolean> {
  const { data } = await db
    .from("subscription")
    .update({ ...champs, status: "unsubscribed" })
    .eq("id", subscriptionId)
    .neq("status", "unsubscribed")
    .neq("status", "deleted")
    .select("id");
  return ((data as unknown[] | null) ?? []).length > 0;
}

/**
 * ⭐ LE RETOUR SE DÉCIDE DANS L'ÉCRITURE, comme la désinscription (24/09/2026). Rallumer « Newsletter »
 * sur une souscription `unsubscribed` est un RETOUR : il se trace `resubscribe` (méthode
 * `preference_center`), l'événement que lit l'automation « Welcome back » (0082) — sans lui, ces
 * retours lui échappaient. La condition vit dans l'instruction : deux clics croisés ne tracent qu'un
 * retour, et une souscription `pending`, déjà active ou effacée n'en trace jamais (pour « Welcome
 * back », ce serait accueillir de nouveau quelqu'un qui n'est jamais parti).
 *
 * Rend vrai quand CE geste a fait passer la souscription de `unsubscribed` à `active`.
 */
async function reabonnerSiDesinscrite(db: Db, subscriptionId: string, champs: Record<string, unknown>): Promise<boolean> {
  const { data } = await db
    .from("subscription")
    .update({ ...champs, status: "active" })
    .eq("id", subscriptionId)
    .eq("status", "unsubscribed")
    .select("id");
  return ((data as unknown[] | null) ?? []).length > 0;
}

/**
 * ⛔ UN EFFACEMENT EST DÉFINITIF (décision du 22/09/2026). Aucune écriture de ce centre ne ramène
 * une souscription `deleted` à un autre statut, ni ne la retouche.
 *
 * POURQUOI C'ÉTAIT ATTEIGNABLE. Le jeton de préférences est un HMAC SANS ÉTAT ni date
 * (`packages/tokens/src/index.ts`, `signPrefs`/`verifyScoped`) : rien ne le révoque. Et
 * `erase_subscriber` (0006) GARDE la ligne `subscriber` — pseudonymisée — et passe les souscriptions à
 * `deleted` sans les supprimer. Un vieux lien de pied de page rouvrait donc l'écran, l'interrupteur
 * « Newsletter » était encore là, et le rallumer écrivait `status = 'active'` sur la souscription
 * effacée : les campagnes seraient reparties vers `erased+…@deleted.invalid`, qu'aucune suppression ne
 * couvre, avec une trace `granted` (IP, user-agent) dans le dossier d'une personne qui a demandé
 * l'oubli.
 *
 * Qui veut revenir passe par le formulaire public, qui crée une NOUVELLE souscription `pending`
 * (0073) — jamais en ressuscitant la ligne effacée.
 *
 * La condition vit dans l'écriture (`.neq('status','deleted')`), comme pour la désinscription. Rend
 * vrai si l'écriture a porté ; faux si la ligne est effacée (ou a disparu) — l'appelant ne trace
 * alors RIEN et répond ce qu'il répond à un geste sans effet, pour ne pas dire qu'un effacement a
 * eu lieu.
 */
async function ecrireSaufEffacee(db: Db, subscriptionId: string, champs: Record<string, unknown>): Promise<boolean> {
  const { data } = await db
    .from("subscription")
    .update(champs)
    .eq("id", subscriptionId)
    .neq("status", "deleted")
    .select("id");
  return ((data as unknown[] | null) ?? []).length > 0;
}

/**
 * La réponse d'un geste qui n'a rien changé. ⛔ LA MÊME, AU CARACTÈRE PRÈS, que celle d'un geste
 * réussi : une réponse propre aux souscriptions effacées apprendrait à qui tient le lien qu'un
 * effacement a eu lieu.
 */
const sansEffet = () => NextResponse.json({ ok: true });

/**
 * L'erreur dit-elle « la colonne du refus n'existe pas » (base d'avant 0092) ? Forme de PostgREST :
 * « Could not find the 'tracking_refused_at' column of 'subscription' in the schema cache ».
 * ⛔ Étroit exprès : toute AUTRE erreur sur cette écriture est un refus perdu, donc un 500.
 */
export function colonneRefusAbsente(message: string): boolean {
  return /tracking_refused_at/.test(message) && /column/i.test(message) && /schema cache|does not exist/i.test(message);
}

export async function handlePreferences(req: Request, deps: PreferencesDeps): Promise<Response> {
  const db = deps.getDb();
  if (!db) return NextResponse.json({ error: "service-indisponible" }, { status: 503 });

  let body: {
    token?: string; action?: string; asset_id?: string; active?: boolean; purpose?: string;
    /** Édition visée (lot E-1). Absente = la souscription la plus récente de la marque. */
    edition_id?: string;
    /** `email_outbox.id` de la relance d'où vient le lien (action `engagement`, lot 5C.6). */
    ls?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "requête invalide" }, { status: 400 });
  }

  /*
   * ⛔ LE JETON D'UN ABONNÉ EFFACÉ EST MORT (22/09/2026) — contrôlé ICI, une fois, avant toute
   * action : `resoudreAbonnePrefs` rend alors « invalide », et la réponse est celle d'un jeton faux,
   * au caractère près. Aucune action ne tourne, donc aucune écriture : ni statut, ni finalité, ni
   * suivi, ni trace, ni suppression, ni DSAR, ni e-mail. Les gardes `.neq('status','deleted')` plus
   * bas restent, en seconde ligne.
   */
  const resolu = await resoudreAbonnePrefs(db, body.token, deps.verifyPrefs, "email, first_name, created_at");
  if (resolu.etat === "invalide") return NextResponse.json({ error: "lien-invalide" }, { status: 403 });
  if (resolu.etat === "inconnu") return NextResponse.json({ error: "introuvable" }, { status: 404 });
  const subscriber = resolu.abonne;
  const subscriberId = subscriber.id;
  const email = subscriber.email as string;

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || null;
  const ua = req.headers.get("user-agent") || null;

  /**
   * Souscription visée par une action du centre de préférences.
   *
   * ⛔ POURQUOI CE N'EST PLUS UN `maybeSingle()` SUR `asset_id`. Depuis le lot E-1 (migration 0026),
   * une personne peut être abonnée à PLUSIEURS éditions du même domaine — `atlas-review.example` en
   * portugais et `atlas-review.example/cl/` en espagnol sont deux listes. `maybeSingle()` LÈVE quand
   * deux lignes correspondent : les trois actions de cet écran seraient tombées en erreur pour
   * exactement les personnes qui ont deux abonnements.
   *
   * Sans `edition_id`, on agit donc sur la souscription la plus récente de la marque plutôt que de
   * refuser — mais l'appelant DOIT préciser l'édition dès que l'écran en propose plusieurs, sinon
   * il désabonne une liste que la personne n'a pas désignée.
   */
  /*
   * ⛔ UN CONTACT HORS NEWSLETTER (0088) N'EST PAS UNE SOUSCRIPTION RÉGLABLE ICI. Rallumer
   * « Newsletter » écrit `status = 'active'` : sur une ligne `contact`, ce serait une inscription à la
   * newsletter SANS double opt-in, faite par un interrupteur. L'écran ne la liste pas non plus
   * (`preferences/vue.tsx`) ; se désinscrire reste possible par le lien de l'e-mail et par
   * « Unsubscribe from all brands », qui ne passent pas par ici.
   */
  const trouverSouscription = async (cols: string, assetId: string, editionId?: string | null) => {
    let q = db.from("subscription").select(cols).eq("subscriber_id", subscriberId).eq("asset_id", assetId)
      .neq("status", "contact");
    if (editionId) q = q.eq("edition_id", editionId);
    const { data } = await q.order("created_at", { ascending: false }).limit(1);
    const rows = (data ?? []) as unknown[];
    return rows.length > 0 ? (rows[0] as Record<string, unknown>) : null;
  };

  /** Colonnes dont l'accusé a besoin : la langue de la souscription et le nom de la marque. */
  const COLS_ACCUSE = "language, asset_id, asset:asset_id(name)";

  /**
   * L'accusé d'une désinscription que CE geste a réellement faite. Toujours APRÈS l'écriture ; ne
   * lève jamais et ne change jamais la réponse (voir `lib/accuse-desabonnement.ts`).
   */
  const accuser = (s: Record<string, unknown>, origine: string) =>
    mettreEnFileAccuse(db, {
      subscriptionId: s.id as string,
      assetId: (s.asset_id as string | null) ?? null,
      email,
      marque: (s.asset as { name?: string } | null)?.name,
      langue: s.language as string | null,
      origine,
    });

  const maintenant = new Date().toISOString();

  /**
   * Marquer une souscription comme « la personne s'est manifestée ».
   *
   * ⛔ LES DEUX COLONNES, ET PAS UNE SEULE. `last_response_at` est la source durable : c'est le
   * signal de PREMIÈRE PARTIE, et `recompute_engagement` (0061) le relit sans jamais l'écraser.
   * `last_engagement_at`, lui, est un agrégat que ce même recalcul réécrit — on le pose quand même
   * ici pour qu'il soit juste TOUT DE SUITE : entre la réaction et la prochaine passe du worker,
   * c'est cette colonne que `select_reengagement_candidates` (0058) interroge, et sans elle on
   * relancerait quelqu'un qui vient précisément de répondre.
   */
  const marquerReaction = (subscriptionId: string) =>
    db.from("subscription")
      .update({ last_response_at: maintenant, last_engagement_at: maintenant })
      .eq("id", subscriptionId);

  switch (body.action) {
    /* --- la personne a OUVERT cet écran depuis une relance (lot 5C.6) --- */
    case "engagement": {
      /**
       * ⛔ POURQUOI CETTE ACTION EST UN POST DÉCLENCHÉ PAR LE NAVIGATEUR, ET NON LE GET DE LA PAGE.
       * Les antivirus de messagerie et les préchargeurs de liens suivent les URL d'un e-mail sans
       * qu'aucun humain n'ait rien fait. Écrire la réaction au rendu de la page compterait ces
       * robots comme des réponses — la panne exacte des ouvertures Apple MPP, transposée au seul
       * signal qui nous reste. Exiger l'exécution du JS ne prouve pas un humain, mais écarte ces
       * deux-là.
       *
       * ⛔ `ls` NE DONNE AUCUN DROIT. C'est un `email_outbox.id`, déjà transmis à Mailgun en
       * `v:outbox_id` : rien de secret, et rien d'exploitable — la relance désignée doit appartenir
       * à l'abonné que le jeton HMAC prouve, sinon on n'écrit rien. Un tiers qui devinerait un id
       * ne pourrait donc marquer que ses propres relances.
       *
       * Silencieux par construction : sans `ls` utilisable, on répond `ok` sans rien écrire. Cet
       * appel ne doit jamais faire échouer l'affichage de l'écran.
       */
      if (!isUuid(body.ls)) return NextResponse.json({ ok: true, recorded: false });

      const { data: sends } = await db
        .from("lifecycle_send").select("id, subscription_id, responded_at")
        .eq("outbox_id", body.ls.trim()).limit(1);
      const send = (sends ?? [])[0];
      if (!send) return NextResponse.json({ ok: true, recorded: false });

      // ⛔ Deux requêtes explicites, jamais un embed PostgREST : la propriété se vérifie, elle ne
      // se déduit pas d'une relation dont la résolution peut rendre `null` sans lever.
      const { data: own } = await db
        .from("subscription").select("id")
        .eq("id", send.subscription_id).eq("subscriber_id", subscriberId).maybeSingle();
      if (!own) return NextResponse.json({ ok: true, recorded: false });

      // ⛔ `.is(null)` EN PLUS du test : deux onglets ouverts en même temps écriraient deux fois, et
      // la seconde écriture ferait reculer la date de première réaction — la seule qui nous
      // intéresse. La condition est donc portée par la base, pas par le raisonnement.
      if (!send.responded_at) {
        await db.from("lifecycle_send")
          .update({ responded_at: maintenant }).eq("id", send.id).is("responded_at", null);
      }
      await marquerReaction(send.subscription_id as string);
      return NextResponse.json({ ok: true, recorded: true });
    }

    /* --- (dés)activer une marque --- */
    case "set_asset": {
      if (!body.asset_id) return NextResponse.json({ error: "asset-requis" }, { status: 422 });
      const sub = await trouverSouscription(`id, status, ${COLS_ACCUSE}`, body.asset_id, body.edition_id);
      if (!sub) return NextResponse.json({ error: "souscription-introuvable" }, { status: 404 });
      const active = body.active === true;
      // ⚠️ L'écran ne l'appelle plus (il passe par `set_purpose` / `content`), mais la route reste
      // ouverte : la même règle d'accusé s'y applique, pour qu'aucune porte n'en envoie deux.
      // ⛔ Rallumer ou éteindre une souscription EFFACÉE ne porte pas : rien n'est tracé (voir
      // `ecrireSaufEffacee`). Déjà désinscrite, l'extinction se réécrit à l'identique et se trace,
      // comme avant.
      let desinscrit = false;
      if (active) {
        if (!(await ecrireSaufEffacee(db, sub.id as string, { status: "active" }))) return sansEffet();
      } else {
        desinscrit = await desinscrireSiActive(db, sub.id as string, {});
        if (!desinscrit && !(await ecrireSaufEffacee(db, sub.id as string, { status: "unsubscribed" }))) {
          return sansEffet();
        }
      }
      await db.from("consent_event").insert({
        subscription_id: sub.id, event_type: active ? "resubscribe" : "unsubscribe",
        ip_address: ip, user_agent: ua, method: "preference_center",
      });
      // Un geste explicite est la plus forte réaction qui soit — y compris quand il retire un
      // consentement : la personne s'est manifestée, c'est ce que cette date dit, et rien d'autre.
      await marquerReaction(sub.id as string);
      if (desinscrit) await accuser(sub, "preference_center");
      return NextResponse.json({ ok: true });
    }

    /* --- (dés)activer UNE finalité (content = maître, pilote le statut) --- */
    case "set_purpose": {
      const purpose = body.purpose;
      if (!body.asset_id || !purpose || !(ALL_PURPOSES as readonly string[]).includes(purpose)) {
        return NextResponse.json({ error: "params" }, { status: 422 });
      }
      const sub = await trouverSouscription(`id, granted_purposes, ${COLS_ACCUSE}`, body.asset_id, body.edition_id);
      if (!sub) return NextResponse.json({ error: "souscription-introuvable" }, { status: 404 });
      const active = body.active === true;
      const granted = { ...((sub.granted_purposes ?? {}) as Record<string, boolean>), [purpose]: active };
      /*
       * `content` (newsletter cœur) = maître : off → marque en pause ; on → réactivée.
       *
       * ⛔ « OFF » EST LE VRAI BOUTON DE DÉSINSCRIPTION DE L'ÉCRAN, donc celui qui accuse (22/09).
       * La bascule est conditionnelle (`desinscrireSiActive`) : un second clic, ou une souscription
       * déjà désinscrite par le lien d'un e-mail, ne passe pas — et n'accuse rien. La finalité, elle,
       * est écrite dans TOUS les cas : sans ce second `update`, l'interrupteur resterait allumé à
       * l'écran pour quelqu'un que le lien avait déjà désinscrit.
       *
       * ⛔ SAUF SUR UNE SOUSCRIPTION EFFACÉE : ni statut, ni finalité, ni trace — dans les deux sens,
       * et pour toutes les finalités (voir `ecrireSaufEffacee`). Rallumer « Newsletter » sur une ligne
       * `deleted` la faisait repasser `active`.
       */
      let desinscrit = false;
      let reabonne = false;
      let porte: boolean;
      if (purpose === "content" && !active) {
        desinscrit = await desinscrireSiActive(db, sub.id as string, { granted_purposes: granted });
        porte = desinscrit || (await ecrireSaufEffacee(db, sub.id as string, { granted_purposes: granted }));
      } else {
        const update: Record<string, unknown> = { granted_purposes: granted };
        if (purpose === "content") {
          update.status = "active";
          reabonne = await reabonnerSiDesinscrite(db, sub.id as string, { granted_purposes: granted });
        }
        porte = reabonne || (await ecrireSaufEffacee(db, sub.id as string, update));
      }
      if (!porte) return sansEffet();
      await db.from("consent_event").insert({
        subscription_id: sub.id, event_type: active ? "granted" : "withdrawn", purpose,
        ip_address: ip, user_agent: ua, method: "preference_center",
      });
      if (reabonne) {
        await db.from("consent_event").insert({
          subscription_id: sub.id, event_type: "resubscribe",
          ip_address: ip, user_agent: ua, method: "preference_center",
        });
      }
      await marquerReaction(sub.id as string);
      if (desinscrit) await accuser(sub, "preference_center");
      return NextResponse.json({ ok: true });
    }

    /* --- (dés)activer le SUIVI (tracking_consent, base ePrivacy séparée des finalités) --- */
    case "set_tracking": {
      if (!body.asset_id) return NextResponse.json({ error: "asset-requis" }, { status: 422 });
      const sub = await trouverSouscription("id", body.asset_id, body.edition_id);
      if (!sub) return NextResponse.json({ error: "souscription-introuvable" }, { status: 404 });
      const active = body.active === true;
      /*
       * 0092 — LE REFUS EXPLICITE, que le mode « suivi pour tous » respecte (worker, `gate.ts`
       * `suiviAccepte`). Écrit EN PREMIER et VÉRIFIÉ : un refus perdu en silence laisserait suivre
       * quelqu'un qui vient de dire non. Seule tolérance : une base d'avant 0092, qui n'a ni la
       * colonne ni le mode « pour tous » — il n'y a alors rien d'autre à respecter que le consentement.
       */
      const { error: eRefus } = await db.from("subscription")
        .update({ tracking_refused_at: active ? null : new Date().toISOString() }).eq("id", sub.id);
      if (eRefus && !colonneRefusAbsente(eRefus.message)) {
        return NextResponse.json({ error: "refus-non-enregistre" }, { status: 500 });
      }
      await db.from("subscription")
        .update({ tracking_consent: active, tracking_consent_at: active ? new Date().toISOString() : null }).eq("id", sub.id);
      await db.from("consent_event").insert({
        subscription_id: sub.id, event_type: active ? "granted" : "withdrawn",
        ip_address: ip, user_agent: ua, method: "preference_center",
        metadata: { tracking_consent: active },
      });
      await marquerReaction(sub.id as string);
      return NextResponse.json({ ok: true });
    }

    /* --- opt-out global (toutes marques) + suppression permanente --- */
    case "unsub_all": {
      const { data: subs } = await db.from("subscription")
        .select(`id, status, created_at, ${COLS_ACCUSE}`).eq("subscriber_id", subscriberId);
      /*
       * ⛔ SEULES LES SOUSCRIPTIONS QUE CE GESTE A RÉELLEMENT FAIT PASSER comptent — pour la trace
       * comme pour l'accusé (22/09/2026). Le statut lu plus haut ne suffit pas : deux clics croisés
       * le liraient tous les deux `active`. Et une souscription effacée n'est ni réécrite ni tracée :
       * la trace remettrait une IP dans le dossier d'une personne qui a demandé l'oubli.
       */
      const desinscrites: Record<string, unknown>[] = [];
      for (const s of (subs ?? []) as Record<string, unknown>[]) {
        if (s.status === "unsubscribed") continue;
        if (!(await desinscrireSiActive(db, s.id as string, {}))) continue;
        desinscrites.push(s);
        await db.from("consent_event").insert({
          subscription_id: s.id, event_type: "unsubscribe",
          ip_address: ip, user_agent: ua, method: "preference_center_global",
        });
      }
      await db.rpc("suppress", { p_email: email, p_asset_id: null, p_reason: "global_optout", p_scope: "global" });
      // ⛔ UN accusé pour tout le geste, jamais un par marque (voir `choisirAccuseGlobal`).
      const cible = choisirAccuseGlobal(desinscrites, body.asset_id);
      if (cible) await accuser(cible, "preference_center_global");
      return NextResponse.json({ ok: true });
    }

    /* --- droit d'accès / portabilité --- */
    case "export": {
      const { data: subs } = await db.from("subscription")
        .select("id, status, source, language, created_at, tracking_consent, tracking_consent_at, granted_purposes, asset:asset_id(name, slug)")
        .eq("subscriber_id", subscriberId);
      const subIds = (subs ?? []).map((s) => s.id);
      let events: unknown[] = [];
      if (subIds.length) {
        const { data: ev } = await db.from("consent_event")
          .select("subscription_id, event_type, purpose, method, legal_basis, country, language, source_url, occurred_at")
          .in("subscription_id", subIds).order("occurred_at", { ascending: true });
        events = ev ?? [];
      }
      await db.from("dsar_request").insert({
        subscriber_id: subscriberId, email, type: "access", status: "done",
        nl_completed_at: new Date().toISOString(),
      });
      return NextResponse.json({
        ok: true,
        data: {
          subscriber: { email: subscriber.email, first_name: subscriber.first_name, created_at: subscriber.created_at },
          subscriptions: subs ?? [],
          consent_history: events,
        },
      });
    }

    /* --- droit à l'oubli --- */
    case "erase": {
      // ⛔ AUCUN ACCUSÉ (décision d'Alix du 22/09/2026) : la personne a demandé qu'on oublie son
      // adresse, lui écrire à cette adresse serait la contredire. L'écran confirme lui-même.
      const { data: dsar } = await db.from("dsar_request")
        .insert({ subscriber_id: subscriberId, email, type: "erasure", status: "processing" })
        .select("id").single();
      await db.rpc("suppress", { p_email: email, p_asset_id: null, p_reason: "erasure", p_scope: "global" });
      const { error } = await db.rpc("erase_subscriber", { p_subscriber_id: subscriberId });
      if (error) return NextResponse.json({ error: "erase-failed" }, { status: 500 });
      if (dsar?.id) {
        await db.from("dsar_request")
          .update({ status: "done", nl_completed_at: new Date().toISOString() }).eq("id", dsar.id);
      }
      return NextResponse.json({ ok: true });
    }

    default:
      return NextResponse.json({ error: "action-inconnue" }, { status: 400 });
  }
}
