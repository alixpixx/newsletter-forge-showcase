/**
 * LES RÈGLES DE LA RELECTURE (0079) — pures, partagées par la route de l'admin et le worker.
 *
 * Ce banc garde ce que les deux appelants tiennent pour acquis : l'écart est MINIMAL (c'est ce qui rend
 * « reset » exact), une édition vide est refusée, un lien est une adresse web, et cacher une carte de
 * flux emporte son filet — et rien d'autre.
 */
import { describe, expect, test } from "bun:test";
import {
  EDITION_VIDE,
  appliquerArticles,
  articlesDeLEdition,
  contexteGele,
  estUrlWeb,
  revisionEnAttente,
  validerOverrides,
  type EditionBase,
} from "./regles";

const art = (id: string, title = `Titre ${id}`) => ({ id, type: "article", title, excerpt: `Ext ${id}`, href: `https://x.test/${id}` });
const filet = (id: string) => ({ id, type: "divider" });
const titre = { id: "h", type: "heading", text: "À la une" };

const doc = (blocks: unknown[]) => ({ meta: { locale: "es" }, rows: [{ columns: [{ blocks }] }] });
const idsDe = (d: unknown) =>
  ((d as { rows: { columns: { blocks: { id: string }[] }[] }[] }).rows[0]!.columns[0]!.blocks).map((b) => b.id);

const base = (d: unknown, extra: Partial<EditionBase> = {}): EditionBase => ({
  version: 1,
  doc: d,
  partials: null,
  pointeAuxPartials: false,
  html_shell: "<html></html>",
  text_shell: null,
  size_bytes: null,
  subject: "Sujet",
  preheader: null,
  campaign_name: "C",
  segment_id: null,
  ai: false,
  ai_intro: null,
  ai_preheader: null,
  ...extra,
});

describe("cacher une carte emporte SON filet, et seulement lui", () => {
  const blocs = [titre, art("a"), filet("d1"), art("b"), filet("d2"), art("c")];
  const cas: [string, string[], string[]][] = [
    ["la première : le filet d'après", ["a"], ["h", "b", "d2", "c"]],
    ["celle du milieu : le filet d'avant", ["b"], ["h", "a", "d2", "c"]],
    ["la dernière : le filet d'avant", ["c"], ["h", "a", "d1", "b"]],
    ["deux voisines : leurs deux filets", ["a", "b"], ["h", "c"]],
    ["les deux dernières", ["b", "c"], ["h", "a"]],
  ];
  for (const [nom, caches, attendu] of cas) {
    test(nom, () => {
      const relu = appliquerArticles(doc(blocs), Object.fromEntries(caches.map((id) => [id, { hidden: true as const }])));
      expect(idsDe(relu)).toEqual(attendu);
    });
  }

  test("un filet qui borde un titre n'est jamais touché (mise en page écrite à la main)", () => {
    const relu = appliquerArticles(doc([titre, filet("d0"), art("a"), filet("d1"), art("b")]), { a: { hidden: true } });
    expect(idsDe(relu)).toEqual(["h", "d0", "b"]);
  });

  test("sans écart, le document ressort À L'OBJET PRÈS", () => {
    const d = doc(blocs);
    expect(appliquerArticles(d, undefined)).toBe(d);
    expect(appliquerArticles(d, {})).toBe(d);
  });
});

describe("validerOverrides — l'écart minimal, et ses refus", () => {
  const b = base(doc([art("a"), filet("d"), art("b")]), { ai: true, ai_intro: "Généré" });

  test("une valeur égale au gel n'est pas un écart : c'est un reset", () => {
    const v = validerOverrides(
      { subject: "Sujet", ai_intro: "Généré", articles: { a: { title: "Titre a", href: "https://x.test/a" } } },
      contexteGele(b),
    );
    expect(v).toEqual({ ok: true, overrides: null });
  });

  test("une intro VIDÉE est un écart (l'édition part sans intro), un sujet vidé non (il ne part jamais vide)", () => {
    const v = validerOverrides({ subject: "  ", ai_intro: "" }, contexteGele(b));
    expect(v).toEqual({ ok: true, overrides: { ai_intro: "" } });
  });

  test("⛔ tout cacher est refusé avec le message de l'écran", () => {
    const v = validerOverrides({ articles: { a: { hidden: true }, b: { hidden: true } } }, contexteGele(b));
    expect(v).toEqual({ ok: false, erreur: EDITION_VIDE });
  });

  test("un en-tête de marque non capturé au gel : la recompilation est refusée plutôt que de le perdre", () => {
    const sansEntete = base(b.doc, { pointeAuxPartials: true, partials: null });
    const v = validerOverrides({ articles: { a: { title: "Autre" } } }, contexteGele(sansEntete));
    expect(v.ok).toBe(false);
  });

  test("planifiée : ni articles ni textes du modèle (pas encore choisis)", () => {
    const ctx = { etat: "planned" as const, base: null, sujetDeBase: "S", preheaderDeBase: null };
    expect(validerOverrides({ articles: { a: { hidden: true } } }, ctx).ok).toBe(false);
    expect(validerOverrides({ ai_intro: "x" }, ctx).ok).toBe(false);
    expect(validerOverrides({ subject: "Autre" }, ctx)).toEqual({ ok: true, overrides: { subject: "Autre" } });
  });

  test("l'écart d'une édition sans jeton IA ne peut pas écrire de texte IA (rien ne l'afficherait)", () => {
    const v = validerOverrides({ ai_intro: "x" }, contexteGele(base(b.doc)));
    expect(v.ok).toBe(false);
  });
});

describe("petites règles partagées", () => {
  test("estUrlWeb : http(s) complet seulement", () => {
    for (const [u, ok] of [
      ["https://a.test/x", true],
      ["http://a.test", true],
      ["javascript:alert(1)", false],
      ["mailto:a@b.test", false],
      ["//a.test/x", false],
      ["https://a.test/x y", false],
      ["", false],
    ] as const) {
      expect(`${u}:${estUrlWeb(u)}`).toBe(`${u}:${ok}`);
    }
  });

  test("revisionEnAttente : rev > appliquée ; une colonne absente vaut 0", () => {
    expect(revisionEnAttente(2, 1)).toBe(true);
    expect(revisionEnAttente(2, 2)).toBe(false);
    expect(revisionEnAttente(null, null)).toBe(false);
    expect(revisionEnAttente(undefined, undefined)).toBe(false);
    expect(revisionEnAttente(1, undefined)).toBe(true);
  });

  test("articlesDeLEdition lit les blocs article, dans l'ordre", () => {
    expect(articlesDeLEdition(doc([titre, art("a"), filet("d"), art("b")])).map((a) => a.id)).toEqual(["a", "b"]);
  });
});
