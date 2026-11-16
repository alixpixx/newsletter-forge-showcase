import {
  MAX_MEDIA_BYTES,
  MEDIA_BUCKET,
  findMediaBySha,
  insertMedia,
  mediaPath,
  restoreMedia,
  sha256Hex,
  sniffImageMime,
} from "@/lib/data/media";
import { WpFetchError, safeFetchBytes } from "@nf/wp/guard";
import type { BuilderDb, ScopedAsset } from "@/app/api/builder/_shared";

/**
 * RÉHÉBERGEMENT DES VIGNETTES WORDPRESS — le lot WP-7 (déduplication média), remonté ici.
 *
 * ⛔ POURQUOI ON NE MET JAMAIS L'URL DISTANTE DANS LE BLOC. Il serait tentant d'écrire
 * `imageSrc = post._embedded['wp:featuredmedia'][0].source_url` et d'en rester là. Trois raisons de
 * ne pas le faire, et aucune n'est esthétique :
 *
 *  1. **L'email est lu longtemps après.** Le client de messagerie va chercher l'image AU MOMENT DE
 *     L'OUVERTURE, parfois des semaines plus tard. Entre-temps le site a pu la renommer, la
 *     recompresser ou la supprimer : le trou apparaît dans une boîte que nous ne contrôlons plus.
 *  2. **Fuite d'IP.** Charger depuis `northwind-sports.example` fait signer à chaque abonné une visite chez un
 *     tiers, avec son IP et son user-agent, sans qu'il l'ait accepté. Nos surfaces sont sans
 *     cookie ; on n'introduit pas un mouchard par la porte des images.
 *  3. **Le type n'est pas vérifié.** L'URL annoncée par WordPress n'est pas reniflée.
 *
 * Donc : on télécharge, on renifle, on stocke chez nous, et le bloc pointe sur NOTRE URL.
 *
 * ⚠️ ET SI ÇA ÉCHOUE ? L'article s'insère SANS image. Jamais avec l'URL distante en repli — un
 * repli « qui marche à l'écran » aurait exactement les trois défauts ci-dessus, en silence.
 * L'appelant reçoit la raison et l'affiche ; l'auteur choisit alors une image de la médiathèque.
 *
 * ⚠️ ON NE DÉDUPLIQUE PAS SUR L'URL, ON DÉDUPLIQUE SUR LES OCTETS. Le même visuel arrive souvent
 * sous deux URL (`?v=2`, tailles `-1024x768`), et deux URL différentes servent parfois les mêmes
 * octets. `unique (asset_id, sha256)` est la seule clé qui dit la vérité — et c'est déjà celle de
 * la médiathèque : une image importée et une image téléversée à la main restent interchangeables.
 */

/** Le plafond AFFICHÉ à l'utilisateur pour la médiathèque, pas celui du garde JSON (3 Mo) : une
 *  vignette rapatriée doit obéir à la même règle qu'une image téléversée, sinon deux limites
 *  cohabitent pour un même stock et la plus basse devient invisible. */
const MAX_IMAGE_BYTES = MAX_MEDIA_BYTES;

/** Budget de temps par image. Court exprès : 8 vignettes × 10 s dépasseraient le temps d'une
 *  fonction Vercel, et une modale qui « réfléchit » 80 secondes est vécue comme un plantage. */
const IMAGE_TIMEOUT_MS = 6_000;

export interface ImportedImage {
  /** URL PUBLIQUE CHEZ NOUS. C'est la seule qui a le droit d'entrer dans un bloc. */
  url: string;
  /** `alt_text` WordPress, ou vide — auquel cas la publication le réclamera (jamais de faux alt). */
  alt: string;
  mediaId: string;
  /** Vrai quand ces octets étaient déjà connus : rien n'a été re-téléversé ni re-facturé. */
  deduplicated: boolean;
}

export type ImageImport =
  | { ok: true; image: ImportedImage }
  /** `reason` est une phrase destinée à l'écran, pas un code : elle est montrée telle quelle. */
  | { ok: false; reason: string };

/** Message lisible pour chaque famille d'échec réseau. Un « fetch failed » nu n'apprend rien. */
function reasonFor(e: unknown): string {
  if (e instanceof WpFetchError) {
    switch (e.kind) {
      case "blocked":
        return "that image URL points to a private address and was refused";
      case "too_large":
        return `that image is larger than ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB`;
      case "timeout":
        return "the site took too long to serve that image";
      case "redirect":
        return "that image URL redirects too many times";
      case "http":
        return `the site answered ${e.status ?? "an error"} for that image`;
      default:
        return "that image could not be downloaded";
    }
  }
  return "that image could not be downloaded";
}

/**
 * Télécharge une image distante et la range dans la médiathèque de la marque.
 *
 * NE LANCE JAMAIS. Une insertion de 5 articles ne doit pas être perdue parce que la vignette du
 * troisième est cassée : chaque image rend son propre verdict, l'appelant les agrège.
 */
export async function importRemoteImage(
  db: BuilderDb,
  asset: ScopedAsset,
  sourceUrl: string,
  alt: string,
  author: string | null,
): Promise<ImageImport> {
  let bytes: Uint8Array;
  try {
    const res = await safeFetchBytes(sourceUrl, {
      timeoutMs: IMAGE_TIMEOUT_MS,
      maxBytes: MAX_IMAGE_BYTES,
    });
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, reason: `the site answered ${res.status} for that image` };
    }
    bytes = res.bytes;
  } catch (e) {
    return { ok: false, reason: reasonFor(e) };
  }

  if (bytes.byteLength === 0) return { ok: false, reason: "that image came back empty" };

  // Le type vient des OCTETS. Un SVG annoncé `image/png` deviendrait une XSS stockée servie depuis
  // notre domaine — c'est la même défense que le téléversement manuel, et pour la même raison.
  const mime = sniffImageMime(bytes);
  if (!mime) {
    return { ok: false, reason: "that image is not a PNG, JPEG or WebP (SVG and AVIF are refused)" };
  }

  const buffer = Buffer.from(bytes);
  const sha256 = await sha256Hex(bytes);

  // Ces octets sont peut-être déjà chez nous — même image republiée, ou deuxième newsletter qui
  // reprend le même article. On ne re-téléverse rien et on ne crée pas de doublon.
  const existing = await findMediaBySha(db, asset.id, sha256);
  if (existing) {
    if (existing.archivedAt) await restoreMedia(db, asset.id, existing.id);
    return {
      ok: true,
      image: {
        url: existing.url,
        // L'alt STOCKÉ fait foi : quelqu'un l'a peut-être écrit à la main, et WordPress renvoie
        // très souvent une chaîne vide. On ne remplace pas un alt humain par un vide automatique.
        alt: existing.alt || alt,
        mediaId: existing.id,
        deduplicated: true,
      },
    };
  }

  const path = mediaPath(asset.slug, mime);
  const { error: upErr } = await db.storage.from(MEDIA_BUCKET).upload(path, buffer, {
    contentType: mime,
    upsert: false,
  });
  if (upErr) return { ok: false, reason: `that image could not be stored: ${upErr.message}` };

  const { data: pub } = db.storage.from(MEDIA_BUCKET).getPublicUrl(path);
  const url = pub?.publicUrl;
  if (!url) {
    // Pas d'URL publique = fichier inutilisable. On le retire plutôt que de laisser un orphelin
    // que plus rien ne référence : PostgREST n'a pas de transaction, ce ménage est manuel.
    await db.storage.from(MEDIA_BUCKET).remove([path]);
    return { ok: false, reason: "that image was stored but no public URL could be built" };
  }

  const inserted = await insertMedia(db, {
    assetId: asset.id,
    path,
    url,
    mime,
    bytes: buffer.byteLength,
    sha256,
    alt: alt.slice(0, 300),
    // `import` — la troisième source prévue par le CHECK de la migration 0018, précisément pour
    // distinguer ce qui vient d'un site externe de ce qu'on a téléversé ou généré.
    source: "import",
    createdBy: author,
  });

  if (!inserted.ok) {
    await db.storage.from(MEDIA_BUCKET).remove([path]);
    if (inserted.duplicate) {
      // Deux articles de la même fournée partagent la même vignette et sont importés en parallèle :
      // l'un gagne l'insertion, l'autre relit la ligne gagnante. Aucun des deux n'échoue.
      const winner = await findMediaBySha(db, asset.id, sha256);
      if (winner) {
        return {
          ok: true,
          image: { url: winner.url, alt: winner.alt || alt, mediaId: winner.id, deduplicated: true },
        };
      }
    }
    return { ok: false, reason: `that image could not be recorded: ${inserted.message}` };
  }

  return {
    ok: true,
    image: { url: inserted.row.url, alt: inserted.row.alt, mediaId: inserted.row.id, deduplicated: false },
  };
}
