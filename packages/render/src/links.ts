/**
 * ---------------------------------------------------------------------------
 * LA définition de « ce lien ne mène nulle part », et le seul endroit où elle est écrite.
 * ---------------------------------------------------------------------------
 *
 * ⛔ POURQUOI UN FICHIER À PART. La même règle vivait en deux exemplaires : la boucle
 * d'avertissement du compilateur (`compile/index.ts`) et la garde de `withDefaultCta` (`feed.ts`),
 * qui en avait recopié le noyau faute de pouvoir l'importer — il était enfermé dans une fonction
 * privée. Deux copies ne restent d'accord que tant que personne n'en élargit une : le jour où l'une
 * apprend un nouveau cas, l'autre continue de le laisser passer EN SILENCE, et le désaccord ne se
 * voit que dans la boîte du lecteur. Une seule vérité, deux consommateurs.
 *
 * ⛔ ZÉRO DÉPENDANCE D'EXÉCUTION — pas même un type importé. Ce module est tiré par `feed.ts`, donc
 * par le chemin d'envoi du worker (qui ne doit charger ni MJML ni Zod), et il doit rester importable
 * tel quel depuis `apps/admin`. Il ne contient que des fonctions pures sur une chaîne.
 *
 * ⚠️ DEUX NIVEAUX, ET C'EST VOLONTAIRE. Ils ne répondent pas à la même question, donc ils ne peuvent
 * pas avoir la même largeur :
 *   • `isPlaceholderHref` — « faut-il AVERTIR l'auteur ? ». Étroit. Élargir un avertissement fait
 *     rougir d'un coup des documents déjà en base que personne n'a touchés : l'auteur apprend qu'il
 *     a un problème là où rien n'a changé, et il apprend à ignorer la ligne rouge.
 *   • `goesNowhere` — « a-t-on le droit de FABRIQUER un bouton par-dessus ? ». Plus large. Ce
 *     niveau-là ne signale rien et n'efface rien : il s'abstient. Le coût d'un cas en trop est une
 *     carte sans bouton dans l'éditeur, où l'auteur le voit et le corrige ; le coût d'un cas en
 *     moins est une ancre morte expédiée à toute une liste.
 *
 * `isPlaceholderHref` ⊂ `goesNowhere` : tout ce qui mérite un avertissement mérite aussi qu'on
 * n'y accroche pas de bouton. L'inverse est faux, et c'est là toute la différence entre les deux.
 */

/**
 * L'href de remplissage des fabriques : `https://example.com` NU, et lui seul.
 *
 * ⚠️ LA RACINE SEULEMENT, et ce n'est pas un oubli. `https://example.com/sunday-preview` porte un
 * chemin, donc une intention d'auteur — il garde son défaut. Élargir à tout `example.com` retirerait
 * le CTA de blocs qu'un humain a pourtant reliés à quelque chose (les gabarits de pré-vol du dépôt
 * en sont pleins). Domaine réservé par la RFC 2606 : le dépôt le nomme déjà ainsi pour les adresses.
 */
const FILLER_HREF = /^https?:\/\/example\.com\/?$/i;

/**
 * NIVEAU « AVERTIR L'AUTEUR » — href vide ou `#` nu, exactement ce que le compilateur signale
 * depuis toujours (« Placeholder link on … — "#" goes nowhere. »).
 *
 * ⛔ NE PAS ÉLARGIR CE PRÉDICAT. Il alimente un avertissement de compilation, donc l'aperçu de tout
 * document déjà en base. Un cas de plus ici, et des modèles publiés se mettent à afficher un
 * reproche pour un markup que leur auteur n'a pas changé. Ce qui doit s'élargir est `goesNowhere`,
 * qui ne parle à personne et se contente de ne rien fabriquer.
 */
export function isPlaceholderHref(href: string): boolean {
  const h = href.trim();
  return h === "" || h === "#";
}

/**
 * NIVEAU « REFUSER DE FABRIQUER UN BOUTON » — le seul consommateur est `withDefaultCta` (`feed.ts`).
 *
 * ⛔ CE N'EST PAS UNE RÈGLE DE PUBLICATION : elle ne refuse aucun envoi et n'écrit aucun
 * avertissement — la publication et le pré-vol gardent les leurs. Elle répond à UNE question : ce
 * href mérite-t-il qu'on FABRIQUE un bouton par-dessus ? Un bouton qui promet une lecture qu'il ne
 * tient pas est pire qu'une carte sans bouton : il déplace le problème dans la boîte du lecteur, là
 * où plus personne ne peut le corriger. Sans libellé, `articleHtml` n'émet aucun `<a>` — la carte
 * reste lisible, et le trou se voit dans l'éditeur.
 *
 * Trois cas, et rien d'autre :
 *   1. le niveau d'avertissement (`""`, `"#"`), par construction ;
 *   2. TOUT href qui commence par `#` — donc aussi les ancres nommées (`#latest`). Dans un email,
 *      une ancre interne ne mène nulle part : les clients réécrivent ou suppriment les `id` du
 *      markup, Gmail sert le message dans un conteneur qui n'est pas un document autonome. Aucun
 *      faux positif possible : une URL réelle ne commence JAMAIS par `#` — ni absolue, ni relative,
 *      ni `mailto:`, ni un jeton `{{…}}` résolu à l'hydratation. Le cas n'est pas théorique : c'est
 *      la forme qu'un lien inventé par le modèle prend quand on le neutralise ;
 *   3. l'href de remplissage des fabriques (`FILLER_HREF`, la racine seule).
 *
 * ⛔ CE QUI EST EXCLU FAUTE DE PREUVE, et doit le rester tant que personne n'a mesuré la fréquence :
 * `javascript:`, `about:blank`, les `data:` — dans le doute on garde l'étroitesse, parce qu'un faux
 * positif efface un lien légitime, ce qui est pire que le cas qu'on prétend couvrir.
 */
export function goesNowhere(href: string): boolean {
  const h = href.trim();
  return isPlaceholderHref(h) || h.startsWith("#") || FILLER_HREF.test(h);
}

/* ------------------------------------------------------------------ *
 * Balisage UTM des liens de contenu
 * ------------------------------------------------------------------ */

export interface UtmParams {
  /** `utm_source` — « newsletter » par défaut : c'est ce qu'on veut lire dans Analytics. */
  source: string;
  /** `utm_medium` — « email ». */
  medium: string;
  /** `utm_campaign` — le nom de la campagne, en slug. Absent = paramètre non posé. */
  campaign?: string | null;
  /** `utm_content` — l'édition (`edition-7`), quand elle existe. */
  content?: string | null;
}

/**
 * Ce qu'on pose partout, sauf demande contraire.
 *
 * ⚠️ Pas de réglage par marque pour l'instant, et c'est délibéré : la demande est un balisage
 * GÉNÉRIQUE (« utm_source=newsletter ») lisible dans tous les Analytics. Une colonne de réglage
 * que personne n'irait jamais changer serait une colonne alimentée par personne — on l'ajoutera le
 * jour où une marque aura besoin d'autre chose, avec l'écran qui va avec.
 */
export const UTM_DEFAULTS = { source: "newsletter", medium: "email" } as const;

export interface UtmResult {
  html: string;
  /** Liens réellement balisés. */
  tagged: number;
  /** Liens laissés intacts, et pourquoi — le décompte SERT au journal, il n'est pas décoratif. */
  skipped: { token: number; nonHttp: number; alreadyTagged: number; unparsable: number };
}

/** Slug ASCII lisible pour `utm_campaign` : « Resumo da Semana » → « resumo-da-semana ». */
export function utmSlug(value: string): string {
  return value
    .normalize("NFD")
    // Les diacritiques séparés par NFD, désignés par leur propriété Unicode plutôt que par une
    // plage recopiée : « Résumé » doit donner « resume », pas « r-sum ».
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * Pose les paramètres UTM sur les liens de CONTENU d'un email compilé.
 *
 * ⛔ CE QU'IL NE FAUT SURTOUT PAS TOUCHER : les liens système (désinscription, préférences,
 * confidentialité, version web). Deux barrières, et il est important de savoir laquelle porte
 * réellement — mesuré sur les dix versions publiées en base le 08/09/2026 :
 *
 *   1. LA VRAIE, structurelle : ces liens N'EXISTENT PAS ENCORE ici. Le footer légal est injecté
 *      d'un bloc par le jeton `{{legal_footer_html}}` à l'hydratation, c'est-à-dire APRÈS ce
 *      balisage. Aucune des dix versions ne porte le moindre href de désinscription. On ne peut
 *      pas abîmer ce qui n'est pas là.
 *   2. LA CEINTURE, quand même utile : le registre expose `{{unsubscribe_url}}` comme jeton, donc
 *      un auteur PEUT poser un bouton dessus dans le builder. Tout href contenant `{{` est donc
 *      laissé strictement intact.
 *
 * Un lien de désinscription abîmé est un manquement de conformité, pas un défaut d'analytics :
 * les deux barrières sont verrouillées par des tests.
 *
 * ⛔ UN LIEN DÉJÀ BALISÉ N'EST PAS COMPLÉTÉ, il est laissé tel quel. Un auteur qui a écrit ses
 * propres `utm_` a une intention ; y ajouter nos paramètres produirait un mélange dont personne ne
 * saurait dire ce qu'il mesure. Tout ou rien, jamais moitié-moitié.
 *
 * ⚠️ Les `&` d'un href sont ÉCHAPPÉS dans le HTML (`&amp;`). On désamorce l'entité avant de
 * manipuler l'URL et on ré-échappe après : écrire un `&` nu produirait un attribut invalide que
 * certains clients mail coupent au premier point-virgule qui suit.
 */
export function applyUtm(html: string, params: UtmParams): UtmResult {
  const paires: [string, string][] = [
    ["utm_source", params.source],
    ["utm_medium", params.medium],
  ];
  if (params.campaign) paires.push(["utm_campaign", params.campaign]);
  if (params.content) paires.push(["utm_content", params.content]);

  const skipped = { token: 0, nonHttp: 0, alreadyTagged: 0, unparsable: 0 };
  let tagged = 0;

  /*
   * ⛔ SEULEMENT LES ANCRES, ET C'EST UNE CORRECTION PAYÉE. Une première version visait tout
   * attribut `href=` : mesurée sur les dix versions publiées en base, elle balisait aussi le
   * `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?...">` du gabarit. Un
   * paramètre de campagne collé à une requête de police ne mesure rien, alourdit l'email et
   * s'invite dans une URL dont on ne maîtrise pas le contrat. Le défaut ne se voyait sur aucun
   * exemple écrit à la main : il fallait le HTML réel.
   */
  const out = html.replace(
    /(<a\b[^>]*?\shref=)(["'])([^"']*)\2/gi,
    (tout: string, avant: string, quote: string, brut: string): string => {
      // Un jeton non résolu : c'est un lien système, il n'existe pas encore.
      if (brut.includes("{{")) {
        skipped.token += 1;
        return tout;
      }
      const url = brut.replace(/&amp;/gi, "&").trim();
      if (!/^https?:\/\//i.test(url)) {
        // `mailto:`, `tel:`, ancres, chemins relatifs : rien à baliser.
        skipped.nonHttp += 1;
        return tout;
      }
      let parsee: URL;
      try {
        parsee = new URL(url);
      } catch {
        skipped.unparsable += 1;
        return tout;
      }
      let porteDejaUnUtm = false;
      parsee.searchParams.forEach((_v, k) => {
        if (k.toLowerCase().startsWith("utm_")) porteDejaUnUtm = true;
      });
      if (porteDejaUnUtm) {
        skipped.alreadyTagged += 1;
        return tout;
      }
      for (const [k, v] of paires) parsee.searchParams.set(k, v);
      tagged += 1;
      // Même échappement que le compilateur : `&` → `&amp;` (les autres caractères sont déjà
      // percent-encodés par `URL`, il n'y a donc ni `<`, ni `>`, ni guillemet à traiter).
      return `${avant}${quote}${parsee.toString().replace(/&/g, "&amp;")}${quote}`;
    },
  );

  return { html: out, tagged, skipped };
}
