/**
 * Le strict nécessaire d'un client Supabase pour ce module : appeler une fonction SQL.
 *
 * ⛔ CE PAQUET EST PARTAGÉ PAR L'ADMIN ET LE WORKER, qui ont chacun leur propre client (l'un épinglé
 * sur `newsletter` via `lib/supabase.ts`, l'autre construit dans `apps/worker/src/db.ts`). Typer sur
 * l'un des deux forcerait l'autre à l'importer — c'est-à-dire à dépendre d'une application. On décrit
 * donc la seule capacité utilisée, et les deux clients réels la satisfont.
 *
 * ⚠️ `PromiseLike` et non `Promise` : `rpc()` de supabase-js rend un constructeur de requête qui
 * n'est *thenable* qu'à l'exécution, sans `catch` ni `finally`.
 */
export interface ClientRpc {
  rpc: (
    nom: string,
    params: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

/**
 * L'audience GA4 d'articles candidats, lue par la RPC `newsletter.article_views`.
 *
 * ⛔ POURQUOI UNE RPC ET PAS UN SECOND CLIENT `.schema("marts")`. Les vues vivent dans le schéma
 * `marts` (entrepôt data-warehouse), qui est dans la MÊME instance Postgres — mais le client d'ici est
 * épinglé sur `newsletter` (`lib/supabase.ts:20`). Un second client marcherait tant que PostgREST
 * expose `marts` ; le jour où ce réglage de projet change — hors du dépôt, hors migration — il
 * rendrait `PGRST106`, et un appelant qui lit `data ?? []` afficherait « aucun article populaire ».
 * La RPC ne dépend que de l'exposition de `newsletter`, dont l'application entière dépend déjà.
 *
 * ⛔ AUCUN CHEMIN NE REND UN VIDE MUET. Un zéro a quatre causes qui n'appellent pas la même action —
 * marque sans propriété élue, source qui n'émet plus, entrepôt injoignable, et « ces articles n'ont
 * pas été lus » — et un seul message pour les quatre ferait accuser WordPress d'une panne
 * d'analytics. D'où un type discriminé, et jamais un tableau vide en cas d'échec.
 */

/** Ce que la RPC rend telle quelle. Les noms sont ceux du JSON, pas encore ceux du produit. */
type ReponseRpc = {
  ok: boolean;
  reason: "no_property" | "source_silent" | "source_stale" | null;
  site_slug: string | null;
  window: { from: string; to: string; to_requested: string };
  freshness: { max_event_date: string | null; rows_last_day: number; rows_prev_day: number };
  candidates: number;
  rejected_relative: number;
  matched: number;
  /**
   * ⚠️ `views` vaut `null` quand AUCUNE ligne d'analytics n'apparie le chemin — ce n'est pas 0.
   * (Migration 0047 : la 0046 faisait `coalesce(..., 0)` derrière un `left join` et fabriquait donc
   * un zéro pour chaque candidat non apparié, indiscernable d'un article que personne n'a lu.)
   */
  views: { href: string; path: string; views: number | null }[];
};

export type MotifIndisponible =
  /** Aucune ligne dans `asset_analytics` : personne n'a élu de propriété GA4 pour cette marque. */
  | "no_property"
  /** La propriété élue n'a jamais rien rendu sur les 30 derniers jours. */
  | "source_silent"
  /** Elle a émis, mais plus rien depuis assez longtemps pour que la fenêtre soit vide ou fausse. */
  | "source_stale"
  /** L'entrepôt n'a pas répondu. ⚠️ N'existe pas côté SQL : c'est la panne, pas un état des données. */
  | "unavailable";

export type Audience =
  | {
      ok: true;
      siteSlug: string;
      /** La fenêtre RÉELLEMENT couverte, bornée à J−2 par la RPC — pas celle qui a été demandée. */
      fenetre: { du: string; au: string; auDemande: string };
      fraicheur: { dernierJour: string | null; lignesDernierJour: number; lignesVeille: number };
      /** Combien de href ont été soumis, et combien ont trouvé une audience non nulle. */
      candidats: number;
      apparies: number;
      /** Des href relatifs, qui ne peuvent apparier aucun chemin. Comptés pour ne pas disparaître. */
      rejetesRelatifs: number;
      /** href → vues sur la fenêtre. Un href absent de la carte n'a pas été mesuré ; à 0, il l'a été. */
      vues: Map<string, number>;
    }
  | { ok: false; motif: MotifIndisponible; siteSlug: string | null; detail?: string };

/**
 * ⚠️ LA FENÊTRE EST DEMANDÉE, PAS IMPOSÉE. La RPC la ramène à J−2 et rend celle qu'elle a réellement
 * couverte : l'ingestion de data-warehouse s'arrête à J−1 par conception, et J−1 est tronqué de façon
 * très inégale selon la marque (le 31/08 : northwind-sports −67 %, harbor-tech −64 %, copper-kettle stable).
 * L'écran doit donc afficher `fenetre.au`, jamais la date qu'il a demandée.
 */
export async function lireAudience(
  db: ClientRpc,
  assetId: string,
  hrefs: string[],
  du: string,
  au: string,
): Promise<Audience> {
  if (hrefs.length === 0) {
    return {
      ok: true,
      siteSlug: "",
      fenetre: { du, au, auDemande: au },
      fraicheur: { dernierJour: null, lignesDernierJour: 0, lignesVeille: 0 },
      candidats: 0,
      apparies: 0,
      rejetesRelatifs: 0,
      vues: new Map(),
    };
  }

  const { data, error } = await db.rpc("article_views", {
    p_asset_id: assetId,
    p_hrefs: hrefs,
    p_from: du,
    p_to: au,
  });

  // ⛔ Ne JAMAIS retomber sur une carte vide ici. Une erreur PostgREST (`PGRST202` fonction absente,
  // `42501` droits) et « ces articles n'ont pas été lus » se ressemblent une fois réduits à zéro
  // vue — et la première demande d'aller voir la base, la seconde de changer de catégorie.
  if (error) return { ok: false, motif: "unavailable", siteSlug: null, detail: error.message };
  if (!data) return { ok: false, motif: "unavailable", siteSlug: null, detail: "empty response" };

  const r = data as ReponseRpc;
  if (!r.ok) {
    return { ok: false, motif: r.reason ?? "unavailable", siteSlug: r.site_slug };
  }

  return {
    ok: true,
    siteSlug: r.site_slug ?? "",
    fenetre: { du: r.window.from, au: r.window.to, auDemande: r.window.to_requested },
    fraicheur: {
      dernierJour: r.freshness.max_event_date,
      lignesDernierJour: r.freshness.rows_last_day,
      lignesVeille: r.freshness.rows_prev_day,
    },
    candidats: r.candidates,
    apparies: r.matched,
    rejetesRelatifs: r.rejected_relative,
    // ⛔ Un `views` nul reste HORS de la carte. C'est ce qui permet à l'écran d'écrire « not
    // measured » plutôt que « 0 view » — et au tri de ranger ces articles sous les zéros réels.
    // L'insérer à 0 ici annulerait la migration 0047 d'un cran plus haut.
    vues: new Map(
      r.views.filter((v): v is { href: string; path: string; views: number } => v.views !== null).map((v) => [v.href, v.views]),
    ),
  };
}

/**
 * La phrase à montrer quand l'audience n'est pas disponible.
 *
 * ⛔ Elle NOMME la cause. Le produit refuse déjà, par écrit et à deux endroits, de proposer « les
 * plus lus » en servant autre chose derrière ; un message unique pour quatre causes serait la même
 * faute déplacée d'un cran — l'auteur irait vérifier ses catégories WordPress alors que c'est une
 * propriété GA4 qui n'émet plus.
 */
export function raisonLisible(motif: MotifIndisponible): string {
  switch (motif) {
    case "no_property":
      return "No analytics property has been chosen for this brand, so view counts cannot be shown.";
    case "source_silent":
      return "The analytics property for this brand has never reported any page views.";
    case "source_stale":
      return "The analytics property for this brand has stopped reporting, so recent view counts are missing.";
    case "unavailable":
      return "View counts could not be read right now. This is a data warehouse problem, not a WordPress one.";
  }
}

/**
 * Forme sérialisable de `Audience` : une `Map` ne survit pas à `JSON.stringify` (elle devient `{}`,
 * silencieusement — l'écran afficherait « 0 vue » partout sans qu'aucune erreur ne soit levée).
 */
export type AudienceJson =
  | {
      ok: true;
      siteSlug: string;
      fenetre: { du: string; au: string; auDemande: string };
      fraicheur: { dernierJour: string | null; lignesDernierJour: number; lignesVeille: number };
      candidats: number;
      apparies: number;
      rejetesRelatifs: number;
      vues: Record<string, number>;
    }
  | { ok: false; motif: MotifIndisponible; siteSlug: string | null; message: string };

/** Le message part d'ici : l'écran n'a pas à connaître la liste des motifs pour savoir quoi dire. */
export function audienceEnJson(a: Audience): AudienceJson {
  if (!a.ok) return { ok: false, motif: a.motif, siteSlug: a.siteSlug, message: raisonLisible(a.motif) };
  return { ...a, vues: Object.fromEntries(a.vues) };
}

/**
 * Cet article a-t-il été publié APRÈS la fin de la fenêtre mesurée ?
 *
 * ⛔ POURQUOI CETTE DISTINCTION EXISTE. Mesuré en production le 01/09/2026 : les 8 candidats rendus
 * par défaut pour copper-kettle sont appariés **0 fois sur 8** — et les 8 articles publiés avant le
 * 29/08 le sont **8 fois sur 8** (170, 278, 28, 55, 331, 97, 94, 171 vues). La jointure est juste ;
 * ce que WordPress rend « en premier » est simplement plus récent que la borne haute de l'entrepôt.
 * Sans cette fonction, l'écran écrit « not measured » sur la totalité du pool et laisse croire à un
 * appariement cassé, alors que la seule chose à faire est de demander des articles plus anciens.
 *
 * ⚠️ La comparaison est faite à la fin du jour `fenetreAu`, en UTC, alors que `event_date` est un
 * jour dans le fuseau de reporting de la propriété GA4 — que rien n'expose. L'imprécision porte donc
 * sur quelques heures autour de la frontière, et elle est sans conséquence ici : la fonction ne sert
 * qu'à EXPLIQUER une absence de mesure déjà constatée, jamais à décider qu'un article n'a pas de
 * vues. Un article apparié affiche ses vues, quelle que soit sa date.
 */
export function publieApresLaFenetre(publishedAt: string | null, fenetreAu: string): boolean {
  // Pas de garde explicite sur les dates illisibles : `Date.parse` rend `NaN`, et toute comparaison
  // avec `NaN` est fausse. Une date absente ou invalide ne peut donc PAS devenir « trop récent »,
  // c'est-à-dire fabriquer une explication rassurante à la place d'un vrai défaut d'appariement.
  // Un garde de plus serait une ligne qu'aucun test ne pourrait faire tomber ; le banc prouve le
  // comportement, pas la ceinture.
  return Date.parse(publishedAt ?? "") > Date.parse(`${fenetreAu}T23:59:59.999Z`);
}

/**
 * La date de publication la plus RÉCENTE qu'un article puisse avoir pour être mesurable.
 *
 * ⛔ SANS ELLE, LE TRI PAR VUES NE SERT JAMAIS. Mesuré en production le 01/09/2026 : un bloc réglé
 * sur « most viewed » chez copper-kettle reçoit 7 articles frais et en fait mesurer **zéro** — tous
 * publiés dans les 48 h que l'entrepôt n'a pas encore ingérées. Le bloc refuse alors, correctement,
 * mais il refuserait à CHAQUE échéance : ces sites publient 42 à 53 articles par jour, donc le haut
 * du flux est toujours postérieur à la borne.
 *
 * Classer par vues implique donc de ne récolter que ce qui est classable. Ce n'est pas un réglage
 * de plus à comprendre pour l'auteur : c'est la conséquence du mode qu'il a choisi, et l'aide de
 * l'inspecteur le dit.
 *
 * ⚠️ Rendu en ISO, à la fin du jour J−2, pour être passé tel quel au `before` de l'API WordPress.
 */
export function bornePublicationMesurable(maintenant: Date): string {
  const fin = new Date(maintenant);
  fin.setUTCDate(fin.getUTCDate() - 2);
  return `${fin.toISOString().slice(0, 10)}T23:59:59`;
}

/** La fenêtre par défaut de l'écran d'import : sept jours, en dates ISO. */
export function fenetreParDefaut(maintenant: Date, jours = 7): { du: string; au: string } {
  const jour = (d: Date) => d.toISOString().slice(0, 10);
  const debut = new Date(maintenant);
  debut.setUTCDate(debut.getUTCDate() - jours);
  // ⚠️ Ces bornes sont en UTC, et `event_date` est un jour dans le fuseau de reporting de la
  // propriété GA4 — que rien n'expose. Pour un classement sur sept jours l'écart d'un jour partiel
  // est sans effet sur l'ordre ; il ne le serait plus pour une fenêtre d'un seul jour. C'est le
  // lot B (fenêtre dérivée de la récurrence) qui devra calculer ses bornes en SQL, dans le fuseau
  // de la campagne.
  return { du: jour(debut), au: jour(maintenant) };
}

/** D'où vient la durée d'un classement — l'écran et le journal doivent pouvoir le DIRE. */
export type OrigineFenetre =
  /** Une durée écrite dans le modèle. */
  | "fixed"
  /** L'écart entre deux envois de la campagne. */
  | "cadence"
  /** Le modèle demande la cadence, mais aucune campagne récurrente ne la fournit. */
  | "no-cadence"
  /** Le modèle demande la cadence et l'appelant ne connaît pas de campagne (aperçu isolé). */
  | "no-campaign";

/** Durée par défaut quand rien ne peut la fournir. Sept jours : la cadence la plus courante. */
export const JOURS_PAR_DEFAUT = 7;

/**
 * Traduit la RÈGLE du modèle (`viewsWindow`) en une DURÉE, et dit d'où elle vient.
 *
 * ⛔ LA PROVENANCE COMPTE AUTANT QUE LE NOMBRE. « Sept jours » parce que la campagne est
 * hebdomadaire et « sept jours parce qu'on n'a rien trouvé » donnent le même classement et
 * appellent deux gestes opposés : le premier est correct, le second veut dire qu'une récurrence
 * n'est pas armée et que l'auteur croit à tort que sa période suit ses envois. Rendre un simple
 * nombre effacerait cette différence — c'est pourquoi cette fonction rend aussi `origine`.
 *
 * `cadenceJours` : l'écart en jours entre l'envoi précédent et celui-ci, quand l'appelant le
 * connaît. `null` = campagne connue mais sans récurrence armée. `undefined` = pas de campagne du
 * tout (l'aperçu d'un modèle qui n'en a pas encore).
 */
export function joursDeFenetre(
  viewsWindow: "cadence" | number,
  cadenceJours?: number | null,
): { jours: number; origine: OrigineFenetre } {
  if (typeof viewsWindow === "number") {
    return { jours: Math.min(90, Math.max(1, Math.trunc(viewsWindow))), origine: "fixed" };
  }
  if (cadenceJours === undefined) return { jours: JOURS_PAR_DEFAUT, origine: "no-campaign" };
  if (cadenceJours === null) return { jours: JOURS_PAR_DEFAUT, origine: "no-cadence" };
  // ⚠️ Une cadence lue en base reste bornée comme une saisie : une récurrence mal remplie ne doit
  // pas produire une fenêtre de zéro jour (WordPress rendrait une liste vide, indiscernable d'une
  // période sans publication) ni de trois ans.
  return { jours: Math.min(90, Math.max(1, Math.trunc(cadenceJours))), origine: "cadence" };
}

/**
 * L'écart, en jours, entre l'envoi PRÉCÉDENT de la campagne et celui qu'on prépare.
 *
 * C'est ce qui rend vraie la promesse « les plus lus depuis la dernière lettre » : une
 * hebdomadaire donne sept, une campagne du lundi et du vendredi donne quatre puis trois — donc
 * aucun article n'est compté deux fois d'un envoi à l'autre, ce qu'une fenêtre fixe de sept jours
 * ferait à chaque fois.
 *
 * ⛔ ON FILTRE STRICTEMENT AVANT `scheduledAt`. La fonction `campaign_occurrences` a une borne
 * haute INCLUSIVE (vérifié le 03/09 : demander `p_to = 2026-09-06T23:00Z` rend bien l'occurrence
 * de cet instant), donc l'occurrence courante figure dans la liste. La garder produirait un écart
 * de zéro jour — et une fenêtre vide, indiscernable d'une période sans publication.
 *
 * ⚠️ `null` = aucune occurrence antérieure trouvée. Ce n'est PAS un cas courant : la fonction
 * génère les occurrences théoriques même avant l'ancre de la récurrence (vérifié le 03/09 : une
 * ancre au 06/09 rend quand même les dimanches depuis juin), donc un premier envoi a bien un
 * prédécesseur théorique. `null` signale une récurrence non armée ou une fenêtre mal demandée.
 *
 * ⚠️ `Math.round` et pas un calcul de jours calendaires : un changement d'heure d'été fait un écart
 * de 3,96 ou 4,04 jours entre deux occurrences hebdomadaires. L'arrondi rend l'intention.
 */
export function ecartDeCadence(firesAt: string[], scheduledAt: string): number | null {
  const cible = Date.parse(scheduledAt);
  if (!Number.isFinite(cible)) return null;

  let precedente = Number.NEGATIVE_INFINITY;
  for (const f of firesAt) {
    const t = Date.parse(f);
    if (Number.isFinite(t) && t < cible && t > precedente) precedente = t;
  }
  if (precedente === Number.NEGATIVE_INFINITY) return null;

  const jours = Math.round((cible - precedente) / 86_400_000);
  // Deux occurrences le même jour (une campagne du matin et du soir) ne font pas une fenêtre de
  // zéro jour : on rend `null` et l'appelant retombe sur son défaut, en le disant.
  return jours >= 1 ? jours : null;
}

/** Les quatre bornes d'un classement par vues — cf. `fenetreClassement`. */
export interface FenetreClassement {
  /** `after` de l'API WordPress : début de la fenêtre de PUBLICATION. */
  apres: string;
  /** `before` de l'API WordPress : fin de J−2, au-delà l'entrepôt n'a rien ingéré. */
  avant: string;
  /** Borne basse passée à la RPC d'audience. Alignée sur `apres`, par construction. */
  du: string;
  /** Borne haute passée à la RPC. Le SQL la ramène à J−2 de toute façon. */
  au: string;
  /** Jours de publication réellement couverts. Sert à l'écran, qui doit dire ce qu'il classe. */
  jours: number;
  /**
   * Borne haute de la ZONE FRAÎCHE : maintenant. La zone fraîche va de `avant` (J−2) à ici — ce
   * que l'entrepôt ne saura mesurer que dans deux jours, et que le mode mixte sert en s'appuyant
   * sur la date de publication seule.
   *
   * ⚠️ Il n'y a délibérément PAS de champ `fraisApres` : la frontière est `avant`, exactement.
   * Deux noms pour une même borne finiraient par diverger — c'est la faute que cette fonction
   * existe pour empêcher.
   */
  fraisAvant: string;
  /**
   * La MÊME limite que `avant`, mais exprimée en UTC — pour comparer des dates de publication,
   * jamais pour interroger WordPress.
   *
   * ⛔ POURQUOI DEUX REPÈRES POUR UNE SEULE LIMITE. `avant` part dans `before` et WordPress
   * l'interprète dans le fuseau du SITE. `FeedCandidate.publishedAt`, lui, vient de
   * `toIsoUtc(post.date_gmt)` : c'est de l'UTC. Comparer l'un à l'autre décalerait la frontière de
   * trois heures chez northwind-sports (UTC−3), et rangerait tout article publié en soirée dans le mauvais
   * seau — mesuré comme frais, ou frais classé sur des vues qu'il n'a pas. Les deux champs ne
   * divergent pas : ils décrivent la même limite dans deux référentiels, et c'est écrit ici.
   */
  frontiereFraicheUtc: string;
}

/**
 * Le retard de l'entrepôt d'audience, en jours. C'est LUI qui décide si une cadence peut être
 * servie par des « plus lus » — pas un seuil choisi à la main.
 *
 * Mesuré le 01/09/2026 : J−1 est tronqué de 64 à 67 % chez northwind-sports et harbor-tech (mais PAS chez
 * copper-kettle, donc un contrôle sur cette seule marque conclurait à tort que tout va bien).
 * Le plus récent jour honnête est J−2.
 */
export const RETARD_ENTREPOT_JOURS = 2;

/**
 * Une cadence peut-elle être servie par un classement de vues, ou seulement par des articles frais ?
 *
 * ⛔ LE SEUIL EST DÉDUIT, PAS CHOISI. Une lettre quotidienne classée par vues parlerait d'articles
 * publiés il y a deux à trois jours : plus vieux que son propre rythme, et déjà lus par l'abonné
 * qui reçoit tous les jours. Dès que la cadence dépasse le retard de l'entrepôt, ce décalage
 * redevient une fraction acceptable de la période — une hebdomadaire couvre sept jours dont deux
 * d'angle mort, pas l'inverse.
 *
 * Écrire « si cadence < 3 » aurait donné le même résultat aujourd'hui et serait devenu faux le jour
 * où l'ingestion gagne ou perd un jour, sans que personne ne fasse le lien.
 */
export function cadencePeutClasserParVues(joursDeCadence: number): boolean {
  return Math.trunc(joursDeCadence) > RETARD_ENTREPOT_JOURS;
}

/** Le mode réellement appliqué, et s'il diffère de celui qui a été demandé. */
export interface ModeDeSelection {
  mode: "date" | "views" | "mixed";
  /**
   * `true` quand le mélange a été DEMANDÉ mais n'a pas pu être composé, la cadence étant trop
   * courte — le bloc retombe alors sur ce qu'il demandait sans la case (`views`, ou `date`).
   *
   * ⛔ CE DRAPEAU DOIT REMONTER JUSQU'À L'ÉCRAN ET AU JOURNAL. Un mélange demandé qui ne se produit
   * pas est indiscernable d'un mélange jamais demandé : l'auteur croirait avoir armé une règle qui
   * ne s'applique pas, et chercherait la panne dans l'entrepôt.
   */
  degrade: boolean;
}

/**
 * Traduit ce que le MODÈLE demande (`orderby`) et ce que la CAMPAGNE veut (`mixLatest`) en un mode
 * réellement applicable, selon la cadence.
 *
 * ⭐ QUI DÉCIDE QUOI (arbitrage d'Alix du 04/09/2026). Le modèle dit **comment classer** — les plus
 * récents, ou les plus vus. La campagne dit **s'il faut compléter** avec les articles des 48 h que
 * l'entrepôt ne sait pas encore mesurer. Le réglage vit dans la campagne parce qu'un modèle sert
 * PLUSIEURS campagnes — « Friday NL TW » et « Resumo da rodada » partagent la version 509c87c3 — et
 * qu'Alix veut le mélange sur l'une et pas sur l'autre. Un réglage posé dans le document les
 * toucherait ensemble.
 *
 * ⛔ LA CASE NE PROMEUT QUE LES BLOCS DÉJÀ CLASSÉS PAR VUES. Forcer un bloc « les plus récents »
 * exigerait une propriété d'audience élue sur la marque, que goalpost-weekly n'a plus depuis le
 * 16/08 : la case transformerait des blocs qui fonctionnent en refus. Une porte qui condamne en
 * masse n'est pas un réglage.
 *
 * ⚠️ `orderby: "mixed"` est un HÉRITAGE du 03/09, conservé pour ne casser aucun document : l'option
 * a quitté l'inspecteur, mais le schéma l'accepte encore. Aucun conflit n'est possible entre les
 * deux entrées — ce sont deux façons de dire oui, pas deux avis contraires à départager.
 *
 * ⭐ LE SEUIL EST DÉDUIT, PAS CHOISI : il découle du retard de l'entrepôt
 * (`cadencePeutClasserParVues`). Une quotidienne mélangée parlerait d'articles publiés il y a deux
 * jours — plus vieux que son propre rythme, et déjà lus par l'abonné d'hier.
 *
 * ⛔ ET LA DÉGRADATION RAMÈNE AU MODE DU BLOC, PAS À `date`. Une campagne quotidienne dont la case
 * est cochée perd le MÉLANGE, jamais le classement par vues que le modèle demandait : la case
 * n'ajoute qu'une chose, elle ne doit pas pouvoir en retirer une autre.
 *
 * ⚠️ CADENCE INCONNUE ⇒ ON SERT CE QUI EST DEMANDÉ. `undefined` (aucune campagne) comme `null`
 * (campagne sans récurrence armée) veulent dire « on ne peut pas prouver que la lettre est
 * quotidienne » — et dégrader retirerait en silence une règle que quelqu'un a posée. Les deux cas
 * restent distingués ailleurs, par `joursDeFenetre().origine`, qui les affiche à l'écran.
 */
/**
 * Le mélange est-il demandé, par le modèle ou par la campagne ?
 *
 * ⛔ EXPORTÉE POUR QU'IL N'Y AIT QU'UNE SEULE DÉFINITION. Les appelants en ont besoin AVANT
 * `modeDeSelection` : la lecture de cadence coûte un aller-retour en base et ne doit être payée que
 * si elle peut changer quelque chose. Recopier la condition chez eux ferait exactement ce que ce
 * fichier existe pour empêcher — deux endroits qui décident la même chose, et qui finissent par ne
 * plus la décider pareil.
 */
export function melangeDemande(
  orderby: "date" | "views" | "mixed" | undefined,
  mixLatest?: boolean | null,
): boolean {
  return orderby === "mixed" || (orderby === "views" && mixLatest === true);
}

export function modeDeSelection(
  orderby: "date" | "views" | "mixed" | undefined,
  cadenceJours: number | null | undefined,
  mixLatest?: boolean | null,
): ModeDeSelection {
  /** Ce que le bloc rend quand le mélange n'a pas lieu — le mode que le MODÈLE demandait. */
  const base: "date" | "views" = orderby === "views" ? "views" : "date";

  if (!melangeDemande(orderby, mixLatest)) return { mode: base, degrade: false };
  if (cadenceJours === undefined || cadenceJours === null) return { mode: "mixed", degrade: false };
  return cadencePeutClasserParVues(cadenceJours) ? { mode: "mixed", degrade: false } : { mode: base, degrade: true };
}

/**
 * La fenêtre complète d'un classement par vues : ce qu'on RÉCOLTE et ce qu'on MESURE, décidés
 * ensemble, en un seul endroit.
 *
 * ⛔ LES DEUX BORNES DOIVENT ÊTRE ALIGNÉES, et c'est la raison d'être de cette fonction. Récolter
 * les articles publiés depuis J−9 tout en ne comptant leurs vues qu'à partir de J−7 amputerait
 * chaque article de ses deux PREMIERS jours — c'est-à-dire de ses meilleurs (mesuré le 01/09 :
 * 97 vues moyennes à un jour d'exposition contre 32 à sept). Le classement resterait plausible et
 * serait faux, sans que rien ne le signale. Deux appels séparés à `fenetreParDefaut` et
 * `bornePublicationMesurable` laissaient exactement cette divergence possible.
 *
 * ⚠️ LA FENÊTRE EST DÉCALÉE, PAS RACCOURCIE. Une hebdomadaire classe J−9 → J−2 : sept jours
 * pleins, décalés de deux, parce que l'audience s'arrête à J−2. Couper à J−2 sans décaler la borne
 * basse donnerait cinq jours sous une étiquette qui en promet sept. Le recouvrement de deux jours
 * avec l'envoi précédent est absorbé par l'anti-répétition, dont la fenêtre est bien plus longue.
 *
 * ⚠️ Ces bornes sont en UTC quand `event_date` est un jour dans le fuseau de reporting de la
 * propriété GA4 — que rien n'expose. Sur sept jours l'écart d'un jour partiel ne change pas
 * l'ordre ; il le changerait pour une fenêtre d'un seul jour, que ce mode ne sert pas.
 *
 * ⚠️ MESURÉ LE 03/09/2026, ET CE N'EST PAS UN DÉFAUT : WordPress interprète `after`/`before` dans
 * le fuseau du SITE, pas en UTC. Une fenêtre posée à `2026-09-01T23:59:59` ramène donc chez northwind-sports
 * (UTC−3) des articles dont le `date_gmt` va jusqu'à `2026-09-02T02:45` — huit jours calendaires
 * UTC pour sept jours locaux. La durée annoncée est juste ; c'est le repère qui change. Et pour une
 * lettre adressée aux lecteurs d'un site, « sept jours dans le fuseau du site » est le découpage
 * que l'auteur a en tête. Une correction demanderait de connaître le fuseau de chaque source, que
 * `wp_source` ne porte pas.
 */
export function fenetreClassement(maintenant: Date, jours = 7): FenetreClassement {
  const j = Math.max(1, Math.trunc(jours));
  const avant = bornePublicationMesurable(maintenant);

  // `apres` est la FIN du jour qui précède la fenêtre : `after` étant strictement supérieur, la
  // fenêtre commence au premier instant du jour suivant et compte donc exactement `j` jours.
  const debut = new Date(maintenant);
  debut.setUTCDate(debut.getUTCDate() - (j + 2));
  const apres = `${debut.toISOString().slice(0, 10)}T23:59:59`;

  return {
    apres,
    avant,
    // La mesure part du jour de `apres`, donc un jour AVANT le premier jour publié. Cette marge
    // d'un jour est sans effet — aucun article du pool n'existait encore — et elle garantit de ne
    // pas perdre les premières heures d'un article publié juste après la borne, dont `event_date`
    // peut tomber la veille selon le fuseau de reporting de la propriété.
    du: apres.slice(0, 10),
    au: avant.slice(0, 10),
    jours: j,
    /**
     * ⚠️ Instant courant, tronqué à la seconde et SANS suffixe `Z`. WordPress lit `before` dans le
     * fuseau du SITE : une borne portant un fuseau explicite serait convertie, alors qu'on veut
     * simplement dire « jusqu'à maintenant ». Le pire cas est une borne de quelques heures dans le
     * futur local, qui n'exclut rien — exactement l'effet recherché.
     */
    fraisAvant: maintenant.toISOString().slice(0, 19),
    // Même jour que `avant`, lu en UTC. L'écart résiduel avec le fuseau réel du site est de
    // quelques heures et concerne les seuls articles publiés en pleine nuit ; ce qui compte est que
    // les deux côtés de la comparaison soient dans le MÊME référentiel.
    frontiereFraicheUtc: `${avant.slice(0, 10)}T23:59:59Z`,
  };
}
