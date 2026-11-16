/**
 * LA VANNE DU PASSAGE — `debit.ts`, et son câblage dans la boucle de drain.
 *
 * ⛔ CE QUE CES TESTS EXISTENT POUR EMPÊCHER. La boucle de drain s'écrivait
 * `do { drainOnceLive() } while (n > 0)` : elle rappelait la réclamation jusqu'à épuisement de la
 * file. `BATCH_SIZE=10` ne bornait rien — dix lignes par lot, mille lots, dix mille envois dans le
 * même tick de cron. Décision d'Alix du 15/09/2026 : « jveux jamais de liste stocké qui s'envoi
 * apres c'est le milleur moyen d'avoir un probleme qui balance d'un coup 10000 maisl ».
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  FENETRE_DEBIT_MS,
  fenetreCourante,
  lignesAReclamer,
  MAX_INTERACTIFS_PAR_FENETRE_DEFAUT,
  MAX_PAR_PASSAGE_DEFAUT,
  type FenetreDebit,
} from "./debit";

describe("debit — combien un passage s'autorise à réclamer", () => {
  test("loin du plafond, on réclame un lot plein", () => {
    expect(lignesAReclamer(0, 10, 50)).toBe(10);
    expect(lignesAReclamer(30, 10, 50)).toBe(10);
  });

  test("⛔ près du plafond, on réclame LE RESTE — pas un lot plein", () => {
    // C'est ici que le plafond devient une borne plutôt qu'un vœu : le dernier lot est tronqué,
    // donc le total réclamé ne peut JAMAIS dépasser le plafond.
    expect(lignesAReclamer(45, 10, 50)).toBe(5);
    expect(lignesAReclamer(49, 10, 50)).toBe(1);
  });

  test("au plafond, et au-delà, on ne réclame plus rien", () => {
    expect(lignesAReclamer(50, 10, 50)).toBe(0);
    // Au-delà ne devrait pas arriver, mais un compteur qui dépasse ne doit pas rouvrir la vanne.
    expect(lignesAReclamer(51, 10, 50)).toBe(0);
    expect(lignesAReclamer(10_000, 10, 50)).toBe(0);
  });

  test("⛔ FAIL-CLOSED sur l'absurde : une valeur inintelligible ne vaut pas « pas de limite »", () => {
    // Le schéma d'`env.ts` refuse déjà ces valeurs au boot. Cette borne existe pour que la
    // fonction soit sûre SEULE, sans dépendre de ce que son appelant a validé — c'est la
    // différence entre une garde et une convention.
    for (const plafond of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(lignesAReclamer(0, 10, plafond)).toBe(0);
    }
    for (const lot of [0, -5, Number.NaN]) {
      expect(lignesAReclamer(0, lot, 50)).toBe(0);
    }
    expect(lignesAReclamer(-1, 10, 50)).toBe(0);
    expect(lignesAReclamer(Number.NaN, 10, 50)).toBe(0);
  });

  test("⛔ le défaut PROTÈGE au lieu de convenir", () => {
    // Même doctrine que `WORKER_MODE=dry-run` par défaut : remonter ce nombre est un geste
    // conscient ; l'oublier ne peut pas nuire. Un défaut à quelques milliers rendrait le plafond
    // décoratif le jour de la bascule, qui est précisément le jour où il doit mordre.
    expect(MAX_PAR_PASSAGE_DEFAUT).toBeLessThanOrEqual(100);
    expect(MAX_PAR_PASSAGE_DEFAUT).toBeGreaterThan(0);
  });

  test("⭐⛔ dix mille lignes en file ne sortent PAS en un passage", () => {
    /**
     * Le test qui porte la décision. On rejoue la boucle de drain telle qu'elle est écrite dans
     * `index.ts` — un lot, puis on redemande tant qu'il rend des lignes — contre une file de dix
     * mille. Avant le plafond, ce scénario vidait la file entière dans un seul tick.
     */
    const PLAFOND = MAX_PAR_PASSAGE_DEFAUT;
    let enFile = 10_000;
    let reclamees = 0;
    let lots = 0;
    for (;;) {
      const aReclamer = lignesAReclamer(reclamees, 10, PLAFOND);
      if (aReclamer === 0) break;
      const rendu = Math.min(aReclamer, enFile);
      if (rendu === 0) break;
      enFile -= rendu;
      reclamees += rendu;
      lots++;
      expect(lots).toBeLessThan(10_000); // garde anti-boucle infinie : le test doit finir, ou échouer
    }
    expect(reclamees).toBe(PLAFOND);
    expect(enFile).toBe(10_000 - PLAFOND);
  });

  test("une file plus petite que le plafond sort entièrement, sans attendre", () => {
    // Le plafond ne doit pas retarder le cas normal : huit lignes en file partent dans le passage.
    let enFile = 8;
    let reclamees = 0;
    for (;;) {
      const aReclamer = lignesAReclamer(reclamees, 10, MAX_PAR_PASSAGE_DEFAUT);
      const rendu = Math.min(aReclamer, enFile);
      if (rendu === 0) break;
      enFile -= rendu;
      reclamees += rendu;
    }
    expect(reclamees).toBe(8);
    expect(enFile).toBe(0);
  });
});

/**
 * ⛔ POURQUOI CE GARDE LIT LA SOURCE AU LIEU D'APPELER LE CODE.
 *
 * `index.ts` lance `main()` au chargement du module (`main().catch(…)`, dernière ligne) : l'importer
 * DÉMARRERAIT le worker depuis la suite de tests. Le comportement de la boucle est donc
 * inatteignable, et la source est le seul endroit où le câblage peut être gardé.
 *
 * ⛔ CE GARDE NE CITE DONC PAS L'APPEL, IL TIENT UNE ABSENCE ET UN ORDRE. Un motif qui décrirait
 * l'appel entier rougirait au premier reformatage sans qu'aucune propriété n'ait bougé.
 */
describe("debit — le câblage dans la boucle de drain", () => {
  /** Le fichier SANS ses commentaires : ils citent `cfg.batchSize` et `db.claim(` pour les
   *  expliquer, et un comptage qui les inclut mesure la prose au lieu du code. */
  const codeSeul = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");

  test("⛔ ABSENCE — `cfg.batchSize` n'est plus ce qu'on réclame", () => {
    // Le défaut d'origine, exactement : `db.claim(cfg.workerId, cfg.batchSize, …)`. Tant que cette
    // forme subsiste, chaque lot repart pour un lot plein et le plafond ne borne rien.
    expect(/db\.claim\([^)]*cfg\.batchSize/.test(codeSeul)).toBe(false);
  });

  test("⛔ ce qu'on réclame vient du plafond, et les TROIS passes le demandent", () => {
    // Trois sites de drain : la passe `RUN_ONCE` (repli, cron */5), et dans la boucle résidente la
    // passe des interactifs (0073) puis celle des newsletters. En oublier une laisserait un chemin
    // non borné — le seul qui serve, peut-être.
    expect((codeSeul.match(/lignesAReclamer\(/g) ?? []).length).toBe(3);
    expect((codeSeul.match(/drainOnceLive\(db, cfg, mailgun, aReclamer\)/g) ?? []).length).toBe(2);
    expect((codeSeul.match(/drainOnceLive\(db, cfg, mailgun, aReclamerInteractifs, "interactifs"\)/g) ?? []).length).toBe(1);
  });

  test("⛔ ORDRE — on demande le plafond AVANT de réclamer, dans chacune des trois passes", () => {
    // L'inverse serait un plafond consulté après coup : il compterait les envois déjà partis.
    const morceaux = codeSeul.split("lignesAReclamer(");
    expect(morceaux.length).toBe(4); // 1 préambule + 3 appels
    const attendus: Array<[string, string]> = [
      ["aReclamer === 0", "drainOnceLive(db, cfg, mailgun, aReclamer)"],
      ["aReclamerInteractifs === 0", 'drainOnceLive(db, cfg, mailgun, aReclamerInteractifs, "interactifs")'],
      ["aReclamer === 0", "drainOnceLive(db, cfg, mailgun, aReclamer)"],
    ];
    morceaux.slice(1).forEach((apres, i) => {
      const [plafondNul, reclame] = attendus[i]!;
      const iPlafondNul = apres.indexOf(plafondNul);
      const iReclame = apres.indexOf(reclame);
      expect(iPlafondNul).toBeGreaterThan(-1);
      expect(iReclame).toBeGreaterThan(-1);
      expect(iPlafondNul).toBeLessThan(iReclame);
    });
  });

  /**
   * ⛔ LA BOUCLE RÉSIDENTE COMPTE PAR FENÊTRE, ET LA FENÊTRE EST PRISE AVANT LE PLAFOND.
   * MUTATION QUI DOIT LE TUER : rendre au résident son compteur « à vie » (`lignesAReclamer(reclamees,
   * …)`) — le service permanent s'arrêterait au 51e envoi de sa vie.
   */
  test("⛔ le résident demande le plafond sur le compteur de la FENÊTRE courante", () => {
    const resident = codeSeul.split("lignesAReclamer(")[3] ?? "";
    expect(resident.startsWith("fenetre.reclamees,")).toBe(true);
    const avant = codeSeul.split("lignesAReclamer(").slice(0, 3).join("lignesAReclamer(");
    expect(avant.lastIndexOf("fenetre = fenetreCourante(fenetre, Date.now(), FENETRE_DEBIT_MS)")).toBeGreaterThan(-1);
  });

  /**
   * ⛔ LE FAN-OUT DU RÉSIDENT NE PREND QUE LES OPTIONS « IMMÉDIATES » (avance forcée à zéro).
   * MUTATION QUI DOIT LE TUER : lui passer l'avance de l'environnement — il enfilerait, donc
   * enverrait, avant l'heure, à chaque passage de cinq secondes.
   */
  test("⛔ le fan-out du résident est appelé avec `optionsFanoutInstantane`, et rien d'autre", () => {
    const appels = codeSeul.match(/runFanout\([^)]*\)/g) ?? [];
    expect(appels.length).toBe(2);
    expect(appels.filter((a) => a.includes("instantane"))).toEqual(["runFanout(fanoutDb, { ...instantane })"]);
    expect(codeSeul).toContain("const instantane = optionsFanoutInstantane(process.env);");
  });
});

/**
 * ⭐ LES E-MAILS INTERACTIFS NE PATIENTENT PLUS DERRIÈRE LES NEWSLETTERS (0073, 22/09/2026 — Alix :
 * « tout les mails de type welcome etc soit instant les 5min d'attente ca doit etre que pour les
 * newsletter »). Même méthode que ci-dessus : `index.ts` ne s'importe pas, on tient le câblage.
 */
describe("debit — la passe des e-mails interactifs", () => {
  const codeSeul = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
  /** Espaces écrasés : un reformatage ne doit rien faire rougir. */
  const plat = codeSeul.replace(/\s+/g, " ");

  /**
   * ⛔ AVANT LE PLAFOND DES NEWSLETTERS. Placée après, la branche « plafond atteint » (`continue`) la
   * sauterait pendant toute une campagne — le défaut qu'on corrige.
   * MUTATION QUI DOIT LE TUER : déplacer la passe après `fenetre = fenetreCourante(fenetre, …)`.
   */
  test("la passe interactive tourne AVANT la fenêtre des newsletters", () => {
    const iInteractifs = plat.indexOf('drainOnceLive(db, cfg, mailgun, aReclamerInteractifs, "interactifs")');
    const iNewsletters = plat.indexOf("fenetre = fenetreCourante(fenetre, Date.now(), FENETRE_DEBIT_MS)");
    expect(iInteractifs).toBeGreaterThan(-1);
    expect(iNewsletters).toBeGreaterThan(-1);
    expect(iInteractifs).toBeLessThan(iNewsletters);
  });

  /** MUTATION QUI DOIT LE TUER : `cfg.maxPerRun` à la place — le plafond des newsletters. */
  test("elle a SON plafond, sur SA fenêtre", () => {
    expect(plat).toContain(
      "lignesAReclamer( fenetreInteractifs.reclamees, cfg.batchSize, cfg.maxInteractivePerWindow, )",
    );
    expect(plat).toContain("fenetreInteractifs = fenetreCourante(fenetreInteractifs, Date.now(), FENETRE_DEBIT_MS)");
  });

  /**
   * ⛔ CE QU'ELLE RÉCLAME N'ENTRE PAS DANS LA FENÊTRE DES NEWSLETTERS, et inversement.
   * MUTATION QUI DOIT LE TUER : `fenetre.reclamees + n + nInteractifs`.
   */
  test("les deux compteurs ne se mélangent pas", () => {
    expect(plat).toContain("reclamees: fenetreInteractifs.reclamees + nInteractifs");
    expect(plat).toContain("fenetre = { debut: fenetre.debut, reclamees: fenetre.reclamees + n }");
    expect(/fenetre\.reclamees \+[^}]*nInteractifs/.test(plat)).toBe(false);
    expect(/fenetreInteractifs\.reclamees \+ n\b(?!Interactifs)/.test(plat)).toBe(false);
  });

  /** MUTATION QUI DOIT LE TUER : la branche `interactifs` appelle `db.claim(` — toute la file. */
  test("la file « interactifs » passe par `claim_outbox_interactive`, jamais par la file commune", () => {
    expect(plat).toContain('file === "interactifs" ? await db.claimInteractive(cfg.workerId, aReclamer, cfg.staleLockSeconds)');
    expect(/db\.claimInteractive\([^)]*cfg\.batchSize/.test(plat)).toBe(false);
  });
});

describe("debit — le plafond des interactifs", () => {
  test("⛔ le défaut borne une rafale sans gêner l'usage réel", () => {
    // Usage mesuré : 7 confirmations du 18 au 22/09. Le plafond est là pour un robot, pas pour eux.
    expect(MAX_INTERACTIFS_PAR_FENETRE_DEFAUT).toBeGreaterThan(MAX_PAR_PASSAGE_DEFAUT);
    expect(MAX_INTERACTIFS_PAR_FENETRE_DEFAUT).toBeLessThanOrEqual(500);
  });

  test("dix mille inscriptions de robot ne partent pas en une heure", () => {
    let enFile = 10_000;
    let f: FenetreDebit | null = null;
    const T0 = Date.parse("2026-09-22T12:00:00Z");
    for (let t = T0; t < T0 + 60 * 60_000; t += 5_000) {
      f = fenetreCourante(f, t, FENETRE_DEBIT_MS);
      const rendu = Math.min(lignesAReclamer(f.reclamees, 10, MAX_INTERACTIFS_PAR_FENETRE_DEFAUT), enFile);
      enFile -= rendu;
      f = { debut: f.debut, reclamees: f.reclamees + rendu };
    }
    expect(10_000 - enFile).toBe(12 * MAX_INTERACTIFS_PAR_FENETRE_DEFAUT);
  });
});

describe("debit — la fenêtre du service résident", () => {
  const CINQ_MIN = 5 * 60_000;
  const T0 = Date.parse("2026-09-22T12:00:00Z");

  test("la première fenêtre s'ouvre à zéro", () => {
    expect(fenetreCourante(null, T0, CINQ_MIN)).toEqual({ debut: T0, reclamees: 0 });
  });

  test("dans la fenêtre, le compteur est conservé", () => {
    const f = { debut: T0, reclamees: 50 };
    expect(fenetreCourante(f, T0 + CINQ_MIN - 1, CINQ_MIN)).toBe(f);
  });

  /** MUTATION QUI DOIT LE TUER : ne jamais rouvrir (`>= dureeMs` → `false`) — le résident mourrait. */
  test("la fenêtre écoulée repart d'un compteur neuf", () => {
    expect(fenetreCourante({ debut: T0, reclamees: 50 }, T0 + CINQ_MIN, CINQ_MIN)).toEqual({
      debut: T0 + CINQ_MIN,
      reclamees: 0,
    });
  });

  /** ⛔ Un saut d'horloge en arrière ne remet pas le compteur à zéro. */
  test("une horloge qui recule ne rouvre pas la fenêtre", () => {
    const f = { debut: T0, reclamees: 50 };
    expect(fenetreCourante(f, T0 - 10 * CINQ_MIN, CINQ_MIN)).toBe(f);
  });

  test("une durée absurde ne rouvre jamais (repli sur le plafond à vie)", () => {
    const f = { debut: T0, reclamees: 50 };
    for (const d of [0, -1, Number.NaN]) expect(fenetreCourante(f, T0 + 100 * CINQ_MIN, d)).toBe(f);
  });

  /**
   * ⭐ LE DÉBIT NE BOUGE PAS : sur une file de dix mille lignes, le résident ne réclame jamais plus
   * que le plafond dans une même fenêtre — exactement le cron de cinq minutes qu'il remplace.
   */
  test("sur une heure simulée, jamais plus de MAX_PAR_PASSAGE_DEFAUT réclamations par fenêtre", () => {
    let enFile = 10_000;
    let fenetre: FenetreDebit | null = null;
    const parFenetre = new Map<number, number>();
    for (let t = T0; t < T0 + 60 * 60_000; t += 5_000) {
      fenetre = fenetreCourante(fenetre, t, CINQ_MIN);
      const aReclamer = lignesAReclamer(fenetre.reclamees, 10, MAX_PAR_PASSAGE_DEFAUT);
      const rendu = Math.min(aReclamer, enFile);
      enFile -= rendu;
      fenetre = { debut: fenetre.debut, reclamees: fenetre.reclamees + rendu };
      parFenetre.set(fenetre.debut, fenetre.reclamees);
    }
    expect(parFenetre.size).toBe(12);
    for (const n of parFenetre.values()) expect(n).toBe(MAX_PAR_PASSAGE_DEFAUT);
    expect(10_000 - enFile).toBe(12 * MAX_PAR_PASSAGE_DEFAUT);
  });
});
