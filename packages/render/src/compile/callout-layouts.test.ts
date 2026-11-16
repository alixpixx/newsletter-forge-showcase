/**
 * MISES EN PAGE DE L'ENCART (`callout.layout`, 23/09/2026) — CE QUI PART CHEZ L'ABONNÉ.
 *
 * Sept mises en page, tirées des maquettes validées par Alix (Affiche, Lecteur, Pochette, Onde,
 * Mosaïque, Bandeau, Ticket). Chacune pose une photo ou des aplats là où l'encart classique ne pose
 * qu'un fond. Quatre promesses, une par famille de client, et ces bancs les tiennent :
 *  1. Outlook desktop n'affiche un fond d'image que par VML (`v:rect` + `v:fill`) — sans lui, la
 *     cellule reste nue et le texte blanc tombe sur le blanc du contenu.
 *  2. Images bloquées (Outlook par défaut, Gmail IMAP, lecteurs prudents) : chaque cellule à photo
 *     porte une couleur de REPLI (`bgcolor` + `background-color`), et c'est elle que le lecteur voit.
 *  3. Rendu sans image du tout (l'auteur n'en a pas posé) : un aplat, et le texte ET le bouton intacts.
 *  4. Le CSS mobile d'une mise en page (`.nf-lo-*`) ne part QUE si une mise en page sert : un
 *     document sans `layout` compile à l'octet près comme avant (golden.test.ts le garde aussi).
 *
 * ⛔ Les bancs lisent le HTML COMPILÉ, pas l'AST : c'est le HTML qui part.
 */
import { describe, expect, test } from "bun:test";
import { CALLOUT_LAYOUTS, EmailDoc, EmailDocPublishable, type CalloutLayout } from "../schema";
import { compileDoc } from "./index";

const PHOTO = "https://cdn.test/fond.jpg";
const REPLI = "#123456";

const doc = (callout: Record<string, unknown>, theme: Record<string, unknown> = {}): EmailDoc =>
  EmailDoc.parse({
    schema: 2,
    meta: { subject: "Banc", preheader: "Banc des mises en page", assetSlug: "banc", locale: "en" },
    theme,
    rows: [
      {
        id: "r1",
        layout: "1",
        columns: [
          {
            id: "c1",
            blocks: [
              {
                id: "enc",
                type: "callout",
                kicker: "PODCAST",
                title: "Friday night preview",
                body: "Three matches worth your evening.",
                href: "https://site.test/listen",
                ctaLabel: "Listen now",
                ...callout,
              },
            ],
          },
        ],
      },
      { id: "r2", layout: "1", columns: [{ id: "c2", blocks: [{ id: "pied", type: "footer_legal" }] }] },
    ],
  });

const html = async (callout: Record<string, unknown>, theme?: Record<string, unknown>): Promise<string> =>
  (await compileDoc(doc(callout, theme))).html;

/** Le `<head>` seul : c'est là que partent les règles mobiles. */
const head = (h: string): string => h.slice(0, h.indexOf("</head>"));

/** Les mises en page qui posent la photo de fond (`backgroundImage`) en cellule VML. */
const A_FOND: { layout: CalloutLayout; repli: string }[] = [
  { layout: "poster", repli: REPLI },
  { layout: "player", repli: REPLI },
  // Pochette : la photo n'est qu'une CASE de la carte, son repli est `stubBackground`.
  { layout: "cover", repli: "#654321" },
  { layout: "strip", repli: REPLI },
  { layout: "ticket", repli: REPLI },
];

const avecPhoto = (layout: CalloutLayout): Record<string, unknown> => ({
  layout,
  backgroundImage: PHOTO,
  style: { backgroundColor: REPLI },
  stubBackground: "#654321",
});

describe("les photos de fond : VML pour Outlook, couleur de repli partout", () => {
  for (const { layout, repli } of A_FOND) {
    test(`${layout} : v:rect, v:fill de la photo sur le repli, et la cellule porte bgcolor`, async () => {
      const h = await html(avecPhoto(layout));
      expect(h).toContain(`<v:rect xmlns:v="urn:schemas-microsoft-com:vml"`);
      expect(h).toContain(`<v:fill type="frame" src="${PHOTO}" color="${repli}" />`);
      // La cellule à photo : l'attribut `background` (Outlook.com, anciens clients), le CSS, ET le
      // repli sur la MÊME cellule — c'est lui que voit un lecteur aux images bloquées.
      const cellule = h.match(new RegExp(`<td[^>]*background="${PHOTO}"[^>]*>`))?.[0] ?? "";
      expect(cellule).toContain(`bgcolor="${repli}"`);
      expect(cellule).toContain(`background-color:${repli};`);
      expect(cellule).toContain(`background-image:url('${PHOTO}')`);
    });

    test(`${layout} : sans photo, un aplat — ni VML ni attribut background, le texte et le bouton intacts`, async () => {
      const h = await html({ ...avecPhoto(layout), backgroundImage: undefined });
      expect(h).not.toContain("<v:rect");
      expect(h).not.toContain(` background="`);
      expect(h).toContain(`bgcolor="${repli}"`);
      for (const texte of ["PODCAST", "Friday night preview", "Three matches worth your evening.", "Listen now"]) {
        expect(h).toContain(texte);
      }
      expect(h).toContain(`href="https://site.test/listen"`);
    });
  }

  test("ticket : la souche a son propre aplat, et son pointillé passe en haut sur mobile", async () => {
    const h = await html({ ...avecPhoto("ticket"), stubBackground: "#ffe600" });
    expect(h).toMatch(/<td class="[^"]*nf-lo-stub" width="\d+" valign="middle" bgcolor="#ffe600"/);
    expect(head(h)).toContain(".nf-lo-stub {");
  });

  test("la cellule qui porte une photo n'est JAMAIS épinglée : l'épingle Gmail remplacerait l'image", async () => {
    for (const { layout } of A_FOND) {
      const h = await html(avecPhoto(layout));
      const cellules = h.match(new RegExp(`<td[^>]*background="${PHOTO}"[^>]*>`, "g")) ?? [];
      expect(cellules.length).toBe(1);
      for (const c of cellules) expect(c).not.toContain("nf-bg-");
    }
  });
});

describe("onde et mosaïque : des cartes à aplat, pas de photo de fond", () => {
  test("wave : la carte porte son fond, 38 barres épinglées, la vignette ronde n'existe que si elle est posée", async () => {
    const avec = await html({ layout: "wave", imageSrc: "https://cdn.test/rond.jpg", imageAlt: "Host", style: { backgroundColor: REPLI } });
    expect(avec).toContain(`background-color:${REPLI};`);
    expect((avec.match(/ width="4" height="\d+" bgcolor="#/g) ?? []).length).toBe(38);
    // Barres SANS texte : épinglées, sinon Gmail les inverse et l'onde disparaît sur fond sombre.
    expect((avec.match(/<td class="nf-bg-[0-9a-f]+" width="4" height=/g) ?? []).length).toBe(38);
    expect(avec).toContain(`src="https://cdn.test/rond.jpg" width="72" height="72"`);

    const sans = await html({ layout: "wave", style: { backgroundColor: REPLI } });
    expect(sans).not.toContain(`width="72" height="72"`);
    expect(sans).toContain("Friday night preview");
    expect(sans).toContain("Listen now");
  });

  test("gallery : chaque case porte le repli, une case sans alt n'est pas liée", async () => {
    const h = await html({
      layout: "gallery",
      stubBackground: "#654321",
      gallery: [
        { src: "https://cdn.test/1.jpg", alt: "One" },
        { src: "https://cdn.test/2.jpg", alt: "" },
        { src: "https://cdn.test/3.jpg", alt: "Three" },
      ],
    });
    expect((h.match(/<td width="32%" valign="top" bgcolor="#654321"/g) ?? []).length).toBe(3);
    expect(h).toContain(`<a href="https://site.test/listen" target="_blank"><img src="https://cdn.test/1.jpg"`);
    expect(h).not.toContain(`target="_blank"><img src="https://cdn.test/2.jpg"`);
    expect(h).toContain(`<img src="https://cdn.test/2.jpg"`);
  });

  test("gallery sans case : titre et bouton seuls, aucune grille", async () => {
    const h = await html({ layout: "gallery" });
    expect(h).not.toContain(`width="32%"`);
    expect(h).toContain("Listen now");
  });
});

describe("CSS mobile : il ne part que si une mise en page sert", () => {
  test("sans layout : aucune règle ni classe nf-lo", async () => {
    const h = await html({ backgroundImage: PHOTO });
    expect(h).not.toContain("nf-lo");
  });

  for (const layout of CALLOUT_LAYOUTS) {
    test(`${layout} : chaque classe nf-lo posée a sa règle dans le head, et réciproquement`, async () => {
      const h = await html({
        ...avecPhoto(layout),
        imageSrc: "https://cdn.test/rond.jpg",
        imageAlt: "Host",
        gallery: [{ src: "https://cdn.test/1.jpg", alt: "One" }],
      });
      const regles = new Set([...head(h).matchAll(/\.(nf-lo-[a-z0-9]+)[ ,{]/g)].map((m) => m[1] ?? ""));
      const corps = h.slice(h.indexOf("</head>"));
      const posees = new Set([...corps.matchAll(/class="([^"]*)"/g)].flatMap((m) => (m[1] ?? "").split(/\s+/)).filter((c) => c.startsWith("nf-lo-")));
      expect(posees.size).toBeGreaterThan(0);
      expect([...posees].sort()).toEqual([...regles].sort());
      // Les règles vivent dans la media query mobile, pas en clair : sur ordinateur, rien ne bouge.
      const mq = head(h).indexOf("@media only screen and (max-width:");
      expect(mq).toBeGreaterThan(-1);
    });
  }

  // ⛔ `display:block` sur un <table> : ses cellules restent dans une table anonyme taillée au contenu,
  // et le bouton pleine largeur d'une tuile Duo rétrécissait à son libellé à 375 px (vu en capture, 23/09).
  test("aucune TABLE ne porte une classe nf-lo qui la passe en display:block", async () => {
    for (const layout of CALLOUT_LAYOUTS) {
      for (const style of [{ align: "left" }, { align: "center" }]) {
        const h = await html({ ...avecPhoto(layout), ctaFullWidth: true, gallery: [{ src: "https://cdn.test/1.jpg", alt: "One" }], style: { backgroundColor: REPLI, ...style } });
        const regles = new Map([...head(h).matchAll(/\.(nf-lo-[a-z0-9]+) \{([^}]*)\}/g)].map((m) => [m[1] ?? "", m[2] ?? ""]));
        const classes = [...h.matchAll(/<table[^>]*class="([^"]*)"/g)].flatMap((m) => (m[1] ?? "").split(/\s+/)).filter((c) => c.startsWith("nf-lo-"));
        for (const c of classes) expect(`${layout} ${c} ${regles.get(c) ?? "?"}`).not.toContain("display:block");
      }
    }
  });

  // ⚠️ Sans taille ni interligne propres, la cellule du bouton hérite ceux du `mj-text` (ici 20 px × 1,8)
  // et le bouton grandit d'une ligne fantôme : +5 à 6 px sur les maquettes, mesuré le 23/09.
  test("la cellule du bouton porte la taille et l'interligne du libellé, pas ceux du texte courant", async () => {
    for (const layout of CALLOUT_LAYOUTS) {
      const h = await html({ ...avecPhoto(layout), ctaSize: 14, gallery: [{ src: "https://cdn.test/1.jpg", alt: "One" }] }, { fontSize: 20, lineHeight: 1.8 });
      const td = h.match(/<td[^>]*>(?=<a href="https:\/\/site\.test\/listen" target="_blank" style="[^"]*display:inline-block)/)?.[0] ?? "";
      expect(`${layout} ${td}`).toContain("font-size:14px;line-height:1.2;");
    }
  });

  test("la version texte ignore la mise en page", async () => {
    const classique = (await compileDoc(doc({}))).text;
    for (const layout of CALLOUT_LAYOUTS) {
      expect((await compileDoc(doc({ layout, backgroundImage: PHOTO, style: { backgroundColor: REPLI } }))).text).toBe(classique);
    }
  });
});

describe("gardes du schéma", () => {
  const galerie = (n: number) => Array.from({ length: n }, (_, i) => ({ src: `https://cdn.test/${i}.jpg`, alt: `Picture ${i}` }));
  const parse = (callout: Record<string, unknown>) => {
    try {
      doc(callout);
      return true;
    } catch {
      return false;
    }
  };

  test("gallery : 1 à 3 cases, jamais 0 ni 4", () => {
    expect(parse({ layout: "gallery", gallery: galerie(3) })).toBe(true);
    expect(parse({ layout: "gallery", gallery: galerie(1) })).toBe(true);
    expect(parse({ layout: "gallery", gallery: galerie(4) })).toBe(false);
    expect(parse({ layout: "gallery", gallery: [] })).toBe(false);
  });

  test("une mise en page inconnue est refusée", () => {
    expect(parse({ layout: "carousel" })).toBe(false);
  });

  test("ai:// : accepté en brouillon, refusé à la publication — fond et case de galerie", () => {
    const d = doc({
      layout: "gallery",
      backgroundImage: "ai://a stadium at dusk",
      style: { backgroundColor: REPLI },
      gallery: [
        { src: "https://cdn.test/1.jpg", alt: "One" },
        { src: "ai://a microphone", alt: "Two" },
      ],
    });
    const r = EmailDocPublishable.safeParse(d);
    expect(r.success).toBe(false);
    const chemins = (r.error?.issues ?? []).map((i) => i.path.slice(-3).join("."));
    expect(chemins).toContain("blocks.0.backgroundImage");
    expect(chemins).toContain("gallery.1.src");
    // Sans les sentinelles, le même encart se publie.
    const propre = doc({ layout: "gallery", backgroundImage: PHOTO, style: { backgroundColor: REPLI }, gallery: [{ src: "https://cdn.test/1.jpg", alt: "One" }] });
    expect(EmailDocPublishable.safeParse(propre).success).toBe(true);
  });

  test("une tuile à mise en page qui ne porte que son bouton se publie ; un encart classique vide, non", () => {
    const tuile = doc({ layout: "poster", kicker: "", title: "", body: "", backgroundImage: PHOTO, style: { backgroundColor: REPLI } });
    expect(EmailDocPublishable.safeParse(tuile).success).toBe(true);
    const vide = doc({ kicker: "", title: "", body: "" });
    expect(EmailDocPublishable.safeParse(vide).success).toBe(false);
  });
});

describe("avertissements du compilateur", () => {
  const warnings = async (callout: Record<string, unknown>) => (await compileDoc(doc(callout))).warnings;

  test("photo de fond sans couleur de repli : averti — sauf la pochette, dont le texte est sur la carte", async () => {
    const w = await warnings({ layout: "poster", backgroundImage: PHOTO });
    expect(w.some((m) => m.includes("has a background picture but no fallback colour"))).toBe(true);
    expect((await warnings(avecPhoto("poster"))).some((m) => m.includes("no fallback colour"))).toBe(false);
    expect((await warnings({ layout: "cover", backgroundImage: PHOTO })).some((m) => m.includes("no fallback colour"))).toBe(false);
  });

  test("fond et case de galerie en http:// ou en sentinelle : un avertissement chacun", async () => {
    const w = await warnings({
      layout: "gallery",
      backgroundImage: "http://cdn.test/fond.jpg",
      style: { backgroundColor: REPLI },
      gallery: [
        { src: "https://cdn.test/1.jpg", alt: "One" },
        { src: "ai://a microphone", alt: "Two" },
      ],
    });
    expect(w.some((m) => m.startsWith("Callout background picture on") && m.includes("http://"))).toBe(true);
    expect(w.some((m) => m.startsWith("Callout gallery picture 2 on") && m.includes("AI placeholder"))).toBe(true);
    expect(w.some((m) => m.startsWith("Callout gallery picture 1 on"))).toBe(false);
  });

  test("case de galerie sans alt : avertie", async () => {
    const w = await warnings({ layout: "gallery", gallery: [{ src: "https://cdn.test/1.jpg", alt: " " }] });
    expect(w.some((m) => m.startsWith("Callout gallery picture 1 on") && m.includes("no alt text"))).toBe(true);
  });

  test("tuile bouton seul : pas d'avertissement « neither a title nor a body »", async () => {
    const w = await warnings({ layout: "poster", kicker: "", title: "", body: "" });
    expect(w.some((m) => m.includes("neither a title nor a body"))).toBe(false);
    const classique = await warnings({ kicker: "", title: "", body: "" });
    expect(classique.some((m) => m.includes("neither a title nor a body"))).toBe(true);
  });
});
