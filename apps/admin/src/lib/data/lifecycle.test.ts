import { describe, expect, test } from "bun:test";
import { totalReengagement, type ReengagementRow } from "./lifecycle";

/**
 * ⛔ CE QUE CE BANC EXISTE POUR EMPÊCHER. Un écran de réengagement se trompe toujours dans le même
 * sens : il affiche « 0 % de réponses » là où il faudrait lire « rien n'est parti ». Les deux
 * phrases mènent à des décisions opposées — arrêter la séquence, ou aller réparer la file — et
 * elles s'affichent pareil dès qu'on divise sans regarder le dénominateur.
 */

const ligne = (p: Partial<ReengagementRow>): ReengagementRow => ({
  assetId: "a1", assetSlug: "quartz-tips", step: 1,
  enqueued: 0, delivered: 0, responded: 0, opened: 0, clicked: 0,
  unsubscribed: 0, complained: 0, bounced: 0,
  firstSentAt: null, lastSentAt: null, orphanEvents: 0, ...p,
});

describe("totalReengagement — les taux", () => {
  test("⛔ sans aucune remise, les taux sont `null`, JAMAIS zéro", () => {
    // 500 relances coincées dans la file : il n'y a rien à juger. Un « 0 % » ici condamnerait une
    // mécanique qui n'a jamais tourné.
    const t = totalReengagement([ligne({ enqueued: 500, delivered: 0 })]);
    expect(t.responseRate).toBeNull();
    expect(t.costRate).toBeNull();
  });

  test("le dénominateur est `delivered`, pas `enqueued`", () => {
    const t = totalReengagement([ligne({ enqueued: 1000, delivered: 100, responded: 12 })]);
    expect(t.responseRate).toBe(0.12);
  });

  test("le coût additionne désabonnements ET plaintes, jamais les rebonds", () => {
    // Un rebond est une adresse morte : il ne dit rien du bien-fondé de la relance, et le compter
    // ferait passer une liste vieillie pour une liste maltraitée.
    const t = totalReengagement([ligne({ delivered: 100, unsubscribed: 3, complained: 1, bounced: 40 })]);
    expect(t.costRate).toBe(0.04);
  });

  test("plusieurs pas s'additionnent", () => {
    const t = totalReengagement([
      ligne({ step: 1, delivered: 100, responded: 10 }),
      ligne({ step: 2, delivered: 50, responded: 2 }),
    ]);
    expect(t.delivered).toBe(150);
    expect(t.responded).toBe(12);
  });
});

describe("totalReengagement — le discriminant", () => {
  test("⛔ les orphelins ne s'ADDITIONNENT pas : on garde le plus grand", () => {
    // La vue ajoute à CHAQUE ligne les événements sans marque. Les sommer les compterait une fois
    // par pas, et un compteur de panne qui exagère finit par être ignoré comme le reste.
    const t = totalReengagement([
      ligne({ step: 1, orphanEvents: 2 }),
      ligne({ step: 2, orphanEvents: 2 }),
    ]);
    expect(t.orphanEvents).toBe(2);
  });

  test("aucune ligne du tout ⇒ zéro orphelin et des taux nuls", () => {
    const t = totalReengagement([]);
    expect(t.orphanEvents).toBe(0);
    expect(t.responseRate).toBeNull();
  });
});
