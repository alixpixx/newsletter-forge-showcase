/**
 * L'envoi immédiat (22/09/2026) ne doit rien ouvrir d'autre que ce qu'il nomme : une campagne
 * « maintenant », demandée en toutes lettres. Le refus d'une date passée, lui, ne bouge pas.
 */
import { describe, expect, test } from "bun:test";
import { resolveSendWhen } from "./send-when";

const MAINTENANT = Date.parse("2026-09-22T12:00:00Z");

describe("resolveSendWhen — l'envoi immédiat", () => {
  /** MUTATION QUI DOIT LE TUER : prendre `scheduledAt` du navigateur au lieu de `now`. */
  test("sendNow: true date la campagne à l'heure du SERVEUR", () => {
    const r = resolveSendWhen({ sendNow: true }, MAINTENANT);
    expect(r).toEqual({ ok: true, when: new Date(MAINTENANT), sendNow: true });
  });

  test("sendNow: true avec scheduledAt null est accepté (le champ vide d'un formulaire)", () => {
    expect(resolveSendWhen({ sendNow: true, scheduledAt: null }, MAINTENANT).ok).toBe(true);
  });

  /** ⛔ Deviner entre « maintenant » et « jeudi » à la place de l'appelant : refus. */
  test("sendNow et scheduledAt ensemble sont refusés", () => {
    const r = resolveSendWhen({ sendNow: true, scheduledAt: "2026-09-25T10:00:00Z" }, MAINTENANT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not both");
  });

  /**
   * ⛔ UNE VALEUR « VRAIE » N'EST PAS UNE DEMANDE. `"true"`, `1` ou `"yes"` sont refusés : un envoi
   * immédiat ne part pas sur une coercition. MUTATION QUI DOIT LE TUER : tester `if (body.sendNow)`.
   */
  for (const v of ["true", 1, "yes"] as const) {
    test(`sendNow = ${JSON.stringify(v)} est refusé`, () => {
      expect(resolveSendWhen({ sendNow: v }, MAINTENANT).ok).toBe(false);
    });
  }

  test("sendNow: false retombe sur la date, qui reste obligatoire", () => {
    const r = resolveSendWhen({ sendNow: false }, MAINTENANT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("scheduledAt is required");
  });
});

describe("resolveSendWhen — la date programmée ne change pas", () => {
  test("une date future est acceptée telle quelle", () => {
    const r = resolveSendWhen({ scheduledAt: "2026-09-22T12:30:00Z" }, MAINTENANT);
    expect(r).toEqual({ ok: true, when: new Date("2026-09-22T12:30:00Z"), sendNow: false });
  });

  /**
   * ⛔ LE REFUS D'UNE DATE PASSÉE SURVIT À L'ENVOI IMMÉDIAT. Une date passée sans `sendNow` reste
   * « une faute de frappe ou un envoi immédiat déguisé ». MUTATION QUI DOIT LE TUER : accepter une
   * date passée en la ramenant à `now`.
   */
  test("une date passée est refusée, et le refus indique Send now", () => {
    const r = resolveSendWhen({ scheduledAt: "2026-09-22T11:59:00Z" }, MAINTENANT);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("must be in the future");
      expect(r.error).toContain("Send now");
    }
  });

  test("l'instant présent exact est une date passée", () => {
    expect(resolveSendWhen({ scheduledAt: new Date(MAINTENANT).toISOString() }, MAINTENANT).ok).toBe(false);
  });

  test("une date illisible est refusée en le disant", () => {
    const r = resolveSendWhen({ scheduledAt: "jeudi" }, MAINTENANT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not a valid date-time");
  });
});
