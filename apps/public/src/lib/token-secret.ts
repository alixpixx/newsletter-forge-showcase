/**
 * Garde de boot TOKEN_SECRET du site public — le pendant de `apps/worker/src/env.ts:117-124`.
 *
 * ⛔ L'ASYMÉTRIE est le défaut qu'on supprime ici. Le worker SIGNE les liens unsub/prefs des
 * footers et refuse de démarrer en live sans TOKEN_SECRET (ou avec la valeur de dev) ; le site
 * public, lui, les VÉRIFIE — et se rabattait en silence sur le secret de dev si Vercel oubliait la
 * variable. Résultat : les deux côtés signent avec des secrets différents, `verifyUnsub` /
 * `verifyPrefs` renvoient null, plus personne ne peut se désinscrire, et on ne l'apprend que par
 * une plainte (CAN-SPAM/LGPD/GDPR). Un côté qui hurle et un côté qui continue, c'est pire que deux
 * côtés qui hurlent : mieux vaut un site mort et visible qu'une conformité morte et invisible.
 *
 * Pourquoi NODE_ENV et pas VERCEL_ENV : c'est ce que le dépôt utilise déjà pour cette décision
 * (`apps/admin/src/lib/auth.ts:15`), et sur Vercel une PREVIEW a NODE_ENV="production" — donc elle
 * est gardée elle aussi. C'est voulu : une preview sert de vrais liens de désinscription à qui a
 * l'URL, elle n'a pas moins besoin du bon secret que la prod. Le repli reste donc autorisé
 * exactement là où il est légitime : `next dev` et les tests, où NODE_ENV n'est pas "production".
 */
import { DEV_TOKEN_SECRET, tokenSecretFingerprint } from "@nf/tokens";

const IS_PROD = process.env.NODE_ENV === "production";

/* `next build` importe TOUS les modules de page pour collecter leur config, avec un
   NODE_ENV="production" mais SANS les variables runtime de Vercel. Jeter là ferait échouer le
   build au lieu de protéger le service. On refuse donc de SERVIR sans secret, jamais de builder. */
const IS_BUILD = process.env.NEXT_PHASE === "phase-production-build";

let fingerprintLogged = false;

/**
 * Journalise l'EMPREINTE non secrète du TOKEN_SECRET posé ici (voir `tokenSecretFingerprint`).
 *
 * ⛔ Pourquoi ça existe EN PLUS de la garde : `assertTokenSecret()` ne voit que « absent ou valeur
 * dev ». Elle ne voit PAS un secret réel mais DIFFÉRENT de celui du worker — mesuré : dans ce cas
 * le serveur démarre (`✓ Ready`), répond 200, affiche « Invalid link » à l'abonné, et le log ne
 * contient AUCUNE mention de TOKEN_SECRET. Personne ne peut comparer deux secrets sans les
 * exposer ; on compare donc leurs empreintes, une ligne de chaque côté.
 * Appelée AVANT le refus, pour que la ligne existe même quand la garde va jeter.
 */
export function logTokenSecretFingerprint(): void {
  if (fingerprintLogged) return;
  fingerprintLogged = true;
  console.info(
    `[boot] TOKEN_SECRET empreinte=${tokenSecretFingerprint(process.env.TOKEN_SECRET)} (site public) — ` +
      "doit être IDENTIQUE à l'empreinte imprimée au boot du worker. Si les deux diffèrent, les liens " +
      "unsub/prefs signés par le worker seront rejetés ici sans aucune autre alerte : reposer la même " +
      "valeur de TOKEN_SECRET des deux côtés, puis redéployer.",
  );
}

let warned = false;

/**
 * Vérifie que TOKEN_SECRET est posé et n'est pas la valeur de dev.
 * En production : jette (le module appelant ne se charge pas → la route ne sert pas).
 * En développement : avertit une seule fois et laisse tourner.
 */
export function assertTokenSecret(): void {
  const secret = process.env.TOKEN_SECRET;
  if (secret && secret !== DEV_TOKEN_SECRET) return;

  if (IS_PROD) {
    if (IS_BUILD) return;
    throw new Error(
      "[boot] TOKEN_SECRET manquant ou valeur dev — refus de servir en production (liens unsub/prefs cassés). " +
        "Poser TOKEN_SECRET sur apps/public avec EXACTEMENT la même valeur que le worker, puis redéployer.",
    );
  }

  if (!warned) {
    warned = true;
    console.warn(
      "[boot] ⚠️ TOKEN_SECRET absent/dev : les liens signés ici ne seront pas vérifiables par la prod.",
    );
  }
}
