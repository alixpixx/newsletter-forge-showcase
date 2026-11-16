import type { Group, Predicate, RuleNode } from "./fields";
import { NO_OPTIN, PURPOSE_KEYS, SYSTEM_EMAIL_KEYS, getField } from "./fields";

/**
 * Compilateur arbre-de-règles → expression de filtre PostgREST.
 *
 * Garde-fous (mêmes principes que le compilateur SQL cible de packages/segments) :
 * - les COLONNES viennent d'une allowlist code-définie (jamais du JSON) ;
 * - les OPÉRATEURS viennent d'un enum fermé ;
 * - les VALEURS sont validées puis quotées — une valeur exotique fait rejeter le prédicat
 *   plutôt que de l'injecter dans l'expression.
 *
 * Les prédicats non supportés (comportement : nécessite le flux d'événements d'envoi,
 * tâche P2-23) sont ignorés et remontés dans `unsupported` pour être affichés à l'utilisateur
 * — jamais silencieusement.
 */

const COLUMN: Record<string, string> = {
  country: "country",
  language: "language",
  signup_source: "source",
  engagement_level: "engagement_level",
  open_count: "open_count",
  last_open: "last_open_at",
  never_opened: "open_count",
  completed_welcome: "welcome_completed",
  tag: "tag_ids",
  // ⚠️ Cette colonne doit exister dans `sendable_subscription` ET dans
  // `excluded_demo_subscription` : c'est là que l'admin compte et que le worker énumère, jamais
  // dans `subscription`. Migration 0052 — sans elle, PostgREST répond « column does not exist »,
  // l'estimation devient illisible et le fan-out LÈVE (l'édition ne part pas).
  optin: "optin_id",
  // ⚠️ MÊME PIÈGE QUE `optin_id` CI-DESSUS, sur trois colonnes de plus : elles doivent exister dans
  // LES TROIS vues d'audience (`sendable_subscription`, `sunsetted_subscription`,
  // `excluded_demo_subscription`) — c'est là que l'admin compte, que l'écran explique son zéro et
  // que le worker énumère, jamais dans `subscription`. Migration 0063. Sans elles, PostgREST répond
  // « column does not exist », l'estimation devient illisible et le fan-out LÈVE le jour de l'envoi.
  // ⛔ Ces colonnes sont écrites par le SEUL trigger `refresh_subscription_capture` : aucun code
  // applicatif ne les met à jour, et ce compilateur ne fait que les LIRE.
  capture_campaign: "capture_campaign_ids",
  capture_creative: "capture_optin_ids",
  interest: "interest_ids",
  // Les finalités acceptées, telles que la personne les a cochées au formulaire de capture.
  // ⚠️ MÊME PIÈGE DE VUE que les colonnes ci-dessus — vérifié avant d'ajouter ce champ :
  // `granted_purposes` est bien dans LES TROIS vues d'audience (migration 0063), et l'index GIN de
  // la migration 0013 la couvre. Aucune migration n'a donc été nécessaire pour ce champ.
  purpose: "granted_purposes",
  // La famille « Automations » : trois colonnes de la migration 0087, présentes dans LES TROIS vues
  // d'audience (ajoutées en fin de vue), écrites par ses SEULS déclencheurs. `consent_at` (la date de
  // confirmation, posée par `confirm/handler.ts`) y est depuis 0001.
  lifecycle_email: "lifecycle_sent",
  automation_email: "automations_sent",
  resubscribed: "resubscribed_at",
  confirmed: "consent_at",
};

/** Nécessite `nl_email_event` (pas encore alimenté : pas d'envoi réel). */
const NEEDS_EVENTS = new Set(["clicked_cta"]);

const SAFE_VALUE = /^[A-Za-z0-9:_\-.+]+$/;
/** Ceinture sur une valeur qui vient de la base : rien d'autre qu'un uuid n'entre dans l'expression. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Un identifiant de tag (donc d'intérêt) est un entier de `newsletter.tag.id`, jamais un slug. */
const POSITIVE_INT = /^[0-9]{1,9}$/;

/**
 * Les tables de correspondance dont la compilation a besoin, SCOPÉES MARQUE.
 *
 * ⛔ UN OBJET, ET PAS DES PARAMÈTRES OPTIONNELS QUI S'ACCUMULENT. Trois appelants compilent la
 * même règle : l'écran de segment, l'estimation d'audience d'une campagne et le fan-out. Un
 * quatrième paramètre facultatif qu'un seul d'entre eux oublierait ferait diverger le nombre annoncé
 * et le nombre envoyé — sur la même grandeur, sans erreur nulle part. Ici le typecheck refuse de
 * compiler tant que les trois ne fournissent pas la table.
 */
export interface RuleContext {
  /** slug → identifiant entier de `newsletter.tag` (unique par `(asset_id, slug)`). */
  tagIdBySlug: Record<string, number>;
  /** slug → identifiant uuid de `newsletter.optin` (unique par `(asset_id, slug)`). */
  optinIdBySlug: Record<string, string>;
  /*
   * LES TROIS LISTES BLANCHES DE PROVENANCE, SCOPÉES MARQUE.
   *
   * ⛔ POURQUOI ELLES SONT FACULTATIVES, ET POURQUOI ÇA NE COÛTE AUCUNE SÉCURITÉ. Le plan les
   * voulait obligatoires, pour forcer les trois appelants à se mettre à jour faute de CI. Les
   * rendre obligatoires casse par construction cinq fichiers hors de cette zone
   * (`api/segments/count`, `lib/data/campaigns`, `worker/fanout`, `worker/fanout-db`,
   * `worker/fanout.test`), traités par un autre agent — le dépôt resterait rouge entre les deux.
   *
   * Le repli choisi est FERMÉ, pas ouvert : une liste absente vaut « aucune valeur autorisée »,
   * donc TOUT prédicat de capture rend `null`, remonte dans `unsupported` et lève `widened` sous un
   * ET. Un appelant qui ne les fournit pas ne peut donc pas produire un filtre FAUX — il ne produit
   * aucun filtre, et refuse bruyamment. Le seul point perdu par rapport à « obligatoire » est le
   * rappel au typecheck ; la panne que le plan redoutait (un identifiant d'une AUTRE marque qui
   * compile en un filtre parfaitement valide, ne matchant personne en `any_of` et tout le monde en
   * `none_of`) reste impossible.
   *
   * Passer de `?:` à obligatoire est un geste d'une ligne par champ, le jour où les cinq ancrages
   * sont à jour.
   */
  /** Identifiants `newsletter.capture_campaign.id` autorisés pour la marque courante. */
  captureCampaignIds?: readonly string[];
  /** Identifiants `newsletter.optin.id` (les créatives) autorisés pour la marque courante. */
  captureOptinIds?: readonly string[];
  /** Identifiants `newsletter.tag.id` de `kind = 'interest'` autorisés pour la marque courante. */
  interestIds?: readonly number[];
  /**
   * Identifiants `newsletter.automation.id` de la marque courante, TOUS STATUTS : une automation
   * repassée en brouillon a toujours envoyé ce qu'elle a envoyé. Même repli FERMÉ que les trois
   * listes ci-dessus : absente, tout prédicat `automation_email` est dénoncé.
   */
  automationIds?: readonly string[];
}

/**
 * Ce qu'une valeur d'un champ multi a le droit d'être, ÉLÉMENT PAR ÉLÉMENT.
 *
 * ⛔ R4, LE DÉFAUT QUE CE TABLEAU RÉPARE. La ceinture historique s'applique à `String(p.value)` :
 * sur un tableau, elle inspecte la chaîne `"a,b"` et ne voit JAMAIS un élément
 * (`String(["a","b"]) === "a,b"`, et cette chaîne passe la regex). Un élément valant
 * `},x,and(country.eq."XX"` refermerait le groupe et ajouterait un terme au OU de premier niveau —
 * c'est-à-dire exactement la structure `.or(expr)` qu'utilisent les trois appelants : le filtre
 * s'ouvre alors sur toute la table.
 */
const MULTI_VALUE: Record<
  string,
  { valid: (v: string) => boolean; allowed: (ctx: RuleContext) => readonly (string | number)[] | undefined }
> = {
  capture_campaign: { valid: (v) => UUID.test(v), allowed: (c) => c.captureCampaignIds },
  capture_creative: { valid: (v) => UUID.test(v), allowed: (c) => c.captureOptinIds },
  interest: { valid: (v) => POSITIVE_INT.test(v), allowed: (c) => c.interestIds },
  // Les e-mails système ne dépendent pas de la marque : leur liste blanche est le registre.
  lifecycle_email: { valid: (v) => SYSTEM_EMAIL_KEYS.includes(v), allowed: () => SYSTEM_EMAIL_KEYS },
  automation_email: { valid: (v) => UUID.test(v), allowed: (c) => c.automationIds },
};

const daysAgoIso = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

/** Nommer le coupable au plus près de sa découverte : voir `CompiledRule.unsupported`. */
const denonce = (acc: Acc | undefined, label: string) => acc?.unsupported.push(label);

/**
 * La branche multi-valeurs — « une ou des » campagnes, créatives, intérêts.
 *
 * ⛔ `ov` (`&&`, « au moins une en commun ») ET SURTOUT PAS `cs` (`@>`, « contient TOUTES »).
 * `capture_optin_ids.cs.{a,b}` retient les abonnés entrés par la créative a ET par la créative b —
 * l'inverse exact de « une ou des ». Et il échoue en RÉTRÉCISSANT : aucun e-mail ne part, rien ne
 * le signale, on accuse l'ingestion pendant des heures.
 * `not.ov` est MESURÉ accepté par PostgREST en production (206) : pas de repli
 * `and(not.cs.{a},not.cs.{b})` — deux chemins pour la même question dont un seul serait exercé,
 * et c'est celui qui ne l'est jamais qui se tromperait.
 */
function multiExpr(p: Predicate, valeurs: string[], col: string, ctx: RuleContext, acc?: Acc): string | null {
  const spec = MULTI_VALUE[p.field];
  if (!spec) return null;

  /*
   * ⛔ LA LISTE VIDE NE SE COMPILE JAMAIS, ET CE TEST EST EN TÊTE DE BRANCHE.
   * `cs.{}` matche TOUT LE MONDE (mesuré : 1 203 / 1 203 — en SQL tout tableau contient l'ensemble
   * vide) et `ov.{}` NE MATCHE PERSONNE. Deux pannes opposées pour le même clic, et `widened`
   * resterait aveugle puisque le prédicat aurait COMPILÉ. Ici il ne compile pas : il est dénoncé.
   */
  if (valeurs.length === 0) {
    denonce(acc, p.field);
    return null;
  }

  const autorises = spec.allowed(ctx);
  if (!autorises) {
    denonce(acc, p.field);
    return null;
  }

  /*
   * ⛔ TOUT OU RIEN, JAMAIS « LES DEUX QUI RESTENT SUR TROIS ». On rend `null` au PREMIER élément
   * refusé, et on ne filtre surtout pas l'élément fautif : un `any_of` amputé RÉTRÉCIT en silence,
   * un `none_of` amputé ÉLARGIT — et `widened` compte les enfants d'un groupe, pas les valeurs
   * d'un prédicat. Il ne verrait donc rien.
   */
  const ids: string[] = [];
  for (const brut of valeurs) {
    const v = String(brut);
    const connu = autorises.some((a) => String(a).toLowerCase() === v.toLowerCase());
    if (!spec.valid(v) || !connu) {
      denonce(acc, `${p.field}:${v}`);
      return null;
    }
    ids.push(v);
  }

  switch (p.op) {
    case "any_of": return `${col}.ov.{${ids.join(",")}}`;
    case "none_of": return `${col}.not.ov.{${ids.join(",")}}`;
    default: return null;
  }
}

function predicateExpr(p: Predicate, ctx: RuleContext, acc?: Acc): string | null {
  // Un sélecteur de population arrivé jusqu'ici n'était PAS au premier niveau d'un ET (voir
  // `choisirPopulation`) : on ne sait pas l'honorer, donc la règle est refusée — même sous un OU, où
  // l'ignorer ferait compter des abonnés à la place des contacts demandés.
  if (p.field === SELECTEUR_POPULATION) {
    denonce(acc, `${SELECTEUR_POPULATION}:nested`);
    if (acc) acc.widened = true;
    return null;
  }
  if (NEEDS_EVENTS.has(p.field)) return null;
  const col = COLUMN[p.field];
  if (!col) return null;

  /*
   * ⛔ LA QUATRIÈME BARRIÈRE : LE CHAMP DOIT DÉCLARER L'OPÉRATEUR.
   *
   * Les `switch` fermés ci-dessous refusent un opérateur inconnu branche par branche, mais le
   * `switch` scalaire final accepte `eq`/`neq`/`gte`/`lte` pour N'IMPORTE QUEL champ : `country`
   * avec `gte` compilait en `country.gte.0`, un filtre parfaitement valide qui ne veut rien dire.
   * Une paire champ×opérateur que l'écran ne peut pas produire vient donc d'une règle forgée ou
   * périmée — on refuse, on ne devine pas.
   */
  const f = getField(p.field);
  if (!f || !f.ops.includes(p.op)) return null;

  // ⚠️ AVANT tout le reste : un tableau est un objet, et un tableau posé sur un champ scalaire
  // (`never_opened: ["x"]`) tombait autrefois dans un ternaire et compilait un filtre INVERSE.
  if (Array.isArray(p.value)) return multiExpr(p, p.value, col, ctx, acc);

  // « ever » : la date existe. La valeur (des jours restés d'un autre opérateur) est ignorée, et le
  // champ a déjà dû déclarer l'opérateur à la barrière ci-dessus.
  if (p.op === "ever") return `${col}.not.is.null`;

  /*
   * ⛔ POURQUOI DES `switch` FERMÉS ET PLUS DES TERNAIRES BINAIRES (les six, dans tout ce qui suit).
   * Un ternaire `p.op === "X" ? A : B` est TOTAL : un opérateur neuf ne lève rien, il tombe dans le
   * `else` — c'est-à-dire dans la NÉGATION du filtre demandé, avec `widened: false` et
   * `unsupported: []`. Le pire défaut possible : un envoi PLUS LARGE que la règle affichée, sans
   * qu'un seul garde-fou ne se lève. `default: return null` fait au contraire remonter le prédicat
   * dans `unsupported`, et l'appelant refuse.
   */
  // Booléens dérivés
  if (p.field === "never_opened") {
    switch (p.op) {
      case "is_true": return "open_count.eq.0";
      case "is_false": return "open_count.gt.0";
      default: return null;
    }
  }
  if (p.field === "completed_welcome") {
    switch (p.op) {
      case "is_true": return "welcome_completed.is.true";
      case "is_false": return "welcome_completed.is.false";
      default: return null;
    }
  }

  // Tags → tableau tag_ids (contains).
  // `not.cs` sur une colonne NULL rendrait NULL, donc faux, donc une exclusion qui exclut aussi
  // ceux qui n'ont aucun tag. Mesuré le 08/09/2026 sur cette base : `tag_ids` n'a AUCUN NULL
  // (783 tableaux vides sur 1 203) — la colonne a un défaut `{}`. Le cas ne se pose pas ici, il se
  // pose pour `optin_id` juste en dessous.
  if (p.field === "tag") {
    const id = ctx.tagIdBySlug[String(p.value)];
    if (id === undefined) return null;
    switch (p.op) {
      case "has": return `tag_ids.cs.{${id}}`;
      case "not_has": return `tag_ids.not.cs.{${id}}`;
      default: return null;
    }
  }

  /*
   * CE QUE LA PERSONNE A ACCEPTÉ DE RECEVOIR, finalité par finalité.
   *
   * ⛔ LE MÊME PIÈGE DE NULL QUE `optin` JUSTE EN DESSOUS, sous une autre forme : ici ce n'est pas
   * la colonne qui est NULL — `granted_purposes` est `not null default '{}'` — c'est LA CLÉ qui
   * peut manquer dans le jsonb. Une clé absente n'est PAS `false` : `granted_purposes->>'partners'`
   * rend NULL, et en SQL `NOT (NULL = 'true')` vaut NULL, donc faux.
   *
   * MESURÉ le 18/09/2026 sur la base, avant d'écrire cette branche, sur `partners` :
   *   1 208 lignes · accepté 5 · refusé 1 202 · CLÉ ABSENTE 1.
   *   « accepté » (5) + « refusé OU absent » (1 203) = 1 208 ✅
   *   la négation naïve `not(…= 'true')` = 1 202 ❌ — elle perd la ligne à clé absente.
   * Une personne dont on n'a jamais eu la réponse serait donc tombée dans AUCUN des deux côtés du
   * filtre : invisible aussi bien dans « a accepté » que dans « n'a pas accepté ». D'où la
   * disjonction explicite, exactement comme pour `optin_id`.
   *
   * ⛔ `->>` ET NON `cs` : l'expression part dans un `or=(…)` PostgREST, où `cs.{"offers":true}`
   * ferait entrer accolades et guillemets dans une liste déjà délimitée par des virgules et des
   * parenthèses. `->>cle.eq.true` n'a aucun caractère à échapper. La clé est validée contre
   * `PURPOSE_KEYS`, dérivée du registre des champs, donc rien d'autre n'atteint l'expression.
   */
  if (p.field === "purpose") {
    const cle = String(p.value);
    if (!PURPOSE_KEYS.includes(cle)) {
      denonce(acc, `${p.field}:${cle}`);
      return null;
    }
    switch (p.op) {
      case "eq": return `granted_purposes->>${cle}.eq.true`;
      case "neq":
        return `or(granted_purposes->>${cle}.eq.false,granted_purposes->>${cle}.is.null)`;
      default: return null;
    }
  }

  /*
   * Formulaire d'origine.
   *
   * ⛔ DEUX PIÈGES DE NULL, ET LES DEUX PORTENT SUR LES MÊMES 1 203 CONTACTS (ceux d'avant le lot
   * optin, dont `optin_id` est NULL) :
   *  1. « aucun formulaire » ne peut pas s'écrire comme une valeur ordinaire — `optin_id.eq.null`
   *     ne matche rien. D'où `is.null`, sur une valeur sentinelle que la contrainte de format des
   *     slugs rend inatteignable pour un vrai optin ;
   *  2. « le formulaire n'est PAS X » doit les GARDER : en SQL `NULL <> x` vaut NULL, donc faux,
   *     donc un `neq` seul les exclurait en silence. Quelqu'un qui cible « tout sauf le guide »
   *     perdrait les 1 203 contacts historiques sans qu'aucun message ne l'en avertisse.
   *     D'où la disjonction explicite.
   */
  if (p.field === "optin") {
    const slug = String(p.value);
    if (slug === NO_OPTIN) {
      switch (p.op) {
        case "eq": return "optin_id.is.null";
        case "neq": return "optin_id.not.is.null";
        default: return null;
      }
    }
    const id = ctx.optinIdBySlug[slug];
    if (id === undefined || !UUID.test(id)) return null;
    switch (p.op) {
      case "eq": return `optin_id.eq.${id}`;
      case "neq": return `or(optin_id.neq.${id},optin_id.is.null)`;
      default: return null;
    }
  }

  // Fenêtres temporelles.
  // ⚠️ Le dispatch se fait sur la FORME DE LA VALEUR, pas sur le champ — et c'est voulu : les deux
  // segments en base qui stockent `last_open: 30` en nombre nu ratent cette branche, tombent dans
  // le chemin scalaire et meurent au `switch` final. Ils sont incomptables ET inenvoyables, ce qui
  // est le comportement juste : élargir la garde leur donnerait un sens qu'ils n'ont pas.
  if (typeof p.value === "object" && p.value !== null && "days" in p.value) {
    const iso = daysAgoIso(Number(p.value.days) || 30);
    switch (p.op) {
      case "older_than_days": return `${col}.lt."${iso}"`;
      case "within_days": return `${col}.gte."${iso}"`;
      default: return null;
    }
  }

  const v = String(p.value);
  if (!SAFE_VALUE.test(v)) return null;

  switch (p.op) {
    case "eq": return `${col}.eq."${v}"`;
    case "neq": return `${col}.neq."${v}"`;
    case "gte": return `${col}.gte.${Number(v) || 0}`;
    case "lte": return `${col}.lte.${Number(v) || 0}`;
    default: return null;
  }
}

/**
 * Ce qu'une règle a réellement produit.
 *
 * ⛔ POURQUOI CE N'EST PLUS UNE SIMPLE CHAÎNE. Un prédicat que le compilateur ne sait pas évaluer
 * était jeté, noté dans `unsupported`, et le reste compilé. C'est ASYMÉTRIQUE, et dans le mauvais
 * sens : retirer un terme d'un ET n'enlève pas des destinataires, il en AJOUTE. « brésiliens ET
 * tagués campagne-X » privé de son second terme devient « tous les brésiliens » — l'écran affiche
 * toujours les deux conditions, et le fan-out ne s'arrête pas. Un avertissement suppose que
 * quelqu'un le lit AVANT l'effet ; sur un envoi, l'effet est immédiat et irréversible.
 * D'où `widened`, que les trois appelants doivent traiter comme un refus.
 */
export interface CompiledRule {
  /** L'expression PostgREST, ou `null` quand la règle ne restreint rien. */
  expr: string | null;
  /**
   * Ce qui n'a pas pu être compilé, NOMMÉ : `tag:vip`, `optin:guia`, `clicked_cta`.
   * Le type du champ seul ne dit pas lequel des trois tags a disparu — un avertissement qui ne
   * nomme pas le coupable n'est pas actionnable.
   */
  unsupported: string[];
  /**
   * ⛔ Un prédicat écarté ÉLARGIT l'ensemble : il était sous un ET.
   * L'appelant ne doit ni compter, ni envoyer — il doit refuser et le dire.
   * (Sous un OU, un terme perdu RÉTRÉCIT l'ensemble : signaler suffit.)
   */
  widened: boolean;
  /**
   * La vue que la règle désigne : `subscribers` → `sendable_subscription`, `contacts` →
   * `contact_subscription` (0088). ⛔ Les appelants lisent CETTE vue et jamais les deux : un contact
   * n'est atteint que par une règle qui porte « Newsletter: No ».
   */
  population: Population;
}

export type Population = "subscribers" | "contacts";

/**
 * La vue d'audience de chaque population — UNE table pour les quatre appelants (compte, estimation,
 * membres, fan-out). ⛔ Écrire le nom de vue ailleurs, c'est la certitude qu'un jour l'écran compte
 * les contacts et que le fan-out enfile les abonnés, ou l'inverse.
 */
export const AUDIENCE_VIEW: Readonly<Record<Population, string>> = {
  subscribers: "sendable_subscription",
  contacts: "contact_subscription",
};

/** Le champ qui choisit la population (voir `fields.ts`). */
const SELECTEUR_POPULATION = "newsletter";

/**
 * Lit le sélecteur de population au PREMIER NIVEAU d'un ET et le retire de l'arbre à compiler.
 *
 * ⛔ Il ne compile en AUCUN filtre : il choisit la vue. Le laisser dans l'arbre le ferait dénoncer
 * comme un prédicat inconnu, donc refuser toute règle qui le porte.
 * ⛔ TOUT OU RIEN : une valeur inconnue, un autre opérateur que `eq`, ou « Yes » ET « No » ensemble
 * sont dénoncés et la règle refusée (`widened`) — jamais un repli silencieux sur les abonnés, qui
 * écrirait à d'autres gens que ceux que la règle nomme.
 */
function choisirPopulation(node: RuleNode, acc: Acc): { racine: RuleNode; population: Population } {
  const estSelecteur = (n: RuleNode): n is Predicate => n.type === "predicate" && n.field === SELECTEUR_POPULATION;

  let directs: Predicate[] = [];
  let racine: RuleNode = node;
  if (estSelecteur(node)) {
    directs = [node];
    racine = { id: node.id, type: "group", op: "AND", children: [] };
  } else if (node.type === "group" && node.op === "AND") {
    directs = node.children.filter(estSelecteur);
    if (directs.length > 0) racine = { ...node, children: node.children.filter((c) => !estSelecteur(c)) };
  }

  const valeurs = new Set<string>();
  for (const p of directs) {
    const v = String(p.value);
    if (p.op !== "eq" || (v !== "yes" && v !== "no")) {
      denonce(acc, `${SELECTEUR_POPULATION}:${p.op}:${v}`);
      acc.widened = true;
      continue;
    }
    valeurs.add(v);
  }
  if (valeurs.size > 1) {
    denonce(acc, `${SELECTEUR_POPULATION}:conflict`);
    acc.widened = true;
  }
  return { racine, population: valeurs.size === 1 && valeurs.has("no") ? "contacts" : "subscribers" };
}

/** Ce qui a été écarté, nommé par son identité et pas seulement par son type de champ. */
function labelOf(p: Predicate): string {
  if (p.field === "tag" || p.field === "optin") return `${p.field}:${String(p.value)}`;
  return p.field;
}

interface Acc {
  unsupported: string[];
  widened: boolean;
}

function compileNode(node: RuleNode, ctx: RuleContext, acc: Acc): string | null {
  if (node.type === "predicate") {
    // ⚠️ `labelOf` ne connaît que le champ et une valeur SCALAIRE. Sur une liste, il rendrait
    // « capture_campaign:3f2a…,9c1b…,7d40… » — trois uuid collés à la virgule dans un bandeau
    // d'avertissement, qui ne dit pas LEQUEL a disparu. La branche qui découvre le coupable le
    // nomme donc elle-même ; on ne complète ici que si personne n'a rien dit.
    const avant = acc.unsupported.length;
    const expr = predicateExpr(node, ctx, acc);
    if (!expr && acc.unsupported.length === avant) acc.unsupported.push(labelOf(node));
    return expr;
  }

  const group = node as Group;
  const parts = group.children
    .map((c) => compileNode(c, ctx, acc))
    .filter((x): x is string => Boolean(x));

  // ⛔ LE TEST QUI COMPTE. Un enfant perdu sous un ET ouvre le filtre. Peu importe que l'enfant
  // soit un prédicat inconnu ou un sous-groupe dont toutes les branches sont tombées : ce qui reste
  // vise PLUS de monde que ce qui est écrit à l'écran.
  if (group.op === "AND" && parts.length < group.children.length) acc.widened = true;

  if (parts.length === 0) return null;
  // `parts[0] ?? null` et non `parts[0]` : sous `noUncheckedIndexedAccess`, un accès indexé rend
  // `string | undefined`. Le test de longueur au-dessus le garantit défini, mais le compilateur ne
  // le sait pas — et une garde qui repose sur ce que le compilateur ne vérifie pas s'érode.
  if (parts.length === 1) return parts[0] ?? null;
  return `${group.op === "AND" ? "and" : "or"}(${parts.join(",")})`;
}

/**
 * Compile une règle de ciblage en expression de filtre PostgREST.
 *
 * ⛔ `expr === null` NE VEUT PAS DIRE « pas de filtre, prends tout le monde ». Il veut dire que la
 * règle n'a rien produit — et l'appelant doit décider, en regardant `widened`, s'il s'agit d'une
 * règle vide (personne n'a demandé de ciblage) ou d'un ciblage qui s'est effondré.
 */
export function compileRule(node: RuleNode, ctx: RuleContext): CompiledRule {
  const acc: Acc = { unsupported: [], widened: false };
  const { racine, population } = choisirPopulation(node, acc);
  const expr = compileNode(racine, ctx, acc);

  /*
   * ⛔ LE TROU QUE « SOUS UN OU, UN TERME PERDU RÉTRÉCIT » LAISSE OUVERT — ET C'EST LE PLUS LARGE
   * DE TOUS.
   *
   * « Rétrécit » n'est vrai que tant qu'il RESTE une branche au OU. Quand elles tombent TOUTES, le
   * groupe rend `null`, et `compileNode` ne lève `widened` que sur un ET : rien ne se plaint. Or
   * `null` n'est pas un filtre étroit — les trois appelants écrivent tous `if (expr) q.or(expr)`,
   * donc un `null` ne pose AUCUN filtre. « Campagne Copa OU créative A », dont aucun identifiant ne
   * se résout, compte et ENVOIE à toute la marque, sous une pastille verte « Exact count ».
   * C'est le cas ordinaire aujourd'hui : aucun appelant ne fournit encore les trois listes
   * blanches, donc TOUT prédicat de capture rend `null`.
   *
   * La distinction qui fait la garde : un groupe SANS ENFANT est un ciblage volontairement absent
   * (l'écran l'écrit : « the group targets the entire list »). Un groupe qui avait des enfants et
   * n'a rien produit est un ciblage EFFONDRÉ. Les deux rendent `null` ; un seul est un
   * élargissement.
   */
  // ⚠️ Sur la racine SANS le sélecteur : « Newsletter: No » seul vise tous les contacts de la marque,
  // exactement comme un groupe vide vise tous ses abonnés.
  const ciblageVolontairementAbsent = racine.type === "group" && racine.children.length === 0;
  if (expr === null && !ciblageVolontairementAbsent) acc.widened = true;

  return { expr, unsupported: [...new Set(acc.unsupported)], widened: acc.widened, population };
}
