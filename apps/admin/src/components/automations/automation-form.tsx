"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, Check, ExternalLink, Loader2, Minus, Plus, RefreshCw } from "lucide-react";
import {
  DAILY_CAP_MAX,
  PURPOSES,
  TRIGGERS,
  validateAutomation,
  type TriggerId,
  type TriggerSpec,
} from "@nf/automations";
import { Btn, Card, CardHead, Pill } from "@/components/ui";
import { purposeLabel, readError } from "@/components/campaigns/shared";
import { CREATABLE_TRIGGERS, formatDelay, policyText, unavailableVariables, variablesFor, type VariableView } from "@/lib/automations";
import {
  erreursEtapes,
  etatVersionEtape,
  optionsFuseau,
  trierEtapes,
  type VersionEpinglee,
  type VersionPubliee,
} from "@/lib/automation-edit";
import { bodyOf, defaultsFor, type FormValue } from "./form-values";

/**
 * Le formulaire d'une automation — création et modification d'un brouillon (étapes 10 et 12 ; plan
 * AUTO-EDIT du 25/09/2026 : c'est aussi LA page d'un brouillon).
 *
 * ⛔ IL N'EXPOSE QUE LE CATALOGUE. Déclencheur dans la liste FERMÉE, réglages bornés par le catalogue,
 * filtres connus (opt-in, langue, intérêts), étapes = délai + version publiée d'un modèle de la marque.
 * Aucun champ libre qui deviendrait une requête (le fuseau, libre, est validé par `Intl`).
 *
 * ⛔ LA VALIDATION AFFICHÉE EST CELLE DU SERVEUR ET DU WORKER (`validateAutomation`) : l'écran la
 * calcule pour prévenir, la route la refait pour décider. Même fonction, mêmes phrases — à UNE
 * exception près : les étapes sont rangées par délai AVANT la validation (`trierEtapes`), et deux délais
 * égaux s'affichent avec leurs numéros au lieu de « must be longer than » (`erreursEtapes`).
 */

export interface FormOptions {
  templates: VersionPubliee[];
  templatesKnown: boolean;
  optins: { id: string; name: string; archived: boolean }[];
  interests: { id: number; label: string }[];
  /** Labels d'automation de la marque (0095), nommés dans optinforge (onglet Where d'une créative). */
  labels: { slug: string; name: string }[];
  filtersKnown: boolean;
  /** Langues de la marque (`asset.languages`), dans la forme que porte `subscription.language`. */
  languages: string[];
  /** Fuseaux des éditions des marques (`listTimezonesInUse`) ; UTC et la valeur courante s'y ajoutent. */
  timezones: string[];
  /** Les versions citées par les étapes enregistrées (`describeVersions`), par id de version. */
  pinned?: Record<string, VersionEpinglee>;
}

// ⛔ Valeurs par défaut et corps de requête : dans `form-values.ts`, JAMAIS ici. Les pages serveur en ont
// besoin, et une fonction exportée par ce module `"use client"` n'y arrive que comme référence client.
export type { FormValue } from "./form-values";

const champ =
  "w-full rounded-[9px] border border-border bg-card px-3 py-2 text-[13px] outline-none focus:ring-2 focus:ring-brand/30";
const heures = Array.from({ length: 25 }, (_, h) => h);
const AUTRE_FUSEAU = "__other__";
const lienExterne = "inline-flex items-center gap-1 text-[12px] font-medium text-brand hover:underline";

const uniteDe = (h: number): "h" | "d" => (h >= 24 && h % 24 === 0 ? "d" : "h");

/** Les étapes (et leurs unités d'affichage) dans l'ordre de leurs délais. */
function ranger(v: FormValue, unites: ("h" | "d")[]): { v: FormValue; unites: ("h" | "d")[] } {
  const { ordre } = trierEtapes(v.steps.map((s) => s.delay_hours));
  if (ordre.every((j, k) => j === k)) return { v, unites };
  return {
    v: { ...v, steps: ordre.map((j) => v.steps[j]!) },
    unites: ordre.map((j) => unites[j] ?? uniteDe(v.steps[j]!.delay_hours)),
  };
}

export function AutomationForm({
  mode,
  id,
  initial,
  options,
  assetId,
  triggerLockedReason = null,
  justSaved = false,
}: {
  mode: "create" | "edit";
  id?: string;
  initial: FormValue;
  options: FormOptions;
  /** Sert seulement au calcul local de la validation (la route prend la marque de la session). */
  assetId: string;
  /**
   * En modification : pourquoi le déclencheur est figé (`null` = il peut changer). Il ne change que sur
   * un brouillon qui n'a jamais sélectionné personne — la route le revérifie (409).
   */
  triggerLockedReason?: string | null;
  /** Arrivée juste après une création ou une copie (`?saved=1`) : le dire. */
  justSaved?: boolean;
}) {
  const router = useRouter();
  const [depart] = useState(() => ranger(initial, initial.steps.map((s) => uniteDe(s.delay_hours))));
  const [v, setV] = useState<FormValue>(depart.v);
  const [unites, setUnites] = useState<("h" | "d")[]>(depart.unites);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverErrors, setServerErrors] = useState<string[]>([]);
  // Ce qui est en base, tel que le formulaire l'enverrait : « Saved » tant que rien n'a bougé depuis.
  const [enregistre, setEnregistre] = useState(() => (mode === "edit" ? JSON.stringify(bodyOf(depart.v)) : null));
  const [saved, setSaved] = useState(justSaved);
  const [fuseauLibre, setFuseauLibre] = useState(false);

  const spec: TriggerSpec = TRIGGERS[v.trigger];
  // 0095 : la promo exige un opt-in OU un label — le dire au-dessus des deux listes.
  const requisLabel = (spec.requiredFilter?.length ?? 0) > 1;
  // ⭐ Les étapes sont validées et envoyées RANGÉES par délai : l'ordre saisi n'est jamais une erreur.
  const tri = trierEtapes(v.steps.map((s) => s.delay_hours));
  const body = bodyOf({ ...v, steps: tri.ordre.map((j) => v.steps[j]!) });
  // Recalculée à chaque rendu : c'est une fonction pure et bornée (5 étapes au plus).
  const validation = validateAutomation({ ...body, asset_id: assetId, status: "draft" });
  const erreurs = erreursEtapes(validation.ok ? [] : validation.errors, tri.erreurs);
  const modifie = enregistre !== null && JSON.stringify(body) !== enregistre;

  const set = (patch: Partial<FormValue>) => setV((cur) => ({ ...cur, ...patch }));

  /** Range les étapes affichées (à la sortie d'un champ de délai) : l'écran suit l'ordre des délais. */
  function rangerAffichage() {
    const r = ranger(v, unites);
    if (r.v !== v) {
      setV(r.v);
      setUnites(r.unites);
    }
  }

  function changerDeclencheur(t: TriggerId) {
    const d = defaultsFor(t, { name: v.name, timezone: v.timezone });
    setV({ ...d, daily_cap: v.daily_cap, window_start_hour: v.window_start_hour, window_end_hour: v.window_end_hour });
    setUnites(d.steps.map((s) => uniteDe(s.delay_hours)));
  }

  function majEtape(i: number, patch: Partial<FormValue["steps"][number]>) {
    set({ steps: v.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  }

  function ajouterEtape() {
    // Après la plus longue : la nouvelle étape arrive déjà à sa place.
    const der = Math.max(0, ...v.steps.map((s) => s.delay_hours).filter(Number.isFinite));
    const pas = Math.max(24, spec.steps.minDelayHours);
    set({ steps: [...v.steps, { delay_hours: Math.min(der + pas, spec.steps.maxDelayHours), template_version_id: null }] });
    setUnites([...unites, "h"]);
  }

  function retirerEtape(i: number) {
    set({ steps: v.steps.filter((_, j) => j !== i) });
    setUnites(unites.filter((_, j) => j !== i));
  }

  function basculer<T>(liste: T[], x: T): T[] {
    return liste.includes(x) ? liste.filter((y) => y !== x) : [...liste, x];
  }

  async function enregistrer() {
    rangerAffichage();
    setBusy(true);
    setError(null);
    setServerErrors([]);
    setSaved(false);
    const envoye = JSON.stringify(body);
    try {
      const res = await fetch(mode === "create" ? "/api/automations" : `/api/automations/${id}`, {
        method: mode === "create" ? "POST" : "PUT",
        headers: { "content-type": "application/json" },
        body: envoye,
      });
      if (!res.ok) {
        const clone = res.clone();
        setError(await readError(res));
        try {
          const b = (await clone.json()) as { errors?: unknown };
          if (Array.isArray(b.errors)) setServerErrors(b.errors.map(String));
        } catch {
          /* corps non-JSON */
        }
        return;
      }
      if (mode === "edit") {
        // ⭐ On RESTE sur la page (c'est le formulaire du brouillon) ; `refresh` relit l'aperçu d'audience
        // et les contrôles d'état, qui décrivent ce qui est en base.
        setEnregistre(envoye);
        setSaved(true);
        router.refresh();
        return;
      }
      const b = (await res.json()) as { id?: string };
      router.push(b.id ? `/automations/${b.id}?saved=1` : "/automations");
      router.refresh();
    } catch {
      setError("Network error: nothing was saved.");
    } finally {
      setBusy(false);
    }
  }

  const variables = variablesFor(v.trigger);
  const indisponibles = unavailableVariables(v.trigger);

  return (
    <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
      <div className="flex flex-col gap-4">
        <Card>
          <CardHead title="Trigger" sub="From the catalogue: no free query" />
          <label className="text-[12.5px] font-medium" htmlFor="auto-name">
            Name
          </label>
          <input
            id="auto-name"
            className={`${champ} mt-1`}
            value={v.name}
            maxLength={120}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="e.g. Confirmation reminder, 24 h"
          />
          <label className="mt-3 block text-[12.5px] font-medium" htmlFor="auto-trigger">
            Trigger
          </label>
          <select
            id="auto-trigger"
            className={`${champ} mt-1`}
            value={v.trigger}
            disabled={mode === "edit" && triggerLockedReason !== null}
            onChange={(e) => changerDeclencheur(e.target.value as TriggerId)}
          >
            {CREATABLE_TRIGGERS.map((t) => (
              <option key={t} value={t}>
                {TRIGGERS[t].label}
              </option>
            ))}
          </select>
          {mode === "edit" && (
            <p className="mt-1 text-[11.5px] text-muted-foreground">
              {triggerLockedReason ?? "Changing the trigger resets the steps, settings and filters to the new trigger's defaults. The name and sending limits stay."}
            </p>
          )}
          <p className="mt-2 text-[12.5px] leading-relaxed text-foreground/80">{spec.description}</p>
          <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">{policyText(spec)}</p>
          {spec.liveBlockedReason && (
            <p className="mt-2 rounded-[9px] bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
              Can be simulated, cannot go live: {spec.liveBlockedReason}
            </p>
          )}
          {spec.policy === "marketing" && (
            <>
              <label className="mt-3 block text-[12.5px] font-medium" htmlFor="auto-purpose">
                Purpose <span className="font-normal text-muted-foreground">(the consent it is sent under)</span>
              </label>
              <select
                id="auto-purpose"
                className={`${champ} mt-1`}
                value={v.purpose ?? ""}
                onChange={(e) => set({ purpose: e.target.value || null })}
              >
                <option value="">Choose a purpose…</option>
                {PURPOSES.map((p) => (
                  <option key={p} value={p}>
                    {purposeLabel(p)}
                  </option>
                ))}
              </select>
            </>
          )}
          {Object.entries(spec.settings).filter(([, s]) => !s.readOnly).length > 0 && (
            <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3">
              {Object.entries(spec.settings)
                .filter(([, s]) => !s.readOnly)
                .map(([k, s]) =>
                  s.type === "boolean" ? (
                    <label key={k} className="flex items-center gap-2 text-[12.5px]">
                      <input
                        type="checkbox"
                        checked={v.settings[k] === true}
                        onChange={(e) => set({ settings: { ...v.settings, [k]: e.target.checked } })}
                      />
                      {s.label}
                    </label>
                  ) : (
                    <label key={k} className="flex items-center justify-between gap-3 text-[12.5px]">
                      <span>
                        {s.label} <span className="text-muted-foreground">({s.min}–{s.max})</span>
                      </span>
                      <input
                        type="number"
                        className={`${champ} w-[110px]`}
                        min={s.min}
                        max={s.max}
                        value={Number(v.settings[k] ?? s.default)}
                        onChange={(e) => set({ settings: { ...v.settings, [k]: Math.trunc(Number(e.target.value)) } })}
                      />
                    </label>
                  ),
                )}
            </div>
          )}
        </Card>

        <Card>
          <CardHead
            title="Steps"
            sub={`${spec.steps.min === spec.steps.max ? spec.steps.min : `${spec.steps.min} to ${spec.steps.max}`} step(s), delays counted from the trigger${spec.steps.max > 1 ? " — kept in order of delay" : ""}`}
          />
          <div className="flex flex-col gap-3">
            {v.steps.map((s, i) => {
              const u = unites[i] ?? "h";
              const facteur = u === "d" ? 24 : 1;
              const etat = etatVersionEtape(s.template_version_id, options.pinned ?? {}, options.templates);
              const dansLaListe = options.templates.some((t) => t.versionId === s.template_version_id);
              return (
                <div key={i} className="rounded-[10px] border border-border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Step {i + 1}</span>
                    <span className="text-[12.5px]">after</span>
                    <input
                      type="number"
                      aria-label={`Step ${i + 1} delay`}
                      className={`${champ} w-[90px]`}
                      min={0}
                      value={s.delay_hours / facteur}
                      onChange={(e) => majEtape(i, { delay_hours: Math.round(Number(e.target.value) * facteur) })}
                      onBlur={rangerAffichage}
                    />
                    <select
                      aria-label={`Step ${i + 1} delay unit`}
                      className={`${champ} w-[90px]`}
                      value={u}
                      onChange={(e) => setUnites(unites.map((x, j) => (j === i ? (e.target.value as "h" | "d") : x)))}
                    >
                      <option value="h">hours</option>
                      <option value="d">days</option>
                    </select>
                    <span className="text-[11.5px] text-muted-foreground">= {formatDelay(s.delay_hours)}</span>
                    {v.steps.length > spec.steps.min && (
                      <button
                        type="button"
                        onClick={() => retirerEtape(i)}
                        className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-muted-foreground hover:bg-accent"
                      >
                        <Minus className="h-3.5 w-3.5" /> Remove
                      </button>
                    )}
                  </div>
                  {spec.steps.requiresTemplate ? (
                    <div className="mt-2">
                      <select
                        aria-label={`Step ${i + 1} template`}
                        className={champ}
                        value={s.template_version_id ?? ""}
                        onChange={(e) => majEtape(i, { template_version_id: e.target.value || null })}
                      >
                        <option value="">Choose a published template…</option>
                        {s.template_version_id && !dansLaListe && (
                          <option value={s.template_version_id}>{etat.optionLabel ?? "Template version not found"}</option>
                        )}
                        {options.templates.map((t) => (
                          <option key={t.versionId} value={t.versionId}>
                            {t.templateName} · v{t.version}
                            {t.subject ? ` — ${t.subject}` : ""}
                          </option>
                        ))}
                      </select>
                      {/* Plan AUTO-EDIT, étape 5 : ce que l'étape envoie — sujet, version — et où le changer. */}
                      {etat.kind !== "none" && etat.kind !== "unknown" && (
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
                          <span className="text-foreground/80">
                            <span className="text-muted-foreground">Subject:</span>{" "}
                            {etat.subject ?? <span className="text-muted-foreground">—</span>}
                          </span>
                          {etat.version !== null && (
                            <span className="tabular-nums text-muted-foreground">
                              v{etat.version}
                              {etat.kind === "latest" ? " · latest published" : ""}
                            </span>
                          )}
                          {etat.templateId && (
                            <a href={`/builder/${etat.templateId}`} target="_blank" rel="noopener noreferrer" className={lienExterne}>
                              Edit template <ExternalLink className="h-3 w-3" />
                            </a>
                          )}
                        </div>
                      )}
                      {etat.newer && (
                        <button
                          type="button"
                          onClick={() => majEtape(i, { template_version_id: etat.newer!.versionId })}
                          className="mt-1.5 inline-flex items-center gap-1 rounded-[7px] border border-amber-200 bg-amber-50 px-2 py-0.5 text-[12px] font-medium text-amber-800 hover:bg-amber-100"
                        >
                          {etat.newer.action}
                        </button>
                      )}
                      {etat.note && <p className="mt-1 text-[12px] text-amber-700">{etat.note}</p>}
                    </div>
                  ) : (
                    <p className="mt-2 text-[12px] text-muted-foreground">This trigger sends nothing: no template.</p>
                  )}
                </div>
              );
            })}
            {!options.templatesKnown && spec.steps.requiresTemplate && (
              <p className="text-[12px] text-amber-700">The templates of this brand could not be read right now.</p>
            )}
            {options.templatesKnown && options.templates.length === 0 && spec.steps.requiresTemplate && (
              <p className="text-[12px] text-amber-700">
                No published template you can open in this brand. Publish one in{" "}
                <Link href="/templates" className="underline">
                  Templates
                </Link>{" "}
                first.
              </p>
            )}
            {v.steps.length < spec.steps.max && (
              <button
                type="button"
                onClick={ajouterEtape}
                className="inline-flex w-fit items-center gap-1.5 rounded-[9px] border border-dashed border-border px-3 py-1.5 text-[12.5px] hover:bg-accent"
              >
                <Plus className="h-3.5 w-3.5" /> Add a step
              </button>
            )}
            {spec.steps.requiresTemplate && (
              <div className="flex flex-col gap-1 border-t border-border pt-3 text-[12px] text-muted-foreground">
                <p className="leading-snug">
                  The subject and the content come from the template: change them in the builder, publish, then use the
                  new version here.
                </p>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <a href="/builder" target="_blank" rel="noopener noreferrer" className={lienExterne}>
                    New template <ExternalLink className="h-3 w-3" />
                  </a>
                  {/* Un modèle publié dans l'autre onglet n'est pas encore dans la liste : la relire garde la saisie. */}
                  <button type="button" onClick={() => router.refresh()} className={lienExterne}>
                    <RefreshCw className="h-3 w-3" /> Refresh templates
                  </button>
                </div>
              </div>
            )}
          </div>
          {spec.steps.requiresTemplate && <Variables variables={variables} indisponibles={indisponibles} />}
        </Card>

        <Card>
          <CardHead title="Filters" sub="Optional: narrow who the trigger selects" />
          {!options.filtersKnown && (
            <p className="mb-2 text-[12px] text-amber-700">The opt-ins and interests of this brand could not be read right now.</p>
          )}
          {requisLabel && (
            <p className="mb-2 text-[12px] text-muted-foreground">Pick at least one opt-in or one automation label.</p>
          )}
          <Choix
            titre={`Opt-in${spec.requiredFilter?.length === 1 ? " (at least one required)" : ""}`}
            vide="No opt-in in this brand."
            items={options.optins.map((o) => ({ key: o.id, label: o.archived ? `${o.name} (archived)` : o.name }))}
            coches={v.filters.optin_ids}
            onToggle={(k) => set({ filters: { ...v.filters, optin_ids: basculer(v.filters.optin_ids, k) } })}
          />
          <Choix
            titre="Language"
            vide="No language set for this brand."
            // ⚠️ Clé en minuscules : la validation range `pt-BR` en `pt-br` (et 0082 compare en
            // minuscules) ; une clé en casse d'origine ne se recocherait pas à la modification.
            items={options.languages.map((l) => ({ key: l.toLowerCase(), label: l }))}
            coches={v.filters.languages}
            onToggle={(k) => set({ filters: { ...v.filters, languages: basculer(v.filters.languages, k) } })}
          />
          <Choix
            titre="Interests (any of)"
            vide="No interest in this brand."
            items={options.interests.map((t) => ({ key: String(t.id), label: t.label }))}
            coches={v.filters.interest_ids.map(String)}
            onToggle={(k) =>
              set({ filters: { ...v.filters, interest_ids: basculer(v.filters.interest_ids, Number(k)) } })
            }
          />
          <Choix
            titre="Automation label (any of)"
            vide="No automation label yet: name one in optinforge, in the Where tab of a creative."
            // Un label coché qui n'est plus au registre reste affiché (par son slug) : sinon il serait
            // impossible à décocher, et l'automation filtrerait sur un label invisible.
            items={[
              ...options.labels.map((l) => ({ key: l.slug, label: l.name })),
              ...v.filters.labels.filter((s) => !options.labels.some((l) => l.slug === s)).map((s) => ({ key: s, label: s })),
            ]}
            coches={v.filters.labels}
            onToggle={(k) => set({ filters: { ...v.filters, labels: basculer(v.filters.labels, k) } })}
          />
        </Card>
      </div>

      <div className="flex flex-col gap-4">
        <Card>
          <CardHead title="Guardrails" />
          <label className="flex items-center justify-between gap-3 text-[12.5px]">
            <span>
              Daily cap <span className="text-muted-foreground">(1–{DAILY_CAP_MAX.toLocaleString("en-US")})</span>
            </span>
            <input
              type="number"
              className={`${champ} w-[110px]`}
              min={1}
              max={DAILY_CAP_MAX}
              value={v.daily_cap}
              onChange={(e) => set({ daily_cap: Math.trunc(Number(e.target.value)) })}
            />
          </label>
          <div className="mt-3 flex items-center gap-2 text-[12.5px]">
            <span className="shrink-0">Send between</span>
            <select
              aria-label="Window start"
              className={`${champ} w-[80px]`}
              value={v.window_start_hour}
              onChange={(e) => set({ window_start_hour: Number(e.target.value) })}
            >
              {heures.slice(0, 24).map((h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, "0")}:00
                </option>
              ))}
            </select>
            <span>and</span>
            <select
              aria-label="Window end"
              className={`${champ} w-[80px]`}
              value={v.window_end_hour}
              onChange={(e) => set({ window_end_hour: Number(e.target.value) })}
            >
              {heures.slice(1).map((h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, "0")}:00
                </option>
              ))}
            </select>
          </div>
          <label className="mt-3 block text-[12.5px]" htmlFor="auto-tz">
            Time zone of the window
          </label>
          {/* Plan AUTO-EDIT, étape 6 : les fuseaux des marques, UTC, la valeur courante (jamais perdue),
              et « Other… » pour en taper un autre — validé par le catalogue (`unknown time zone`). */}
          <select
            id="auto-tz"
            className={`${champ} mt-1`}
            value={fuseauLibre ? AUTRE_FUSEAU : v.timezone}
            onChange={(e) => {
              if (e.target.value === AUTRE_FUSEAU) {
                setFuseauLibre(true);
                return;
              }
              setFuseauLibre(false);
              set({ timezone: e.target.value });
            }}
          >
            {!v.timezone.trim() && !fuseauLibre && <option value={v.timezone}>Choose a time zone…</option>}
            {optionsFuseau(options.timezones, v.timezone).map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
            <option value={AUTRE_FUSEAU}>Other…</option>
          </select>
          {fuseauLibre && (
            <input
              aria-label="Other time zone"
              autoFocus
              className={`${champ} mt-1.5`}
              value={v.timezone}
              onChange={(e) => set({ timezone: e.target.value })}
              placeholder="IANA name, e.g. America/Santiago"
            />
          )}
          <p className="mt-3 text-[11.5px] leading-snug text-muted-foreground">
            Also enforced, not editable: the worker&apos;s allowlist when live, demo subscribers never selected, and
            the send gate&apos;s consent checks.
          </p>
        </Card>

        <Card>
          <CardHead title={mode === "create" ? "Create" : "Save"} sub="Saved as a draft: it does nothing until simulated" />
          {saved && !modifie && (
            <p className="mb-3 flex items-center gap-1.5 text-[12.5px] font-medium text-[#1f9d57]" role="status">
              <Check className="h-4 w-4" /> Saved
            </p>
          )}
          {modifie && (
            <p className="mb-3 text-[12px] text-amber-800" role="status">
              Unsaved changes. Simulate uses the last saved version.
            </p>
          )}
          {erreurs.length > 0 ? (
            <ul className="mb-3 flex flex-col gap-1">
              {erreurs.map((e) => (
                <li key={e} className="flex items-start gap-1.5 text-[12px] text-amber-800">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {e}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mb-3 text-[12px] text-[#1f9d57]">Valid for the engine.</p>
          )}
          {error && (
            <div className="mb-3 text-[12px] text-red-700">
              {error}
              {serverErrors.length > 0 && (
                <ul className="mt-1 list-inside list-disc">
                  {serverErrors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <Btn
            variant="primary"
            disabled={busy || erreurs.length > 0 || (mode === "edit" && !modifie)}
            onClick={enregistrer}
            className="w-full justify-center"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {mode === "create" ? "Create draft" : "Save draft"}
          </Btn>
        </Card>
      </div>
    </div>
  );
}

function Choix({
  titre,
  vide,
  items,
  coches,
  onToggle,
}: {
  titre: string;
  vide: string;
  items: { key: string; label: string }[];
  coches: string[];
  onToggle: (key: string) => void;
}) {
  return (
    <fieldset className="mb-3">
      <legend className="mb-1.5 text-[12.5px] font-medium">{titre}</legend>
      {items.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">{vide}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {items.map((it) => {
            const on = coches.includes(it.key);
            return (
              <button
                key={it.key}
                type="button"
                aria-pressed={on}
                onClick={() => onToggle(it.key)}
                className={`rounded-full border px-2.5 py-1 text-[12px] ${
                  on ? "border-brand bg-brand-soft font-semibold text-brand-soft-foreground" : "border-border hover:bg-accent"
                }`}
              >
                {it.label}
              </button>
            );
          })}
        </div>
      )}
    </fieldset>
  );
}

/**
 * Étape 12 — les variables que le déclencheur fournit, à écrire dans le MODÈLE (`{{jeton}}`).
 * ⛔ Une variable SIGNALÉE s'imprimerait vide aujourd'hui : elle est montrée, barrée d'un avertissement,
 * jamais proposée comme si elle marchait.
 */
export function Variables({ variables, indisponibles }: { variables: VariableView[]; indisponibles: VariableView[] }) {
  return (
    <div className="mt-4 border-t border-border pt-3">
      <p className="text-[12.5px] font-medium">Variables this trigger provides</p>
      <p className="mb-2 text-[11.5px] text-muted-foreground">Write them in the step&apos;s template, in the builder.</p>
      <ul className="flex flex-col gap-1.5">
        {variables.map((x) => (
          <li key={x.name} className="text-[12px] leading-snug">
            {x.flagged ? (
              <>
                <Pill tone="amber">{x.label}</Pill> <span className="text-amber-800">{x.why}</span>
              </>
            ) : (
              <>
                <code className="rounded bg-accent px-1.5 py-0.5 text-[11.5px]">{`{{${x.token}}}`}</code>{" "}
                <span className="text-foreground/80">{x.label}</span>
                {x.hint && <span className="text-muted-foreground"> — {x.hint}</span>}
              </>
            )}
          </li>
        ))}
      </ul>
      {indisponibles.length > 0 && (
        <>
          <p className="mt-3 text-[12px] font-medium">Requested, not available anywhere yet</p>
          <ul className="mt-1 flex flex-col gap-1.5">
            {indisponibles.map((x) => (
              <li key={x.name} className="text-[12px] leading-snug">
                <Pill tone="amber">{x.label}</Pill> <span className="text-amber-800">{x.why}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
