import { NextResponse } from "next/server";
import { Row, newId, type Row as RowType } from "@nf/render/schema";
import { authorEmail } from "@/lib/data/templates";
import { findWpSource } from "@/lib/data/wp-sources";
import { MAX_ARTICLES } from "@nf/wp/client";
import { importRemoteImage } from "@/lib/wp/media-import";
import { jsonError, readJson, requireContext } from "../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/builder/wp/insert — transforme les articles CHOISIS en lignes prêtes à insérer.
 *
 * C'est ici que les vignettes quittent le site d'origine pour la médiathèque de la marque, et
 * nulle part ailleurs : sonder 20 articles ne doit pas peupler le stock de 20 images dont 17 ne
 * partiront jamais.
 *
 * POURQUOI LE CLIENT RENVOIE LE CONTENU QU'IL A REÇU, PLUTÔT QUE DES IDS À RELIRE. Refaire la
 * requête WordPress ici semblerait plus rigoureux ; ce serait l'inverse. Entre l'aperçu et le clic,
 * le site peut avoir publié : la même requête ne rend plus les mêmes articles, et on insérerait
 * quelque chose que personne n'a vu. **Ce qui s'insère est exactement ce qui a été montré.** Le
 * serveur ne fait donc pas confiance au client pour la SÛRETÉ (longueurs, schémas d'URL et gardes
 * réseau sont revérifiés ici), seulement pour le CHOIX — qui lui appartient.
 *
 * ⚠️ UNE VIGNETTE QUI ÉCHOUE NE FAIT PAS ÉCHOUER L'INSERTION. L'article entre sans image et la
 * raison est remontée dans `notes`. Perdre cinq articles choisis parce que la troisième image est
 * cassée serait punir l'auteur pour l'état d'un site qu'il ne contrôle pas.
 *
 * ⛔ ET JAMAIS L'URL DISTANTE EN REPLI : voir `lib/wp/media-import.ts`.
 */

interface InsertArticle {
  /** Id WordPress — la clé du retour vers la source pour le rafraîchissement (lot WP-3). */
  id?: unknown;
  title?: unknown;
  excerpt?: unknown;
  permalink?: unknown;
  publishedAt?: unknown;
  imageUrl?: unknown;
  imageAlt?: unknown;
}

interface InsertBody {
  sourceId?: unknown;
  articles?: unknown;
  /** `stacked` (image au-dessus) ou `side` (image à gauche) — appliqué à toute la fournée. */
  layout?: unknown;
  /**
   * Libellé du bouton, TEL QUE TAPÉ par l'auteur dans le formulaire d'import — et rien d'autre.
   *
   * ⛔ VIDE ⇒ AUCUNE CLÉ `ctaLabel` DANS LE BLOC, surtout pas un repli fabriqué ici. Un libellé
   * présent dans un document signifie désormais qu'un HUMAIN l'a tapé : c'est ce qui permet au
   * rendu (`withDefaultCta`) de distinguer une saisie d'une absence, donc de poser le défaut de
   * `meta.locale` — et de s'en abstenir sur un lien mort. En fabriquant un repli ici, la route
   * rendait cette distinction impossible pour tout article importé. Le rendu s'en charge, et lui
   * seul ; la route n'a donc plus besoin de connaître la langue du document cible.
   */
  ctaLabel?: unknown;
}

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Seuls `http`/`https` absolus. Un `data:` ou un chemin relatif n'a rien à faire ici. */
function httpUrl(v: unknown): string | null {
  const raw = str(v, 2048);
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  const c = await requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  const body = await readJson<InsertBody>(req);
  if (!body) return jsonError("invalid JSON body", 400);

  const sourceId = typeof body.sourceId === "string" ? body.sourceId : "";
  if (!sourceId) return jsonError("`sourceId` is required", 400);

  // Portée marque. Elle sert ici à autre chose qu'à la lecture : l'import écrit dans la
  // médiathèque de `asset`, et rien ne doit pouvoir y verser depuis le contexte d'une autre marque.
  const source = await findWpSource(db, sourceId, asset.id);
  if (!source) return jsonError("source not found", 404);

  const raw = Array.isArray(body.articles) ? (body.articles as InsertArticle[]) : [];
  if (raw.length === 0) return jsonError("pick at least one article", 400);
  if (raw.length > MAX_ARTICLES) {
    return jsonError(`too many articles at once — the limit is ${MAX_ARTICLES}`, 400);
  }

  const layout = body.layout === "side" ? "side" : "stacked";
  // 28 caractères : au-delà, le libellé passe à la ligne sous Outlook (cf. `MAX_BUTTON_LABEL`).
  // `str()` rend "" aussi bien pour un champ absent que pour un champ vidé à la main : dans les
  // deux cas personne n'a rien tapé, et le bloc part donc SANS la clé (voir `InsertBody.ctaLabel`).
  const ctaLabel = str(body.ctaLabel, 28);

  const author = await authorEmail();

  // UN SEUL instant pour toute la fournée. Le recalculer par article ferait porter à cinq blocs
  // insérés d'un même clic cinq âges différents — un écart de quelques secondes, mais qui rend le
  // tri par fraîcheur instable et l'affichage incompréhensible.
  const fetchedAt = new Date().toISOString();

  const rows: RowType[] = [];
  const notes: { title: string; note: string }[] = [];
  let imagesImported = 0;
  let imagesDeduplicated = 0;

  for (const a of raw) {
    const title = str(a.title, 200);
    const href = httpUrl(a.permalink);
    // Sans lien, la carte n'est plus un article : c'est un pavé de texte qui ressemble à un
    // article. On refuse la ligne plutôt que d'insérer un leurre cliquable qui ne mène nulle part.
    if (!title || !href) {
      notes.push({ title: title || "(untitled)", note: "skipped — it has no title or no link" });
      continue;
    }

    // Date de publication chez la source : on la garde telle qu'elle est arrivée, sans la
    // recalculer. `toIsoUtc` a déjà écarté les dates inexploitables côté normalisation.
    const publishedAt = str(a.publishedAt, 40);

    let imageSrc: string | undefined;
    let imageAlt = str(a.imageAlt, 300);

    const remote = httpUrl(a.imageUrl);
    if (remote) {
      const res = await importRemoteImage(db, asset, remote, imageAlt, author);
      if (res.ok) {
        imageSrc = res.image.url;
        imageAlt = res.image.alt;
        if (res.image.deduplicated) imagesDeduplicated++;
        else imagesImported++;
      } else {
        notes.push({ title, note: `inserted without its image — ${res.reason}` });
      }
    }

    const block = {
      id: newId("blk"),
      type: "article" as const,
      title,
      excerpt: str(a.excerpt, 1000),
      ...(imageSrc ? { imageSrc } : {}),
      // La clé existe TOUJOURS, même vide : c'est le contrat du bloc article, et un alt vide est ce
      // qui déclenche l'avertissement de l'inspecteur puis le refus de publication. WordPress ne
      // remplit `alt_text` que rarement — on ne recopie surtout pas le titre à sa place, un lecteur
      // d'écran l'entendrait deux fois.
      imageAlt,
      href,
      // Clé ABSENTE quand rien n'a été tapé — et non `ctaLabel: ""`. Le schéma accepterait la
      // chaîne vide, mais elle écrirait dans le document la trace d'une saisie qui n'a pas eu lieu.
      ...(ctaLabel ? { ctaLabel } : {}),
      layout,
      // PROVENANCE. Elle voyage DANS le document, donc elle survit à la duplication, à la
      // publication et au gel d'une occurrence de série — c'est-à-dire précisément aux moments où
      // « ces articles datent de quand ? » devient la question qui compte.
      source: {
        kind: "wp" as const,
        sourceId: source.id,
        sourceLabel: source.label,
        postId: str(a.id, 40),
        fetchedAt,
        ...(publishedAt ? { publishedAt } : {}),
        ...(remote ? { remoteImageUrl: remote } : {}),
        // Jamais épinglé à la naissance : l'épingle est un geste de l'auteur (« celui-ci, je l'ai
        // retouché, ne le remplace pas »), pas un état par défaut.
        pinned: false,
      },
    };

    // Chaque article occupe une ligne PLEINE LARGEUR. Les verser dans la colonne active
    // reproduirait le colonnage courant : cinq articles dans une demi-colonne donneraient des
    // vignettes illisibles, sans que personne n'ait demandé ça.
    const row = {
      id: newId("row"),
      layout: "1" as const,
      columns: [{ id: newId("col"), blocks: [block] }],
    };

    // Validation par le MÊME schéma que le reste du builder. Une ligne fabriquée ici et refusée à
    // la sauvegarde se manifesterait bien plus tard, sur un document déjà composé.
    const parsed = Row.safeParse(row);
    if (!parsed.success) {
      notes.push({ title, note: "skipped — the article did not fit the block schema" });
      continue;
    }
    rows.push(parsed.data);
  }

  if (rows.length === 0) {
    return jsonError("none of the selected articles could be turned into blocks", 422, { notes });
  }

  return NextResponse.json({
    rows,
    notes,
    imagesImported,
    imagesDeduplicated,
    sourceLabel: source.label,
  });
}
