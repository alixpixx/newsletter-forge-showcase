/**
 * Registre de champs + modèle d'arbre de règles pour le constructeur de segment.
 * Version UI (client) : l'estimation est un mock réactif tant que la base de
 * données n'est pas branchée. Le vrai compilateur règle→SQL vivra dans
 * `packages/segments` (tâche P2-21) — voir docs/DATA-MODEL.md.
 */

export type Operator =
  | "eq" | "neq" | "gte" | "lte"
  | "within_days" | "older_than_days"
  | "has" | "not_has"
  | "is_true" | "is_false"
  // « une ou des » : `any_of` = au moins une des valeurs cochées, `none_of` = aucune d'elles.
  // ⛔ Ce n'est PAS `has`/`not_has` : ceux-là portent sur UNE valeur, et se compilent en `cs`
  // (« contient toutes »). Les confondre répond à l'inverse de la question posée.
  | "any_of" | "none_of"
  // « au moins une fois » : la date existe, quelle qu'elle soit. Sur une colonne de date qui reste
  // NULL tant que l'événement n'a pas eu lieu (`resubscribed_at`), c'est la seule question qui ne
  // dépend d'aucune fenêtre — « in the last 36 500 days » n'en est qu'une approximation.
  | "ever";

export type ValueType =
  | "select" | "number" | "days" | "cta_window" | "bool" | "tag" | "optin"
  /** Plusieurs valeurs cochées : la valeur du prédicat est un `string[]`. */
  | "multi";

/**
 * « Aucun formulaire d'origine », comme VALEUR de premier plan et non comme absence.
 *
 * ⛔ POURQUOI UNE CONSTANTE ET PAS UN CHAMP VIDE. `subscription.optin_id` est NULL pour les 1 203
 * souscriptions antérieures au lot optin, et un NULL ne matche JAMAIS un `eq` ni un `in` : sans
 * cette valeur explicite, ces contacts disparaîtraient de tout compte de segment sans qu'une seule
 * ligne le dise. « Sans optin » est un état légitime qu'on doit pouvoir cibler, et son complément
 * doit pouvoir les ré-inclure.
 *
 * La forme `__none__` ne peut PAS entrer en collision avec un vrai slug : la contrainte
 * `optin_slug_format` (migration 0051) impose `^[a-z0-9][a-z0-9-]{0,63}$` — un slug ne commence
 * jamais par un souligné.
 */
export const NO_OPTIN = "__none__";

export interface Option {
  value: string;
  label: string;
}

export interface FieldDef {
  key: string;
  label: string;
  category: "Attribut" | "Engagement" | "Comportement" | "Capture" | "Automations";
  valueType: ValueType;
  ops: Operator[];
  options?: Option[];
}

/** Dérivée du registre, jamais recopiée — voir `CATEGORIES` sous `FIELDS`. */
export type FieldCategory = FieldDef["category"];

export const OP_LABEL: Record<Operator, string> = {
  eq: "is",
  neq: "is not",
  gte: "≥",
  lte: "≤",
  within_days: "in the last",
  older_than_days: "more than",
  has: "contains",
  not_has: "does not contain",
  is_true: "true",
  is_false: "false",
  any_of: "is any of",
  none_of: "is none of",
  ever: "ever",
};

export const CTA_OPTIONS: Option[] = [
  { value: "paris", label: "paris" },
  { value: "article", label: "article" },
  { value: "cotes", label: "cotes" },
  { value: "social", label: "social" },
];

export const FIELDS: FieldDef[] = [
  {
    key: "country", label: "Country", category: "Attribut", valueType: "select", ops: ["eq", "neq"],
    options: [
      { value: "BR", label: "Brazil" }, { value: "GB", label: "United Kingdom" }, { value: "CL", label: "Chile" },
      { value: "FR", label: "France" }, { value: "IT", label: "Italy" }, { value: "MX", label: "Mexico" }, { value: "US", label: "United States" },
    ],
  },
  {
    key: "language", label: "Language", category: "Attribut", valueType: "select", ops: ["eq", "neq"],
    options: [
      { value: "pt-BR", label: "PT-BR" }, { value: "en", label: "EN" }, { value: "es", label: "ES" },
      { value: "fr", label: "FR" }, { value: "it", label: "IT" }, { value: "sv", label: "SV" },
    ],
  },
  {
    key: "signup_source", label: "Signup source", category: "Attribut", valueType: "select", ops: ["eq", "neq"],
    options: [
      { value: "organic", label: "Organic" }, { value: "social", label: "Social media" },
      { value: "crm_sync", label: "CRM sync" }, { value: "import", label: "Import" }, { value: "content_upgrade", label: "Content upgrade" },
    ],
  },
  {
    /*
     * QUI EST VISÉ : les abonnés newsletter (double opt-in confirmé) ou les CONTACTS hors newsletter
     * (statut `contact`, 0088 — leads OptinForge d'une créative « pas newsletter », entrés sans
     * confirmation, décision d'Alix du 25/09/2026).
     *
     * ⛔ CE CHAMP NE FILTRE PAS : IL CHOISIT LA POPULATION, donc la vue lue par le compte, l'estimation
     * et le fan-out. Il n'a de sens qu'AU PREMIER NIVEAU d'un ET : on ne sait pas unir deux vues, et
     * « abonnés OU contacts » n'est pas une question que ce ciblage pose. Ailleurs il est dénoncé et
     * la règle refusée (`compile.ts`, `choisirPopulation`). Sans lui : les abonnés, comme toujours —
     * c'est ce qui garantit qu'un contact n'est atteint QUE par une règle qui le nomme.
     */
    key: "newsletter", label: "Newsletter", category: "Attribut", valueType: "select", ops: ["eq"],
    options: [
      { value: "yes", label: "Subscribed (confirmed)" },
      { value: "no", label: "Not subscribed (contacts)" },
    ],
  },
  {
    key: "engagement_level", label: "Engagement level", category: "Engagement", valueType: "select", ops: ["eq", "neq"],
    options: [
      { value: "active", label: "Active" }, { value: "dormant", label: "Dormant" }, { value: "churned", label: "Lapsed" },
    ],
  },
  { key: "open_count", label: "Open count", category: "Engagement", valueType: "number", ops: ["gte", "lte", "eq"] },
  { key: "last_open", label: "Last open", category: "Engagement", valueType: "days", ops: ["within_days", "older_than_days"] },
  { key: "clicked_cta", label: "Clicked a CTA", category: "Comportement", valueType: "cta_window", ops: ["within_days"] },
  { key: "never_opened", label: "Never opened", category: "Comportement", valueType: "bool", ops: ["is_true", "is_false"] },
  { key: "completed_welcome", label: "Completed welcome", category: "Comportement", valueType: "bool", ops: ["is_true", "is_false"] },
  {
    // ⚠️ Ces quatre valeurs sont des EXEMPLES, pas les tags de la marque : `newsletter.tag` est
    // scopé par `(asset_id, slug)` et ne peut pas être connu d'un paquet sans base. L'écran les
    // remplace par les vrais (route `/api/segments/options`) ; elles ne servent que de repli quand
    // ce chargement échoue, pour que le contrôle ne soit jamais un select vide.
    key: "tag", label: "Tag", category: "Comportement", valueType: "tag", ops: ["has", "not_has"],
    options: [
      { value: "interesse:paris", label: "interesse:paris" }, { value: "futebol", label: "futebol" },
      { value: "vip", label: "vip" }, { value: "libertadores", label: "libertadores" },
    ],
  },
  {
    // Le formulaire d'origine (`newsletter.optin`) : « les contacts venus du guide en barre latérale
    // de Quartz Tips ». `eq`/`neq` et non `has`/`not_has` — un contact vient d'UN formulaire, ce
    // n'est pas une collection.
    // La seule option connue hors base est « aucun » ; les vrais optins arrivent par
    // `/api/segments/options`. Aucun exemple inventé ici : un slug d'optin qui n'existe pas se
    // compilerait en `null` et le prédicat serait silencieusement ignoré.
    // ⛔ « FIRST » N'EST PAS UN ORNEMENT DE LIBELLÉ. Ce champ lit `subscription.optin_id`, qui est
    // le miroir de la PREMIÈRE créative (D8) ; `Capture creative`, juste en dessous, lit
    // `capture_optin_ids`, qui les porte TOUTES. Les deux répondent à « par quelle créative cette
    // personne est-elle entrée ? » et rendent des ensembles différents — quelqu'un revenu par une
    // seconde créative est dans le second, pas dans le premier. Sans ces deux mots, on choisit
    // l'un pour l'autre et on cible à côté sans qu'aucune erreur ne le dise.
    key: "optin", label: "Opt-in form (first)", category: "Attribut", valueType: "optin", ops: ["eq", "neq"],
    options: [{ value: NO_OPTIN, label: "No opt-in form" }],
  },
  /*
   * LA PROVENANCE, À SES TROIS NIVEAUX : d'où vient le contact (campagne d'acquisition
   * optinforge), par quelle créative il est entré, et ce qu'il a coché.
   *
   * ⚠️ AUCUNE `options` CODÉE EN DUR ICI, pour la même raison qu'au-dessus (`tag`, `optin`) : ces
   * valeurs sont des identifiants scopés MARQUE. Un exemple inventé se compilerait en `null` et le
   * prédicat serait silencieusement écarté ; l'écran les charge par `/api/segments/options`.
   *
   * ⛔ `any_of` / `none_of` UNIQUEMENT. `has`/`not_has` se compilent en `cs` (« contient TOUTES ») :
   * sur une multi-sélection, ils répondent à l'inverse de « une ou des » — et ils échouent en
   * RÉTRÉCISSANT, donc sans e-mail parti et sans rien à l'écran pour le dire.
   */
  {
    key: "capture_campaign", label: "Capture campaign", category: "Capture",
    valueType: "multi", ops: ["any_of", "none_of"],
  },
  {
    // « any » : toutes les créatives touchées, pas seulement celle d'entrée — voir `optin` ci-dessus.
    key: "capture_creative", label: "Capture creative (any)", category: "Capture",
    valueType: "multi", ops: ["any_of", "none_of"],
  },
  {
    key: "interest", label: "Interest", category: "Capture",
    valueType: "multi", ops: ["any_of", "none_of"],
  },
  {
    /*
     * CE QUE LA PERSONNE A ACCEPTÉ DE RECEVOIR, finalité par finalité — les cases du formulaire de
     * capture, telles qu'elle les a cochées.
     *
     * ⛔ LES OPTIONS SONT EN DUR ICI, CONTRAIREMENT À TOUT CE QUI PRÉCÈDE, et c'est la bonne
     * décision : ces quatre clés ne sont pas des identifiants scopés marque, ce sont LES QUATRE
     * VALEURS DU CONTRAT DU PONT (`optinforge/src/lib/bridge/newsletter-forge.ts`, `PURPOSE_MAP`),
     * et le récepteur REJETTE en 422 toute clé qu'il ne connaît pas. Une cinquième finalité n'est
     * donc pas une donnée de marque qui arriverait toute seule : c'est un changement de contrat des
     * deux côtés à la fois, qui doit passer par ici.
     *
     * ⛔ DEUX VOCABULAIRES POUR LA MÊME CHOSE, et le libellé tranche pour l'opérateur. La capture
     * dit `newsletter`, l'envoi dit `content` : `PURPOSE_MAP` traduit l'un dans l'autre. La valeur
     * stockée — donc celle qu'on compile — est TOUJOURS celle de l'envoi ; le libellé, lui, nomme
     * ce que la personne a vu sur le formulaire.
     *
     * `eq`/`neq` et non `has`/`not_has` : on interroge une finalité à la fois, et « is not » doit
     * couvrir aussi bien la case décochée que la clé absente — voir `compile.ts`.
     */
    key: "purpose", label: "Subscription option", category: "Attribut",
    valueType: "select", ops: ["eq", "neq"],
    options: [
      { value: "content", label: "Newsletter & content" },
      { value: "offers", label: "Offers & promotions" },
      { value: "events", label: "Events & invitations" },
      { value: "partners", label: "Selected partner offers" },
    ],
  },
  /*
   * LA FAMILLE « AUTOMATIONS » (24/09/2026) : ce que le système a déjà ENVOYÉ à la personne, et ses
   * retours. Demande d'Alix : toutes les automations dans Segments, y compris celles qu'on créera.
   *
   * ⛔ CES TROIS COLONNES NE SONT ÉCRITES QUE PAR LES DÉCLENCHEURS DE LA MIGRATION 0087, au passage
   * d'un e-mail à `sent` — jamais à la mise en file, jamais depuis `automation_send` (le sunset y écrit
   * des lignes sans aucun e-mail). Ce registre et le compilateur ne font que les LIRE.
   */
  {
    /*
     * ⛔ OPTIONS EN DUR, comme `purpose` et pour la même raison : ce ne sont pas des identifiants de
     * marque mais les `kind` des e-mails de la carte System, un contrat du code. `reengagement` n'y
     * est PAS : il ne part plus jamais (la relance est une automation, 24/09/2026), et le proposer
     * ferait cocher une option qui rend toujours zéro.
     */
    key: "lifecycle_email", label: "Got a system email", category: "Automations",
    valueType: "multi", ops: ["any_of", "none_of"],
    options: [
      { value: "confirmation", label: "Confirmation" },
      { value: "welcome", label: "Welcome" },
      { value: "unsubscribe_ack", label: "Unsubscribe receipt" },
    ],
  },
  {
    // ⚠️ AUCUNE option en dur : des uuid scopés marque, chargés par `/api/segments/options` — TOUTES
    // les automations, quel que soit leur statut, donc une automation neuve y entre d'office.
    key: "automation_email", label: "Got an email from automation", category: "Automations",
    valueType: "multi", ops: ["any_of", "none_of"],
  },
  { key: "resubscribed", label: "Re-subscribed", category: "Automations", valueType: "days", ops: ["ever", "within_days"] },
  { key: "confirmed", label: "Confirmed", category: "Automations", valueType: "days", ops: ["within_days"] },
];

/**
 * Les finalités que le compilateur accepte de traduire, dérivées du registre ci-dessus.
 *
 * ⛔ DÉRIVÉE, JAMAIS RECOPIÉE — même raison que `CATEGORIES` plus bas : une liste blanche écrite une
 * seconde fois finit par diverger de celle qui décide, et c'est alors le filtre qui se tait.
 */
export const PURPOSE_KEYS: readonly string[] =
  FIELDS.find((f) => f.key === "purpose")?.options?.map((o) => o.value) ?? [];

/** Les e-mails système ciblables, dérivés du registre — même règle que `PURPOSE_KEYS`. */
export const SYSTEM_EMAIL_KEYS: readonly string[] =
  FIELDS.find((f) => f.key === "lifecycle_email")?.options?.map((o) => o.value) ?? [];

const FIELD_MAP: Record<string, FieldDef> = Object.fromEntries(FIELDS.map((f) => [f.key, f]));
export const getField = (key: string): FieldDef | undefined => FIELD_MAP[key];

/**
 * Les catégories réellement présentes dans le registre, dans l'ordre de première apparition.
 *
 * ⛔ DÉRIVÉE, ET SURTOUT PAS RECOPIÉE. L'écran itérait sur un tableau littéral
 * `["Attribut", "Engagement", "Comportement"]` : un champ rangé dans une catégorie absente de ce
 * tableau était accepté par TypeScript et INVISIBLE à l'écran, sans une seule erreur — on croyait
 * la fonctionnalité livrée et le menu ne la proposait nulle part.
 */
export const CATEGORIES: readonly FieldCategory[] = [...new Set(FIELDS.map((f) => f.category))];

/* ---------------- Arbre de règles ---------------- */

/**
 * ⛔ LA FORME TABLEAU EST CE QUI PERMET « UNE OU DES ». Sans elle, un ciblage sur trois campagnes
 * s'écrit en trois prédicats sous un OU imbriqué — que le compilateur sait faire, mais que l'écran
 * ne sait pas rendre, et dont le résumé devient illisible.
 */
export type PredValue = string | number | string[] | { days: number; cta?: string };

export interface Predicate {
  id: string;
  type: "predicate";
  field: string;
  op: Operator;
  value: PredValue;
}

export interface Group {
  id: string;
  type: "group";
  op: "AND" | "OR";
  children: RuleNode[];
}

export type RuleNode = Predicate | Group;

export function defaultValue(f: FieldDef): PredValue {
  switch (f.valueType) {
    case "select":
    case "tag":
    case "optin":
      return f.options?.[0]?.value ?? "";
    case "number":
      return 1;
    case "days":
      return { days: 30 };
    case "cta_window":
      return { days: 14, cta: "paris" };
    case "multi":
      /*
       * ⛔ LA LISTE VIDE EST LA SENTINELLE NON COMPILABLE, ET C'EST VOULU. Un champ multi neuf ne
       * doit RIEN cibler tant que rien n'est coché : `cs.{}` matcherait les 1 203 abonnés (tout
       * tableau contient l'ensemble vide) et `ov.{}` personne — même clic, deux pannes opposées.
       * Le compilateur refuse donc une liste vide en tête de branche, le prédicat remonte dans
       * `unsupported`, `widened` se lève sous un ET, et l'écran dit « Targeting incomplete » au
       * lieu d'afficher un nombre.
       */
      return [];
    default:
      return "";
  }
}

export function makePredicate(id: string, fieldKey?: string): Predicate {
  // ⚠️ Le champ par défaut ET l'opérateur par défaut sont résolus par une recherche qui peut
  // échouer : `FIELDS` est une donnée, pas une garantie de type. Plutôt que deux `!` qui
  // planteraient à l'exécution le jour où le registre change, on refuse explicitement — un
  // registre vide ou un champ sans opérateur est un défaut de programmation, pas une saisie.
  const first = FIELDS[0];
  const f = getField(fieldKey ?? first?.key ?? "") ?? first;
  if (!f) throw new Error("segment field registry is empty");
  const op = f.ops[0];
  if (!op) throw new Error(`segment field \"${f.key}\" declares no operator`);
  return { id, type: "predicate", field: f.key, op, value: defaultValue(f) };
}

/**
 * L'arbre d'un segment neuf.
 *
 * ⛔ CHAQUE PRÉDICAT ICI DOIT COMPILER. L'arbre de départ portait une démonstration de tout ce que
 * l'écran sait faire : `clicked_cta` (qui exige `email_event`, non alimenté — donc renvoyé dans
 * `unsupported`) et `tag has interesse:paris` (un slug d'exemple qui n'existe dans aucune marque —
 * donc un prédicat ignoré). Un écran neuf s'ouvrait ainsi sur deux conditions inertes, avec un
 * compte qui ne correspondait pas aux conditions affichées : l'utilisateur croit filtrer, et le
 * chiffre parle d'une population plus large. Un exemple qui ne fonctionne pas n'enseigne rien.
 */
export const INITIAL_TREE: Group = {
  id: "root",
  type: "group",
  op: "AND",
  children: [
    { id: "n1", type: "predicate", field: "country", op: "eq", value: "BR" },
    { id: "n2", type: "predicate", field: "language", op: "eq", value: "pt-BR" },
  ],
};

/*
 * ⛔ PLUS D'ESTIMATION LOCALE (retirée le 24/09/2026). `estimate()` rendait 128 450 abonnés FICTIFS
 * multipliés par une sélectivité inventée ; le constructeur de segments l'affichait quand la base ne
 * répondait pas. Un chiffre qui ne vient d'aucune lecture ne doit plus pouvoir s'afficher : la case
 * dit « Size unavailable » et pourquoi (`apps/admin/src/components/segments/segment-size.ts`). Le
 * seul compte d'un segment est celui de la base (`/api/segments/count`).
 */

/* ---------------- Résumé en langage clair ---------------- */

/**
 * Le carnet de libellés : identifiant → nom lisible, rempli par la même lecture que les options.
 *
 * ⛔ POURQUOI UN CARNET ET PAS UN LIBELLÉ DÉNORMALISÉ DANS LA RÈGLE. Une règle qui porterait
 * « Copa 2026 » à côté de son uuid deviendrait FAUSSE au premier renommage, sans le dire. La règle
 * ne retient donc que des identifiants, et le nom est résolu au moment de l'affichage — quitte à
 * dire « introuvable » quand la campagne a été supprimée.
 */
export type LabelBook = Record<string, string>;

/** Un uuid entier dans une phrase est illisible ; on garde de quoi le reconnaître. */
const shortId = (v: string) => (v.length > 12 ? `${v.slice(0, 8)}…` : v);

function predText(p: Predicate, labels?: LabelBook): string {
  const f = getField(p.field);
  const label = f?.label ?? p.field;

  if (f?.valueType === "bool") {
    switch (p.op) {
      case "is_true": return label.toLowerCase();
      case "is_false": return `${label.toLowerCase()}: no`;
      default: return `${label} ${OP_LABEL[p.op]}`;
    }
  }

  // Multi-sélection : jamais `String(tableau)`, qui rendrait « 3f2a…,9c1b… » collés à la virgule.
  if (Array.isArray(p.value)) {
    if (p.value.length === 0) return `${label} ${OP_LABEL[p.op]} nothing selected yet`;
    const noms = p.value.map(
      (v) => labels?.[v] ?? f?.options?.find((o) => o.value === v)?.label ?? `${shortId(v)} (not found)`,
    );
    return `${label} ${OP_LABEL[p.op]} ${noms.join(", ")}`;
  }

  if (p.field === "clicked_cta" && typeof p.value === "object") {
    return `clicked a ${p.value.cta ?? ""} CTA (last ${p.value.days} days)`;
  }
  // « ever » ne porte aucune fenêtre : les jours restés dans la valeur ne doivent pas s'afficher.
  if (f?.valueType === "days" && p.op === "ever") return `${label.toLowerCase()} ever`;
  // ⚠️ TOUT champ `days`, et pas seulement `last_open` : un champ de ce type non prévu ici tombait
  // dans `String(p.value)` et le résumé disait « Confirmed in the last [object Object] ».
  if (f?.valueType === "days" && typeof p.value === "object") {
    // ⚠️ Un ternaire binaire ici rendrait « in the last » pour TOUT opérateur non prévu — le même
    // défaut que dans le compilateur, en version affichage.
    switch (p.op) {
      case "within_days": return `${label.toLowerCase()} in the last ${p.value.days} days`;
      case "older_than_days": return `${label.toLowerCase()} more than ${p.value.days} days`;
      default: return `${label} ${OP_LABEL[p.op]} ${p.value.days} days`;
    }
  }
  const brut = String(p.value);
  /*
   * ⛔ LE CARNET NE SE CONSULTE QUE SUR UN CHAMP QUI PORTE DES IDENTIFIANTS.
   *
   * Il est indexé par VALEUR D'OPTION, et une valeur d'intérêt est un petit entier de
   * `newsletter.tag.id`. La même clé « 7 » désigne donc l'intérêt n°7 et le nombre 7 d'un
   * « Open count ≥ 7 » : consulté sans discernement, le carnet rend « Open count ≥ Futebol ».
   * Même piège sur un code pays si un slug de tag vaut « BR ». C'est un résumé FAUX, sans une
   * seule erreur, au-dessus du bouton d'enregistrement — et c'est aussi la seule description du
   * segment au moment de choisir l'audience d'une campagne.
   */
  const porteDesIdentifiants =
    f?.valueType === "tag" || f?.valueType === "optin" || f?.valueType === "multi";
  const v = (porteDesIdentifiants ? labels?.[brut] : undefined)
    ?? f?.options?.find((o) => o.value === p.value)?.label
    ?? brut;
  return `${label} ${OP_LABEL[p.op]} ${v}`;
}

export function summarize(node: RuleNode, labels?: LabelBook): string {
  if (node.type === "predicate") return predText(node, labels);
  const parts = node.children.map((c) =>
    c.type === "group" ? `(${summarize(c, labels)})` : summarize(c, labels),
  );
  if (!parts.length) return "the whole list";
  return parts.join(node.op === "AND" ? " and " : " or ");
}

/* ---------------- Mutations immuables ---------------- */

export function updateNode(root: Group, id: string, fn: (n: RuleNode) => RuleNode): Group {
  const walk = (n: RuleNode): RuleNode => {
    if (n.id === id) return fn(n);
    if (n.type === "group") return { ...n, children: n.children.map(walk) };
    return n;
  };
  return walk(root) as Group;
}

export function removeNode(root: Group, id: string): Group {
  const walk = (g: Group): Group => ({
    ...g,
    children: g.children.filter((c) => c.id !== id).map((c) => (c.type === "group" ? walk(c) : c)),
  });
  return walk(root);
}

export function addChild(root: Group, groupId: string, node: RuleNode): Group {
  return updateNode(root, groupId, (g) =>
    g.type === "group" ? { ...g, children: [...g.children, node] } : g,
  ) as Group;
}
