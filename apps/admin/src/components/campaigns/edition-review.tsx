"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Eye, EyeOff, Loader2, Pencil, RotateCcw, X } from "lucide-react";
import {
  EDITION_VIDE,
  MAX_AI_INTRO,
  MAX_AI_PREHEADER,
  MAX_EXCERPT,
  MAX_PREHEADER,
  MAX_SUBJECT,
  MAX_TITLE,
  estUrlWeb,
  type ArticleOverride,
  type EditionArticle,
  type EditionOverrides,
} from "@nf/edition/regles";
import { Btn, Pill } from "@/components/ui";

/**
 * « REVIEW EDITION » — relire, et corriger, ce qu'une édition de série va envoyer (0079).
 *
 * ⭐ La règle d'Alix (22/09/2026) : « je veux tout pouvoir modifier dans le builder ce que les users
 * vont recevoir sans exception !! ». Ici : le sujet, le preheader, l'introduction et l'accroche écrites
 * par le modèle, et chaque article du jour (cacher, corriger). Rien n'est obligatoire : ce que personne
 * ne touche part tel que généré.
 *
 * ⛔ L'ÉCRAN NE DÉCIDE RIEN. Il envoie un ÉCART ; la route le valide (mêmes règles que le worker,
 * `@nf/edition/regles`) et le worker reconstruit l'édition. L'aperçu vient du serveur, par la même
 * fonction que le worker : ce qui s'affiche ici est ce qui partira. Les contrôles faits ici (URL, titre
 * vide, tout caché) ne servent qu'à le dire plus tôt — le serveur les refait.
 *
 * ⚠️ Importe `@nf/edition/regles` et PAS `@nf/edition` : l'entrée principale tire `node:crypto` et le
 * compilateur MJML, qui n'ont rien à faire dans le navigateur.
 */

interface Vue {
  id: string;
  seq: number;
  localDate: string | null;
  status: string;
  editable: boolean;
  lockedReason: string | null;
  stage: "planned" | "frozen";
  rev: number;
  pending: boolean;
  error: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  aiStatus: string | null;
  aiReason: string | null;
  base: {
    subject: string;
    preheader: string | null;
    ai: boolean;
    aiIntro: string | null;
    aiPreheader: string | null;
    articles: EditionArticle[];
  };
  overrides: EditionOverrides | null;
}

interface Apercu {
  html: string;
  subjectRendered: string;
  preheader: string | null;
  articleCount: number;
  sizeBytes: number;
  recompiled: boolean;
  warnings: string[];
}

/** L'écart MINIMAL : une valeur égale à celle du gel n'en fait pas partie (c'est ce qui rend « reset » exact). */
function minimal(d: EditionOverrides, v: Vue): EditionOverrides {
  const out: EditionOverrides = {};
  if (d.subject !== undefined && d.subject.trim() !== "" && d.subject !== v.base.subject) out.subject = d.subject;
  if (d.preheader !== undefined && d.preheader.trim() !== "" && d.preheader !== (v.base.preheader ?? "")) out.preheader = d.preheader;
  if (d.ai_intro !== undefined && d.ai_intro !== (v.base.aiIntro ?? "")) out.ai_intro = d.ai_intro;
  if (d.ai_preheader !== undefined && d.ai_preheader !== (v.base.aiPreheader ?? "")) out.ai_preheader = d.ai_preheader;
  const articles: Record<string, ArticleOverride> = {};
  for (const a of v.base.articles) {
    const o = d.articles?.[a.id];
    if (!o) continue;
    const m: ArticleOverride = {};
    if (o.hidden) m.hidden = true;
    if (o.title !== undefined && o.title !== a.title) m.title = o.title;
    if (o.excerpt !== undefined && o.excerpt !== a.excerpt) m.excerpt = o.excerpt;
    if (o.href !== undefined && o.href !== a.href) m.href = o.href;
    if (o.imageSrc !== undefined && o.imageSrc !== (a.imageSrc ?? "")) m.imageSrc = o.imageSrc;
    if (Object.keys(m).length > 0) articles[a.id] = m;
  }
  if (Object.keys(articles).length > 0) out.articles = articles;
  return out;
}

/**
 * JSON à clés triées, À TOUS LES NIVEAUX. ⚠️ Pas `JSON.stringify(o, clesTriees)` : un tableau de clés
 * filtre aussi les objets imbriqués, et deux jeux d'articles différents s'écriraient pareil.
 */
function cle(v: unknown): string {
  if (v === null || v === undefined) return "{}";
  if (typeof v !== "object") return JSON.stringify(v);
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${cle(o[k])}`)
    .join(",")}}`;
}

/** Ce que l'écran peut dire AVANT le serveur. `null` = rien à signaler. */
function erreurArticle(a: EditionArticle, o: ArticleOverride | undefined): string | null {
  if (!o) return null;
  if (o.title !== undefined && o.title.trim() === "") return "The title cannot be empty — hide the article instead.";
  if (o.title !== undefined && o.title.length > MAX_TITLE) return `The title is longer than ${MAX_TITLE} characters.`;
  if (o.excerpt !== undefined && o.excerpt.length > MAX_EXCERPT) return `The excerpt is longer than ${MAX_EXCERPT} characters.`;
  if (o.href !== undefined && o.href !== a.href && !estUrlWeb(o.href)) return "The link must be a full http:// or https:// address.";
  if (o.imageSrc !== undefined && o.imageSrc !== "" && !estUrlWeb(o.imageSrc)) {
    return "The image must be a full http:// or https:// address (leave it empty for no image).";
  }
  return null;
}

export function EditionReview({
  occurrenceId,
  onClose,
  onSaved,
}: {
  occurrenceId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [vue, setVue] = useState<Vue | null>(null);
  const [draft, setDraft] = useState<EditionOverrides>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState<"load" | "save" | "preview" | null>("load");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [apercu, setApercu] = useState<Apercu | null>(null);

  const charger = useCallback(async () => {
    setBusy("load");
    try {
      const res = await fetch(`/api/campaigns/occurrences/${occurrenceId}/review`);
      const body = (await res.json().catch(() => ({}))) as Vue & { error?: string };
      if (!res.ok) {
        setError(body.error ?? `the server refused (${res.status})`);
        return;
      }
      setVue(body);
      setDraft(body.overrides ?? {});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [occurrenceId]);

  useEffect(() => {
    void charger();
  }, [charger]);

  const ecart = useMemo(() => (vue ? minimal(draft, vue) : {}), [draft, vue]);
  const modifie = vue !== null && cle(ecart) !== cle(vue.overrides);
  const articles = vue?.base.articles ?? [];
  const visibles = articles.filter((a) => !ecart.articles?.[a.id]?.hidden).length;
  const toutCache = articles.length > 0 && visibles === 0;
  const erreurs = articles.map((a) => erreurArticle(a, draft.articles?.[a.id])).filter((e): e is string => e !== null);
  const bloque = toutCache || erreurs.length > 0;

  const poser = (patch: Partial<EditionOverrides>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setApercu(null);
    setNotice(null);
  };
  const retirer = (k: keyof EditionOverrides) => {
    setDraft((d) => {
      const n = { ...d };
      delete n[k];
      return n;
    });
    setApercu(null);
  };
  const poserArticle = (id: string, patch: Partial<ArticleOverride> | null) => {
    setDraft((d) => {
      const tous = { ...(d.articles ?? {}) };
      if (patch === null) delete tous[id];
      else {
        const suivant: ArticleOverride = { ...(tous[id] ?? {}), ...patch };
        if (patch.hidden === undefined && "hidden" in patch) delete suivant.hidden;
        tous[id] = suivant;
      }
      return { ...d, articles: tous };
    });
    setApercu(null);
    setNotice(null);
  };

  async function apercevoir() {
    setBusy("preview");
    setError(null);
    try {
      const res = await fetch(`/api/campaigns/occurrences/${occurrenceId}/review/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ overrides: ecart }),
      });
      const body = (await res.json().catch(() => ({}))) as Apercu & { error?: string };
      if (!res.ok) {
        setError(body.error ?? `the server refused (${res.status})`);
        return;
      }
      setApercu(body);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function enregistrer() {
    if (!vue) return;
    setBusy("save");
    setError(null);
    try {
      const res = await fetch(`/api/campaigns/occurrences/${occurrenceId}/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rev: vue.rev, overrides: ecart }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; next?: string; unchanged?: boolean };
      if (!res.ok) {
        // La raison du serveur, mot pour mot : c'est lui qui sait pourquoi.
        setError(body.error ?? `the server refused (${res.status})`);
        return;
      }
      setNotice(body.unchanged ? "Nothing changed." : (body.next ?? "Saved."));
      await charger();
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const entete = (
    <div className="flex items-center gap-2">
      <p className="text-[12.5px] font-semibold">Review edition</p>
      {vue?.pending && vue.stage === "frozen" && <Pill tone="amber">changes pending</Pill>}
      {vue && Object.keys(vue.overrides ?? {}).length > 0 && !vue.pending && <Pill tone="blue">reviewed</Pill>}
      <button type="button" onClick={onClose} className="ml-auto text-muted-foreground hover:text-foreground" aria-label="Close review">
        <X className="h-4 w-4" />
      </button>
    </div>
  );

  if (!vue) {
    return (
      <div className="mt-2.5 rounded-[10px] border border-border bg-accent/20 px-3 py-2.5">
        {entete}
        {busy === "load" ? (
          <p className="mt-2 inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading the edition…
          </p>
        ) : (
          <p className="mt-2 text-[12px] text-red-800">{error ?? "This edition could not be loaded."}</p>
        )}
      </div>
    );
  }

  const lecture = !vue.editable;
  const gelee = vue.stage === "frozen";
  const champ = "w-full rounded-[8px] border border-border bg-card px-2.5 py-1.5 text-[12.5px] disabled:opacity-60";

  return (
    <div className="mt-2.5 space-y-3 rounded-[10px] border border-border bg-accent/20 px-3 py-2.5">
      {entete}

      {lecture && (
        <p className="rounded-[8px] border border-border bg-card px-2.5 py-2 text-[12px] text-muted-foreground">
          Read only: {vue.lockedReason}
        </p>
      )}

      {/* ⛔ UNE RELECTURE QUI NE S'APPLIQUE PAS BLOQUE L'ENVOI : le dire ici, à côté du geste qui la lève. */}
      {vue.error && (
        <div className="flex items-start gap-2 rounded-[8px] border border-red-200 bg-red-50 px-2.5 py-2 text-[12px] text-red-800">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            <b>Your last changes could not be applied:</b> {vue.error}. This edition will not be sent until you fix or undo
            them.
          </span>
        </div>
      )}
      {vue.pending && gelee && !vue.error && (
        <p className="text-[11.5px] text-amber-800">
          Changes saved — the edition is being rebuilt with them (within a few minutes). It is not sent until it is.
        </p>
      )}

      <div className="grid gap-2.5">
        <label className="grid gap-1 text-[11.5px] font-medium text-muted-foreground">
          <span className="flex items-center gap-2">
            Subject
            {draft.subject !== undefined && !lecture && (
              <button type="button" onClick={() => retirer("subject")} className="font-normal underline underline-offset-2">
                Use the campaign subject
              </button>
            )}
          </span>
          <input
            className={champ}
            disabled={lecture}
            maxLength={MAX_SUBJECT}
            value={draft.subject ?? vue.base.subject}
            onChange={(e) => poser({ subject: e.target.value })}
          />
        </label>
        <label className="grid gap-1 text-[11.5px] font-medium text-muted-foreground">
          <span className="flex items-center gap-2">
            Preheader
            {draft.preheader !== undefined && !lecture && (
              <button type="button" onClick={() => retirer("preheader")} className="font-normal underline underline-offset-2">
                Use the campaign preheader
              </button>
            )}
          </span>
          <input
            className={champ}
            disabled={lecture}
            maxLength={MAX_PREHEADER}
            value={draft.preheader ?? vue.base.preheader ?? ""}
            onChange={(e) => poser({ preheader: e.target.value })}
          />
        </label>
      </div>

      {!gelee && (
        <p className="text-[11.5px] text-muted-foreground">
          The articles of the day and the AI text are picked when this edition is frozen, shortly before the send. You can
          review and edit them from then on — the subject and preheader can be changed now.
        </p>
      )}

      {/* LES TEXTES DU MODÈLE — lisibles, corrigibles, « Reset to AI version ». */}
      {gelee && vue.base.ai && (
        <div className="grid gap-2.5">
          {vue.aiStatus === "failed" && (
            <p className="text-[11.5px] text-amber-800">
              The AI text was not generated ({vue.aiReason ?? "no reason recorded"}). You can write it here, or the edition
              ships without it.
            </p>
          )}
          {(
            [
              ["ai_preheader", "AI preheader", vue.base.aiPreheader, MAX_AI_PREHEADER, 2],
              ["ai_intro", "AI intro", vue.base.aiIntro, MAX_AI_INTRO, 4],
            ] as const
          ).map(([k, libelle, genere, max, lignes]) => (
            <label key={k} className="grid gap-1 text-[11.5px] font-medium text-muted-foreground">
              <span className="flex items-center gap-2">
                {libelle}
                {draft[k] !== undefined && draft[k] !== (genere ?? "") && <Pill tone="violet">edited</Pill>}
                {draft[k] !== undefined && !lecture && (
                  <button
                    type="button"
                    onClick={() => retirer(k)}
                    className="inline-flex items-center gap-1 font-normal underline underline-offset-2"
                  >
                    <RotateCcw className="h-3 w-3" /> Reset to AI version
                  </button>
                )}
              </span>
              <textarea
                className={champ}
                disabled={lecture}
                rows={lignes}
                maxLength={max}
                value={draft[k] ?? genere ?? ""}
                onChange={(e) => poser({ [k]: e.target.value } as Partial<EditionOverrides>)}
              />
            </label>
          ))}
        </div>
      )}

      {/* LES ARTICLES DU JOUR — cacher, corriger. */}
      {gelee && articles.length > 0 && (
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">
            Articles in this edition · {visibles} of {articles.length} shown
          </p>
          <ol className="mt-1.5 space-y-1.5">
            {articles.map((a, i) => {
              const o = draft.articles?.[a.id];
              const cache = o?.hidden === true;
              const titre = o?.title ?? a.title;
              const faute = erreurArticle(a, o);
              return (
                <li key={a.id} className={`rounded-[8px] border border-border bg-card px-2.5 py-2 ${cache ? "opacity-55" : ""}`}>
                  <div className="flex items-start gap-2">
                    <span className="tabular-nums text-[12px] text-muted-foreground/70">{i + 1}.</span>
                    <div className="min-w-0 flex-1">
                      <p className={`truncate text-[12.5px] font-medium ${cache ? "line-through" : ""}`} title={titre}>
                        {titre || "(no title)"}
                      </p>
                      <p className="truncate text-[11.5px] text-muted-foreground">{o?.href ?? a.href}</p>
                    </div>
                    {o && (o.title !== undefined || o.excerpt !== undefined || o.href !== undefined || o.imageSrc !== undefined) && (
                      <Pill tone="violet">edited</Pill>
                    )}
                    {!lecture && (
                      <>
                        <button
                          type="button"
                          onClick={() => poserArticle(a.id, { hidden: cache ? undefined : true })}
                          className="inline-flex items-center gap-1 rounded-[6px] border border-border px-2 py-0.5 text-[11.5px]"
                        >
                          {cache ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                          {cache ? "Show" : "Hide"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditing(editing === a.id ? null : a.id)}
                          className="inline-flex items-center gap-1 rounded-[6px] border border-border px-2 py-0.5 text-[11.5px]"
                        >
                          <Pencil className="h-3 w-3" /> Edit
                        </button>
                      </>
                    )}
                  </div>
                  {editing === a.id && !lecture && (
                    <div className="mt-2 grid gap-1.5">
                      {(
                        [
                          ["title", "Title", a.title, false],
                          ["excerpt", "Excerpt", a.excerpt, true],
                          ["imageSrc", "Image URL (empty = no image)", a.imageSrc ?? "", false],
                          ["href", "Link URL", a.href, false],
                        ] as const
                      ).map(([k, libelle, origine, long]) => (
                        <label key={k} className="grid gap-0.5 text-[11px] text-muted-foreground">
                          {libelle}
                          {long ? (
                            <textarea
                              className={champ}
                              rows={2}
                              value={o?.[k] ?? origine}
                              onChange={(e) => poserArticle(a.id, { [k]: e.target.value } as Partial<ArticleOverride>)}
                            />
                          ) : (
                            <input
                              className={champ}
                              value={o?.[k] ?? origine}
                              onChange={(e) => poserArticle(a.id, { [k]: e.target.value } as Partial<ArticleOverride>)}
                            />
                          )}
                        </label>
                      ))}
                      <button
                        type="button"
                        onClick={() => poserArticle(a.id, cache ? { title: undefined, excerpt: undefined, href: undefined, imageSrc: undefined } : null)}
                        className="justify-self-start text-[11.5px] underline underline-offset-2 text-muted-foreground"
                      >
                        Undo edits to this article
                      </button>
                    </div>
                  )}
                  {faute && <p className="mt-1 text-[11.5px] text-red-700">{faute}</p>}
                </li>
              );
            })}
          </ol>
          {/* ⛔ UNE ÉDITION VIDE NE PART PAS : refusé ici, et redit par le serveur. */}
          {toutCache && <p className="mt-1.5 text-[11.5px] font-medium text-red-700">{EDITION_VIDE}.</p>}
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-[8px] border border-red-200 bg-red-50 px-2.5 py-2 text-[12px] text-red-800">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {notice && <p className="text-[11.5px] text-emerald-800">{notice}</p>}

      <div className="flex flex-wrap items-center gap-2">
        {gelee && (
          <Btn type="button" disabled={busy !== null || bloque} onClick={apercevoir}>
            {busy === "preview" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Preview email
          </Btn>
        )}
        {!lecture && (
          <Btn
            type="button"
            variant="primary"
            disabled={busy !== null || bloque || !modifie}
            title={!modifie ? "Nothing to save" : bloque ? "Fix the problems above first" : undefined}
            onClick={enregistrer}
          >
            {busy === "save" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save changes
          </Btn>
        )}
        {vue.updatedAt && (
          <span className="text-[11px] text-muted-foreground">
            Last reviewed {new Date(vue.updatedAt).toLocaleString()}
            {vue.updatedBy ? ` by ${vue.updatedBy}` : ""}
          </span>
        )}
      </div>

      {apercu && (
        <div className="space-y-1.5">
          <p className="text-[11.5px] text-muted-foreground">
            <b className="text-foreground">{apercu.subjectRendered}</b>
            {apercu.preheader ? ` — ${apercu.preheader}` : ""} · {apercu.articleCount} article
            {apercu.articleCount === 1 ? "" : "s"} · {(apercu.sizeBytes / 1024).toFixed(0)} KB
            {apercu.recompiled ? " · rebuilt with your changes" : ""}
          </p>
          <p className="text-[11px] text-muted-foreground/80">
            Built by the same function the sender uses. Name, address and legal footer are sample values.
          </p>
          {apercu.warnings.length > 0 && (
            <ul className="text-[11px] text-amber-800">
              {apercu.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
          {/* sandbox vide : l'aperçu n'exécute rien et ne navigue nulle part. */}
          <iframe title="Edition preview" sandbox="" srcDoc={apercu.html} className="h-[640px] w-full max-w-[640px] rounded-[8px] border border-border bg-white" />
        </div>
      )}
    </div>
  );
}
