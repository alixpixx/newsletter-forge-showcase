import { NextResponse } from "next/server";
import { getDb } from "@/lib/supabase";
import { newDoiToken, verifyForm } from "@/lib/tokens";
import { queueEmail } from "@/lib/mailer";
import { applyInterests, normalizeInterests } from "@/lib/interests";
import { applyOptinTag, parseOptin, resolveOptin, type OptinInput } from "@/lib/optin";
import {
  CAPTURE_CONTRACT,
  captureProbe,
  collectIgnored,
  decideSignup,
  finalitesContact,
  ipInet,
  lireMode,
  mergePurposes,
  optinIdPremiereTouche,
  parseCapture,
  paysAlpha2,
  paysPremiereTouche,
  readCaptureEcho,
  resolveCaptureCampaign,
  resolveInterestTags,
  writeCaptureEvent,
  type CaptureEcho,
  type CaptureV2,
  type SignupMode,
} from "@/lib/capture";
import { suiteEchec, type OperationSignup } from "@/lib/write-policy";
import { origineEmail } from "@/lib/origine-publique";
import { verificationSuppression } from "@/lib/reinscription";
import { dict, normalizeLocale } from "@/lib/i18n";
import { limiterInscription, reponseTropDeTentatives } from "@/lib/debit-inscription";
import { legalBasisForRegime, ALL_PURPOSES, type ConsentPurpose, type GrantedPurposes } from "@nf/config";
import { timingSafeEqual } from "node:crypto";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Comparaison à temps constant. `timingSafeEqual` jette si les longueurs diffèrent —
 * ce qui fuiterait déjà la longueur du secret — d'où le test de longueur en amont,
 * qui répond faux sans lever.
 */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Un refus de base de données qui DIT quelque chose — au serveur toujours, au public quand c'est
 * sûr.
 *
 * ⛔ CE QUE CE CHEMIN FAISAIT AVANT. Les deux écritures de l'inscription répondaient
 * `{ error: "db" }` en 500 sans rien journaliser. Une inscription refusée par une CONTRAINTE —
 * cas mesuré : une adresse en domaine réservé RFC 2606, que `subscriber_reserved_domain_is_demo`
 * (0033) interdit tant que `is_demo` n'est pas posé — ne laissait donc aucune trace nulle part.
 * Ni la personne, ni les journaux du serveur, ni personne d'autre ne pouvait savoir POURQUOI. Un
 * échec muet sur le seul chemin qui fabrique des abonnés est le pire endroit où en avoir un.
 *
 * ⚠️ LE MESSAGE POSTGRES BRUT NE SORT PAS. Il nomme des tables et des contraintes : c'est de la
 * cartographie de schéma offerte à un chemin public non authentifié. Seul le cas que nous SAVONS
 * nommer sans risque l'est ; tout le reste reste `db` côté public et vit en entier dans le journal.
 */
function refusDb(op: string, error: { message?: string; code?: string } | null) {
  const brut = error?.message ?? "";
  console.error(JSON.stringify({ event: "signup-db-refused", op, code: error?.code ?? null, message: brut }));
  const reserve = /reserved_domain|is_demo/i.test(brut);
  return NextResponse.json(
    reserve
      ? {
          error: "reserved_domain",
          message: "this address is on a reserved test domain (example.com and friends) and cannot subscribe",
        }
      : { error: "db" },
    { status: reserve ? 422 : 500 },
  );
}

/**
 * Un accès base qui a ÉCHOUÉ, journalisé — et refusé quand continuer coûterait plus cher.
 *
 * ⛔ CE QUE CE CHEMIN FAISAIT AVANT. Six accès étaient en `await db.from(…)` / `db.rpc(…)` sans
 * jamais lire `error` : la route poursuivait comme si la ligne était écrite, et rendait 200. Le
 * plus grave n'était même pas une écriture mais une LECTURE, celle de la liste de suppression,
 * dont l'échec réabonnait en silence une personne effacée au titre du droit à l'oubli.
 *
 * ⛔ LA POLITIQUE N'EST PAS ICI, ET C'EST VOULU. Elle vit dans `lib/write-policy.ts`, pure, sous
 * banc (`write-policy.test.ts`) : cette route fait 860 lignes et n'a aucun harnais, donc une
 * politique écrite au milieu d'elle ne serait tenue par rien. Ici il ne reste que le câblage —
 * journaliser, puis rendre la réponse que la politique a décidée.
 *
 * ⚠️ Le message Postgres brut NE SORT PAS au public, pour la même raison que dans `refusDb` : il
 * nomme des tables et des contraintes, et ce chemin est public non authentifié. Il vit en entier
 * dans le journal.
 */
function suiteDe(
  op: OperationSignup,
  error: { message?: string; code?: string } | null,
): NextResponse | null {
  const suite = suiteEchec(op);
  console.error(
    JSON.stringify({
      event: suite.event,
      refused: suite.refuse,
      code: error?.code ?? null,
      message: error?.message ?? null,
    }),
  );
  return suite.refuse ? NextResponse.json({ error: suite.code }, { status: suite.status }) : null;
}

/**
 * SONDE DE CAPACITÉ — ce que ce récepteur comprend, sans rien écrire.
 *
 * ⛔ POURQUOI ELLE EXISTE. Le pont a été déployé, puis modifié, sans qu'aucun des deux côtés ne
 * puisse jamais dire ce que l'autre acceptait : un champ inconnu était avalé en silence et la
 * réponse était un `{ok:true}` nu. L'émetteur peut désormais LIRE la version comprise avant
 * d'envoyer quoi que ce soit, et refuser de partir s'il ne la reconnaît pas.
 *
 * ⛔ AUCUNE LECTURE D'ENVIRONNEMENT, AUCUN ACCÈS BASE. Dire à un appelant anonyme si
 * `NF_INGEST_SECRET` est posée lui apprendrait si la porte est ouverte ; et une sonde qui touche la
 * base devient une sonde qui tombe en même temps qu'elle, donc qui ne sonde plus rien.
 */
export async function GET() {
  return NextResponse.json(captureProbe());
}

/**
 * L'ÉCHO du contrat v2 — la réponse que l'émetteur RELIT et ASSERTE.
 *
 * ⛔ RÉSERVÉ À L'INGESTION SERVEUR. `already:true` est déjà servi à un appelant anonyme (le widget
 * en dépend) : c'est une fuite d'un bit, « cette adresse est-elle abonnée ? ». Y ajouter
 * `subscription_id`, `capture_event_id` ou `resolved` en ferait une fuite d'identifiants internes,
 * sur un chemin public non authentifié.
 */
function echoIngestion(args: {
  /**
   * ⛔ LE MODE APPLIQUÉ, RENDU POUR QUE L'ÉMETTEUR L'ASSERTE. Un contact envoyé à un récepteur qui
   * ignorerait `mode` deviendrait une inscription newsletter : l'émetteur doit pouvoir lire, sur
   * CHAQUE lead, que c'est bien un contact qui a été traité — pas le déduire d'un 200.
   */
  mode: SignupMode;
  already: boolean;
  duplicate: boolean;
  subscriptionId: string | null;
  captureEventId: string | null;
  resolved: CaptureEcho | null;
  /**
   * ⛔ LES INTÉRÊTS ÉCARTÉS REMONTENT JUSQU'À L'ÉMETTEUR, PAS SEULEMENT DANS NOS JOURNAUX.
   * `normalizeInterestItems` existe pour rendre « kept ET rejected, avec le motif » — mais un
   * motif qui s'arrête à un `console.error` chez nous ne dit rien à celui qui a envoyé le lead.
   * Cas mesurable : l'émetteur régresse et envoie des CHAÎNES dans `capture.interests.chosen` ;
   * chaque élément est écarté (`pas-un-objet`), la réponse reste `200 ok`, et 100 % des sujets
   * cochés sont perdus en silence — la panne `origin_tags`, rejouée dans le v2. Idem quand la
   * résolution des tags échoue en base : `interest_ids` vaut `[]`, ce qui se lit « il n'a rien
   * coché » alors qu'il a coché et que nous avons échoué.
   */
  rejectedInterests: { slug: string; reason: string }[];
  ignoredFields: string[];
  devConfirmUrl?: string | null;
}) {
  const corps: Record<string, unknown> = {
    ok: true,
    contract: CAPTURE_CONTRACT,
    mode: args.mode,
    already: args.already,
    duplicate: args.duplicate,
    subscription_id: args.subscriptionId,
    capture_event_id: args.captureEventId,
    // Un écho absent est un écho VIDE, jamais un écho manquant : l'émetteur asserte des clés, pas
    // leur présence. Les trois valeurs à null disent « rien n'a été rattaché », ce qui est vrai.
    resolved: args.resolved ?? { campaign_id: null, optin_id: null, interest_ids: [], automation_label: null },
    rejected_interests: args.rejectedInterests,
    ignored_fields: args.ignoredFields,
  };
  if (args.devConfirmUrl) corps._devConfirmUrl = args.devConfirmUrl;
  return NextResponse.json(corps);
}

/**
 * Inscription publique (widget). Crée une souscription `pending` + un événement de
 * consentement `optin_request`, émet un token de double opt-in, et met en file un email
 * de confirmation (stubé → outbox). Aucun abonné n'est ACTIF avant d'avoir cliqué le lien.
 *
 * Anti-spam : honeypot + time-trap (gratuits, sans dépendance). Turnstile viendra plus tard.
 */
export async function POST(req: Request) {
  const db = getDb();
  if (!db) return NextResponse.json({ error: "service-indisponible" }, { status: 503 });

  let body: {
    email?: string; first_name?: string; asset?: string;
    consent?: boolean; tracking_consent?: boolean; company?: string; ft?: string;
    /** Slug de l'édition visée (`cl`, `en`, `pt-br`). Absent = édition primaire de la marque. */
    edition?: string;
    // Consentement par finalité (mode granulaire) : `consent` = case Newsletter (content, requise).
    purposes?: { offers?: boolean; events?: boolean };
    partner_consent?: boolean;
    // Ingestion serveur-à-serveur uniquement (voir plus bas) : le système de capture
    // parle déjà le vocabulaire de finalités d'ici, et transporte le contexte du lead.
    granted_purposes?: Record<string, boolean>;
    /**
     * Les catégories éditoriales cochées à l'inscription, en slugs bruts.
     *
     * ⛔ Ce ne sont PAS des finalités : elles ne passent pas par la validation
     * `ALL_PURPOSES` plus bas et ne doivent jamais y passer. Une clé de finalité
     * inconnue fait refuser l'inscription en 422 — c'est voulu, le vocabulaire
     * est fermé ; une catégorie inconnue est au contraire normale, le
     * vocabulaire est libre et décidé par la créative qui l'a proposée.
     */
    interests?: string[];
    /**
     * Le FORMULAIRE d'origine (`{ slug, name }`), pour classer le contact dans une sous-liste.
     *
     * ⛔ Ce n'est ni une finalité ni une catégorie : c'est d'où il vient, pas ce qu'il a choisi.
     * Réservé à l'ingestion serveur, comme `interests` — accepter ce champ d'un appelant anonyme
     * laisserait n'importe qui créer des sous-listes sur n'importe quelle marque.
     */
    optin?: { slug?: string; name?: string };
    /**
     * Le contrat v2 : la provenance à trois niveaux (campagne → créative → intérêts).
     *
     * ⛔ UN OBJET NEUF, et rien au-dessus ne change de forme (D5). `unknown` et non un type
     * détaillé : la validation appartient à `parseCapture`, seul endroit qui puisse dire à
     * l'émetteur QUEL champ il a mal écrit. Un type TypeScript, lui, ne dit rien de ce qui arrive
     * vraiment sur le fil — il décrit un espoir.
     */
    capture?: unknown;
    source?: string;
    source_detail?: Record<string, unknown>;
    ip_address?: string;
    user_agent?: string;
    source_url?: string;
    /**
     * Le pays DU CONTACT, en ISO-3166-1 alpha-2. Réservé à l'ingestion serveur.
     *
     * ⛔ N'A RIEN À VOIR AVEC `edition.market`, qui reste le marché de la PUBLICATION et continue
     * d'alimenter seul `consent_event.country`. Voir `paysAlpha2` pour le pourquoi complet : les
     * deux répondent à deux questions, et les confondre écrirait une géographie fausse dans la
     * preuve légale.
     */
    country?: string;
    /** `"contact"` = contact hors newsletter (0088), ingestion serveur seulement — voir `lireMode`. */
    mode?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "requête invalide" }, { status: 400 });
  }

  /**
   * Ce que nous n'avons PAS compris, relevé sur l'objet BRUT.
   *
   * ⛔ ICI ET PAS AILLEURS : le type TypeScript ci-dessus ne dit rien des clés réellement reçues —
   * il est effacé à la compilation. Sans ce relevé, un émetteur qui écrit `capture.creatives` au
   * pluriel reçoit un `200 {ok:true}` parfaitement rassurant et perd 100 % de ses créatives.
   * C'est le seul signal qui distingue « champ inconnu » de « champ compris et vide ».
   */
  const ignoredFields = collectIgnored(body);

  /**
   * --- Entrée serveur-à-serveur (pont depuis le système de capture) ---
   * Un lead capturé ailleurs n'a jamais chargé CE formulaire : il n'a donc ni
   * honeypot ni jeton `ft`, et le chemin public le jetterait en silence — la route
   * répond `200 {ok:true}` sans rien créer, ce qui perdrait 100 % des leads sans
   * une ligne de log. Une clé partagée ouvre la même séquence, sans la dupliquer :
   * tout ce qui suit est commun aux deux entrées.
   */
  const ingestHeader = req.headers.get("x-nf-ingest-secret");
  let serverIngest = false;
  if (ingestHeader !== null) {
    const expected = process.env.NF_INGEST_SECRET ?? "";
    // Un secret absent de l'environnement ne doit JAMAIS ouvrir la porte (sinon
    // un déploiement mal configuré accepterait n'importe quel appelant). Et on
    // répond bruyamment plutôt que par le 200 muet réservé aux bots : en face il
    // y a une machine, dont le silence transformerait une panne en succès apparent.
    if (!expected || !safeEqual(ingestHeader, expected)) {
      return NextResponse.json({ error: "ingest-refuse" }, { status: 401 });
    }
    serverIngest = true;
  }

  // --- Anti-bot (on renvoie 200 sans rien créer pour ne pas informer le bot) ---
  if (!serverIngest) {
    // 1) Honeypot : champ caché rempli = bot.
    if (body.company && body.company.trim() !== "") return NextResponse.json({ ok: true });
    // 2) Jeton de formulaire signé : bloque le POST direct sur l'API (sans charger le form)
    //    ET mesure le temps de remplissage — horloge SERVEUR uniquement (pas de dérive client).
    const formTs = verifyForm(body.ft);
    if (formTs === null) return NextResponse.json({ ok: true }); // jamais passé par le formulaire
    const elapsed = Date.now() - formTs;
    if (elapsed < 800) return NextResponse.json({ ok: true }); // soumission trop rapide = bot
    if (elapsed > 2 * 3600 * 1000) return NextResponse.json({ error: "form-expire" }, { status: 422 });
  }

  const email = (body.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return NextResponse.json({ error: "email-invalide" }, { status: 422 });
  const luMode = lireMode(body.mode, serverIngest);
  if (!luMode.ok) {
    return NextResponse.json({ error: luMode.error, expected: luMode.expected }, { status: luMode.status });
  }
  // ⛔ Un contact hors newsletter (0088) n'a coché aucune case newsletter : la barrière `consent`
  //    ne le concerne pas. Il n'en reçoit pas non plus les effets — ni preuve d'opt-in, ni jeton,
  //    ni e-mail (`decideSignup`).
  const modeContact = luMode.mode === "contact";
  if (!modeContact && body.consent !== true) {
    return NextResponse.json({ error: "consentement-requis" }, { status: 422 });
  }

  // Sur le pont, l'IP et l'agent des en-têtes sont ceux du SERVEUR appelant, pas du
  // visiteur : la preuve de consentement doit porter ceux du visiteur, transportés
  // dans le corps. Sur le chemin public, les en-têtes restent la seule source.
  // ⛔ VALIDÉE DES DEUX CÔTÉS, PAS SEULEMENT SUR LE PONT. `ip` atterrit dans deux colonnes `inet`
  //    (`consent_event.ip_address`, `capture_event.ip_address`) dont les INSERT ne lisent pas leur
  //    retour : une valeur mal formée les fait échouer EN SILENCE, sur un 200. Le chemin public
  //    n'est pas à l'abri — un proxy mal réglé pose ce qu'il veut dans `x-forwarded-for`.
  // ⚠️ Calculée ICI, avant toute lecture en base, parce que la limite de débit juste en dessous
  //    en a besoin : c'est l'IP du VISITEUR qui compte, sur le pont comme ailleurs.
  const ip = serverIngest
    ? ipInet(body.ip_address)
    : (ipInet(req.headers.get("x-forwarded-for")) ?? ipInet(req.headers.get("x-real-ip")));

  /*
   * ⛔ LIMITE DE DÉBIT (24/09/2026), AVANT TOUTE ÉCRITURE ET SUR LES DEUX ENTRÉES. Chaque inscription
   * qui passe envoie un vrai e-mail en quelques secondes : sans borne, un robot fait recevoir des
   * dizaines de confirmations à l'adresse d'un tiers. Le pont y est soumis aussi — ce qu'il relaie
   * vient de popups publiques, et un 429 laisse son lead rejouable. Le pourquoi, les seuils et le
   * choix « une panne du compteur laisse passer » : `lib/debit-inscription.ts`.
   */
  const debit = await limiterInscription(db, { ip, email });
  if (!debit.ok) return reponseTropDeTentatives(debit);

  const assetSlug = (body.asset ?? "").trim();
  const { data: asset } = await db.from("asset").select("id, name").eq("slug", assetSlug).maybeSingle();
  if (!asset) return NextResponse.json({ error: "marque-inconnue" }, { status: 404 });

  // C5 : suppression list — on ne recrée jamais une adresse qui a rebondi durement ou s'est plainte.
  //
  // ⭐ DEPUIS 0073, UNE PERSONNE QUI SE RÉINSCRIT ELLE-MÊME (formulaire public, popup de capture) n'est
  // bloquée que par la suppression DURE (22/09/2026, Alix : « si la personne se reinscrit on l'a reme
  // dans le systeme »). Elle repart `pending`, reçoit son lien, et c'est SON CLIC qui lève
  // l'ancienne suppression (`confirm/page.tsx`) ; avant, elle ne reçoit rien d'autre. Un import ou un
  // ajout depuis l'admin garde la suppression COMPLÈTE — voir `lib/reinscription.ts`.
  //
  // ⚠️ SOUS LE CONTRAT v2, LE `{ok:true}` NU EST UN PIÈGE : un émetteur qui asserte
  // « capture_event_id non nul » lirait ce silence comme une panne du pont et rejouerait le lead
  // indéfiniment. Il reçoit donc l'écho complet, avec des identifiants à NULL — et SANS motif : la
  // raison (effacement RGPD ou plainte) est une donnée personnelle qui ne se rend pas à l'appelant.
  // La sonde `GET` documente ce cas : « ok:true avec capture_event_id:null = rien n'a été
  // enregistré, la raison n'est pas divulguée ».
  //
  // ⛔⛔ ET SON ÉCHEC FERME, IL N'OUVRE PAS. Sans cette garde, une RPC en panne rendait
  // `supp.data === undefined`, le test était faux, et la route REMONTAIT une personne effacée au
  // titre du droit à l'oubli — sur un chemin public, sans une ligne de journal. Sur une
  // vérification de suppression, « je ne sais pas » ne se rend jamais comme « non ».
  const supp = await db.rpc(verificationSuppression(serverIngest, body.source_detail?.origin, luMode.mode), {
    p_email: email,
    p_asset_id: asset.id,
  });
  if (supp.error) {
    const refus = suiteDe("suppression-check", supp.error);
    if (refus) return refus;
  }
  if (supp.data === true) {
    return serverIngest
      ? echoIngestion({
          mode: luMode.mode, already: false, duplicate: false, subscriptionId: null,
          captureEventId: null, resolved: null, rejectedInterests: [], ignoredFields,
        })
      : NextResponse.json({ ok: true }); // silencieux
  }

  // --- Édition ciblée (lot E-1) ---
  //
  // Une marque peut avoir PLUSIEURS éditions, chacune avec sa liste et sa newsletter :
  // `atlas-review.example` en portugais et `atlas-review.example/cl/` en espagnol sont deux publics.
  // Le widget la désigne par son slug (`edition: "cl"`) ; à défaut on prend la primaire.
  //
  // ⛔ CE QU'ON NE FAIT PLUS : `.limit(1)` SANS `order by`. Avec une seule édition c'était correct
  // par accident ; avec deux, Postgres est libre de rendre l'une ou l'autre, et la même personne
  // atterrirait dans la liste espagnole un jour et portugaise le lendemain.
  //
  // ⚠️ Les colonnes `slug` / `is_primary` arrivent avec la migration 0026. Tant qu'elle n'est pas
  // appliquée, la requête échoue et on retombe sur l'ancienne forme, triée par `created_at` — qui
  // désigne exactement l'édition que 0026 marquera primaire. Le code est donc correct AVANT comme
  // APRÈS la migration, dans les deux ordres de déploiement.
  const editionSlug = typeof body.edition === "string" ? body.edition.trim().toLowerCase() : "";
  const editionCols = "id, language, market, compliance_regime, consent_mode";

  interface EditionRow {
    id: string;
    language: string | null;
    market: string | null;
    compliance_regime: string | null;
    consent_mode: string | null;
  }
  let edition: EditionRow | null = null;

  const moderne = await db
    .from("asset_edition")
    .select(`${editionCols}, slug, is_primary`)
    .eq("asset_id", asset.id)
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true });

  if (!moderne.error && moderne.data) {
    const rows = moderne.data as unknown as (EditionRow & { slug?: string | null })[];
    edition =
      (editionSlug ? rows.find((e) => (e.slug ?? "").toLowerCase() === editionSlug) : null) ??
      rows[0] ??
      null;
    // Un slug demandé mais introuvable est une ERREUR, pas une invitation à choisir à sa place :
    // le formulaire promet une liste précise, et inscrire ailleurs serait un consentement donné
    // pour une publication que la personne n'a pas vue.
    if (editionSlug && !rows.some((e) => (e.slug ?? "").toLowerCase() === editionSlug)) {
      return NextResponse.json({ error: "edition-inconnue" }, { status: 404 });
    }
  } else {
    const ancien = await db
      .from("asset_edition")
      .select(editionCols)
      .eq("asset_id", asset.id)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    // Les slugs n'existent pas encore en base : on ne PEUT pas honorer une édition demandée. La
    // refuser est la seule réponse honnête — inscrire dans l'édition primaire à la place donnerait
    // un consentement pour une publication que la personne n'a pas vue.
    if (editionSlug) {
      return NextResponse.json({ error: "edition-inconnue" }, { status: 404 });
    }
    edition = (ancien.data as unknown as EditionRow | null) ?? null;
  }
  const { data: consentVersion } = await db
    .from("consent_version").select("id").eq("asset_id", asset.id)
    .order("effective_from", { ascending: false }).limit(1).maybeSingle();

  // `ip` est calculée plus haut, avant la limite de débit ; l'agent suit la même règle.
  const ua = serverIngest
    ? (body.user_agent ?? null)
    : (req.headers.get("user-agent") || null);
  const firstName = (body.first_name ?? "").trim() || null;
  // ⛔ RÉSERVÉ AU PONT, comme `interests` et `optin` : `subscription.country` est le prédicat de
  //    segmentation, et l'accepter d'un appelant anonyme laisserait n'importe qui déplacer des
  //    abonnés d'un ciblage à un autre. Le chemin public n'écrit donc rien dans cette colonne.
  const paysContact = serverIngest ? paysAlpha2(body.country) : null;
  // ⛔ Pas de consentement au suivi pour un contact : rien n'en écrirait la preuve (aucun
  //    `consent_event`), et un envoi sans ce consentement part simplement sans pixel.
  const trackingConsent = !modeContact && body.tracking_consent === true;
  const trackingConsentAt = trackingConsent ? new Date().toISOString() : null;

  // Finalités accordées. `body.consent` (validé true) = case Newsletter (content, requise).
  // Mode single : la case unique couvre content+offers+events. Mode granular : chaque finalité à part.
  const partnerConsent = body.partner_consent === true;
  let grantedPurposes: GrantedPurposes =
    edition?.consent_mode === "granular"
      ? { content: true, offers: body.purposes?.offers === true, events: body.purposes?.events === true, partners: partnerConsent }
      : { content: true, offers: true, events: true, partners: partnerConsent };

  /**
   * Le pont envoie les finalités déjà traduites dans le vocabulaire d'ici. Une clé
   * inconnue est REFUSÉE plutôt qu'ignorée : le vocabulaire de la capture et celui
   * de l'envoi ont divergé une fois (`newsletter` contre `content`), et une clé
   * ignorée en silence crée un abonné à qui la porte d'envoi ne laissera jamais
   * rien passer — un échec invisible des deux côtés. `content` reste vrai : la
   * route exige déjà `consent === true` au-dessus.
   */
  if (serverIngest && body.granted_purposes) {
    const unknown = Object.keys(body.granted_purposes).filter(
      (k) => !ALL_PURPOSES.includes(k as ConsentPurpose),
    );
    if (unknown.length > 0) {
      return NextResponse.json(
        { error: "finalites-inconnues", unknown, expected: ALL_PURPOSES },
        { status: 422 },
      );
    }
    grantedPurposes = { ...(body.granted_purposes as GrantedPurposes), content: true };
  }
  // Un contact : ce que l'émetteur a transmis et rien de plus — `content` n'est pas forcé.
  if (modeContact) grantedPurposes = finalitesContact(body.granted_purposes);
  const legalBasis = legalBasisForRegime(edition?.compliance_regime as string | undefined);
  /**
   * L'origine PUBLIQUE de ce service, résolue UNE FOIS. `new URL(req.url).origin` rend l'adresse
   * d'écoute du conteneur (`https://0.0.0.0:3000`) : c'est ce qui a envoyé des liens de
   * confirmation morts après le changement d'hébergement. Détail : `lib/origine-publique.ts`.
   */
  const origine = origineEmail({
    urlRequete: req.url,
    enTetes: req.headers,
    env: {
      PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
      NEXT_PUBLIC_PUBLIC_BASE_URL: process.env.NEXT_PUBLIC_PUBLIC_BASE_URL,
    },
    production: process.env.NODE_ENV === "production",
  });
  // Pour la PROVENANCE, une origine même imparfaite vaut mieux que rien : elle n'est jamais cliquée.
  const origineTrace = origine.ok ? origine.origine : new URL(req.url).origin;
  const sourceUrl = serverIngest
    // ⚠️ `(x ?? null) ?? y` était rigoureusement équivalent à `x ?? y`, mais TypeScript le refuse
    // (TS2871) : la porte de typecheck d'`apps/public` restait rouge, donc illisible. Comportement
    // inchangé — l'URL transmise par l'ingestion serveur l'emporte, l'origine de la requête est le
    // repli.
    ? body.source_url ?? origineTrace
    : req.headers.get("referer") || origineTrace;
  // `subscription_source_check` n'accepte que organic|social|crm_sync|import|content_upgrade :
  // une valeur libre ferait échouer l'insert. Le détail de la provenance vit dans
  // `source_detail`, qui est libre.
  const ALLOWED_SOURCES = ["organic", "social", "crm_sync", "import", "content_upgrade"];
  const source = serverIngest
    ? (body.source && ALLOWED_SOURCES.includes(body.source) ? body.source : "content_upgrade")
    : "organic";
  const sourceDetail: Record<string, unknown> = serverIngest ? { ...(body.source_detail ?? {}) } : {};

  /*
   * --- L'OPTIN : de quel formulaire vient ce contact ---
   *
   * Résolu AVANT la souscription, parce qu'il s'écrit DANS la souscription. Un slug mal formé est
   * refusé ici (422 lisible côté émetteur) plutôt que de faire échouer l'insert sur la contrainte
   * de base : le contact serait alors classé « sans optin » sans que personne ne l'apprenne.
   *
   * ⛔ Mais un échec de RÉSOLUTION (base indisponible, conflit) ne coûte pas l'inscription : on
   * journalise et on continue sans optin. Le classement se rattrape, un consentement non.
   */
  let optinId: string | null = null;
  let optinDefaultTagId: number | null = null;

  /*
   * --- LE CONTRAT v2 : campagne → créative → intérêts ---
   *
   * L'ORDRE EST IMPOSÉ, et pas par élégance : la campagne s'écrit DANS la créative, et les intérêts
   * PROPOSÉS s'écrivent dans la créative eux aussi (`offered_interest_ids`). Résoudre la créative
   * en premier obligerait à la réécrire ensuite — deux écritures pour un fait, donc une occasion de
   * divergence.
   *
   * ⛔ `capture` GAGNE sur le v1. Un corps portant les deux est un émetteur en cours de bascule :
   * traiter les deux poserait, pour le même sujet, un tag `kind='manual'` (chemin v1, slug brut) ET
   * un tag `kind='interest'` (chemin v2, slug préfixé) — deux identités permanentes pour un seul
   * intérêt, exactement ce que le préfixe existe pour empêcher.
   */
  let capture: CaptureV2 | null = null;
  let captureCampaignId: string | null = null;
  let campaignNameAtCapture: string | null = null;
  let optinNameAtCapture: string | null = null;
  let interestIdsCaptured: number[] = [];
  let interestsOfferedIds: number[] | undefined;
  /** Ce qui a été écarté au niveau 3 — journalisé ICI *et* rendu à l'émetteur (voir `echoIngestion`). */
  const interestsEcartes: { slug: string; reason: string }[] = [];

  if (serverIngest) {
    const luCapture = parseCapture(body.capture);
    // Le refus NOMME le champ et l'attendu : côté émetteur, « 422 » sans le champ fautif oblige à
    // deviner, et on devine mal sur un contrat à trois niveaux.
    if (!luCapture.ok) {
      return NextResponse.json(
        { error: luCapture.error, field: luCapture.field, expected: luCapture.expected },
        { status: 422 },
      );
    }
    capture = luCapture.value;
  }

  if (capture) {
    // 1. La campagne d'acquisition (niveau 1).
    let campagnePourOptin: string | null | undefined;
    if (capture.campaign === null) {
      // Détachement EXPLICITE : l'émetteur dit que cette créative n'appartient plus à une campagne.
      campagnePourOptin = null;
    } else if (capture.campaign) {
      campaignNameAtCapture = capture.campaign.name;
      const resolue = await resolveCaptureCampaign(db, asset.id, capture.campaign);
      if (resolue.error) {
        console.error(
          JSON.stringify({
            event: "signup-capture-campaign-failed",
            external_id: capture.campaign.externalId,
            reason: resolue.error,
          }),
        );
      }
      captureCampaignId = resolue.value?.id ?? null;
      // ⛔ UN ÉCHEC DE RÉSOLUTION NE DÉTACHE PAS. Laisser `undefined` (donc ne pas citer la colonne)
      //    préserve le rattachement existant ; écrire `null` ferait d'une panne d'une seconde une
      //    perte définitive du niveau 1 pour cette créative.
      campagnePourOptin = captureCampaignId ?? undefined;
    }

    // 2. Les intérêts (niveau 3), AVANT la créative — voir l'en-tête de ce bloc.
    if (capture.interests) {
      for (const ecarte of capture.interests.rejected) {
        // Un intérêt écarté est un sujet que quelqu'un a coché et ne recevra pas : il ne coûte pas
        // l'inscription, mais il ne part pas non plus en silence — ni chez nous, ni chez l'émetteur.
        interestsEcartes.push(ecarte);
        console.error(
          JSON.stringify({
            event: "signup-capture-interest-rejected",
            slug: ecarte.slug,
            reason: ecarte.reason,
          }),
        );
      }

      const proposes = capture.interests.offered;
      if (proposes !== undefined) {
        const offerts = await resolveInterestTags(db, asset.id, proposes);
        if (offerts.error) {
          // ⛔ UN ÉCHEC DE RÉSOLUTION N'EST PAS « RIEN À RÉSOUDRE ». Sans cette remontée, le
          //    dénominateur des taux d'intérêt reste NULL et l'émetteur croit avoir tout transmis.
          for (const item of proposes) {
            interestsEcartes.push({ slug: item.slug, reason: "offert-non-resolu" });
          }
          console.error(
            JSON.stringify({ event: "signup-capture-offered-failed", reason: offerts.error }),
          );
        }
        for (const ecarte of offerts.rejected) {
          interestsEcartes.push(ecarte);
          console.error(
            JSON.stringify({ event: "signup-capture-interest-rejected", slug: ecarte.slug, reason: ecarte.reason }),
          );
        }
        // ⛔ `[]` reste `[]` (« rien n'était proposé ») ; `undefined` laisse la colonne non citée
        //    (« on ne sait pas »). Confondre les deux retire pour toujours le dénominateur de tout
        //    taux d'intérêt — il ne se reconstitue pas après coup.
        interestsOfferedIds = offerts.error ? undefined : offerts.ids;
      }

      const coches = capture.interests.chosen;
      const choisis = await resolveInterestTags(db, asset.id, coches);
      if (choisis.error) {
        // ⛔ SANS CETTE REMONTÉE, UNE PANNE SE LIT COMME UNE MESURE. `capture_event.interest_ids`
        //    est `not null default '{}'` : la base n'a AUCUN état « on ne sait pas » pour le
        //    niveau 3. Un échec de résolution écrirait donc `[]`, c'est-à-dire « cette personne
        //    n'a rien coché », sur un formulaire où elle avait coché — un zéro qui n'est pas une
        //    mesure mais un refus, et que rien ne permet de reconstituer ensuite.
        for (const item of coches) {
          interestsEcartes.push({ slug: item.slug, reason: "choisi-non-resolu" });
        }
        console.error(
          JSON.stringify({ event: "signup-capture-interests-failed", reason: choisis.error }),
        );
      }
      for (const ecarte of choisis.rejected) {
        interestsEcartes.push(ecarte);
        console.error(
          JSON.stringify({ event: "signup-capture-interest-rejected", slug: ecarte.slug, reason: ecarte.reason }),
        );
      }
      interestIdsCaptured = choisis.ids;
    }

    // 3. La créative (niveau 2).
    if (capture.creative) {
      optinNameAtCapture = capture.creative.name;
      const entree: OptinInput = {
        // ⚠️ LE SLUG EST L'UUID AMONT, en minuscules. Il satisfait `optin_slug_format` (36
        // caractères, commence par un alphanumérique, tirets autorisés) et réutilise l'unique
        // `(asset_id, slug)` déjà en place — aucun unique n'existe sur `(asset_id, external_id)`,
        // et en inventer un aurait imposé une migration de plus.
        slug: capture.creative.externalId,
        name: capture.creative.name,
        externalId: capture.creative.externalId,
        placement: capture.creative.placement,
        ...(campagnePourOptin !== undefined ? { captureCampaignId: campagnePourOptin } : {}),
        ...(capture.interests ? { asksInterests: capture.interests.asks } : {}),
        ...(interestsOfferedIds !== undefined ? { offeredInterestIds: interestsOfferedIds } : {}),
      };
      const resolu = await resolveOptin(db, asset.id, entree);
      if (resolu.error) {
        console.error(
          JSON.stringify({ event: "signup-optin-failed", slug: entree.slug, reason: resolu.error }),
        );
      }
      optinId = resolu.value?.id ?? null;
      optinDefaultTagId = resolu.value?.defaultTagId ?? null;
    }
  } else if (serverIngest) {
    const lu = parseOptin(body.optin);
    if (!lu.ok) {
      return NextResponse.json(
        { error: lu.reason, expected: "optin.slug matching ^[a-z0-9][a-z0-9-]{0,63}$" },
        { status: 422 },
      );
    }
    if (lu.value) {
      const resolu = await resolveOptin(db, asset.id, lu.value);
      if (resolu.error) {
        console.error(
          JSON.stringify({ event: "signup-optin-failed", slug: lu.value.slug, reason: resolu.error }),
        );
      }
      optinId = resolu.value?.id ?? null;
      optinDefaultTagId = resolu.value?.defaultTagId ?? null;
    }
  }

  /**
   * ⛔ LE RAPPEL VERS L'ÉMETTEUR TIENT À `source_detail.lead_id` — ET À RIEN D'AUTRE.
   * `apps/public/src/app/confirm/page.tsx` ne rappelle optinforge que si
   * `detail.origin === "optinforge" && detail.lead_id`. Le v2 déplace le lead dans
   * `capture.lead_id` ; si le récepteur cessait d'alimenter `source_detail`, la condition
   * deviendrait fausse, le lead resterait `verified=false` POUR TOUJOURS chez l'émetteur, et le
   * seul témoin serait un `console.warn`. On continue donc d'écrire les deux clés tant que
   * `/confirm` n'a pas basculé sur les événements de capture (étape hors de ce lot).
   *
   * ⚠️ Sans écraser : un émetteur qui envoie encore `source_detail` garde ses valeurs.
   */
  if (capture?.leadId) {
    if (sourceDetail.origin === undefined) sourceDetail.origin = "optinforge";
    if (sourceDetail.lead_id === undefined) sourceDetail.lead_id = capture.leadId;
  }

  // --- Abonné (dédup par email) ---
  let subscriberId: string;
  // ⛔ UNE LECTURE RATÉE N'EST PAS « PAS TROUVÉ ». Sans cette garde, une panne de lecture envoyait
  //    la route dans la branche CRÉATION juste en dessous, où l'INSERT bute sur l'unique `(email)` :
  //    un 500 illisible, sur quelqu'un qui existait déjà.
  const { data: existingSub, error: erreurSub } = await db
    .from("subscriber").select("id").eq("email", email).maybeSingle();
  if (erreurSub) {
    const refus = suiteDe("subscriber-read", erreurSub);
    if (refus) return refus;
  }
  if (existingSub) {
    subscriberId = existingSub.id;
    // ⛔ Un contact ne touche à AUCUNE ligne existante, pas même le prénom (lot E, 0088).
    if (firstName && !modeContact) {
      // ⛔ CELUI-CI NE REFUSE PAS, et c'est le seul du lot. L'abonné PRÉEXISTAIT, rien de neuf
      //    n'est écrit ici, rien en aval n'en dépend : refuser l'inscription entière pour un prénom
      //    non rafraîchi serait disproportionné. Mais l'échec se dit — voir `write-policy.ts`.
      const { error } = await db.from("subscriber").update({ first_name: firstName }).eq("id", subscriberId);
      if (error) {
        const refus = suiteDe("subscriber-first-name", error);
        if (refus) return refus;
      }
    }
  } else {
    const { data: created, error } = await db
      .from("subscriber").insert({ email, first_name: firstName }).select("id").single();
    if (error || !created) return refusDb("subscriber-insert", error);
    subscriberId = created.id;
  }

  // --- Souscription : une par (personne, ÉDITION) depuis le lot E-1 ---
  //
  // ⛔ CE QUI ÉTAIT ARMÉ ICI. La requête filtrait sur `asset_id` seul et appelait `maybeSingle()`,
  // qui LÈVE dès que deux lignes correspondent. Tant qu'une marque n'avait qu'une édition, la
  // contrainte `unique (subscriber_id, asset_id)` garantissait l'unicité ; en la levant (0026),
  // cette ligne serait devenue une erreur d'inscription pour toute personne déjà abonnée à une
  // autre édition du même domaine — sur un chemin public, en production.
  //
  // Filtrer sur `edition_id` est correct AVANT la migration aussi : les 1 203 souscriptions
  // existantes portent toutes une édition (vérifié le 20/08).
  //
  // ⚠️ LE `select` EST ÉLARGI depuis le 10/09/2026 : la fusion de consentement a besoin de
  // l'existant. Lire `id, status` seuls obligeait à ÉCRASER `granted_purposes`, `source_detail` et
  // `tracking_consent` faute de savoir ce qu'ils valaient.
  const dejaLa = db
    .from("subscription")
    .select("id, status, optin_id, country, granted_purposes, source_detail, tracking_consent, tracking_consent_at")
    .eq("subscriber_id", subscriberId)
    .eq("asset_id", asset.id);
  // ⛔ MÊME PIÈGE QUE POUR `subscriber`, UNE CLÉ UNIQUE PLUS LOIN. Une lecture ratée lue comme
  //    « aucune souscription » part en branche CRÉATION et viole
  //    `(subscriber_id, asset_id, edition_id)`.
  const { data: existing, error: erreurExistant } = await (edition
    ? dejaLa.eq("edition_id", edition.id)
    : dejaLa.is("edition_id", null)
  ).maybeSingle();
  if (erreurExistant) {
    const refus = suiteDe("subscription-read", erreurExistant);
    if (refus) return refus;
  }

  interface SouscriptionExistante {
    id: string;
    status: string;
    optin_id: string | null;
    /** Lu UNIQUEMENT pour savoir s'il est déjà posé : la règle est première touche. */
    country: string | null;
    granted_purposes: Record<string, unknown> | null;
    source_detail: Record<string, unknown> | null;
    tracking_consent: boolean | null;
    tracking_consent_at: string | null;
  }
  const existant = (existing ?? null) as unknown as SouscriptionExistante | null;

  /**
   * LA SÉQUENCE, décidée en un seul endroit et testable sans base (`decideSignup`).
   *
   * ⛔ CE QUE CE LOT CORRIGE. `if (existing.status === "active") return {ok:true, already:true}`
   * sortait AVANT toute écriture : la deuxième inscription d'une même personne — donc la deuxième
   * créative, donc les intérêts cochés la deuxième fois — était perdue sans une trace.
   *
   * ⛔ ET LE PIÈGE QUE LA CORRECTION OUVRE. L'UPDATE ci-dessous posait `status: "pending"` EN DUR.
   * Il n'était jamais atteint sur une souscription active parce que le retour anticipé sortait
   * avant ; le laisser sans garde ferait passer un abonné ACTIF en PENDING — il sortirait de
   * `sendable_subscription`, ne recevrait plus rien, et rien ne le signalerait.
   */
  const seq = decideSignup({ existingStatus: existant?.status ?? null, serverIngest, mode: luMode.mode });
  // Le chemin PUBLIC ne change pas d'un octet : `signup-form.tsx` lit `already` pour afficher
  // « déjà inscrit », et un anonyme ne doit rien apprendre de plus.
  if (seq.earlyAlready) return NextResponse.json({ ok: true, already: true });

  let subscriptionId: string;
  if (existant) {
    subscriptionId = existant.id;
    // ⛔ TERNAIRE PLUTÔT QUE BLOC : la charge utile ci-dessous ne bouge pas d'un octet, seule sa
    //    SORTIE est désormais lue. Un refus ici perdait, en silence et sur un 200, la DEUXIÈME
    //    inscription d'une personne — sa créative, ses intérêts, ses finalités.
    const majSouscription = seq.updateSubscription ? await db.from("subscription").update({
      ...(seq.forceStatusPending ? { status: "pending" } : {}),
      edition_id: edition?.id ?? null,
      // ⛔ PREMIÈRE TOUCHE, JAMAIS LA DERNIÈRE (D8) — la règle et son POURQUOI vivent dans
      //    `optinIdPremiereTouche`, sous banc, parce qu'un commentaire ne se relit pas tout seul.
      ...optinIdPremiereTouche(existant.optin_id, optinId),
      // ⛔ MÊME RÈGLE, MÊME RAISON (voir `paysPremiereTouche`) : un pays déjà posé a servi à
      //    segmenter des envois DÉJÀ PARTIS. La clé n'est pas citée quand il n'y a rien à écrire —
      //    `country: x ?? null` effacerait la valeur existante à chaque réinscription muette.
      ...paysPremiereTouche(existant.country, paysContact),
      // ⛔ FUSION PAR OU, JAMAIS ÉCRASEMENT (P3). Une seconde inscription muette sur
      //    `tracking_consent` écrivait `false` par-dessus un `true` et remettait la date à NULL —
      //    une réduction de consentement SANS aucun `consent_event` de retrait, donc sans preuve
      //    et sans trace. Le retrait garde son chemin : le centre de préférences, qui écrit la
      //    sienne.
      tracking_consent: existant.tracking_consent === true || trackingConsent,
      tracking_consent_at: existant.tracking_consent_at ?? trackingConsentAt,
      granted_purposes: mergePurposes(existant.granted_purposes, grantedPurposes),
      // Même règle pour le détail de provenance : les `lead_id` s'empilent dans les événements de
      // capture, mais ce jsonb ne doit pas perdre ce qu'une inscription précédente y avait mis.
      source, source_detail: { ...(existant.source_detail ?? {}), ...sourceDetail },
      // Lu partout, jamais posé jusqu'ici : les preuves de consentement citaient une
      // version du texte que la souscription elle-même ne portait pas.
      consent_version_id: consentVersion?.id ?? null,
    }).eq("id", subscriptionId) : null;
    if (majSouscription?.error) {
      const refus = suiteDe("subscription-update", majSouscription.error);
      if (refus) return refus;
    }
  } else {
    const { data: created, error } = await db.from("subscription").insert({
      subscriber_id: subscriberId, asset_id: asset.id, edition_id: edition?.id ?? null,
      optin_id: optinId,
      // `pending` (attend son clic) ou `contact` (0088) — décidé par `decideSignup`, sous banc.
      status: seq.createStatus, source, source_detail: sourceDetail, language: edition?.language ?? null,
      // Première touche par construction : la souscription n'existait pas.
      country: paysContact,
      tracking_consent: trackingConsent, tracking_consent_at: trackingConsentAt,
      granted_purposes: grantedPurposes,
      // Un contact n'a accepté aucun texte de consentement : citer une version mentirait.
      consent_version_id: modeContact ? null : consentVersion?.id ?? null,
    }).select("id").single();
    if (error || !created) return refusDb("subscription-insert", error);
    subscriptionId = created.id;
  }

  /**
   * --- Catégories choisies à l'inscription (pont depuis la capture) ---
   *
   * Posées en TAGS, jamais en finalités : voir l'en-tête de `lib/interests.ts`.
   *
   * ⛔ APRÈS la souscription et AVANT rien du tout : l'abonné existe déjà, son
   * consentement est enregistré, et un échec ici ne doit pas coûter l'un ni
   * l'autre. La fonction ne lève pas ; son motif d'échec est journalisé pour
   * qu'un pont qui n'attache plus rien ne soit pas un silence.
   *
   * Réservé à l'ingestion serveur : le formulaire public ne propose pas encore
   * de catégories, et accepter le champ d'un appelant anonyme laisserait
   * n'importe qui créer des tags sur n'importe quelle marque.
   *
   * ⛔ `seq.applyTags` est faux pour un contact sur une souscription EXISTANTE : il n'y touche pas.
   */
  if (serverIngest && seq.applyTags) {
    /*
     * Le tag par défaut de l'optin, s'il en a un.
     *
     * ⛔ APRÈS la souscription, comme les catégories, et pour la même raison : l'abonné et son
     * consentement sont déjà enregistrés, un échec de tag ne doit coûter ni l'un ni l'autre. Le
     * motif est journalisé — un tag qui cesse d'être posé ne doit pas être un silence.
     */
    const motifTag = await applyOptinTag(db, subscriptionId, optinDefaultTagId);
    if (motifTag) {
      console.error(
        JSON.stringify({
          event: "signup-optin-tag-failed",
          subscription_id: subscriptionId,
          tag_id: optinDefaultTagId,
          reason: motifTag,
        }),
      );
    }

    // ⛔ CHEMIN v1 SEULEMENT. Quand `capture` est là, il gagne : traiter les deux poserait, pour le
    //    même sujet, un tag `kind='manual'` (slug brut) ET un tag `kind='interest'` (slug préfixé
    //    par sa taxonomie) — deux identités permanentes pour un seul intérêt.
    const wanted = capture ? [] : normalizeInterests(body.interests);
    if (wanted.length > 0) {
      const outcome = await applyInterests(db, asset.id, subscriptionId, wanted);
      if (outcome.error) {
        console.error(
          JSON.stringify({
            event: "signup-interests-failed",
            subscription_id: subscriptionId,
            asked: wanted,
            applied: outcome.applied,
            reason: outcome.error,
          }),
        );
      }
    }
  }

  // --- Consentement (log immuable) : demande d'opt-in ---
  //
  // ⛔ PAS SUR UNE SOUSCRIPTION DÉJÀ ACTIVE. `optin_request` est la preuve d'une DEMANDE d'opt-in
  // qui attend sa confirmation ; en écrire une sur un abonné déjà confirmé raconterait dans le
  // journal légal une demande qui n'a jamais eu de réponse, et un export DSAR y lirait un
  // consentement en attente à côté d'un consentement acquis.
  //
  // ⛔ ET SON ÉCHEC REFUSE, AVANT LE JETON QUI SUIT. Continuer fabriquerait un abonné CONFIRMABLE
  // dont la preuve légale n'existe nulle part : le défaut ne se voit pas le jour où il arrive, il
  // se voit le jour d'un contrôle, sur des mois de leads.
  const preuve = seq.writeConsentEvent ? await db.from("consent_event").insert({
    subscription_id: subscriptionId,
    consent_version_id: consentVersion?.id ?? null,
    event_type: "optin_request",
    ip_address: ip, user_agent: ua, method: serverIngest ? "capture_bridge_doi" : "widget_doi",
    source_url: sourceUrl, country: edition?.market ?? null, language: edition?.language ?? null, legal_basis: legalBasis,
    metadata: { tracking_consent: trackingConsent, granted_purposes: grantedPurposes, ...(serverIngest ? { source_detail: sourceDetail } : {}) },
  }) : null;
  if (preuve?.error) {
    const refus = suiteDe("consent-event-insert", preuve.error);
    if (refus) return refus;
  }

  // --- Token double opt-in (stocké hashé) ---
  //
  // ⛔ AUCUN JETON, AUCUN E-MAIL SUR UNE SOUSCRIPTION ACTIVE. C'est le geste irréversible de tout
  // ce lot : envoyer une confirmation à quelqu'un de déjà confirmé est public, ne se rattrape pas,
  // et transforme une deuxième inscription (un fait normal) en incident de réputation.
  let confirmUrl: string | null = null;
  if (seq.issueToken) {
    const { raw, hash } = newDoiToken();
    const { error: erreurJeton } = await db.from("doi_token").insert({
      subscription_id: subscriptionId,
      token_hash: hash,
      expires_at: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
    });
    // ⛔⛔ LE REFUS LE PLUS IMPÉRATIF DU LOT. `confirmUrl` ci-dessous est bâti avec le `raw` gardé
    //     en mémoire, hors de toute garde : sans la ligne en base, le lien envoyé à une VRAIE
    //     PERSONNE est mort à la seconde où il part. Irréversible, invisible, et le seul témoin
    //     serait son silence. On s'arrête AVANT de fabriquer l'URL.
    if (erreurJeton) {
      const refus = suiteDe("doi-token-insert", erreurJeton);
      if (refus) return refus;
    }
    /**
     * ⛔⛔ MÊME DOCTRINE QUE LE JETON CI-DESSUS : on s'arrête AVANT de fabriquer une URL qui ne mène
     * nulle part. Sans origine publique, le lien partirait sur l'adresse d'écoute du conteneur
     * (`https://0.0.0.0:3000/confirm?token=…`) — constaté le 18/09/2026 : la personne clique et lit
     * « This site can't be reached », son inscription reste `pending` pour toujours. Refuser laisse
     * la capture rejouable côté pont ; envoyer un lien mort ne se rattrape pas.
     */
    if (!origine.ok) {
      console.error(
        JSON.stringify({ event: "signup-origine-non-publique", refused: true, message: origine.raison }),
      );
      return NextResponse.json({ error: "origine-publique-absente" }, { status: 500 });
    }
    const langParam = edition?.language ? `&lang=${encodeURIComponent(edition.language)}` : "";
    confirmUrl = `${origine.origine}/confirm?token=${raw}${langParam}`;
  }

  // --- Email de confirmation (stubé → outbox) ---
  //
  // ⛔ SANS CETTE LIGNE EN FILE, LE WORKER N'A RIEN À DRAINER. La personne ne reçoit jamais son
  // lien et sa souscription reste `pending` pour toujours — un abonné perdu, que le `200 {ok:true}`
  // d'avant déclarait acquis. `queueEmail` rendait `Promise<void>` : elle ne POUVAIT rien dire.
  if (seq.sendConfirmation && confirmUrl) {
    /*
     * ⛔ L'OBJET EST FIGÉ ICI, PAS AU RENDU. `email_outbox.subject` est écrit une fois et le worker
     * le sert tel quel : c'est donc cette ligne, et elle seule, qui décide dans quelle langue la
     * personne lira son e-mail. Elle était EN DUR EN FRANÇAIS pendant que `i18n.ts` traduisait les
     * pages en six locales — mesuré le 15/09/2026 sur quatre souscriptions `language = 'es'` mises
     * en file avec « Confirme ton inscription ».
     *
     * ⚠️ La langue vient de l'ÉDITION, la même source que le `lang` du lien de confirmation
     * construit juste au-dessus. Prendre une autre source ferait diverger l'objet de l'e-mail et la
     * page qu'il ouvre — deux langues pour un seul geste.
     */
    const motifEnvoi = await queueEmail(db, {
      assetId: asset.id, subscriptionId, toEmail: email, kind: "confirmation",
      subject: dict(normalizeLocale(edition?.language)).m.confirmSubject(asset.name),
      actionUrl: confirmUrl, payload: { first_name: firstName },
    });
    if (motifEnvoi) {
      const refus = suiteDe("confirmation-email", { message: motifEnvoi });
      if (refus) return refus;
    }
  }

  /**
   * --- L'ÉVÉNEMENT DE CAPTURE : la provenance, toujours écrite ---
   *
   * ⛔ EN DERNIER, ET C'EST LA CLÉ ÉTRANGÈRE QUI L'EXIGE : `capture_event.subscription_id`
   * référence la souscription, qui doit donc exister. C'est aussi le bon ordre moralement — un
   * échec ici ne coûte ni l'abonné ni son consentement, tous deux déjà écrits.
   *
   * ⚠️ UN CORPS v1 PRODUIT UN ÉVÉNEMENT À `interest_ids` VIDE, même s'il a envoyé des `interests`.
   * Ce n'est pas un oubli : le v1 ne dit ni taxonomie ni offre, ses tags sont `kind='manual'`, et
   * verser leurs ids ici les ferait entrer dans `subscription.interest_ids` — la projection sur
   * laquelle le ciblage par intérêt s'appuie. Un tag posé par l'équipe deviendrait un goût déclaré
   * par l'abonné.
   */
  let captureEventId: string | null = null;
  let duplicate = false;
  let resolved: CaptureEcho | null = null;
  if (seq.writeCaptureEvent) {
    const leadExternalId =
      capture?.leadId ?? (typeof sourceDetail.lead_id === "string" ? sourceDetail.lead_id : null);
    const ecrit = await writeCaptureEvent(db, {
      subscriptionId,
      assetId: asset.id,
      optinId,
      captureCampaignId,
      leadExternalId,
      occurredAt: capture?.occurredAt,
      interestIds: interestIdsCaptured,
      interestsOffered: interestsOfferedIds,
      campaignNameAtCapture,
      optinNameAtCapture,
      // Voir la décision (b) dans `lib/capture.ts` : la colonne s'appelle `variant_external_id` et
      // reçoit un LIBELLÉ de variante. Le nom ment, et perdre la variante coûterait plus cher.
      variantExternalId: capture?.creative?.variantLabel ?? null,
      sourceUrl,
      ipAddress: ip,
      userAgent: ua,
      automationLabel: capture?.creative?.automationLabel ?? null,
    });
    if (ecrit.error) {
      console.error(
        JSON.stringify({
          event: "signup-capture-event-failed",
          subscription_id: subscriptionId,
          reason: ecrit.error,
        }),
      );
    }
    captureEventId = ecrit.id;
    duplicate = ecrit.duplicate;

    /**
     * ⛔ L'ÉCHO SE CONSTRUIT À LA RELECTURE, JAMAIS EN RECOPIANT LA REQUÊTE. Un écho recopié depuis
     * l'entrée ne prouve que la capacité à parser du JSON : il annoncerait une campagne rattachée
     * alors que la résolution a échoué et que la colonne est NULL. C'est une requête DISTINCTE de
     * l'insert, adressée par l'id que la base a rendu.
     */
    if (captureEventId) resolved = await readCaptureEcho(db, captureEventId);
  }

  if (serverIngest) {
    return echoIngestion({
      mode: luMode.mode,
      already: existant?.status === "active",
      duplicate,
      subscriptionId,
      captureEventId,
      resolved,
      rejectedInterests: interestsEcartes,
      ignoredFields,
      devConfirmUrl: process.env.NODE_ENV !== "production" ? confirmUrl : null,
    });
  }

  const res: Record<string, unknown> = { ok: true };
  if (process.env.NODE_ENV !== "production" && confirmUrl) res._devConfirmUrl = confirmUrl; // aide au test uniquement
  return NextResponse.json(res);
}
