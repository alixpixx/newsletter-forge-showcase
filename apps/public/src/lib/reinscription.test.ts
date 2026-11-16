/**
 * LA RÉINSCRIPTION VOLONTAIRE — câblage côté site public (0073, 22/09/2026).
 *
 * Alix : « si la personne se reinscrit on l'a reme dans le systeme ». Mesuré le même jour : une
 * collègue effacée le 19/09 se réinscrit sur Northwind Sports → aucun abonné, aucun e-mail, aucune trace.
 *
 * ⛔ POURQUOI CE BANC LIT LA SOURCE. La route d'inscription n'a aucun banc (voir `write-policy.ts`).
 * Le gestionnaire du clic de confirmation en a un depuis le 24/09/2026 (`confirm/handler.test.ts`),
 * mais ce qui se tient ici est d'une autre nature : QUELLE vérification est appelée et DANS QUEL
 * ORDRE.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { verificationSuppression } from "./reinscription";

/** Le code sans ses commentaires : ils citent `is_suppressed` pour l'expliquer. */
function codeSeul(chemin: string): string {
  return readFileSync(new URL(chemin, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n")
    .replace(/\s+/g, " ");
}

describe("inscription — quelle suppression bloque", () => {
  /** MUTATION QUI DOIT LE TUER : rendre toujours `is_suppressed` (plus personne ne revient). */
  test("le formulaire public et le popup de capture : seule la suppression DURE", () => {
    expect(verificationSuppression(false, undefined)).toBe("is_hard_suppressed");
    expect(verificationSuppression(true, "optinforge")).toBe("is_hard_suppressed");
  });

  /**
   * ⛔ « the address can never be re-added by an import » (admin). Un import ou un ajout manuel ne
   * rouvre JAMAIS la porte à une personne effacée — ni une synchro, ni un appelant anonyme.
   * MUTATION QUI DOIT LE TUER : rendre toujours `is_hard_suppressed`.
   */
  test("l'admin, une synchro, un appelant serveur sans origine : la suppression COMPLÈTE", () => {
    for (const origine of ["admin", "crm", undefined, null, "", "OPTINFORGE", { origin: "optinforge" }]) {
      expect(verificationSuppression(true, origine)).toBe("is_suppressed");
    }
  });

  /**
   * ⛔ Un contact (0088) ne reçoit jamais de clic de confirmation, donc personne ne lèverait une
   * suppression douce : elle doit le bloquer, même venu du popup.
   * MUTATION QUI DOIT LE TUER : retirer la branche `mode === "contact"`.
   */
  test("un contact hors newsletter : la suppression COMPLÈTE, quelle que soit l'origine", () => {
    for (const [pont, origine] of [[true, "optinforge"], [true, "admin"], [true, undefined], [false, undefined]] as const) {
      expect(verificationSuppression(pont, origine, "contact")).toBe("is_suppressed");
    }
    // Le défaut reste l'inscription : les appelants d'avant ne changent pas de vérification.
    expect(verificationSuppression(true, "optinforge", "subscribe")).toBe("is_hard_suppressed");
  });

  const route = codeSeul("../app/api/v1/signup/route.ts");

  /** MUTATION QUI DOIT LE TUER : revenir à `db.rpc("is_suppressed", …)` en dur. */
  test("la route demande la vérification à `verificationSuppression`, avec l'origine déclarée", () => {
    expect(route).toContain("db.rpc(verificationSuppression(serverIngest, body.source_detail?.origin, luMode.mode), {");
    expect(route).not.toContain('rpc("is_suppressed"');
    expect(route).not.toContain('rpc("is_hard_suppressed"');
  });

  test("⛔ son échec FERME toujours (la garde fail-closed n'a pas bougé)", () => {
    expect(route).toContain('if (supp.error) { const refus = suiteDe("suppression-check", supp.error); if (refus) return refus; }');
  });
});

describe("confirmation — le clic lève l'ancienne suppression", () => {
  /*
   * ⚠️ DEPUIS LE 24/09/2026, LA PAGE NE FAIT PLUS QUE MONTRER. Ouvrir `/confirm` ne confirme plus
   * rien (un scanneur de liens confirmait à la place de la personne) : le clic sur le bouton poste
   * vers `/api/v1/confirm`, dont le gestionnaire porte l'activation, la levée et le bienvenue. La
   * lecture de l'état (dont la souscription effacée) vit dans `lib/confirmation.ts`.
   */
  const page = codeSeul("../app/api/v1/confirm/handler.ts");
  const lecture = codeSeul("./confirmation.ts");
  const iActivation = page.indexOf('status: "active", consent_state: true');
  const iLevee = page.indexOf('db.rpc("lift_voluntary_suppression", {');
  const iBienvenue = page.indexOf('kind: "welcome"');

  /** MUTATION QUI DOIT LE TUER : supprimer l'appel. */
  test("le clic appelle `lift_voluntary_suppression` avec l'adresse, la marque et la souscription", () => {
    expect(iLevee).toBeGreaterThan(-1);
    expect(page).toContain("p_email: sub.email, p_asset_id: sub.asset_id, p_subscription_id: sub.id");
  });

  /**
   * ⛔ APRÈS L'ACTIVATION, AVANT LE BIENVENUE. Avant l'activation, elle lèverait pour un clic qui
   * n'aboutit pas ; après le bienvenue, celui-ci partirait vers une adresse encore supprimée — et
   * serait écarté pour de bon.
   * MUTATION QUI DOIT LE TUER : déplacer la levée sous la mise en file du bienvenue.
   */
  test("elle vient après l'activation et avant la mise en file du bienvenue", () => {
    expect(iActivation).toBeGreaterThan(-1);
    expect(iBienvenue).toBeGreaterThan(-1);
    expect(iActivation).toBeLessThan(iLevee);
    expect(iLevee).toBeLessThan(iBienvenue);
  });

  test("son échec se journalise au lieu de passer en silence", () => {
    expect(page).toContain('event: "confirm-suppression-lift-failed"');
  });

  /**
   * ⛔ Un vieux lien d'une souscription EFFACÉE ne la rallume pas.
   * MUTATION QUI DOIT LE TUER : retirer la garde `deleted`.
   */
  test("une souscription effacée est refusée AVANT toute activation", () => {
    expect(lecture).toContain('if (sub.status === "deleted") return { etat: "efface", sub };');
    const iEffacee = page.indexOf('lu.etat === "efface"');
    expect(iEffacee).toBeGreaterThan(-1);
    expect(iEffacee).toBeLessThan(iActivation);
  });
});
