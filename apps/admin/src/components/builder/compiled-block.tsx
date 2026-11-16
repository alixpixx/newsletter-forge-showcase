"use client";

/**
 * Le HTML du compilateur, posé dans l'éditeur — et ce qu'il faut pour qu'il y ait l'air de ce que
 * reçoit l'abonné : sa feuille de style, ses polices, son vrai pied légal.
 *
 * ⛔ Rien ici ne DESSINE un bloc. Tout ce qui est dessiné vient de `POST /api/builder/canvas-render`,
 * c'est-à-dire de `compileDoc`. Ce fichier ne fait que transporter, isoler et mettre à jour.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { EmailDoc } from "@nf/render/schema";
import type { CanvasRender } from "@/lib/canvas-render";
import {
  SHADOW_RESET_CSS,
  chosenLegalTemplateId,
  dangerousAttr,
  dangerousTag,
  editorFontHref,
  fragmentKeys,
  fragmentMarkup,
  lightOnly,
  rawFrameDocument,
} from "./compiled-fragment";

/* ------------------------------------------------------------------ *
 * Rendu du document, bloc par bloc
 * ------------------------------------------------------------------ */

export interface CanvasRenderState {
  /** Dernier rendu RÉUSSI. Gardé pendant qu'un nouveau se calcule : l'écran ne clignote pas. */
  render: CanvasRender | null;
  /** Clés de fraîcheur du document qui a produit `render` (voir `fragmentKeys`). */
  renderedKeys: Map<string, string>;
  pending: boolean;
  error: string | null;
  issues: string[];
}

/** Assez court pour suivre la frappe, assez long pour ne pas compiler chaque lettre. */
const DEBOUNCE_MS = 220;

export function useCanvasRender(doc: EmailDoc): CanvasRenderState {
  const [state, setState] = useState<CanvasRenderState>({
    render: null,
    renderedKeys: new Map(),
    pending: true,
    error: null,
    issues: [],
  });

  useEffect(() => {
    const abort = new AbortController();
    setState((s) => (s.pending ? s : { ...s, pending: true }));
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch("/api/builder/canvas-render", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ doc }),
          signal: abort.signal,
        });
        const body = (await res.json().catch(() => null)) as (CanvasRender & { error?: string; issues?: string[] }) | null;
        if (abort.signal.aborted) return;
        if (!res.ok || !body || typeof body.blocks !== "object") {
          setState((s) => ({
            ...s,
            pending: false,
            error: body?.error ?? `Rendering failed (${res.status})`,
            issues: Array.isArray(body?.issues) ? body.issues : [],
          }));
          return;
        }
        setState({ render: body, renderedKeys: fragmentKeys(doc), pending: false, error: null, issues: [] });
      } catch (err) {
        if (abort.signal.aborted) return;
        setState((s) => ({ ...s, pending: false, error: err instanceof Error ? err.message : "Network error", issues: [] }));
      }
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      abort.abort();
    };
  }, [doc]);

  return state;
}

/**
 * Une feuille par passe de compilation, construite UNE fois et partagée par toutes les racines
 * d'ombre (`adoptedStyleSheets`) : deux cents blocs ne recopient pas deux cents fois la même CSS.
 * Repli sur le texte brut là où les feuilles construites n'existent pas.
 */
export type CompiledSheet = CSSStyleSheet | string;

export function useCompiledSheets(render: CanvasRender | null): CompiledSheet[] {
  return useMemo(() => {
    if (!render) return [];
    return render.sheets.map((css) => {
      const texte = `${SHADOW_RESET_CSS}\n${lightOnly(css)}`;
      if (typeof CSSStyleSheet === "undefined" || !("replaceSync" in CSSStyleSheet.prototype)) return texte;
      try {
        const s = new CSSStyleSheet();
        s.replaceSync(texte);
        return s;
      } catch {
        return texte;
      }
    });
  }, [render]);
}

/** Le fragment, analysé dans un `<template>` INERTE puis nettoyé — voir `dangerousAttr`. */
function inertFragment(markup: string): DocumentFragment {
  const tpl = document.createElement("template");
  tpl.innerHTML = markup;
  for (const el of Array.from(tpl.content.querySelectorAll("*"))) {
    if (dangerousTag(el.localName)) {
      el.remove();
      continue;
    }
    for (const a of Array.from(el.attributes)) if (dangerousAttr(a.name, a.value)) el.removeAttribute(a.name);
  }
  return tpl.content;
}

/**
 * Le HTML compilé d'un bloc, dans une racine d'ombre : la CSS de l'éditeur ne l'atteint pas, la
 * sienne ne déborde pas sur l'éditeur, et il n'hérite de rien (`all: initial`) — comme dans une boîte
 * de réception. Aucun clic n'y entre (`pointer-events: none`) : il tombe sur le bloc, donc sélectionne.
 */
export function ShadowHtml({ html, sheet, className }: { html: string; sheet: CompiledSheet | undefined; className?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    const contenu = inertFragment(fragmentMarkup(html));
    if (sheet === undefined || typeof sheet === "string") {
      // Une feuille adoptée lors d'un rendu précédent resterait appliquée par-dessus : on la retire.
      if ("adoptedStyleSheets" in root) root.adoptedStyleSheets = [];
      const style = document.createElement("style");
      style.textContent = sheet ?? SHADOW_RESET_CSS;
      root.replaceChildren(style, contenu);
    } else {
      root.adoptedStyleSheets = [sheet];
      root.replaceChildren(contenu);
    }
  }, [html, sheet]);

  // `inert` : ni focus au clavier (un Tab sur un lien de l'e-mail puis Entrée ferait quitter l'éditeur),
  // ni cible de pointeur — le clic retombe sur le bloc qui l'enveloppe.
  return <div ref={hostRef} className={className} inert />;
}

/**
 * Un bloc `html` BRUT, dans une `<iframe>` sans scripts. Hauteur mesurée sur son contenu, et suivie :
 * une image qui arrive tard agrandit le bloc comme elle agrandira l'e-mail.
 *
 * `allow-same-origin` sert UNIQUEMENT à mesurer cette hauteur depuis l'éditeur ; sans `allow-scripts`,
 * le document encadré ne peut rien exécuter, donc rien faire de cette origine.
 */
export function RawHtmlFrame({ html, css, fonts }: { html: string; css: string; fonts: readonly string[] }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const ro = useRef<ResizeObserver | null>(null);
  const [height, setHeight] = useState(24);
  const srcDoc = useMemo(() => rawFrameDocument(html, lightOnly(css), fonts), [html, css, fonts]);

  useEffect(() => () => ro.current?.disconnect(), []);

  // ⚠️ `onLoad` (posé par React à la création de l'élément) et non un écouteur ajouté dans un effet :
  // un `srcdoc` court peut finir de charger AVANT que l'effet ne s'exécute, et la hauteur resterait figée.
  function charge() {
    const frame = ref.current;
    const body = frame?.contentDocument?.body;
    if (!body) return;
    const mesurer = () => setHeight(Math.max(1, Math.ceil(body.getBoundingClientRect().height)));
    mesurer();
    ro.current?.disconnect();
    if (typeof ResizeObserver !== "undefined") {
      ro.current = new ResizeObserver(mesurer);
      ro.current.observe(body);
    }
  }

  return (
    <iframe
      ref={ref}
      title="Raw HTML block"
      sandbox="allow-same-origin"
      srcDoc={srcDoc}
      onLoad={charge}
      // ⛔ Aucun clic ni focus dedans : il sélectionne le bloc, et un lien ne peut pas faire quitter l'éditeur.
      inert
      tabIndex={-1}
      className="pointer-events-none block w-full border-0"
      style={{ height }}
    />
  );
}

/* ------------------------------------------------------------------ *
 * Polices de la marque
 * ------------------------------------------------------------------ */

/**
 * Charge `theme.webFonts` dans le document de l'éditeur, là où les racines d'ombre les trouvent
 * (Chrome ignore une `@font-face` déclarée dans une racine d'ombre). Renvoie les adresses REFUSÉES —
 * hors liste `EDITOR_FONT_HOSTS` — pour que le canvas dise qu'il ne les montre pas.
 */
export function useWebFonts(webFonts: readonly { family: string; href: string }[] | undefined): {
  loaded: string[];
  refused: string[];
} {
  const cle = JSON.stringify(webFonts ?? []);
  const tri = useMemo(() => {
    const loaded: string[] = [];
    const refused: string[] = [];
    for (const f of (JSON.parse(cle) as { href: string }[])) {
      const ok = editorFontHref(f.href);
      if (ok) loaded.push(ok);
      else refused.push(f.href);
    }
    return { loaded, refused };
  }, [cle]);

  useEffect(() => {
    const liens = tri.loaded.map((href) => {
      const existant = document.head.querySelector<HTMLLinkElement>(`link[data-nf-webfont][href="${CSS.escape(href)}"]`);
      if (existant) {
        existant.dataset.nfWebfontRefs = String(Number(existant.dataset.nfWebfontRefs ?? "0") + 1);
        return existant;
      }
      const l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = href;
      l.dataset.nfWebfont = "";
      l.dataset.nfWebfontRefs = "1";
      document.head.appendChild(l);
      return l;
    });
    return () => {
      // Compté : l'aperçu et le canvas peuvent demander la même police en même temps.
      for (const l of liens) {
        const n = Number(l.dataset.nfWebfontRefs ?? "1") - 1;
        if (n <= 0) l.remove();
        else l.dataset.nfWebfontRefs = String(n);
      }
    };
  }, [tri]);

  return tri;
}

/* ------------------------------------------------------------------ *
 * Le vrai pied légal
 * ------------------------------------------------------------------ */

export interface LegalFooterEdition {
  id: string;
  market: string;
  language: string;
  isPrimary: boolean;
}

export interface LegalFooterState {
  html: string | null;
  text: string | null;
  missing: string[];
  editions: LegalFooterEdition[];
  editionId: string | null;
  error: string | null;
  loading: boolean;
}

export const editionLabel = (e: LegalFooterEdition): string =>
  [e.market, e.language].filter((s) => s.trim() !== "").join(" · ") || "Edition";

/**
 * Le pied légal que le worker construira pour ce document : config choisie par le bloc, sinon celle
 * de l'édition ; édition demandée, sinon celle de la langue du document, sinon la primaire.
 * Liens personnels à `#` (voir `GET /api/builder/legal-footer-preview`).
 */
export function useLegalFooter(doc: EmailDoc, editionId: string | null, enabled: boolean): LegalFooterState {
  const templateId = chosenLegalTemplateId(doc);
  const locale = doc.meta.locale;
  const [state, setState] = useState<LegalFooterState>({
    html: null,
    text: null,
    missing: [],
    editions: [],
    editionId: null,
    error: null,
    loading: enabled,
  });

  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController();
    const q = new URLSearchParams({ locale });
    if (templateId) q.set("template", templateId);
    if (editionId) q.set("edition", editionId);
    setState((s) => ({ ...s, loading: true }));
    void (async () => {
      try {
        const res = await fetch(`/api/builder/legal-footer-preview?${q.toString()}`, { signal: abort.signal });
        const body = (await res.json().catch(() => null)) as
          | { html?: string; text?: string; missing?: string[]; editions?: LegalFooterEdition[]; editionId?: string; error?: string }
          | null;
        if (abort.signal.aborted) return;
        if (!res.ok || !body || typeof body.html !== "string") {
          setState({
            html: null,
            text: null,
            missing: [],
            editions: [],
            editionId: null,
            error: body?.error ?? `Could not load the legal footer (${res.status})`,
            loading: false,
          });
          return;
        }
        setState({
          html: body.html,
          text: typeof body.text === "string" ? body.text : "",
          missing: Array.isArray(body.missing) ? body.missing : [],
          editions: Array.isArray(body.editions) ? body.editions : [],
          editionId: body.editionId ?? null,
          error: null,
          loading: false,
        });
      } catch (err) {
        if (abort.signal.aborted) return;
        setState((s) => ({ ...s, error: err instanceof Error ? err.message : "Network error", loading: false }));
      }
    })();
    return () => abort.abort();
  }, [enabled, locale, templateId, editionId]);

  return state;
}
