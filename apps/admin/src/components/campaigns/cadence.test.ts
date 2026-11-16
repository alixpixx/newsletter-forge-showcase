/**
 * DIRE UNE CADENCE — le banc du défaut « rien ne se sauvegarde » (18/09/2026), côté lecture.
 *
 * Ces fonctions sont la seule chose qui rende une série VISIBLE. Tant qu'elles n'existaient pas,
 * `/api/campaigns/[id]/recurrence` écrivait huit colonnes qu'aucun écran ne relisait.
 */
import { describe, expect, test } from "bun:test";
import {
  estUneSerie,
  etatDeLaSerie,
  heureDeGel,
  jetonsSansValeurHorsSerie,
  nomsDesJours,
  phraseCadence,
  quandDansLeFuseau,
  statutDeSerie,
  type CadenceLue,
} from "./cadence";

const CADENCE = (p: Partial<CadenceLue> = {}): CadenceLue => ({
  recurrenceDays: [1, 5],
  recurrenceTime: "10:00",
  recurrenceEveryWeeks: 1,
  recurrenceUntil: null,
  recurrenceActive: false,
  timezone: "America/Santiago",
  freezeLeadMinutes: 90,
  editionStart: 1,
  ...p,
});

describe("estUneSerie", () => {
  /**
   * ⛔ MUTATION QUI DOIT LE TUER : faire dépendre la réponse de `recurrenceActive`. Une cadence
   * enregistrée mais pas encore armée EST une série — c'est même exactement l'état qu'il fallait
   * rendre visible, celui où Alix croyait n'avoir rien sauvegardé.
   */
  test("une cadence non armée reste une série", () => {
    expect(estUneSerie(CADENCE({ recurrenceActive: false }))).toBe(true);
  });

  test("sans jours, campagne ponctuelle", () => {
    expect(estUneSerie({ recurrenceDays: [] })).toBe(false);
  });
});

describe("nomsDesJours", () => {
  test("l'ordre de la semaine, pas celui de la saisie", () => {
    expect(nomsDesJours([5, 1])).toBe("Mon and Fri");
  });

  test("trois jours et plus : virgules puis « and »", () => {
    expect(nomsDesJours([1, 3, 7])).toBe("Mon, Wed and Sun");
  });

  test("un seul jour, sans conjonction", () => {
    expect(nomsDesJours([4])).toBe("Thu");
  });

  /** Les doublons et les valeurs hors 1-7 sont des données abîmées, pas des jours. */
  test("doublons et valeurs hors bornes écartés", () => {
    expect(nomsDesJours([1, 1, 0, 8, 2])).toBe("Mon and Tue");
    expect(nomsDesJours([])).toBe("");
  });
});

describe("heureDeGel", () => {
  test("90 minutes avant 10:00", () => {
    expect(heureDeGel("10:00", 90)).toBe("08:30");
  });

  /**
   * ⛔ MUTATION QUI DOIT LE TUER : rendre l'heure sans dire le jour. Un gel affiché « 23:30 » sur
   * un envoi de 00:30 laisserait croire qu'on a jusqu'au soir même, alors que c'est la veille.
   */
  test("un gel qui passe minuit tombe LA VEILLE, et le dit", () => {
    expect(heureDeGel("00:30", 90)).toBe("23:00 the day before");
  });

  /**
   * La base rend `time without time zone` en "10:00:00" ; le formulaire, lui, parle en "10:00".
   * Les deux doivent traverser — c'est la même valeur.
   */
  test("les secondes de PostgreSQL ne bloquent pas le calcul", () => {
    expect(heureDeGel("10:00:00", 90)).toBe("08:30");
  });

  test("sans heure ou sans délai, rien à afficher", () => {
    expect(heureDeGel(null, 90)).toBeNull();
    expect(heureDeGel("10:00", null)).toBeNull();
    expect(heureDeGel("pas une heure", 90)).toBeNull();
  });

  test("un gel nul rend l'heure d'envoi", () => {
    expect(heureDeGel("07:30", 0)).toBe("07:30");
  });
});

describe("phraseCadence", () => {
  /** « Every week » est le cas de 99 % des séries : le répéter noie le reste, on ne le dit pas deux fois. */
  test("intervalle d'une semaine : la phrase reste courte", () => {
    expect(phraseCadence(CADENCE())).toBe("Every week on Mon and Fri at 10:00 (America/Santiago)");
  });

  test("au-delà d'une semaine, l'intervalle est dit", () => {
    expect(phraseCadence(CADENCE({ recurrenceEveryWeeks: 2, recurrenceDays: [4] }))).toBe(
      "Every 2 weeks on Thu at 10:00 (America/Santiago)",
    );
  });

  test("les champs manquants disparaissent au lieu d'afficher « null »", () => {
    expect(phraseCadence(CADENCE({ recurrenceTime: null, timezone: null, recurrenceEveryWeeks: null }))).toBe(
      "Every week on Mon and Fri",
    );
  });

  test("sans jours, la phrase ne prétend pas qu'il y a une cadence", () => {
    expect(phraseCadence(CADENCE({ recurrenceDays: [] }))).toBe("No cadence set");
  });
});

describe("jetonsSansValeurHorsSerie", () => {
  /**
   * ⛔ LE BANC DU MUR SUIVANT (18/09/2026). Ces trois jetons sont lus sur l'OCCURRENCE et nulle part
   * ailleurs (`apps/worker/src/render.ts`) : sur un envoi ponctuel ils s'hydratent en chaîne vide,
   * et si le sujet ne tenait que sur eux, le gate refuse l'envoi en `missing_subject` — après le
   * verrou, après la planification. C'est le mur qui attendait la campagne « Test 3 ».
   */
  test("les trois jetons d'occurrence sont refusés hors série", () => {
    expect(jetonsSansValeurHorsSerie(["first_article"], false)).toEqual(["first_article"]);
    expect(jetonsSansValeurHorsSerie(["article_count", "edition_number"], false)).toEqual([
      "article_count",
      "edition_number",
    ]);
  });

  /**
   * ⛔ MUTATION QUI DOIT LE TUER : ajouter `ai_intro` ou `ai_preheader` à la liste. Elles ont un
   * repli sur la CAMPAGNE (`ctx.campaign_ai_intro`) : elles se remplissent très bien pour un envoi
   * ponctuel, et les refuser interdirait des sujets parfaitement valides.
   */
  test("les jetons qui ont un repli campagne ne sont PAS refusés", () => {
    expect(jetonsSansValeurHorsSerie(["ai_intro", "ai_preheader", "edition_date", "brand"], false)).toEqual([]);
  });

  /** Une série les remplit toutes : la question est « y a-t-il une cadence », pas « est-elle armée ». */
  test("dans une série, rien n'est refusé", () => {
    expect(jetonsSansValeurHorsSerie(["first_article", "edition_number"], true)).toEqual([]);
  });

  test("un sujet sans jeton ne déclenche rien", () => {
    expect(jetonsSansValeurHorsSerie([], false)).toEqual([]);
  });
});

describe("etatDeLaSerie", () => {
  /**
   * ⛔ LE CŒUR DU CORRECTIF. Le planificateur ne lit QUE les campagnes `recurrence_active` : une
   * cadence enregistrée mais jamais démarrée ne crée aucune occurrence. Afficher les deux états de
   * la même façon promettrait des envois qui ne partiront jamais.
   * ⛔ Et les mots sont ceux de l'écran (22/09/2026) : « Running » / « Stopped », plus « Armed ».
   */
  test("démarrée ≠ arrêtée, avec les deux mots de l'écran", () => {
    const arretee = etatDeLaSerie({ recurrenceActive: false });
    const enMarche = etatDeLaSerie({ recurrenceActive: true });
    expect(arretee).toEqual({ arme: false, libelle: "Stopped" });
    expect(enMarche).toEqual({ arme: true, libelle: "Running" });
  });
});

describe("statutDeSerie — ce qui remplace « Draft » dans la pastille", () => {
  const c = (p: Partial<CadenceLue & { status: string }>) => ({ ...CADENCE(), status: "draft", ...p });

  /** Une série vit en `draft` pour toujours : « Draft » sur une série qui envoie se lisait « rien n'est lancé ». */
  test("série en brouillon ⇒ Running / Stopped", () => {
    expect(statutDeSerie(c({ recurrenceActive: true }))?.libelle).toBe("Running");
    expect(statutDeSerie(c({ recurrenceActive: false }))?.libelle).toBe("Stopped");
  });

  test("campagne ponctuelle ⇒ null : le statut ordinaire dit vrai", () => {
    expect(statutDeSerie(c({ recurrenceDays: [] }))).toBeNull();
  });

  // MUTATION QUI DOIT TUER CE TEST : retirer la condition `status !== "draft"`. Une série annulée
  // afficherait « Running » ou « Stopped » au lieu de « Cancelled ».
  test("série annulée ⇒ null : « Cancelled » n'est pas remplacé", () => {
    expect(statutDeSerie(c({ status: "cancelled", recurrenceActive: true }))).toBeNull();
  });

  // ⛔ 0077 : une série archivée dit « Archived », jamais « Stopped » (qui invite à la redémarrer
  // depuis sa page, geste refusé tant qu'elle est rangée) ni « Running ».
  test("série archivée ⇒ « Archived », quel que soit son statut ou son interrupteur", () => {
    for (const status of ["draft", "cancelled", "paused"]) {
      for (const recurrenceActive of [true, false]) {
        const s = statutDeSerie({ ...c({ status, recurrenceActive }), archivedAt: "2026-09-20T08:00:00Z" });
        expect(s).toEqual({ arme: false, libelle: "Archived" });
      }
    }
    expect(statutDeSerie({ ...c({}), archivedAt: null })?.libelle).toBe("Stopped");
  });
});

describe("quandDansLeFuseau — l'heure promise aux abonnés, pas celle du navigateur", () => {
  // Le Chili passe à l'heure d'été (UTC-3) début septembre : 13:00 UTC le 29/09 = 10:00 là-bas.
  test("10:00 à Santiago, heure d'été chilienne (UTC-3)", () => {
    expect(quandDansLeFuseau("2026-09-29T13:00:00Z", "America/Santiago")).toBe(
      "Tue 29 Sep 2026, 10:00 (America/Santiago)",
    );
  });

  test("le jour change avec le fuseau : 23:30 UTC le lundi = mardi 08:30 à Tokyo", () => {
    expect(quandDansLeFuseau("2026-09-28T23:30:00Z", "Asia/Tokyo")).toBe("Tue 29 Sep 2026, 08:30 (Asia/Tokyo)");
  });

  test("fuseau illisible ⇒ UTC, NOMMÉ comme tel ; date illisible ⇒ tiret", () => {
    expect(quandDansLeFuseau("2026-09-29T14:00:00Z", "Mars/Olympus")).toBe("Tue 29 Sep 2026, 14:00 (UTC)");
    expect(quandDansLeFuseau(null, "UTC")).toBe("—");
    expect(quandDansLeFuseau("pas une date", "UTC")).toBe("—");
  });
});
