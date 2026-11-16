/**
 * Le bilan du repointage tel que l'écran l'affiche après « Save content ». Ce qui compte : chaque
 * édition qui GARDE l'ancienne version est dite (en préparation, retenue), et un échec partiel (207)
 * ne se lit jamais comme un succès.
 */
import { describe, expect, test } from "bun:test";
import { avisDeRepointage } from "./repointage";

describe("avisDeRepointage", () => {
  test("déplacées + en préparation + retenue : les trois faits, et le ton d'alerte", () => {
    const a = avisDeRepointage({ occurrences: { moved: 3, skippedInFreezeWindow: 1, held: 1 } }, 10);
    expect(a!.ton).toBe("warn");
    expect(a!.texte).toContain("3 upcoming editions moved to v10.");
    expect(a!.texte).toContain("1 already in preparation keeps the version it started with.");
    expect(a!.texte).toContain("1 held edition keeps its previous version");
  });

  test("tout déplacé : ton d'information, aucune mention de ce qui n'existe pas", () => {
    const a = avisDeRepointage({ occurrences: { moved: 2, skippedInFreezeWindow: 0, held: 0 } }, 10);
    expect(a).toEqual({ ton: "info", texte: "2 upcoming editions moved to v10." });
  });

  test("⛔ 207 : l'échec des éditions est DIT, la campagne est annoncée enregistrée", () => {
    const a = avisDeRepointage({ occurrences: null, occurrencesError: "boom" }, 10);
    expect(a!.ton).toBe("warn");
    expect(a!.texte).toContain("saved on v10");
    expect(a!.texte).toContain("could not be moved (boom)");
  });

  test("pas de bilan (version inchangée) : rien à dire", () => {
    expect(avisDeRepointage({ campaign: {} }, 10)).toBeNull();
    expect(avisDeRepointage(null, 10)).toBeNull();
  });
});

/*
 * « Même règle » (décision d'Alix du 25/09/2026 au soir) : le sujet, le preheader et le segment
 * repointent aussi, et la réponse les nomme (`occurrencesFields`). L'écran doit dire LESQUELS ont suivi.
 */
describe("avisDeRepointage — sujet, preheader, segment", () => {
  test("⛔ les champs qui ont suivi sont nommés : « 3 upcoming editions updated (subject, segment). »", () => {
    // MUTATION QUI DOIT TUER CE TEST : ignorer `occurrencesFields` et dire « moved to … » pour tout.
    const a = avisDeRepointage(
      { occurrences: { moved: 3, skippedInFreezeWindow: 0, held: 0 }, occurrencesFields: ["subject", "segmentId"] },
      null,
    );
    expect(a).toEqual({ ton: "info", texte: "3 upcoming editions updated (subject, segment)." });
  });

  test("version ET sujet : la version garde son numéro ; en préparation et retenues disent ce qu'elles gardent", () => {
    const a = avisDeRepointage(
      {
        occurrences: { moved: 2, skippedInFreezeWindow: 1, held: 2 },
        occurrencesFields: ["templateVersionId", "subject"],
      },
      10,
    );
    expect(a!.ton).toBe("warn");
    expect(a!.texte).toContain("2 upcoming editions updated (version v10, subject).");
    expect(a!.texte).toContain("1 already in preparation keeps the version and subject it started with.");
    expect(a!.texte).toContain("2 held editions keep their previous version and subject — sent anyway, they go out with them.");
  });

  test("⛔ 207 sur le sujet : la campagne est dite enregistrée, l'échec des éditions est DIT", () => {
    const a = avisDeRepointage({ occurrences: null, occurrencesError: "boom", occurrencesFields: ["subject"] }, null);
    expect(a).toEqual({
      ton: "warn",
      texte:
        "The campaign is saved (subject), but its upcoming editions could not be updated (boom). They still send the subject they had.",
    });
  });

  test("la version seule, nommée par la réponse, garde ses phrases d'origine", () => {
    const a = avisDeRepointage(
      { occurrences: { moved: 2, skippedInFreezeWindow: 0, held: 0 }, occurrencesFields: ["templateVersionId"] },
      10,
    );
    expect(a).toEqual({ ton: "info", texte: "2 upcoming editions moved to v10." });
  });

  test("rien à mettre à jour : dit, pas tu", () => {
    const a = avisDeRepointage(
      { occurrences: { moved: 0, skippedInFreezeWindow: 0, held: 1 }, occurrencesFields: ["preheader"] },
      null,
    );
    expect(a!.texte).toBe(
      "No upcoming edition had to be updated (preheader). 1 held edition keeps its previous preheader — sent anyway, it goes out with it.",
    );
  });
});
