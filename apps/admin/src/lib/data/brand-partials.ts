import {
  IMPORTED_FOOTER_ROW_PREFIX,
  MAX_BRAND_PARTIAL_ROWS,
  Row,
  withFreshRowIds,
  rowCarriesFooterLegal,
} from "@nf/render/schema";
// `isUuid` vit déjà dans `templates.ts` : une seule définition du filtre uuid, pas deux regex qui
// divergeraient. Import en lecture seule, aucune dépendance inverse.
import { isUuid } from "@/lib/data/templates";
import { getDb } from "@/lib/supabase";

/**
 * En-tête et pied de marque — accès serveur à `newsletter.brand_partial` (migration 0064).
 *
 * Le besoin : un en-tête composé une fois pour Copper Kettle doit servir ses quatre modèles, et le
 * corriger une fois doit suffire. D'où un POINTEUR dans le document (`doc.meta.headerPartialId`)
 * plutôt qu'une copie : le lien survit à l'insertion, et c'est lui qui permet de répondre à « quels
 * modèles utilisent cet en-tête ? » — la question à laquelle `saved_row` ne sait pas répondre.
 *
 * ⚠️ INVARIANT DE MARQUE, identique à `templates.ts` : aucune fonction ici ne lit
 * sans `assetId`. Un partial d'une autre marque doit être indiscernable d'un partial inexistant.
 *
 * ⚠️ INVARIANT D'IDENTIFIANTS : toute row qui SORT de ce module porte des ids fraîchement
 * régénérés (`withFreshRowIds`). Les ids de rows sont humains et déjà dupliqués entre modèles en
 * production (`pf_head` est sur les quatre Copper Kettle) ; réinjecter une row telle qu'elle est
 * stockée échoue SILENCIEUSEMENT — le reducer du builder rend `null`.
 *
 * ⛔ CE MODULE NE FAIT PAS DE VERDICT SUR UNE LECTURE RATÉE. Toutes les lectures rendent
 * `{ known, value }` : « la base n'a pas répondu » et « cette marque n'a aucun en-tête » sont deux
 * faits opposés, et un écran qui les confond écrit « aucun en-tête » sur une panne.
 *
 * ⭐ TROIS FENTES DEPUIS LE 23/09 (migration 0080) : `header`, `footer` et `block`. Un BLOC est une
 * suite de 1 à 20 rows que l'auteur importe OÙ IL VEUT (Alix : « des blocks qu'on peut importer où on
 * veut, comme le header et le footer »). Comme l'en-tête et le pied depuis le 16/09, il est COPIÉ dans
 * le document : aucun pointeur ne le désigne, et `resolveBrandPartials` le refuse comme en-tête.
 */

type Db = NonNullable<ReturnType<typeof getDb>>;

export const BRAND_PARTIAL_SLOTS = ["header", "footer", "block"] as const;
export type BrandPartialSlot = (typeof BRAND_PARTIAL_SLOTS)[number];

export const isBrandPartialSlot = (v: unknown): v is BrandPartialSlot =>
  typeof v === "string" && (BRAND_PARTIAL_SLOTS as readonly string[]).includes(v);

/**
 * Les fentes qui ont une PLACE dans l'e-mail : l'en-tête en haut, le pied au-dessus du pied légal.
 * Ce sont les seules qu'un pointeur (`meta.headerPartialId` / `footerPartialId`) peut désigner, et
 * les seules que « Create from a template » sait lever.
 *
 * ⛔ UN BLOC N'A PAS DE PLACE, DONC PAS DE ROW À LEVER. Lever « la première row » ou « celle d'avant
 * le pied légal » pour en faire un bloc prendrait l'en-tête ou le pied du modèle en croyant prendre
 * un contenu : la route refuse `block` en 400 plutôt que de deviner.
 */
export const POSITIONED_SLOTS = ["header", "footer"] as const;
export type PositionedSlot = (typeof POSITIONED_SLOTS)[number];

export const isPositionedSlot = (v: unknown): v is PositionedSlot =>
  typeof v === "string" && (POSITIONED_SLOTS as readonly string[]).includes(v);

/** Aligné sur `template.name` et `saved_row.name`. */
export const MAX_BRAND_PARTIAL_NAME = 120;
/** Défini dans `@nf/render/schema`, que l'éditeur (client) peut importer ; réexporté pour les appelants serveur. */
export { MAX_BRAND_PARTIAL_ROWS };

export interface BrandPartial {
  id: string;
  slot: BrandPartialSlot;
  name: string;
  /** Rows du schéma EmailDoc, ids DÉJÀ régénérés (voir l'invariant d'identifiants). */
  rows: Row[];
  archivedAt: string | null;
  updatedBy: string | null;
  updatedAt: string;
  createdAt: string;
}

/**
 * Résultat d'une LECTURE. `known: false` = on ne sait pas (base absente, marque non résolue, requête
 * en erreur, forme illisible). Jamais « aucun ».
 */
export interface BrandPartialRead<T> {
  known: boolean;
  value: T;
}

const SELECT = "id, slot, name, rows, archived_at, updated_by, updated_at, created_at";

/**
 * Ligne de base → objet de sortie, ou `null` si la ligne est illisible.
 *
 * ⛔ UNE ROW QUI NE PARSE PLUS N'EST PAS UNE ROW VIDE. Les rows sont validées à l'ÉCRITURE : un
 * échec ici ne peut venir que d'une évolution ultérieure du schéma. Rendre le partial avec un
 * tableau vide le ferait compiler SANS en-tête, et l'e-mail partirait nu sans que rien ne l'ait dit.
 * On rend donc `null`, que l'appelant traite comme « inconnu ».
 */
function toBrandPartial(raw: unknown): BrandPartial | null {
  const r = raw as Record<string, unknown>;
  if (!isBrandPartialSlot(r.slot)) return null;

  const rows = rowsOf(r.rows);
  if (rows === null) return null;

  return {
    id: String(r.id ?? ""),
    slot: r.slot,
    name: String(r.name ?? ""),
    // Les rows d'un footer portent le préfixe qui dit à la palette où finit le corps de l'e-mail.
    // ⛔ CELLES D'UN BLOC, JAMAIS : un bloc inséré au milieu du corps et préfixé `ftr_` serait pris
    // pour le début du pied (`debutDuPied`), et les rows ajoutées ensuite passeraient AU-DESSUS de lui.
    rows: rows.map((row) => withFreshRowIds(row, r.slot === "footer" ? IMPORTED_FOOTER_ROW_PREFIX : "row")),
    archivedAt: (r.archived_at as string | null) ?? null,
    updatedBy: (r.updated_by as string | null) ?? null,
    updatedAt: String(r.updated_at ?? ""),
    createdAt: String(r.created_at ?? ""),
  };
}

/** Le jsonb `rows` relu en `Row[]`, ou `null` dès qu'une seule row ne parse plus. */
function rowsOf(raw: unknown): Row[] | null {
  if (!Array.isArray(raw)) return null;
  const out: Row[] = [];
  for (const item of raw) {
    const parsed = Row.safeParse(item);
    if (!parsed.success) return null;
    out.push(parsed.data);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Validation d'écriture — invariants 1 et 2, portés par le SERVEUR
 * ------------------------------------------------------------------ */

/**
 * ⛔ `kind` DISTINGUE LES DEUX 409, ET CE N'EST PAS DÉCORATIF. Un nom déjà pris et une édition
 * concurrente rendent le MÊME code HTTP, et tous deux font relire l'état du partial par la route :
 * l'écran ne peut donc les séparer ni sur le statut, ni sur le corps de la réponse. Sans ce
 * discriminant, il ne reste qu'à comparer le texte du message — un garde qui casse au premier
 * reformulage — ou à servir un seul message, et alors l'un des deux cas envoie l'auteur dans une
 * impasse : recharger la page ne libérera jamais un nom que quelqu'un d'autre occupe.
 */
export type BrandPartialRefusal = {
  status: number;
  error: string;
  issues?: string[];
  kind?: "name_taken" | "stale";
};

/**
 * Valide les rows d'un partial AVANT toute écriture.
 *
 * Deux invariants, et ils ne vivent pas dans l'UI :
 *  1. SCHÉMA — `z.array(Row)` à l'écriture (422 + issues). Stocker une forme non conforme ferait
 *     échouer, bien plus tard et sur un autre écran, la compilation du modèle qui pointe dessus.
 *  2. CONFORMITÉ — aucune row ne peut porter un bloc `footer_legal` (422). Le pied légal est généré,
 *     verrouillé et injecté par la plateforme, avec les liens de désabonnement SIGNÉS du
 *     destinataire ; un partial qui l'embarquerait créerait une DEUXIÈME source pour la mention de
 *     désabonnement — donc deux liens, dont un non signé.
 */
export function validateBrandPartialRows(
  raw: unknown,
): { ok: true; rows: Row[] } | { ok: false; refusal: BrandPartialRefusal } {
  if (!Array.isArray(raw)) {
    return { ok: false, refusal: { status: 422, error: "rows must be an array of document rows" } };
  }
  // Messages GÉNÉRIQUES : la même validation sert l'en-tête, le pied et le bloc, et nommer
  // « header or footer » dans le refus d'un bloc enverrait l'auteur chercher une fente qu'il n'a pas choisie.
  if (raw.length === 0) {
    return { ok: false, refusal: { status: 422, error: "a library item needs at least one row" } };
  }
  if (raw.length > MAX_BRAND_PARTIAL_ROWS) {
    return {
      ok: false,
      refusal: { status: 422, error: `a library item cannot hold more than ${MAX_BRAND_PARTIAL_ROWS} rows` },
    };
  }

  const rows: Row[] = [];
  const issues: string[] = [];
  raw.forEach((item, index) => {
    const parsed = Row.safeParse(item);
    if (parsed.success) rows.push(parsed.data);
    else {
      for (const i of parsed.error.issues) {
        issues.push(`rows.${index}.${i.path.map(String).join(".") || "(root)"}: ${i.message}`);
      }
    }
  });
  if (issues.length > 0) return { ok: false, refusal: { status: 422, error: "invalid rows", issues } };

  if (rows.some(rowCarriesFooterLegal)) {
    return {
      ok: false,
      refusal: {
        status: 422,
        error:
          "the legal footer cannot be part of a brand header, footer or block — the platform injects it " +
          "once per email, with the recipient's signed unsubscribe links. A library item carrying one " +
          "would create a second source for the unsubscribe notice.",
      },
    };
  }

  return { ok: true, rows };
}

/** Nom d'un partial : présent, borné. C'est la seule prise de l'utilisateur sur sa bibliothèque. */
export function validateBrandPartialName(
  raw: unknown,
): { ok: true; name: string } | { ok: false; refusal: BrandPartialRefusal } {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name) return { ok: false, refusal: { status: 400, error: "name is required" } };
  if (name.length > MAX_BRAND_PARTIAL_NAME) {
    return {
      ok: false,
      refusal: { status: 400, error: `name must be ${MAX_BRAND_PARTIAL_NAME} characters or less` },
    };
  }
  return { ok: true, name };
}

/* ------------------------------------------------------------------ *
 * Lectures
 * ------------------------------------------------------------------ */

/** La bibliothèque VIVANTE de la marque (archivés exclus), la plus récente d'abord. */
export async function listBrandPartials(
  db: Db,
  assetId: string,
): Promise<BrandPartialRead<BrandPartial[]>> {
  const { data, error } = await db
    .from("brand_partial")
    .select(SELECT)
    .eq("asset_id", assetId)
    .is("archived_at", null)
    .order("updated_at", { ascending: false });

  if (error) return { known: false, value: [] };

  const lignes = ((data as unknown[]) ?? []).map(toBrandPartial);
  // Une ligne illisible ne se jette pas en silence : la bibliothèque afficherait un partial de moins
  // qu'il n'y en a, et l'auteur chercherait longtemps celui qui manque.
  if (lignes.some((l) => l === null)) return { known: false, value: [] };
  return { known: true, value: lignes as BrandPartial[] };
}

/**
 * Un partial VIVANT de la marque courante, pour l'édition et l'application.
 *
 * `null` = inexistant, archivé, OU appartenant à une autre marque : les trois se répondent
 * pareil, aucun oracle d'existence inter-marques.
 */
export async function getBrandPartial(
  db: Db,
  id: string,
  assetId: string,
): Promise<BrandPartialRead<BrandPartial | null>> {
  if (!isUuid(id)) return { known: true, value: null };

  const { data, error } = await db
    .from("brand_partial")
    .select(SELECT)
    .eq("id", id)
    .eq("asset_id", assetId)
    .is("archived_at", null)
    .maybeSingle();

  if (error) return { known: false, value: null };
  if (!data) return { known: true, value: null };

  const partial = toBrandPartial(data);
  return partial === null ? { known: false, value: null } : { known: true, value: partial };
}

export interface ResolvedBrandPartials {
  header: Row[];
  footer: Row[];
  /** Les pointeurs qu'on n'a pas su honorer. Non vide ⇒ `known` est faux. */
  missing: PositionedSlot[];
}

const RIEN: ResolvedBrandPartials = { header: [], footer: [], missing: [] };

/**
 * Résout les pointeurs d'un document en rows, pour `compileDoc(doc, partials)`.
 *
 * ⛔ CETTE LECTURE NE FILTRE PAS `archived_at`, ET C'EST LE POINT ENTIER. Archiver un partial le
 * retire de la bibliothèque — on ne peut plus l'appliquer à un nouveau modèle. Cela ne doit RIEN
 * changer aux modèles qui pointent déjà dessus : filtrer ici ferait disparaître l'en-tête de
 * plusieurs newsletters à leur prochaine publication, sans qu'aucun écran ne l'ait annoncé.
 *
 * ⛔ UN POINTEUR NON RÉSOLU REND `known: false`. L'appelant doit REFUSER de publier, jamais publier
 * sans l'en-tête : un e-mail de marque expédié nu ne se rattrape pas après coup.
 */
export async function resolveBrandPartials(
  db: Db,
  assetId: string,
  meta: { headerPartialId?: string; footerPartialId?: string },
): Promise<BrandPartialRead<ResolvedBrandPartials>> {
  const demandes: { slot: PositionedSlot; id: string }[] = [];
  if (meta.headerPartialId !== undefined) demandes.push({ slot: "header", id: meta.headerPartialId });
  if (meta.footerPartialId !== undefined) demandes.push({ slot: "footer", id: meta.footerPartialId });
  if (demandes.length === 0) return { known: true, value: RIEN };

  const ids = demandes.map((d) => d.id).filter(isUuid);
  if (ids.length !== demandes.length) {
    // Un pointeur qui n'est même pas un uuid ne désigne aucune ligne : PostgREST répondrait 400.
    return { known: false, value: { ...RIEN, missing: demandes.map((d) => d.slot) } };
  }

  const { data, error } = await db
    .from("brand_partial")
    .select(SELECT)
    .eq("asset_id", assetId)
    .in("id", ids);

  if (error) return { known: false, value: { ...RIEN, missing: demandes.map((d) => d.slot) } };

  const parId = new Map<string, BrandPartial>();
  for (const raw of (data as unknown[]) ?? []) {
    const partial = toBrandPartial(raw);
    if (partial !== null) parId.set(partial.id, partial);
  }

  const resolu: ResolvedBrandPartials = { header: [], footer: [], missing: [] };
  for (const { slot, id } of demandes) {
    const partial = parId.get(id);
    // ⚠️ On exige que la FENTE corresponde : un pointeur d'en-tête vers un pied de page poserait le
    // pied éditorial en haut de l'e-mail, et personne n'aurait demandé ça. Même refus pour un BLOC :
    // il n'a pas de place fixe, et le poser en tête parce qu'un id le désigne serait deviner.
    //
    // ⛔ ET UN PARTIAL SANS AUCUNE ROW EST UN REFUS, PAS UNE RÉSOLUTION RÉUSSIE. Le laisser passer
    // rendrait `known: true` avec `header: []`, et `applyBrandPartials` ne dit rien d'un tableau
    // vide — il n'avertit que sur `undefined`. L'e-mail se compilerait sans son en-tête et la
    // publication répondrait 200. La route de création refuse déjà `rows: []` ; une écriture SQL
    // directe, non.
    if (!partial || partial.slot !== slot || partial.rows.length === 0) {
      resolu.missing.push(slot);
      continue;
    }
    resolu[slot] = partial.rows;
  }

  return { known: resolu.missing.length === 0, value: resolu };
}

/**
 * Combien de modèles VIVANTS de la marque pointent sur ce partial ? (« Used by 4 of 5 templates »)
 *
 * ⛔ Compte des MODÈLES, pas des versions : un modèle qui porte le pointeur sur son brouillon ET sur
 * trois versions publiées est UN modèle qui l'utilise. Compter les versions gonflerait la phrase que
 * l'écran affiche, et celle-là doit être vraie.
 *
 * ⛔ `known: false` ne vaut pas `0`. Un écran qui affiche « used by 0 templates » sur une lecture
 * ratée invite à supprimer un en-tête qui sert peut-être quatre newsletters.
 */
export async function countTemplatesUsingPartial(
  db: Db,
  assetId: string,
  partialId: string,
): Promise<BrandPartialRead<number>> {
  if (!isUuid(partialId)) return { known: true, value: 0 };

  const { data: templates, error: erreurTemplates } = await db
    .from("template")
    .select("id")
    .eq("asset_id", assetId)
    .is("archived_at", null);
  if (erreurTemplates) return { known: false, value: 0 };

  const ids = ((templates as unknown[]) ?? []).map((t) => String((t as { id?: unknown }).id ?? ""));
  if (ids.length === 0) return { known: true, value: 0 };

  const porteurs = new Set<string>();
  // Deux requêtes plutôt qu'un `.or()` sur des chemins JSON : la syntaxe `doc->meta->>clé` dans un
  // `or` PostgREST se négocie mal, et un échec de filtre n'y lève pas — il rend « aucune ligne »,
  // c'est-à-dire un compte de zéro indiscernable d'un vrai.
  for (const cle of ["headerPartialId", "footerPartialId"] as const) {
    const { data, error } = await db
      .from("template_version")
      .select("template_id")
      .in("template_id", ids)
      .eq(`doc->meta->>${cle}`, partialId);
    if (error) return { known: false, value: 0 };
    for (const row of (data as unknown[]) ?? []) {
      porteurs.add(String((row as { template_id?: unknown }).template_id ?? ""));
    }
  }

  return { known: true, value: porteurs.size };
}

/* ------------------------------------------------------------------ *
 * Extraction — lever l'en-tête qu'un modèle porte déjà
 * ------------------------------------------------------------------ */

/**
 * La row d'un document à promouvoir en partial, ou un refus expliqué.
 *
 * ⛔ POURQUOI CETTE FONCTION EXISTE. Les en-têtes ne manquent pas : ils sont là, copiés-collés dans
 * chaque modèle — les quatre Copper Kettle portent la MÊME première row, identique à l'octet près.
 * Sans ce geste, remplir la bibliothèque voudrait dire recomposer à la main ce qui existe déjà, et
 * personne ne le ferait. Une bibliothèque vide est une bibliothèque morte.
 *
 * ⛔ LE PIED ÉDITORIAL EST LA ROW D'AVANT LE PIED LÉGAL, JAMAIS LE PIED LÉGAL LUI-MÊME. Ce dernier
 * compile vers `{{legal_footer_html}}`, que le worker remplit avec les liens de désabonnement SIGNÉS
 * du destinataire. Le recopier dans un partial créerait une seconde source pour la mention de
 * désabonnement, donc deux liens dont un non signé — `validateBrandPartialRows` le refuse déjà, mais
 * le refuser ICI permet de le DIRE au lieu de laisser un 422 sans contexte.
 *
 * ⛔ `index` EST LA POSITION DANS `doc.rows`, PAS DANS LES ROWS LISIBLES. Les deux divergent dès
 * qu'une row du document ne parse plus : la sélection saute la row illisible — c'est voulu — mais
 * son rang dans le tableau filtré ne désigne alors plus la même ligne du document. Rendre le rang
 * filtré ferait retirer, plus tard, une row VOISINE de celle qu'on a promue.
 *
 * ⚠️ `slot` EST UNE FENTE À PLACE FIXE, PAS UNE FENTE QUELCONQUE. Un bloc n'a pas de row désignée
 * dans un modèle (voir `POSITIONED_SLOTS`) : le type le refuse ici, la route le refuse en 400.
 */
export function rowAPromouvoir(
  doc: unknown,
  slot: PositionedSlot,
): { ok: true; row: Row; index: number } | { ok: false; refusal: BrandPartialRefusal } {
  const rows = (doc as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, refusal: { status: 422, error: "this template has no rows to lift a header or footer from" } };
  }

  // Chaque row lisible garde SA position d'origine : c'est la seule façon de désigner ensuite la
  // ligne exacte du document, y compris quand une row plus haut ne parse plus.
  const parsees: { row: Row; index: number }[] = [];
  rows.forEach((brut, index) => {
    const p = Row.safeParse(brut);
    // Une row illisible n'interrompt pas : elle ne peut simplement pas être choisie. Refuser tout le
    // modèle parce que sa troisième row a vieilli empêcherait de lever un en-tête parfaitement sain.
    if (p.success) parsees.push({ row: p.data, index });
  });
  if (parsees.length === 0) {
    return { ok: false, refusal: { status: 422, error: "none of this template's rows could be read" } };
  }

  if (slot === "header") {
    const choisi = parsees[0]!;
    if (rowCarriesFooterLegal(choisi.row)) {
      return {
        ok: false,
        refusal: { status: 422, error: "the first row of this template is the legal footer — there is no header to lift" },
      };
    }
    return { ok: true, row: choisi.row, index: choisi.index };
  }

  const rangLegal = parsees.findIndex((e) => rowCarriesFooterLegal(e.row));
  // Sans pied légal dans le document, le pied éditorial est simplement la dernière row : c'est là
  // qu'il se serait trouvé.
  const rang = rangLegal === -1 ? parsees.length - 1 : rangLegal - 1;
  if (rang < 0) {
    return {
      ok: false,
      refusal: { status: 422, error: "this template starts with its legal footer — there is no editorial footer above it to lift" },
    };
  }
  const choisi = parsees[rang]!;
  return { ok: true, row: choisi.row, index: choisi.index };
}

/* ------------------------------------------------------------------ *
 * Écritures
 * ------------------------------------------------------------------ */

/**
 * Crée un partial. UN SEUL chemin d'écriture pour les deux routes (saisie directe et extraction
 * depuis un modèle) : deux insertions parallèles finiraient par diverger sur la normalisation des
 * rows ou sur le traitement du conflit de nom.
 */
export async function createBrandPartial(
  db: Db,
  p: { assetId: string; slot: BrandPartialSlot; name: string; rows: Row[]; author: string | null },
): Promise<{ ok: true; id: string } | { ok: false; refusal: BrandPartialRefusal }> {
  // On stocke les rows NORMALISÉES par le schéma (defaults appliqués), pas l'entrée brute : un
  // partial ne doit pas propager des formes à moitié remplies dans les documents qui pointent dessus.
  const { data, error } = await db
    .from("brand_partial")
    .insert({ asset_id: p.assetId, slot: p.slot, name: p.name, rows: p.rows, updated_by: p.author })
    .select("id")
    .single();

  // 23505 = violation de `uq_brand_partial_nom`, unicité FILTRÉE sur `archived_at` : contrairement à
  // `saved_row`, seul un partial VIVANT réserve le nom. Le message peut donc désigner un objet que
  // l'utilisateur voit à l'écran — et archiver celui-là libère vraiment le nom.
  if (error?.code === "23505") {
    return { ok: false, refusal: { status: 409, error: `a ${p.slot} named "${p.name}" already exists for this brand` } };
  }
  if (error || !data) {
    return { ok: false, refusal: { status: 500, error: error?.message ?? "could not save the brand partial" } };
  }
  return { ok: true, id: String((data as { id: string }).id) };
}

/**
 * Renomme un partial et/ou REMPLACE ses rows. Le second chemin d'écriture, pendant de
 * `createBrandPartial` : le SQL ne vit pas dans la route, pour la même raison qu'à la création —
 * deux écritures parallèles finiraient par diverger sur le conflit de nom ou sur l'archivé.
 *
 * ⛔ `rows` EST UN REMPLACEMENT, JAMAIS UNE FUSION. L'éditeur renvoie l'état final du partial ;
 * fusionner demanderait de décider quoi faire d'une row disparue, et aucune réponse à cette
 * question n'est évidente pour l'auteur.
 *
 * ⭐ `baseUpdatedAt` EST LE COMPARE-AND-SWAP, ET C'EST LUI QUI EMPÊCHE LA PERTE SILENCIEUSE. Un
 * partial sert plusieurs modèles : deux personnes peuvent l'ouvrir en même temps, et sans cette
 * comparaison le second enregistrement écrase le premier sans que rien ne l'ait dit. Le client
 * renvoie l'horodatage qu'il a lu ; s'il ne correspond plus, on REFUSE au lieu d'écraser.
 *
 * ⛔ IL FAUT UN `.select()` POUR SAVOIR SI ON A ÉCRIT. Un `update` PostgREST qui ne touche AUCUNE
 * ligne ne lève pas d'erreur : sans le `.select()`, cette fonction rendrait « enregistré » sur un
 * partial archivé entre-temps, ou sur une écriture refusée par le compare-and-swap. C'est
 * précisément le mensonge que la route portait avant.
 */
export async function updateBrandPartial(
  db: Db,
  p: {
    id: string;
    assetId: string;
    name?: string;
    rows?: Row[];
    author: string | null;
    /** Horodatage lu par le client. Absent ⇒ pas de compare-and-swap. */
    baseUpdatedAt?: string;
  },
): Promise<{ ok: true; updatedAt: string } | { ok: false; refusal: BrandPartialRefusal }> {
  if (!isUuid(p.id)) return { ok: false, refusal: { status: 404, error: "brand partial not found" } };

  const patch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    updated_by: p.author,
  };
  if (p.name !== undefined) patch.name = p.name;
  if (p.rows !== undefined) patch.rows = p.rows;

  let q = db
    .from("brand_partial")
    .update(patch)
    .eq("id", p.id)
    .eq("asset_id", p.assetId)
    // Un partial archivé entre la lecture et l'écriture ne doit pas être ressuscité par un PATCH.
    .is("archived_at", null);
  if (p.baseUpdatedAt !== undefined) q = q.eq("updated_at", p.baseUpdatedAt);

  const { data, error } = await q.select("updated_at").maybeSingle();

  // 23505 = `uq_brand_partial_nom`, unicité FILTRÉE sur `archived_at` : seul un partial VIVANT
  // réserve le nom, donc le message peut désigner un objet que l'utilisateur voit à l'écran.
  if (error?.code === "23505") {
    return {
      ok: false,
      refusal: {
        status: 409,
        kind: "name_taken",
        // Générique : la fente est connue de l'écran, pas de ce refus (un bloc, un en-tête ou un pied).
        error: "another library item of this brand already has that name",
      },
    };
  }
  if (error) return { ok: false, refusal: { status: 500, error: error.message } };

  if (!data) {
    // Aucune ligne touchée. Deux causes très différentes, et l'auteur doit savoir laquelle : on
    // relit pour ne pas annoncer un conflit d'édition sur un partial qui a simplement été archivé.
    const relu = await getBrandPartial(db, p.id, p.assetId);
    if (!relu.known) return { ok: false, refusal: { status: 503, error: "could not read this brand partial" } };
    if (!relu.value) return { ok: false, refusal: { status: 404, error: "brand partial not found" } };
    return {
      ok: false,
      refusal: {
        status: 409,
        kind: "stale",
        error: "this library item changed somewhere else since you opened it — reload before saving",
      },
    };
  }

  return { ok: true, updatedAt: String((data as { updated_at: unknown }).updated_at ?? "") };
}

/**
 * ARCHIVE le partial — invariant 4 : on ne le SUPPRIME jamais.
 *
 * ⛔ POURQUOI JAMAIS DE SUPPRESSION DURE. Des modèles portent un POINTEUR vers cette ligne, y compris
 * dans des versions déjà publiées et figées. La détruire laisserait ces pointeurs dans le vide :
 * `resolveBrandPartials` répondrait « je ne sais pas » à chaque publication, et le seul geste de
 * réparation serait de rouvrir chaque modèle à la main. L'archivage retire le partial de la
 * bibliothèque tout en le laissant résoluble — ce que fait déjà `resolveBrandPartials`.
 *
 * ⛔ LE `.select()` N'EST PAS DÉCORATIF. Sans lui, archiver un partial déjà archivé — ou d'une autre
 * marque — répondrait « archivé » sans avoir touché une seule ligne. L'écran afficherait un succès
 * pour un geste qui n'a rien fait.
 */
export async function archiveBrandPartial(
  db: Db,
  id: string,
  assetId: string,
  updatedBy: string | null,
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  if (!isUuid(id)) return { ok: false, status: 404, message: "brand partial not found" };

  const now = new Date().toISOString();
  const { data, error } = await db
    .from("brand_partial")
    .update({ archived_at: now, updated_at: now, updated_by: updatedBy })
    .eq("id", id)
    .eq("asset_id", assetId)
    // Un partial déjà archivé ne doit pas voir sa date d'archivage repoussée par un second clic :
    // ce serait réécrire une trace sans que rien n'ait changé.
    .is("archived_at", null)
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, status: 500, message: error.message };
  if (!data) return { ok: false, status: 404, message: "brand partial not found" };
  return { ok: true };
}
