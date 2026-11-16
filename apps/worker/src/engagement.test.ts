import { describe, expect, test } from "bun:test";
import { runEngagement, engagementNeedsAlert, type EngagementDbLike, type EngagementReport } from "./engagement";

/**
 * ⛔ CE QUE CE BANC NE PROUVE PAS. Le CALCUL d'engagement est en SQL (`newsletter.recompute_engagement`,
 * 0056) et a été vérifié cas par cas contre la vraie base, en transaction annulée — un banc en
 * TypeScript ne peut pas le refaire, et prétendre le contraire donnerait une fausse garantie.
 *
 * Ce que ce banc prouve, c'est la couche qui l'entoure et qui, elle, est en TypeScript : le
 * périmètre passé à la RPC, la traduction des compteurs `snake_case` en rapport, et surtout le
 * PRÉDICAT D'ALERTE — qui est la seule chose de cette tâche capable de réveiller quelqu'un, donc la
 * seule qui puisse crier à tort ou se taire à tort.
 */

/** Un faux dépôt qui note ce qu'on lui a demandé et rend ce qu'on lui a dit de rendre. */
function fakeDb(
  ligne: Record<string, number>,
  sent = 0,
): EngagementDbLike & { vus: { assetId: string | null; dryRun: boolean }[]; sentAssetIds: (string | null)[] } {
  const vus: { assetId: string | null; dryRun: boolean }[] = [];
  const sentAssetIds: (string | null)[] = [];
  return {
    vus,
    sentAssetIds,
    async recompute(assetId, dryRun) {
      vus.push({ assetId, dryRun });
      return ligne;
    },
    async countSentEmails(assetId) {
      sentAssetIds.push(assetId);
      return sent;
    },
  };
}

const LIGNE = {
  scanned: 1203,
  changed: 12,
  lvl_active: 900,
  lvl_dormant: 200,
  lvl_churned: 103,
  without_events: 40,
};

describe("runEngagement", () => {
  test("traduit les compteurs snake_case de la fonction SQL sans en perdre un", () => {
    // Un champ oublié ici serait rendu 0 par le `?? 0` du code : le rapport aurait l'air complet et
    // dirait « rien n'a changé » sur une passe qui a tout changé.
    return runEngagement(fakeDb(LIGNE, 7)).then((r) => {
      expect(r).toEqual({
        scanned: 1203,
        changed: 12,
        active: 900,
        dormant: 200,
        churned: 103,
        withoutEvents: 40,
        sentEmails: 7,
        dryRun: false,
      });
    });
  });

  test("le mode par défaut ÉCRIT : `dryRun` ne s'active que si on le demande", () => {
    // ⛔ L'inverse serait pire qu'inutile : un job qui ne recalcule jamais rien pendant que son
    // journal annonce des passes réussies.
    return runEngagement(fakeDb(LIGNE)).then((r) => {
      expect(r.dryRun).toBe(false);
    });
  });

  test("le périmètre demandé est celui passé à la RPC — et le MÊME pour le compteur d'envois", () => {
    // ⚠️ Deux périmètres différents feraient dire au discriminant « des e-mails sont partis » alors
    // qu'aucun n'est parti pour la marque examinée : l'alerte accuserait une jointure saine.
    const db = fakeDb(LIGNE);
    return runEngagement(db, { assetId: "asset-1", dryRun: true }).then(() => {
      expect(db.vus).toEqual([{ assetId: "asset-1", dryRun: true }]);
      expect(db.sentAssetIds).toEqual(["asset-1"]);
    });
  });

  test("sans périmètre, on passe `null` — jamais `undefined`", () => {
    // `undefined` traverserait PostgREST comme un paramètre ABSENT : la RPC prendrait son défaut.
    // Ici les deux valent « toutes les marques », mais compter sur cette coïncidence est fragile.
    const db = fakeDb(LIGNE);
    return runEngagement(db).then(() => {
      expect(db.vus[0].assetId).toBeNull();
      expect(db.sentAssetIds[0]).toBeNull();
    });
  });

  test("une fonction SQL qui ne rend rien donne des zéros, pas des NaN", () => {
    // PostgREST rend `[]` si la fonction ne renvoie aucune ligne. Un `NaN` remonterait jusqu'au
    // journal et jusqu'au prédicat d'alerte, où toute comparaison est fausse — donc silence total.
    return runEngagement(fakeDb({})).then((r) => {
      expect(r.scanned).toBe(0);
      expect(Number.isNaN(r.scanned)).toBe(false);
      expect(r.withoutEvents).toBe(0);
    });
  });
});

function rapport(p: Partial<EngagementReport>): EngagementReport {
  return {
    scanned: 0,
    changed: 0,
    active: 0,
    dormant: 0,
    churned: 0,
    withoutEvents: 0,
    sentEmails: 0,
    dryRun: false,
    ...p,
  };
}

describe("engagementNeedsAlert", () => {
  test("des e-mails partis et AUCUN événement : on alerte", () => {
    // La signature exacte d'une jointure `provider_message_id` cassée : l'envoi marche, les retours
    // ne se rattachent à personne, et l'engagement affiché vaudra zéro pour tout le monde.
    expect(engagementNeedsAlert(rapport({ scanned: 500, withoutEvents: 500, sentEmails: 1200 }))).toBe(true);
  });

  test("AUCUN e-mail parti : on se tait, même si personne n'a d'événement", () => {
    // ⛔ C'est l'état réel de la base au 08/09/2026 (0 e-mail jamais envoyé). Alerter ici, ce serait
    // crier tous les soirs sur un état sain — et l'alerte serait coupée bien avant de servir.
    expect(engagementNeedsAlert(rapport({ scanned: 1203, withoutEvents: 1203, sentEmails: 0 }))).toBe(false);
  });

  test("un seul abonnement avec des événements suffit à innocenter la jointure", () => {
    // Si la jointure était cassée, elle le serait pour tout le monde : un seul rattachement réussi
    // prouve que le chemin fonctionne, et l'alerte n'aurait plus rien à dire.
    expect(engagementNeedsAlert(rapport({ scanned: 500, withoutEvents: 499, sentEmails: 1200 }))).toBe(false);
  });

  test("un périmètre VIDE ne déclenche rien", () => {
    // ⚠️ Sans la garde `scanned > 0`, `0 === 0` serait vrai et l'alerte partirait sur une base sans
    // le moindre abonné à recalculer.
    expect(engagementNeedsAlert(rapport({ scanned: 0, withoutEvents: 0, sentEmails: 1200 }))).toBe(false);
  });

  test("le mode simulation alerte comme le mode réel", () => {
    // Le défaut qu'on cherche existe indépendamment de l'écriture : le taire en simulation ferait
    // du mode « voir sans écrire » un mode « voir moins ».
    expect(engagementNeedsAlert(rapport({ scanned: 500, withoutEvents: 500, sentEmails: 1200, dryRun: true }))).toBe(true);
  });
});
