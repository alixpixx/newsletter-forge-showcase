/**
 * Banc de la RÉCOLTE d'articles (`fetchPosts`).
 *
 * Ce qui se joue ici est invisible à l'écran : une pagination qui se trompe de curseur rend un
 * pool plausible — le bon nombre d'articles, tous réels — mais amputé ou dupliqué. Le classement
 * par vues calculé dessus serait alors juste sur l'ordre et faux sur la fenêtre, sans que rien ne
 * le signale.
 *
 *  1. **`per_page` doit rester CONSTANT pendant une pagination.** `page` est un numéro de page, pas
 *     un décalage : réduire la taille sur la dernière page pour ne demander que le reste ferait
 *     repartir le curseur en arrière. C'est le témoin principal de ce banc.
 *  2. **Une page incomplète arrête la boucle**, sans dépendre de `x-wp-totalpages` — absent sur
 *     certains plugins de cache.
 *  3. **Une troncature se DIT.** Atteindre le plafond alors que le site en annonce davantage n'est
 *     pas la même chose que l'avoir vidé, et les deux rendent le même tableau plein.
 *  4. **Le mode `date` ne paie aucun appel de plus** qu'avant : un `limit` sous la taille de page
 *     fait exactement un tour.
 */
import { describe, expect, mock, test } from "bun:test";

const vraiGuard = await import("./guard");

/** Un appel sortant, tel qu'il est réellement parti. */
interface Appel {
  url: URL;
  /** Le budget de temps demandé au garde — `undefined` = son défaut. */
  timeoutMs: number | undefined;
}

const appels: Appel[] = [];
/** Ce que le faux site répond, page par page — posé par chaque test. */
let pages: { corps: unknown; total?: number | null }[] = [];

mock.module("./guard", () => ({
  ...vraiGuard,
  safeFetch: async (url: string, opts?: { timeoutMs?: number }) => {
    const u = new URL(url);
    appels.push({ url: u, timeoutMs: opts?.timeoutMs });
    const page = Number(u.searchParams.get("page") ?? "1");
    const rendu = pages[page - 1] ?? { corps: [] };
    const headers = new Headers();
    // ⚠️ `x-wp-total` est le total de la REQUÊTE, pas de la page — c'est ce que WordPress met, et
    // c'est ce sur quoi `truncated` se prononce.
    const total = rendu.total === undefined ? pages.reduce((n, p) => n + (Array.isArray(p.corps) ? p.corps.length : 0), 0) : rendu.total;
    if (total !== null) headers.set("x-wp-total", String(total));
    return { url, status: 200, headers, text: JSON.stringify(rendu.corps), redirects: 0 };
  },
}));

const { fetchPost, fetchPosts, fetchPostsByIds, probe, MAX_POOL } = await import("./client");

/** Un article WordPress réduit à ce que `toCandidates` lit. */
const article = (id: number) => ({
  id,
  link: `https://exemple-wp.test/article-${id}/`,
  date_gmt: "2026-08-30T10:00:00",
  title: { rendered: `Article ${id}` },
  excerpt: { rendered: `<p>Extrait ${id}</p>` },
});

/** `n` articles d'affilée, en repartant de `depuis`. */
const lot = (n: number, depuis = 0) => Array.from({ length: n }, (_, i) => article(depuis + i + 1));

const ROOT = "https://exemple-wp.test";
const AUTH = { kind: "none" } as const;

function reset(nouvelles: { corps: unknown; total?: number | null }[]) {
  appels.length = 0;
  pages = nouvelles;
}

describe("fetchPosts — un pool sous la taille de page", () => {
  test("fait exactement un appel, et demande exactement ce qu'on veut", async () => {
    reset([{ corps: lot(12) }]);
    const r = await fetchPosts(ROOT, AUTH, { limit: 12 });

    expect(appels.length).toBe(1);
    expect(appels[0]?.url.searchParams.get("per_page")).toBe("12");
    expect(appels[0]?.url.searchParams.get("page")).toBe("1");
    expect(r.candidates.length).toBe(12);
    // Le site a tout donné : rien n'est tronqué, et le dire faux enverrait l'auteur réduire une
    // fenêtre qui tient déjà entière.
    expect(r.truncated).toBe(false);
  });

  test("le défaut reste cinq articles — le mode `date` ne change pas de comportement", async () => {
    reset([{ corps: lot(5) }]);
    await fetchPosts(ROOT, AUTH);
    expect(appels.length).toBe(1);
    expect(appels[0]?.url.searchParams.get("per_page")).toBe("5");
  });
});

describe("fetchPosts — pagination", () => {
  /**
   * ⛔ LE TÉMOIN QUI COMPTE. Avec 250 demandés, la troisième page ne doit PAS être réclamée en
   * `per_page=50` : `per_page=50&page=3` désigne les articles 101 à 150, déjà lus deux fois. La
   * réponse aurait la bonne taille et le mauvais contenu.
   */
  test("garde `per_page` constant sur toutes les pages", async () => {
    reset([{ corps: lot(100) }, { corps: lot(100, 100) }, { corps: lot(100, 200) }]);
    const r = await fetchPosts(ROOT, AUTH, { limit: 250 });

    expect(appels.map((a) => a.url.searchParams.get("per_page"))).toEqual(["100", "100", "100"]);
    expect(appels.map((a) => a.url.searchParams.get("page"))).toEqual(["1", "2", "3"]);

    // Coupé à ce qui était demandé, pas à ce que la dernière page a rapporté.
    expect(r.candidates.length).toBe(250);
    // Et l'ordre est celui du site, sans trou ni répétition : c'est ce qu'un curseur cassé perdrait.
    expect(r.candidates[0]?.permalink).toBe("https://exemple-wp.test/article-1/");
    expect(r.candidates[249]?.permalink).toBe("https://exemple-wp.test/article-250/");
    expect(new Set(r.candidates.map((c) => c.permalink)).size).toBe(250);
  });

  test("s'arrête sur une page incomplète, sans lire `x-wp-totalpages`", async () => {
    // 100 puis 37 : le site n'a plus rien. Une troisième requête serait un appel pour rien à un
    // site qu'on ne contrôle pas.
    reset([{ corps: lot(100) }, { corps: lot(37, 100) }]);
    const r = await fetchPosts(ROOT, AUTH, { limit: 500 });

    expect(appels.length).toBe(2);
    expect(r.candidates.length).toBe(137);
    expect(r.truncated).toBe(false);
  });

  test("s'arrête aussi sur une page vide", async () => {
    reset([{ corps: lot(100) }, { corps: [] }]);
    const r = await fetchPosts(ROOT, AUTH, { limit: 300 });
    expect(appels.length).toBe(2);
    expect(r.candidates.length).toBe(100);
  });
});

describe("fetchPosts — la troncature se dit", () => {
  test("plafond atteint et le site en annonce plus ⇒ `truncated`", async () => {
    // 500 rapatriés sur 900 annoncés : le classement ne portera que sur les plus récents.
    reset([
      { corps: lot(100), total: 900 },
      { corps: lot(100, 100) },
      { corps: lot(100, 200) },
      { corps: lot(100, 300) },
      { corps: lot(100, 400) },
    ]);
    const r = await fetchPosts(ROOT, AUTH, { limit: MAX_POOL });

    expect(r.candidates.length).toBe(MAX_POOL);
    expect(r.total).toBe(900);
    expect(r.truncated).toBe(true);
  });

  test("plafond atteint mais le site n'en avait pas plus ⇒ PAS tronqué", async () => {
    reset([{ corps: lot(100), total: 100 }]);
    const r = await fetchPosts(ROOT, AUTH, { limit: 100 });
    expect(r.candidates.length).toBe(100);
    expect(r.truncated).toBe(false);
  });

  /**
   * ⚠️ Sans en-tête, on ne SAIT pas s'il en restait. Annoncer `truncated: true` par prudence ferait
   * afficher un avertissement permanent sur les sites dont un cache mange l'en-tête, et un
   * avertissement permanent cesse d'être lu.
   */
  test("sans `x-wp-total`, on n'invente pas une troncature", async () => {
    reset([{ corps: lot(100), total: null }]);
    const r = await fetchPosts(ROOT, AUTH, { limit: 100 });
    expect(r.total).toBe(null);
    expect(r.truncated).toBe(false);
  });

  test("le plafond `MAX_POOL` borne un `limit` déraisonnable", async () => {
    reset([{ corps: lot(100) }, { corps: lot(100, 100) }, { corps: lot(100, 200) }, { corps: lot(100, 300) }, { corps: lot(100, 400) }, { corps: lot(100, 500) }]);
    const r = await fetchPosts(ROOT, AUTH, { limit: 10_000 });
    // Six pages sont disponibles, cinq suffisent à remplir le plafond : la sixième n'est jamais
    // demandée. Un plafond qui laisse partir l'appel de trop ne plafonne rien.
    expect(r.candidates.length).toBe(MAX_POOL);
    expect(appels.length).toBe(MAX_POOL / 100);
  });
});

describe("fetchPosts — ce qui part dans l'URL", () => {
  test("les bornes de date et les filtres sont transmis, sur chaque page", async () => {
    reset([{ corps: lot(100) }, { corps: lot(20, 100) }]);
    await fetchPosts(ROOT, AUTH, {
      limit: 500,
      categories: [12087, 5609],
      tags: [7],
      after: "2026-08-25T23:59:59",
      before: "2026-09-01T23:59:59",
    });

    for (const a of appels) {
      // ⛔ Perdre une borne sur la deuxième page rapporterait des articles hors fenêtre, mêlés aux
      // autres, sans que le compte final ait l'air anormal.
      expect(a.url.searchParams.get("after")).toBe("2026-08-25T23:59:59");
      expect(a.url.searchParams.get("before")).toBe("2026-09-01T23:59:59");
      expect(a.url.searchParams.get("categories")).toBe("12087,5609");
      expect(a.url.searchParams.get("tags")).toBe("7");
      expect(a.url.searchParams.get("status")).toBe("publish");
    }
  });

  test("sans filtre, aucun paramètre vide n'est envoyé", async () => {
    reset([{ corps: lot(5) }]);
    await fetchPosts(ROOT, AUTH, { limit: 5 });
    const p = appels[0]?.url.searchParams;
    // Un `categories=` vide n'est pas neutre : WordPress répond 400 `rest_invalid_param`.
    expect(p?.has("categories")).toBe(false);
    expect(p?.has("tags")).toBe(false);
    expect(p?.has("after")).toBe(false);
    expect(p?.has("before")).toBe(false);
  });
});

/**
 * ⛔ LE BUDGET DES LISTES D'ARTICLES (25/09/2026). La requête de gel de Northwind Sports a mis jusqu'à 9,8 s
 * hors cache — et une variante 18,6 s — contre un budget de 10 s : édition retenue, aperçu en échec.
 * Les trois lectures d'articles prennent `WP_POSTS_TIMEOUT_MS` ; la sonde garde le défaut court.
 */
describe("le budget de temps de chaque lecture", () => {
  test("les listes d'articles (toutes les pages) prennent le budget des articles", async () => {
    reset([{ corps: lot(100) }, { corps: lot(20, 100) }]);
    await fetchPosts(ROOT, AUTH, { limit: 150 });
    expect(appels.length).toBe(2);
    for (const a of appels) expect(a.timeoutMs).toBe(vraiGuard.WP_POSTS_TIMEOUT_MS);
  });

  test("le second temps d'un classement et l'article seul aussi", async () => {
    reset([{ corps: lot(2) }]);
    await fetchPostsByIds(ROOT, AUTH, ["1", "2"]);
    expect(appels.length).toBe(1);
    expect(appels[0]?.timeoutMs).toBe(vraiGuard.WP_POSTS_TIMEOUT_MS);

    reset([{ corps: article(7) }]);
    await fetchPost(ROOT, AUTH, "7");
    expect(appels.length).toBe(1);
    expect(appels[0]?.timeoutMs).toBe(vraiGuard.WP_POSTS_TIMEOUT_MS);
  });

  test("la sonde garde le budget court : un site mort doit s'y dire vite", async () => {
    reset([{ corps: { namespaces: [] } }]);
    await probe(ROOT, AUTH);
    expect(appels[0]?.timeoutMs).toBe(vraiGuard.WP_TIMEOUT_MS);
    expect(vraiGuard.WP_POSTS_TIMEOUT_MS > vraiGuard.WP_TIMEOUT_MS).toBe(true);
  });
});
