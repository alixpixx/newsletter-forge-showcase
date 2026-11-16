/**
 * Hook `register()` de Next : appelé quand un RUNTIME serveur se charge — une fois par instance,
 * donc à chaque démarrage de serveur et, sur Vercel, à chaque cold start de fonction.
 *
 * ⛔ CE QUI EST MESURÉ ICI, et pas ce qu'on aimerait croire : ce n'est PAS un échec de démarrage.
 * `next start` imprime `✓ Ready` AVANT de charger ce hook, et l'exception jetée par la garde ne
 * tue pas le processus : le serveur reste VIVANT, sort `Failed to prepare server` puis
 * `⨯ unhandledRejection`, et répond 500 à CHAQUE requête, sur TOUTES les routes, `/` comprise
 * (mesuré : HTTP_root=500). Aucun code de sortie non nul. Conséquence assumée : sur Vercel le
 * déploiement sera VERT et le refus se manifestera au premier hit — mais partout à la fois, donc
 * un healthcheck sur `/` le voit, ce n'est pas seulement le lien d'un abonné qui casse.
 * Le worker, lui, jette vraiment dans sa garde de boot et s'arrête : la symétrie porte sur le
 * REFUS DE SERVIR, pas sur le moment de l'échec. Obtenir un vrai échec au déploiement demanderait
 * une route de santé branchée en Vercel deployment check — ce fichier ne le fait pas, et ce
 * commentaire ne doit pas le promettre.
 */

export async function register(): Promise<void> {
  /* ⛔ `register()` tourne AUSSI dans le runtime EDGE dès qu'un `middleware.ts` existe, et l'edge
     n'a PAS `node:crypto` — dont dépend @nf/tokens. Mesuré : avec le middleware `/unsubscribe`
     présent et un import STATIQUE de la garde, l'entrée edge échoue à l'évaluation
     (`Failed to load external module node:crypto`) et `/unsubscribe` répond 500 MÊME AVEC LE BON
     SECRET. D'où le filtre par runtime + l'import DYNAMIQUE : node:crypto ne doit jamais entrer
     dans le bundle edge. Le middleware ne signe ni ne vérifie de jeton, il n'a rien à garder ;
     tout ce qui touche au secret vit dans le runtime Node. */
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { assertTokenSecret, logTokenSecretFingerprint } = await import("./lib/token-secret");

  // D'abord le témoin d'empreinte : c'est la SEULE trace qui rende comparable le secret d'ici et
  // celui du worker (la garde, elle, est aveugle à « réel mais différent »). Avant le refus, pour
  // que la ligne soit dans le log même quand la garde va jeter juste après.
  logTokenSecretFingerprint();
  assertTokenSecret();
}
