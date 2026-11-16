/**
 * BANC OCTET POUR OCTET — les réglages ajoutés le 22/09/2026, ABSENTS, ne changent RIEN.
 *
 * Des emails partent pour de vrai chaque jour. Chaque décision du compilateur devenue réglable
 * (« tout ce que l'abonné reçoit se règle dans le builder ») retombe, clé absente, sur la valeur
 * qu'elle avait. Ce banc le prouve sur des documents qui couvrent chaque bloc et chaque forme
 * (`golden-docs.ts`) : leur HTML et leur texte ont été produits par le compilateur de `5311631`,
 * AVANT le chantier, et figés dans `__golden__/golden.json`. Le compilateur courant doit les
 * reproduire à l'octet près — aux ÉCARTS VOLONTAIRES près, déclarés un par un ci-dessous.
 *
 * ⛔ SI CE BANC ROUGIT : ce n'est pas la référence qui a tort. Un défaut a changé, ou un réglage
 * absent émet quelque chose. Régénérer `golden.json` avec le compilateur courant rendrait le banc
 * inutile — il comparerait le compilateur à lui-même.
 *
 * ⛔ UN CHANGEMENT VOULU QUI TOUCHE TOUS LES E-MAILS NE SE « RÉGÉNÈRE » PAS NON PLUS : il s'AJOUTE à
 * `ECARTS_VOLONTAIRES` (texte exact d'avant, texte exact d'après, documents visés, nombre
 * d'occurrences, raison). La référence reste celle de 5311631 ; le banc applique les écarts à la
 * référence, puis exige l'octet sur TOUT le reste. Un écart qui ne s'applique plus (texte absent,
 * ou présent un nombre de fois différent) rougit lui aussi : aucun écart périmé ne passe en silence.
 *
 * Contre-épreuve faite le 22/09/2026 (mutant) : l'écart entre paragraphes passé de 12 à 13 px
 * par défaut ⇒ ce banc rouge sur les documents qui ont plus d'un paragraphe.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileDoc } from "./index";
import { GOLDEN_DOCS } from "./golden-docs";

interface Golden {
  compiler: string;
  commit: string;
  docs: Record<string, { html: string; text: string }>;
}

// Lu depuis le disque et non importé : un JSON importé passe par le chargeur, qui pourrait le
// normaliser ; ici on compare des octets.
const reference = JSON.parse(readFileSync(join(import.meta.dir, "__golden__", "golden.json"), "utf8")) as Golden;

interface Ecart {
  /** Date et nature du changement voulu. */
  pourquoi: string;
  /** Documents de `GOLDEN_DOCS` concernés ; `"*"` = tous. */
  docs: "*" | readonly string[];
  /** Texte EXACT de la référence, et nombre de fois où il doit y figurer dans chaque document visé. */
  avant: string;
  fois: number;
  apres: string;
}

/** La cellule d'un `mj-image`, telle que MJML l'écrit juste après ses attributs. */
const TABLE_IMAGE =
  '\n                >\n                  \n      <table\n         border="0" cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:collapse;border-spacing:0px;" class="mj-full-width-mobile"';

/**
 * ⛔ 23/09/2026 — « que ce soit en dark ou white mode ça doit être identique à notre template » (Alix).
 * Rendu clair INCHANGÉ AU PIXEL (mesuré sur les 18 e-mails réels, WebKit et Chromium, 375 et 700 px).
 */
const ECARTS_VOLONTAIRES: readonly Ecart[] = [
  {
    pourquoi: "color-scheme par défaut : « light only » au lieu de « light dark » (meta, lue par Gmail iOS/Android)",
    docs: "*",
    avant: '<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">',
    fois: 1,
    apres: '<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only">',
  },
  {
    pourquoi: "color-scheme par défaut : « light only » (notation CSS, lue par Apple Mail 13+)",
    docs: "*",
    avant: ":root { color-scheme: light dark; supported-color-schemes: light dark; }",
    fois: 1,
    apres: ":root { color-scheme: light only; supported-color-schemes: light only; }",
  },
  {
    pourquoi: "épingle Gmail : la table d'une rangée est visée aussi ; nouvelle couleur épinglée (image sur fond de contenu)",
    docs: ["chassis-es"],
    avant: ".nf-bg-0d0d12 { background-image:linear-gradient(#0d0d12,#0d0d12) !important; }",
    fois: 1,
    apres:
      ".nf-bg-0d0d12, .nf-bg-0d0d12 > table { background-image:linear-gradient(#0d0d12,#0d0d12) !important; }\n" +
      ".nf-bg-fefefe, .nf-bg-fefefe > table { background-image:linear-gradient(#fefefe,#fefefe) !important; }",
  },
  {
    pourquoi: "épingle en thème sombre : nouvelle couleur épinglée (image sur fond de contenu)",
    docs: ["chassis-es"],
    avant: "  .nf-bg-0d0d12, .nf-bg-0d0d12 > table { background-color:#0d0d12 !important; }",
    fois: 1,
    apres:
      "  .nf-bg-0d0d12, .nf-bg-0d0d12 > table { background-color:#0d0d12 !important; }\n" +
      "  .nf-bg-fefefe, .nf-bg-fefefe > table { background-color:#fefefe !important; }",
  },
  {
    pourquoi: "le logo du bandeau porte le fond de sa rangée (#0D0D12) et son épingle",
    docs: ["chassis-es"],
    avant: `align="center" style="font-size:0px;padding:8px 24px 8px 24px;word-break:break-word;"${TABLE_IMAGE}`,
    fois: 1,
    apres: `align="center" class="nf-bg-0d0d12" style="background:#0D0D12;font-size:0px;padding:8px 24px 8px 24px;word-break:break-word;"${TABLE_IMAGE}`,
  },
  {
    pourquoi: "l'image de la 3e colonne porte le fond du contenu (#FEFEFE) et son épingle",
    docs: ["chassis-es"],
    avant: `align="right" class="nf-m-9" style="font-size:0px;padding:8px 24px 8px 24px;word-break:break-word;"${TABLE_IMAGE}`,
    fois: 1,
    apres: `align="right" class="nf-m-9 nf-bg-fefefe" style="background:#FEFEFE;font-size:0px;padding:8px 24px 8px 24px;word-break:break-word;"${TABLE_IMAGE}`,
  },
  // ⛔ 23/09/2026 — la barre à segments forçait 600 px à tout l'e-mail sur mobile (débord de 225 px
  // à 375, texte coupé). Table HYBRIDE : attributs `width` en px inchangés (Outlook/Word), style
  // fluide. Rendu bureau inchangé au pixel (mesuré sur les 14 versions Northwind Sports et leur pied de marque).
  {
    pourquoi: "barre à segments en table hybride : style width:100%;max-width en px, cellules en % (attributs px inchangés)",
    docs: ["chassis-es"],
    avant:
      'width="552" style="width:552px;border-collapse:collapse;"><tr>' +
      '<td width="276" style="width:276px;height:4px;background-color:#0033A0;font-size:0;line-height:0;">&nbsp;</td>' +
      '<td width="276" style="width:276px;height:4px;background-color:#D52B1E;font-size:0;line-height:0;">&nbsp;</td></tr></table>',
    fois: 1,
    apres:
      'width="552" style="width:100%;max-width:552px;border-collapse:collapse;"><tr>' +
      '<td width="276" style="width:50%;height:4px;background-color:#0033A0;font-size:0;line-height:0;">&nbsp;</td>' +
      '<td width="276" style="width:50%;height:4px;background-color:#D52B1E;font-size:0;line-height:0;">&nbsp;</td></tr></table>',
  },
  // ⛔ 23/09/2026 — le même défaut dans tous les autres blocs-tables (article, section_title, encart,
  // bandeau, pick, promo, cotes, classement) : 71 documents réels sur 125 débordaient à 375 px, jusqu'à
  // 604 px. Tables HYBRIDES (`largeurTable`), attributs px inchangés ; les CELLULES gardent leur px (un %
  // décalait le bureau, cf. `largeurTable`). Rendu bureau inchangé au pixel (125 documents réels, ces 7
  // documents et 5 variantes, Chromium et WebKit, 700 px ; 600 px aussi, hors contentWidth 640). ⚠️ Les
  // tables INTÉRIEURES d'un cadre BORDÉ gardaient alors leur px : ici les deux picks de chassis-es —
  // d'où 2 des 4 tables de 520. Elles tiennent dans leur cadre depuis le 24/09/2026 (écarts suivants).
  {
    pourquoi: "tables de blocs hybrides : width:100%;max-width en px (la 15e occurrence de la référence est la barre à segments, déjà réécrite par l'écart précédent)",
    docs: ["chassis-es"],
    avant: 'style="width:552px;border-collapse:collapse;"',
    fois: 15,
    apres: 'style="width:100%;max-width:552px;border-collapse:collapse;"',
  },
  {
    pourquoi: "tables de blocs hybrides : articles du flux déplié",
    docs: ["flux-pt"],
    avant: 'style="width:552px;border-collapse:collapse;"',
    fois: 6,
    apres: 'style="width:100%;max-width:552px;border-collapse:collapse;"',
  },
  {
    pourquoi: "tables de blocs hybrides : articles",
    docs: ["langue-fr", "langue-it", "langue-sv"],
    avant: 'style="width:552px;border-collapse:collapse;"',
    fois: 2,
    apres: 'style="width:100%;max-width:552px;border-collapse:collapse;"',
  },
  {
    pourquoi: "tables de blocs hybrides : article empilé d'une colonne",
    docs: ["colonnes-en"],
    avant: 'style="width:370px;border-collapse:collapse;"',
    fois: 1,
    apres: 'style="width:100%;max-width:370px;border-collapse:collapse;"',
  },
  {
    pourquoi: "cadres hybrides : deux picks, bandeau, deux encarts, deux promos",
    docs: ["chassis-es"],
    avant: 'style="width:552px;border-collapse:separate;',
    fois: 7,
    apres: 'style="width:100%;max-width:552px;border-collapse:separate;',
  },
  {
    pourquoi: "table des scores hybride (bandeau sans bordure) ; celles des deux picks, bordés, restaient en px (cf. 24/09/2026)",
    docs: ["chassis-es"],
    avant: ' width="520" style="width:520px;border-collapse:collapse;"><tr><td width="454"',
    fois: 2,
    apres: ' width="520" style="width:100%;max-width:520px;border-collapse:collapse;"><tr><td width="454"',
  },
  // ⛔ 24/09/2026 — DÉCISION D'ALIX : la table intérieure d'un cadre BORDÉ tient dans son cadre, bordure
  // comprise (`tableInterieure` : W − marges − bordures), et devient fluide. Avant, calculée sans la
  // bordure, elle poussait le cadre à W + bordures (557 px dans une colonne de 552 pour l'encart
  // ci-dessous) et le faisait déborder à 375 px (45 documents réels sur 125). Au bureau, le cadre perd
  // ses px de trop (ici 2 et 5) et sa section revient à sa largeur.
  {
    pourquoi: "pick bordé (1 px) : table intérieure 552 − 32 − 2 = 518, fluide ; libellés 370 → 368, cote 150 inchangée",
    docs: ["chassis-es"],
    avant: ' width="520" style="width:520px;border-collapse:collapse;"><tr><td align="left" width="370" valign="middle" style="width:370px;">',
    fois: 1,
    apres: ' width="518" style="width:100%;max-width:518px;border-collapse:collapse;"><tr><td align="left" width="368" valign="middle" style="width:368px;">',
  },
  {
    pourquoi: "pick bordé (1 px) sans cote : table et cellule 520 → 518, table fluide",
    docs: ["chassis-es"],
    avant: ' width="520" style="width:520px;border-collapse:collapse;"><tr><td align="left" width="520" valign="middle" style="width:520px;">',
    fois: 1,
    apres: ' width="518" style="width:100%;max-width:518px;border-collapse:collapse;"><tr><td align="left" width="518" valign="middle" style="width:518px;">',
  },
  {
    pourquoi: "encart à filet d'accent (4 px) et bordure (1 px) : table intérieure 552 − 48 − 5 = 499, fluide ; texte 369 → 365",
    docs: ["chassis-es"],
    avant: ' width="504" style="width:504px;border-collapse:collapse;"><tr><td align="left" width="369" valign="top" style="width:369px;padding:0 14px 0 0;">',
    fois: 1,
    apres: ' width="499" style="width:100%;max-width:499px;border-collapse:collapse;"><tr><td align="left" width="365" valign="top" style="width:365px;padding:0 14px 0 0;">',
  },
  {
    pourquoi: "sa vignette (cellule) : 24 % de 499 = 120, au lieu de 24 % de 504 = 121",
    docs: ["chassis-es"],
    avant: '<td align="right" width="121" valign="top" style="width:121px;">',
    fois: 1,
    apres: '<td align="right" width="120" valign="top" style="width:120px;">',
  },
  {
    pourquoi: "sa vignette (image) : 121 → 120 px",
    docs: ["chassis-es"],
    avant: 'alt="Estadio" width="121" border="0" style="display:block;width:100%;max-width:121px;',
    fois: 1,
    apres: 'alt="Estadio" width="120" border="0" style="display:block;width:100%;max-width:120px;',
  },
  // ⛔ 24/09/2026 — « sur le responsive c'est top sauf le logo qui reste géant » (Alix). `fluid-on-mobile`
  // passait TOUTE image à 100 % de sa colonne sous 480 px : une image réglée sous 100 % (les deux de
  // chassis-es : logo à 40 %, image de 3e colonne à 50 %) garde désormais sa largeur en px. L'écran
  // large ne lit pas ces classes : rendu bureau inchangé au pixel (127 documents réels, 600 et 700 px).
  {
    pourquoi: "image réglée sous 100 % : sa table perd la classe qui la passait à 100 % sur mobile (logo 40 %, image 50 %)",
    docs: ["chassis-es"],
    avant: 'style="border-collapse:collapse;border-spacing:0px;" class="mj-full-width-mobile"',
    fois: 2,
    apres: 'style="border-collapse:collapse;border-spacing:0px;"',
  },
  {
    pourquoi: "logo à 40 % : sa cellule garde ses 221 px sur mobile",
    docs: ["chassis-es"],
    avant: '<td  style="width:221px;" class="mj-full-width-mobile">',
    fois: 1,
    apres: '<td  style="width:221px;">',
  },
  {
    pourquoi: "image à 50 % de la 3e colonne : sa cellule garde ses 76 px sur mobile",
    docs: ["chassis-es"],
    avant: '<td  style="width:76px;" class="mj-full-width-mobile">',
    fois: 1,
    apres: '<td  style="width:76px;">',
  },
  {
    pourquoi: "image alignée à droite (marges 24 / 24) : centrée une fois les colonnes empilées",
    docs: ["chassis-es"],
    avant: 'align="right" class="nf-m-9',
    fois: 1,
    apres: 'align="right" class="nf-img-c24 nf-m-9',
  },
  {
    pourquoi: "sa règle, sous le seuil d'empilement de MJML (479 px) et pas sous celui des réglages mobiles (600 px)",
    docs: ["chassis-es"],
    avant: "}\n@media (prefers-color-scheme: dark) {",
    fois: 1,
    apres:
      "}\n@media only screen and (max-width:479px) {\n" +
      "  .nf-img-c24 { padding-left:24px !important; padding-right:24px !important; }\n" +
      "  .nf-img-c24 > table { margin-left:auto !important; margin-right:auto !important; }\n" +
      "}\n@media (prefers-color-scheme: dark) {",
  },
];

const vise = (e: Ecart, nom: string): boolean => e.docs === "*" || e.docs.includes(nom);

/** La référence, écarts volontaires appliqués. */
function attenduPour(nom: string, html: string): string {
  let out = html;
  for (const e of ECARTS_VOLONTAIRES) if (vise(e, nom)) out = out.split(e.avant).join(e.apres);
  return out;
}

/** Le premier point de divergence, avec du contexte : un « expected false » ne dirait rien. */
function ecart(attendu: string, obtenu: string): string {
  let i = 0;
  while (i < attendu.length && i < obtenu.length && attendu[i] === obtenu[i]) i++;
  return `à l'octet ${i} :\n  attendu : ${JSON.stringify(attendu.slice(Math.max(0, i - 80), i + 120))}\n  obtenu  : ${JSON.stringify(obtenu.slice(Math.max(0, i - 80), i + 120))}`;
}

describe("banc octet pour octet — compilateur de 5311631 contre compilateur courant", () => {
  test("la référence a bien été produite AVANT le chantier, et couvre tous les documents", () => {
    expect(reference.commit).toBe("5311631");
    expect(reference.compiler).toBe("nf-render@1.4.0+mjml@5.4.0");
    expect(Object.keys(reference.docs).sort()).toEqual(Object.keys(GOLDEN_DOCS).sort());
  });

  /** Un écart déclaré doit s'appliquer tel quel : sinon il couvrirait un changement qui n'existe plus. */
  test("chaque écart volontaire s'applique à la référence, le nombre de fois annoncé", () => {
    for (const e of ECARTS_VOLONTAIRES) {
      const noms = e.docs === "*" ? Object.keys(reference.docs) : e.docs;
      expect(noms.length).toBeGreaterThan(0);
      for (const nom of noms) {
        const html = reference.docs[nom]?.html ?? "";
        if (html.split(e.avant).length - 1 !== e.fois) throw new Error(`écart « ${e.pourquoi} » : ${html.split(e.avant).length - 1} occurrence(s) dans « ${nom} », ${e.fois} annoncée(s)`);
      }
    }
  });

  for (const [nom, doc] of Object.entries(GOLDEN_DOCS)) {
    test(`${nom} : HTML et texte identiques à l'octet, aux écarts volontaires près`, async () => {
      const ref = reference.docs[nom];
      expect(ref).toBeDefined();
      const attendu = attenduPour(nom, ref!.html);
      const { html, text } = await compileDoc(doc as never);
      if (html !== attendu) throw new Error(`HTML de « ${nom} » différent ${ecart(attendu, html)}`);
      if (text !== ref!.text) throw new Error(`texte de « ${nom} » différent ${ecart(ref!.text, text)}`);
    });
  }
});
