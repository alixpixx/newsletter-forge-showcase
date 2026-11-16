/**
 * AUTOMATIONS — la logique PURE des écrans (vague 3 du plan `tasks/plan-automations.md`, étapes 10,
 * 12 et 13). Aucun accès base ici : ce que ces fonctions décident se mesure sans cookie ni réseau.
 *
 * ⛔ L'ADMIN N'EXPOSE QUE LE CATALOGUE (`@nf/automations`). Les déclencheurs, leurs réglages, leurs
 * variables et la validation viennent de là, pas d'une copie : le worker exécute avec la même
 * `validateAutomation` que l'écran applique, et une règle recopiée ici finirait par diverger.
 *
 * ⛔ AUCUN CHIFFRE ÉCRIT EN DUR. Une section « Automations » a déjà été retirée le 31/08 (`93fe012`)
 * parce qu'elle affichait des automatisations et des compteurs inventés. Ce fichier ne porte que des
 * textes et des règles ; les nombres des écrans sont lus en base (`lib/data/automations.ts`).
 */
import {
  AUTOMATION_STATUSES,
  TRIGGERS,
  TRIGGER_IDS,
  VARIABLES,
  canTransition,
  type AutomationRecord,
  type AutomationStatus,
  type TriggerId,
  type TriggerSpec,
  type Validation,
  type VariableName,
  type VariableSpec,
  type VariableStatus,
} from "@nf/automations";
import type { Tone } from "@/components/ui";

/* ------------------------------------------------------------------------------------------------
 * Statuts
 * ---------------------------------------------------------------------------------------------- */

export const STATUS_LABEL: Readonly<Record<AutomationStatus, string>> = {
  draft: "Draft",
  simulation: "Simulation",
  live: "Live",
  paused: "Paused",
};

export const STATUS_TONE: Readonly<Record<AutomationStatus, Tone>> = {
  draft: "grey",
  simulation: "violet",
  live: "green",
  paused: "amber",
};

/** Ce que chaque statut FAIT, en une phrase — affiché sous la pastille. */
export const STATUS_MEANING: Readonly<Record<AutomationStatus, string>> = {
  draft: "Does nothing. The only state in which it can be edited.",
  simulation: "Computes who would receive what at each worker pass and logs it. Sends nothing.",
  live: "Queues real emails at each worker pass, within the daily cap and the send window.",
  paused: "Stopped. Resuming goes back to live without a new simulation.",
};

export function isAutomationStatus(v: unknown): v is AutomationStatus {
  return typeof v === "string" && (AUTOMATION_STATUSES as readonly string[]).includes(v);
}

/* ------------------------------------------------------------------------------------------------
 * La carte « System » — les 15 lignes du tableau d'Alix, dans SON ordre (24/09/2026, feature 3)
 * ---------------------------------------------------------------------------------------------- */

/**
 * ⭐ ALIX (24/09) : « je veux pas séparer lifecycle email de system, je veux tout dans système […] et que
 * tout soit éditable directement depuis la page automations ». Une seule liste, trois sortes de lignes :
 *  - `lifecycle` : un e-mail envoyé sur-le-champ par l'app publique (confirmation, bienvenue, accusé).
 *    Il se règle sur sa page (`/automations/system/[kind]`) : modèle, et on/off sauf la confirmation ;
 *  - `engine` : un déclencheur du moteur (0082). La ligne montre les automations de ce déclencheur, ou
 *    propose d'en créer une. Nom et description viennent du CATALOGUE, jamais d'une copie ;
 *  - `rule` : une règle toujours active (journal de consentement, rebonds, plaintes) — dite, pas pilotée.
 *
 * ⛔ AUCUN COMPTEUR ICI : les nombres sont lus en base par la page, et « non lu » n'est jamais « 0 ».
 */
export const LIFECYCLE_EDITABLE = ["confirmation", "welcome", "unsubscribe_ack"] as const;
export type LifecycleEditable = (typeof LIFECYCLE_EDITABLE)[number];

export function isLifecycleEditable(v: unknown): v is LifecycleEditable {
  return typeof v === "string" && (LIFECYCLE_EDITABLE as readonly string[]).includes(v);
}

/** ⛔ La confirmation ne se coupe jamais : sans elle, personne ne confirme, donc personne ne s'inscrit. */
export function canTurnOff(kind: LifecycleEditable): kind is "welcome" | "unsubscribe_ack" {
  return kind !== "confirmation";
}

export const CONFIRMATION_LOCKED_WHY =
  "Always on: without it nobody can confirm a signup, so nobody is subscribed and the double opt-in is not proven.";

export function adresseSysteme(kind: LifecycleEditable): string {
  return `/automations/system/${kind}`;
}

export type SystemRow =
  | { sheetRow: number; type: "lifecycle"; kind: LifecycleEditable; name: string; does: string; note: string | null }
  | { sheetRow: number; type: "engine"; trigger: TriggerId; note: string | null }
  | {
      sheetRow: number;
      type: "rule";
      name: string;
      does: string;
      /** Où la regarder. `href: null` = rien à ouvrir dans cet admin. */
      where: { label: string; href: string | null };
      note: string | null;
    };

/**
 * ⚠️ Le seuil des rebonds mous vient du catalogue (`soft_bounce_rule`, lecture seule), lui-même
 * aligné sur `SEUIL_REBONDS_MOUS` du webhook — pas d'un 4 recopié.
 */
const SEUIL_MOUS = TRIGGERS.soft_bounce_rule.settings.threshold?.default;

export const SYSTEM_ROWS: readonly SystemRow[] = [
  {
    sheetRow: 1,
    type: "lifecycle",
    kind: "confirmation",
    name: "Confirmation (double opt-in)",
    does: "Sent right after a signup, with the link that confirms it. The subscription stays pending until that link is used.",
    note: null,
  },
  { sheetRow: 2, type: "engine", trigger: "confirmation_reminder", note: null },
  {
    sheetRow: 3,
    type: "lifecycle",
    kind: "welcome",
    name: "Welcome",
    does: "Sent once, when the subscription is confirmed.",
    note: null,
  },
  { sheetRow: 4, type: "engine", trigger: "preferences_updated", note: null },
  {
    sheetRow: 5,
    type: "lifecycle",
    kind: "unsubscribe_ack",
    name: "Unsubscribe receipt",
    does: "Sent after an unsubscribe on our unsubscribe page or preference center. Never after the one-click unsubscribe of mail clients: they confirm it themselves.",
    note: "The one-click header itself is a worker setting on the server, not in this admin.",
  },
  {
    sheetRow: 6,
    type: "engine",
    trigger: "welcome_back",
    note: "Signing up again already sends a new confirmation (see Confirmation). Welcome back is an optional extra email, once the person is back.",
  },
  { sheetRow: 7, type: "engine", trigger: "reengagement", note: null },
  { sheetRow: 8, type: "engine", trigger: "sunset", note: null },
  { sheetRow: 9, type: "engine", trigger: "anniversary", note: null },
  {
    sheetRow: 10,
    type: "rule",
    name: "Consent log",
    does: "Every signup request, confirmation, grant, withdrawal and unsubscribe is recorded silently, with its time, method and consent text version. No email.",
    where: { label: "Compliance", href: "/compliance" },
    note: "Always on: it is the proof of consent.",
  },
  { sheetRow: 11, type: "engine", trigger: "consent_renewal", note: null },
  {
    sheetRow: 12,
    type: "rule",
    name: "Hard bounce",
    does: "A permanent delivery failure reported by Mailgun suppresses the address for this brand.",
    where: { label: "Deliverability", href: "/deliverability" },
    note: "Always on: sending again to a dead address hurts every brand's delivery. Deliverability is visible to super admins only.",
  },
  {
    sheetRow: 13,
    type: "rule",
    name: "Soft bounces",
    does: `${SEUIL_MOUS} temporary failures since the last successful delivery suppress the address for this brand. A delivery resets the count.`,
    where: { label: "Deliverability", href: "/deliverability" },
    note: "Counted by the Mailgun webhook; the threshold is fixed in code.",
  },
  {
    sheetRow: 14,
    type: "rule",
    name: "Spam complaint",
    does: "A complaint reported by Mailgun suppresses the address on every brand.",
    where: { label: "Deliverability", href: "/deliverability" },
    note: "Always on: a complaint is a legal stop. Deliverability is visible to super admins only.",
  },
  { sheetRow: 15, type: "engine", trigger: "optin_promo", note: null },
];

export function systemRowName(r: SystemRow): string {
  return r.type === "engine" ? TRIGGERS[r.trigger].label : r.name;
}

export function systemRowDoes(r: SystemRow): string {
  return r.type === "engine" ? TRIGGERS[r.trigger].description : r.does;
}

/**
 * Les automations rangées sous la ligne de leur déclencheur, dans l'ordre reçu.
 *
 * ⛔ AUCUNE N'EST PERDUE. Une automation dont le déclencheur n'a pas de ligne (un déclencheur ajouté au
 * catalogue sans ligne, une ligne ancienne) part dans `autres`, que l'écran affiche : une automation
 * live qu'aucune ligne ne montre enverrait sans que personne ne la voie.
 */
export function rangerParDeclencheur<T extends { trigger: string }>(
  automations: readonly T[],
): { parDeclencheur: Map<string, T[]>; autres: T[] } {
  const lignes = new Set(SYSTEM_ROWS.flatMap((r) => (r.type === "engine" ? [r.trigger as string] : [])));
  const parDeclencheur = new Map<string, T[]>();
  const autres: T[] = [];
  for (const a of automations) {
    if (!lignes.has(a.trigger)) {
      autres.push(a);
      continue;
    }
    const l = parDeclencheur.get(a.trigger);
    if (l) l.push(a);
    else parDeclencheur.set(a.trigger, [a]);
  }
  return { parDeclencheur, autres };
}

/* ------------------------------------------------------------------------------------------------
 * Déclencheurs proposés à la création
 * ---------------------------------------------------------------------------------------------- */

/**
 * ⛔ Seuls les déclencheurs que le MOTEUR exécute se créent. La règle système (rebonds mous) est
 * listée plus haut, en lecture seule : une automation « soft bounce » créée ici ne pourrait ni
 * simuler ni s'armer (`validateAutomation` le refuse), elle ne serait qu'une ligne qui ne fait rien.
 */
export const CREATABLE_TRIGGERS: readonly TriggerId[] = TRIGGER_IDS.filter((t) => TRIGGERS[t].engine);

export function isCreatableTrigger(v: unknown): v is TriggerId {
  return typeof v === "string" && (CREATABLE_TRIGGERS as readonly string[]).includes(v);
}

/**
 * Le déclencheur de départ du formulaire de création : celui de `?trigger=` (bouton « Set up » d'une
 * ligne de la carte System) s'il est créable, sinon le premier du catalogue. ⛔ Une valeur inconnue ou
 * non créable (`soft_bounce_rule`) ne passe jamais : elle retombe sur le défaut, sans erreur.
 */
export function declencheurInitial(param: unknown): TriggerId {
  const v = Array.isArray(param) ? param[0] : param;
  return isCreatableTrigger(v) ? v : (CREATABLE_TRIGGERS[0] ?? "confirmation_reminder");
}

/**
 * Pourquoi le déclencheur ne peut plus changer (`null` = il peut). Même règle que la route (409) :
 * il ne change que si l'automation n'a JAMAIS sélectionné personne, et « non lu » n'est pas « zéro ».
 */
export function raisonDeclencheurFige(selections: number | null): string | null {
  if (selections === null) return "The trigger cannot change right now: this automation's history could not be read.";
  if (selections > 0) {
    return "The trigger cannot change: this automation has already selected people (simulated or real). Create a new automation instead.";
  }
  return null;
}

export function triggerLabel(t: string): string {
  return (TRIGGERS as Record<string, TriggerSpec | undefined>)[t]?.label ?? t;
}

/** La politique d'envoi, telle que la porte du worker l'applique. */
export function policyText(spec: TriggerSpec): string {
  switch (spec.policy) {
    case "marketing":
      return "Marketing: only to an active subscription that granted the purpose below, with a one-click unsubscribe header.";
    case "transactional":
      return "Transactional, strictly: only for this trigger, without purpose, tracking or promotion.";
    case "silent":
      return "Silent: sends nothing. It marks the subscription as sunsetted (reversible).";
    case "system":
      return "System rule: enforced elsewhere, nothing to switch on here.";
  }
}

/** `0` → « immediately », multiples de 24 h en jours, le reste en heures. */
export function formatDelay(hours: number): string {
  if (hours === 0) return "immediately";
  if (hours % 24 === 0) {
    const d = hours / 24;
    return `${d} day${d === 1 ? "" : "s"}`;
  }
  return `${hours} h`;
}

/* ------------------------------------------------------------------------------------------------
 * Variables (étape 12)
 * ---------------------------------------------------------------------------------------------- */

export interface VariableView {
  name: VariableName;
  label: string;
  /** Le jeton à écrire dans le modèle (`{{token}}`), quand il existe. */
  token: string | null;
  status: VariableStatus;
  /**
   * ⛔ SIGNALÉE = l'auteur ne peut pas s'en servir telle quelle aujourd'hui. Un jeton hors registre
   * est RETIRÉ en silence au rendu (il s'imprime vide) : sans ce signal, l'e-mail partirait avec un
   * trou là où l'auteur croyait voir une valeur.
   */
  flagged: boolean;
  /** Pourquoi elle est signalée. */
  why: string | null;
  /** Conseil d'usage pour une variable servie (ex. prénom souvent vide). */
  hint: string | null;
}

export const NEEDS_REGISTRY_WHY =
  "Not usable in a template yet: it is stored with each send, but the template engine does not know this variable, so it would print empty.";

function viewOf(name: VariableName): VariableView {
  const v: VariableSpec = VARIABLES[name];
  const flagged = v.status !== "ready";
  const why =
    v.status === "needs_registry"
      ? NEEDS_REGISTRY_WHY
      : v.status === "no_data"
        ? `No data today.${v.note ? ` ${v.note}` : ""}`
        : null;
  return {
    name,
    label: v.label,
    token: v.token ?? null,
    status: v.status,
    flagged,
    why,
    hint: v.status === "ready" ? (v.note ?? null) : null,
  };
}

/** Les variables que ce déclencheur fournit, dans l'ordre du catalogue — signalées quand il le faut. */
export function variablesFor(trigger: TriggerId): VariableView[] {
  return TRIGGERS[trigger].variables.map(viewOf);
}

/**
 * Les variables DEMANDÉES (tableau d'Alix) qu'aucune donnée ne sert, et que CE déclencheur ne fournit
 * pas non plus — `club_preference`, `resubscribe_link`… L'éditeur les nomme pour qu'on ne les
 * cherche pas : elles n'existent nulle part aujourd'hui.
 */
export function unavailableVariables(trigger: TriggerId): VariableView[] {
  const fournies = new Set<string>(TRIGGERS[trigger].variables);
  return (Object.keys(VARIABLES) as VariableName[])
    .filter((n) => VARIABLES[n].status === "no_data" && !fournies.has(n))
    .map(viewOf);
}

/* ------------------------------------------------------------------------------------------------
 * Corps d'un formulaire → ligne `automation`
 * ---------------------------------------------------------------------------------------------- */

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Le corps d'une création/modification, réduit aux colonnes éditables. ⛔ Rien d'autre ne passe :
 * ni `status`, ni `event_cursor`, ni `armed_by` — un corps qui les porterait n'arme rien.
 * La validation du CONTENU est celle du catalogue (`validateAutomation`), appelée par la route.
 */
export function recordFromBody(body: unknown, assetId: string, status: AutomationStatus): AutomationRecord | null {
  if (!isObject(body)) return null;
  const purpose = body.purpose === "" || body.purpose === undefined ? null : (body.purpose as string | null);
  return {
    asset_id: assetId,
    name: typeof body.name === "string" ? body.name : "",
    trigger: typeof body.trigger === "string" ? body.trigger : "",
    filters: body.filters ?? {},
    settings: body.settings ?? {},
    steps: body.steps ?? [],
    status,
    purpose,
    daily_cap: body.daily_cap as number,
    window_start_hour: body.window_start_hour as number,
    window_end_hour: body.window_end_hour as number,
    timezone: typeof body.timezone === "string" ? body.timezone : "",
  };
}

/** Les colonnes écrites, depuis la version NORMALISÉE par la validation (jamais le corps brut). */
export function columnsOf(v: Extract<Validation, { ok: true }>["automation"]) {
  return {
    name: v.name,
    trigger: v.trigger,
    filters: v.filters,
    settings: v.settings,
    steps: v.steps,
    purpose: v.purpose,
    daily_cap: v.dailyCap,
    window_start_hour: v.windowStartHour,
    window_end_hour: v.windowEndHour,
    timezone: v.timezone,
  };
}

/* ------------------------------------------------------------------------------------------------
 * Armement (étape 13)
 * ---------------------------------------------------------------------------------------------- */

/**
 * La simulation a-t-elle TOURNÉ depuis qu'on l'a lancée ?
 *
 * ⛔ « Depuis qu'on l'a lancée » = depuis `status_changed_at` (0082), posé par l'admin à chaque
 * transition. Une trace simulée d'AVANT le dernier retour au brouillon a été calculée sur d'autres
 * réglages : elle ne prouve rien sur ceux-ci. Deux preuves acceptées : le moteur est passé
 * (`last_run_at`, posé à chaque passe, y compris celle qui initialise le curseur sans rien
 * sélectionner), ou il a écrit au moins une trace simulée.
 */
export function simulationRan(
  a: { status: AutomationStatus; lastRunAt: string | null; statusChangedAt: string | null },
  simulatedSince: number,
): boolean {
  if (a.status !== "simulation") return false;
  if (simulatedSince > 0) return true;
  const depuis = a.statusChangedAt ? Date.parse(a.statusChangedAt) : Number.NaN;
  const passe = a.lastRunAt ? Date.parse(a.lastRunAt) : Number.NaN;
  return Number.isFinite(depuis) && Number.isFinite(passe) && passe >= depuis;
}

export interface TransitionInput {
  from: AutomationStatus;
  to: AutomationStatus;
  name: string;
  isSuperAdmin: boolean;
  /** Le nom tapé dans la confirmation (exigé pour passer `live`). */
  confirmName: string | null;
  simulationRan: boolean;
  /** `validateAutomation` de la ligne, AVEC le statut visé. */
  validation: Validation;
}

export type TransitionDecision =
  | { ok: true }
  | { ok: false; status: 403 | 409 | 422; error: string; errors?: string[] };

/**
 * La décision d'une transition, dans l'ordre où elle se prend.
 *
 * ⛔ 1. PASSER `live` = ENVOYER POUR DE VRAI : réservé `super_admin`, et vérifié AVANT tout le reste
 *    — un membre qui essaie n'apprend rien de l'état de l'automation, et rien n'est écrit.
 * ⛔ 2. La table des transitions est celle du catalogue (`canTransition`) : `draft → live` n'existe pas.
 * ⛔ 3. `simulation → live` exige que la simulation ait tourné (voir `simulationRan`).
 * ⛔ 4. `live` exige le nom tapé : un double clic ou un bouton pris pour un autre n'arme rien.
 * ⛔ 5. Simuler ou armer une automation invalide est refusé — la même validation que le worker, qui
 *    l'écarterait de toute façon ; mieux vaut le dire au clic que la voir « armée » et muette.
 */
export function decideTransition(i: TransitionInput): TransitionDecision {
  if (i.to === "live" && !i.isSuperAdmin) {
    // ⛔ Pas le mot « arm » : il a disparu de l'écran le 22/09/2026 (décision d'Alix), et ce message s'y affiche.
    return { ok: false, status: 403, error: "only a super admin can switch an automation to live: live sends real emails" };
  }
  if (i.from === i.to) {
    return { ok: false, status: 409, error: `this automation is already ${STATUS_LABEL[i.to].toLowerCase()}` };
  }
  if (!canTransition(i.from, i.to)) {
    return {
      ok: false,
      status: 409,
      error: `an automation cannot go from ${STATUS_LABEL[i.from].toLowerCase()} to ${STATUS_LABEL[i.to].toLowerCase()}`,
    };
  }
  if (i.from === "simulation" && i.to === "live" && !i.simulationRan) {
    return {
      ok: false,
      status: 409,
      error: "the simulation has not run yet: wait for the worker's next planning pass, check the simulation log, then go live",
    };
  }
  if (i.to === "live" && (i.confirmName ?? "").trim() !== i.name.trim()) {
    return { ok: false, status: 422, error: "type the automation's exact name to confirm" };
  }
  if ((i.to === "simulation" || i.to === "live") && !i.validation.ok) {
    return { ok: false, status: 422, error: "this automation is not valid", errors: i.validation.errors };
  }
  return { ok: true };
}

/** L'action d'audit d'une transition — `automation-armed` et `automation-resumed` sont les deux qui envoient. */
export function auditAction(from: AutomationStatus, to: AutomationStatus): string {
  if (to === "live") return from === "paused" ? "automation-resumed" : "automation-armed";
  if (to === "simulation") return "automation-simulation-started";
  if (to === "paused") return "automation-paused";
  return "automation-back-to-draft";
}
