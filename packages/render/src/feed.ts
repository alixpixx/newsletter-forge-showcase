/**
 * ---------------------------------------------------------------------------
 * Mise en état d'un document avant rendu : dépliage des flux d'articles (un bloc `article-feed`
 * DEVIENT N blocs `article`) ET pose du libellé de CTA par défaut sur les blocs article.
 * ---------------------------------------------------------------------------
 *
 * ⚠️ POURQUOI LES DEUX ICI, ET PAS DEUX PASSES SÉPARÉES. Le défaut de CTA a besoin de `meta.locale`
 * — donc du document entier, ce qu'un bloc seul ne voit jamais. Or la seule fonction que traverse
 * TOUTE COMPILATION avec le document en main est le dépliage : `compileDoc` l'appelle en entrée
 * (`compile/index.ts`), pour l'aperçu comme pour le HTML que le worker recompile avant envoi
 * (`freezeDue`, `apps/worker/src/planner.ts`). Deux exports à appeler dans le bon ordre feraient exister
 * un troisième appelant, un jour, qui n'en appellerait qu'un : le CTA manquant repartirait alors
 * sans que rien ne rougisse. Une seule porte, donc — et un nom d'export qui ne dit plus que la
 * moitié du travail, ce que ce cartouche et le doc-comment de la fonction compensent.
 *
 * ⛔ POURQUOI UNE TRANSFORMATION DE DOCUMENT, ET PAS UN MOTEUR DE RENDU DE PLUS. Le contenu du
 * jour doit être fabriqué 90 min avant chaque échéance, donc APRÈS la publication du modèle. La
 * tentation était d'apprendre au compilateur à rendre un flux, ou au worker à recoller des cartes
 * dans un HTML déjà compilé. Les deux créent une SECONDE écriture du markup d'un article — et deux
 * écritures divergent toujours : l'aperçu à l'écran finirait par ne plus ressembler à ce qui part.
 * Ici, il n'y a qu'un seul rendu d'article, celui du compilateur, et les flux sont dépliés AVANT
 * lui. L'aperçu et l'envoi empruntent exactement le même chemin.
 *
 * ⛔ ZÉRO DÉPENDANCE D'EXÉCUTION — types uniquement. Ce fichier est importé par le worker, dont
 * l'invariant est de ne charger ni MJML ni Zod dans le chemin d'envoi.
 */
import type {
  ArticleBlock,
  ArticleFeedBlock,
  ArticleLook,
  Block,
  DividerBlock,
  EmailDoc,
  FeedItem,
  SectionTitleBlock,
} from "./schema";
// Seul import de VALEUR du fichier, et il ne casse pas l'invariant ci-dessus : `./cta` est une
// table de constantes du même paquet, sans aucune dépendance. L'invariant vise MJML et Zod.
import { defaultArticleCta } from "./cta";
// Même raison que `./cta` : module du paquet, sans aucune dépendance. Il porte LA définition de
// « ce lien ne mène nulle part », que ce fichier recopiait faute de pouvoir l'importer.
import { goesNowhere } from "./links";

/** Ce qu'une résolution rapporte pour UN bloc : les articles du moment et l'instant de récolte. */
export interface FeedResolution {
  items: FeedItem[];
  /** ISO 8601. Devient le `fetchedAt` de chaque article produit — donc sa fraîcheur. */
  fetchedAt: string;
}

export interface ExpandReport {
  /** Nombre de blocs flux rencontrés. */
  feeds: number;
  /** Nombre de blocs article produits, tous flux confondus. */
  articles: number;
  /** Blocs flux qui n'avaient AUCUN article — ils disparaissent du document. */
  emptyBlockIds: string[];
  /** Blocs flux dépliés depuis leur APERÇU faute de résolution fournie. */
  previewBlockIds: string[];
}

const isFeed = (b: Block): b is ArticleFeedBlock => b.type === "article-feed";

// Une seule définition de « absence de libellé » pour tout le fichier : `undefined`, `""` et une
// suite d'espaces sont le même cas. Deux définitions divergeraient, et l'une des deux laisserait
// passer une carte sans aucun lien cliquable.
const blank = (label: string | undefined): boolean => label === undefined || label.trim() === "";

/**
 * ⛔ LA SEULE PORTE — le défaut de libellé est posé ICI, et NULLE PART AILLEURS dans le dépôt.
 * Aucun chemin de création n'écrit le `ctaLabel` d'un bloc ARTICLE dans le document sauvegardé : ni
 * la fabrique de blocs (`newBlock`, `apps/admin/src/components/builder/factories.ts` — le `promo`,
 * lui, garde son libellé vide, mais cette fonction-ci ne juge que les articles), ni la palette
 * (`apps/admin/src/components/builder/palette.tsx`), ni l'insertion WordPress (la route
 * `apps/admin/src/app/api/builder/wp/insert/route.ts`, qui n'écrit la clé que si un humain a tapé
 * quelque chose), ni la composition assistée (`apps/admin/src/lib/ai/compose.ts`). L'éditeur
 * AFFICHE bien le défaut comme valeur héritée (`CtaChip` dans `builder/canvas.tsx`, le champ avec
 * `onReset` dans `builder/inspector.tsx`) — afficher n'est pas écrire, et ces écrans ne persistent
 * rien tant que personne ne tape.
 *
 * ⭐ CE QUE CETTE UNICITÉ ACHÈTE, et c'est tout l'intérêt du montage : un `ctaLabel` présent dans un
 * document signifie TOUJOURS qu'un humain l'a tapé. Il n'existe plus de troisième cas « défaut
 * figé en base par une fabrique d'il y a six mois » qu'il faudrait distinguer d'une saisie. C'est
 * cette équivalence — et elle seule — qui autorise le paragraphe suivant : puisque tout ce que
 * nous fabriquons est fabriqué ici, nous pouvons refuser d'en fabriquer sans rien effacer.
 *
 * ⛔ DONC : RIEN N'EST POSÉ SUR UN HREF QUI NE MÈNE NULLE PART — au sens de `goesNowhere`
 * (`./links`), qui est aussi la source de l'avertissement du compilateur : la règle n'est pas
 * réécrite ici. Un bouton qui promet une lecture qu'il ne tient pas est pire qu'une carte sans
 * bouton : il déplace le problème dans la boîte du lecteur, là où plus personne ne peut le
 * corriger. Sans libellé, `articleHtml` (`compile/mjml.ts`) n'émet aucune ancre de CTA et le titre
 * reste un `<div>` nu ; sur une carte sans image, c'est toute l'ancre qui disparaît — la carte
 * reste lisible, et le trou se voit dans l'éditeur, pas chez l'abonné. Deux cas, un seul geste :
 *   • `lib/ai/compose.ts` neutralise en `#` un lien que le modèle a inventé. Il n'écrit aucun
 *     libellé — c'est ce qui permet à la garde de voir le href : un libellé écrit par le produit
 *     serait indiscernable d'une saisie et ferait sortir `withDefaultCta` avant ce test ;
 *   • un bloc article ajouté à la palette et jamais relié garde le `https://example.com` des
 *     fabriques. Sans image ni libellé il ne porte AUCUNE ancre ; poser le défaut sur tout article
 *     le rendrait soudain cliquable vers un domaine réservé, sur tout le stock d'un coup.
 *
 * ⛔ L'ORDRE DES DEUX TESTS EST PORTEUR, ET NON RÉVERSIBLE : le libellé est jugé AVANT le href. Une
 * saisie humaine ressort donc intacte MÊME sur un href douteux — la garde ne retient que ce que
 * NOUS fabriquons, elle n'arbitre jamais du travail humain. Juger le href d'abord ferait de
 * `goesNowhere` un motif d'effacement : « Read and comment » disparaîtrait d'un bloc Harbor Tech dont
 * le lien n'est pas encore branché, et l'auteur ne verrait rien puisque rien ne rougirait. Mesure
 * de référence au banc (`feed.test.ts`) : 90 combinaisons — 6 langues × 5 formes d'href × 3
 * libellés saisis — sans une seule altération.
 *
 * ⚠️ Un bloc qui n'a rien à recevoir RESSORT À L'IDENTIQUE (`===`), pas en copie : c'est ce qui
 * protège « Read and comment » y compris quand la saisie coïncide avec le défaut de sa langue (à
 * valeur égale, la référence est le SEUL témoin), et ce qui garde le document inchangé pour les
 * appelants qui s'en servent.
 *
 * ⚠️ CE QUE CE PASSAGE COUVRE, ET CE QU'IL NE COUVRE PAS. Le défaut n'étant écrit nulle part, il
 * n'existe que pour les documents qui RETRAVERSENT ce code — c'est-à-dire à chaque compilation.
 * Couvert : tout aperçu d'éditeur, et tout envoi dont le document porte un flux (le worker ne
 * recompile que sous sa garde `hasFeeds`). NON couvert : un document DÉJÀ PUBLIÉ et SANS FLUX, dont
 * `version.html_shell` reste figé à l'instant de la publication et part tel quel — ce HTML-là n'a
 * jamais vu cette fonction. Sa seule issue est la RÉPUBLICATION. Un CTA manquant dans un envoi
 * n'est donc pas forcément une régression d'ici : c'est peut-être un shell d'avant.
 */
function withDefaultCta(block: Block, locale: string, defaultLabel?: string): Block {
  if (block.type !== "article" || !blank(block.ctaLabel)) return block;
  // ⛔ AVANT le href : une carte qui déclare ne pas vouloir de lien de lecture n'en reçoit pas,
  // quel que soit son lien. Sans ce test, le défaut de langue rendait `ctaStyle:"none"`
  // inatteignable pour toute carte correctement liée — c'est-à-dire pour toutes.
  if (block.ctaStyle === "none") return block;
  // ⛔ ORDRE VOLONTAIRE : le libellé est jugé AVANT le href. Un auteur qui a tapé « Read and
  // comment » sur un bloc au lien douteux le garde — la garde ne retient que le défaut que NOUS
  // posons, elle n'efface jamais du travail humain.
  if (goesNowhere(block.href)) return block;
  // `defaultLabel` = le libellé choisi pour CE modèle (`meta.defaultCtaLabel`) : il remplace celui
  // de la langue, jamais un libellé saisi sur le bloc (ce cas est sorti au premier test).
  return { ...block, ctaLabel: defaultArticleCta(locale, defaultLabel) };
}

/**
 * Un article du flux, sous la forme d'un bloc article ordinaire.
 *
 * ⚠️ L'`id` dérive de celui du flux (`<flux>-1`, `<flux>-2`…) : stable d'une échéance à l'autre,
 * donc un message de pré-vol ou de journal désigne toujours la même place dans le modèle.
 * `style` et `visibleIf` du flux sont RECOPIÉS sur chaque carte : ils décrivent l'apparence et la
 * condition d'affichage du bloc, et les perdre ferait apparaître, chez le mauvais destinataire,
 * des articles qu'une condition devait masquer.
 *
 * ⚠️ Ne connaît PAS `meta.locale`, et n'a donc pas à connaître les libellés par défaut : la carte
 * qu'elle produit est un bloc article ordinaire, qui reçoit son défaut au même endroit que les
 * autres (`withDefaultCta`).
 */
/**
 * L'heure de publication, dans le fuseau demandé. `undefined` dès que quelque chose manque ou ne
 * se lit pas : une heure fausse est pire que pas d'heure du tout.
 *
 * ⛔ Jamais l'heure du serveur. Le worker tourne en UTC, l'abonné lit à Santiago ou à Rio :
 * sans fuseau explicite, `toLocaleTimeString` afficherait l'heure de la machine — juste par
 * accident, et faux le reste du temps. Absence de `timeZone` ⇒ UTC, dit tout haut.
 */
function heureDe(
  iso: string | undefined,
  timeZone: string | undefined,
  format: "24h" | "12h" | undefined,
): string | undefined {
  if (iso === undefined || iso.trim() === "") return undefined;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return undefined;
  try {
    // `12h` (22/09/2026) : « 1:50 PM ». Le défaut reste la forme 24 h à deux chiffres, octet pour
    // octet — `en-GB` et ses options d'origine, inchangés.
    if (format === "12h") {
      return new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZone: timeZone ?? "UTC",
      }).format(t);
    }
    return new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: timeZone ?? "UTC",
    }).format(t);
  } catch {
    // Fuseau IANA inconnu du moteur : on ne devine pas, on n'affiche pas.
    return undefined;
  }
}

/**
 * Le surtitre et la ligne de pied d'une carte, composés à partir de ce que l'article porte
 * VRAIMENT. Chaque donnée manquante fait disparaître sa part — et le séparateur voyage avec
 * l'heure, sinon un article sans heure laisserait un « · » orphelin en tête de ligne.
 *
 * L'heure part en ACCENT et non dans le texte : c'est elle qui change de couleur chez Northwind Sports
 * (`#FD4040` sur une catégorie bordeaux), et une seule chaîne ne porte pas deux couleurs.
 */
function surtitreEtPied(
  feed: ArticleFeedBlock,
  look: ArticleLook,
  item: FeedItem,
): Pick<ArticleBlock, "kicker" | "kickerAccent" | "metaAccent"> {
  const out: Pick<ArticleBlock, "kicker" | "kickerAccent" | "metaAccent"> = {};
  const heure = heureDe(item.publishedAt, feed.timeZone, feed.timeFormat);
  const brut = item.category === undefined ? "" : item.category.trim();
  const categorie = brut === "" ? undefined : brut;
  // `showKicker` est la forme courte : « je veux catégorie · heure ». `kickerMode` la précise.
  const demande = look.kickerMode ?? (feed.showKicker === true ? "category-time" : "none");
  // ⛔ `showKicker` EST AUSSI L'INTERRUPTEUR. C'est la seule case que l'inspecteur montre (« Show
  // category and time above each title ») ; un `kickerMode` de look, posé par l'import des maquettes
  // et invisible à l'écran, la rendait sans effet : décochée, les surtitres partaient quand même.
  // Le libellé fixe (`text`, le « Destacada » de la une) n'est ni une catégorie ni une heure : il
  // suit la case « Lead card », puisque le look `lead` n'existe que sous `leadCount: 1`.
  // Mesuré le 22/09/2026 : tout flux en base qui porte un `kickerMode` de catégorie ou d'heure a
  // `showKicker: true` — aucun envoi existant ne change.
  const mode = demande !== "text" && feed.showKicker !== true ? "none" : demande;

  if (mode === "text" && !blank(look.kickerText)) {
    out.kicker = look.kickerText;
  } else if (mode === "category" && categorie !== undefined) {
    out.kicker = categorie;
  } else if (mode === "time" && heure !== undefined) {
    out.kicker = heure;
  } else if (mode === "category-time") {
    if (categorie !== undefined && heure !== undefined) {
      out.kicker = categorie;
      // Le séparateur voyage avec l'heure (voir plus haut) ; `kickerSeparator` le remplace tel quel.
      out.kickerAccent = `${feed.kickerSeparator ?? "\u00a0·\u00a0"}${heure}`;
    } else if (categorie !== undefined) {
      out.kicker = categorie;
    } else if (heure !== undefined) {
      out.kicker = heure;
    }
  }

  if (look.metaMode === "time" && heure !== undefined) out.metaAccent = heure;
  return out;
}

/**
 * Le titre de section qui sépare la une des brèves, sous la forme d'un vrai bloc `section_title`.
 *
 * ⚠️ `rule` et `ruleThickness` portent ici les défauts du schéma (`after`, 2) : le bloc produit ne
 * repasse PAS par `EmailDoc.parse`, il est fabriqué après validation. Les omettre laisserait deux
 * clés obligatoires absentes, et le compilateur lirait `undefined` là où il attend une valeur.
 */
function toMidSection(feed: ArticleFeedBlock): SectionTitleBlock | undefined {
  const s = feed.midSection;
  if (s === undefined) return undefined;
  return {
    id: `${feed.id}-mid`.slice(0, 64),
    type: "section_title",
    label: s.label,
    rule: s.rule ?? "after",
    ruleThickness: s.ruleThickness ?? 2,
    ...(s.ruleColor === undefined ? {} : { ruleColor: s.ruleColor }),
    ...(s.ruleGap === undefined ? {} : { ruleGap: s.ruleGap }),
    ...(s.style === undefined ? {} : { style: s.style }),
    ...(feed.visibleIf === undefined ? {} : { visibleIf: feed.visibleIf }),
  };
}

/**
 * Le filet qui sépare deux brèves. `index` est celui de la carte QUI SUIT, pour que deux filets
 * n'aient jamais le même id — deux blocs de même id rendraient le journal du pré-vol ambigu.
 *
 * ⚠️ Mêmes défauts que le schéma (`thickness` 1, `widthPct` 100) : le bloc est fabriqué APRÈS
 * validation et ne repasse pas par `EmailDoc.parse`.
 */
function toCardRule(feed: ArticleFeedBlock, index: number): DividerBlock | undefined {
  const r = feed.cardRule;
  if (r === undefined) return undefined;
  return {
    id: `${feed.id}-r${index}`.slice(0, 64),
    type: "divider",
    thickness: r.thickness ?? 1,
    widthPct: r.widthPct ?? 100,
    ...(r.lineStyle === undefined ? {} : { lineStyle: r.lineStyle }),
    ...(r.color === undefined ? {} : { color: r.color }),
    ...(r.style === undefined ? {} : { style: r.style }),
    ...(feed.visibleIf === undefined ? {} : { visibleIf: feed.visibleIf }),
  };
}

/** Nombre de cartes en une : `leadCount` borné, absent = 0. Une seule lecture pour tout le fichier. */
const unesDe = (feed: ArticleFeedBlock): number => Math.max(0, Math.trunc(feed.leadCount ?? 0));

/**
 * Les réglages de carte ajoutés le 22/09/2026 (`articleCardLook` du schéma) que `toArticle` recopie
 * du look vers la carte, sous le même nom. `ctaSize` n'y est pas : il était déjà recopié plus bas.
 */
const REGLAGES_DE_CARTE = [
  "excerptLineHeight",
  "excerptWeight",
  "kickerGap",
  "imageGap",
  "excerptGap",
  "metaGap",
  "ctaGap",
  "sideGap",
  "imageLink",
  "ctaBackground",
  "ctaTextColor",
  "ctaWeight",
  "ctaPadding",
  "ctaRadius",
] as const satisfies readonly (keyof ArticleLook & keyof ArticleBlock)[];

function reglagesDeCarte(look: ArticleLook): Partial<ArticleBlock> {
  const out: Record<string, unknown> = {};
  for (const cle of REGLAGES_DE_CARTE) if (look[cle] !== undefined) out[cle] = look[cle];
  return out as Partial<ArticleBlock>;
}

function toArticle(feed: ArticleFeedBlock, item: FeedItem, index: number, fetchedAt: string): ArticleBlock {
  // La UNE est la (ou les) première(s) carte(s), et seulement si le flux en demande. Sans
  // `leadCount`, toutes les cartes prennent `card` — et un flux sans `card` ni `lead` ne change rien.
  const look: ArticleLook = (index < unesDe(feed) ? feed.lead : feed.card) ?? {};
  const style = look.style ?? feed.style;
  const label = look.ctaLabel ?? feed.ctaLabel;
  // Le look l'emporte sur le flux, comme pour le libellé : `none` au niveau du flux retire le lien
  // de lecture de toutes les cartes sans qu'il faille créer un look pour ça.
  const ctaStyle = look.ctaStyle ?? feed.ctaStyle;
  // L'heure porte UNE couleur pour tout le flux (`timeColor`) ; un look peut la surcharger, jamais
  // l'inverse — sinon deux réglages diraient la même chose et divergeraient.
  const accent = look.kickerAccentColor ?? feed.timeColor;
  const accentMeta = look.metaAccentColor ?? feed.timeColor;
  return {
    id: `${feed.id}-${index + 1}`.slice(0, 64),
    type: "article",
    ...(style === undefined ? {} : { style }),
    ...(feed.visibleIf === undefined ? {} : { visibleIf: feed.visibleIf }),
    source: {
      kind: "wp",
      sourceId: feed.sourceId,
      sourceLabel: feed.sourceLabel,
      postId: item.postId,
      fetchedAt,
      ...(item.publishedAt === undefined ? {} : { publishedAt: item.publishedAt }),
      // ⛔ Jamais épinglé : une carte de flux est REMPLACÉE à chaque échéance, c'est sa raison
      // d'être. L'épingle protège le travail manuel d'un auteur — il n'y en a pas ici.
      pinned: false,
    },
    title: item.title,
    excerpt: item.excerpt,
    ...(item.imageSrc === undefined ? {} : { imageSrc: item.imageSrc }),
    imageAlt: item.imageAlt,
    href: item.href,
    // Le libellé du flux est RECOPIÉ TEL QUEL, y compris absent ou vide : la carte sortira ensuite
    // par `withDefaultCta`, comme n'importe quel bloc article du document. Le poser ici en plus
    // serait de toute façon impossible sans changer la signature — `toArticle` ne reçoit pas la
    // locale — et ajouterait un endroit de plus à tenir à jour le jour où un libellé change.
    ...(label === undefined ? {} : { ctaLabel: label }),
    layout: look.layout ?? feed.layout,
    ...(look.imageWidthPct === undefined ? {} : { imageWidthPct: look.imageWidthPct }),
    ...surtitreEtPied(feed, look, item),
    // Apparence : ce que le look dit, rien de plus. Une clé absente laisse le rendu à son défaut,
    // qui est exactement le rendu d'avant l'existence de `ArticleLook`.
    ...(look.kickerFont === undefined ? {} : { kickerFont: look.kickerFont }),
    ...(look.ctaFont === undefined ? {} : { ctaFont: look.ctaFont }),
    ...(look.kickerColor === undefined ? {} : { kickerColor: look.kickerColor }),
    ...(look.kickerSize === undefined ? {} : { kickerSize: look.kickerSize }),
    ...(accent === undefined ? {} : { kickerAccentColor: accent }),
    ...(look.titleSize === undefined ? {} : { titleSize: look.titleSize }),
    ...(look.titleFont === undefined ? {} : { titleFont: look.titleFont }),
    ...(look.titleColor === undefined ? {} : { titleColor: look.titleColor }),
    ...(look.titleWeight === undefined ? {} : { titleWeight: look.titleWeight }),
    ...(look.titleLineHeight === undefined ? {} : { titleLineHeight: look.titleLineHeight }),
    ...(look.titleLink === undefined ? {} : { titleLink: look.titleLink }),
    ...(look.metaColor === undefined ? {} : { metaColor: look.metaColor }),
    ...(look.metaSize === undefined ? {} : { metaSize: look.metaSize }),
    ...(accentMeta === undefined ? {} : { metaAccentColor: accentMeta }),
    ...(ctaStyle === undefined ? {} : { ctaStyle }),
    ...(look.ctaUnderline === undefined ? {} : { ctaUnderline: look.ctaUnderline }),
    ...(look.ctaColor === undefined ? {} : { ctaColor: look.ctaColor }),
    ...(look.ctaSize === undefined ? {} : { ctaSize: look.ctaSize }),
    ...(look.ctaLetterSpacing === undefined ? {} : { ctaLetterSpacing: look.ctaLetterSpacing }),
    ...(look.ctaTransform === undefined ? {} : { ctaTransform: look.ctaTransform }),
    ...reglagesDeCarte(look),
  };
}

/**
 * Les blocs qu'UN flux devient — une, titre de section, filets, cartes — dans l'ordre de lecture.
 * Tableau vide quand il n'y a aucun article (le bloc disparaît, cf. `expandFeedBlocks`).
 *
 * ⛔ C'EST LA SEULE DÉFINITION DE « CE QU'UN FLUX AFFICHE », ET ELLE A DEUX APPELANTS : le dépliage
 * ci-dessous (donc l'aperçu compilé ET l'envoi) et le canvas de l'éditeur. Le canvas dessinait
 * jadis les `previewItems` à sa façon — même mise en page pour toutes les cartes, un bouton partout,
 * ni une, ni surtitre, ni « Más noticias » — alors que l'email, lui, appliquait `leadCount`, `lead`,
 * `card`, `midSection` et `showKicker`. Constaté le 22/09/2026 sur « Boletín semanal genérico » :
 * l'éditeur montrait des cartes identiques à bouton rouge, l'abonné recevait une une « Destacada »,
 * des surtitres « Noticias · 21:42 » et des liens soulignés. Deux lectures d'un même réglage
 * divergent toujours ; il n'y en a plus qu'une.
 *
 * `resolution` absente ⇒ l'APERÇU du bloc, tronqué à `count` comme le fera la résolution réelle.
 *
 * `defaultCtaLabel` = `meta.defaultCtaLabel` du document (le libellé de lecture choisi pour CE
 * modèle). Absent ⇒ le libellé de la langue, comme avant : un appelant qui ne le passe pas (le canvas,
 * tant qu'il ne le lit pas) voit exactement ce qu'il voyait.
 */
export function feedCards(
  block: ArticleFeedBlock,
  locale: string,
  resolution?: FeedResolution,
  defaultCtaLabel?: string,
): Block[] {
  // ⛔ L'APERÇU SE TRONQUE À `count`, comme le fera la résolution réelle (`resolveFeed` rend au plus
  // `count` articles). Sans ce `slice`, un bloc réglé sur 3 articles en montrait 5 à l'écran :
  // l'éditeur validait une mise en page plus longue d'un tiers que celle qui part. Les items en trop
  // restent stockés — changer `count` les fait réapparaître.
  const items = resolution?.items ?? block.previewItems.slice(0, Math.max(1, Math.trunc(block.count)));
  const fetchedAt = resolution?.fetchedAt ?? block.previewAt ?? new Date(0).toISOString();
  const out: Block[] = [];
  const unes = unesDe(block);
  // Sans une, le titre de section n'est posé que si le flux le demande (`showWithoutLead`) : il passe
  // alors au-dessus de la première carte. Avec une, il s'insère entre la dernière une et les brèves.
  const mid = unes >= 1 || block.midSection?.showWithoutLead === true ? toMidSection(block) : undefined;
  // Première brève : celle qui suit la (dernière) une, ou la toute première carte s'il n'y en a pas.
  const premiereBreve = unes;
  items.forEach((item, i) => {
    // Le titre de section s'insère AVANT la première brève — et seulement s'il y a une brève : un
    // titre suspendu au-dessus du vide est ce que le traitement des flux vides évite déjà par ailleurs.
    if (i === premiereBreve && mid !== undefined) out.push(mid);
    // ⛔ Le filet ne va QU'ENTRE deux brèves : ni avant la première (le titre de section vient
    // d'être posé), ni autour de la une (la maquette n'en a pas là).
    else if (i > premiereBreve) {
      const filet = toCardRule(block, i);
      if (filet !== undefined) out.push(filet);
    }
    out.push(withDefaultCta(toArticle(block, item, i, fetchedAt), locale, defaultCtaLabel));
  });
  return out;
}

/**
 * Remplace chaque bloc `article-feed` par ses articles, PUIS pose le libellé de CTA par défaut de
 * `meta.locale` sur tout bloc article qui n'en porte pas — carte de flux ou bloc écrit à la main il
 * y a six mois. Un libellé saisi ressort intact.
 *
 * ⛔ CE QUE CE PASSAGE RATTRAPE EN BASE, ET CE QU'IL NE RATTRAPE PAS — le détail des deux
 * populations est écrit une fois pour toutes sur `withDefaultCta`, ci-dessus. En un mot : le défaut
 * n'existe que pour un document qui RETRAVERSE ce code, donc à chaque compilation ; un modèle DÉJÀ
 * PUBLIÉ et SANS FLUX expédie son `version.html_shell` figé, que `freezeDue`
 * (`apps/worker/src/planner.ts`) ne recompile pas — sa garde `hasFeeds` l'en empêche. C'est le cas
 * qui a produit le symptôme Harbor Tech : des blocs article stockés, aucun flux, et un shell publié
 * avec moins de CTA que le document n'a d'articles. Seule la RÉPUBLICATION le résout.
 *
 * C'est aussi pourquoi le défaut ne peut PAS vivre dans le schéma : un `.default()` est fixe, il ne
 * voit pas `meta.locale`, et les éditions chilienne et brésilienne hériteraient de l'anglais.
 *
 * ⚠️ Le document ressort par IDENTITÉ (`===`) quand il n'y avait ni flux ni CTA à compléter : des
 * appelants s'en servent pour éviter une réécriture, et le banc de preuve le mesure.
 *
 * `resolved` absent (ou muet sur un bloc) ⇒ on déplie l'APERÇU du bloc. C'est ce qui se passe à
 * l'écran de l'éditeur et sur un envoi de test. Le chemin d'envoi réel, lui, fournit TOUJOURS une
 * résolution : c'est au planificateur de refuser de geler quand il n'en a pas — un email qui part
 * avec l'aperçu enverrait les articles du jour de la publication, exactement ce qu'on veut tuer.
 */
export function expandFeedBlocks(
  doc: EmailDoc,
  resolved?: Record<string, FeedResolution>,
): { doc: EmailDoc; report: ExpandReport } {
  const report: ExpandReport = { feeds: 0, articles: 0, emptyBlockIds: [], previewBlockIds: [] };
  let touched = false;

  const rows = doc.rows.map((row) => {
    const columns = row.columns.map((column) => {
      // ⛔ PLUS DE RACCOURCI « pas de flux dans cette colonne, on passe ». C'est lui qui laissait
      // Harbor Tech à 1 CTA sur 3 : ses 3 blocs sont des articles STOCKÉS, aucun flux, donc la
      // colonne entière était rendue telle quelle sans jamais voir le défaut. L'identité est
      // désormais préservée par `changed`, plus par un test sur le type des blocs.
      let changed = false;
      const blocks: Block[] = [];
      for (const block of column.blocks) {
        if (!isFeed(block)) {
          const filled = withDefaultCta(block, doc.meta.locale, doc.meta.defaultCtaLabel);
          if (filled !== block) changed = true;
          blocks.push(filled);
          continue;
        }
        changed = true;
        report.feeds += 1;
        const found = resolved?.[block.id];
        if (found === undefined) report.previewBlockIds.push(block.id);
        // Toute la mise en page d'un flux vit dans `feedCards` — c'est elle aussi que le canvas lit.
        const cards = feedCards(block, doc.meta.locale, found, doc.meta.defaultCtaLabel);
        const articles = cards.filter((b) => b.type === "article").length;
        if (articles === 0) {
          // Le bloc disparaît plutôt que de laisser un titre de section suspendu au-dessus du vide.
          // Ce n'est pas un silence : `emptyBlockIds` le remonte, et le planificateur en fait une
          // raison de rétention.
          report.emptyBlockIds.push(block.id);
          continue;
        }
        blocks.push(...cards);
        report.articles += articles;
      }
      if (!changed) return column;
      touched = true;
      return { ...column, blocks };
    });
    return { ...row, columns };
  });

  return { doc: touched ? { ...doc, rows } : doc, report };
}

/** Les blocs flux d'un document, dans l'ordre de lecture. Sert aux écrans et à la résolution. */
export function feedBlocksOf(doc: EmailDoc): ArticleFeedBlock[] {
  const out: ArticleFeedBlock[] = [];
  for (const row of doc.rows) for (const column of row.columns) for (const block of column.blocks) {
    if (isFeed(block)) out.push(block);
  }
  return out;
}

/**
 * Résumé lisible d'une règle de flux — même phrase à l'écran de campagne et dans le journal.
 *
 * ⛔ ELLE DOIT DIRE CE QUE LE BLOC FAIT VRAIMENT. Depuis que le tri par vues existe, « 5 latest »
 * décrivait faux un bloc réglé sur « les plus vus » : la phrase apparaît à côté d'une occurrence
 * retenue, sans le modèle sous les yeux, et c'est sur elle que l'opérateur décide quoi corriger.
 * La période en fait partie — « les plus vus » sans dire de quand n'est pas une règle.
 */
export function describeFeed(feed: ArticleFeedBlock): string {
  const where = feed.categoryNames.length > 0 ? feed.categoryNames.join(", ") : feed.sourceLabel || "the whole site";
  const tags = feed.tagNames.length > 0 ? ` tagged ${feed.tagNames.join(", ")}` : "";
  if (feed.orderby === "date") return `${feed.count} latest from ${where}${tags}`;
  // « over the send interval » et pas « over 7 days » : la durée n'est connue qu'à la résolution,
  // et écrire un nombre ici en inventerait un pour les modèles réglés sur la cadence.
  const when =
    feed.viewsWindow === "cadence" ? "over the send interval" : `over ${feed.viewsWindow} days`;
  if (feed.orderby === "views") return `${feed.count} most viewed from ${where}${tags} ${when}`;
  /**
   * ⛔ LA PHRASE DIT LA COMPOSITION, PAS LE NOM DU MODE. « mixed » n'apprend rien à l'opérateur qui
   * lit ça à côté d'une occurrence retenue ; « 3 most viewed + 2 latest » lui dit ce qu'il aurait
   * reçu. L'arrondi impair est celui du code (`Math.ceil`) — écrit ici en dur, il divergerait le
   * jour où l'arbitrage change, donc il se relit à la même source : la moitié haute aux plus lus.
   */
  const plusLus = Math.ceil(feed.count / 2);
  return `${plusLus} most viewed ${when} + ${feed.count - plusLus} latest, from ${where}${tags}`;
}
