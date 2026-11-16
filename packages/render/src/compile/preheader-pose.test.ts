/**
 * LE PREHEADER DE LA CAMPAGNE ATTEINT-IL VRAIMENT LA BOÎTE DU LECTEUR ?
 *
 * ⛔ CE FICHIER COMPILE POUR DE VRAI, ET C'EST TOUT L'INTÉRÊT. `poserPreheader` reconnaît le div
 * masqué de `mj-preview` par sa signature structurelle : un banc qui lui donnerait une chaîne écrite
 * à la main passerait au vert même si MJML produisait autre chose — il ne prouverait que ma propre
 * arithmétique. Les cas 1 à 5 partent donc de `compileDoc`, comme la production.
 *
 * ⛔ LE DÉFAUT CORRIGÉ (18/09/2026). Le champ « Preheader » de l'écran campagne était saisi,
 * sauvegardé, gelé, affiché — et n'arrivait JAMAIS dans l'e-mail : seul `mj-preview`, donc le
 * preheader DU MODÈLE, atteignait la boîte. Deux campagnes partageant un modèle avaient forcément la
 * même ligne d'aperçu, quoi qu'on tape dans leur champ.
 */
import { describe, expect, test } from "bun:test";
import { EmailDoc } from "../schema";
import { poserPreheader } from "../hydrate";
import { compileDoc } from "./index";

const doc = (meta: Record<string, unknown> = {}) =>
  EmailDoc.parse({
    schema: 2,
    meta: { subject: "Sujet", preheader: "CELUI DU MODELE", assetSlug: "copper-kettle", locale: "es", ...meta },
    theme: {},
    rows: [
      {
        id: "r1",
        layout: "1",
        columns: [
          { id: "c1", blocks: [{ id: "b1", type: "text", paragraphs: [{ spans: [{ text: "corps" }] }] }] },
        ],
      },
    ],
  });

/** Combien de div de preheader porte ce HTML. */
const compte = (html: string): number =>
  (html.match(/<div style="display:none;[^"]*max-height:0px;[^"]*overflow:hidden;[^"]*"\s*>/gi) ?? []).length;

describe("poserPreheader — sur du HTML RÉELLEMENT compilé", () => {
  test("⭐⛔ le preheader de la campagne REMPLACE celui du modèle", async () => {
    const { html } = await compileDoc(doc());
    expect(html).toContain("CELUI DU MODELE");

    const pose = poserPreheader(html, "CELUI DE LA CAMPAGNE");
    expect(pose).toContain("CELUI DE LA CAMPAGNE");
    expect(pose).not.toContain("CELUI DU MODELE");
    expect(compte(pose)).toBe(1);
  });

  /**
   * ⛔⛔ LA MUTATION LA PLUS COÛTEUSE, ET CELLE QU'ON NE VERRAIT PAS : ancrer le motif sur la
   * couleur. MJML écrit `color:#ffffff`, puis `patchHtml` le réécrit en
   * `doc.theme.contentBackground`. Ce test MESURE que le HTML publié ne porte plus `#ffffff` : un
   * motif calé dessus ne matcherait donc aucun document réel, et il échouerait EN SILENCE — le
   * preheader de la campagne serait simplement ignoré, la panne exacte qu'on corrige.
   */
  test("⛔⛔ la couleur du div a DÉJÀ été réécrite : elle ne peut pas servir d'ancrage", async () => {
    const { html } = await compileDoc(doc());
    const div = html.match(/<div style="display:none;[^"]*overflow:hidden;?"\s*>/i)?.[0] ?? "";

    expect(div).not.toBe("");
    expect(div.toLowerCase()).not.toContain("#ffffff");
    // Ce sur quoi on s'ancre, en revanche, est bien là.
    expect(div).toContain("display:none;");
    expect(div).toContain("max-height:0px;");
    expect(div).toContain("overflow:hidden;");
  });

  test("⛔ un modèle SANS preheader en reçoit un — c'est le cas courant, pas un cas limite", async () => {
    const { html } = await compileDoc(doc({ preheader: "" }));
    expect(compte(html)).toBe(0);

    const pose = poserPreheader(html, "ECRIT SUR LA CAMPAGNE");
    expect(compte(pose)).toBe(1);
    expect(pose).toContain("ECRIT SUR LA CAMPAGNE");
  });

  test("⛔ et il est posé AVANT le contenu, sinon l'aperçu montrerait le corps", async () => {
    const { html } = await compileDoc(doc({ preheader: "" }));
    const pose = poserPreheader(html, "APERCU");
    expect(pose.indexOf("APERCU")).toBeLessThan(pose.indexOf("corps"));
  });

  /**
   * ⛔ IDEMPOTENCE. Le div posé porte la MÊME signature que celui de MJML : un second appel doit
   * remplacer, jamais empiler. Deux div masqués mettraient deux phrases dans la ligne d'aperçu.
   * MUTATION QUI DOIT TUER : donner au div neuf un style que `DIV_PREHEADER` ne reconnaît pas.
   */
  test("⛔ deux appels ne produisent qu'UN seul div", async () => {
    const { html } = await compileDoc(doc({ preheader: "" }));
    const deux = poserPreheader(poserPreheader(html, "PREMIER"), "SECOND");

    expect(compte(deux)).toBe(1);
    expect(deux).toContain("SECOND");
    expect(deux).not.toContain("PREMIER");
  });
});

describe("poserPreheader — ce qui doit survivre, et ce qui doit être neutralisé", () => {
  /**
   * ⭐⛔ LES JETONS SURVIVENT, ET C'EST LA RAISON D'ÊTRE DES PUCES DE L'ÉCRAN. `escapeHtml` ne touche
   * ni `{` ni `}` : le shell garde `{{first_name}}`, que l'hydratation résout par destinataire.
   * MUTATION QUI DOIT TUER : encoder les accolades, ou échapper deux fois.
   */
  test("⭐⛔ `{{first_name}}` reste un jeton, il n'est pas encodé", async () => {
    const { html } = await compileDoc(doc({ preheader: "" }));
    const pose = poserPreheader(html, "Salut {{first_name}}, ca vient de sortir");

    expect(pose).toContain("{{first_name}}");
    expect(pose).not.toContain("&#123;");
  });

  test("⛔ mais le HTML d'un preheader est NEUTRALISÉ", async () => {
    const { html } = await compileDoc(doc({ preheader: "" }));
    const pose = poserPreheader(html, '<script>alert("x")</script> & co');

    expect(pose).not.toContain("<script>");
    expect(pose).toContain("&lt;script&gt;");
    expect(pose).toContain("&amp; co");
  });

  test("les deux ensemble : le jeton passe, la balise non", async () => {
    const { html } = await compileDoc(doc({ preheader: "" }));
    const pose = poserPreheader(html, "<b>{{first_name}}</b>");

    expect(pose).toContain("{{first_name}}");
    expect(pose).not.toContain("<b>{{first_name}}");
  });
});

describe("poserPreheader — ce qu'elle refuse de toucher", () => {
  /**
   * ⛔ UN PREHEADER EFFECTIF VIDE NE VIDE PAS CELUI DU SHELL. L'appelant a déjà résolu le repli
   * (campagne, sinon modèle) : « vide » signifie donc « personne n'en a écrit nulle part ».
   * MUTATION QUI DOIT TUER : retirer la garde — le preheader du modèle serait efface par du vide.
   */
  test("⛔ preheader vide ou blanc : le shell revient INCHANGÉ", async () => {
    const { html } = await compileDoc(doc());
    expect(poserPreheader(html, "")).toBe(html);
    expect(poserPreheader(html, "   ")).toBe(html);
  });

  /**
   * ⛔⛔ LA FENÊTRE EST FERMÉE. Un div masqué appartenant au CONTENU (un bloc `html` de l'auteur, un
   * pixel de suivi) ne doit jamais être capturé : on remplacerait du contenu réel par la ligne
   * d'aperçu, et personne ne le verrait avant la boîte du lecteur.
   * MUTATION QUI DOIT TUER : chercher dans le document entier au lieu de la tête du corps.
   */
  test("⛔⛔ un div masqué LOIN dans le corps n'est pas capturé", () => {
    const loin =
      "<html><body style=\"x\">" +
      "<p>" + "z".repeat(3000) + "</p>" +
      '<div style="display:none;font-size:1px;color:#111;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">CONTENU DE L AUTEUR</div>' +
      "</body></html>";

    const pose = poserPreheader(loin, "APERCU");
    expect(pose).toContain("CONTENU DE L AUTEUR");
    // Et le preheader a bien ete pose, en tete du corps.
    expect(pose.indexOf("APERCU")).toBeLessThan(pose.indexOf("CONTENU DE L AUTEUR"));
  });

  test("pas de <body> : on rend la chaîne telle quelle, sans lever", () => {
    expect(poserPreheader("<p>un fragment</p>", "APERCU")).toBe("<p>un fragment</p>");
    expect(poserPreheader("", "APERCU")).toBe("");
  });

  test("le reste du document n'est pas touché", async () => {
    const { html } = await compileDoc(doc());
    const pose = poserPreheader(html, "APERCU");

    expect(pose).toContain("corps");
    expect(pose).toContain("<html");
    expect(pose.length).toBeGreaterThan(html.length - 100);
  });
});
