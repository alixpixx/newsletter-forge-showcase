/**
 * ⛔ CE QUE CE BANC EXISTE POUR EMPÊCHER : qu'une édition hebdomadaire parte SANS son en-tête de
 * marque, silencieusement, parce que le worker recompile le document avec les articles du jour et
 * ne sait pas résoudre un pointeur. Le cas ne se voit ni dans l'admin (l'aperçu, lui, a l'en-tête),
 * ni dans les journaux (le compilateur se contente d'un avertissement que personne ne lit sur ce
 * chemin) : il se voit dans la boîte de réception, une fois.
 *
 * Les tests qui comptent le plus ici sont ceux où le module REFUSE. Rendre « rien » au lieu de
 * « je ne sais pas » est précisément ce qui ferait partir l'e-mail nu.
 */
import { describe, expect, test } from "bun:test";
import {
  pointeursDuDoc,
  raisonPartialsManquants,
  resoudrePartials,
  type LignePartial,
} from "./brand-partials";

const ID_HEADER = "11111111-1111-4111-8111-111111111111";
const ID_FOOTER = "22222222-2222-4222-8222-222222222222";

/** Une row valide du schéma EmailDoc, réduite à ce qu'il faut pour être acceptée. */
const rowTexte = (id: string, texte: string): unknown => ({
  id,
  layout: "1",
  columns: [
    { id: `${id}_c`, blocks: [{ id: `${id}_b`, type: "text", paragraphs: [{ spans: [{ text: texte }] }] }] },
  ],
});

const ligneHeader = (over: Partial<LignePartial> = {}): LignePartial => ({
  id: ID_HEADER,
  slot: "header",
  rows: [rowTexte("pf_head", "Copper Kettle")],
  ...over,
});

describe("pointeursDuDoc — lire un document venu de la base", () => {
  test("un document sans meta ne porte aucun pointeur, et ne fait pas lever", () => {
    // `template_version.doc` est un jsonb typé `unknown` : le planificateur ne doit pas tomber
    // parce qu'un vieux document n'a pas la forme attendue.
    expect(pointeursDuDoc(null)).toEqual({});
    expect(pointeursDuDoc(undefined)).toEqual({});
    expect(pointeursDuDoc({})).toEqual({});
    expect(pointeursDuDoc({ meta: "pas un objet" })).toEqual({});
  });

  test("les deux pointeurs sont lus quand ils sont là", () => {
    expect(pointeursDuDoc({ meta: { headerPartialId: ID_HEADER, footerPartialId: ID_FOOTER } })).toEqual({
      header: ID_HEADER,
      footer: ID_FOOTER,
    });
  });

  test("un pointeur qui n'est pas une chaîne est ignoré, pas converti", () => {
    // `String(42)` produirait un identifiant plausible et faux : on ne fabrique pas un pointeur.
    expect(pointeursDuDoc({ meta: { headerPartialId: 42 } })).toEqual({});
  });
});

describe("resoudrePartials — apparier les pointeurs aux lignes lues", () => {
  test("aucun pointeur : rien à résoudre, rien à refuser", () => {
    expect(resoudrePartials({}, [])).toEqual({ header: [], footer: [], manquants: [] });
  });

  test("un pointeur honoré rend les rows du partial", () => {
    const r = resoudrePartials({ header: ID_HEADER }, [ligneHeader()]);
    expect(r.manquants).toEqual([]);
    expect(r.header).toHaveLength(1);
    expect(r.header[0]!.id).toBe("pf_head");
    expect(r.footer).toEqual([]);
  });

  test("⛔ un pointeur d'en-tête vers un partial de PIED est un refus, pas une pose en haut", () => {
    // Sans ce contrôle, le pied éditorial s'afficherait en tête de l'e-mail et le rendu serait
    // « réussi » : aucune erreur, aucun test rouge, une newsletter à l'envers.
    const r = resoudrePartials({ header: ID_HEADER }, [ligneHeader({ slot: "footer" })]);
    expect(r.manquants).toEqual(["header"]);
    expect(r.header).toEqual([]);
  });

  test("⛔ un pointeur d'en-tête vers un BLOC de bibliothèque (fente `block`, 0080) est un refus", () => {
    // Le worker ne connaît pas la fente `block` et n'a pas à la connaître : un bloc n'a pas de place
    // fixe, rien ne doit le poser en tête d'une édition parce qu'un id le désigne. Ce test prouve que
    // le contrôle de fente existant suffit — aucune ligne de code worker n'a changé avec 0080.
    const r = resoudrePartials({ header: ID_HEADER, footer: ID_FOOTER }, [
      ligneHeader({ slot: "block" }),
      { ...ligneHeader({ slot: "block" }), id: ID_FOOTER },
    ]);
    expect(r.manquants).toEqual(["header", "footer"]);
    expect(r.header).toEqual([]);
    expect(r.footer).toEqual([]);
  });

  test("⛔ des rows illisibles rendent la fente MANQUANTE, jamais un tableau vide", () => {
    // Le cœur du banc : un tableau vide compilerait l'e-mail sans en-tête — le défaut même que ce
    // module existe pour empêcher.
    const r = resoudrePartials({ header: ID_HEADER }, [ligneHeader({ rows: [{ pas: "une row" }] })]);
    expect(r.manquants).toEqual(["header"]);
    expect(r.header).toEqual([]);
  });

  test("⛔ UNE SEULE row invalide suffit à refuser tout le partial", () => {
    // Garder les rows valides et jeter l'autre livrerait un en-tête AMPUTÉ, sans que personne
    // puisse voir ce qui manque.
    const r = resoudrePartials({ header: ID_HEADER }, [
      ligneHeader({ rows: [rowTexte("a", "bon"), { pas: "une row" }] }),
    ]);
    expect(r.manquants).toEqual(["header"]);
    expect(r.header).toEqual([]);
  });

  test("⛔ un partial dont `rows` est un tableau VIDE est un refus, pas une résolution réussie", () => {
    /*
     * Le trou que ce module devait fermer, et qui est resté ouvert jusqu'au 15/09 : rendre `[]`
     * ici fait passer la fente pour honorée. La garde du planificateur ne voit aucun manquant,
     * `applyBrandPartials` reçoit `header: []` et n'avertit de RIEN (il ne parle que sur
     * `undefined`), et l'édition part sans son en-tête.
     *
     * La route de création refuse déjà `rows: []` — mais une écriture SQL directe ne passe par
     * aucune route, et c'est exactement par là que les 4 en-têtes de production ont été créés.
     */
    const r = resoudrePartials({ header: ID_HEADER }, [ligneHeader({ rows: [] })]);
    expect(r.manquants).toEqual(["header"]);
    expect(r.header).toEqual([]);
  });

  test("un pointeur qui n'est pas un uuid est refusé sans même chercher", () => {
    const r = resoudrePartials({ header: "pf_head" }, [ligneHeader()]);
    expect(r.manquants).toEqual(["header"]);
  });

  test("une ligne absente de la lecture est un refus", () => {
    const r = resoudrePartials({ header: ID_HEADER }, []);
    expect(r.manquants).toEqual(["header"]);
  });

  test("les deux fentes sont jugées séparément : l'une peut passer quand l'autre manque", () => {
    const r = resoudrePartials({ header: ID_HEADER, footer: ID_FOOTER }, [ligneHeader()]);
    expect(r.header).toHaveLength(1);
    expect(r.manquants).toEqual(["footer"]);
  });

  test("⛔ un partial ARCHIVÉ se résout quand même — archiver ne retire pas l'en-tête des modèles", () => {
    // Filtrer l'archivage ici ferait disparaître l'en-tête de plusieurs newsletters à leur
    // prochaine édition, sans qu'aucun écran ne l'ait annoncé.
    const r = resoudrePartials({ header: ID_HEADER }, [
      { ...ligneHeader(), archived_at: "2026-09-15T00:00:00Z" } as LignePartial,
    ]);
    expect(r.manquants).toEqual([]);
    expect(r.header).toHaveLength(1);
  });
});

describe("raisonPartialsManquants — ce que lira la personne qui ouvre l'admin", () => {
  test("nomme la fente en clair, et dit que l'édition a été RETENUE", () => {
    expect(raisonPartialsManquants(["header"])).toContain("brand header");
    expect(raisonPartialsManquants(["header"])).toContain("held back");
    expect(raisonPartialsManquants(["header", "footer"])).toContain("brand header and brand footer");
  });
});
