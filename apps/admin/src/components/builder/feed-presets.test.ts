/**
 * STYLES PRÊTS DU FLUX — Classic / Compact / Hero (24/09/2026, feature 5, étape 6).
 *
 * Ce qui est tenu :
 *  - chaque style écrit SA disposition (arrangement, unes, tailles, vignette, filet) et ne repeint rien :
 *    couleurs, polices, surtitre, libellés d'un look restent ;
 *  - un style est « actif » ssi le choisir ne changerait rien ; un réglage fait main ⇒ « Custom » ;
 *  - un flux neuf est déjà Classic (le défaut), et le choisir n'empile rien ;
 *  - reducer : une étape d'annulation, un second clic n'empile rien ;
 *  - l'e-mail compilé : les trois styles rendent trois e-mails différents ;
 *  - le sélecteur : trois boutons, `aria-pressed` sur l'actif, le clic envoie l'action.
 */
import { describe, expect, test } from "bun:test";
import { isValidElement, type ReactNode } from "react";
import { compileDoc } from "@nf/render/compile";
import { EmailDoc, type ArticleFeedBlock } from "@nf/render/schema";
import { appliquerStyleFlux, FEED_PRESETS, styleFluxActif, type FeedPreset } from "./feed-presets";
import { FeedCardFields, FeedPresetPicker } from "./inspector";
import { builderReducer, initBuilderState, type BuilderAction } from "./reducer";

type Json = Record<string, unknown>;
const ITEM = (n: number) => ({
  postId: `post-${n}`,
  title: `Carte ${n}`,
  excerpt: `Chapeau ${n}`,
  href: `https://example.test/article-${n}`,
  imageSrc: `https://example.test/img-${n}.jpg`,
  imageAlt: "",
  publishedAt: "2026-09-22T21:42:00.000Z",
});

function docFlux(feed: Json = {}): EmailDoc {
  return EmailDoc.parse({
    schema: 2,
    meta: { subject: "Sujet", preheader: "Preheader", assetSlug: "banc", locale: "en" },
    theme: {},
    rows: [
      {
        id: "r",
        layout: "1",
        columns: [
          {
            id: "c",
            blocks: [
              {
                id: "feed",
                type: "article-feed",
                sourceId: "src_1",
                count: 4,
                previewItems: [ITEM(1), ITEM(2), ITEM(3), ITEM(4)],
                previewAt: "2026-09-22T12:00:00.000Z",
                ...feed,
              },
            ],
          },
        ],
      },
    ],
  });
}
const flux = (d: EmailDoc) => d.rows[0]!.columns[0]!.blocks[0] as ArticleFeedBlock;

/** Un flux « de marque » : couleurs, police, surtitre et libellés posés sur les looks. */
const MARQUE = {
  showKicker: true,
  lead: { titleColor: "#123456", kickerMode: "text", kickerText: "Destacada", titleFont: "Georgia, serif" },
  card: { titleColor: "#654321", ctaLabel: "Leer", metaMode: "time" },
  midSection: { label: "Más noticias" },
};

describe("chaque style écrit sa disposition, et rien d'autre", () => {
  test("Classic : empilé, sans une, tailles par défaut, sans filet", () => {
    const b = appliquerStyleFlux(flux(docFlux({ layout: "side", leadCount: 2, card: { titleSize: 15, imageWidthPct: 20 }, cardRule: {} })), "classic");
    expect([b.layout, b.leadCount, b.card, b.cardRule]).toEqual(["stacked", undefined, undefined, undefined]);
    expect("leadCount" in b || "card" in b || "cardRule" in b).toBe(false);
  });

  test("Compact : côte à côte, vignette 28 %, titres 17 px, lien texte, un filet", () => {
    const b = appliquerStyleFlux(flux(docFlux()), "compact");
    expect([b.layout, b.leadCount, b.card, b.cardRule]).toEqual(["side", undefined, { imageWidthPct: 28, titleSize: 17, ctaStyle: "link" }, {}]);
  });

  test("⛔ un lien de lecture RETIRÉ le reste, sur le look comme sur le flux ; Classic rend le défaut du flux", () => {
    for (const p of ["compact", "hero"] as const) {
      expect([p, appliquerStyleFlux(flux(docFlux({ ctaStyle: "none" })), p).card?.ctaStyle]).toEqual([p, undefined]);
      expect([p, appliquerStyleFlux(flux(docFlux({ card: { ctaStyle: "none" } })), p).card?.ctaStyle]).toEqual([p, "none"]);
    }
    expect(appliquerStyleFlux(flux(docFlux({ card: { ctaStyle: "none" } })), "classic").card?.ctaStyle).toBe("none");
    expect(appliquerStyleFlux(flux(docFlux({ card: { ctaStyle: "link" } })), "classic").card).toBeUndefined();
  });

  test("Hero : une empilée à 26 px, brèves compactes, filet ; une une de 2 est gardée", () => {
    const b = appliquerStyleFlux(flux(docFlux()), "hero");
    expect([b.layout, b.leadCount, b.lead, b.card, b.cardRule]).toEqual([
      "side",
      1,
      { layout: "stacked", titleSize: 26 },
      { imageWidthPct: 28, titleSize: 17, ctaStyle: "link" },
      {},
    ]);
    expect(appliquerStyleFlux(flux(docFlux({ leadCount: 2 })), "hero").leadCount).toBe(2);
  });

  test("⛔ un style ne repeint rien : couleurs, police, surtitre, libellé et filet posé restent", () => {
    for (const p of FEED_PRESETS) {
      const avant = flux(docFlux({ ...MARQUE, cardRule: { color: "#DDDDDD", thickness: 2 } }));
      const b = appliquerStyleFlux(avant, p);
      expect([p, b.lead?.titleColor, b.lead?.kickerText, b.lead?.titleFont]).toEqual([p, "#123456", "Destacada", "Georgia, serif"]);
      expect([p, b.card?.titleColor, b.card?.ctaLabel, b.card?.metaMode]).toEqual([p, "#654321", "Leer", "time"]);
      expect([p, b.showKicker, b.midSection]).toEqual([p, true, { label: "Más noticias" }]);
      // Compact et Hero gardent le filet posé tel quel ; Classic le retire (pas de filet, par définition).
      expect([p, b.cardRule]).toEqual([p, p === "classic" ? undefined : { color: "#DDDDDD", thickness: 2 }]);
    }
  });

  test("les brèves perdent leur `layout` propre : « Arrangement » montre ce qui part", () => {
    for (const p of FEED_PRESETS) expect([p, appliquerStyleFlux(flux(docFlux({ card: { layout: "side" } })), p).card?.layout]).toEqual([p, undefined]);
  });
});

describe("style actif", () => {
  test("un flux neuf est Classic ; après un choix, c'est ce choix", () => {
    expect(styleFluxActif(flux(docFlux()))).toBe("classic");
    for (const p of FEED_PRESETS) expect(styleFluxActif(appliquerStyleFlux(flux(docFlux(MARQUE)), p))).toBe(p);
  });

  test("un réglage fait main ⇒ Custom (null)", () => {
    const compact = appliquerStyleFlux(flux(docFlux()), "compact");
    expect(styleFluxActif({ ...compact, card: { ...compact.card, titleSize: 18 } })).toBeNull();
    expect(styleFluxActif(flux(docFlux({ leadCount: 1 })))).toBeNull();
  });
});

describe("reducer", () => {
  const applique = (preset: FeedPreset): BuilderAction => ({ type: "applyFeedPreset", blockId: "feed", preset });

  test("une étape d'annulation ; un second clic n'empile rien ; undo rend l'avant", () => {
    const avant = docFlux(MARQUE);
    const s1 = builderReducer(initBuilderState(avant), applique("hero"));
    expect(s1.past.length).toBe(1);
    expect(styleFluxActif(flux(s1.present))).toBe("hero");
    expect(builderReducer(s1, applique("hero"))).toBe(s1);
    expect(JSON.stringify(builderReducer(s1, { type: "undo" }).present)).toBe(JSON.stringify(avant));
  });

  test("Classic sur un flux neuf : rien ne change, rien n'est empilé", () => {
    const s0 = initBuilderState(docFlux());
    expect(builderReducer(s0, applique("classic"))).toBe(s0);
  });

  test("un bloc qui n'est pas un flux : rien", () => {
    const d = docFlux();
    const s0 = initBuilderState(d);
    expect(builderReducer(s0, { type: "applyFeedPreset", blockId: "absent", preset: "hero" })).toBe(s0);
  });
});

describe("l'e-mail compilé", () => {
  test("trois styles, trois e-mails ; Classic sur un flux neuf = l'e-mail d'avant", async () => {
    const base = docFlux();
    const avec = (p: FeedPreset) => ({ ...base, rows: [{ ...base.rows[0]!, columns: [{ ...base.rows[0]!.columns[0]!, blocks: [appliquerStyleFlux(flux(base), p)] }] }] });
    const [avant, classic, compact, hero] = await Promise.all([
      compileDoc(base),
      compileDoc(avec("classic")),
      compileDoc(avec("compact")),
      compileDoc(avec("hero")),
    ]);
    expect(classic.html).toBe(avant.html);
    expect(new Set([classic.html, compact.html, hero.html]).size).toBe(3);
  });
});

describe("le sélecteur « Card style »", () => {
  const boutons = (node: ReactNode, out: Json[] = []): Json[] => {
    if (Array.isArray(node)) node.forEach((n) => boutons(n as ReactNode, out));
    else if (isValidElement(node)) {
      const props = node.props as Json;
      if (node.type === "button") out.push(props);
      else if (typeof node.type === "function") boutons((node.type as (p: unknown) => ReactNode)(props), out);
      else boutons(props.children as ReactNode, out);
    }
    return out;
  };

  test("trois boutons, l'actif pressé, le clic envoie le style", () => {
    const recu: BuilderAction[] = [];
    const b = flux(docFlux());
    const bs = boutons(FeedPresetPicker({ block: b, dispatch: (a) => recu.push(a) }));
    expect(bs.map((x) => [x.children, x["aria-pressed"]])).toEqual([
      ["Classic", true],
      ["Compact", false],
      ["Hero", false],
    ]);
    (bs[2]!.onClick as () => void)();
    expect(recu).toEqual([{ type: "applyFeedPreset", blockId: "feed", preset: "hero" }]);
  });

  test("réglé à la main : aucun bouton pressé", () => {
    const bs = boutons(FeedPresetPicker({ block: flux(docFlux({ leadCount: 1 })), dispatch: () => {} }));
    expect(bs.map((x) => x["aria-pressed"])).toEqual([false, false, false]);
  });

  test("il ouvre la section Cards de l'éditeur du flux, avant « Arrangement »", () => {
    const tree = FeedCardFields({ block: flux(docFlux()), patch: () => {}, dispatch: () => {}, locale: "en" }) as {
      props: { children: ReactNode[] };
    };
    const enfants = (tree.props.children as unknown[]).filter(isValidElement);
    expect(enfants[0]?.type).toBe(FeedPresetPicker);
    expect((enfants[1]?.props as Json).label).toBe("Arrangement");
  });
});
