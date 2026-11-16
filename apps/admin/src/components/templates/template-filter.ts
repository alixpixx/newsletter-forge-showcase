import { TEMPLATE_CATEGORIES, categoryLabel } from "@/components/templates/categories";

/*
 * Recherche et filtre par catégorie de la bibliothèque de modèles (demande de Chloé, 26/09/2026 :
 * « comme on commence à en avoir pas mal »).
 *
 * Module NEUTRE et PUR — ni `"use client"`, ni React : la page serveur peut l'importer sans tomber
 * sous le garde de `client-imports.test.ts`, et chaque règle se teste sans rendu.
 *
 * ⛔ LE FILTRAGE EST CÔTÉ NAVIGATEUR, SUR LA LISTE DÉJÀ LUE. La page lit TOUT le périmètre (marque +
 * modèles octroyés, `listTemplatesRead`) ; ce module ne fait que masquer des lignes. Il ne peut donc
 * rien montrer que le serveur n'ait déjà autorisé : le périmètre reste l'affaire de la couche data.
 */

export interface FiltreModeles {
  /** Le texte tapé, tel quel : c'est ce que le champ réaffiche (un espace final n'est pas mangé). */
  recherche: string;
  /** Catégorie BRUTE (`newsletter`, `daily_pick`…), jamais son libellé. "" = toutes. */
  type: string;
}

export const FILTRE_VIDE: FiltreModeles = { recherche: "", type: "" };

/** Même borne que la recherche de l'Analytics : un nom de modèle ne dépasse pas 200 caractères. */
const MAX_RECHERCHE = 200;
const MAX_TYPE = 64;

/**
 * Casse ET accents : « boletin » trouve « Boletín », « PREVIA » trouve « prévia ». NFD sépare la
 * lettre de son diacritique, `\p{M}` retire tous les diacritiques (pas seulement le bloc latin).
 */
export function normaliser(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Les mots de la recherche. Chacun doit se trouver quelque part : « diario boletin » trouve « Boletín Diario ». */
function mots(recherche: string): string[] {
  return normaliser(recherche).split(/\s+/).filter(Boolean);
}

interface LigneFiltrable {
  name: string;
  /** Le sous-titre affiché sous le nom dans la liste. */
  slug: string;
  category: string;
}

export interface PastilleCategorie {
  categorie: string;
  label: string;
  /** Modèles de cette catégorie qui passent la RECHERCHE — ce que donnerait un clic sur la pastille. */
  n: number;
}

export interface ResultatFiltre<T> {
  /** Les lignes à afficher : recherche ET catégorie. */
  visibles: T[];
  /** Tout le périmètre reçu (le M de « N of M templates »). */
  total: number;
  /** Modèles qui passent la recherche, toutes catégories confondues : le chiffre de « All ». */
  nRecherche: number;
  /**
   * ⚠️ Les catégories PRÉSENTES dans le périmètre, jamais seulement dans le résultat : une pastille qui
   * disparaîtrait à chaque lettre tapée ferait sauter la rangée sous le curseur. Sa catégorie à 0 dit
   * « la recherche l'exclut », pas « elle n'existe pas ».
   */
  categories: PastilleCategorie[];
  /** Un filtre est posé (recherche non blanche ou catégorie choisie). */
  actif: boolean;
}

/** Ordre de la contrainte CHECK (`categories.ts`) ; une catégorie inconnue de l'UI vient après, par libellé. */
function rang(categorie: string): number {
  const i = (TEMPLATE_CATEGORIES as readonly string[]).indexOf(categorie);
  return i === -1 ? TEMPLATE_CATEGORIES.length : i;
}

export function filtrerModeles<T extends LigneFiltrable>(
  rows: readonly T[],
  filtre: FiltreModeles,
): ResultatFiltre<T> {
  const cherches = mots(filtre.recherche);
  const passeRecherche = rows.filter((t) => {
    if (cherches.length === 0) return true;
    const botte = `${normaliser(t.name)} ${normaliser(t.slug)}`;
    return cherches.every((m) => botte.includes(m));
  });

  const n = new Map<string, number>();
  for (const t of passeRecherche) n.set(t.category, (n.get(t.category) ?? 0) + 1);
  const presentes = new Set(rows.map((t) => t.category));
  /* Une catégorie demandée par l'URL mais absente (modèle archivé depuis, lien périmé) reste
     affichée, active et à 0 : un filtre invisible qui vide la liste serait un piège sans sortie. */
  if (filtre.type) presentes.add(filtre.type);
  const categories = [...presentes]
    .map((c) => ({ categorie: c, label: categoryLabel(c), n: n.get(c) ?? 0 }))
    .sort((a, b) => rang(a.categorie) - rang(b.categorie) || a.label.localeCompare(b.label, "en"));

  return {
    visibles: filtre.type ? passeRecherche.filter((t) => t.category === filtre.type) : passeRecherche,
    total: rows.length,
    nRecherche: passeRecherche.length,
    categories,
    actif: cherches.length > 0 || filtre.type !== "",
  };
}

/** Lit `?q=&type=`. Une valeur absente ou vide retombe sur « pas de filtre », jamais sur autre chose. */
export function lireFiltre(get: (cle: string) => string | null): FiltreModeles {
  return {
    recherche: (get("q") ?? "").slice(0, MAX_RECHERCHE),
    type: (get("type") ?? "").trim().slice(0, MAX_TYPE),
  };
}

/**
 * L'adresse qui porte le filtre. ⚠️ Les AUTRES paramètres de la requête (onglet, et tout ce qu'un
 * autre écran y aurait mis) sont gardés tels quels : poser une recherche ne doit rien effacer.
 * Un filtre vide RETIRE son paramètre — `/templates` reste `/templates`, pas `/templates?q=`.
 */
export function urlFiltre(pathname: string, search: string, filtre: FiltreModeles): string {
  const p = new URLSearchParams(search);
  const q = filtre.recherche.trim().slice(0, MAX_RECHERCHE);
  if (q) p.set("q", q);
  else p.delete("q");
  if (filtre.type) p.set("type", filtre.type);
  else p.delete("type");
  const s = p.toString();
  return s ? `${pathname}?${s}` : pathname;
}

/** Le « N of M templates » : n'existe que si un filtre est posé (sinon l'en-tête compte déjà tout). */
export function compteur(r: Pick<ResultatFiltre<unknown>, "visibles" | "total" | "actif">): string {
  if (!r.actif) return "";
  return `${r.visibles.length} of ${r.total} template${r.total === 1 ? "" : "s"}`;
}

/** L'état vide d'un filtre : il nomme CE QUI a été cherché, pour qu'on voie quoi relâcher. */
export function messageAucun(filtre: FiltreModeles): string {
  const q = filtre.recherche.trim();
  const dans = filtre.type ? categoryLabel(filtre.type) : "";
  if (q && dans) return `No ${dans} template matches “${q}”`;
  if (q) return `No template matches “${q}”`;
  return dans ? `No ${dans} template` : "No template";
}
