import { afterEach, describe, expect, test } from "bun:test";
import {
  buildUserMessage,
  clampText,
  generateEditionIntro,
  MAX_PREHEADER_CHARS,
  type IntroInput,
} from "./newsletter-intro";

/**
 * Ce banc mesure les DEUX garanties dont dépend un envoi :
 *  1. la fonction ne lève jamais — un modèle indisponible ou qui refuse laisse geler l'édition ;
 *  2. les bornes tiennent EN CODE — l'API rejette les contraintes de valeur dans un schéma de
 *     sortie (HTTP 400), donc rien d'autre que ce code ne borne le preheader.
 *
 * L'appel réseau est remplacé par un double posé sur `globalThis.fetch` : on ne teste pas le
 * modèle, on teste ce que notre code lui envoie et ce qu'il fait de sa réponse.
 */

const vraiFetch = globalThis.fetch;
const vraieCle = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
  globalThis.fetch = vraiFetch;
  if (vraieCle === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = vraieCle;
});

/** Remplace `fetch` par un double qui rend `corps` et retient ce que le client a envoyé. */
function interceptFetch(corps: Record<string, unknown>) {
  const vu: { body?: any } = {};
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    vu.body = JSON.parse(String(init?.body ?? "{}"));
    return new Response(JSON.stringify(corps), { status: 200 });
  }) as unknown as typeof fetch;
  return vu;
}

function reponseModele(preheader: string, intro: string) {
  return {
    model: "modele-de-test",
    stop_reason: "end_turn",
    content: [{ type: "text", text: JSON.stringify({ preheader, intro }) }],
    usage: { input_tokens: 10, output_tokens: 20 },
  };
}

const ENTREE: IntroInput = {
  assetName: "Quartz Tips",
  language: "pt-BR",
  articles: [{ title: "Titre un" }, { title: "Titre deux" }],
};

describe("clampText", () => {
  test("normalise les espaces et les sauts de ligne", () => {
    // L'intro part dans du HTML : un `\n` y est invisible, il ne doit pas survivre au parsing.
    expect(clampText("a\n\nb   c\t d ", 100)).toBe("a b c d");
  });

  test("tronque sur une frontière de mot, sous le plafond", () => {
    const s = clampText("aaa bbb ccc ddd eee", 11);
    expect(s.length).toBeLessThanOrEqual(11);
    expect(s).toBe("aaa bbb");
  });

  test("un mot unique plus long que le plafond est coupé net, pas vidé", () => {
    // Contre-cas : la coupe sur frontière de mot ne doit pas rendre une chaîne vide, sinon une
    // langue sans séparateur perdrait tout le texte au lieu d'en perdre la fin.
    expect(clampText("x".repeat(50), 10)).toBe("x".repeat(10));
  });

  test("une valeur absente rend une chaîne vide, pas \"undefined\"", () => {
    expect(clampText(undefined, 10)).toBe("");
    expect(clampText(null, 10)).toBe("");
  });
});

describe("buildUserMessage", () => {
  test("porte la marque, la langue et les titres numérotés", () => {
    const m = buildUserMessage(ENTREE);
    expect(m).toContain("Brand: Quartz Tips");
    expect(m).toContain("Language: pt-BR");
    expect(m).toContain("1. Titre un");
    expect(m).toContain("2. Titre deux");
    expect(m).toContain("Headlines in this edition (2)");
  });

  test("le sujet n'apparaît que s'il existe", () => {
    expect(buildUserMessage(ENTREE)).not.toContain("Subject line");
    expect(buildUserMessage({ ...ENTREE, subject: "Le sujet" })).toContain("Subject line already chosen: Le sujet");
  });

  test("le chapô n'apparaît que s'il est non vide", () => {
    const avec = buildUserMessage({ ...ENTREE, articles: [{ title: "T", excerpt: "Le chapô" }] });
    expect(avec).toContain("1. T — Le chapô");
    const sans = buildUserMessage({ ...ENTREE, articles: [{ title: "T", excerpt: "   " }] });
    expect(sans).toContain("1. T");
    expect(sans).not.toContain("—");
  });
});

describe("generateEditionIntro", () => {
  test("sans article : refuse SANS appeler le modèle", async () => {
    // Si un appel partait quand même, le double lèverait faute d'avoir été posé : l'absence
    // d'exception ici prouve qu'aucune requête n'a eu lieu.
    globalThis.fetch = (() => {
      throw new Error("le modèle a été appelé alors qu'il n'y a rien à résumer");
    }) as unknown as typeof fetch;
    const r = await generateEditionIntro({ ...ENTREE, articles: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("no-articles");
  });

  test("des titres vides comptent pour zéro article", async () => {
    globalThis.fetch = (() => {
      throw new Error("appel inattendu");
    }) as unknown as typeof fetch;
    const r = await generateEditionIntro({ ...ENTREE, articles: [{ title: "  " }, { title: "" }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("no-articles");
  });

  test("le nombre annoncé au modèle est celui des titres RETENUS", async () => {
    process.env.ANTHROPIC_API_KEY = "cle-de-test";
    const vu = interceptFetch(reponseModele("Accroche", "Intro."));
    await generateEditionIntro({ ...ENTREE, articles: [{ title: "A" }, { title: "   " }, { title: "B" }] });
    const envoye = String(vu.body.messages[0].content[0].text);
    // Annoncer 3 alors qu'on n'en fournit que 2 ferait promettre au modèle un article absent.
    expect(envoye).toContain("Headlines in this edition (2)");
    expect(envoye).toContain("1. A");
    expect(envoye).toContain("2. B");
  });

  test("un preheader trop long est ramené sous la borne", async () => {
    process.env.ANTHROPIC_API_KEY = "cle-de-test";
    const long = "mot ".repeat(200).trim();
    interceptFetch(reponseModele(long, long));
    const r = await generateEditionIntro(ENTREE);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.preheader.length).toBeLessThanOrEqual(MAX_PREHEADER_CHARS);
      expect(r.intro.length).toBeLessThanOrEqual(600);
      expect(r.model).toBe("modele-de-test");
    }
  });

  test("une moitié vide n'est pas un succès", async () => {
    process.env.ANTHROPIC_API_KEY = "cle-de-test";
    interceptFetch(reponseModele("", "Une intro correcte."));
    const r = await generateEditionIntro(ENTREE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("bad_response");
  });

  test("un refus du modèle rend un motif, il ne lève pas", async () => {
    process.env.ANTHROPIC_API_KEY = "cle-de-test";
    interceptFetch({ model: "m", stop_reason: "refusal", stop_details: { category: "x" }, content: [] });
    const r = await generateEditionIntro(ENTREE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("refusal");
  });

  test("une panne réseau rend un motif, elle ne lève pas", async () => {
    process.env.ANTHROPIC_API_KEY = "cle-de-test";
    globalThis.fetch = (async () => {
      throw new Error("socket coupée");
    }) as unknown as typeof fetch;
    const r = await generateEditionIntro(ENTREE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("server");
  });

  test("sans clé configurée, l'édition peut encore geler", async () => {
    // ⛔ La garantie centrale : un service tiers non configuré ne doit pas empêcher un envoi.
    delete process.env.ANTHROPIC_API_KEY;
    const r = await generateEditionIntro(ENTREE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("not_configured");
  });

  test("le system prompt reste identique d'un appel à l'autre", async () => {
    // Il porte `cache_control: ephemeral` : la moindre interpolation casserait le cache.
    process.env.ANTHROPIC_API_KEY = "cle-de-test";
    const a = interceptFetch(reponseModele("A", "B"));
    await generateEditionIntro(ENTREE);
    const b = interceptFetch(reponseModele("A", "B"));
    await generateEditionIntro({ ...ENTREE, assetName: "Autre marque", language: "es" });
    expect(a.body.system[0].text).toBe(b.body.system[0].text);
    expect(a.body.system[0].cache_control).toEqual({ type: "ephemeral" });
  });
});
