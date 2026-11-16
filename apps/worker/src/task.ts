/**
 * La TÂCHE, distincte du MODE.
 *
 * ⛔ `WORKER_MODE` (dry-run / live) décide si des emails PARTENT. La tâche décide de ce que le
 * processus fait de sa vie : drainer la file, planifier, remplir, recalculer l'engagement. Les
 * mélanger aurait fait du matérialiseur une option du chemin d'envoi — donc quelque chose qu'un
 * `WORKER_MODE=live` mal placé pourrait transformer en envoi. Ce sont des processus distincts, des
 * crons distincts, des responsabilités distinctes.
 *
 * `plan` et `engagement` n'ouvrent jamais Mailgun et n'instancient même pas le client qui sait
 * écrire dans l'outbox.
 *
 * ⛔ POURQUOI CE MODULE EXISTE PLUTÔT QUE DE VIVRE DANS `index.ts`. `index.ts` appelle `main()` au
 * chargement : l'importer depuis un banc lancerait le worker pour de vrai. La seule fonction qui
 * décide ce que fait le service était donc INTESTABLE, et elle l'est restée jusqu'ici — alors
 * qu'une erreur dedans est exactement du genre qui rend un cron vert et improductif.
 */
export type Task = "drain" | "plan" | "enqueue" | "engagement" | "lifecycle";

/**
 * ⛔ LA LISTE BLANCHE ET LE TYPE, DÉRIVÉS L'UN DE L'AUTRE. Ils étaient écrits deux fois : ajouter
 * une tâche au type sans l'ajouter à la liste faisait refuser le démarrage du service, avec un
 * message parlant de trois valeurs alors que le code en connaissait quatre. Une seule source.
 */
export const TASKS: readonly Task[] = ["drain", "plan", "enqueue", "engagement", "lifecycle"];

export function parseTask(argv: readonly string[] = process.argv, env: NodeJS.ProcessEnv = process.env): Task {
  const raw = env.WORKER_TASK;
  const fromEnv = (raw ?? "").trim().toLowerCase();

  /*
   * ⛔ UNE VALEUR INCONNUE EST UNE ERREUR, PAS UN « drain ».
   *
   * Les tâches partagent le même dépôt, la même configuration de déploiement et la même commande de démarrage : ce qui
   * les distingue est CETTE SEULE VARIABLE, posée à la main dans le tableau de bord. Une faute de
   * frappe (`plann`, `Plan `, `PLAN_`) retombait donc silencieusement sur `drain` — le service
   * aurait tourné toutes les dix minutes, journalisé des passes réussies, et RIEN n'aurait jamais
   * été planifié. La panne aurait été invisible jusqu'à ce que quelqu'un remarque qu'aucune édition
   * ne part.
   *
   * ⚠️ L'ABSENCE reste `drain` : c'est la configuration du service existant, qui n'a pas de
   * `WORKER_TASK`. Seule une valeur POSÉE et inconnue est refusée — on distingue « non renseigné »
   * de « mal renseigné », parce que les deux ne veulent pas dire la même chose.
   */
  if (fromEnv !== "" && !(TASKS as readonly string[]).includes(fromEnv)) {
    throw new Error(
      `[boot] WORKER_TASK="${raw}" inconnu — attendu ${TASKS.join(" | ")}. ` +
        `Refus de démarrer : retomber sur « drain » ferait passer ce service pour vivant alors qu'il ` +
        `ne ferait pas son travail.`,
    );
  }

  // ⚠️ `enqueue` est testé EN PREMIER : c'est la précédence, pas un ordre de lecture. Un service
  // qui porte WORKER_TASK=plan ET l'argument --enqueue fera `enqueue`. Ne pas les mélanger.
  if (argv.includes("--enqueue") || fromEnv === "enqueue") return "enqueue";
  if (argv.includes("--plan") || fromEnv === "plan") return "plan";
  if (argv.includes("--engagement") || fromEnv === "engagement") return "engagement";
  if (argv.includes("--lifecycle") || fromEnv === "lifecycle") return "lifecycle";
  return "drain";
}
