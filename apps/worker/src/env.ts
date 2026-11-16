/**
 * Configuration du worker (zod). Défauts SÛRS : dry-run + sandbox + one-click off.
 * En mode `live`, des GARDES DE BOOT refusent de démarrer sur toute config qui pourrait
 * spammer de vrais abonnés (allowlist vide, clé Mailgun absente, TOKEN_SECRET par défaut).
 */
import { z } from "zod";
import { hostname } from "node:os";
/* ⛔ Le littéral du repli dev était RECOPIÉ ici. Deux copies de la même chaîne : le jour où l'une
   change, une des deux gardes cesse SILENCIEUSEMENT de reconnaître le secret de dev. Une seule
   source, celle que le site public compare aussi (`apps/public/src/lib/token-secret.ts`). */
import { DEV_TOKEN_SECRET, tokenSecretFingerprint } from "@nf/tokens";
import { MAX_INTERACTIFS_PAR_FENETRE_DEFAUT, MAX_PAR_PASSAGE_DEFAUT } from "./debit";

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null || v === "" ? def : /^(1|true|yes|on)$/i.test(v)));

const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null || v === "" ? def : Number(v)))
    .pipe(z.number().int().positive());

const schema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  TOKEN_SECRET: z.string().optional(),

  MAILGUN_API_KEY: z.string().optional(),
  MAILGUN_REGION: z.enum(["us", "eu"]).default("us"),
  MAILGUN_SANDBOX_DOMAIN: z.string().optional(),
  /*
   * ⛔ UNE PARTIE LOCALE, RIEN D'AUTRE. Le From est `<localpart>@<sous-domaine vérifié>` ; une valeur
   * porteuse d'un `@` ou d'un chevron glisserait un second domaine dans l'adresse d'envoi et casserait
   * l'alignement DMARC de toutes les marques d'un coup. Le NOM affiché et le Reply-To se règlent par
   * édition (0078) ; l'adresse d'envoi, jamais.
   */
  MAILGUN_FROM_LOCALPART: z
    .string()
    .regex(/^[A-Za-z0-9._+-]{1,64}$/, "MAILGUN_FROM_LOCALPART: une partie locale seule (sans @ ni domaine)")
    .default("no-reply"),
  MAILGUN_TIMEOUT_MS: int(20000),

  WORKER_MODE: z.enum(["dry-run", "live"]).default("dry-run"),
  WORKER_SENDING_MODE: z.enum(["sandbox", "asset"]).default("sandbox"),
  // Emails exacts ou domaines, séparés par des virgules. `*` seul = OUVERTE à tous : c'est la mise
  // en production, et elle ne s'obtient QUE par ce geste explicite (vide = refus de démarrer en live).
  WORKER_ALLOWLIST: z.string().optional(),
  WORKER_ONE_CLICK: bool(false),
  WORKER_ID: z.string().optional(),

  PUBLIC_BASE_URL: z.string().url(),

  RUN_ONCE: bool(true),
  POLL_INTERVAL_MS: int(5000),
  BATCH_SIZE: int(10),
  /*
   * ⛔ LA VANNE DU PASSAGE — à ne pas confondre avec `BATCH_SIZE`, qui n'en est pas une.
   * `BATCH_SIZE` dimensionne UN lot ; la boucle de drain rappelait la réclamation tant qu'elle
   * rendait des lignes, donc dix mille lignes sortaient dans le même tick. Ce plafond-ci borne le
   * PASSAGE entier. Défaut volontairement bas (voir `debit.ts`) : un réglage de sûreté se règle
   * vers le haut sciemment, jamais par oubli.
   */
  WORKER_MAX_PER_RUN: int(MAX_PAR_PASSAGE_DEFAUT),
  // Plafond PROPRE des e-mails interactifs (confirmation, bienvenue…), par fenêtre de 5 min, dans le
  // service résident. Jamais compté dans `WORKER_MAX_PER_RUN` (voir `debit.ts`).
  WORKER_MAX_INTERACTIVE_PER_WINDOW: int(MAX_INTERACTIFS_PAR_FENETRE_DEFAUT),
  // 3× la période du cron de la plateforme (5 min). À 300s le lock expirait EXACTEMENT quand le tick suivant
  // démarrait : à égalité, un envoi encore en vol pouvait être réclamé une seconde fois — donc
  // envoyé deux fois. Le reclaim doit rester une reprise après crash, pas une course avec le cron.
  STALE_LOCK_SECONDS: int(900),

  SLACK_WEBHOOK_URL: z.string().url().optional(),
});

/**
 * La valeur de `WORKER_ALLOWLIST` qui OUVRE l'envoi à tous les destinataires.
 *
 * ⛔ POURQUOI ELLE EXISTE (21/09/2026). La liste blanche était un filet d'avant-lancement SANS
 * POSITION DE SORTIE : vide, le worker refuse de démarrer en live ; non vide, tout ce qui n'y figure
 * pas est écarté en TERMINAL (`not_allowlisted`). Aucune configuration ne permettait donc d'envoyer
 * à de vrais abonnés — ni leurs campagnes, ni même la CONFIRMATION de leur inscription, que la liste
 * filtre comme le reste. Énumérer leurs domaines n'était pas une sortie : tout domaine oublié aurait
 * perdu ses abonnés en silence.
 */
export const ALLOWLIST_OUVERTE = "*";

export interface WorkerConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
  tokenSecret: string | undefined;
  mailgun: { apiKey: string | undefined; region: "us" | "eu"; sandboxDomain: string | undefined; fromLocalpart: string; timeoutMs: number };
  mode: "dry-run" | "live";
  sendingMode: "sandbox" | "asset";
  allowlist: Set<string>;
  oneClick: boolean;
  workerId: string;
  publicBaseUrl: string;
  messageIdHost: string;
  runOnce: boolean;
  pollIntervalMs: number;
  batchSize: number;
  /** Lignes qu'UN passage s'autorise à réclamer, toutes boucles confondues (voir `debit.ts`). */
  maxPerRun: number;
  /** Réclamations d'e-mails interactifs par fenêtre, dans le service résident (voir `debit.ts`). */
  maxInteractivePerWindow: number;
  staleLockSeconds: number;
  slackWebhookUrl: string | undefined;
}

export function parseWorkerEnv(src: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const e = schema.parse(src);

  const allowlist = new Set(
    (e.WORKER_ALLOWLIST ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );

  const cfg: WorkerConfig = {
    supabaseUrl: e.SUPABASE_URL,
    serviceRoleKey: e.SUPABASE_SERVICE_ROLE_KEY,
    tokenSecret: e.TOKEN_SECRET,
    mailgun: {
      apiKey: e.MAILGUN_API_KEY,
      region: e.MAILGUN_REGION,
      sandboxDomain: e.MAILGUN_SANDBOX_DOMAIN,
      fromLocalpart: e.MAILGUN_FROM_LOCALPART,
      timeoutMs: e.MAILGUN_TIMEOUT_MS,
    },
    mode: e.WORKER_MODE,
    sendingMode: e.WORKER_SENDING_MODE,
    allowlist,
    oneClick: e.WORKER_ONE_CLICK,
    workerId: e.WORKER_ID || `${hostname()}-${process.pid}`,
    publicBaseUrl: e.PUBLIC_BASE_URL.replace(/\/+$/, ""),
    messageIdHost: new URL(e.PUBLIC_BASE_URL).host, // host STABLE pour le Message-Id (dédup MUA entre retries)
    runOnce: e.RUN_ONCE,
    pollIntervalMs: e.POLL_INTERVAL_MS,
    batchSize: e.BATCH_SIZE,
    maxPerRun: e.WORKER_MAX_PER_RUN,
    maxInteractivePerWindow: e.WORKER_MAX_INTERACTIVE_PER_WINDOW,
    staleLockSeconds: e.STALE_LOCK_SECONDS,
    slackWebhookUrl: e.SLACK_WEBHOOK_URL,
  };

  // Invariant anti-doublon : le timeout HTTP doit rester bien SOUS la fenêtre de reclaim, sinon un
  // envoi encore en vol serait réclamé et ré-envoyé (doublon SYSTÉMATIQUE, pas le « rare » assumé).
  if (cfg.mailgun.timeoutMs * 2 > cfg.staleLockSeconds * 1000) {
    throw new Error(
      `[boot] MAILGUN_TIMEOUT_MS (${cfg.mailgun.timeoutMs}ms) trop proche de STALE_LOCK_SECONDS (${cfg.staleLockSeconds}s) — ` +
        `exige timeout*2 <= stale*1000 pour éviter les ré-envois. Réduire le timeout ou augmenter stale.`,
    );
  }

  // Le worker signe les liens unsub/prefs des footers → il DOIT partager le secret du site
  // public, sinon verifyUnsub/verifyPrefs échouent et la désinscription est cassée.
  // ⛔ Témoin d'EMPREINTE (voir `tokenSecretFingerprint` dans packages/tokens) : la garde ci-dessous
  // ne voit que « absent ou valeur dev ». Un secret RÉEL mais DIFFÉRENT de celui du site public est
  // invisible des deux côtés — chacun n'a que sa propre valeur — et casse la désinscription en
  // silence. Cette ligne et sa jumelle côté public se comparent à l'œil dans deux logs de déploiement.
  // Imprimée AVANT le refus, pour exister même quand le worker va s'arrêter juste après.
  console.info(
    `[boot] TOKEN_SECRET empreinte=${tokenSecretFingerprint(cfg.tokenSecret)} (worker) — ` +
      "doit être IDENTIQUE à l'empreinte imprimée au boot du site public ; sinon les liens unsub/prefs " +
      "signés ici seront rejetés là-bas. Reposer la même valeur des deux côtés, puis redéployer.",
  );

  if (!cfg.tokenSecret || cfg.tokenSecret === DEV_TOKEN_SECRET) {
    if (cfg.mode === "live") {
      throw new Error("[boot] TOKEN_SECRET manquant ou valeur dev — refus de démarrer en live (liens unsub/prefs cassés).");
    }
    console.warn("[boot] ⚠️ TOKEN_SECRET absent/dev : les tokens de test ne seront pas vérifiables par la prod.");
  }

  // Gardes de boot LIVE : rendre impossible un envoi accidentel à de vrais abonnés.
  if (cfg.mode === "live") {
    if (cfg.allowlist.size === 0) {
      throw new Error("[boot] WORKER_MODE=live avec WORKER_ALLOWLIST VIDE — refus de démarrer (fail-closed anti-spam).");
    }
    // ⛔ OUVRIR À TOUS DEPUIS LE BAC À SABLE ENVOIE DANS LE MUR. Le domaine sandbox de Mailgun ne
    // livre qu'à ses destinataires autorisés : chaque vrai abonné partirait en échec (4xx classés
    // retentables) après cinq tentatives, sans qu'un seul message n'arrive. On l'arrête au boot.
    if (cfg.allowlist.has(ALLOWLIST_OUVERTE) && cfg.sendingMode === "sandbox") {
      throw new Error(
        "[boot] WORKER_ALLOWLIST=* (ouverte à tous) avec WORKER_SENDING_MODE=sandbox — refus de démarrer : " +
          "le domaine bac à sable ne livre qu'aux destinataires autorisés. Passer en asset (domaines vérifiés) d'abord.",
      );
    }
    if (!cfg.mailgun.apiKey) {
      throw new Error("[boot] WORKER_MODE=live sans MAILGUN_API_KEY — refus de démarrer.");
    }
    if (cfg.sendingMode === "sandbox" && !cfg.mailgun.sandboxDomain) {
      throw new Error("[boot] sending=sandbox sans MAILGUN_SANDBOX_DOMAIN — refus de démarrer.");
    }
  }

  return cfg;
}
