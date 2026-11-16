import { describe, expect, test } from "bun:test";
import {
  derniereVersionParModele,
  groupesDeFuseaux,
  isoToZonedFields,
  timeZoneOptions,
  zoneCanonique,
  zoneOffsetLabel,
  zoneOffsetMs,
  etatDUnePonctuelle,
  pastilleDeCampagne,
  zonedToIso,
  type PublishedVersion,
} from "./shared";

/**
 * ⛔ CE QUE CE BANC EXISTE POUR EMPÊCHER — quatre erreurs qui ne se voient pas à l'écran :
 *
 *  1. planifier dans le fuseau du RÉDACTEUR au lieu de celui du lecteur. C'est le défaut
 *     d'origine : `new Date("2026-08-20T10:00")` lit l'heure du navigateur, donc une campagne
 *     chilienne préparée depuis São Paulo partait une heure trop tôt ;
 *  2. croire qu'un pays a UN décalage. Santiago vaut −04:00 en hiver austral et −03:00 en été :
 *     l'écart Chili/Brésil vaut 1 h une partie de l'année et **0 le reste**, donc « retirer une
 *     heure à la main » est faux la moitié du temps ;
 *  3. convertir en une seule passe. Près d'une bascule, le décalage lu « à l'heure murale » n'est
 *     pas celui de l'instant visé — une heure d'erreur, deux week-ends par an ;
 *  4. rendre 0 pour un fuseau inconnu, ce qui ferait passer une heure locale pour de l'UTC.
 *
 * ⚠️ Les instants de bascule ci-dessous ont été MESURÉS dans la base tzdata de l'environnement
 * (Santiago passe à −03:00 le 2026-09-06 à 04:00 UTC), jamais déduits des règles de mémoire.
 */

const SANTIAGO = "America/Santiago";
const SAO_PAULO = "America/Sao_Paulo";
const LONDON = "Europe/London";

describe("zonedToIso — le fuseau choisi décide de l'instant", () => {
  test("la MÊME heure murale donne des instants différents selon le fuseau", () => {
    // Le cas d'Alix : site chilien, navigateur brésilien, hiver austral.
    expect(zonedToIso("2026-07-15", "10:00", SANTIAGO)).toBe("2026-07-15T14:00:00.000Z");
    expect(zonedToIso("2026-07-15", "10:00", SAO_PAULO)).toBe("2026-07-15T13:00:00.000Z");
  });

  test("⛔ et en été austral l'écart entre les deux TOMBE À ZÉRO", () => {
    // C'est ce qui condamne toute correction « d'une heure » appliquée à la main.
    expect(zonedToIso("2026-12-15", "10:00", SANTIAGO)).toBe("2026-12-15T13:00:00.000Z");
    expect(zonedToIso("2026-12-15", "10:00", SAO_PAULO)).toBe("2026-12-15T13:00:00.000Z");
  });

  test("⭐ la double passe : une heure murale juste APRÈS une bascule", () => {
    // Bascule mesurée : 2026-09-06 04:00 UTC, Santiago passe de −04:00 à −03:00.
    // 01:00 heure murale se lit donc avec le décalage d'ÉTÉ : 01:00 + 03:00 = 04:00 UTC.
    // ⛔ Une implémentation à une seule passe lirait le décalage d'HIVER (−04:00) et rendrait
    // 05:00 UTC — une heure de trop, sur la seule nuit de l'année où c'est indétectable.
    expect(zonedToIso("2026-09-06", "01:00", SANTIAGO)).toBe("2026-09-06T04:00:00.000Z");
  });

  test("de part et d'autre de la bascule, en journée", () => {
    expect(zonedToIso("2026-09-05", "12:00", SANTIAGO)).toBe("2026-09-05T16:00:00.000Z");
    expect(zonedToIso("2026-09-06", "12:00", SANTIAGO)).toBe("2026-09-06T15:00:00.000Z");
  });

  test("Londres change d'heure dans l'autre sens", () => {
    expect(zonedToIso("2026-07-15", "10:00", LONDON)).toBe("2026-07-15T09:00:00.000Z");
    expect(zonedToIso("2026-12-15", "10:00", LONDON)).toBe("2026-12-15T10:00:00.000Z");
  });

  test("UTC est l'identité", () => {
    expect(zonedToIso("2026-07-15", "10:00", "UTC")).toBe("2026-07-15T10:00:00.000Z");
  });

  test("heure absente ⇒ minuit dans le fuseau demandé, pas minuit UTC", () => {
    expect(zonedToIso("2026-07-15", "", SANTIAGO)).toBe("2026-07-15T04:00:00.000Z");
  });

  test("⛔ entrées invalides : null, jamais une date inventée", () => {
    expect(zonedToIso("", "10:00", SANTIAGO)).toBeNull();
    expect(zonedToIso("20/08/2026", "10:00", SANTIAGO)).toBeNull();
    expect(zonedToIso("2026-07-15", "10:00", "Mars/Olympus_Mons")).toBeNull();
  });
});

describe("isoToZonedFields — rouvrir une campagne ne la déplace pas", () => {
  test("aller-retour : ce qu'on saisit est ce qu'on relit", () => {
    for (const [date, time, zone] of [
      ["2026-07-15", "10:00", SANTIAGO],
      ["2026-12-15", "23:45", SAO_PAULO],
      ["2026-09-06", "01:00", SANTIAGO],
      ["2026-12-15", "10:00", LONDON],
    ] as const) {
      const iso = zonedToIso(date, time, zone);
      expect(iso).not.toBeNull();
      expect(isoToZonedFields(iso as string, zone)).toEqual({ date, time });
    }
  });

  test("le même instant se lit différemment selon le fuseau", () => {
    const iso = "2026-07-15T14:00:00.000Z";
    expect(isoToZonedFields(iso, SANTIAGO)).toEqual({ date: "2026-07-15", time: "10:00" });
    expect(isoToZonedFields(iso, SAO_PAULO)).toEqual({ date: "2026-07-15", time: "11:00" });
  });

  test("⛔ un instant illisible ou un fuseau inconnu ⇒ null", () => {
    expect(isoToZonedFields("pas une date", SANTIAGO)).toBeNull();
    expect(isoToZonedFields("2026-07-15T14:00:00.000Z", "Mars/Olympus_Mons")).toBeNull();
  });
});

describe("zoneOffsetMs / zoneOffsetLabel", () => {
  test("⛔ un fuseau inconnu rend null, PAS zéro", () => {
    // Un 0 silencieux ferait passer une heure locale pour de l'UTC, sans rien afficher d'anormal.
    expect(zoneOffsetMs(Date.parse("2026-07-15T12:00:00Z"), "Mars/Olympus_Mons")).toBeNull();
  });

  test("le décalage dépend de l'INSTANT, pas seulement du fuseau", () => {
    const hiver = zoneOffsetMs(Date.parse("2026-07-15T12:00:00Z"), SANTIAGO);
    const ete = zoneOffsetMs(Date.parse("2026-12-15T12:00:00Z"), SANTIAGO);
    expect(hiver).toBe(-4 * 3_600_000);
    expect(ete).toBe(-3 * 3_600_000);
  });

  test("le libellé porte le signe et la date", () => {
    expect(zoneOffsetLabel(SANTIAGO, Date.parse("2026-07-15T12:00:00Z"))).toBe("UTC−04");
    expect(zoneOffsetLabel(SANTIAGO, Date.parse("2026-12-15T12:00:00Z"))).toBe("UTC−03");
    expect(zoneOffsetLabel("UTC", Date.parse("2026-07-15T12:00:00Z"))).toBe("UTC+00");
    expect(zoneOffsetLabel("Asia/Kolkata", Date.parse("2026-07-15T12:00:00Z"))).toBe("UTC+05:30");
    expect(zoneOffsetLabel("Mars/Olympus_Mons", Date.now())).toBe("");
  });
});

describe("timeZoneOptions", () => {
  test("le fuseau du navigateur vient en tête, sans doublon", () => {
    const { common, rest } = timeZoneOptions(SAO_PAULO);
    expect(common[0]).toBe(SAO_PAULO);
    expect(common.filter((z) => z === SAO_PAULO)).toHaveLength(1);
    expect(common).toContain(SANTIAGO);
    expect(rest).not.toContain(SAO_PAULO);
  });

  test("⚠️ la liste courte n'est pas une limite : la liste IANA complète suit", () => {
    const { common, rest } = timeZoneOptions("UTC");
    expect(rest.length).toBeGreaterThan(100);
    expect(rest).toContain("Asia/Tokyo");
    // Aucun fuseau ne figure dans les deux groupes : le select n'affiche jamais deux fois le même.
    expect(rest.filter((z) => common.includes(z))).toHaveLength(0);
  });
});

/*
 * ⛔ LE FUSEAU LISTÉ DEUX FOIS — l'un des dédoublements signalés par Alix le 18/09/2026.
 *
 * Le système peut rendre un ALIAS historique (`Europe/Kiev`, `Asia/Calcutta`) là où la liste IANA
 * du moteur ne connaît que le nom primaire. Comparés comme des chaînes, les deux passent pour deux
 * fuseaux : la même ville s'affichait dans « Where this brand publishes » ET dans « All timezones »,
 * et deux valeurs différentes pouvaient être écrites en base pour le même endroit.
 *
 * ⭐⛔ CE QUI A ÉTÉ MESURÉ ICI, ET QUI CONTREDIT L'INTUITION : sous JavaScriptCore (bun),
 * `resolvedOptions().timeZone` rend l'alias TEL QUEL et `supportedValuesOf` liste `Europe/Kiev`
 * SANS `Europe/Kyiv` — l'inverse de V8. Ces tests n'affirment donc JAMAIS « Kiev devient Kyiv » :
 * ils vérifient la propriété qui doit tenir dans les deux moteurs — un fuseau, une seule entrée.
 */
describe("zoneCanonique — deux noms du même endroit ne font qu'une entrée", () => {
  test("un fuseau canonique est rendu inchangé, et la fonction est idempotente", () => {
    for (const zone of [SANTIAGO, SAO_PAULO, LONDON, "UTC", "Asia/Tokyo"]) {
      expect(zoneCanonique(zone)).toBe(zone);
      expect(zoneCanonique(zoneCanonique(zone))).toBe(zoneCanonique(zone));
    }
  });

  test("un alias historique se résout vers un fuseau que le moteur liste vraiment", () => {
    // La propriété qui compte : quel que soit le moteur, la forme canonique d'un alias figure dans
    // la liste IANA — c'est elle qui garantit qu'il n'y aura pas deux entrées pour un endroit.
    const listes = Intl.supportedValuesOf("timeZone");
    for (const alias of ["Europe/Kiev", "Asia/Calcutta", "America/Buenos_Aires"]) {
      expect(listes).toContain(zoneCanonique(alias));
    }
  });

  test("⛔ un fuseau inconnu est rendu TEL QUEL, jamais remplacé par un fuseau plausible", () => {
    // Inventer un repli ferait passer une erreur de saisie pour un choix valide, à des heures près.
    expect(zoneCanonique("Mars/Olympus_Mons")).toBe("Mars/Olympus_Mons");
    expect(zoneCanonique("")).toBe("");
  });
});

describe("timeZoneOptions — un endroit, une seule ligne dans le select", () => {
  test("⛔ un navigateur qui rend un ALIAS ne fait pas apparaître le fuseau deux fois", () => {
    const { common, rest } = timeZoneOptions("Europe/Kiev");
    const tout = [...common, ...rest];
    // La forme retenue en tête est canonique, donc comparable à ce que la liste IANA contient…
    expect(common[0]).toBe(zoneCanonique("Europe/Kiev"));
    // …et elle n'apparaît nulle part ailleurs.
    expect(tout.filter((z) => z === common[0])).toHaveLength(1);
    expect(rest).not.toContain(common[0]);
  });

  test("⛔ AUCUN fuseau n'est listé deux fois, alias compris, sur toute la liste", () => {
    // La garde générale : c'est elle qui tomberait si la déduplication repassait à la chaîne brute.
    const { common, rest } = timeZoneOptions("Asia/Calcutta");
    const canoniques = [...common, ...rest].map(zoneCanonique);
    expect(canoniques).toHaveLength(new Set(canoniques).size);
  });
});

describe("groupesDeFuseaux — le moteur où le défaut VIT, rejoué", () => {
  /*
   * ⛔ CE BLOC EST LA SEULE PREUVE DU CORRECTIF. Les tests au-dessus s'exécutent dans un moteur
   * (JavaScriptCore) qui ne mélange jamais alias et noms primaires : ils passent avec le code
   * fautif comme avec le code corrigé. Ici, la canonicalisation et la liste sont INJECTÉES pour
   * rejouer V8 — système en `Europe/Kiev`, liste IANA en `Europe/Kyiv`.
   */
  const CANON_V8 = (zone: string) =>
    zone === "Europe/Kiev" ? "Europe/Kyiv" : zone === "Asia/Calcutta" ? "Asia/Kolkata" : zone;
  const LISTE_V8 = ["Europe/Kyiv", "Asia/Kolkata", "Asia/Tokyo", "America/Santiago", "UTC"];

  test("⛔ le fuseau du système en ALIAS n'apparaît pas une seconde fois sous son nom primaire", () => {
    const { common, rest } = groupesDeFuseaux("Europe/Kiev", LISTE_V8, CANON_V8);
    // Ce qui est proposé en tête est le nom primaire — celui qui sera écrit en base.
    expect(common[0]).toBe("Europe/Kyiv");
    // ⛔ La ligne qui tombe si la déduplication repasse à la chaîne brute : `Europe/Kyiv` revenait
    // alors dans « All timezones », soit la même ville deux fois dans le même select.
    expect(rest).not.toContain("Europe/Kyiv");
    expect([...common, ...rest].filter((z) => z === "Europe/Kyiv")).toHaveLength(1);
  });

  test("les fuseaux de la marque restent en tête et ne sont pas répétés dans la liste longue", () => {
    const { common, rest } = groupesDeFuseaux("Europe/Kiev", LISTE_V8, CANON_V8);
    expect(common).toContain("America/Santiago");
    expect(rest).not.toContain("America/Santiago");
    expect(rest).toContain("Asia/Tokyo");
  });

  test("un alias DANS la liste des marchés ne crée pas non plus de doublon", () => {
    const { common, rest } = groupesDeFuseaux("Asia/Calcutta", LISTE_V8, CANON_V8);
    expect(common[0]).toBe("Asia/Kolkata");
    expect(rest).not.toContain("Asia/Kolkata");
  });

  test("⛔ un fuseau vide ne prend pas une ligne du select", () => {
    const { common } = groupesDeFuseaux("", LISTE_V8, CANON_V8);
    expect(common).not.toContain("");
    expect(common[0]).toBe("America/Santiago");
  });
});


/**
 * ⛔ LE CHOIX DE VERSION A DISPARU DES DEUX ÉCRANS DE CAMPAGNE (décision d’Alix, 18/09/2026).
 * C’est cette fonction, et elle seule, qui décide désormais QUEL CONTENU PART. Deux fautes y
 * coûteraient un envoi réel à toute une liste :
 *
 *  1. prendre « la première ligne du tableau » au lieu du plus grand numéro — une campagne partirait
 *     sur un contenu périmé le jour où le tri de `listPublishedVersions` changerait ;
 *  2. étiqueter deux modèles homonymes à l’identique — le menu proposerait deux lignes
 *     rigoureusement indiscernables dont une seule est la bonne.
 */
describe("derniereVersionParModele", () => {
  const v = (
    templateId: string,
    version: number,
    templateName: string,
    versionId = `${templateId}-v${version}`,
  ): PublishedVersion => ({
    versionId,
    templateId,
    templateName,
    version,
    subject: "",
    preheader: "",
    sizeBytes: 1000,
    publishedAt: null,
  });

  test("⛔ le MAXIMUM, pas la première ligne reçue", () => {
    // Ordre volontairement décroissant PUIS croissant : un `find` naif tomberait sur v1.
    const r = derniereVersionParModele([v("t1", 3, "Hebdo"), v("t1", 1, "Hebdo"), v("t1", 2, "Hebdo")]);
    expect(r).toHaveLength(1);
    expect(r[0]!.version).toBe(3);
  });

  test("⛔ MUTATION QUI DOIT LE TUER : lire l’ordre du tableau (`if (!courant)` seul)", () => {
    // La dernière publiée est ici la PREMIÈRE du tableau : garder « la première vue » rendrait v9…
    // et le test passerait. Le cas d’au-dessus, lui, tombe. Les deux ensemble tiennent la règle.
    const r = derniereVersionParModele([v("t1", 9, "Hebdo"), v("t1", 10, "Hebdo")]);
    expect(r[0]!.version).toBe(10);
  });

  test("un modèle par entrée, jamais une version en double", () => {
    const r = derniereVersionParModele([
      v("t1", 2, "Hebdo"),
      v("t1", 1, "Hebdo"),
      v("t2", 5, "Quotidienne"),
    ]);
    expect(r.map((x) => x.templateId).sort()).toEqual(["t1", "t2"]);
  });

  test("⛔ DEUX MODÈLES HOMONYMES restent distinguables — le cas Copper Kettle", () => {
    const r = derniereVersionParModele([
      v("aaaaaaaa-1111", 2, "Boletín semanal"),
      v("bbbbbbbb-2222", 7, "Boletín semanal"),
    ]);
    expect(r).toHaveLength(2);
    expect(new Set(r.map((x) => x.etiquette)).size).toBe(2);
    for (const x of r) expect(x.etiquette).toContain(x.templateId.slice(0, 8));
  });

  test("un nom UNIQUE ne porte aucun identifiant — on n’enlaidit que ce qui l’exige", () => {
    const r = derniereVersionParModele([v("t1", 1, "Hebdo"), v("t2", 1, "Quotidienne")]);
    for (const x of r) expect(x.etiquette).not.toContain("(");
  });

  test("tri par ÉTIQUETTE, celle qui s’affiche", () => {
    const r = derniereVersionParModele([v("t1", 1, "Zeta"), v("t2", 1, "Alpha")]);
    expect(r.map((x) => x.etiquette)).toEqual(["Alpha", "Zeta"]);
  });

  test("aucune version publiée : liste vide, et surtout pas une entrée fantôme", () => {
    expect(derniereVersionParModele([])).toEqual([]);
  });

  test("l’identifiant rendu est bien celui de la version, pas celui du modèle", () => {
    // C’est `versionId` qui part à la route (`templateVersionId`). Les confondre ferait refuser le
    // verrou avec « version introuvable » sur une campagne pourtant complète.
    const r = derniereVersionParModele([v("t1", 4, "Hebdo", "version-xyz")]);
    expect(r[0]!.versionId).toBe("version-xyz");
    expect(r[0]!.templateId).toBe("t1");
  });
});

/**
 * ⛔ « J'AI FAIT UNE CAMPAGNE ONE SHOT ET RIEN NE S'EST ENVOYÉ » (Alix, 18/09/2026).
 *
 * La colonne « Next / sent » affichait `sentAt ?? scheduledAt`, sans jamais regarder si c'était
 * arrivé : « c'est parti », « ça va partir » et « l'heure est passée et rien n'est parti »
 * produisaient rigoureusement le même pixel gris. Le troisième est une panne.
 *
 * Quatre choses peuvent se tromper ici sans lever la moindre erreur, et ce banc les tient toutes :
 *  1. comparer des CHAÎNES au lieu d'instants — juste en test, faux en production ;
 *  2. alerter dès l'heure dite, donc crier au loup sur des campagnes saines ;
 *  3. annoncer « bloqué » sur une campagne que quelqu'un a déjà arrêtée ou qui part en ce moment ;
 *  4. ignorer `enqueuedAt`, c'est-à-dire le seul fait qui prouve que la file a été remplie.
 */
describe("etatDUnePonctuelle — la date seule ne dit pas si c'est parti", () => {
  const MAINTENANT = "2026-09-18T21:30:00.000Z";
  const c = (over: Partial<Parameters<typeof etatDUnePonctuelle>[0]> = {}) => ({
    status: "scheduled",
    scheduledAt: null,
    sentAt: null,
    enqueuedAt: null,
    ...over,
  });

  test("envoyée : c'est la date d'envoi qui compte, pas celle du plan", () => {
    const e = etatDUnePonctuelle(
      c({ status: "sent", scheduledAt: "2026-09-18T20:45:00Z", sentAt: "2026-09-18T20:46:12Z" }),
      MAINTENANT,
    );
    expect(e).toEqual({ quoi: "envoye", quand: "2026-09-18T20:46:12Z" });
  });

  test("aucune date : rien à dire, et surtout pas une alerte", () => {
    expect(etatDUnePonctuelle(c(), MAINTENANT).quoi).toBe("rien");
  });

  test("date à venir : on affiche la date, point", () => {
    const e = etatDUnePonctuelle(c({ scheduledAt: "2026-09-19T08:00:00Z" }), MAINTENANT);
    expect(e).toEqual({ quoi: "prevu", quand: "2026-09-19T08:00:00Z" });
  });

  /** ⛔ LE CAS D'ALIX : prévue à 20:45, il est 21:30, rien n'est jamais entré en file. */
  test("⛔ heure passée + jamais mise en file = BLOQUÉ", () => {
    const e = etatDUnePonctuelle(c({ scheduledAt: "2026-09-18T20:45:00Z" }), MAINTENANT);
    expect(e).toEqual({ quoi: "bloque", quand: "2026-09-18T20:45:00Z" });
  });

  /**
   * ⛔ MUTATION QUI DOIT LE TUER : ignorer `enqueuedAt` et ne juger que sur la date. La file a été
   * remplie — l'envoi est en cours, ou vient d'avoir lieu. Annoncer « Not queued » dessus enverrait
   * chercher une panne de mise en file là où le problème, s'il existe, est à l'ENVOI. Deux pannes
   * différentes, deux endroits différents.
   */
  test("⛔ heure passée MAIS la file a été remplie : ce n'est pas bloqué", () => {
    const e = etatDUnePonctuelle(
      c({ scheduledAt: "2026-09-18T20:45:00Z", enqueuedAt: "2026-09-18T20:30:00Z" }),
      MAINTENANT,
    );
    expect(e.quoi).toBe("prevu");
  });

  /**
   * ⛔ MUTATION QUI DOIT LE TUER : laisser tomber le test sur le statut. Une campagne en pause a été
   * arrêtée — par le worker avec une raison, ou par un humain. Sa date est passée elle aussi, mais
   * « Not queued » serait un faux diagnostic : la raison existe, et l'écran de détail la porte.
   */
  test("⛔ heure passée mais la campagne a été ARRÊTÉE : ce n'est pas bloqué non plus", () => {
    for (const status of ["paused", "sending", "cancelled", "sent"]) {
      const e = etatDUnePonctuelle(c({ status, scheduledAt: "2026-09-18T20:45:00Z" }), MAINTENANT);
      expect(e.quoi).toBe("prevu");
    }
  });

  /**
   * ⛔⛔ LE DÉLAI DE GRÂCE, ET LE MUTANT QUI DOIT LE TUER : alerter dès `prevu <= maintenant`.
   *
   * Le fan-out tourne sur un cron toutes les 30 min avec 20 min d'avance : à l'heure dite exacte,
   * une file encore vide est NORMALE. Sans ce délai, le badge s'allumerait quelques minutes à chaque
   * envoi sain — et un badge qui se trompe souvent n'est plus lu le jour où il dit vrai.
   */
  test("⛔⛔ à l'heure dite EXACTE, rien n'est annoncé : le cron a encore sa fenêtre", () => {
    const e = etatDUnePonctuelle(c({ scheduledAt: "2026-09-18T21:30:00Z" }), MAINTENANT);
    expect(e.quoi).toBe("prevu");
  });

  test("⛔ et 29 minutes après non plus — la grâce vaut une période de cron entière", () => {
    const e = etatDUnePonctuelle(c({ scheduledAt: "2026-09-18T21:01:00Z" }), MAINTENANT);
    expect(e.quoi).toBe("prevu");
  });

  test("⛔ mais 31 minutes après, oui : le fan-out a EU sa chance", () => {
    const e = etatDUnePonctuelle(c({ scheduledAt: "2026-09-18T20:59:00Z" }), MAINTENANT);
    expect(e.quoi).toBe("bloque");
  });

  /**
   * ⭐⛔⛔ LE CAS QUI TUE UNE COMPARAISON DE CHAÎNES, ET LUI SEUL. PostgREST rend
   * `2026-09-18T21:30:00+00:00` là où `toISOString()` rend `…T21:30:00.000Z` — le MÊME instant. À
   * préfixe égal, '+' (0x2B) est inférieur à '.' (0x2E), donc un `>` lexicographique classerait
   * cette campagne « en retard » alors qu'elle est exactement à l'heure. Le piège : il répond JUSTE
   * tant que les deux côtés viennent de la même source, donc en test et pas en production.
   */
  test("⭐⛔⛔ `+00:00` et `.000Z` désignent le même instant : on compare des INSTANTS", () => {
    const e = etatDUnePonctuelle(c({ scheduledAt: "2026-09-18T21:30:00+00:00" }), MAINTENANT);
    expect(e.quoi).toBe("prevu");
  });

  test("et une date réellement en retard le reste, dans les deux notations", () => {
    expect(etatDUnePonctuelle(c({ scheduledAt: "2026-09-18T20:45:00+00:00" }), MAINTENANT).quoi).toBe("bloque");
    expect(etatDUnePonctuelle(c({ scheduledAt: "2026-09-18T20:45:00.000Z" }), MAINTENANT).quoi).toBe("bloque");
  });

  test("une date illisible n'invente aucune panne", () => {
    const e = etatDUnePonctuelle(c({ scheduledAt: "pas une date" }), MAINTENANT);
    expect(e).toEqual({ quoi: "prevu", quand: "pas une date" });
  });

  test("un instant de référence illisible non plus", () => {
    const e = etatDUnePonctuelle(c({ scheduledAt: "2026-09-18T20:45:00Z" }), "pas une date");
    expect(e.quoi).toBe("prevu");
  });
});

/**
 * LA PASTILLE (0077) — une seule règle pour la liste et la page de campagne.
 *
 * ⛔ MUTATION QUI DOIT TUER CE BANC : oublier l'envoi unique archivé. L'archivage d'un envoi
 * programmé le remet en `draft` : sans ce cas, l'onglet Archived afficherait « Draft ».
 */
describe("pastilleDeCampagne — « Archived » partout, pour une série comme pour un envoi unique", () => {
  const c = (o: Partial<Parameters<typeof pastilleDeCampagne>[0]> = {}) => ({
    status: "draft",
    recurrenceDays: [] as number[],
    recurrenceActive: false,
    archivedAt: null as string | null,
    ...o,
  });

  test("envoi unique archivé (remis en brouillon) ⇒ Archived, gris", () => {
    expect(pastilleDeCampagne(c({ archivedAt: "2026-09-20T08:00:00Z" }))).toEqual({ libelle: "Archived", ton: "grey" });
    expect(pastilleDeCampagne(c({ status: "sent", archivedAt: "2026-09-20T08:00:00Z" })).libelle).toBe("Archived");
  });

  test("série archivée ⇒ Archived ; série active ⇒ Running / Stopped", () => {
    expect(pastilleDeCampagne(c({ recurrenceDays: [1], archivedAt: "2026-09-20T08:00:00Z" })).libelle).toBe("Archived");
    expect(pastilleDeCampagne(c({ recurrenceDays: [1], recurrenceActive: true }))).toEqual({ libelle: "Running", ton: "green" });
    expect(pastilleDeCampagne(c({ recurrenceDays: [1] })).libelle).toBe("Stopped");
  });

  test("active, ponctuelle ⇒ son statut", () => {
    expect(pastilleDeCampagne(c({ status: "scheduled" })).libelle).toBe("Scheduled");
  });
});
