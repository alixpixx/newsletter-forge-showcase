/**
 * LA PORTE D'ENVOI DEVANT UN CONTACT HORS NEWSLETTER (0088, décision d'Alix du 25/09/2026).
 *
 * ⛔ Un contact (statut `contact`) ne passe QUE sur une ligne `campaign` marquée `audience: contacts`
 * — la marque que seule `enqueue_campaign_batch_contacts` écrit. Et sa finalité ne saute que si la
 * ligne porte AUSSI `ignore_purpose: true`. Tout le reste est refusé, et nommé.
 */
import { describe, expect, test } from "bun:test";
import { gate } from "./gate";
import type { OutboxContext } from "./db";

const MAINTENANT = new Date("2026-09-25T12:00:00Z");

function ctx(p: Partial<OutboxContext> = {}): OutboxContext {
  return {
    id: "o1",
    kind: "campaign",
    subject: "s",
    action_url: null,
    payload: { audience: "contacts" },
    to_email: "a@example.invalid",
    status: "pending",
    attempts: 0,
    max_attempts: 5,
    next_attempt_at: "2026-09-25T00:00:00Z",
    created_at: "2026-09-25T11:00:00Z",
    asset_id: "asset-1",
    subscription_id: "sub-1",
    asset_name: "Pixel Daily",
    asset_slug: "pixel-daily",
    sending_subdomain: "mg",
    compliance_regime: "lgpd",
    legal_footer: { company: "X" },
    language: "pt",
    sub_status: "contact",
    subscriber_id: "subr-1",
    tracking_consent: false,
    suppressed: false,
    purpose: "content",
    market: null,
    consent_mode: null,
    granted_purposes: {},
    ...p,
  } as OutboxContext;
}

describe("gate — un contact visé par une campagne de contacts", () => {
  test("sans la case : la finalité reste exigée", () => {
    expect(gate(ctx(), MAINTENANT)).toEqual({ send: false, reason: "purpose_not_granted" });
    expect(gate(ctx({ granted_purposes: { content: true } }), MAINTENANT).send).toBe(true);
  });

  test("avec la case : il reçoit sans finalité", () => {
    // MUTATION QUI DOIT TUER : retirer `&& !finaliteIgnoree` du calcul de `purpose`.
    const d = gate(ctx({ payload: { audience: "contacts", ignore_purpose: true } }), MAINTENANT);
    expect(d.send).toBe(true);
  });

  test("⛔ la suppression l'arrête toujours, case cochée", () => {
    const d = gate(ctx({ payload: { audience: "contacts", ignore_purpose: true }, suppressed: true }), MAINTENANT);
    expect(d).toEqual({ send: false, reason: "suppressed" });
  });
});

describe("gate — tout le reste est refusé", () => {
  test("un contact sur une ligne SANS la marque : not_active (la newsletter ne l'atteint pas)", () => {
    // MUTATION QUI DOIT TUER : `requiredStatus: "contact"` sans condition.
    expect(gate(ctx({ payload: null }), MAINTENANT)).toEqual({ send: false, reason: "not_active" });
    expect(gate(ctx({ payload: { ignore_purpose: true } }), MAINTENANT)).toEqual({ send: false, reason: "not_active" });
  });

  test("un abonné actif sur une ligne de contacts : not_contact", () => {
    // MUTATION QUI DOIT TUER : retirer la ligne `not_contact`. L'abonné passerait sans sa finalité.
    const d = gate(ctx({ sub_status: "active", payload: { audience: "contacts", ignore_purpose: true } }), MAINTENANT);
    expect(d).toEqual({ send: false, reason: "not_contact" });
  });

  test("la marque sur un autre kind que `campaign` : contacts_not_allowed", () => {
    for (const kind of ["automation", "broadcast", "reengagement", "welcome"]) {
      const d = gate(ctx({ kind, payload: { audience: "contacts", ignore_purpose: true } }), MAINTENANT);
      expect(d).toEqual({ send: false, reason: "contacts_not_allowed" });
    }
  });

  test("`ignore_purpose` sans la marque ne lève RIEN pour un abonné", () => {
    const d = gate(ctx({ sub_status: "active", payload: { ignore_purpose: true } }), MAINTENANT);
    expect(d).toEqual({ send: false, reason: "purpose_not_granted" });
  });

  test("une ligne d'abonné ordinaire reste inchangée", () => {
    const d = gate(ctx({ sub_status: "active", payload: null, granted_purposes: { content: true } }), MAINTENANT);
    expect(d.send).toBe(true);
  });
});
