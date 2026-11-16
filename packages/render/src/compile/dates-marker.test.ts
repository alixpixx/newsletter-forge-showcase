/**
 * Le choix des formats de date (`meta.dateFormats`) doit arriver jusqu'au worker, qui ne voit que
 * le shell figé : le compilateur le pose en marqueur, le worker le lit puis le retire.
 *
 * ⛔ Ce banc tient les deux bouts avec les VRAIES fonctions du worker (`readDateFormats`,
 * `stripDateFormatsMarker`, de `@nf/email/dates`) : un marqueur que le compilateur écrirait dans une
 * forme que le worker ne relit pas partirait en silence au format par défaut.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_DATE_FORMATS, readDateFormats, stripDateFormatsMarker } from "@nf/email/dates";
import { compileDoc } from "./index";

const doc = (dateFormats?: Record<string, string>) => ({
  schema: 2 as const,
  meta: { subject: "S", assetSlug: "northwind-sports", locale: "es", ...(dateFormats ? { dateFormats } : {}) },
  rows: [
    {
      id: "r1",
      layout: "1",
      columns: [{ id: "c1", blocks: [{ id: "b1", type: "text", paragraphs: [{ spans: [{ text: "Edición del {{edition_date}}" }] }] }] }],
    },
  ],
});

describe("formats de date : du document au worker", () => {
  test("rien de choisi ⇒ aucun marqueur, le worker garde les formats d'avant", async () => {
    const { html } = await compileDoc(doc() as never);
    expect(html).not.toContain("nf:dates");
    expect(readDateFormats(html)).toEqual(DEFAULT_DATE_FORMATS);
  });

  test("seulement les défauts ⇒ shell identique à l'octet près à celui sans réglage", async () => {
    const sans = (await compileDoc(doc() as never)).html;
    const defauts = (await compileDoc(doc({ ...DEFAULT_DATE_FORMATS }) as never)).html;
    expect(defauts).toBe(sans);
  });

  test("un style choisi ⇒ marqueur avant </body>, relu par le worker, et retiré il rend le shell d'avant", async () => {
    const sans = (await compileDoc(doc() as never)).html;
    const r = await compileDoc(doc({ edition_date: "full", weekday: "weekday_short" }) as never);
    expect(r.html).toContain("<!--nf:dates edition_date=full weekday=weekday_short--></body>");
    expect(readDateFormats(r.html)).toEqual({ ...DEFAULT_DATE_FORMATS, edition_date: "full", weekday: "weekday_short" });
    expect(stripDateFormatsMarker(r.html)).toBe(sans);
    // Le poids annoncé est celui du shell qui part au gel, marqueur compris.
    expect(r.sizeBytes).toBe(Buffer.byteLength(r.html, "utf8"));
  });

  test("un style inconnu est refusé par le schéma, jamais transmis", async () => {
    await expect(compileDoc(doc({ edition_date: "julian" }) as never)).rejects.toThrow();
  });
});
