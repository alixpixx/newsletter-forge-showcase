/**
 * Inscrire un contact depuis l'admin — en APPELANT le parcours public, jamais en le refaisant.
 *
 * ⛔⛔ IL N'EXISTE QU'UN SEUL CHEMIN DE CRÉATION D'ABONNÉ DANS CE DÉPÔT, et il est dans
 * `apps/public/src/app/api/v1/signup/route.ts` : deux `insert` en ligne, précédés de la liste de
 * suppression, du dédoublonnage, de la version de consentement, du jeton et de la mise en file de
 * l'e-mail. Aucune RPC, aucune fonction partagée — vérifié sur les 70 migrations et sur tout
 * `apps/`. En réécrire un second ici donnerait deux définitions de « inscrire quelqu'un », et
 * elles divergeraient par celle que personne ne teste : celle-ci. Le précédent est `erase_subscriber`.
 *
 * La route a déjà la porte prévue pour ce cas : le mode **ingestion serveur-à-serveur**, en-tête
 * `x-nf-ingest-secret`, spécifié dans `docs/INGEST-API.md`. On l'appelle en HTTP.
 *
 * TROIS RÈGLES QUE LE CONTRAT IMPOSE, ET QU'ON NE PEUT PAS DEVINER À LA RELECTURE :
 *
 *  1. ⛔ NE JAMAIS ENVOYER `ip_address` NI `user_agent`. Ces champs portent la PREUVE DE
 *     CONSENTEMENT et désignent le VISITEUR (`INGEST-API.md` §2). Ici il n'y a pas de visiteur :
 *     il y a un opérateur devant l'admin. Y mettre l'IP du serveur ou celle de l'opérateur
 *     fabriquerait une preuve qui désigne la mauvaise machine — pire qu'une preuve absente, parce
 *     qu'elle a l'air d'en être une.
 *
 *  2. ⛔ `source` EST UN ENUM FERMÉ, ET IL ÉCHOUE EN SILENCE. Toute valeur hors
 *     `organic|social|crm_sync|import|content_upgrade` retombe sur `content_upgrade` sans
 *     prévenir : une faute de frappe rangerait tous ces contacts sous la mauvaise provenance,
 *     pour toujours, sans un message.
 *
 *  3. ⛔ AUCUN RÉESSAI AUTOMATIQUE. `INGEST-API.md` §7 : rejouer l'appel pour un contact `pending`
 *     « remet à jour la souscription et émet un NOUVEAU jeton » — donc un deuxième e-mail de
 *     confirmation. Un réessai après une réponse perdue alors que l'écriture a eu lieu écrit une
 *     deuxième fois à quelqu'un qui n'a rien demandé. On préfère rendre l'échec visible et laisser
 *     un humain relancer les seules lignes concernées.
 */

/** La provenance, écrite une fois. Toute autre valeur serait avalée sans erreur. */
export const SOURCE_IMPORT = "import" as const;

/**
 * Le plafond d'un fichier, en contacts VALIDES.
 *
 * ⛔ CE N'EST PAS UNE LIMITE TECHNIQUE, C'EST UNE LIMITE DE DÉGÂTS. Chaque contact déclenche un
 * e-mail de confirmation réel, et `0023_outbox_priority.sql` place le transactionnel AVANT les
 * campagnes : un import massif passe donc devant tout ce qui attend. Au-delà de ce nombre, la
 * route REFUSE le fichier au lieu d'en prendre le début — une troncature muette perdrait des
 * contacts en annonçant « terminé ».
 */
export const MAX_IMPORT = 1000;

/**
 * Le nombre de contacts traités par appel HTTP.
 *
 * Chaque contact est un aller-retour vers l'app publique. Au-delà, la requête dépasse les limites
 * de temps d'exécution et l'écran perd le résultat de lignes DÉJÀ écrites — qu'on rejouerait,
 * envoyant une deuxième confirmation à des gens qui l'ont déjà reçue.
 */
export const MAX_PAR_APPEL = 25;

/** Ce qu'on sait du sort d'un contact après l'appel. */
export type EtatInscription = "mis-en-file" | "deja-actif" | "refus" | "injoignable";

export type ResultatInscription = {
  etat: EtatInscription;
  /** Le code rendu par la route (`reserved_domain`, `marque-inconnue`…), pour l'afficher tel quel. */
  code?: string;
  /** Une phrase en anglais, prête pour l'écran. */
  message?: string;
};

/** D'où vient l'inscription : un ajout à l'unité, ou une ligne de fichier. */
export type Origine = "add" | "import";

export type DemandeInscription = {
  email: string;
  prenom?: string;
  /** Le SLUG de la marque, pas son identifiant — c'est ce que la route attend. */
  assetSlug: string;
  origine: Origine;
  /** Le nom du fichier déposé, s'il y en a un. Sert uniquement à la traçabilité. */
  fichier?: string;
};

/**
 * Le corps de la requête. Fonction pure : c'est elle qu'on prouve, pas le réseau.
 *
 * `consent: true` est OBLIGATOIRE côté route, et ce n'est pas une preuve fabriquée : il déclenche
 * un `consent_event` de type **`optin_request`** — la trace d'une DEMANDE. Le consentement lui-même
 * n'est écrit qu'au clic sur le lien, en `optin_confirm`. L'inscription reste `pending` d'ici là et
 * rien d'autre ne lui est envoyé. C'est exactement ce qu'Alix a tranché : l'adresse entre en
 * attente et reçoit une confirmation, on n'atteste rien à sa place.
 */
export function corpsInscription(d: DemandeInscription): Record<string, unknown> {
  const corps: Record<string, unknown> = {
    email: d.email.trim().toLowerCase(),
    asset: d.assetSlug,
    consent: true,
    source: SOURCE_IMPORT,
    source_detail: {
      origin: "admin",
      mode: d.origine,
      ...(d.fichier ? { file: d.fichier } : {}),
    },
  };

  // Un prénom vide n'est pas envoyé : la route écrase `first_name` quand le champ est fourni, et
  // une chaîne vide effacerait un prénom déjà connu sur un contact existant.
  const prenom = (d.prenom ?? "").trim();
  if (prenom !== "") corps.first_name = prenom;

  // ⛔ Ni `edition` (absente = édition primaire ; un slug inconnu serait un 404), ni `ip_address`,
  // ni `user_agent`, ni `granted_purposes` : on n'invente aucune finalité au nom de la personne.
  return corps;
}

/** Les messages d'écran, un par code que la route peut rendre. */
const MESSAGES: Record<string, string> = {
  "ingest-refuse": "The admin is not allowed to reach the signup route — the shared secret is missing or wrong.",
  "marque-inconnue": "This brand is unknown to the public app.",
  "edition-inconnue": "This edition is unknown for this brand.",
  "email-invalide": "Not a valid email address.",
  "consentement-requis": "Consent was refused by the signup route.",
  "finalites-inconnues": "One of the consent purposes is outside the accepted vocabulary.",
  "optin-invalide": "The opt-in slug is malformed.",
  reserved_domain: "Reserved test domain (example.com and friends) — only demo contacts may use it.",
  db: "The database refused the write. The reason is in the public app's logs.",
  "service-indisponible": "The public app cannot reach its database right now.",
};

/**
 * Ce que la réponse veut dire. Fonction pure.
 *
 * ⛔ UN 200 NE VEUT PAS DIRE « ABONNÉ », ET IL VEUT DIRE TROIS CHOSES DIFFÉRENTES
 * (`INGEST-API.md` §5) : inscription créée en attente ; contact déjà **actif**, rien fait ; ou
 * adresse en **liste de suppression** — et ce dernier cas est rendu SILENCIEUX À DESSEIN, pour ne
 * jamais confirmer à un tiers qu'une adresse est supprimée. On ne peut donc pas distinguer le
 * premier du troisième, et l'écran ne doit surtout pas annoncer « N inscrits » : il annonce ce
 * qu'on sait, « N acceptés ».
 */
export function interpreterReponse(statut: number, corps: unknown): ResultatInscription {
  const objet = (corps ?? {}) as { ok?: unknown; already?: unknown; error?: unknown };

  if (statut === 200 && objet.ok === true) {
    return objet.already === true ? { etat: "deja-actif" } : { etat: "mis-en-file" };
  }

  const code = typeof objet.error === "string" ? objet.error : `http-${statut}`;
  return {
    etat: "refus",
    code,
    message: MESSAGES[code] ?? `The signup route refused this address (${code}).`,
  };
}

/** Le sort d'une ligne de fichier : son rang, son adresse, et ce qu'on en sait. */
export type LigneResultat = ResultatInscription & {
  ligne: number;
  email: string;
};

export type ResumeInscriptions = {
  misEnFile: number;
  dejaActifs: number;
  refuses: number;
  injoignables: number;
  total: number;
};

/**
 * Les totaux à afficher. Fonction pure.
 *
 * ⛔ « misEnFile » NE VEUT PAS DIRE « INSCRITS ». Il compte les adresses que la route a acceptées :
 * la plupart recevront une confirmation, mais celles qui sont en liste de suppression rendent la
 * MÊME réponse, silencieusement et à dessein (`INGEST-API.md` §5). L'écran doit dire « accepted »,
 * jamais « subscribed » — et surtout jamais « emails sent », que personne ici ne peut savoir.
 */
export function resumerInscriptions(lignes: LigneResultat[]): ResumeInscriptions {
  const resume: ResumeInscriptions = {
    misEnFile: 0,
    dejaActifs: 0,
    refuses: 0,
    injoignables: 0,
    total: lignes.length,
  };
  for (const l of lignes) {
    if (l.etat === "mis-en-file") resume.misEnFile += 1;
    else if (l.etat === "deja-actif") resume.dejaActifs += 1;
    else if (l.etat === "injoignable") resume.injoignables += 1;
    else resume.refuses += 1;
  }
  return resume;
}

export type OptionsAppel = {
  base: string;
  secret: string;
  fetchImpl?: typeof fetch;
};

/**
 * L'appel lui-même — mince à dessein : tout ce qui se décide est au-dessus, et se prouve sans réseau.
 *
 * ⛔ Pas de réessai (voir l'en-tête, règle 3). Une panne réseau rend `injoignable`, jamais un
 * second appel.
 */
export async function inscrireUnContact(
  d: DemandeInscription,
  o: OptionsAppel,
): Promise<ResultatInscription> {
  const appeler = o.fetchImpl ?? fetch;

  let reponse: Response;
  try {
    reponse = await appeler(`${o.base.replace(/\/+$/, "")}/api/v1/signup`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-nf-ingest-secret": o.secret,
      },
      body: JSON.stringify(corpsInscription(d)),
      cache: "no-store",
    });
  } catch {
    // ⛔ Le message de l'exception n'est pas remonté : il peut porter l'URL complète et, selon le
    // moteur, l'en-tête. Le secret ne doit jamais atteindre un écran ni un journal.
    return {
      etat: "injoignable",
      code: "reseau",
      message: "The public app could not be reached. Nothing was written — run these lines again.",
    };
  }

  let corps: unknown = null;
  try {
    corps = await reponse.json();
  } catch {
    corps = null;
  }

  return interpreterReponse(reponse.status, corps);
}
