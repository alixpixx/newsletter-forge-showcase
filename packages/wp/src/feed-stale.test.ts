/**
 * BANC DE `staleFeedWarning` — l'avertissement « le plus récent a plus de 24 h ».
 *
 * Né du 25/09/2026 : un bloc Northwind Sports trié par date filtrait sur deux catégories que le site n'emploie
 * plus, et a servi toute la journée les mêmes articles vieux de 12 à 15 h sans aucun signal. Chaque
 * test ci-dessous tue UN mutant nommé (seuil, comparaison, mode, liste vide).
 */
import { describe, expect, test } from "bun:test";
import { STALE_FEED_HOURS, staleFeedWarning } from "./feed";

const NOW = new Date("2026-09-25T12:00:00.000Z");
const HOUR = 3_600_000;
/** Un article publié `ms` millisecondes avant `NOW`. */
const publie = (ms: number) => ({ publishedAt: new Date(NOW.getTime() - ms).toISOString() });

describe("staleFeedWarning", () => {
  test("le seuil vaut 24 h", () => {
    expect(STALE_FEED_HOURS).toBe(24);
  });

  test("au-delà du seuil ⇒ avertissement qui dit l'âge, la date et la cause probable", () => {
    // Le plus récent a 27 h : c'est LUI qui est jugé, pas le plus vieux (40 h) ni le premier de la liste.
    const w = staleFeedWarning("date", [publie(40 * HOUR), publie(27 * HOUR + 5 * 60_000), publie(30 * HOUR)], NOW);
    expect(w).toEqual({
      message: "The newest article is 27 h old — this feed may be filtered on categories the site no longer uses.",
      ageHours: 27,
      newestPublishedAt: "2026-09-24T08:55:00.000Z",
    });
  });

  test("`orderby` absent = mode `date` (le défaut de `FeedQuery`)", () => {
    expect(staleFeedWarning(undefined, [publie(30 * HOUR)], NOW)?.ageHours).toBe(30);
  });

  test("en deçà du seuil ⇒ null", () => {
    // Le cas Northwind Sports du matin (12 à 15 h) reste SOUS le seuil : c'est voulu, un site calme n'est pas un filtre mort.
    expect(staleFeedWarning("date", [publie(15 * HOUR), publie(40 * HOUR)], NOW)).toBe(null);
    expect(staleFeedWarning("date", [publie(23 * HOUR + 59 * 60_000)], NOW)).toBe(null);
  });

  test("⛔ la borne : pile 24 h ⇒ null ; 24 h et 1 ms ⇒ avertissement", () => {
    expect(staleFeedWarning("date", [publie(24 * HOUR)], NOW)).toBe(null);
    const juste = staleFeedWarning("date", [publie(24 * HOUR + 1)], NOW);
    expect(juste).not.toBe(null);
    expect(juste!.ageHours).toBe(24);
  });

  test("⛔ mode par vues ⇒ null, même avec des articles de plusieurs jours", () => {
    // Récolte bornée à J−2 : le plus récent y a TOUJOURS plus de 48 h — sonner ici serait sonner toujours.
    expect(staleFeedWarning("views", [publie(72 * HOUR)], NOW)).toBe(null);
  });

  test("mode mixte ⇒ null (sa moitié fraîche est rapportée par `composition`)", () => {
    expect(staleFeedWarning("mixed", [publie(72 * HOUR)], NOW)).toBe(null);
  });

  test("liste vide ⇒ null — le flux vide est un autre chemin", () => {
    expect(staleFeedWarning("date", [], NOW)).toBe(null);
  });

  test("aucune date lisible ⇒ null, on n'invente pas un âge", () => {
    expect(staleFeedWarning("date", [{}, { publishedAt: "pas une date" }], NOW)).toBe(null);
  });
});
