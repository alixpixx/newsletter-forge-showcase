/**
 * @nf/edition/regles — ce qu'une RELECTURE d'édition a le droit de changer, et comment on l'applique.
 *
 * ⭐ LA DEMANDE (Alix, 22/09/2026) : « je veux tout pouvoir modifier dans le builder ce que les users
 * vont recevoir sans exception !! ». Pour une édition de série, trois choses étaient décidées à l'envoi
 * sans que personne puisse les lire ni les corriger : l'introduction et l'accroche écrites par le
 * modèle, les articles du jour (figés ~90 min avant), et le sujet / preheader PAR ÉDITION.
 *
 * ⛔ CE FICHIER EST PUR : aucun accès réseau, aucune base, aucun `node:*`, aucun compilateur. Il est
 * importé par l'écran (composant client) pour ses bornes, par la route qui écrit une relecture, et par
 * le planificateur qui l'applique. UNE seule définition de « relecture valide » : la route refuse ce
 * que le worker refuserait, et le worker revalide ce que la route a écrit (un client bogué ou une
 * écriture à la main ne passent pas pour autant).
 *
 * ⛔ UNE RELECTURE EST UN ÉCART, JAMAIS UNE COPIE. On ne stocke que ce qui DIFFÈRE de ce que le gel a
 * produit (`review_base`) : un champ remis à sa valeur d'origine disparaît de l'écart. C'est ce qui rend
 * « Reset to AI version » exact — on retire la clé, et c'est le texte généré qui repart.
 */
import { extractTokens, MERGE_VARS, AI_MERGE_VARS } from "@nf/render/hydrate";

/* ------------------------------------------------------------------ *
 * Formes stockées (colonnes `campaign_occurrence.review_*`, migration 0079)
 * ------------------------------------------------------------------ */

/**
 * CE QUE LE GEL A PRODUIT, AVANT toute relecture — de quoi reconstruire l'édition sans rien relire
 * ailleurs.
 *
 * ⛔ POURQUOI TOUT EST LÀ, Y COMPRIS LE DOCUMENT DÉPLIÉ ET L'EN-TÊTE DE MARQUE. Recompiler une édition
 * relue exige les articles DU JOUR. Les redemander à WordPress en rendrait d'autres (la résolution
 * exclut ce que la campagne a déjà envoyé… y compris ce que CETTE édition vient de retenir). Relire les
 * rows d'en-tête en base appliquerait un en-tête modifié depuis le gel. L'aperçu de l'admin et la
 * recompilation du worker partent donc du MÊME objet figé : ils ne peuvent pas produire deux e-mails.
 */
export interface EditionBase {
  version: 1;
  /** Le document EXPÉDIÉ tel que le gel l'a arrêté (flux dépliés avec les articles du jour). */
  doc: unknown;
  /** En-tête / pied de marque résolus au gel. `null` = le gel n'en a pas résolu (voir `pointeAuxPartials`). */
  partials: { header?: readonly unknown[]; footer?: readonly unknown[] } | null;
  /** Le document désigne-t-il un en-tête ou un pied de marque ? */
  pointeAuxPartials: boolean;
  /** Le shell compilé AVANT preheader et balisage UTM. */
  html_shell: string;
  text_shell: string | null;
  /** Taille de référence (compilation du gel, sinon celle de la version publiée). `null` = mesurer. */
  size_bytes: number | null;
  /** Sujet et preheader d'avant relecture (l'occurrence, sinon le modèle). */
  subject: string;
  preheader: string | null;
  /** Le nom de campagne ET le segment au gel : le balisage UTM et l'empreinte ne bougent pas après. */
  campaign_name: string;
  segment_id: string | null;
  /** `true` = le contenu porte `{{ai_intro}}` ou `{{ai_preheader}}` : le gel a appelé le modèle. */
  ai: boolean;
  /** Les textes ÉCRITS PAR LE MODÈLE — ceux que « Reset to AI version » rétablit. */
  ai_intro: string | null;
  ai_preheader: string | null;
}

/** Ce qu'une relecture change sur UN article, désigné par l'id de son bloc. */
export interface ArticleOverride {
  /** Retiré de l'édition. */
  hidden?: true;
  title?: string;
  excerpt?: string;
  /** `""` = retirer l'image. */
  imageSrc?: string;
  href?: string;
}

/** L'écart d'une relecture. Une clé absente = la valeur du gel. */
export interface EditionOverrides {
  subject?: string;
  preheader?: string;
  /** `""` est une valeur : « cette édition part SANS introduction ». Absent = le texte généré. */
  ai_intro?: string;
  ai_preheader?: string;
  articles?: Record<string, ArticleOverride>;
}

/** Un article tel que l'écran de relecture le montre. */
export interface EditionArticle {
  id: string;
  title: string;
  excerpt: string;
  imageSrc: string | null;
  href: string;
}

/* ------------------------------------------------------------------ *
 * Bornes
 * ------------------------------------------------------------------ */

export const MAX_SUBJECT = 250;
export const MAX_PREHEADER = 250;
/** Plus large que la borne du modèle (600) : un humain qui réécrit n'est pas un modèle qui déborde. */
export const MAX_AI_INTRO = 1000;
export const MAX_AI_PREHEADER = 200;
/** Les bornes du schéma (`ArticleBlock`) : un titre plus long ne compilerait pas. */
export const MAX_TITLE = 200;
export const MAX_EXCERPT = 1000;
export const MAX_URL = 2048;

/** Jeton de sujet résolu au gel, avec les articles de l'occurrence en cours. */
export const FIRST_ARTICLE_TOKEN = "{{first_article}}";

export const EDITION_VIDE =
  "hiding every article would send an empty edition — keep at least one article, or cancel this edition instead";

/* ------------------------------------------------------------------ *
 * Lecture tolérante de ce qui est stocké
 * ------------------------------------------------------------------ */

const estObjet = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * L'écart stocké, relu sans confiance : clés inconnues ignorées, types vérifiés. `null` = aucun écart.
 * ⚠️ Ne VALIDE pas (bornes, liens, articles existants) : c'est `validerOverrides`.
 */
export function lireOverrides(raw: unknown): EditionOverrides | null {
  if (!estObjet(raw)) return null;
  const o: EditionOverrides = {};
  for (const k of ["subject", "preheader", "ai_intro", "ai_preheader"] as const) {
    if (typeof raw[k] === "string") o[k] = raw[k] as string;
  }
  if (estObjet(raw.articles)) {
    const articles: Record<string, ArticleOverride> = {};
    for (const [id, v] of Object.entries(raw.articles)) {
      if (!estObjet(v)) continue;
      const a: ArticleOverride = {};
      if (v.hidden === true) a.hidden = true;
      for (const f of ["title", "excerpt", "imageSrc", "href"] as const) {
        if (typeof v[f] === "string") a[f] = v[f] as string;
      }
      if (Object.keys(a).length > 0) articles[id] = a;
    }
    if (Object.keys(articles).length > 0) o.articles = articles;
  }
  return Object.keys(o).length > 0 ? o : null;
}

/** La base stockée, relue sans confiance. `null` = absente ou d'une forme que ce code ne sait pas lire. */
export function lireBase(raw: unknown): EditionBase | null {
  if (!estObjet(raw) || raw.version !== 1) return null;
  if (typeof raw.html_shell !== "string" || typeof raw.subject !== "string") return null;
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const partials = estObjet(raw.partials)
    ? {
        ...(Array.isArray(raw.partials.header) ? { header: raw.partials.header as unknown[] } : {}),
        ...(Array.isArray(raw.partials.footer) ? { footer: raw.partials.footer as unknown[] } : {}),
      }
    : null;
  return {
    version: 1,
    doc: raw.doc ?? null,
    partials,
    pointeAuxPartials: raw.pointeAuxPartials === true,
    html_shell: raw.html_shell,
    text_shell: str(raw.text_shell),
    size_bytes: typeof raw.size_bytes === "number" && Number.isFinite(raw.size_bytes) ? raw.size_bytes : null,
    subject: raw.subject,
    preheader: str(raw.preheader),
    campaign_name: str(raw.campaign_name) ?? "",
    segment_id: str(raw.segment_id),
    ai: raw.ai === true,
    ai_intro: str(raw.ai_intro),
    ai_preheader: str(raw.ai_preheader),
  };
}

/**
 * ⛔ LA SEULE DÉFINITION DE « CETTE ÉDITION ATTEND SA RECOMPILATION ». Le fan-out la lit pour refuser
 * d'enfiler une édition relue que le worker n'a pas encore reconstruite ; l'écran la lit pour dire
 * « changes pending ». Une révision absente vaut 0 (base d'avant 0079).
 */
export function revisionEnAttente(rev: unknown, appliquee: unknown): boolean {
  const r = typeof rev === "number" && Number.isFinite(rev) ? rev : 0;
  const a = typeof appliquee === "number" && Number.isFinite(appliquee) ? appliquee : 0;
  return r > a;
}

/* ------------------------------------------------------------------ *
 * Le document
 * ------------------------------------------------------------------ */

type Bloc = Record<string, unknown>;

const estArticle = (b: unknown): b is Bloc => estObjet(b) && b.type === "article";

/** Les blocs de chaque colonne, dans l'ordre de lecture. Les blocs ne s'emboîtent pas (schéma). */
function colonnes(doc: unknown): unknown[][] {
  if (!estObjet(doc) || !Array.isArray(doc.rows)) return [];
  const out: unknown[][] = [];
  for (const row of doc.rows) {
    if (!estObjet(row) || !Array.isArray(row.columns)) continue;
    for (const col of row.columns) if (estObjet(col) && Array.isArray(col.blocks)) out.push(col.blocks);
  }
  return out;
}

/** Les articles de l'édition, tels que l'écran de relecture les liste. */
export function articlesDeLEdition(doc: unknown): EditionArticle[] {
  const out: EditionArticle[] = [];
  for (const blocs of colonnes(doc)) {
    for (const b of blocs) {
      if (!estArticle(b) || typeof b.id !== "string") continue;
      out.push({
        id: b.id,
        title: typeof b.title === "string" ? b.title : "",
        excerpt: typeof b.excerpt === "string" ? b.excerpt : "",
        imageSrc: typeof b.imageSrc === "string" && b.imageSrc !== "" ? b.imageSrc : null,
        href: typeof b.href === "string" ? b.href : "",
      });
    }
  }
  return out;
}

/**
 * Titre du PREMIER article du document, s'il y en a un.
 *
 * Sert au jeton `{{first_article}}` dans le sujet : une série hebdomadaire dont le sujet est figé
 * une fois pour toutes annonce la même chose chaque semaine, alors que le contenu, lui, a changé.
 * Le sujet est ce que l'abonné voit avant d'ouvrir — c'est la partie qui doit le moins ressembler
 * à la semaine dernière.
 *
 * ⛔ Le remplacement n'a lieu QUE si le jeton est écrit. On ne devine jamais : écraser un sujet
 * saisi à la main serait écraser une décision éditoriale.
 *
 * ⚠️ Déplacée ici depuis `planner.ts` (0079) : le gel ET la recompilation après relecture doivent
 * dire le même titre de tête. Un article caché n'est plus dans le document, donc plus en tête.
 */
export function firstArticleTitle(doc: unknown): string | null {
  let trouve: string | null = null;
  const visit = (node: unknown): void => {
    if (trouve !== null) return;
    if (Array.isArray(node)) {
      for (const n of node) visit(n);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const o = node as Record<string, unknown>;
    if (o.type === "article" && typeof o.title === "string" && o.title.trim() !== "") {
      trouve = o.title.trim();
      return;
    }
    for (const v of Object.values(o)) visit(v);
  };
  visit(doc);
  return trouve;
}

/**
 * Combien d'articles porte le document expédié — pour le jeton `{{article_count}}`.
 *
 * ⛔ On compte les blocs `article` du document DÉPLIÉ (`shippedDoc`), pas ceux du modèle : avec un
 * bloc flux, le modèle n'en contient qu'un seul, l'aperçu. Compter là ferait annoncer « 1 article »
 * dans un sujet pour une édition qui en porte huit.
 *
 * Un bloc article sans titre compte quand même : il est bel et bien dans l'édition. C'est
 * `firstArticleTitle` qui exige un titre, parce qu'elle doit en IMPRIMER un.
 *
 * ⚠️ Déplacée ici depuis `planner.ts` (0079), même raison que `firstArticleTitle`.
 */
export function countArticles(doc: unknown): number {
  let total = 0;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const n of node) visit(n);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const o = node as Record<string, unknown>;
    if (o.type === "article") total += 1;
    for (const v of Object.values(o)) visit(v);
  };
  visit(doc);
  return total;
}

const estSeparateur = (b: unknown): boolean => estObjet(b) && b.type === "divider";

/**
 * Les blocs d'une colonne après relecture : articles cachés retirés, champs relus posés.
 *
 * ⛔ UN ARTICLE CACHÉ EMPORTE SON FILET, ET SEULEMENT LUI. Entre deux cartes d'un flux, le dépliage
 * pose un séparateur (`cardRule`) ; retirer la carte seule laisserait deux filets collés — un défaut
 * que l'abonné voit. La règle est STRUCTURELLE, pas liée aux ids générés : on retire le séparateur
 * placé ENTRE la carte cachée et une autre carte (celui d'avant de préférence, sinon celui d'après).
 * Un séparateur qui borde autre chose qu'un article (un titre, un texte) n'est jamais touché : dans un
 * modèle écrit à la main, c'est une décision de mise en page, pas un filet de carte.
 */
function blocsRelus(blocs: unknown[], articles: Record<string, ArticleOverride>): unknown[] {
  const retires = new Set<number>();
  blocs.forEach((b, i) => {
    if (!estArticle(b) || typeof b.id !== "string" || articles[b.id]?.hidden !== true) return;
    retires.add(i);
    if (estSeparateur(blocs[i - 1]) && estArticle(blocs[i - 2]) && !retires.has(i - 1)) retires.add(i - 1);
    else if (estSeparateur(blocs[i + 1]) && estArticle(blocs[i + 2])) retires.add(i + 1);
  });
  const out: unknown[] = [];
  blocs.forEach((b, i) => {
    if (retires.has(i)) return;
    const ov = estArticle(b) && typeof b.id === "string" ? articles[b.id] : undefined;
    if (!ov) {
      out.push(b);
      return;
    }
    const relu: Bloc = { ...(b as Bloc) };
    if (ov.title !== undefined) relu.title = ov.title;
    if (ov.excerpt !== undefined) relu.excerpt = ov.excerpt;
    if (ov.href !== undefined) relu.href = ov.href;
    if (ov.imageSrc !== undefined) {
      if (ov.imageSrc === "") delete relu.imageSrc;
      else relu.imageSrc = ov.imageSrc;
    }
    out.push(relu);
  });
  return out;
}

/**
 * Le document d'une édition, relu. ⛔ Ne touche QUE les blocs `article` désignés (et le filet d'une
 * carte cachée) : tout le reste ressort tel quel, à l'objet près.
 */
export function appliquerArticles(doc: unknown, articles: Record<string, ArticleOverride> | undefined): unknown {
  if (!articles || Object.keys(articles).length === 0) return doc;
  if (!estObjet(doc) || !Array.isArray(doc.rows)) return doc;
  const rows = doc.rows.map((row) => {
    if (!estObjet(row) || !Array.isArray(row.columns)) return row;
    return {
      ...row,
      columns: row.columns.map((col) =>
        estObjet(col) && Array.isArray(col.blocks) ? { ...col, blocks: blocsRelus(col.blocks, articles) } : col,
      ),
    };
  });
  return { ...doc, rows };
}

/* ------------------------------------------------------------------ *
 * Validation — la même pour la route et pour le worker
 * ------------------------------------------------------------------ */

/**
 * `planned` : l'édition n'est pas encore gelée — seuls le sujet et le preheader existent déjà.
 * `frozen`  : contenu arrêté — tout se relit, articles et textes du modèle compris.
 */
export type EtatRelecture = "planned" | "frozen";

export interface ContexteRelecture {
  etat: EtatRelecture;
  /** Obligatoire pour `frozen` : c'est elle qu'on relit. */
  base: EditionBase | null;
  /** Le sujet et le preheader d'avant relecture (ceux de la base pour `frozen`, de l'occurrence sinon). */
  sujetDeBase: string;
  preheaderDeBase: string | null;
}

export type Validation = { ok: true; overrides: EditionOverrides | null } | { ok: false; erreur: string };

/** Une adresse http(s) complète — rien d'autre ne part dans un lien ou une image d'article. */
export function estUrlWeb(v: string): boolean {
  if (v.length > MAX_URL || /\s/.test(v)) return false;
  try {
    const u = new URL(v);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname !== "";
  } catch {
    return false;
  }
}

/** Les jetons d'un texte que le registre ne connaît pas : l'hydratation les retirerait EN SILENCE. */
function jetonsInconnus(texte: string): string[] {
  return extractTokens(texte).filter((t) => !(t in MERGE_VARS));
}

function jetonsIa(texte: string): string[] {
  return extractTokens(texte).filter((t) => (AI_MERGE_VARS as readonly string[]).includes(t));
}

const liste = (jetons: string[]) => jetons.map((t) => `{{${t}}}`).join(", ");

/**
 * Valide ET normalise un écart. Rend l'écart MINIMAL : tout champ égal à la valeur du gel en est
 * retiré (c'est ce qui rend « reset » exact), `null` s'il ne reste rien.
 *
 * Les messages sont en anglais : ils s'affichent tels quels sous le champ fautif.
 */
export function validerOverrides(raw: unknown, ctx: ContexteRelecture): Validation {
  const lu = lireOverrides(raw);
  if (lu === null) return { ok: true, overrides: null };
  const base = ctx.base;
  if (ctx.etat === "frozen" && base === null) {
    return { ok: false, erreur: "this edition was frozen before edition review existed — it cannot be edited" };
  }
  const out: EditionOverrides = {};
  const ia = ctx.etat === "planned" || base?.ai === true;

  // --- Sujet et preheader : écrits par l'opérateur, jetons contrôlés comme au verrouillage ---------
  for (const [champ, max, deBase] of [
    ["subject", MAX_SUBJECT, ctx.sujetDeBase],
    ["preheader", MAX_PREHEADER, ctx.preheaderDeBase ?? ""],
  ] as const) {
    const v = lu[champ];
    // Vide = « revenir à la valeur de la campagne » : un sujet vide ne part jamais (`missing_subject`).
    if (v === undefined || v.trim() === "" || v === deBase) continue;
    if (v.length > max) return { ok: false, erreur: `the ${champ} is longer than ${max} characters` };
    const inconnus = jetonsInconnus(v);
    if (inconnus.length > 0) {
      return {
        ok: false,
        erreur: `the ${champ} uses ${liste(inconnus)}, which ${inconnus.length > 1 ? "are not shortcodes" : "is not a shortcode"} — it would be silently removed`,
      };
    }
    const iaSansTexte = ia ? [] : jetonsIa(v);
    if (iaSansTexte.length > 0) {
      return {
        ok: false,
        erreur: `the ${champ} uses ${liste(iaSansTexte)}, but this edition has no AI text (its template does not use it) — it would ship blank`,
      };
    }
    out[champ] = v;
  }

  // --- Textes du modèle ------------------------------------------------------------------------
  for (const [champ, max] of [
    ["ai_intro", MAX_AI_INTRO],
    ["ai_preheader", MAX_AI_PREHEADER],
  ] as const) {
    const v = lu[champ];
    if (v === undefined) continue;
    if (ctx.etat !== "frozen" || base === null) {
      return {
        ok: false,
        erreur: "the AI text is written when the edition is frozen (shortly before the send) — it can be edited from then on",
      };
    }
    if (!base.ai) {
      return {
        ok: false,
        erreur: `this edition does not use {{${champ}}} — nothing in the email would show this text`,
      };
    }
    if (v.length > max) return { ok: false, erreur: `the ${champ === "ai_intro" ? "AI intro" : "AI preheader"} is longer than ${max} characters` };
    if (v === (base[champ] ?? "")) continue; // identique au texte généré : c'est un reset
    out[champ] = v;
  }

  // --- Articles ----------------------------------------------------------------------------------
  if (lu.articles) {
    if (ctx.etat !== "frozen" || base === null) {
      return {
        ok: false,
        erreur: "the articles are picked when the edition is frozen (shortly before the send) — they can be reviewed from then on",
      };
    }
    const connus = new Map(articlesDeLEdition(base.doc).map((a) => [a.id, a]));
    const articles: Record<string, ArticleOverride> = {};
    for (const [id, ov] of Object.entries(lu.articles)) {
      const orig = connus.get(id);
      if (!orig) return { ok: false, erreur: `article ${id} is not in this edition` };
      const nom = `« ${(ov.title ?? orig.title).slice(0, 60)} »`;
      const a: ArticleOverride = {};
      if (ov.hidden === true) a.hidden = true;
      if (ov.title !== undefined && ov.title !== orig.title) {
        if (ov.title.trim() === "") return { ok: false, erreur: "an article title cannot be empty — hide the article instead" };
        if (ov.title.length > MAX_TITLE) return { ok: false, erreur: `the title of ${nom} is longer than ${MAX_TITLE} characters` };
        a.title = ov.title;
      }
      if (ov.excerpt !== undefined && ov.excerpt !== orig.excerpt) {
        if (ov.excerpt.length > MAX_EXCERPT) return { ok: false, erreur: `the excerpt of ${nom} is longer than ${MAX_EXCERPT} characters` };
        a.excerpt = ov.excerpt;
      }
      if (ov.href !== undefined && ov.href !== orig.href) {
        if (!estUrlWeb(ov.href)) return { ok: false, erreur: `the link of ${nom} must be a full http:// or https:// address` };
        a.href = ov.href;
      }
      if (ov.imageSrc !== undefined && ov.imageSrc !== (orig.imageSrc ?? "")) {
        if (ov.imageSrc !== "" && !estUrlWeb(ov.imageSrc)) {
          return { ok: false, erreur: `the image of ${nom} must be a full http:// or https:// address (leave it empty for no image)` };
        }
        a.imageSrc = ov.imageSrc;
      }
      if (Object.keys(a).length > 0) articles[id] = a;
    }
    if (Object.keys(articles).length > 0) {
      /*
       * ⛔ RECOMPILER SANS L'EN-TÊTE DE MARQUE, C'EST L'ENVOYER NU. Un document qui pointe sur un
       * en-tête dont le gel n'a pas capturé les rows (édition sans flux : son shell venait de la
       * publication) ne peut pas être reconstruit fidèlement — on refuse plutôt que de le perdre.
       */
      if (base.pointeAuxPartials && base.partials === null) {
        return {
          ok: false,
          erreur:
            "this edition's brand header or footer was not captured when it was frozen, so it cannot be rebuilt without losing it — edit the template instead, or cancel this edition",
        };
      }
      // ⛔ UNE ÉDITION VIDE NE PART PAS : refusé ici, donc à l'écran, avant d'arriver au worker.
      if (countArticles(base.doc) > 0 && countArticles(appliquerArticles(base.doc, articles)) === 0) {
        return { ok: false, erreur: EDITION_VIDE };
      }
      out.articles = articles;
    }
  }

  return { ok: true, overrides: Object.keys(out).length > 0 ? out : null };
}

/** Le contexte de validation d'une édition GELÉE : tout vient de sa base. */
export function contexteGele(base: EditionBase | null): ContexteRelecture {
  return {
    etat: "frozen",
    base,
    sujetDeBase: base?.subject ?? "",
    preheaderDeBase: base?.preheader ?? null,
  };
}

/** Les textes du modèle QUI PARTENT : l'écart s'il existe, sinon le texte généré. `null` = aucun jeton IA. */
export function textesIa(
  base: EditionBase,
  overrides: EditionOverrides | null,
): { ai_intro: string | null; ai_preheader: string | null } | null {
  if (!base.ai) return null;
  return {
    ai_intro: overrides?.ai_intro ?? base.ai_intro,
    ai_preheader: overrides?.ai_preheader ?? base.ai_preheader,
  };
}
