/**
 * Banc du moteur de VARIABLES — le premier de ce module, qui n'en avait aucun.
 *
 * ⛔ CE QUI SE JOUE ICI : ce code est la dernière chose qui touche un e-mail avant qu'il parte.
 * Une variable qui ne s'imprime pas ne lève aucune erreur — elle laisse un trou dans une phrase
 * (« Edição de  ») et l'envoi réussit. C'est exactement le défaut qui a vécu jusqu'au 03/09/2026 :
 * `{{edition_date}}` était offerte dans le menu du builder depuis l'origine et n'était alimentée
 * nulle part. Aucun test n'aurait pu le voir, faute de banc.
 */
import { describe, expect, test } from "bun:test";

const { hydrate, hydrateText, extractTokens, MERGE_VARS } = await import("./index");

/** Un jeu complet, pour que chaque test ne modifie que ce qu'il éprouve. */
const vars = (o: Record<string, string> = {}) => ({
  first_name: "Ana",
  last_name: "",
  email: "ana@exemple.test",
  asset_name: "Quartz Tips",
  edition_title: "",
  edition_date: "",
  edition_number: "",
  locale: "pt-BR",
  market: "",
  unsubscribe_url: "https://exemple.test/unsub",
  preferences_url: "",
  privacy_url: "",
  web_version_url: "",
  is_premium: false,
  has_first_name: true,
  legal_footer_html: "",
  legal_footer_text: "",
  ...o,
}) as never;

describe("le numéro et la date d'édition", () => {
  test("s'impriment quand l'occurrence les fournit", async () => {
    expect(hydrateText("Edição nº {{edition_number}} — {{edition_date}}", vars({
      edition_number: "7",
      edition_date: "6 de setembro de 2026",
    }))).toBe("Edição nº 7 — 6 de setembro de 2026");
  });

  test("⛔ un envoi SANS édition n'invente pas de numéro", async () => {
    // Bienvenue, confirmation, campagne ponctuelle : il n'y a pas d'occurrence. Un repli à « 1 »
    // enverrait une « édition n° 1 » à chaque message de bienvenue — plausible, et faux.
    expect(hydrateText("Edição nº {{edition_number}}", vars())).toBe("Edição nº ");
    expect(MERGE_VARS.edition_number.fallback).toBe("");
  });

  test("le numéro fait partie du registre, donc du menu d'insertion du builder", async () => {
    // Le menu est dérivé du registre : y déclarer la variable suffit à la proposer à l'auteur.
    expect(Object.keys(MERGE_VARS)).toContain("edition_number");
    expect(MERGE_VARS.edition_number.kind).toBe("text");
  });

  test("les deux sont échappées comme du texte d'abonné", async () => {
    // Le titre d'édition vient d'un humain : il peut contenir une esperluette ou un chevron.
    expect(hydrate("<p>{{edition_title}}</p>", vars({ edition_title: "Fla & Flu <hoje>" }))).toBe(
      "<p>Fla &amp; Flu &lt;hoje&gt;</p>",
    );
  });
});

describe("les garde-fous du moteur, jamais mis sous banc jusqu'ici", () => {
  test("un jeton hors registre est effacé, pas laissé visible", async () => {
    // Laisser « {{inconnu}} » partirait tel quel chez l'abonné.
    expect(hydrateText("a {{inconnu}} b", vars())).toBe("a  b");
  });

  test("le repli du registre s'applique quand la valeur est vide", async () => {
    expect(MERGE_VARS.first_name.fallback).toBe("there");
    expect(hydrateText("Olá {{first_name}}", vars({ first_name: "" }))).toBe("Olá there");
  });

  test("un repli écrit dans le jeton l'emporte sur celui du registre", async () => {
    expect(hydrateText("Olá {{first_name|amigo}}", vars({ first_name: "" }))).toBe("Olá amigo");
  });

  test("`extractTokens` voit les nouvelles variables — c'est ce que lit le préflight", async () => {
    expect(extractTokens("{{edition_number}} et {{edition_date}}").sort()).toEqual([
      "edition_date",
      "edition_number",
    ]);
  });
});
