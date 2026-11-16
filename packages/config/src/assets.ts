/**
 * Registre des assets Example Media — source unique de vérité pour les marques,
 * marchés, langues, régimes de conformité et sous-domaines d'envoi.
 * Voir docs/SOURCE-SPEC.md (section « Marques & marchés »).
 */

export type ComplianceRegime = "gdpr" | "lgpd" | "canspam";

/**
 * ⛔ Bluefin News, Pixel Daily et Lumen Living ont été RETIRÉS du parc le 01/09/2026 (décision d'Alix,
 * migration 0045). Ils sortent du type ET de `ASSETS` : les laisser dans le type aurait fait
 * accepter, sans erreur, des slugs ne désignant plus aucune marque — et le repli hors-base
 * (`fromConfig` dans asset-context.ts) aurait continué de les nommer à l'écran.
 * Aucun abonné n'était rattaché aux trois ; leurs mentions dans packages/wp restent, ce sont des
 * commentaires qui décrivent des mesures faites à l'époque, pas du code actif.
 *
 * ⭐ PIXEL DAILY EST RECRÉÉE le 25/09/2026 (décision d'Alix, Q-E2 : « Oui, recrée-la »,
 * migration 0089) : le site OptinForge `pixel-daily-apostas` collecte des contacts hors
 * newsletter, qui doivent entrer quelque part. Bluefin News et Lumen Living restent retirés.
 */
export type AssetSlug =
  | "quartz-tips"
  | "atlas-review"
  | "harbor-tech"
  | "copper-kettle"
  | "goalpost-weekly"
  | "northwind-sports"
  | "pixel-daily";

export interface Asset {
  slug: AssetSlug;
  name: string;
  /** Codes ISO pays ou "INT". */
  markets: string[];
  /** Locales BCP-47 servies. */
  languages: string[];
  regimes: ComplianceRegime[];
  /** Sous-domaine d'envoi dédié (délivrabilité isolée par asset). */
  sendingSubdomain: string;
  niche: string;
  /** Asset pilote lancé en premier (Phase 1). */
  pilot?: boolean;
}

export const ASSETS: Asset[] = [
  {
    slug: "quartz-tips",
    name: "Quartz Tips",
    markets: ["BR"],
    languages: ["pt-BR"],
    regimes: ["lgpd"],
    // ⛔ `quartz-tips-parked.example` est un domaine PARQUÉ (page qui redirige en JS vers /lander, laquelle
    // répond 403) : on ne peut pas y poser SPF/DKIM, et envoyer depuis le sous-domaine d'un tiers
    // est une usurpation. Le site réel est `quartz-tips.example` — une landing d'une seule page vers
    // Telegram, sans articles ni page de confidentialité. Mesuré le 25/08, pas déduit du nom.
    sendingSubdomain: "news.quartz-tips.example",
    niche: "Communauté de pronostiqueurs",
    pilot: true,
  },
  {
    slug: "atlas-review",
    name: "Atlas Review",
    markets: ["BR", "IT", "FR", "CL", "MX", "AR", "PE", "US", "CA", "INT"],
    // ⛔ `languages[0]` n'est pas décoratif : c'est la langue par DÉFAUT de tout nouveau template,
    // de l'import et du générateur IA (5 lectures). Avec « it » en tête, chaque template de Atlas
    // Review naissait en italien alors que la racine du site publie en portugais — mesuré par la
    // sonde WordPress : « Palpites de hoje », « Notícias », « Brasileirão ». Personne n'avait
    // choisi l'italien ; c'est l'ordre d'un tableau qui décidait. Arbitrage d'Alix du 25/08 :
    // l'édition primaire est BR (voir migration 0029).
    languages: ["pt-BR", "en", "fr", "es", "it"],
    regimes: ["lgpd", "gdpr", "canspam"],
    // ⛔ Valait `news.atlas-review-shop.example`, construit à partir du NOM de la marque et non de son
    // domaine réel, qui est `atlas-review.example`. Or `atlas-review-shop.example` appartient à un tiers
    // (une boutique de vêtements de sport) : impossible d'y poser SPF/DKIM/DMARC,
    // donc impossible d'authentifier un seul envoi — et envoyer depuis le domaine d'autrui.
    sendingSubdomain: "news.atlas-review.example",
    niche: "Pronostics multi-sports",
  },
  {
    slug: "harbor-tech",
    name: "Harbor Tech",
    markets: ["GB", "IT", "CL", "MX", "NG", "SE", "INT"],
    languages: ["en", "it", "es", "sv"],
    regimes: ["gdpr"],
    sendingSubdomain: "news.harbor-tech.example",
    niche: "Fans & pronostics football",
  },
  {
    slug: "copper-kettle",
    name: "Copper Kettle",
    markets: ["CL"],
    languages: ["es"],
    regimes: ["gdpr"],
    sendingSubdomain: "news.copper-kettle.example",
    niche: "Tips & pronostics",
  },
  {
    slug: "goalpost-weekly",
    name: "Goalpost Weekly",
    markets: ["GB"],
    languages: ["en"],
    regimes: ["gdpr"],
    // ⛔ Même défaut que Atlas Review : le seed a dérivé le domaine du NOM. `goalpost-weekly-parked.example`
    // est parqué ; le site réel est `goalpost-weekly.example`, dont l'API REST répond (article du
    // 25/08 lu, id 1327740).
    sendingSubdomain: "news.goalpost-weekly.example",
    niche: "Communauté football UK",
  },
  { slug: "northwind-sports", name: "Northwind Sports", markets: ["BR"], languages: ["pt-BR"], regimes: ["lgpd"], sendingSubdomain: "news.northwind-sports.example", niche: "Actualité football" },
  // ⚠️ Recréée par 0089 avec les valeurs d'avant 0045. Personne n'a vérifié que ce sous-domaine
  //    d'envoi est configuré chez Mailgun (le worker l'emploie tel quel comme domaine d'envoi) :
  //    à contrôler avant la première campagne de cette marque.
  { slug: "pixel-daily", name: "Pixel Daily", markets: ["BR"], languages: ["pt-BR"], regimes: ["lgpd"], sendingSubdomain: "news.pixel-daily.example", niche: "Digital & football" },
];

export const getAsset = (slug: AssetSlug): Asset | undefined =>
  ASSETS.find((a) => a.slug === slug);

export const PILOT_ASSET = ASSETS.find((a) => a.pilot) ?? ASSETS[0];
