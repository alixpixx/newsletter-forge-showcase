"use client";

/**
 * APERÇU RÉEL — le HTML vient de `POST /api/builder/preview`, donc du MJML compilé, pas du canvas.
 * C'est la seule vue qui dit la vérité sur ce que recevra un abonné.
 *
 * Trois honnêtetés à tenir ici :
 *  1. Les largeurs sont VRAIES, bordure comprise. Mobile : la fenêtre de l'iframe fait réellement
 *     375px, donc les `@media (max-width:600px)` du compilateur s'appliquent pour de bon. Desktop :
 *     elle est PLUS LARGE que l'e-mail — une iframe de 600px (598 utiles une fois la bordure ôtée)
 *     déclenchait ces mêmes règles mobiles dans la vue « 600 », qui montrait donc le rendu téléphone.
 *  2. Le mode sombre force les règles `prefers-color-scheme: dark` que le compilateur a émises.
 *     Il ne simule PAS l'inversion propriétaire de Gmail/Outlook, qui est impossible à reproduire
 *     hors du client — c'est écrit sous l'aperçu, pas sous-entendu.
 *  3. DEUX MODES, jamais confondus.
 *     • « As written » (défaut) : le shell BRUT, tel qu'il sera figé à la publication. Les tokens
 *       `{{first_name}}` restent visibles et les marqueurs `nf:if` sont des commentaires HTML —
 *       l'aperçu montre donc TOUT, y compris des morceaux qu'aucun destinataire ne verra ensemble.
 *     • « As a recipient » : le shell passe par `hydrate()` / `hydrateText()`, EXACTEMENT les
 *       fonctions du worker, avec un jeu de variables SIMULÉ saisi à l'écran. C'est le seul moyen
 *       de voir ce que reçoit vraiment un profil donné quand des blocs portent un `visibleIf`.
 *
 *     ⛔ Aucun abonné réel n'est lu, ici ni ailleurs dans ce composant : les valeurs sont tapées
 *     par l'utilisateur ou tirées du document lui-même, et c'est écrit sous l'aperçu.
 *
 * LE PIED LÉGAL EST LE VRAI, dans les deux modes : celui que le worker construira pour l'édition
 * choisie (`GET /api/builder/legal-footer-preview`), avec la config choisie par le bloc. Seuls les
 * liens PERSONNELS (désinscription, préférences) sont remplacés par `#` : ils sont signés par
 * destinataire, et un faux lien aurait l'air vrai. L'ancien « [Simulated] » faisait relire un pied
 * qui n'était pas celui qui part — sans adresse, sans mentions, sans rien de ce que l'auteur doit
 * vérifier.
 *
 * En-tête et pied de MARQUE : déjà dans le HTML, la route d'aperçu compile avec eux.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Loader2, Monitor, Moon, RefreshCw, Smartphone, Sparkles, Sun, UserRound } from "lucide-react";
import { GMAIL_CLIP_BYTES, MERGE_VARS, type EmailDoc, type VisibleIf } from "@nf/render/schema";
// Le worker n'utilise rien d'autre : importer les MÊMES fonctions est la seule façon d'être sûr que
// l'aperçu simulé et l'envoi réel masquent exactement les mêmes blocs.
import { hydrate, hydrateText, usesAiTokens, type MergeVars } from "@nf/render/hydrate";
import { Btn } from "@/components/ui";
import { cn } from "@/lib/utils";
import { Modal } from "./modal";
import { editionLabel, useLegalFooter, type LegalFooterState } from "./compiled-block";
import { LEGAL_FOOTER_TOKEN, hasLegalFooter, withLegalFooter } from "./compiled-fragment";

export interface PreviewResult {
  html: string;
  text: string;
  warnings: string[];
  sizeBytes: number;
}

/**
 * Active les règles dark du shell en neutralisant la media query. Le compilateur n'émet ce bloc
 * que si le thème définit des couleurs dark — sans elles, la bascule ne change rien, et on le dit.
 */
function forceDark(html: string): { html: string; hasDarkRules: boolean } {
  const re = /@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)/gi;
  const hasDarkRules = re.test(html);
  re.lastIndex = 0;
  return { html: html.replace(re, "@media all"), hasDarkRules };
}

const fmtBytes = (n: number): string => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

/* ------------------------------------------------------------------ *
 * Destinataire SIMULÉ
 * ------------------------------------------------------------------ */

/** Prénom de démonstration. Aucun abonné n'est lu : c'est une chaîne en dur, modifiable à l'écran. */
const SIMULATED_FIRST_NAME = "Alex";

/**
 * Ce qui tient la place du pied légal quand le vrai n'a pas pu être lu. Il le DIT, en clair : un
 * pied inventé serait relu comme conforme.
 */
function footerStandIn(legal: LegalFooterState): { html: string; text: string } {
  if (legal.html !== null) return { html: legal.html, text: legal.text ?? "" };
  const text = legal.loading
    ? "[Loading this brand's legal footer…]"
    : `[Legal footer — added at send time. Could not load it here: ${legal.error ?? "unknown error"}]`;
  const html =
    '<div style="font:12px/1.5 Arial,Helvetica,sans-serif;color:#8a6412;background:#fdf7ec;border:1px dashed #c9a227;padding:12px 16px;text-align:center;">' +
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") +
    "</div>";
  return { html, text };
}

/**
 * ÉCHANTILLONS des textes IA, marqués comme tels. Le vrai `{{ai_intro}}` est écrit par l'IA à chaque
 * envoi ; son repli est VIDE, si bien qu'un aperçu « destinataire » sans échantillon montrait un
 * e-mail où le paragraphe d'ouverture avait disparu — et l'auteur ne voyait ni sa place ni son poids.
 */
const AI_SAMPLE_INTRO =
  "[AI sample] This opening paragraph is written by the AI for each send, from the day's articles. Its length and tone vary; this sample only shows where it goes.";
const AI_SAMPLE_PREHEADER = "[AI sample] One line written by the AI for each send.";

/** Un champ de condition réellement utilisé par le document, et les valeurs qu'il y compare. */
interface ConditionField {
  token: string;
  label: string;
  kind: string;
  /** Valeurs comparées par un `equals` quelque part dans le document (vide = simple test de véracité). */
  values: string[];
}

/**
 * Champs de condition PRÉSENTS DANS CE DOCUMENT. On n'offre pas les 16 merge tags du registre :
 * régler un champ qui ne conditionne rien ne changerait rien à l'écran et ferait douter de l'outil.
 */
function collectConditions(doc: EmailDoc): ConditionField[] {
  const values = new Map<string, Set<string>>();

  const add = (cond: VisibleIf | undefined) => {
    if (!cond) return;
    const set = values.get(cond.token) ?? new Set<string>();
    if (cond.equals !== undefined) set.add(cond.equals);
    values.set(cond.token, set);
  };

  for (const row of doc.rows) {
    add(row.visibleIf);
    for (const column of row.columns) {
      add(column.visibleIf);
      // `footer_legal` ne porte pas de `visibleIf` (le schéma le lui interdit).
      for (const block of column.blocks) if (block.type !== "footer_legal") add(block.visibleIf);
    }
  }

  return [...values.entries()].map(([token, set]) => {
    const spec = (MERGE_VARS as Record<string, { kind: string; label: string } | undefined>)[token];
    return {
      token,
      label: spec?.label ?? token,
      kind: spec?.kind ?? "text",
      values: [...set],
    };
  });
}

/**
 * Variables du destinataire simulé.
 *
 * `has_first_name` est DÉRIVÉ du prénom : chez le worker, ce sont les deux faces de la même donnée.
 * Les laisser se désynchroniser à l'écran montrerait un profil qui ne peut pas exister.
 */
function buildVars(
  doc: EmailDoc,
  firstName: string,
  fields: Record<string, string>,
  footer: { html: string; text: string },
): MergeVars {
  const vars: MergeVars = {
    /**
     * ⛔ DÉFAUTS EXHAUSTIFS, POSÉS AVANT `...fields` POUR RESTER ÉCRASABLES. Sans eux, les trois
     * drapeaux de régime seraient faux tant que l'opérateur n'a rien choisi, et l'aperçu montrerait
     * un e-mail SANS AUCUNE mention légale — alors qu'à l'envoi exactement un des trois est
     * toujours vrai. Un aperçu qui ment dans ce sens-là est pire que pas d'aperçu.
     * Le simulateur de destinataire (`collectConditions`) écrase ensuite ce défaut.
     */
    is_gdpr: "1",
    is_lgpd: "",
    is_can_spam: "",
    ...fields,
    first_name: firstName,
    has_first_name: firstName.trim() === "" ? "" : "1",
    // Adresse non délivrable (RFC 2606) : cet aperçu n'envoie rien, et ne doit jamais donner
    // l'exemple d'une vraie adresse dans un jeu de test.
    email: "preview@example.com",
    asset_name: doc.meta.assetSlug,
    edition_title: doc.meta.subject,
    /**
     * ⚠️ VALEURS D'EXEMPLE, comme l'adresse ci-dessus. Le vrai numéro vient de l'occurrence
     * (`campaign_occurrence.seq`) et la vraie date de son jour d'envoi : un modèle en cours
     * d'écriture n'a ni l'un ni l'autre. Les laisser vides ferait croire à l'auteur que ces
     * variables ne fonctionnent pas — c'était précisément le défaut d'avant, où elles ne
     * s'imprimaient nulle part. Le bandeau de l'aperçu dit déjà que ce sont des exemples.
     */
    edition_number: "12",
    edition_date: new Intl.DateTimeFormat(doc.meta.locale, { dateStyle: "long", timeZone: "UTC" }).format(
      new Date(),
    ),
    locale: doc.meta.locale,
    ai_intro: AI_SAMPLE_INTRO,
    ai_preheader: AI_SAMPLE_PREHEADER,
    // Le VRAI pied de l'édition choisie, liens personnels à `#` (voir l'en-tête du fichier).
    legal_footer_html: footer.html,
    legal_footer_text: footer.text,
  };
  return vars;
}

/**
 * Fenêtre « desktop » : plus large que l'e-mail, pour qu'aucune règle `max-width:600px` ne s'y
 * déclenche. +2 : la bordure de l'iframe se prend sur sa largeur (`box-sizing: border-box`).
 */
const IFRAME_BORDER = 2;
const desktopViewport = (contentWidth: number): number => Math.max(680, contentWidth + 40);

const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

export function PreviewDialog({ doc, onClose }: { doc: EmailDoc; onClose: () => void }) {
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [view, setView] = useState<"html" | "text">("html");
  const [width, setWidth] = useState<"desktop" | "mobile">("desktop");
  const [dark, setDark] = useState(false);
  // Édition dont on montre le pied légal — `null` = celle de la langue du document, sinon la primaire.
  const [editionId, setEditionId] = useState<string | null>(null);
  const legal = useLegalFooter(doc, editionId, hasLegalFooter(doc));

  // Simulation de destinataire — inactive par défaut : la vérité de référence reste le shell brut.
  const [simulate, setSimulate] = useState(false);
  const [firstName, setFirstName] = useState(SIMULATED_FIRST_NAME);
  const [fields, setFields] = useState<Record<string, string>>({});

  const conditions = useMemo(() => collectConditions(doc), [doc]);

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/builder/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doc }),
      });
      const body = (await res.json().catch(() => null)) as (PreviewResult & { error?: string }) | null;
      if (!res.ok || !body || typeof body.html !== "string") {
        setError(body?.error ?? `Preview failed (${res.status})`);
        setResult(null);
      } else {
        setResult({
          html: body.html,
          text: typeof body.text === "string" ? body.text : "",
          warnings: Array.isArray(body.warnings) ? body.warnings : [],
          sizeBytes: Number(body.sizeBytes ?? 0),
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setResult(null);
    } finally {
      setBusy(false);
    }
  }, [doc]);

  // Compilation à l'ouverture uniquement : on ne recompile pas à chaque frappe (MJML n'est pas gratuit).
  useEffect(() => {
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const over = result !== null && result.sizeBytes > GMAIL_CLIP_BYTES;
  // Le compilateur encadre le contenu conditionnel de marqueurs `nf:if` : leur présence suffit à
  // savoir que l'aperçu brut montre plus que ce qu'un destinataire donné recevra.
  const conditional = result !== null && result.html.includes("<!--nf:if");

  const footer = footerStandIn(legal);
  const vars = simulate ? buildVars(doc, firstName, fields, footer) : null;
  // « As written » garde les jetons de fusion visibles, mais PAS celui du pied légal : c'est un bloc
  // système, et son contenu est justement ce que l'auteur doit relire.
  const html =
    result === null ? "" : vars === null ? withLegalFooter(result.html, footer.html) : hydrate(result.html, vars);
  const text =
    result === null
      ? ""
      : vars === null
        ? result.text.split("{{legal_footer_text}}").join(footer.text)
        : hydrateText(result.text, vars);
  const aiUsed = result !== null && usesAiTokens(result.html, result.text, doc.meta.preheader);
  const footerUsed = result !== null && result.html.includes(LEGAL_FOOTER_TOKEN);
  const viewport = width === "desktop" ? desktopViewport(doc.theme.contentWidth) : 375;
  const dk = result ? forceDark(html) : null;
  // Taille APRÈS hydratation : c'est elle qui décide de la coupure Gmail chez le destinataire, et
  // elle diffère du shell dès qu'un bloc conditionnel disparaît ou qu'un token se remplit.
  const hydratedBytes = simulate && result !== null ? utf8Bytes(html) : null;

  return (
    <Modal title="Preview" onClose={onClose} width="max-w-[1000px]">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border border-border p-0.5" role="group" aria-label="Preview view">
          {(["html", "text"] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className={cn(
                "rounded-[6px] px-2.5 py-1 text-[12px] font-medium transition-colors",
                view === v ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {v === "html" ? "Rendered" : "Plain text"}
            </button>
          ))}
        </div>

        <div className="inline-flex rounded-lg border border-border p-0.5" role="group" aria-label="Preview width">
          <button
            type="button"
            aria-pressed={width === "desktop"}
            aria-label={`Desktop, a ${desktopViewport(doc.theme.contentWidth)} pixel wide window`}
            title={`The email (${doc.theme.contentWidth}px) in a ${desktopViewport(doc.theme.contentWidth)}px window`}
            onClick={() => setWidth("desktop")}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-[6px] px-2.5 py-1 text-[12px] font-medium transition-colors",
              width === "desktop" ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Monitor className="h-3.5 w-3.5" strokeWidth={2} /> Desktop
          </button>
          <button
            type="button"
            aria-pressed={width === "mobile"}
            aria-label="Mobile width, 375 pixels"
            onClick={() => setWidth("mobile")}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-[6px] px-2.5 py-1 text-[12px] font-medium transition-colors",
              width === "mobile" ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Smartphone className="h-3.5 w-3.5" strokeWidth={2} /> 375
          </button>
        </div>

        {footerUsed && legal.editions.length > 1 && (
          <label className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
            Legal footer of
            <select
              value={legal.editionId ?? ""}
              onChange={(e) => setEditionId(e.target.value || null)}
              className="rounded-[8px] border border-border bg-card px-2 py-1 text-[12px] text-foreground focus:border-brand focus:outline-none"
            >
              {legal.editions.map((e) => (
                <option key={e.id} value={e.id}>
                  {editionLabel(e)}
                  {e.isPrimary ? " (primary)" : ""}
                </option>
              ))}
            </select>
          </label>
        )}

        <button
          type="button"
          aria-pressed={dark}
          onClick={() => setDark((v) => !v)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[12px] font-medium transition-colors",
            dark ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {dark ? <Moon className="h-3.5 w-3.5" strokeWidth={2} /> : <Sun className="h-3.5 w-3.5" strokeWidth={2} />}
          Dark
        </button>

        <div className="inline-flex rounded-lg border border-border p-0.5" role="group" aria-label="Preview audience">
          {([false, true] as const).map((v) => (
            <button
              key={String(v)}
              type="button"
              aria-pressed={simulate === v}
              onClick={() => setSimulate(v)}
              title={
                v
                  ? "Resolve merge tags and conditional blocks against a made-up recipient"
                  : "Show the template exactly as it will be stored at publish time"
              }
              className={cn(
                "inline-flex items-center gap-1.5 rounded-[6px] px-2.5 py-1 text-[12px] font-medium transition-colors",
                simulate === v ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {v && <UserRound className="h-3.5 w-3.5" strokeWidth={2} />}
              {v ? "As a recipient" : "As written"}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {result && hydratedBytes !== null && (
            <span
              className="rounded-full bg-accent px-2.5 py-[3px] text-[11.5px] font-semibold tabular-nums text-muted-foreground"
              title="Size once merge tags and conditions are resolved for this simulated recipient"
            >
              {fmtBytes(hydratedBytes)} sent
            </span>
          )}
          {result && (
            <span
              className={cn(
                "rounded-full px-2.5 py-[3px] text-[11.5px] font-semibold tabular-nums",
                over ? "bg-[#fdf0dd] text-[#b9790a]" : "bg-accent text-muted-foreground",
              )}
              title={over ? "Over the Gmail clipping threshold" : "Compiled HTML size"}
            >
              {fmtBytes(result.sizeBytes)}
            </span>
          )}
          <Btn onClick={() => void run()} disabled={busy}>
            {busy ? <Loader2 className="h-[15px] w-[15px] animate-spin" /> : <RefreshCw className="h-[15px] w-[15px]" />}
            Recompile
          </Btn>
        </div>
      </div>

      {simulate && (
        <div className="mb-3 rounded-[10px] border border-[#cdbaf2] bg-[#f8f5ff] px-3 py-2.5">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.05em] text-[#5b3fa8]">
            <UserRound className="h-3.5 w-3.5" strokeWidth={2.4} />
            Simulated recipient — made up, not a subscriber
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold text-muted-foreground">First name</span>
              <input
                value={firstName}
                maxLength={60}
                onChange={(e) => setFirstName(e.target.value)}
                placeholder="(nobody)"
                className="w-[150px] rounded-[8px] border border-border bg-card px-2 py-1 text-[12.5px] focus:border-brand focus:outline-none"
              />
            </label>
            <button
              type="button"
              onClick={() => setFirstName(firstName.trim() === "" ? SIMULATED_FIRST_NAME : "")}
              className="rounded-[8px] border border-border bg-card px-2 py-1 text-[11.5px] font-medium text-muted-foreground hover:text-foreground"
            >
              {firstName.trim() === "" ? "Give them a name" : "Leave it empty"}
            </button>

            {conditions
              .filter((f) => f.token !== "first_name" && f.token !== "has_first_name")
              .map((field) => (
                <label key={field.token} className="flex flex-col gap-1">
                  <span className="text-[11px] font-semibold text-muted-foreground">{field.label}</span>
                  {field.values.length > 0 ? (
                    <select
                      value={fields[field.token] ?? ""}
                      onChange={(e) => setFields((prev) => ({ ...prev, [field.token]: e.target.value }))}
                      className="rounded-[8px] border border-border bg-card px-2 py-1 text-[12.5px] focus:border-brand focus:outline-none"
                    >
                      <option value="">(empty)</option>
                      {field.values.map((v) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 rounded-[8px] border border-border bg-card px-2 py-1 text-[12.5px]">
                      <input
                        type="checkbox"
                        checked={(fields[field.token] ?? "") !== ""}
                        onChange={(e) =>
                          setFields((prev) => ({ ...prev, [field.token]: e.target.checked ? "1" : "" }))
                        }
                      />
                      {field.kind === "flag" ? "Yes" : "Has a value"}
                    </span>
                  )}
                </label>
              ))}
          </div>

          <p className="mt-2 text-[11px] leading-snug text-[#5b3fa8]/85">
            {conditions.length === 0
              ? "This template has no conditional blocks, so only the merge tags change here."
              : `Rendered through the worker's own hydrate(), so blocks hidden below are exactly the ones this profile would not receive.`}{" "}
            Brand, subject and locale come from this document; everything else is invented for the preview.
          </p>
        </div>
      )}

      {error && (
        <div className="mb-3 flex items-start gap-2 rounded-[10px] border border-[#f3c9c9] bg-[#fdecec] px-3 py-2.5 text-[12.5px] text-[#a33]">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={2} />
          <span>{error}</span>
        </div>
      )}

      {busy && !result && (
        <div className="flex h-[320px] items-center justify-center text-[12.5px] text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Compiling with MJML…
        </div>
      )}

      {result && view === "html" && (
        <div
          className="flex justify-center overflow-auto rounded-[12px] border border-border p-4"
          style={{ backgroundColor: dark ? "#15151b" : "#f4f4f7", maxHeight: "58vh" }}
        >
          <iframe
            key={`${width}-${dark}-${result.sizeBytes}-${hydratedBytes ?? "raw"}`}
            title="Email preview"
            sandbox=""
            srcDoc={dark ? (dk?.html ?? html) : html}
            className="h-[56vh] shrink-0 rounded-[8px] border border-border bg-white"
            style={{ width: viewport + IFRAME_BORDER }}
          />
        </div>
      )}

      {result && (aiUsed || footerUsed) && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] leading-snug text-muted-foreground">
          {footerUsed && (
            <span>
              {legal.html !== null ? (
                <>
                  Legal footer: this brand&rsquo;s real one
                  {legal.editions.length > 0 &&
                    ` (${editionLabel(legal.editions.find((e) => e.id === legal.editionId) ?? legal.editions[0]!)} edition)`}
                  , with the recipient&rsquo;s unsubscribe and preferences links shown as <code className="font-mono">#</code>.
                </>
              ) : (
                "Legal footer: could not be loaded — it is still added at send time."
              )}
              {legal.missing.length > 0 && (
                <strong className="font-semibold text-[#b9790a]">
                  {" "}
                  Incomplete — sending is blocked until it has: {legal.missing.join(", ")}.
                </strong>
              )}
            </span>
          )}
          {aiUsed && (
            <span className="inline-flex items-center gap-1 text-[#5b3fa8]">
              <Sparkles className="h-3 w-3" strokeWidth={2.2} />
              {simulate
                ? "AI text is shown as a marked [AI sample] — the real one is written for each send."
                : "AI tags print as-is here; switch to “As a recipient” to see a marked sample in place."}
            </span>
          )}
        </div>
      )}

      {result && view === "text" && (
        <pre className="max-h-[58vh] overflow-auto rounded-[12px] border border-border bg-accent/40 p-3 font-mono text-[11.5px] leading-relaxed">
          {text || "(empty plain-text version)"}
        </pre>
      )}

      {result && (
        <p className="mt-2 text-[11px] leading-snug text-muted-foreground/80">
          {simulate ? (
            <>
              Simulated view: merge tags are filled and conditional blocks resolved for the made-up recipient above.{" "}
              <strong className="font-semibold">No subscriber was read</strong>; the recipient&rsquo;s signed unsubscribe
              and preferences links are added at send time. What gets stored at publish is the unresolved template, not
              this.
            </>
          ) : (
            <>
              Merge tags such as <code className="font-mono">{"{{first_name}}"}</code> stay unresolved here — the worker
              fills them per recipient. The legal footer shown is the brand&rsquo;s real one; it is added at send time.
              {(doc.meta.headerPartialId !== undefined || doc.meta.footerPartialId !== undefined) &&
                " The brand header and footer set on this email are included, as they will be at send time."}
              {conditional &&
                " This template has conditional content: everything is shown here, including parts no single recipient will receive — switch to “As a recipient” to see one profile at a time."}
            </>
          )}
          {dark &&
            (dk?.hasDarkRules
              ? " Dark mode applies the template's own prefers-color-scheme rules; Gmail and Outlook additionally run their own colour inversion, which cannot be simulated here."
              : " This theme defines no dark-mode colours, so the switch changes nothing beyond the surrounding chrome.")}
        </p>
      )}

      {result && result.warnings.length > 0 && (
        <div className="mt-3 rounded-[10px] border border-amber-200 bg-amber-50 px-3 py-2.5">
          <div className="mb-1.5 flex items-center gap-1.5 text-[11.5px] font-semibold text-amber-800">
            <AlertTriangle className="h-3.5 w-3.5" strokeWidth={2} />
            {result.warnings.length} warning{result.warnings.length === 1 ? "" : "s"}
          </div>
          <ul className="list-disc space-y-1 pl-4 text-[11.5px] leading-snug text-amber-800">
            {result.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  );
}
