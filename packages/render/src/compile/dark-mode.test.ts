/**
 * THÈME SOMBRE DES CLIENTS MAIL — CE QUI PART VRAIMENT DANS LE `<head>` ET SUR LES CELLULES.
 *
 * Contexte (18/09/2026) : la confirmation Copper Kettle s'affichait correctement sur ordinateur et
 * cassée sur mobile — bandeau `#0D0D12` éclairci par le client, logo PNG blanc à fond transparent
 * devenu invisible dessus. Puis (23/09/2026) : « que ce soit en dark ou white mode ça doit être
 * identique à notre template » — les newsletters envoyées changeaient encore de couleur sur mobile.
 *
 * Quatre faits commandent la forme du correctif, et ces bancs les gardent :
 *  1. Gmail iOS et Android honorent `<meta name="color-scheme" content="light only">`, et SEULEMENT
 *     cette chaîne (caniemail `html-meta-color-scheme`, 16/09/2026) ; Apple Mail lit `light only` en
 *     CSS (webkit.org/blog/8840) ; Chromium/WebView exclut `light only` de l'assombrissement forcé
 *     (mesuré le 23/09 : #FEFEFE intact, contre #121212 avec `light` seul). ⇒ défaut `light only`.
 *  2. Gmail n'évalue PAS `prefers-color-scheme` mais ne recolore pas un fond en dégradé ⇒ l'épingle
 *     `linear-gradient` est émise HORS media query.
 *  3. Épingler un FOND sans épingler la COULEUR DU TEXTE donne du texte illisible chez les clients
 *     qui inversent (Litmus) ⇒ on n'épingle QUE des conteneurs SANS TEXTE. Les bancs « ne pas
 *     épingler » ci-dessous sont donc aussi importants que ceux qui vérifient l'épingle.
 *  4. Le bandeau CopperKettleFütbol réel n'est pas un fond de rangée : ce sont des BLOCS à fond #1a1a20
 *     sur une rangée claire ⇒ l'épingle vaut aussi pour les blocs sans texte.
 *
 * Les bancs lisent le HTML compilé, pas l'AST : c'est le HTML qui part chez l'abonné.
 */
import { describe, expect, test } from "bun:test";
import { EmailDoc } from "../schema";
import { compileDoc } from "./index";

/** Le bandeau du 18/09 : une rangée à fond sombre qui ne porte qu'une image. */
const bandeau = (id = "bandeau", couleur = "#0D0D12"): unknown => ({
  id,
  layout: "1",
  style: { backgroundColor: couleur },
  columns: [
    {
      id: `${id}_c`,
      blocks: [{ id: `${id}_b`, type: "image", src: "https://exemple.test/logo.png", alt: "Logo" }],
    },
  ],
});

/**
 * Le bandeau RÉEL des e-mails de cycle de vie Copper Kettle (lu en base le 23/09/2026) : rangée SANS
 * fond, trois blocs — filet rouge, logo, filet — qui portent chacun le fond #1a1a20.
 */
const bandeauParBlocs = (): unknown => ({
  id: "entete",
  layout: "1",
  columns: [
    {
      id: "entete_c",
      blocks: [
        { id: "f1", type: "divider", color: "#FF2F2F", thickness: 5, widthPct: 100, style: { backgroundColor: "#1a1a20" } },
        { id: "logo", type: "image", src: "https://exemple.test/logo.png", alt: "Logo", widthPct: 33, style: { backgroundColor: "#1a1a20" } },
        { id: "f2", type: "divider", color: "#26344B", thickness: 1, widthPct: 100, style: { backgroundColor: "#1a1a20" } },
      ],
    },
  ],
});

/** L'en-tête Colo-Colo : logo ET texte dans une rangée sombre ; le logo n'a pas de fond propre. */
const enteteAvecTexte = (): unknown => ({
  id: "entete_txt",
  layout: "1",
  style: { backgroundColor: "#080808" },
  columns: [
    {
      id: "entete_txt_c",
      blocks: [
        { id: "logo2", type: "image", src: "https://exemple.test/logo-colo.png", alt: "Colo" },
        { id: "sur", type: "text", paragraphs: [{ spans: [{ text: "Boletín semanal" }] }], style: { textColor: "#F1AD00" } },
      ],
    },
  ],
});

/** Une rangée qui porte du texte, avec un fond au choix. */
const texte = (id = "corps", couleur?: string): unknown => ({
  id,
  layout: "1",
  ...(couleur ? { style: { backgroundColor: couleur } } : {}),
  columns: [
    { id: `${id}_c`, blocks: [{ id: `${id}_b`, type: "text", paragraphs: [{ spans: [{ text: "Hola" }] }] }] },
  ],
});

const compile = async (rows: unknown[], theme: Record<string, unknown> = {}): Promise<string> => {
  const doc = EmailDoc.parse({
    schema: 2,
    meta: { subject: "Confirmar", preheader: "", assetSlug: "copper-kettle", locale: "es-CL" },
    theme,
    rows,
  });
  const { html } = await compileDoc(doc);
  return html;
};

/** Le contenu du bloc `@media (prefers-color-scheme: dark) { … }`, ou `undefined` s'il n'est pas émis. */
const blocSombre = (html: string): string | undefined =>
  /@media \(prefers-color-scheme: dark\) \{([\s\S]*?)\n\}/.exec(html)?.[1];

/** La cellule MJML d'un bloc, repérée par ce qu'elle contient (le `<td …>` qui précède `marqueur`). */
const celluleAvant = (html: string, marqueur: string): string => {
  const i = html.indexOf(marqueur);
  const debut = html.lastIndexOf('<td\n                   align=', i);
  return html.slice(debut, html.indexOf(">", debut) + 1);
};

describe("déclaration color-scheme — le client ne recolore pas", () => {
  /**
   * ⛔ LE TEST CENTRAL DU 23/09. MUTATION QUI DOIT LE TUER : remettre `"light dark"` comme défaut dans
   * `headNode`. Symptôme en production : les apps Gmail et Apple Mail en thème sombre recolorent
   * l'e-mail — c'est le « change de couleur sur mobile » signalé par Alix.
   */
  test("sans réglage, l'e-mail déclare « light only » — meta ET notation CSS", async () => {
    const html = await compile([bandeau(), texte()]);
    expect(html).toContain('<meta name="color-scheme" content="light only">');
    expect(html).toContain('<meta name="supported-color-schemes" content="light only">');
    expect(html).toContain(":root { color-scheme: light only; supported-color-schemes: light only; }");
    expect(html).not.toContain("light dark");
  });

  /** Gmail n'a été vu honorer QUE la chaîne `light only` : l'ordre inverse, valide en CSS, n'est pas sûr. */
  test("jamais « only light »", async () => {
    expect(await compile([texte()])).not.toContain("only light");
  });

  test("un choix explicite est respecté, anciennes valeurs comprises", async () => {
    const deux = await compile([texte()], { colorScheme: "light dark" });
    expect(deux).toContain('<meta name="color-scheme" content="light dark">');
    expect(deux).toContain(":root { color-scheme: light dark; supported-color-schemes: light dark; }");
    const clair = await compile([texte()], { colorScheme: "light" });
    expect(clair).toContain('<meta name="color-scheme" content="light">');
  });
});

describe("bandeau sombre — épingle du fond", () => {
  /**
   * ⛔ MUTATION QUI DOIT LE TUER : remettre la règle `linear-gradient` DANS le bloc
   * `@media (prefers-color-scheme: dark)`, ou ne plus l'émettre du tout.
   * Symptôme en production : Gmail n'évalue pas la media query — l'épingle serait écrite pour rien.
   */
  test("la règle dégradé est émise HORS media query, et vise aussi la table de la rangée", async () => {
    const html = await compile([bandeau(), texte()]);
    const attendu = ".nf-bg-0d0d12, .nf-bg-0d0d12 > table { background-image:linear-gradient(#0d0d12,#0d0d12) !important; }";
    expect(html).toContain(attendu);
    expect(blocSombre(html) ?? "").not.toContain("linear-gradient");
  });

  /**
   * MUTATION QUI DOIT LE TUER : ne plus pousser la classe dans `rowNode`. Les règles seraient alors
   * écrites pour une classe que personne ne porte — un garde dont la référence est absente.
   */
  test("la classe est portée par la section, et le fond ré-affirmé dans le bloc sombre", async () => {
    const html = await compile([bandeau(), texte()]);
    expect(blocSombre(html)).toContain(".nf-bg-0d0d12, .nf-bg-0d0d12 > table { background-color:#0d0d12 !important; }");
    // MJML pose `css-class` sur le `<div>` extérieur et répète le fond en inline sur la table qu'il
    // contient : le sélecteur `> table` n'a de sens que si cette imbrication est bien celle-là.
    expect(html).toMatch(/<div[^>]*class="[^"]*nf-bg-0d0d12[^"]*"[^>]*>\s*<table/);
  });

  /** Le `<style>` du head est plafonné à 16 Ko chez Gmail : deux bandeaux de même fond = une règle. */
  test("dédoublonne les fonds identiques", async () => {
    const html = await compile([bandeau("haut"), texte(), bandeau("bas")]);
    expect(html.match(/linear-gradient\(#0d0d12,#0d0d12\)/g)).toHaveLength(1);
  });
});

describe("bandeau fait de BLOCS et logo sans fond propre — les cas réels du 23/09", () => {
  /**
   * ⛔ MUTATION QUI DOIT LE TUER : ne plus épingler les blocs dans `blockNode` (garder la seule épingle
   * par rangée). Symptôme : le bandeau Copper Kettle des confirmations (fond porté par les blocs, pas
   * par la rangée) reste recolorable, et le lettrage blanc du logo y disparaît.
   */
  test("chaque bloc sans texte du bandeau porte l'épingle de son fond", async () => {
    const html = await compile([bandeauParBlocs(), texte()]);
    expect(html).toContain(".nf-bg-1a1a20, .nf-bg-1a1a20 > table { background-image:linear-gradient(#1a1a20,#1a1a20) !important; }");
    expect(blocSombre(html)).toContain(".nf-bg-1a1a20, .nf-bg-1a1a20 > table { background-color:#1a1a20 !important; }");
    // Les trois cellules (filet, logo, filet) : classe ET fond sur la MÊME cellule.
    expect(html.match(/<td\s+align="[a-z]+" class="nf-bg-1a1a20" style="background:#1a1a20;/g)).toHaveLength(3);
  });

  /**
   * ⛔ MUTATION QUI DOIT LE TUER : ne plus poser de fond explicite sur un bloc image qui n'en a pas.
   * Le logo Colo-Colo partage sa rangée avec du texte : la rangée ne peut pas être épinglée, sa cellule
   * doit donc porter elle-même la couleur qu'elle a sous elle (#080808), et l'épingle.
   */
  test("un logo sans fond propre reçoit le fond de sa rangée, épinglé", async () => {
    const html = await compile([enteteAvecTexte(), texte()]);
    const cellule = celluleAvant(html, 'src="https://exemple.test/logo-colo.png"');
    expect(cellule).toContain('class="nf-bg-080808"');
    expect(cellule).toContain("background:#080808;");
    // … mais la RANGÉE, qui porte du texte, n'est pas épinglée.
    expect(html).not.toMatch(/<div[^>]*class="[^"]*nf-bg-080808[^"]*"/);
  });

  test("sans fond de rangée ni de colonne, le logo reçoit le fond du contenu", async () => {
    const html = await compile([enteteAvecTexte(), { ...(texte("pied") as object), columns: [{ id: "pc", blocks: [{ id: "pl", type: "image", src: "https://exemple.test/pied.png", alt: "Pied" }, { id: "pt", type: "text", paragraphs: [{ spans: [{ text: "x" }] }] }] }] }]);
    const cellule = celluleAvant(html, 'src="https://exemple.test/pied.png"');
    expect(cellule).toContain("background:#FEFEFE;");
    expect(cellule).toContain("nf-bg-fefefe");
  });

  /** Une rangée de logo CLAIRE (Northwind Sports : logo sombre sur le fond du contenu) est épinglée aussi. */
  test("une rangée d'image sur fond clair est épinglée — plus de seuil de luminance", async () => {
    const html = await compile([{ id: "r", layout: "1", columns: [{ id: "c", blocks: [{ id: "i", type: "image", src: "https://exemple.test/l.png", alt: "L" }] }] }, texte()]);
    expect(html).toMatch(/<div[^>]*class="[^"]*nf-bg-fefefe[^"]*"[^>]*>\s*<table/);
  });

  /** `pinDarkRows: false` coupe TOUT : ni classe, ni fond ajouté au logo. */
  test("pinDarkRows: false — aucune épingle, aucun fond ajouté", async () => {
    const html = await compile([bandeauParBlocs(), enteteAvecTexte(), texte()], { pinDarkRows: false });
    expect(html).not.toContain("nf-bg-");
    // Le logo Colo-Colo n'a pas de fond propre : sans épingle, sa cellule n'en reçoit aucun.
    expect(celluleAvant(html, 'src="https://exemple.test/logo-colo.png"')).not.toContain("background:");
  });
});

describe("ce qu'on refuse d'épingler — la moitié qui protège", () => {
  /**
   * ⛔ MUTATION QUI DOIT LE TUER : retirer l'appel à `rangeeSansTexte`. Symptôme en production : chez
   * les clients qui inversent, le texte a déjà été inversé ; réimposer le fond d'origine le rend
   * illisible (Litmus) — clair sur clair, ou sombre sur sombre.
   */
  test("une rangée QUI PORTE DU TEXTE n'est jamais épinglée, claire ou sombre", async () => {
    for (const couleur of ["#FEFEFE", "#0D0D12"]) {
      const html = await compile([texte("bloc", couleur), texte()]);
      expect(html).not.toContain("linear-gradient");
      expect(blocSombre(html)).toBeUndefined();
    }
  });

  /** ⛔ MUTATION QUI DOIT LE TUER : épingler tout bloc qui a un fond, texte compris. */
  test("un bloc de TEXTE à fond coloré n'est jamais épinglé", async () => {
    const html = await compile([
      { id: "r", layout: "1", columns: [{ id: "c", blocks: [{ id: "t", type: "text", paragraphs: [{ spans: [{ text: "Hola" }] }], style: { backgroundColor: "#1a1a20" } }] }] },
    ]);
    expect(html).not.toContain("nf-bg-");
    expect(html).not.toContain("linear-gradient");
  });

  /**
   * Une rangée de filet ou d'espaceur SUR LE FOND DU CONTENU n'est pas épinglée : épinglée, elle
   * resterait claire au milieu d'un e-mail inversé par Gmail — une bande que le modèle n'a pas.
   */
  test("un filet sur le fond du contenu n'est pas épinglé", async () => {
    const html = await compile([texte("a"), { id: "f", layout: "1", columns: [{ id: "fc", blocks: [{ id: "fd", type: "divider", thickness: 1, widthPct: 100 }] }] }, texte("b")]);
    expect(html).not.toContain("nf-bg-");
  });

  /** Sans bandeau ni image, on n'ajoute RIEN au bloc sombre : le head reste comme avant. */
  test("un document sans image ni bandeau n'émet aucun bloc sombre", async () => {
    expect(blocSombre(await compile([texte()]))).toBeUndefined();
  });

  /** Aucune couleur de texte n'est forcée quand la marque n'en donne pas. */
  test("aucune couleur de texte forcée sans palette de marque", async () => {
    // `not.toContain("color:")` matcherait `background-color:` : on vise la propriété `color` seule.
    expect(blocSombre(await compile([bandeauParBlocs(), bandeau(), texte()]))).not.toMatch(/(?<!-)color:/);
  });
});

describe("règles mobiles — aucune ne touche une couleur", () => {
  /**
   * Mesuré le 23/09 sur les 18 e-mails réels (WebKit et Chromium, clair 375 px contre clair 700 px) :
   * aucune couleur n'apparaît ni ne disparaît d'un bloc sur mobile. Ce banc garde la cause : les règles
   * sous `max-width` ne règlent que taille, marges, hauteur et masquage — jamais une couleur.
   * MUTATION QUI DOIT LE TUER : ajouter une couleur à une règle de `mobileClass`.
   */
  test("la media query mobile ne porte ni color ni background", async () => {
    const html = await compile([
      bandeau(),
      {
        id: "m",
        layout: "1-1",
        style: { fontSizeMobile: 13, paddingMobile: { top: 0 }, hideOnMobile: false },
        columns: [
          { id: "m1", style: { paddingMobile: { left: 4 } }, blocks: [{ id: "mt", type: "text", paragraphs: [{ spans: [{ text: "a" }] }], style: { fontSizeMobile: 12, paddingMobile: { left: 2 } } }] },
          { id: "m2", blocks: [{ id: "ms", type: "spacer", height: 20, heightMobile: 8 }] },
        ],
      },
    ]);
    const mobile = /@media only screen and \(max-width:600px\) \{([\s\S]*?)\n\}/.exec(html)?.[1] ?? "";
    expect(mobile).toContain("font-size:13px");
    expect(mobile).not.toMatch(/(?<![-\w])color\s*:|background/);
  });
});

describe("marque ayant déclaré sa palette sombre", () => {
  test("ses couleurs sont appliquées, et le bandeau reste épinglé", async () => {
    const dark = blocSombre(
      await compile([bandeau(), texte()], {
        darkBodyBackground: "#101014",
        darkContentBackground: "#18181D",
        darkTextColor: "#EDEDF2",
      }),
    );
    expect(dark).toContain("body, .nf-body { background-color:#101014 !important; }");
    expect(dark).toContain(".nf-content { background-color:#18181D !important; }");
    expect(dark).toContain("color:#EDEDF2 !important;");
    expect(dark).toContain(".nf-bg-0d0d12, .nf-bg-0d0d12 > table { background-color:#0d0d12 !important; }");
  });
});
