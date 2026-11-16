/**
 * Banc de la ligne « date · Edición N » des en-têtes Copper Kettle (décision d'Alix du 16/09 :
 * « on le rend dynamique »).
 *
 * `visibleIf` ne s'applique qu'à un bloc entier, pas à une portion de texte. La ligne est donc
 * portée par DEUX blocs exclusifs : avec numéro (`edition_number` présent) et sans (`exists:false`).
 * ⛔ Ce qu'on refuse de livrer : « 16 septiembre 2026 · Edición » avec un numéro vide (campagne
 * ponctuelle, envoi de test), ou les deux lignes à la fois.
 */
import { describe, expect, test } from "bun:test";
import { compileDoc } from "./compile";
import { hydrate, hydrateText } from "./hydrate";
import { EmailDoc } from "./schema";

const STYLE = { fontSize: 14, textColor: "#8FA0B8", textTransform: "uppercase" };

const AVEC_NUMERO = {
  id: "pf_date_ed",
  type: "text",
  preset: "body",
  style: STYLE,
  visibleIf: { token: "edition_number" },
  paragraphs: [{ spans: [{ text: "{{edition_date}} · Edición {{edition_number}}" }] }],
};
const SANS_NUMERO = {
  id: "pf_date",
  type: "text",
  preset: "body",
  style: STYLE,
  visibleIf: { token: "edition_number", exists: false },
  paragraphs: [{ spans: [{ text: "{{edition_date}}" }] }],
};

async function shells() {
  const doc = EmailDoc.parse({
    schema: 2,
    meta: { subject: "Boletín", preheader: "", assetSlug: "copper-kettle", locale: "es-CL" },
    theme: { contentWidth: 600 },
    rows: [{ id: "r1", layout: "1", columns: [{ id: "c1", blocks: [AVEC_NUMERO, SANS_NUMERO, { id: "f1", type: "footer_legal" }] }] }],
  });
  return await compileDoc(doc as never);
}

const DATE = "16 septiembre 2026";

describe("ligne d'édition Copper Kettle", () => {
  test("occurrence de série n° 12 ⇒ « Edición 12 », une seule ligne", async () => {
    const { html, text } = await shells();
    const vars = { edition_date: DATE, edition_number: "12" };
    const h = hydrate(html, vars);
    expect(h).toContain(`${DATE} · Edición 12`);
    expect(h.split(DATE).length - 1).toBe(1);
    const t = hydrateText(text, vars);
    expect(t).toContain(`${DATE} · Edición 12`);
    expect(t.split(DATE).length - 1).toBe(1);
  });

  test("⛔ sans numéro (campagne ponctuelle, test) ⇒ la date seule, aucun « Edición »", async () => {
    const { html, text } = await shells();
    const vars = { edition_date: DATE, edition_number: "" };
    const h = hydrate(html, vars);
    // Contrôle positif d'abord : le shell rend bien quelque chose.
    expect(h).toContain(DATE);
    expect(h.split(DATE).length - 1).toBe(1);
    expect(h).not.toContain("Edición");
    const t = hydrateText(text, vars);
    expect(t).toContain(DATE);
    expect(t).not.toContain("Edición");
  });

  test("numéro absent des variables ⇒ même chose que vide", async () => {
    const { html } = await shells();
    const h = hydrate(html, { edition_date: DATE });
    expect(h).toContain(DATE);
    expect(h).not.toContain("Edición");
  });
});
