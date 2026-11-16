"use client";

/**
 * BANDEAU DE PROVENANCE — sous chaque bloc importé, dans l'éditeur uniquement.
 *
 * Il répond à trois questions que personne ne peut poser à un bloc autrement :
 *   « d'où vient ce contenu ? », « quel âge a-t-il ? », « est-il encore à jour ? »
 *
 * ⚠️ UN NOMBRE D'HEURES, PAS UNE FORMULE. « Récent », « à jour », « il y a un moment » sont des
 * mots que chacun interprète à sa façon ; « 62 h » se compare à une cadence hebdomadaire sans
 * discussion. C'est aussi ce que verra le journal du worker, avec la MÊME arithmétique
 * (`@nf/config/freshness`) — l'écran et le planificateur ne peuvent pas dire deux âges différents.
 *
 * ⛔ RAFRAÎCHIR MONTRE L'ÉCART AVANT D'APPLIQUER. Un rafraîchissement silencieux écraserait le
 * titre raccourci à la main ou l'extrait réécrit ; on ne le remarquerait qu'après l'envoi.
 *
 * ⛔ UN BLOC ÉPINGLÉ N'EST JAMAIS REMPLACÉ, ni ici ni par la reprise automatique d'une occurrence
 * de série. L'épingle est le seul moyen pour l'auteur de dire « celui-ci, je l'ai travaillé ».
 */
import { useState } from "react";
import { AlertTriangle, Check, Loader2, Pin, PinOff, RefreshCw } from "lucide-react";
import { freshnessOf } from "@nf/config/freshness";
import type { Block, BlockSource } from "@nf/render/schema";
import { Btn } from "@/components/ui";
import { cn } from "@/lib/utils";
import { Modal } from "./modal";
import type { BuilderAction } from "./reducer";

interface FreshArticle {
  title: string;
  excerpt: string;
  href: string;
  publishedAt: string | null;
  imageAlt: string;
  /** URL chez NOUS si l'image a changé et a pu être rapatriée ; `null` = on garde l'actuelle. */
  imageSrc: string | null;
  remoteImageUrl: string | null;
}

/**
 * L'ALT SUIT L'IMAGE, ET SEULEMENT L'IMAGE — la règle, sortie du composant pour être MESURABLE.
 *
 * Rendue dans `apply()`, elle n'était vérifiable qu'en pilotant l'écran. Elle rend le fragment de
 * patch à appliquer au bloc : l'objet VIDE veut dire « ne touche à rien », ce qui n'est PAS la
 * même chose que « écris du vide ».
 *
 * • L'IMAGE CHANGE → l'alt de la NOUVELLE image fait foi, MÊME VIDE. Vider un champ est ici la
 *   bonne réponse, et c'est assez contre-intuitif pour que quelqu'un veuille le « réparer » :
 *   ⛔ NE REMETTEZ PAS un `a.imageAlt || block.imageAlt`. Ce repli-là gardait l'ancienne
 *   description exactement à l'instant où l'illustration qu'elle décrivait était remplacée :
 *   l'alt restait non vide, donc aucun contrôle ne se levait, l'e-mail partait et le lecteur
 *   d'écran annonçait une image qui n'est plus là. Un alt qui survit à son image est PIRE que
 *   pas d'alt. Le vide, lui, est honnête : il dit qu'aucune source ne décrit plus cette image,
 *   et seul un humain qui la regarde peut en écrire une.
 *   ⚠️ Mesuré : sur un bloc SANS titre, ce vide fait bien revenir « alt text is required to
 *   publish ». Avec un titre qui nomme l'article, il ne bloque pas — la vignette est alors
 *   décorative et `alt=""` est ce que WCAG demande (`compile/index.ts`, `EmailDocPublishable`).
 *   Dans les deux cas l'e-mail cesse de décrire une image disparue, ce qui est le but.
 *
 * • L'IMAGE NE CHANGE PAS → on n'écrit RIEN, donc l'alt écrit à la main survit. C'est le cas
 *   NOMINAL : WordPress laisse l'`alt_text` vide la plupart du temps (mesuré au lot précédent :
 *   65 % des rafraîchissements d'une source, 55 % de l'autre). L'écraser par ce vide effacerait
 *   un texte humain qui décrit toujours la bonne image. Même doctrine que `lib/wp/media-import.ts`.
 *
 * @param a l'article tel que la route le rend
 */
export function imagePatchFor(a: Pick<FreshArticle, "imageSrc" | "imageAlt">): {
  imageSrc?: string;
  imageAlt?: string;
} {
  // `imageSrc` non nul est le SEUL signal que l'illustration est remplacée à cet instant : la
  // route ne rapatrie l'image que si son URL distante a bougé, et ne la rend que si le
  // rapatriement a réussi. Image inchangée ⇒ on n'écrit RIEN, donc l'alt écrit à la main survit.
  if (!a.imageSrc) return {};
  return { imageSrc: a.imageSrc, imageAlt: a.imageAlt };
}

const TONE: Record<string, string> = {
  fresh: "text-muted-foreground",
  aging: "text-[#8a5a12]",
  stale: "text-[#c0334a]",
};

/** Ce que le diff compare, dans l'ordre où l'auteur le lira. */
const CHAMPS: { key: "title" | "excerpt" | "link" | "image"; label: string }[] = [
  { key: "title", label: "Title" },
  { key: "excerpt", label: "Excerpt" },
  { key: "link", label: "Link" },
  { key: "image", label: "Image" },
];

export function SourceRibbon({
  block,
  source,
  dispatch,
}: {
  block: Extract<Block, { type: "article" }>;
  source: BlockSource;
  dispatch: React.Dispatch<BuilderAction>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ changed: string[]; article: FreshArticle; fetchedAt: string; imageNote: string | null } | null>(null);
  const [upToDate, setUpToDate] = useState(false);

  // ⚠️ Sans instant d'envoi connu (le bloc n'appartient pas encore à une occurrence), la mesure se
  // fait contre maintenant. Elle est donc OPTIMISTE, et c'est l'armement de l'occurrence qui
  // refera le calcul contre la vraie date de départ — voir `freshnessOf`.
  const verdict = freshnessOf(source.fetchedAt);

  function patchSource(patch: Partial<BlockSource>) {
    dispatch({
      type: "updateBlock",
      blockId: block.id,
      patch: { source: { ...source, ...patch } } as Partial<Block>,
    });
  }

  async function refresh() {
    setBusy(true);
    setError(null);
    setUpToDate(false);
    try {
      const res = await fetch("/api/builder/wp/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceId: source.sourceId,
          postId: source.postId,
          current: {
            title: block.title,
            excerpt: block.excerpt,
            href: block.href,
            imageSrc: block.imageSrc,
            imageAlt: block.imageAlt,
          },
          currentRemoteImage: source.remoteImageUrl,
        }),
      });

      const body = (await res.json()) as {
        error?: string;
        changed?: string[];
        article?: FreshArticle;
        fetchedAt?: string;
        imageNote?: string | null;
      };
      if (!res.ok) throw new Error(body.error ?? `the refresh failed (${res.status})`);
      if (!body.article) throw new Error("the site answered without an article");

      if ((body.changed ?? []).length === 0) {
        // Rien n'a bougé : on avance quand même l'horodatage. C'est une vérification RÉELLE, et
        // laisser l'âge d'origine ferait redemander la même chose demain pour la même réponse.
        patchSource({ fetchedAt: body.fetchedAt ?? new Date().toISOString() });
        setUpToDate(true);
        return;
      }

      setDiff({
        changed: body.changed ?? [],
        article: body.article,
        fetchedAt: body.fetchedAt ?? new Date().toISOString(),
        imageNote: body.imageNote ?? null,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "the refresh failed");
    } finally {
      setBusy(false);
    }
  }

  /** Applique l'écart accepté — un seul `updateBlock`, donc un seul Ctrl+Z. */
  function apply() {
    if (!diff) return;
    const a = diff.article;
    const patch: Partial<Block> = {
      title: a.title,
      excerpt: a.excerpt,
      href: a.href,
      // L'image ne bouge QUE si le serveur a réussi à rapatrier la nouvelle. `null` = on garde
      // celle du bloc ; l'écraser par du vide serait perdre l'illustration sans la remplacer.
      //
      // ⛔ L'alt suit l'image, et seulement l'image — la règle et son pourquoi sont dans
      // `imagePatchFor`, qui est aussi ce qu'un banc peut interroger.
      ...imagePatchFor(a),
      source: {
        ...source,
        fetchedAt: diff.fetchedAt,
        ...(a.publishedAt ? { publishedAt: a.publishedAt } : {}),
        ...(a.remoteImageUrl ? { remoteImageUrl: a.remoteImageUrl } : {}),
      },
    } as Partial<Block>;
    dispatch({ type: "updateBlock", blockId: block.id, patch });
    setDiff(null);
  }

  return (
    <>
      <div
        className={cn(
          "mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-dashed border-current/15 pt-1.5 text-[10.5px]",
          TONE[verdict.level],
        )}
      >
        <span className="font-medium">From {source.sourceLabel}</span>
        <span aria-hidden>·</span>
        <span className="tabular-nums" title={`Fetched ${source.fetchedAt}`}>
          {verdict.hours} h
        </span>

        {source.pinned && (
          <span className="flex items-center gap-1 rounded-full bg-current/10 px-1.5 py-[1px] font-medium">
            <Pin className="h-2.5 w-2.5" strokeWidth={2.5} /> pinned
          </span>
        )}

        <span className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => patchSource({ pinned: !source.pinned })}
            title={
              source.pinned
                ? "Unpin — refreshes may replace this article again"
                : "Pin — keep this article exactly as it is, even when the series refreshes"
            }
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-current/10"
          >
            {source.pinned ? <PinOff className="h-3 w-3" strokeWidth={2} /> : <Pin className="h-3 w-3" strokeWidth={2} />}
            {source.pinned ? "Unpin" : "Pin"}
          </button>
          <button
            type="button"
            onClick={refresh}
            disabled={busy}
            title="Check the source and show what changed before applying anything"
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-current/10 disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" strokeWidth={2} />
            ) : (
              <RefreshCw className="h-3 w-3" strokeWidth={2} />
            )}
            Refresh
          </button>
        </span>

        {upToDate && (
          <span className="flex w-full items-center gap-1 text-[10px] text-muted-foreground">
            <Check className="h-2.5 w-2.5" strokeWidth={3} /> checked just now — nothing changed at the source
          </span>
        )}
        {error && (
          <span className="flex w-full items-start gap-1 text-[10px] text-[#c0334a]">
            <AlertTriangle className="mt-[1px] h-2.5 w-2.5 shrink-0" strokeWidth={2.5} /> {error}
          </span>
        )}
        {verdict.level !== "fresh" && !error && (
          <span className="w-full text-[10px]">{verdict.message}</span>
        )}
      </div>

      {diff && (
        <Modal
          title="What changed at the source"
          onClose={() => setDiff(null)}
          width="max-w-[640px]"
          footer={
            <>
              <span className="mr-auto text-[11px] text-muted-foreground/80">
                {diff.changed.length} field{diff.changed.length > 1 ? "s" : ""} differ
              </span>
              <Btn variant="ghost" onClick={() => setDiff(null)}>
                Keep mine
              </Btn>
              <Btn variant="primary" onClick={apply}>
                Apply changes
              </Btn>
            </>
          }
        >
          <div className="flex flex-col gap-3 text-[12px]">
            {CHAMPS.filter((f) => diff.changed.includes(f.key)).map((f) => {
              const before =
                f.key === "title"
                  ? block.title
                  : f.key === "excerpt"
                    ? block.excerpt
                    : f.key === "link"
                      ? block.href
                      : (block.imageSrc ?? "(none)");
              const after =
                f.key === "title"
                  ? diff.article.title
                  : f.key === "excerpt"
                    ? diff.article.excerpt
                    : f.key === "link"
                      ? diff.article.href
                      : (diff.article.imageSrc ?? "(unchanged)");
              return (
                <div key={f.key}>
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">
                    {f.label}
                  </p>
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    <div className="rounded-lg border border-border bg-accent/40 px-2.5 py-2">
                      <p className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">Yours now</p>
                      <p className="break-words leading-snug">{before || "(empty)"}</p>
                    </div>
                    <div className="rounded-lg border border-brand/40 bg-brand/[0.06] px-2.5 py-2">
                      <p className="mb-1 text-[10px] font-semibold uppercase text-brand">At the source</p>
                      <p className="break-words leading-snug">{after || "(empty)"}</p>
                    </div>
                  </div>
                </div>
              );
            })}

            {/* ⚠️ Le panneau ne montre que les URL d'image : sans cette ligne, l'auteur ne verrait
                nulle part que sa description est sur le point de disparaître avec l'image. */}
            {diff.article.imageSrc && !diff.article.imageAlt && block.imageAlt.trim() !== "" && (
              <p className="flex items-start gap-1.5 rounded-lg border border-[#f3dfc0] bg-[#fdf6ea] px-2.5 py-2 text-[11.5px] text-[#8a5a12]">
                <AlertTriangle className="mt-[2px] h-3 w-3 shrink-0" strokeWidth={2} />
                The new illustration has no alt text at the source. Your current description belongs to the image
                being replaced, so applying clears it — write a new one for the new picture before sending.
              </p>
            )}

            {diff.imageNote && (
              <p className="flex items-start gap-1.5 rounded-lg border border-[#f3dfc0] bg-[#fdf6ea] px-2.5 py-2 text-[11.5px] text-[#8a5a12]">
                <AlertTriangle className="mt-[2px] h-3 w-3 shrink-0" strokeWidth={2} />
                The illustration changed at the source but could not be brought over — {diff.imageNote}. Your current
                image is kept.
              </p>
            )}

            <p className="text-[11px] leading-snug text-muted-foreground/80">
              Applying replaces the fields shown above and resets the age counter. Anything you edited by hand in those
              fields is overwritten — pin the block if you want it left alone from now on.
            </p>
          </div>
        </Modal>
      )}
    </>
  );
}
