import { describe, expect, it } from "bun:test";
import { outboxRefFromEvent } from "./webhook-ref";

const UUID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const MSG = "abc123@news.example.com";

describe("outboxRefFromEvent", () => {
  it("préfère la variable utilisateur au message-id", () => {
    const ref = outboxRefFromEvent({ "user-variables": { outbox_id: UUID } }, MSG);
    // ⛔ L'ordre est le sujet du banc : le message-id est présent ET valide, et il ne doit PAS
    // gagner. C'est nous qui avons posé la variable ; le message-id est recopié par un tiers.
    expect(ref).toEqual({ by: "user_variable", outboxId: UUID });
  });

  it("accepte les variables rendues sous forme de chaîne JSON", () => {
    // Les deux formes se voient en production selon la version du webhook Mailgun.
    const ref = outboxRefFromEvent({ "user-variables": JSON.stringify({ outbox_id: UUID }) }, "");
    expect(ref).toEqual({ by: "user_variable", outboxId: UUID });
  });

  it("retombe sur le message-id quand la variable manque", () => {
    expect(outboxRefFromEvent({}, MSG)).toEqual({ by: "message_id", messageId: MSG });
    expect(outboxRefFromEvent({ "user-variables": {} }, MSG)).toEqual({ by: "message_id", messageId: MSG });
  });

  it("retombe sur le message-id quand la variable n'est pas un uuid", () => {
    // Le cas qui compte : une valeur PRÉSENTE mais inutilisable ne doit pas faire renoncer au
    // repli. Sinon un tiers qui envoie n'importe quoi coupe la jointure pour tout le monde.
    for (const mauvais of ["", "   ", "null", "42", "3f2504e0-4f89-41d3-9a0c", "<" + UUID + ">"]) {
      const ref = outboxRefFromEvent({ "user-variables": { outbox_id: mauvais } }, MSG);
      expect(ref).toEqual({ by: "message_id", messageId: MSG });
    }
  });

  it("ne cherche RIEN quand les deux manquent", () => {
    // ⛔ Jamais une chaîne vide : `provider_message_id = ''` a l'air d'une requête légitime.
    expect(outboxRefFromEvent({}, "")).toBeNull();
    expect(outboxRefFromEvent({ "user-variables": "pas du json" }, "")).toBeNull();
    expect(outboxRefFromEvent(null, "")).toBeNull();
    expect(outboxRefFromEvent(undefined, "")).toBeNull();
  });

  it("normalise l'uuid reçu (espaces, casse)", () => {
    const ref = outboxRefFromEvent({ "user-variables": { outbox_id: `  ${UUID.toUpperCase()}  ` } }, "");
    expect(ref).toEqual({ by: "user_variable", outboxId: UUID });
  });

  it("ignore une variable qui n'est pas une chaîne", () => {
    // `outbox_id: 42` ou un objet : le typage ne protège pas d'un tiers.
    expect(outboxRefFromEvent({ "user-variables": { outbox_id: 42 } }, MSG)).toEqual({
      by: "message_id",
      messageId: MSG,
    });
    expect(outboxRefFromEvent({ "user-variables": { outbox_id: { id: UUID } } }, MSG)).toEqual({
      by: "message_id",
      messageId: MSG,
    });
  });
});
