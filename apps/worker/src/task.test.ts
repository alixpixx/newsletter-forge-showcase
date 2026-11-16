import { describe, expect, test } from "bun:test";
import { parseTask, TASKS } from "./task";

/**
 * ⛔ CE QUE CE BANC EXISTE POUR EMPÊCHER. `parseTask` est la SEULE chose qui décide ce que fait le
 * service : quatre déploiements partagent le même code et le même `startCommand`, et ne diffèrent
 * que par `WORKER_TASK`. Une erreur ici ne casse rien de visible — le processus démarre, journalise
 * des passes réussies, et fait le travail d'un autre. Elle n'avait aucun test jusqu'ici.
 */
const NO_ARGS: readonly string[] = ["bun", "index.ts"];

describe("parseTask", () => {
  test("l'ABSENCE de WORKER_TASK reste « drain »", () => {
    // C'est la configuration du service d'envoi existant, qui n'a jamais porté cette variable.
    // La changer arrêterait la file d'envoi en production sans qu'aucun réglage n'ait bougé.
    expect(parseTask(NO_ARGS, {})).toBe("drain");
    expect(parseTask(NO_ARGS, { WORKER_TASK: "" })).toBe("drain");
    expect(parseTask(NO_ARGS, { WORKER_TASK: "   " })).toBe("drain");
  });

  test("chaque tâche connue est reconnue par son nom", () => {
    for (const t of TASKS) {
      expect(parseTask(NO_ARGS, { WORKER_TASK: t })).toBe(t);
    }
  });

  test("la casse et les espaces autour ne changent pas la tâche", () => {
    expect(parseTask(NO_ARGS, { WORKER_TASK: "  ENGAGEMENT " })).toBe("engagement");
    expect(parseTask(NO_ARGS, { WORKER_TASK: "Plan" })).toBe("plan");
  });

  test("une valeur POSÉE et inconnue fait ÉCHOUER le démarrage", () => {
    // ⛔ Le cœur du banc. Une faute de frappe qui retomberait sur « drain » ferait passer le service
    // pour vivant alors qu'il ne planifierait plus rien, indéfiniment et sans une ligne de journal.
    for (const mauvais of ["plann", "PLAN_", "engagment", "recompute", "0"]) {
      expect(() => parseTask(NO_ARGS, { WORKER_TASK: mauvais })).toThrow(/inconnu/);
    }
  });

  test("le message d'erreur cite la valeur reçue TELLE QUELLE et la liste attendue", () => {
    // Une valeur normalisée dans le message enverrait chercher une faute de frappe invisible :
    // « Plan_ » affiché « plan_ » ne ressemble plus à ce qui est posé dans le tableau de bord.
    try {
      parseTask(NO_ARGS, { WORKER_TASK: " Plan_ " });
      throw new Error("aurait dû lever");
    } catch (e) {
      const m = (e as Error).message;
      expect(m).toContain(' Plan_ ');
      for (const t of TASKS) expect(m).toContain(t);
    }
  });

  test("les arguments de ligne de commande valent autant que la variable", () => {
    expect(parseTask(["bun", "index.ts", "--plan"], {})).toBe("plan");
    expect(parseTask(["bun", "index.ts", "--enqueue"], {})).toBe("enqueue");
    expect(parseTask(["bun", "index.ts", "--engagement"], {})).toBe("engagement");
  });

  test("`--enqueue` PRIME sur toute autre tâche demandée", () => {
    // Précédence documentée, pas un ordre de lecture : la fixer par un banc évite qu'un
    // réagencement des `if` change silencieusement ce que fait un service lancé avec les deux.
    expect(parseTask(["bun", "index.ts", "--enqueue"], { WORKER_TASK: "plan" })).toBe("enqueue");
    expect(parseTask(["bun", "index.ts", "--enqueue", "--plan"], {})).toBe("enqueue");
    expect(parseTask(["bun", "index.ts", "--plan"], { WORKER_TASK: "engagement" })).toBe("plan");
  });

  test("un argument qui CONTIENT le nom d'une tâche ne la déclenche pas", () => {
    // `includes` porte sur les éléments d'argv, pas sur la ligne de commande recomposée.
    expect(parseTask(["bun", "index.ts", "--plan-only"], {})).toBe("drain");
    expect(parseTask(["bun", "index.ts", "plan"], {})).toBe("drain");
  });
});
