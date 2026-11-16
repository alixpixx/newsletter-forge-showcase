import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import {
  reactiverRevenants,
  runLifecycle,
  lifecycleNeedsAlert,
  vaguesCouteuses,
  type LifecycleDbLike,
  type LifecycleReport,
  type LigneResultat,
} from "./lifecycle";

/**
 * La passe `lifecycle` N'ENFILE PLUS (24/09/2026) : la relance des inactifs est l'automation
 * « Re-engagement » du moteur. Il lui reste la réactivation des sunsets (que `plan` fait aussi à
 * chaque passe) et la mesure des vagues déjà parties.
 */

/** Le code seul, sans commentaires : un commentaire qui cite une RPC ne l'appelle pas. */
function codeSeul(chemin: URL): string {
  return readFileSync(chemin, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
}

/** Tous les fichiers de code du worker (tests exclus), sous-dossiers compris. */
function sourcesDuWorker(): { nom: string; code: string }[] {
  const racine = new URL("./", import.meta.url);
  return (readdirSync(racine, { recursive: true }) as string[])
    .map((n) => n.replace(/\\/g, "/"))
    .filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))
    .map((nom) => ({ nom, code: codeSeul(new URL(nom, racine)) }));
}

function fakeDb(
  reactivated = 0,
  resultats: LigneResultat[] = [],
): LifecycleDbLike & {
  reactivations: { assetId: string | null; dryRun: boolean }[];
  /** L'ordre des gestes, avec leur périmètre. */
  ordre: string[];
} {
  const reactivations: { assetId: string | null; dryRun: boolean }[] = [];
  const ordre: string[] = [];
  return {
    reactivations,
    ordre,
    async reactivate(assetId, dryRun) {
      ordre.push(`reactivate:${assetId}`);
      reactivations.push({ assetId, dryRun });
      return { candidates: reactivated, reactivated: dryRun ? 0 : reactivated };
    },
    async syncOutcomes(assetId, dryRun) {
      ordre.push(dryRun ? `sync:dry:${assetId}` : `sync:${assetId}`);
      return { candidates: resultats.length, updated: resultats.length };
    },
    async outcomes(assetId) {
      ordre.push(`outcomes:${assetId}`);
      return resultats;
    },
  };
}

describe("runLifecycle — la relance de masse est RETIRÉE", () => {
  /*
   * ⛔ LE GARDE. La relance vit désormais dans le moteur (automation « Re-engagement »). Si un code du
   * worker rappelait `enqueue_reengagement_batch`, deux relances écriraient aux mêmes inactifs — et
   * `LIFECYCLE_ENABLED=1` redeviendrait un interrupteur d'envoi de masse.
   * MUTATION QUI DOIT LE TUER : remettre un `rpc("enqueue_reengagement_batch", …)` n'importe où.
   */
  test("⛔ aucun code du worker n'appelle plus la RPC d'enfilement de la relance", () => {
    const sources = sourcesDuWorker();
    expect(sources.some((f) => f.nom === "lifecycle.ts") && sources.some((f) => f.nom === "automations/engine.ts")).toBe(true);
    expect(sources.filter((f) => f.code.includes("enqueue_reengagement_batch")).map((f) => f.nom)).toEqual([]);
  });

  test("⛔ `LIFECYCLE_ENABLED` n'est lue que pour être signalée, jamais obéie", () => {
    const index = codeSeul(new URL("./index.ts", import.meta.url));
    const lectures = index.match(/process\.env\.LIFECYCLE_ENABLED[^\n]*/g) ?? [];
    expect(lectures).toEqual([`process.env.LIFECYCLE_ENABLED ?? "").trim() !== "") {`]);
    expect(index).toContain('log("lifecycle-enabled-ignored"');
  });

  test("la passe réactive, synchronise puis mesure — et rien d'autre", async () => {
    const db = fakeDb();
    await runLifecycle(db, {});
    expect(db.ordre).toEqual(["reactivate:null", "sync:null", "outcomes:null"]);
  });

  test("`assetId` : les trois gestes suivent le MÊME périmètre", async () => {
    const db = fakeDb();
    await runLifecycle(db, { assetId: "a2" });
    expect(db.ordre).toEqual(["reactivate:a2", "sync:a2", "outcomes:a2"]);
  });
});

describe("reactiverRevenants — sortir du sunset ceux qui ont réagi après leur marque", () => {
  test("un appel, périmètre et simulation transmis tels quels ; les comptes remontent", async () => {
    const db = fakeDb(7);
    expect(await reactiverRevenants(db, "a1", true)).toEqual({ candidates: 7, reactivated: 0 });
    expect(await reactiverRevenants(db, null, false)).toEqual({ candidates: 7, reactivated: 7 });
    expect(db.reactivations).toEqual([
      { assetId: "a1", dryRun: true },
      { assetId: null, dryRun: false },
    ]);
  });

  test("⛔ la passe `lifecycle` réactive POUR DE VRAI : ne pas réactiver n'est pas une précaution", async () => {
    const db = fakeDb(7);
    const r = await runLifecycle(db, {});
    expect(db.reactivations).toEqual([{ assetId: null, dryRun: false }]);
    expect(r.reactivated).toBe(7);
  });
});

/**
 * ⭐ LA TÂCHE `plan` RÉACTIVE À CHAQUE PASSE (la tâche `lifecycle` n'a jamais eu de cron). Même
 * méthode que `debit.test.ts` : `index.ts` ne s'importe pas, on tient le câblage.
 * MUTATIONS QUI DOIVENT LE TUER : retirer l'appel ; le placer après le moteur ; le doubler ; passer
 * autre chose que la simulation de `plan` ; laisser une panne faire échouer `plan`.
 */
describe("plan — la réactivation des sunsets", () => {
  const plat = codeSeul(new URL("./index.ts", import.meta.url)).replace(/\s+/g, " ");
  const corps = (nom: string) => {
    const i = plat.indexOf(`async function ${nom}(`);
    const j = plat.indexOf("async function ", i + 1);
    return i < 0 ? "" : plat.slice(i, j < 0 ? undefined : j);
  };

  test("UNE fois par passe, AVANT le moteur, avec la simulation de `plan`", () => {
    const plan = corps("runPlanTask");
    expect(plan.match(/runReactivationPass\(/g)?.length ?? 0).toBe(1);
    expect(plan.indexOf("await runReactivationPass(cfg, simulate);")).toBeGreaterThan(-1);
    expect(plan.indexOf("await runReactivationPass(cfg, simulate);")).toBeLessThan(plan.indexOf("await runAutomationsPass(cfg, simulate);"));
  });

  test("toute la base, et une panne est rattrapée : elle ne fait échouer ni `plan` ni le moteur", () => {
    const passe = corps("runReactivationPass");
    expect(passe).toContain("try { await reactiverRevenants(new LifecycleDb(cfg), null, simulate); } catch (e) {");
    expect(passe).not.toContain("throw");
    expect(passe).not.toContain("process.exit");
  });
});

describe("runLifecycle — la mesure des vagues déjà parties", () => {
  test("les compteurs de résultat remontent au rapport", async () => {
    const db = fakeDb(0, [
      { asset_slug: "a", delivered: 100, responded: 12, unsubscribed: 3, complained: 1, orphan_events: 2 },
      { asset_slug: "b", delivered: 40, responded: 5, unsubscribed: 1, complained: 0, orphan_events: 2 },
    ]);
    const r = await runLifecycle(db, {});
    expect(r.delivered).toBe(140);
    expect(r.responded).toBe(17);
    expect(r.unsubscribed).toBe(4);
    // ⛔ Les orphelins ne s'ADDITIONNENT pas : la vue ajoute à chaque marque les événements sans
    // marque, donc les sommer les compterait autant de fois qu'il y a de lignes. On garde le plus
    // grand, qui suffit à dire que la mesure fuit.
    expect(r.orphanEvents).toBe(2);
  });
});

function rapport(p: Partial<LifecycleReport>): LifecycleReport {
  return {
    reactivated: 0, outcomesUpdated: 0, delivered: 0, responded: 0, unsubscribed: 0, complained: 0,
    orphanEvents: 0, costlyAssets: [], ...p,
  };
}

describe("lifecycleNeedsAlert", () => {
  test("⛔ une vague déjà partie qui a coûté plus qu'elle n'a rapporté ⇒ alerte", () => {
    expect(lifecycleNeedsAlert(rapport({ costlyAssets: ["quartz-tips"] }))).toBe(true);
  });

  test("sinon, silence — même avec des revenants réactivés", () => {
    expect(lifecycleNeedsAlert(rapport({ reactivated: 12, delivered: 300, responded: 40 }))).toBe(false);
  });
});

/**
 * ⛔ CE QUE CE BANC EXISTE POUR EMPÊCHER. Une relance ne se juge pas au nombre d'e-mails partis
 * mais à ce qu'ils ont provoqué — et le chiffre qui compte est le COÛT. Une vague qui désabonne
 * plus qu'elle ne réveille détruit une liste sans qu'une seule ligne n'échoue : la file se vide,
 * les journaux sont verts, et il ne reste plus personne à qui écrire.
 */
describe("vaguesCouteuses", () => {
  const ligne = (p: Partial<LigneResultat>): LigneResultat => ({
    asset_slug: "quartz-tips", enqueued: 0, delivered: 0, responded: 0,
    unsubscribed: 0, complained: 0, bounced: 0, orphan_events: 0, ...p,
  });

  test("plus de refus que de réactions ⇒ la marque est signalée", () => {
    expect(vaguesCouteuses([ligne({ delivered: 100, responded: 3, unsubscribed: 9 })])).toEqual(["quartz-tips"]);
  });

  test("les PLAINTES comptent dans le coût, les REBONDS non", () => {
    // Une plainte est un refus, et c'est le pire qui soit pour la réputation d'envoi. Un rebond est
    // une adresse morte : il ne dit rien du message ni du bien-fondé de la relance.
    expect(vaguesCouteuses([ligne({ delivered: 100, responded: 2, unsubscribed: 1, complained: 3 })])).toHaveLength(1);
    expect(vaguesCouteuses([ligne({ delivered: 100, responded: 2, unsubscribed: 1, bounced: 40 })])).toHaveLength(0);
  });

  test("⛔ en dessous du plancher, on ne juge PAS", () => {
    // Trois délivrés et un désabonnement : le rapport est vrai et ne veut rien dire. Une alerte qui
    // se déclenche sur du bruit est coupée avant le jour où elle sert.
    expect(vaguesCouteuses([ligne({ delivered: 3, responded: 0, unsubscribed: 1 })])).toHaveLength(0);
    expect(vaguesCouteuses([ligne({ delivered: 20, responded: 0, unsubscribed: 1 })])).toHaveLength(1);
  });

  test("⛔ le dénominateur est `delivered`, jamais `enqueued`", () => {
    // 5 000 relances enfilées mais bloquées dans la file : rien n'est arrivé chez personne, il n'y
    // a donc rien à juger — même si d'anciens désabonnements traînent sur ces lignes. Compter les
    // enfilées ferait CRIER ici, c'est-à-dire exactement quand la file se bouche et que rien n'est
    // parti.
    expect(vaguesCouteuses([ligne({ enqueued: 5000, delivered: 0, responded: 0, unsubscribed: 9 })])).toHaveLength(0);
  });

  test("à égalité, on ne crie pas", () => {
    expect(vaguesCouteuses([ligne({ delivered: 50, responded: 4, unsubscribed: 4 })])).toHaveLength(0);
  });

  test("chaque marque est jugée SÉPARÉMENT", () => {
    // ⛔ Additionner les marques laisserait une grosse liste saine masquer une petite qu'on détruit.
    const r = vaguesCouteuses([
      ligne({ asset_slug: "saine", delivered: 500, responded: 40, unsubscribed: 5 }),
      ligne({ asset_slug: "abimee", delivered: 40, responded: 0, unsubscribed: 6 }),
    ]);
    expect(r).toEqual(["abimee"]);
  });
});
