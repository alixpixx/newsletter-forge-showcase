"use client";

/**
 * IMPORT D'ARTICLES WORDPRESS — le geste demandé par la collègue le 20/08 :
 * « il faut absolument que la partie content soit une preview de nos articles ou contenus WP. on
 * doit pouvoir choisir la catégorie, le nombre d'articles, le type (les derniers, les plus lus,
 * etc), un peu comme on a fait pour la partie réseaux sociaux. »
 *
 * Quatre partis pris, tous vérifiables à l'écran :
 *
 *  1. **On montre les VRAIS articles avant d'insérer.** Une insertion à l'aveugle suivie d'une
 *     relecture bloc par bloc coûte plus cher que de choisir dans une grille.
 *  2. **Ce qui est inséré est ce qui a été montré.** Les cartes cochées partent telles quelles ;
 *     le serveur ne rejoue pas la requête (le site peut publier entre-temps).
 *  3. **La sortie est faite de blocs `article` ordinaires.** Aucun bloc « WordPress » spécial, rien
 *     qui se re-synchronise dans le dos de l'auteur : une fois insérés, ce sont des blocs qu'il
 *     édite, réordonne ou supprime comme s'il les avait tapés.
 *  4. **« Les plus lus » vient de l'ANALYTICS, pas de WordPress.** Aucun des neuf domaines sondés
 *     n'expose l'endpoint de popularité (mesuré le 20/08) — mais l'entrepôt data-warehouse porte
 *     l'audience page × jour, dans la même base Postgres. La colonne « views » affiche donc les
 *     vues réelles des candidats, et le tri par vues classe CE QUI EST DÉJÀ À L'ÉCRAN : les
 *     articles des catégories choisies, jamais le site entier. Quand l'audience manque, la raison
 *     est écrite (propriété non élue, source muette, entrepôt injoignable) — jamais un tri
 *     silencieusement retombé sur la date (01/09/2026).
 *
 * Le POIDS n'est pas recompté ici : le panneau de pré-vol mesure déjà le document entier et
 * réagira dès l'insertion. Deux compteurs pour un seuil de conformité finiraient par diverger.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { AlertTriangle, Check, ExternalLink, Loader2, Search } from "lucide-react";
import type { Row } from "@nf/render/schema";
// `@nf/analytics` ne dépend d'AUCUN client : il décrit la seule capacité qu'il utilise (`ClientRpc`)
// et le vrai client lui est passé par l'appelant. Rien de Supabase n'entre donc dans le bundle du
// navigateur, et `publieApresLaFenetre` est une fonction pure, sûre à importer côté client.
import type { AudienceJson } from "@nf/analytics/article-views";
import { publieApresLaFenetre } from "@nf/analytics/article-views";
import { defaultArticleCta } from "@nf/render/cta";
import { Btn } from "@/components/ui";
import { cn } from "@/lib/utils";
import { Modal } from "./modal";

/* ------------------------------------------------------------------ *
 * Formes échangées avec les routes
 * ------------------------------------------------------------------ */

interface SourceOption {
  id: string;
  label: string;
  restRoot: string;
  status: "unknown" | "ok" | "error";
  statusDetail: string | null;
  editionLabel?: string | null;
  defaultCategories: number[];
  capabilities: Record<string, unknown>;
}

interface Term {
  id: number;
  name: string;
  slug: string;
  count: number;
}

interface Candidate {
  id: string;
  title: string;
  excerpt: string;
  permalink: string;
  publishedAt: string | null;
  imageUrl: string | null;
  imageAlt: string;
  categoryNames: string[];
}

const INPUT =
  "w-full rounded-lg border border-border bg-card px-2.5 py-1.5 text-[12.5px] text-foreground " +
  "placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40";

/**
 * Bornes de la quantité d'articles demandée à WordPress.
 *
 * 1 est un cas réel (une édition spéciale bâtie autour d'un seul papier), et la liste fermée
 * précédente l'interdisait. Le plafond n'est pas décoratif : au-delà d'une douzaine de vignettes,
 * l'email dépasse le seuil de 102 Ko où Gmail le tronque — le pré-vol le dirait, mais après coup.
 */
const MIN_COUNT = 1;
const MAX_COUNT = 12;
const QUICK_COUNTS = [3, 5, 10];

const clampCount = (n: number): number =>
  // ⚠️ `Number("")` vaut NaN et NaN échoue à toute comparaison : sans ce test, vider le champ
  // écrivait NaN dans `per_page` et la requête partait sans quantité.
  Number.isFinite(n) ? Math.min(MAX_COUNT, Math.max(MIN_COUNT, Math.round(n))) : MIN_COUNT;

/** Lecture d'erreur commune : le corps JSON `{error}` d'abord, le statut ensuite. */
async function errorOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    /* corps illisible : on retombe sur le statut */
  }
  return `the request failed (${res.status})`;
}

/** « il y a 3 h » — la fraîcheur est l'information qui décide, pas la date exacte. */
function ago(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return `${Math.max(1, Math.floor(ms / 60_000))} min ago`;
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

/* ------------------------------------------------------------------ *
 * Sélecteur de taxonomie (catégories / étiquettes)
 * ------------------------------------------------------------------ */

function TermPicker({
  sourceId,
  taxonomy,
  label,
  hint,
  selected,
  onToggle,
}: {
  sourceId: string;
  taxonomy: "categories" | "tags";
  label: string;
  hint: string;
  selected: Term[];
  onToggle: (term: Term) => void;
}) {
  const inputId = useId();
  const [query, setQuery] = useState("");
  const [terms, setTerms] = useState<Term[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sourceId) return;
    let cancelled = false;
    // Anti-rebond : une frappe = une requête vers un site tiers, on attend la fin du mot.
    const timer = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const url = `/api/builder/wp/terms?sourceId=${encodeURIComponent(sourceId)}&taxonomy=${taxonomy}&q=${encodeURIComponent(query)}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(await errorOf(res));
        const body = (await res.json()) as { terms?: Term[]; truncated?: boolean };
        if (cancelled) return;
        setTerms(Array.isArray(body.terms) ? body.terms : []);
        setTruncated(Boolean(body.truncated));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "could not load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sourceId, taxonomy, query]);

  const isPicked = (id: number) => selected.some((t) => t.id === id);

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <label htmlFor={inputId} className="text-[11.5px] font-semibold">
          {label}
        </label>
        <span className="text-[10.5px] text-muted-foreground/80">{hint}</span>
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
        <input
          id={inputId}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${label.toLowerCase()}…`}
          className={cn(INPUT, "pl-7")}
        />
        {loading && (
          <Loader2 className="absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-muted-foreground/60 motion-reduce:animate-none" />
        )}
      </div>

      {/* Ce qui est retenu reste visible même quand la recherche a changé de résultats : sans ça,
          on coche une étiquette, on tape autre chose, et plus rien ne dit ce qui filtre. */}
      {selected.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {selected.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => onToggle(t)}
              title="Remove from the filter"
              className="flex items-center gap-1 rounded-full border border-brand/40 bg-brand/10 px-2 py-[3px] text-[11px] font-medium text-brand"
            >
              {t.name}
              <span aria-hidden className="text-brand/60">
                ×
              </span>
            </button>
          ))}
        </div>
      )}

      {error && (
        <p className="mt-1.5 flex items-start gap-1.5 text-[11px] text-[#c0334a]">
          <AlertTriangle className="mt-[2px] h-3 w-3 shrink-0" strokeWidth={2} />
          {error}
        </p>
      )}

      <div className="mt-1.5 max-h-[132px] overflow-y-auto rounded-lg border border-border">
        {terms.length === 0 && !loading && !error ? (
          <p className="px-2.5 py-2 text-[11.5px] text-muted-foreground/80">
            {query ? "Nothing matches that search on this site." : "This site exposes none."}
          </p>
        ) : (
          <ul>
            {terms.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => onToggle(t)}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-[12px] hover:bg-accent",
                    isPicked(t.id) && "font-semibold text-brand",
                  )}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    {isPicked(t.id) && <Check className="h-3 w-3 shrink-0" strokeWidth={2.5} />}
                    <span className="truncate">{t.name}</span>
                  </span>
                  <span className="shrink-0 tabular-nums text-[10.5px] text-muted-foreground/70">{t.count}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ⛔ Une liste coupée en silence se lit comme « cette étiquette n'existe pas sur ce site ». */}
      {truncated && (
        <p className="mt-1 text-[10.5px] text-muted-foreground/80">
          Showing the most used ones only — type to search the whole site.
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * La boîte de dialogue
 * ------------------------------------------------------------------ */

export function WpImportDialog({
  onClose,
  onInsert,
}: {
  onClose: () => void;
  /** Reçoit des lignes DÉJÀ validées par le schéma, côté serveur. */
  onInsert: (rows: Row[], summary: string) => void;
}) {
  const [sources, setSources] = useState<SourceOption[]>([]);
  const [sourceId, setSourceId] = useState("");
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  const [loadingSources, setLoadingSources] = useState(true);

  const [categories, setCategories] = useState<Term[]>([]);
  const [tags, setTags] = useState<Term[]>([]);
  const [count, setCount] = useState(5);

  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [loadingPosts, setLoadingPosts] = useState(false);
  const [postsError, setPostsError] = useState<string | null>(null);
  // L'audience GA4 des candidats affichés. Jamais affichée sans `candidates` : les deux viennent de
  // la même réponse, et les montrer séparément laisserait un classement survivre à son corpus.
  const [audience, setAudience] = useState<AudienceJson | null>(null);
  // ⚠️ Un tri de LECTURE, pas de sélection : c'est l'auteur qui choisit ensuite ce qu'il insère.
  const [tri, setTri] = useState<"date" | "views">("date");

  const [layout, setLayout] = useState<"stacked" | "side">("stacked");
  const [locale, setLocale] = useState<string | undefined>(undefined);
  /*
   * ⛔ LE CHAMP NE SE PRÉ-REMPLIT PLUS, ET C'EST UN CHAMP FACULTATIF ORDINAIRE. Ce qu'on écrirait
   * ici partirait dans le document, et un libellé présent dans un document signifie désormais
   * qu'un HUMAIN l'a tapé — c'est ce qui permet au rendu de distinguer une saisie d'une absence.
   * Pré-remplir revenait à signer une saisie à la place de l'auteur.
   *
   * Laissé vide, rien n'est écrit : ni ici, ni par la route d'import. Le rendu pose le défaut de
   * `meta.locale` au moment de la compilation. Le champ n'a donc plus aucun cas obligatoire — la
   * langue peut rester illisible sans conséquence sur ce qui part.
   */
  const [ctaLabel, setCtaLabel] = useState("");
  const [inserting, setInserting] = useState(false);
  const [insertError, setInsertError] = useState<string | null>(null);
  const [notes, setNotes] = useState<{ title: string; note: string }[]>([]);

  const gridRef = useRef<HTMLDivElement>(null);

  /* --------------------------------------------------------- Langue du document */

  /*
   * ⚠️ CETTE LECTURE NE SERT PLUS QU'À MONTRER, JAMAIS À ÉCRIRE. La langue du document ouvert
   * alimente le seul texte de remplacement du champ : « laissé vide, voilà ce que porteront les
   * cartes ». Montrer n'est pas écrire — rien de ce qui est affiché ici n'entre dans le document,
   * c'est le rendu qui pose le défaut. Un échec de lecture n'a donc plus de conséquence sur ce qui
   * part : il rend seulement le champ muet, et le muet ne ment pas.
   *
   * Pourquoi une requête plutôt que la valeur déjà à l'écran : le document vit dans `BuilderShell`
   * (`shell.tsx`), qui ne passe à cette boîte que `onClose`/`onInsert`. On relit donc `meta.locale`
   * par l'id de l'URL (`/builder/[id]`, route déjà scopée marque). C'est une lecture de plus au
   * moment de l'ouverture, et la question ne se pose qu'une fois : la langue est figée à la
   * création du template et n'est pas éditable dans le builder (`inspector.tsx`, le champ Locale
   * du panneau Document, en lecture seule), donc
   * cette valeur ne peut pas diverger de celle de l'éditeur.
   */
  const routeParams = useParams<{ id?: string | string[] }>();
  const templateId = typeof routeParams?.id === "string" ? routeParams.id : "";

  /**
   * `loading` → on ne sait pas encore, le champ le dit ; `failed` → on ne saura pas, et le champ
   * se tait. Trois états parce que « on cherche » et « on ne trouvera pas » ne se disent pas
   * pareil à l'auteur ; aucun des deux ne l'empêche d'insérer.
   */
  const [localeStatus, setLocaleStatus] = useState<"loading" | "ready" | "failed">("loading");

  // Le panneau est une modale : elle peut se fermer pendant l'aller-retour. Ce témoin remplace le
  // `cancelled` local d'un effet, qui ne couvrait pas les reprises depuis le bouton.
  const mounted = useRef(true);
  useEffect(() => {
    // Remis à vrai À CHAQUE montage : en mode strict (dev), React monte, démonte, remonte. Un
    // témoin posé une seule fois resterait faux après ce faux démontage, et la langue ne se
    // chargerait plus jamais en développement.
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadLocale = useCallback(async () => {
    const settle = (status: "ready" | "failed") => {
      if (!mounted.current) return;
      setLocaleStatus(status);
    };
    if (!templateId) {
      settle("failed");
      return;
    }
    if (mounted.current) setLocaleStatus("loading");
    try {
      const res = await fetch(`/api/builder/templates/${templateId}`);
      if (!res.ok) {
        settle("failed");
        return;
      }
      const body = (await res.json()) as { draft?: { doc?: { meta?: { locale?: unknown } } } | null };
      const loc = body.draft?.doc?.meta?.locale;
      if (typeof loc !== "string" || loc === "") {
        settle("failed");
        return;
      }
      if (!mounted.current) return;
      setLocale(loc);
      settle("ready");
    } catch {
      settle("failed");
    }
  }, [templateId]);

  useEffect(() => {
    void loadLocale();
  }, [loadLocale]);

  // Ce que le RENDU posera si le champ part vide — la même table que `withDefaultCta`, lue pour
  // l'afficher et pour rien d'autre. `undefined` tant que la langue est inconnue : montrer
  // « Read more » alors reviendrait à annoncer une langue qu'on n'a pas lue.
  const ctaFallback = locale === undefined ? undefined : defaultArticleCta(locale);

  /* --------------------------------------------------------- Sources */

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/builder/wp/sources");
        if (!res.ok) throw new Error(await errorOf(res));
        const body = (await res.json()) as { sources?: SourceOption[]; error?: string | null };
        if (cancelled) return;
        const rows = Array.isArray(body.sources) ? body.sources : [];
        setSources(rows);
        // Une seule source = aucune décision à prendre : on la choisit.
        if (rows.length > 0) setSourceId(rows[0].id);
        // ⚠️ La base a refusé la lecture : ce n'est PAS « aucune source configurée ».
        if (body.error) setSourcesError(body.error);
      } catch (e) {
        if (!cancelled) setSourcesError(e instanceof Error ? e.message : "could not load sources");
      } finally {
        if (!cancelled) setLoadingSources(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const source = sources.find((s) => s.id === sourceId) ?? null;

  // Changer de site invalide tout ce qui a été choisi : les ids de catégories d'un site ne
  // veulent rien dire sur un autre. Les garder filtrerait sur des identifiants au hasard.
  useEffect(() => {
    setCategories([]);
    setTags([]);
    setCandidates(null);
    setPicked(new Set());
    setPostsError(null);
    setNotes([]);
  }, [sourceId]);

  /* --------------------------------------------------------- Aperçu */

  const preview = useCallback(async () => {
    if (!sourceId) return;
    setLoadingPosts(true);
    setPostsError(null);
    setNotes([]);
    try {
      const params = new URLSearchParams({ sourceId, limit: String(count) });
      if (categories.length) params.set("categories", categories.map((t) => t.id).join(","));
      if (tags.length) params.set("tags", tags.map((t) => t.id).join(","));

      const res = await fetch(`/api/builder/wp/posts?${params.toString()}`);
      if (!res.ok) throw new Error(await errorOf(res));
      const body = (await res.json()) as {
        candidates?: Candidate[];
        fetchedAt?: string;
        audience?: AudienceJson;
      };
      const list = Array.isArray(body.candidates) ? body.candidates : [];
      setCandidates(list);
      setAudience(body.audience ?? null);
      // Tout est coché d'entrée : l'auteur a demandé N articles, il les a. Décocher est plus
      // rapide que cocher cinq cases pour obtenir ce qu'on venait justement de demander.
      setPicked(new Set(list.map((c) => c.id)));
      setFetchedAt(body.fetchedAt ?? new Date().toISOString());
      requestAnimationFrame(() => gridRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
    } catch (e) {
      setCandidates(null);
      setAudience(null);
      setPostsError(e instanceof Error ? e.message : "could not load articles");
    } finally {
      setLoadingPosts(false);
    }
  }, [sourceId, count, categories, tags]);

  /* --------------------------------------------------------- Insertion */

  async function insert() {
    if (!candidates || picked.size === 0) return;
    setInserting(true);
    setInsertError(null);
    try {
      const chosen = candidates.filter((c) => picked.has(c.id));
      const res = await fetch("/api/builder/wp/insert", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceId,
          layout,
          // Vide = vide. La route n'en fabrique plus de repli, donc elle n'a plus besoin de la
          // langue du document : c'est le rendu qui posera le défaut, à la compilation.
          ctaLabel,
          articles: chosen.map((c) => ({
            id: c.id,
            publishedAt: c.publishedAt,
            title: c.title,
            excerpt: c.excerpt,
            permalink: c.permalink,
            imageUrl: c.imageUrl,
            imageAlt: c.imageAlt,
          })),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; notes?: typeof notes };
        setNotes(Array.isArray(body.notes) ? body.notes : []);
        throw new Error(body.error ?? `the request failed (${res.status})`);
      }
      const body = (await res.json()) as {
        rows?: Row[];
        notes?: { title: string; note: string }[];
        imagesImported?: number;
        imagesDeduplicated?: number;
      };
      const rows = Array.isArray(body.rows) ? body.rows : [];
      if (rows.length === 0) throw new Error("nothing came back to insert");

      const bits = [`${rows.length} article${rows.length > 1 ? "s" : ""}`];
      if (body.imagesImported) bits.push(`${body.imagesImported} image${body.imagesImported > 1 ? "s" : ""} imported`);
      if (body.imagesDeduplicated) bits.push(`${body.imagesDeduplicated} already in the library`);

      const leftovers = Array.isArray(body.notes) ? body.notes : [];
      if (leftovers.length > 0) {
        // Des articles sont entrés sans leur image : on insère quand même et on GARDE la modale
        // ouverte pour dire lesquels. Fermer emporterait l'explication avec elle.
        setNotes(leftovers);
        onInsert(rows, `${bits.join(" · ")} — ${leftovers.length} needs a look`);
        setCandidates(null);
        setPicked(new Set());
        return;
      }

      onInsert(rows, bits.join(" · "));
      onClose();
    } catch (e) {
      setInsertError(e instanceof Error ? e.message : "the insert failed");
    } finally {
      setInserting(false);
    }
  }

  /* --------------------------------------------------------- Rendu */

  const toggle = (list: Term[], set: (v: Term[]) => void) => (t: Term) => {
    set(list.some((x) => x.id === t.id) ? list.filter((x) => x.id !== t.id) : [...list, t]);
    // Le filtre a changé : l'aperçu affiché ne correspond plus à ce qui est demandé.
    setCandidates(null);
    setAudience(null);
    setPicked(new Set());
  };

  /* ------------------------------------------------------- Audience */

  const vues = audience?.ok ? audience.vues : null;

  /**
   * L'ordre d'affichage.
   *
   * ⛔ ON NE TRIE QUE CE QUI EST DÉJÀ À L'ÉCRAN. La liste vient des catégories choisies ; classer par
   * vues la réordonne, ça n'élargit jamais le corpus. C'est ce qui empêche la page d'accueil et les
   * pages de section d'entrer — sur atlas-review, un classement du site rend 19 pages de catégorie
   * sur 20.
   *
   * ⚠️ « NON MESURÉ » N'EST PAS « ZÉRO VUE », et le tri le respecte : un article absent de la carte
   * (href relatif, que rien ne peut apparier) descend SOUS les articles mesurés à zéro, au lieu de
   * se confondre avec eux. La carte l'écrit aussi en toutes lettres.
   */
  const NON_MESURE = -1;
  const vuesDe = (c: Candidate) => vues?.[c.permalink] ?? NON_MESURE;
  const affiches =
    candidates && tri === "views" && vues
      ? [...candidates].sort((a, b) => vuesDe(b) - vuesDe(a))
      : candidates;

  /**
   * Parmi les articles sans mesure, ceux qui sont simplement TROP RÉCENTS.
   *
   * ⛔ MESURÉ EN PRODUCTION LE 01/09/2026 : sur copper-kettle, les articles rendus par défaut sont
   * appariés 0 fois sur 8 — et ceux publiés avant le 29/08, 8 fois sur 8. L'appariement marche ; ce
   * que WordPress sert en tête est plus récent que la borne haute de l'entrepôt (J−2). Confondre les
   * deux causes sous « not measured » ferait chercher une panne là où il faut juste demander des
   * articles plus anciens.
   */
  const fenetreAu = audience?.ok ? audience.fenetre.au : null;
  const horsFenetre = (c: Candidate) => fenetreAu !== null && publieApresLaFenetre(c.publishedAt, fenetreAu);
  const tropRecents = (candidates ?? []).filter((c) => vuesDe(c) === NON_MESURE && horsFenetre(c)).length;

  /**
   * Ce que ces candidats COUVRENT réellement, en temps de publication.
   *
   * ⛔ POURQUOI CETTE PHRASE EXISTE. Les vues portent sur sept jours, mais le classement ne peut
   * porter que sur les articles demandés. Or ces sites publient BEAUCOUP : mesuré le 01/09/2026,
   * northwind-sports sort 52,6 articles par jour et copper-kettle 41,9 — vingt candidats n'y couvrent même pas
   * une demi-journée. Trier ces vingt-là par vues est exact ; laisser croire qu'on classe la semaine
   * ne le serait pas. La couverture se lit sur les dates DES CANDIDATS REÇUS : c'est une mesure, pas
   * une estimation, et elle ne coûte aucun appel de plus.
   */
  const couverture = (() => {
    const dates = (candidates ?? [])
      .map((c) => (c.publishedAt ? Date.parse(c.publishedAt) : NaN))
      .filter((t) => Number.isFinite(t));
    if (dates.length < 2) return null;
    const heures = (Math.max(...dates) - Math.min(...dates)) / 3_600_000;
    if (heures < 48) return `${Math.max(1, Math.round(heures))}h of publishing`;
    return `${Math.round(heures / 24)} days of publishing`;
  })();

  const broken = source?.status === "error";

  return (
    <Modal
      title="Insert WordPress articles"
      onClose={onClose}
      width="max-w-[860px]"
      footer={
        <>
          <span className="mr-auto text-[11px] text-muted-foreground/80">
            {candidates
              ? `${picked.size} of ${candidates.length} selected`
              : "Pick a source and preview what would be inserted."}
          </span>
          <Btn variant="ghost" onClick={onClose}>
            Cancel
          </Btn>
          <Btn
            variant="primary"
            onClick={insert}
            disabled={!candidates || picked.size === 0 || inserting}
            title={
              !candidates
                ? "Preview the articles first"
                : picked.size === 0
                  ? "Select at least one article"
                  : undefined
            }
          >
            {inserting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> Inserting…
              </>
            ) : (
              `Insert ${picked.size || ""} ${picked.size === 1 ? "article" : "articles"}`.replace("  ", " ")
            )}
          </Btn>
        </>
      }
    >
      {loadingSources ? (
        <p className="flex items-center gap-2 py-6 text-[12.5px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> Loading sources…
        </p>
      ) : sourcesError ? (
        <p className="flex items-start gap-2 rounded-lg border border-[#f0c4cc] bg-[#fdeaec] px-3 py-2 text-[12px] text-[#c0334a]">
          <AlertTriangle className="mt-[2px] h-3.5 w-3.5 shrink-0" strokeWidth={2} />
          <span>
            WordPress sources could not be read — {sourcesError}. This is not the same as having none
            configured, so nothing is assumed here.
          </span>
        </p>
      ) : sources.length === 0 ? (
        <div className="py-4 text-[12.5px]">
          <p className="font-semibold">No WordPress source is connected for this brand yet.</p>
          <p className="mt-1 text-muted-foreground">
            Add one in{" "}
            <a href="/settings/wordpress" className="font-medium text-brand hover:underline">
              Settings → WordPress
            </a>
            . You will need the site address; the probe there tells you what it can serve before you
            rely on it.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {/* ----------------------------------------------- Source */}
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <div>
              <label htmlFor="wp-source" className="mb-1 block text-[11.5px] font-semibold">
                Source
              </label>
              <select
                id="wp-source"
                value={sourceId}
                onChange={(e) => setSourceId(e.target.value)}
                className={INPUT}
              >
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                    {s.editionLabel ? ` — ${s.editionLabel}` : ""}
                  </option>
                ))}
              </select>
              {source && (
                <p className="mt-1 flex items-center gap-1 text-[10.5px] text-muted-foreground/80">
                  <ExternalLink className="h-3 w-3" strokeWidth={2} />
                  {source.restRoot}
                </p>
              )}
            </div>

            <div>
              <label htmlFor="wp-count" className="mb-1 block text-[11.5px] font-semibold">
                How many
              </label>
              {/* Champ libre plutôt qu'une liste fermée : la liste imposait 3 au minimum, alors
                  qu'un seul article est un cas courant (une édition spéciale, un rattrapage). Les
                  raccourcis gardent le geste à un clic pour les trois quantités habituelles. */}
              <div className="flex items-center gap-1.5">
                <input
                  id="wp-count"
                  type="number"
                  min={MIN_COUNT}
                  max={MAX_COUNT}
                  value={count}
                  onChange={(e) => {
                    // On borne à la SAISIE : un 0 ou un 40 tapé ici partirait tel quel dans
                    // `per_page`, et WordPress répondrait 400 sans dire pourquoi.
                    const n = clampCount(Number(e.target.value));
                    setCount(n);
                    setCandidates(null);
                    setPicked(new Set());
                  }}
                  className={cn(INPUT, "w-[68px] tabular-nums")}
                />
                {QUICK_COUNTS.map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => {
                      setCount(n);
                      setCandidates(null);
                      setPicked(new Set());
                    }}
                    className={cn(
                      "rounded-lg border px-2 py-1.5 text-[11.5px] font-medium tabular-nums",
                      count === n ? "border-brand text-brand" : "border-border text-muted-foreground",
                    )}
                  >
                    {n}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-[10.5px] text-muted-foreground/80">
                {MIN_COUNT} to {MAX_COUNT} articles
              </p>
            </div>
          </div>

          {broken && (
            <p className="flex items-start gap-2 rounded-lg border border-[#f0c4cc] bg-[#fdeaec] px-3 py-2 text-[12px] text-[#c0334a]">
              <AlertTriangle className="mt-[2px] h-3.5 w-3.5 shrink-0" strokeWidth={2} />
              <span>
                The last probe of this site failed{source?.statusDetail ? ` — ${source.statusDetail}` : ""}. You
                can still try; it may have come back.
              </span>
            </p>
          )}

          {/* ----------------------------------------------- Filtres */}
          <div className="grid gap-3 sm:grid-cols-2">
            <TermPicker
              sourceId={sourceId}
              taxonomy="categories"
              label="Categories"
              hint="any of these"
              selected={categories}
              onToggle={toggle(categories, setCategories)}
            />
            <TermPicker
              sourceId={sourceId}
              taxonomy="tags"
              label="Tags"
              hint="any of these"
              selected={tags}
              onToggle={toggle(tags, setTags)}
            />
          </div>

          {/* La règle est invisible dans l'URL ; elle est écrite ici plutôt que devinée. */}
          <p className="-mt-1 text-[11px] leading-snug text-muted-foreground/80">
            An article matches if it is in <strong>any</strong> selected category <strong>and</strong> carries{" "}
            <strong>any</strong> selected tag. Leave a group empty to ignore it. WordPress returns the newest
            first; view counts come from analytics and reorder <em>these</em> articles only.
          </p>

          <div className="flex flex-wrap items-end gap-3">
            <Btn onClick={preview} disabled={!sourceId || loadingPosts}>
              {loadingPosts ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> Fetching…
                </>
              ) : (
                "Preview articles"
              )}
            </Btn>
            {fetchedAt && candidates && (
              <span className="text-[11px] text-muted-foreground/80">fetched {ago(fetchedAt)}</span>
            )}
          </div>

          {postsError && (
            <p className="flex items-start gap-2 rounded-lg border border-[#f0c4cc] bg-[#fdeaec] px-3 py-2 text-[12px] text-[#c0334a]">
              <AlertTriangle className="mt-[2px] h-3.5 w-3.5 shrink-0" strokeWidth={2} />
              <span>{postsError}</span>
            </p>
          )}

          {/* ----------------------------------------------- Grille */}
          {candidates && (
            <div ref={gridRef}>
              {candidates.length === 0 ? (
                <p className="rounded-lg border border-border px-3 py-3 text-[12.5px] text-muted-foreground">
                  No published article matches those filters. The site answered — it simply has nothing
                  for this combination.
                </p>
              ) : (
                <>
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">
                      What would be inserted
                    </h3>
                    <button
                      type="button"
                      onClick={() =>
                        setPicked(picked.size === candidates.length ? new Set() : new Set(candidates.map((c) => c.id)))
                      }
                      className="text-[11px] font-medium text-brand hover:underline"
                    >
                      {picked.size === candidates.length ? "Clear all" : "Select all"}
                    </button>
                  </div>

                  {/* ------------------------------------- Tri et témoin d'audience */}
                  <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <span className="text-[11px] text-muted-foreground">Sort by</span>
                    <div className="flex gap-1.5">
                      {(["date", "views"] as const).map((v) => (
                        <button
                          key={v}
                          type="button"
                          // ⛔ Le tri par vues est INDISPONIBLE, pas silencieusement retombé sur la
                          // date : proposer un bouton qui trie autrement que ce qu'il annonce est
                          // exactement le mensonge que cet écran refusait déjà.
                          disabled={v === "views" && !vues}
                          onClick={() => setTri(v)}
                          className={cn(
                            "rounded-md border px-2 py-0.5 text-[11px] transition-colors motion-reduce:transition-none",
                            tri === v ? "border-brand bg-brand/[0.08] font-medium" : "border-border bg-card",
                            v === "views" && !vues && "cursor-not-allowed opacity-45",
                          )}
                        >
                          {v === "date" ? "Newest" : "Most viewed"}
                        </button>
                      ))}
                    </div>

                    {/* ⛔ LE TÉMOIN CHIFFRÉ. Un classement dont 2 articles sur 12 sont appariés n'est
                        pas faux, il est PARTIEL — et sans ce compte, « peu de vues » et « pas de
                        correspondance » se ressemblent trait pour trait. */}
                    {audience?.ok && (
                      <span className="text-[11px] tabular-nums text-muted-foreground/80">
                        {audience.apparies}/{audience.candidats} matched · {audience.fenetre.du} →{" "}
                        <span
                          title={
                            audience.fenetre.au === audience.fenetre.auDemande
                              ? undefined
                              : `Analytics only reports complete days. ${audience.fenetre.auDemande} was requested; the most recent trustworthy day is ${audience.fenetre.au}.`
                          }
                        >
                          {audience.fenetre.au}
                          {audience.fenetre.au !== audience.fenetre.auDemande && "*"}
                        </span>
                        {audience.rejetesRelatifs > 0 &&
                          ` · ${audience.rejetesRelatifs} without a full URL`}
                      </span>
                    )}
                  </div>

                  {/* ⛔ CE QUE LE CLASSEMENT COUVRE, ET CE QU'IL NE COUVRE PAS. Sans cette phrase,
                      « most viewed » sur sept jours de vues se lit comme « les plus lus de la
                      semaine » — alors qu'on classe les seuls articles demandés, et que ces sites
                      publient jusqu'à 50 articles par jour. */}
                  {tri === "views" && vues && couverture && (
                    <p className="mb-2 text-[11px] leading-snug text-muted-foreground/80">
                      Ranking the <strong>{candidates.length}</strong> articles above — {couverture}. View
                      counts cover {audience?.ok ? `${audience.fenetre.du} → ${audience.fenetre.au}` : "the window"};
                      ask for more articles to rank a wider slice.
                    </p>
                  )}

                  {/* ⛔ LE CAS QUI SE PRODUIT VRAIMENT. Ces sites publient 42 à 53 articles par jour ;
                      les articles servis en tête sont donc presque toujours postérieurs au dernier
                      jour d'analytics (J−2). Sans ce bandeau, l'auteur voit « too recent » partout et
                      n'a aucun moyen de savoir que la réponse est « demande des articles plus
                      anciens » — mesuré en production : 0/8 appariés par défaut, 8/8 avant le 29/08. */}
                  {tri === "views" && vues && tropRecents > 0 && candidates && (
                    <p className="mb-2 flex items-start gap-2 rounded-lg border border-border bg-accent/40 px-3 py-2 text-[11.5px] text-muted-foreground">
                      <AlertTriangle className="mt-[2px] h-3.5 w-3.5 shrink-0" strokeWidth={2} />
                      <span>
                        {tropRecents === candidates.length
                          ? `All ${tropRecents} articles here were published after ${fenetreAu}, the last day analytics covers, so none can be ranked by views yet. Ask for more articles, or come back in two days.`
                          : `${tropRecents} of ${candidates.length} articles were published after ${fenetreAu}, the last day analytics covers. They sit at the bottom until their views are collected.`}
                      </span>
                    </p>
                  )}

                  {/* La raison NOMMÉE, jamais une colonne vide sans explication. */}
                  {audience && !audience.ok && (
                    <p className="mb-2 flex items-start gap-2 rounded-lg border border-border bg-accent/40 px-3 py-2 text-[11.5px] text-muted-foreground">
                      <AlertTriangle className="mt-[2px] h-3.5 w-3.5 shrink-0" strokeWidth={2} />
                      <span>{audience.message}</span>
                    </p>
                  )}

                  <div className="grid max-h-[320px] gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
                    {(affiches ?? candidates).map((c) => {
                      const on = picked.has(c.id);
                      const v = vuesDe(c);
                      return (
                        <button
                          key={c.id}
                          type="button"
                          aria-pressed={on}
                          onClick={() => {
                            const next = new Set(picked);
                            if (on) next.delete(c.id);
                            else next.add(c.id);
                            setPicked(next);
                          }}
                          className={cn(
                            "flex gap-2.5 rounded-[10px] border p-2 text-left transition-colors motion-reduce:transition-none",
                            on ? "border-brand bg-brand/[0.06]" : "border-border bg-card hover:border-brand/40",
                          )}
                        >
                          <div className="relative h-[54px] w-[72px] shrink-0 overflow-hidden rounded-md bg-accent">
                            {c.imageUrl ? (
                              // Vignette DISTANTE, et uniquement ici : c'est un écran d'admin, pas
                              // un email. Le réhébergement n'a lieu qu'à l'insertion.
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={c.imageUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
                            ) : (
                              <span className="flex h-full w-full items-center justify-center text-[9.5px] text-muted-foreground/70">
                                no image
                              </span>
                            )}
                            {on && (
                              <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-brand text-white">
                                <Check className="h-2.5 w-2.5" strokeWidth={3} />
                              </span>
                            )}
                          </div>
                          <div className="min-w-0">
                            <p className="line-clamp-2 text-[12px] font-semibold leading-snug">{c.title}</p>
                            <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                              {c.excerpt}
                            </p>
                            <p className="mt-1 truncate text-[10px] text-muted-foreground/70">
                              {[ago(c.publishedAt), c.categoryNames.slice(0, 2).join(", ")]
                                .filter(Boolean)
                                .join(" · ")}
                            </p>
                            {/* ⚠️ « 0 view » et « not measured » sont DEUX choses. Le premier est une
                                mesure — cet article n'a pas été lu sur la fenêtre ; le second dit
                                qu'aucune mesure n'a pu être rattachée à cette adresse. Les afficher
                                pareil ferait passer un défaut d'appariement pour un échec éditorial. */}
                            {vues && (
                              <p className="mt-0.5 truncate text-[10px] tabular-nums text-muted-foreground/70">
                                {v === NON_MESURE ? (
                                  horsFenetre(c) ? (
                                    // Troisième état, ni « lu par personne » ni « adresse
                                    // inapariable » : publié après le dernier jour couvert.
                                    <span
                                      title={`Published after ${fenetreAu}, the last day analytics covers. Its views exist — they have not been collected yet.`}
                                    >
                                      too recent to measure
                                    </span>
                                  ) : (
                                    <span title="No analytics row matches this address. It is not a zero — it was never measured.">
                                      not measured
                                    </span>
                                  )
                                ) : (
                                  `${v.toLocaleString("en-US")} ${v === 1 ? "view" : "views"}`
                                )}
                              </p>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>

                  {/* ------------------------------------- Mise en forme */}
                  <div className="mt-3 grid gap-3 border-t border-border pt-3 sm:grid-cols-2">
                    <div>
                      <span className="mb-1 block text-[11.5px] font-semibold">Layout</span>
                      <div className="flex gap-1.5">
                        {(["stacked", "side"] as const).map((v) => (
                          <button
                            key={v}
                            type="button"
                            onClick={() => setLayout(v)}
                            className={cn(
                              "rounded-lg border px-2.5 py-1.5 text-[11.5px] font-medium",
                              layout === v ? "border-brand text-brand" : "border-border text-muted-foreground",
                            )}
                          >
                            {v === "stacked" ? "Image on top" : "Image on the side"}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <label htmlFor="wp-cta" className="mb-1 block text-[11.5px] font-semibold">
                        Button label
                      </label>
                      {/* ⛔ MONTRER, JAMAIS PRÉ-REMPLIR : un texte de remplacement ne part pas dans
                          le document, une valeur si. Muet quand la langue est inconnue — annoncer
                          « Read more » affirmerait une langue qu'on n'a pas lue. */}
                      <input
                        id="wp-cta"
                        value={ctaLabel}
                        maxLength={28}
                        onChange={(e) => setCtaLabel(e.target.value)}
                        placeholder={
                          localeStatus === "ready" && ctaFallback !== undefined
                            ? ctaFallback
                            : localeStatus === "loading"
                              ? "Reading the template language…"
                              : "Optional"
                        }
                        className={INPUT}
                      />
                      {/* ⛔ Ce marque-page annonçait « Leave empty for no button » : l'option
                          n'existe plus, et elle n'a jamais été sans conséquence — le titre d'un
                          article n'est pas un lien dans l'email rendu. */}
                      <p className="mt-1 text-[10.5px] text-muted-foreground/80">
                        {localeStatus === "ready" && ctaFallback !== undefined
                          ? `Optional — left empty, articles get “${ctaFallback}”, the default for ${locale ?? ""}, when the email is built.`
                          : localeStatus === "loading"
                            ? "Reading the language of this template…"
                            : "Optional — left empty, articles get this template's default label when the email is built."}{" "}
                        The headline is not a link in the email — only the picture and this button are.
                      </p>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ----------------------------------------------- Suites */}
          {notes.length > 0 && (
            <div className="rounded-lg border border-[#f3dfc0] bg-[#fdf6ea] px-3 py-2 text-[12px]">
              <p className="font-semibold text-[#8a5a12]">Inserted, but these need a look:</p>
              <ul className="mt-1 space-y-0.5 text-[#8a5a12]">
                {notes.map((n, i) => (
                  <li key={i}>
                    <strong>{n.title}</strong> — {n.note}
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-[11px] text-[#8a5a12]/85">
                The article is in your document without its picture. Pick one from the media library on
                the block — the original URL is never used as a fallback: by the time the email is opened
                the site may have moved it, and loading it would leak every reader&rsquo;s IP to that site.
              </p>
            </div>
          )}

          {insertError && (
            <p className="flex items-start gap-2 rounded-lg border border-[#f0c4cc] bg-[#fdeaec] px-3 py-2 text-[12px] text-[#c0334a]">
              <AlertTriangle className="mt-[2px] h-3.5 w-3.5 shrink-0" strokeWidth={2} />
              <span>{insertError}</span>
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
