/**
 * EN-TÊTE ET PIED DE MARQUE — CE QUI ARRIVE VRAIMENT DANS LE HTML PRODUIT.
 *
 * Les bancs de ce fichier lisent la SORTIE : l'ordre des textes dans le HTML compilé, pas l'ordre du
 * tableau `rows` qui vient d'être construit trois lignes plus haut. Un test qui relit la structure
 * qu'il vient d'assembler ne prouve que sa propre arithmétique.
 */
import { describe, expect, test } from "bun:test";
import { EmailDoc, type Row } from "../schema";
import { applyBrandPartials } from "./brand-partials";
import { compileDoc } from "./index";

/* ------------------------------------------------------------------ *
 * Matière
 * ------------------------------------------------------------------ */

const rowTexte = (id: string, texte: string): unknown => ({
  id,
  layout: "1",
  columns: [
    { id: `${id}_c`, blocks: [{ id: `${id}_b`, type: "text", paragraphs: [{ spans: [{ text: texte }] }] }] },
  ],
});

const rowLegale = (id = "legal"): unknown => ({
  id,
  layout: "1",
  columns: [{ id: `${id}_c`, blocks: [{ id: `${id}_b`, type: "footer_legal" }] }],
});

const doc = (rows: unknown[], meta: Record<string, unknown> = {}) =>
  EmailDoc.parse({
    schema: 2,
    meta: { subject: "Sujet", preheader: "Preheader", assetSlug: "copper-kettle", locale: "es", ...meta },
    theme: {},
    rows,
  });

const rows = (brut: unknown[]): Row[] => brut.map((r) => EmailDoc.parse({
  schema: 2,
  meta: { subject: "s", preheader: "p", assetSlug: "x" },
  theme: {},
  rows: [r],
}).rows[0]!);

/** Ordre d'apparition des marqueurs dans le HTML compilé. −1 = absent. */
const ordre = (html: string, ...marqueurs: string[]): number[] => marqueurs.map((m) => html.indexOf(m));

const UUID_H = "11111111-1111-4111-8111-111111111111";
const UUID_F = "22222222-2222-4222-8222-222222222222";

/* ------------------------------------------------------------------ *
 * D5 — la clé nouvelle ne doit casser aucun document existant
 * ------------------------------------------------------------------ */

describe("doc.meta — les pointeurs de partial sont OPTIONNELS", () => {
  /**
   * ⛔ LE TEST CENTRAL DE H1.b. MUTATION QUI DOIT LE TUER : retirer `.optional()` de
   * `headerPartialId` ou de `footerPartialId` dans `Meta`.
   * Symptôme en production : `Meta` est `.strict()` et TOUS les `template_version.doc` déjà en base
   * sont dépourvus de ces clés — ils cesseraient tous de se relire d'un coup, sans migration
   * possible côté auteur, et le builder afficherait « document invalide » sur chaque modèle.
   */
  test("un document SANS ces clés parse toujours", () => {
    const r = EmailDoc.safeParse({
      schema: 2,
      meta: { subject: "S", preheader: "P", assetSlug: "harbor-tech", locale: "en" },
      theme: {},
      rows: [rowLegale()],
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data.meta.headerPartialId).toBeUndefined();
  });

  test("un document AVEC les deux pointeurs parse, et les conserve", () => {
    const d = doc([rowLegale()], { headerPartialId: UUID_H, footerPartialId: UUID_F });
    expect(d.meta.headerPartialId).toBe(UUID_H);
    expect(d.meta.footerPartialId).toBe(UUID_F);
  });

  /** Le `.strict()` reste entier : ces deux clés sont les SEULES ajoutées. */
  test("une clé inventée reste refusée", () => {
    const r = EmailDoc.safeParse({
      schema: 2,
      meta: { subject: "S", preheader: "P", assetSlug: "x", brandPartialId: UUID_H },
      theme: {},
      rows: [],
    });
    expect(r.success).toBe(false);
  });

  /** Un pointeur qui n'est pas un uuid ne désignerait aucune ligne : autant le refuser au parse. */
  test("un pointeur qui n'est pas un uuid est refusé", () => {
    const r = EmailDoc.safeParse({
      schema: 2,
      meta: { subject: "S", preheader: "P", assetSlug: "x", headerPartialId: "pf_head" },
      theme: {},
      rows: [],
    });
    expect(r.success).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * H2 — la place exacte des rows dans le HTML produit
 * ------------------------------------------------------------------ */

describe("compileDoc — où l'en-tête et le pied de marque atterrissent", () => {
  const document = doc([rowTexte("corps", "CORPS"), rowLegale()]);

  test("l'en-tête sort AVANT le corps", async () => {
    const { html } = await compileDoc(document, { header: rows([rowTexte("pf_head", "ENTETE")]) });
    const [entete, corps] = ordre(html, "ENTETE", "CORPS");
    expect(entete).toBeGreaterThan(-1);
    expect(entete).toBeLessThan(corps!);
  });

  /**
   * ⛔ LE TEST CENTRAL DE H2. MUTATION QUI DOIT LE TUER : dans `applyBrandPartials`, poser le pied
   * éditorial après la row du pied légal (`doc.rows.slice(0, coupure + 1)`), ou à sa place.
   * Symptôme en production : la mention de désabonnement cesse d'être la dernière chose de l'e-mail
   * — et si le pied éditorial prend sa PLACE, le jeton `{{legal_footer_html}}` disparaît du shell,
   * `renderLifecycle()` refuse alors de servir ce HTML et retombe en silence sur le texte en dur.
   */
  test("le pied éditorial s'insère APRÈS le corps et AVANT le pied légal", async () => {
    const { html } = await compileDoc(document, { footer: rows([rowTexte("tw_foot", "PIEDMARQUE")]) });
    const [corps, marque, legal] = ordre(html, "CORPS", "PIEDMARQUE", "{{legal_footer_html}}");
    expect(marque).toBeGreaterThan(corps!);
    expect(marque).toBeLessThan(legal!);
  });

  test("le pied légal reste dans le HTML : le partial ne prend jamais sa place", async () => {
    const { html } = await compileDoc(document, { footer: rows([rowTexte("tw_foot", "PIEDMARQUE")]) });
    expect(html).toContain("{{legal_footer_html}}");
  });

  test("les deux fentes ensemble : en-tête, corps, pied de marque, pied légal", async () => {
    const { html } = await compileDoc(document, {
      header: rows([rowTexte("pf_head", "ENTETE")]),
      footer: rows([rowTexte("tw_foot", "PIEDMARQUE")]),
    });
    const positions = ordre(html, "ENTETE", "CORPS", "PIEDMARQUE", "{{legal_footer_html}}");
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(positions.every((p) => p > -1)).toBe(true);
  });

  /** Sans pied légal, le document est de toute façon veto à l'envoi : le partial va en dernier. */
  test("document sans pied légal : le pied de marque va à la fin", () => {
    const applique = applyBrandPartials(doc([rowTexte("corps", "CORPS")]), {
      footer: rows([rowTexte("tw_foot", "PIEDMARQUE")]),
    });
    expect(applique.doc.rows.map((r) => r.columns[0]!.blocks[0]!.id.slice(0, 3))).toHaveLength(2);
    expect(applique.doc.rows.at(-1)!.columns[0]!.blocks[0]!.type).toBe("text");
  });
});

/* ------------------------------------------------------------------ *
 * Invariant 2 — le pied légal ne voyage jamais dans un partial
 * ------------------------------------------------------------------ */

describe("un partial ne peut pas embarquer le pied légal", () => {
  /**
   * ⛔ MUTATION QUI DOIT LE TUER : retirer la boucle `rowCarriesFooterLegal` d'`applyBrandPartials`.
   * Symptôme en production : DEUX jetons `{{legal_footer_html}}` dans le même shell, donc deux
   * mentions de désabonnement — une deuxième source pour une information qui doit être unique.
   */
  test("l'application refuse, elle ne compile pas deux pieds légaux", () => {
    expect(() =>
      applyBrandPartials(doc([rowTexte("corps", "CORPS"), rowLegale()]), {
        footer: rows([rowLegale("partial_legal")]),
      }),
    ).toThrow(/legal footer/i);
  });

  test("le refus vaut aussi pour la fente en-tête", () => {
    expect(() =>
      applyBrandPartials(doc([rowLegale()]), { header: rows([rowLegale("partial_legal")]) }),
    ).toThrow(/legal footer/i);
  });
});

/* ------------------------------------------------------------------ *
 * Invariant 3 — les ids sont régénérés
 * ------------------------------------------------------------------ */

describe("les ids du partial sont régénérés à l'insertion", () => {
  /**
   * ⛔ MUTATION QUI DOIT LE TUER : retirer `.map(withFreshRowIds)` dans `applyBrandPartials`.
   * Symptôme en production : `pf_head` existe à l'identique sur les quatre modèles Copper Kettle. Un
   * document extrait de son propre en-tête porterait deux fois le même id de bloc, et
   * `expandFeedBlocks` — qui indexe ses résolutions PAR id de bloc — servirait les articles d'un
   * bloc de flux à un autre.
   */
  test("un id déjà présent dans le document ne se retrouve jamais en double", () => {
    const applique = applyBrandPartials(doc([rowTexte("pf_head", "CORPS"), rowLegale()]), {
      header: rows([rowTexte("pf_head", "ENTETE")]),
    });

    const ids: string[] = [];
    for (const r of applique.doc.rows) {
      ids.push(r.id);
      for (const c of r.columns) {
        ids.push(c.id);
        for (const b of c.blocks) ids.push(b.id);
      }
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  /** Les rows sources ne sont pas mutées : l'appelant peut réutiliser sa résolution. */
  test("la row source garde son id — on travaille sur une copie", () => {
    const source = rows([rowTexte("pf_head", "ENTETE")]);
    applyBrandPartials(doc([rowLegale()]), { header: source });
    expect(source[0]!.id).toBe("pf_head");
  });
});

/* ------------------------------------------------------------------ *
 * Le thème ne voyage pas, et l'existant ne bouge pas
 * ------------------------------------------------------------------ */

describe("ce que le partial ne touche pas", () => {
  /**
   * ⛔ Les 4 modèles Copper Kettle partagent le même en-tête et ont QUATRE thèmes différents.
   * MUTATION QUI DOIT LE TUER : faire porter un thème au partial et l'écrire dans `doc.theme`.
   */
  test("le thème du document est intact", () => {
    const avant = doc([rowLegale()], {});
    const applique = applyBrandPartials(avant, { header: rows([rowTexte("pf_head", "ENTETE")]) });
    expect(applique.doc.theme).toEqual(avant.theme);
  });

  /**
   * ⛔ MUTATION QUI DOIT LE TUER : retirer le `return { doc, warnings }` anticipé
   * d'`applyBrandPartials`, pour que le document soit reconstruit même sans aucun partial.
   * Ce qui est en jeu : `COMPILER_VERSION` n'a PAS été incrémenté, au motif qu'un document sans
   * partial traverse cette fonction sans qu'une row change. Il faut que ce soit vrai — sinon les
   * 7 versions publiées auraient un HTML de référence périmé sans que rien ne le dise.
   */
  test("sans partial, le document n'est même pas reconstruit, et le HTML ne bouge pas", async () => {
    const document = doc([rowTexte("corps", "CORPS"), rowLegale()]);
    expect(applyBrandPartials(document, {}).doc).toBe(document);
    expect(applyBrandPartials(document).doc).toBe(document);

    const sans = await compileDoc(document);
    const vide = await compileDoc(document, {});
    expect(vide.html).toBe(sans.html);
    expect(vide.text).toBe(sans.text);
  });
});

/* ------------------------------------------------------------------ *
 * « Je ne sais pas » ne s'écrit pas « rien »
 * ------------------------------------------------------------------ */

describe("un pointeur que l'appelant n'a pas résolu est DIT", () => {
  /**
   * ⛔ MUTATION QUI DOIT LE TUER : supprimer les deux `warnings.push` d'`applyBrandPartials`.
   * Symptôme en production : `apps/worker/src/planner.ts` recompile les occurrences qui portent un
   * bloc flux SANS passer de partial. L'e-mail partirait alors sans son en-tête de marque, et rien
   * nulle part n'aurait signalé qu'il manquait quelque chose.
   */
  test("un document qui pointe sur un en-tête non fourni le signale", async () => {
    const { warnings } = await compileDoc(doc([rowLegale()], { headerPartialId: UUID_H }));
    expect(warnings.some((w) => /points at a brand header/i.test(w))).toBe(true);
  });

  test("le même signalement existe pour le pied", async () => {
    const { warnings } = await compileDoc(doc([rowLegale()], { footerPartialId: UUID_F }));
    expect(warnings.some((w) => /points at a brand footer/i.test(w))).toBe(true);
  });

  test("pointeur résolu et fourni : aucun signalement", async () => {
    const { warnings } = await compileDoc(doc([rowLegale()], { headerPartialId: UUID_H }), {
      header: rows([rowTexte("pf_head", "ENTETE")]),
    });
    expect(warnings.some((w) => /points at a brand header/i.test(w))).toBe(false);
  });

  /** Aucun pointeur, aucun partial : rien à dire. */
  test("un document sans pointeur ne gagne aucun avertissement", async () => {
    const { warnings } = await compileDoc(doc([rowLegale()]));
    expect(warnings.some((w) => /points at a brand/i.test(w))).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Le doublon du jour où l'on pose un pointeur sur un modèle EXISTANT
 * ------------------------------------------------------------------ */

describe("appliquer un en-tête que le document contient DÉJÀ", () => {
  /**
   * ⛔ CE QUE CE BLOC EXISTE POUR EMPÊCHER. `applyBrandPartials` PRÉFIXE, il ne remplace pas. Or les
   * modèles sur lesquels on voudra poser un pointeur portent déjà leur en-tête sous forme de row —
   * les quatre boletines Copper Kettle ouvrent tous sur `pf_head`, la row même dont l'en-tête de
   * marque a été extrait. Poser le pointeur sans retirer cette row afficherait le logo, le kicker et
   * la date DEUX FOIS, et rien ne s'en plaindrait : le document est valide, la compilation réussit,
   * l'envoi de test passe.
   *
   * ⛔ MUTATION QUI DOIT LE TUER : supprimer le `warnings.push` du doublon dans `applyBrandPartials`.
   */
  test("le doublon est DIT, pas corrigé en douce", async () => {
    const { warnings } = await compileDoc(
      doc([rowTexte("pf_head", "Copper Kettle"), rowTexte("corps", "Article"), rowLegale()], {
        headerPartialId: UUID_H,
      }),
      { header: rows([rowTexte("pf_head", "Copper Kettle")]) },
    );
    expect(warnings.some((w) => /show it twice/i.test(w))).toBe(true);
  });

  test("⛔ la détection ignore les IDS : une copie renommée est le même doublon", async () => {
    // `withFreshRowIds` régénère les ids du partial à l'insertion : une comparaison par identité
    // ne trouverait JAMAIS le doublon qu'on cherche, et le garde serait décoratif.
    const { warnings } = await compileDoc(
      doc([rowTexte("pf_head", "Copper Kettle"), rowLegale()], { headerPartialId: UUID_H }),
      { header: rows([rowTexte("un_tout_autre_id", "Copper Kettle")]) },
    );
    expect(warnings.some((w) => /show it twice/i.test(w))).toBe(true);
  });

  test("la contre-épreuve : un en-tête ABSENT du document ne déclenche rien", async () => {
    // Sans ce test, un avertissement poussé systématiquement passerait les deux tests ci-dessus et
    // crierait au doublon sur chaque e-mail correctement configuré.
    const { warnings } = await compileDoc(
      doc([rowTexte("corps", "Article"), rowLegale()], { headerPartialId: UUID_H }),
      { header: rows([rowTexte("pf_head", "Copper Kettle")]) },
    );
    expect(warnings.some((w) => /show it twice/i.test(w))).toBe(false);
  });

  test("le même garde vaut pour le pied de marque", async () => {
    const { warnings } = await compileDoc(
      doc([rowTexte("corps", "Article"), rowTexte("pied", "Síguenos"), rowLegale()], {
        footerPartialId: UUID_F,
      }),
      { footer: rows([rowTexte("pied", "Síguenos")]) },
    );
    expect(warnings.some((w) => /brand footer/i.test(w) && /show it twice/i.test(w))).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Bornes
 * ------------------------------------------------------------------ */

describe("bornes", () => {
  test("un document qui dépasserait le plafond de rows est refusé, pas tronqué", () => {
    const corps = Array.from({ length: 199 }, (_, i) => rowTexte(`r${i}`, `T${i}`));
    expect(() =>
      applyBrandPartials(doc([...corps, rowLegale()]), { header: rows([rowTexte("pf_head", "ENTETE")]) }),
    ).toThrow(/rows/i);
  });

  test("au-delà de 20 rows, le partial est refusé au parse", () => {
    const trop = rows(Array.from({ length: 21 }, (_, i) => rowTexte(`h${i}`, `H${i}`)));
    expect(() => applyBrandPartials(doc([rowLegale()]), { header: trop })).toThrow();
  });
});
