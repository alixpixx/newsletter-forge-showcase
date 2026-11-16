/**
 * EN-TÊTE ET PIED DE MARQUE, CÔTÉ WORKER — la moitié que le chemin d'envoi doit savoir refaire.
 *
 * ⛔ POURQUOI CE FICHIER EXISTE, ET C'EST MESURÉ. Le HTML est figé à la publication : `compileDoc()`
 * remplit `template_version.html_shell`, et l'en-tête résolu à ce moment-là voyage dedans sans que
 * le worker ait rien à savoir. SAUF pour les éditions qui portent des blocs de flux : là, et là
 * seulement, `planner.ts` RECOMPILE le document avec les articles du jour
 * (`planner.ts` : `if (hasFeeds) { … compileDoc(expanded) }`). Cette recompilation-là ne passait
 * aucun partial — donc elle produisait un e-mail SANS l'en-tête de marque, silencieusement, pour
 * exactement les newsletters qui en ont le plus besoin : celles qui partent toutes les semaines.
 *
 * `applyBrandPartials` pousse bien un avertissement dans ce cas, mais `CompileResult.warnings` n'est
 * lu par personne sur ce chemin : l'édition serait partie nue, et la seule façon de s'en apercevoir
 * aurait été de la recevoir.
 *
 * ⚠️ Fonctions PURES, sans base : « ce pointeur désigne-t-il des rows utilisables ? » est une
 * question de logique, et une question de logique se teste sans base. La lecture, elle, vit dans
 * `planner-db.ts`.
 *
 * ⚠️ POURQUOI UNE DEUXIÈME IMPLÉMENTATION, alors que l'admin a déjà `resolveBrandPartials`. Ce sont
 * deux paquets qui ne se voient pas (`apps/admin` n'est pas importable depuis `apps/worker`), et le
 * pont naturel — `@nf/render` — n'a ni base ni session, par construction. La duplication est donc
 * assumée et bornée : les deux moitiés doivent rendre le MÊME verdict, et c'est ce que leurs deux
 * bancs vérifient chacun de leur côté.
 */
import { Row } from "@nf/render/schema";

export type FenteBrandPartial = "header" | "footer";

/** Une ligne de `newsletter.brand_partial` telle que PostgREST la rend, avant toute confiance. */
export interface LignePartial {
  id?: unknown;
  slot?: unknown;
  rows?: unknown;
}

export interface PartialsResolus {
  header: Row[];
  footer: Row[];
  /**
   * Les fentes qu'on n'a PAS su honorer. Non vide ⇒ l'appelant doit refuser de construire l'e-mail.
   *
   * ⛔ C'est une liste, pas un booléen : « l'en-tête manque » et « le pied manque » ne se réparent
   * pas au même endroit, et la raison finit écrite dans le journal de l'occurrence retenue.
   */
  manquants: FenteBrandPartial[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Les pointeurs portés par un document, sans rien supposer de sa forme.
 *
 * ⚠️ Le document vient de la base (`template_version.doc`, un `jsonb` typé `unknown` jusqu'ici) :
 * un `doc.meta` absent ou d'un autre type ne doit pas faire lever le planificateur, il doit
 * simplement vouloir dire « aucun pointeur ».
 */
export function pointeursDuDoc(doc: unknown): Partial<Record<FenteBrandPartial, string>> {
  const meta = (doc as { meta?: unknown } | null)?.meta;
  if (!meta || typeof meta !== "object") return {};

  const m = meta as Record<string, unknown>;
  const out: Partial<Record<FenteBrandPartial, string>> = {};
  if (typeof m.headerPartialId === "string") out.header = m.headerPartialId;
  if (typeof m.footerPartialId === "string") out.footer = m.footerPartialId;
  return out;
}

/**
 * Les pointeurs qui valent la peine d'une lecture — c'est-à-dire ceux qui ressemblent à un id.
 *
 * ⛔ CE GARDE VIT ICI ET NULLE PART AILLEURS, et c'est une passe de MUTATION qui l'a montré. Le
 * même contrôle posé dans `resoudrePartials` SURVIVAIT à sa suppression : un pointeur qui n'est pas
 * un uuid n'est de toute façon retrouvé par aucune ligne, donc la fente finissait manquante des deux
 * côtés et aucun banc ne pouvait distinguer les deux versions. Ici, il a un effet observable : on
 * n'envoie pas à PostgREST un filtre `in.(…)` qu'il refusera en 400.
 *
 * ⛔ CE QU'IL NE DOIT SURTOUT PAS FAIRE : décider si la garde s'applique. Un document dont l'unique
 * pointeur est illisible produit ici une liste VIDE — si l'appelant en concluait « rien à résoudre »,
 * il compilerait l'e-mail SANS en-tête, ce que ce module entier existe pour empêcher. C'est le
 * document qui décide qu'il y a une fente à honorer, jamais le résultat de ce filtre.
 */
export function idsALire(pointeurs: Partial<Record<FenteBrandPartial, string>>): string[] {
  return [pointeurs.header, pointeurs.footer].filter((v): v is string => v !== undefined && UUID.test(v));
}

/**
 * Apparie les pointeurs du document aux lignes lues en base.
 *
 * ⛔ LA FENTE DOIT CORRESPONDRE. Un pointeur d'en-tête qui désigne un pied de page poserait le pied
 * éditorial EN HAUT de l'e-mail — personne n'a demandé ça, et le rendu serait « réussi ».
 *
 * ⛔ UNE ROW QUI NE PARSE PLUS N'EST PAS UNE ROW VIDE. Les rows sont validées à l'écriture par la
 * route ; un échec ici ne peut venir que d'une évolution ultérieure du schéma. Rendre un tableau
 * vide compilerait l'e-mail SANS en-tête — c'est-à-dire exactement le défaut que ce module existe
 * pour empêcher. On marque la fente manquante et l'appelant refuse.
 *
 * ⛔ AUCUN FILTRE SUR L'ARCHIVAGE, ici comme dans la lecture. Archiver un partial le retire de la
 * bibliothèque ; cela ne doit rien changer aux modèles qui pointent déjà dessus, sans quoi archiver
 * ferait disparaître l'en-tête de plusieurs newsletters à leur prochaine édition, sans un mot.
 */
export function resoudrePartials(
  pointeurs: Partial<Record<FenteBrandPartial, string>>,
  lignes: readonly LignePartial[],
): PartialsResolus {
  const resolu: PartialsResolus = { header: [], footer: [], manquants: [] };

  for (const fente of ["header", "footer"] as const) {
    const id = pointeurs[fente];
    if (id === undefined) continue;

    // ⚠️ Pas de contrôle d'uuid ici : il vit dans `idsALire`, en amont, où il a un effet. Le
    // dupliquer ici serait un garde mort — un pointeur mal formé n'est retrouvé par aucune ligne,
    // donc l'appariement ci-dessous le marque déjà manquant.
    const ligne = lignes.find((l) => String(l.id ?? "") === id);
    if (!ligne || ligne.slot !== fente) {
      resolu.manquants.push(fente);
      continue;
    }

    const rows = rowsOf(ligne.rows);
    if (rows === null) {
      resolu.manquants.push(fente);
      continue;
    }
    resolu[fente] = rows;
  }

  return resolu;
}

/**
 * Le `jsonb` relu en `Row[]`, ou `null` dès qu'UNE SEULE row ne parse plus (voir ci-dessus).
 *
 * ⛔ UN TABLEAU VIDE EST UN REFUS, PAS UN SUCCÈS — et c'est LE trou que ce module entier existait
 * pour fermer, resté ouvert jusqu'au 15/09. Rendre `[]` ici fait passer la fente pour honorée : la
 * garde du planificateur ne voit aucun manquant, `applyBrandPartials` reçoit `header: []` et ne
 * pousse AUCUN avertissement (il ne parle que si la valeur vaut `undefined`), et l'édition part
 * SANS SON EN-TÊTE, en silence. La route de création refuse déjà `rows: []` — mais une écriture
 * SQL directe, elle, ne passe par aucune route, et la base ne porte aucune contrainte là-dessus.
 */
function rowsOf(raw: unknown): Row[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: Row[] = [];
  for (const item of raw) {
    const parsed = Row.safeParse(item);
    if (!parsed.success) return null;
    out.push(parsed.data);
  }
  return out;
}

/**
 * La raison écrite sur l'occurrence retenue. Rédigée pour la personne qui la lira dans l'admin,
 * sans elle : dire « partial manquant » l'obligerait à retrouver seule ce qu'est un partial.
 */
export function raisonPartialsManquants(manquants: readonly FenteBrandPartial[]): string {
  const quoi = manquants
    .map((f) => (f === "header" ? "brand header" : "brand footer"))
    .join(" and ");
  return `this edition points at a ${quoi} that could not be read — it was held back rather than sent without it`;
}
