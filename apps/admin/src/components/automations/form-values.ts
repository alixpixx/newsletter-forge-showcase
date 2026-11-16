import { TRIGGERS, type TriggerId } from "@nf/automations";

/**
 * Les VALEURS du formulaire d'automation — séparées du composant (`automation-form.tsx`, `"use client"`).
 *
 * ⛔ POURQUOI CE FICHIER EXISTE (24/09/2026). Les pages `/automations/new` et `/automations/[id]/edit`
 * sont des composants SERVEUR : elles calculent la valeur initiale avant de rendre le formulaire. Tant
 * que `defaultsFor` vivait dans le module `"use client"`, Next ne leur donnait qu'une RÉFÉRENCE client à
 * la place de la fonction, et l'appeler levait côté serveur — « Something went wrong » à l'ouverture de
 * « New automation » (constaté par Alix sur Copper Kettle, réf. 1765541213). Ni le build ni un import
 * direct en test ne le voient : seule la transformation RSC de Next fabrique la référence.
 *
 * ⛔ PAS DE `"use client"` ICI, et rien qui ne marche que dans le navigateur : ce module sert les deux
 * côtés. Le garde `src/app/client-imports.test.ts` refuse qu'un fichier serveur importe autre chose
 * qu'un composant depuis un module `"use client"`.
 */

export interface FormValue {
  name: string;
  trigger: TriggerId;
  purpose: string | null;
  filters: { optin_ids: string[]; languages: string[]; interest_ids: number[]; labels: string[] };
  settings: Record<string, boolean | number>;
  steps: { delay_hours: number; template_version_id: string | null }[];
  daily_cap: number;
  window_start_hour: number;
  window_end_hour: number;
  timezone: string;
}

/** Les valeurs par défaut d'un déclencheur : ses délais, ses réglages, sa finalité. */
export function defaultsFor(trigger: TriggerId, base: Pick<FormValue, "name" | "timezone">): FormValue {
  const spec = TRIGGERS[trigger];
  const settings: Record<string, boolean | number> = {};
  for (const [k, s] of Object.entries(spec.settings)) if (!s.readOnly) settings[k] = s.default;
  return {
    name: base.name,
    trigger,
    purpose: spec.defaultPurpose,
    filters: { optin_ids: [], languages: [], interest_ids: [], labels: [] },
    settings,
    steps: spec.steps.defaultDelaysHours.map((d) => ({ delay_hours: d, template_version_id: null })),
    daily_cap: 50,
    window_start_hour: 8,
    window_end_hour: 20,
    timezone: base.timezone,
  };
}

/** Le corps envoyé à la route : les listes vides disparaissent (aucun filtre = toute la marque). */
export function bodyOf(v: FormValue) {
  const filters: Record<string, unknown> = {};
  if (v.filters.optin_ids.length) filters.optin_ids = v.filters.optin_ids;
  if (v.filters.languages.length) filters.languages = v.filters.languages;
  if (v.filters.interest_ids.length) filters.interest_ids = v.filters.interest_ids;
  if (v.filters.labels.length) filters.labels = v.filters.labels;
  const spec = TRIGGERS[v.trigger];
  return {
    name: v.name,
    trigger: v.trigger,
    purpose: spec.policy === "marketing" ? v.purpose : null,
    filters,
    settings: v.settings,
    steps: v.steps.map((s) => (spec.steps.requiresTemplate ? s : { delay_hours: s.delay_hours })),
    daily_cap: v.daily_cap,
    window_start_hour: v.window_start_hour,
    window_end_hour: v.window_end_hour,
    timezone: v.timezone,
  };
}
