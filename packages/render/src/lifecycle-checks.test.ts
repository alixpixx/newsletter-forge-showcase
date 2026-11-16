/**
 * ⛔ CE QUE CE BANC EXISTE POUR EMPÊCHER. Deux pannes opposées, et la seconde est la plus vicieuse.
 *
 *  1. Publier un template de `confirmation` sans lien de confirmation : la personne clique dans le
 *     vide, ne confirme jamais, et le consentement que la loi nous demande de prouver n'existe pas.
 *  2. Refuser un template parfaitement valide parce que le contrôle cherche le jeton par une
 *     recherche littérale et manque sa forme à repli inline `{{confirm_url|cliquez ici}}` — ou
 *     parce qu'il s'applique à un template ordinaire qui n'a rien à voir avec le cycle de vie.
 */
import { describe, expect, test } from "bun:test";
import { checkLifecycleShell, isLifecycleKind, lifecycleShellMessage } from "./lifecycle-checks";

const FOOTER = "{{legal_footer_html}}";

describe("checkLifecycleShell — confirmation", () => {
  test("un shell sans lien de confirmation est refusé, et le message NOMME le jeton", () => {
    const r = checkLifecycleShell({ kind: "confirmation", html: `<p>Bonjour</p>${FOOTER}` });
    expect(r.ok).toBe(false);
    expect(r.missing.map((m) => m.token)).toEqual(["confirm_url"]);
    const msg = lifecycleShellMessage(r);
    // ⛔ On asserte la RAISON du refus, pas seulement le refus : un message qui ne dit pas quoi
    // corriger transforme une garde utile en mur.
    expect(msg).toContain("{{confirm_url}}");
    expect(msg).toContain("confirmation");
  });

  test("le jeton présent suffit", () => {
    const r = checkLifecycleShell({ kind: "confirmation", html: `<a href="{{confirm_url}}">ok</a>${FOOTER}` });
    expect(r.ok).toBe(true);
    expect(lifecycleShellMessage(r)).toBeNull();
  });

  test("⛔ le repli inline compte comme une présence", () => {
    // La panne #2. `html.includes("{{confirm_url}}")` rendrait faux ici et refuserait un template
    // parfaitement valide, sans que l'auteur comprenne pourquoi : il VOIT son jeton.
    const r = checkLifecycleShell({ kind: "confirmation", html: `<a href="{{confirm_url|#}}">ok</a>${FOOTER}` });
    expect(r.ok).toBe(true);
  });

  test("les espaces dans le jeton ne le rendent pas invisible", () => {
    const r = checkLifecycleShell({ kind: "confirmation", html: `{{ confirm_url }}${FOOTER}` });
    expect(r.ok).toBe(true);
  });

  test("le jeton peut ne vivre que dans la version TEXTE", () => {
    // Un shell HTML qui utilise un bouton image et un texte qui donne l'URL en clair : le lien
    // existe, l'e-mail fonctionne.
    const r = checkLifecycleShell({
      kind: "confirmation",
      html: `<p>bouton</p>${FOOTER}`,
      text: "Confirmez ici : {{confirm_url}}",
    });
    expect(r.ok).toBe(true);
  });

  test("le jeton peut vivre dans le SUJET", () => {
    const r = checkLifecycleShell({ kind: "confirmation", html: FOOTER, subject: "Confirmez : {{confirm_url}}" });
    expect(r.ok).toBe(true);
  });
});

describe("checkLifecycleShell — réengagement", () => {
  test("sans lien de préférences, refusé", () => {
    const r = checkLifecycleShell({ kind: "reengagement", html: `<p>on ne vous a pas vu</p>${FOOTER}` });
    expect(r.ok).toBe(false);
    expect(r.missing.map((m) => m.token)).toEqual(["preferences_url"]);
  });

  test("avec le lien, accepté", () => {
    const r = checkLifecycleShell({ kind: "reengagement", html: `<a href="{{preferences_url}}">rester</a>${FOOTER}` });
    expect(r.ok).toBe(true);
  });

  test("⛔ le lien de DÉSABONNEMENT ne remplace pas celui des préférences", () => {
    // Les deux sont dans le footer, mais ils ne demandent pas la même chose : l'un fait partir,
    // l'autre laisse choisir. Un réengagement qui n'offre que le départ est un e-mail de rupture.
    const r = checkLifecycleShell({ kind: "reengagement", html: `<a href="{{unsubscribe_url}}">x</a>${FOOTER}` });
    expect(r.ok).toBe(false);
  });
});

describe("checkLifecycleShell — ce qu'il ne doit PAS refuser", () => {
  test("welcome et unsubscribe_ack n'exigent aucun jeton propre", () => {
    // Leur seule obligation — le footer légal — est déjà contrôlée pour TOUS les templates par la
    // barrière {{legal_footer_html}}. La redoubler ici donnerait deux messages pour un défaut.
    for (const kind of ["welcome", "unsubscribe_ack"] as const) {
      const r = checkLifecycleShell({ kind, html: "<p>rien</p>" });
      expect(r.ok).toBe(true);
    }
  });

  test("un kind qui n'est pas du cycle de vie n'en est pas un", () => {
    // Le garde-fou de l'appelant : un template ordinaire ne doit JAMAIS entrer dans ce contrôle,
    // sinon tous les templates de campagne deviendraient impubliables.
    expect(isLifecycleKind("campaign")).toBe(false);
    expect(isLifecycleKind("test")).toBe(false);
    expect(isLifecycleKind(null)).toBe(false);
    expect(isLifecycleKind("confirmation")).toBe(true);
  });
});
