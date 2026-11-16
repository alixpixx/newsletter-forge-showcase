import { describe, expect, test } from "bun:test";
import { dict, normalizeLocale, LOCALES, type Locale } from "./i18n";
// ⚠️ Import relatif, pour ce banc seulement : `apps/public` ne dépend pas de `@nf/email`, et c'est
// précisément la source du worker qu'on veut confronter, pas une copie.
import { strings } from "../../../../packages/email/src/i18n";

/**
 * ⛔ CE QUE CE BANC EXISTE POUR EMPÊCHER, et c'est un défaut qui a VRAIMENT été livré. Les objets
 * d'e-mail vivaient en dur, en français, dans les deux chemins qui mettent en file — pendant que
 * cette même table traduisait les PAGES en six locales. Mesuré le 15/09/2026 : quatre souscriptions
 * Copper Kettle en `language = 'es'` attendaient dans `email_outbox` avec l'objet « Confirme ton
 * inscription — Copper Kettle ».
 *
 * Le défaut était invisible partout où on avait l'habitude de regarder : aucune erreur, aucun test
 * rouge, un rendu de page parfait. Il n'apparaissait que dans la boîte de réception d'un lecteur
 * chilien — c'est-à-dire trop tard.
 */

const MARQUE = "Copper Kettle";

describe("objets d'e-mail — les six locales", () => {
  test("chaque locale rend un objet NON VIDE pour les deux kinds", () => {
    for (const loc of LOCALES) {
      const m = dict(loc).m;
      expect(m.confirmSubject(MARQUE).trim().length).toBeGreaterThan(0);
      expect(m.welcomeSubject(MARQUE).trim().length).toBeGreaterThan(0);
    }
  });

  test("chaque objet porte le nom de la MARQUE", () => {
    // Un objet sans marque force le lecteur à ouvrir pour savoir de qui vient l'e-mail — et à
    // décider sans indice s'il l'a demandé.
    for (const loc of LOCALES) {
      expect(dict(loc).m.confirmSubject(MARQUE)).toContain(MARQUE);
      expect(dict(loc).m.welcomeSubject(MARQUE)).toContain(MARQUE);
    }
  });

  test("⛔ AUCUNE locale autre que `fr` ne sert l'ancien texte français", () => {
    // C'est LE test qui aurait mordu sur le défaut d'origine. Sans lui, ajouter une locale en
    // recopiant le bloc français passerait inaperçu — c'est exactement ainsi que le défaut est né.
    for (const loc of LOCALES.filter((l: Locale) => l !== "fr")) {
      expect(dict(loc).m.confirmSubject(MARQUE)).not.toContain("Confirme ton inscription");
      expect(dict(loc).m.welcomeSubject(MARQUE)).not.toContain("Bienvenue");
    }
  });

  test("les six objets de confirmation sont DISTINCTS deux à deux", () => {
    // Deux locales qui rendent la même chaîne dénoncent un copier-coller, pas une coïncidence
    // linguistique : aucune des six langues servies ne partage une formule de confirmation.
    const vus = new Set(LOCALES.map((l: Locale) => dict(l).m.confirmSubject(MARQUE)));
    expect(vus.size).toBe(LOCALES.length);
  });

  test("aucun objet ne genre le LECTEUR ni ne préjuge du genre de la marque", () => {
    /*
     * ⚠️ Deux pièges distincts, et tous deux se voient à l'œil nu une fois écrits.
     *  · « Bienvenido » genre la personne qui lit — une lectrice sur deux lira le mauvais mot.
     *  · « Boas-vindas à Northwind Sports » impose un article féminin à un nom propre ; « à Atlas Review »
     *    est faux. D'où la forme « Texte — Marque », qui ne suppose rien.
     */
    for (const loc of LOCALES) {
      const bienvenue = dict(loc).m.welcomeSubject(MARQUE);
      expect(bienvenue).toContain(`— ${MARQUE}`);
      for (const genre of ["Bienvenido", "Bienvenida a ", "Benvenuta", "Bem-vindo", "Bem-vinda"]) {
        expect(bienvenue).not.toContain(genre);
      }
    }
  });

  test("une langue d'édition régionale retombe sur sa locale servie", () => {
    // Les éditions portent `es-CL`, `pt`, `de-DE`… : c'est cette normalisation, et non la valeur
    // brute, qui décide de l'objet. Sans elle, `es-CL` tomberait sur le repli anglais.
    expect(dict(normalizeLocale("es-CL")).m.confirmSubject(MARQUE)).toBe(dict("es").m.confirmSubject(MARQUE));
    expect(dict(normalizeLocale("pt")).m.confirmSubject(MARQUE)).toBe(dict("pt-BR").m.confirmSubject(MARQUE));
    expect(dict(normalizeLocale("de-DE")).m.welcomeSubject(MARQUE)).toBe(dict("de").m.welcomeSubject(MARQUE));
  });

  test("une langue absente ou inconnue retombe sur l'anglais, jamais sur le français", () => {
    // ⛔ Le repli est la LANGUE DE BASE du produit, pas celle de l'équipe qui l'écrit. Un repli
    // français rendrait le défaut d'origine invisible : tout marcherait « par défaut ».
    for (const entree of [null, undefined, "", "xx", "klingon"]) {
      expect(dict(normalizeLocale(entree)).m.confirmSubject(MARQUE)).toBe(dict("en").m.confirmSubject(MARQUE));
    }
  });

  test("l'objet espagnol servi aux 4 leads Copper Kettle est bien en espagnol", () => {
    // Le cas réel qui a déclenché ce lot, écrit en toutes lettres pour qu'il reste vérifiable.
    expect(dict(normalizeLocale("es")).m.confirmSubject("Copper Kettle")).toBe("Confirma tu suscripción — Copper Kettle");
  });
});

/**
 * L'accusé de désinscription (22/09/2026) : mis en file par `apps/public` depuis ce jour, il a
 * désormais un objet par locale — et il doit être EXACTEMENT celui du repli du worker.
 */
describe("objet de l'accusé de désinscription — les six locales", () => {
  test("chaque locale rend un objet non vide qui porte la marque", () => {
    for (const loc of LOCALES) {
      const objet = dict(loc).m.unsubAckSubject(MARQUE);
      expect(objet.trim().length).toBeGreaterThan(0);
      expect(objet).toContain(`— ${MARQUE}`);
    }
  });

  test("⛔ MOT POUR MOT l'objet du repli du worker, dans chaque locale", () => {
    /*
     * Le worker se donne `${unsub_ack_title} — ${marque}` quand aucun modèle n'est rattaché ; notre
     * objet ne sert que quand un modèle rattaché n'a pas le sien. Deux formules pour le même e-mail
     * selon qu'une marque l'a personnalisé ou non : c'est ce que ce test interdit. Il lit la source
     * du worker plutôt qu'une copie, pour qu'une retouche d'un seul côté le fasse virer au rouge.
     */
    for (const loc of LOCALES) {
      expect(dict(loc).m.unsubAckSubject(MARQUE)).toBe(`${strings(loc).unsub_ack_title} — ${MARQUE}`);
    }
  });

  test("les six objets sont distincts deux à deux, et aucun n'est l'anglais hors `en`", () => {
    const vus = new Set(LOCALES.map((l: Locale) => dict(l).m.unsubAckSubject(MARQUE)));
    expect(vus.size).toBe(LOCALES.length);
    for (const loc of LOCALES.filter((l: Locale) => l !== "en")) {
      expect(dict(loc).m.unsubAckSubject(MARQUE)).not.toContain("Unsubscribe confirmed");
    }
  });
});
