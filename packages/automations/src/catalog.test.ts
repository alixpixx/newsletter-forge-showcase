/**
 * LE CATALOGUE DES DÉCLENCHEURS — qui est éligible, qui ne l'est pas, et la preuve que chaque garde MORD.
 *
 * ⛔ CE QUE CE BANC NE PROUVE PAS. La sélection réelle est en SQL (`automation_due`, 0082) et n'a
 * jamais tourné sur une base : aucune base jetable n'existe pour ce dépôt, et la base de production
 * envoie de vrais e-mails. Ce banc prouve la SPÉCIFICATION que 0082 recopie, garde pour garde.
 *
 * ⭐ LE MUTANT DE CHAQUE GARDE EST DANS LE BANC. Pour chaque déclencheur, un témoin éligible ; pour
 * chaque garde, une violation du témoin qui ne casse QU'ELLE. Le banc vérifie deux choses :
 *   1. la violation est refusée, et la raison est bien CETTE garde (pas une voisine) ;
 *   2. la même violation, évaluée SANS cette garde (le mutant), redevient éligible.
 * Le 2 est ce qui distingue une garde qui protège d'une garde décorative : si une voisine refusait
 * aussi le cas, retirer la garde ne changerait rien, et personne ne le verrait. Une garde ajoutée
 * sans violation fait échouer le banc (« garde sans témoin »).
 */
import { describe, expect, test } from "bun:test";
import {
  TRIGGERS,
  TRIGGER_IDS,
  TX_TRIGGER_STATUS,
  VARIABLES,
  DAY_MS,
  HOUR_MS,
  anniversaryOf,
  addMonthsUtc,
  evaluate,
  evaluateWith,
  utcDay,
  type EvalContext,
  type SubscriptionFacts,
  type TriggerId,
} from "./catalog";

const NOW = new Date("2026-09-24T12:00:00Z");
const AUTO = "11111111-1111-4111-8111-111111111111";
const OPT = "22222222-2222-4222-8222-222222222222";
const TV = "33333333-3333-4333-8333-333333333333";

const avant = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

function facts(over: Partial<SubscriptionFacts> = {}): SubscriptionFacts {
  return {
    status: "active",
    isDemo: false,
    suppressed: false,
    sunsetAt: null,
    createdAt: avant(400 * DAY_MS),
    consentAt: avant(400 * DAY_MS),
    lastClickAt: null,
    lastResponseAt: null,
    trackingConsent: true,
    optinId: OPT,
    language: "pt-BR",
    interestIds: [3],
    labels: [],
    grantedPurposes: { content: true, offers: true },
    regime: "lgpd",
    events: [],
    confirmationSent: true,
    tokenConfirmed: false,
    sends: [],
    ...over,
  };
}

function ctx(over: Partial<EvalContext> = {}): EvalContext {
  return {
    now: NOW,
    automationId: AUTO,
    step: 1,
    steps: [{ delay_hours: 1, template_version_id: TV }],
    settings: {},
    filters: {},
    purpose: "content",
    eventCursor: 0,
    simulated: false,
    ...over,
  };
}

interface Cas {
  facts: SubscriptionFacts;
  ctx: EvalContext;
}
type Violation = (c: Cas) => Cas;
const avecFaits = (c: Cas, f: Partial<SubscriptionFacts>): Cas => ({ ...c, facts: { ...c.facts, ...f } });
const avecCtx = (c: Cas, x: Partial<EvalContext>): Cas => ({ ...c, ctx: { ...c.ctx, ...x } });
const envoi = (step: number, periodKey: string, over: Partial<SubscriptionFacts["sends"][number]> = {}) => ({
  automationId: AUTO,
  trigger: "reengagement" as TriggerId,
  step,
  periodKey,
  simulated: false,
  at: avant(HOUR_MS),
  ...over,
});

/** Les gardes communes : une seule façon de casser chacune, partagée par tous les déclencheurs. */
const COMMUNES: Record<string, Violation> = {
  active: (c) => avecFaits(c, { status: "unsubscribed" }),
  not_suppressed: (c) => avecFaits(c, { suppressed: true }),
  not_demo: (c) => avecFaits(c, { isDemo: true }),
  not_sunset: (c) => avecFaits(c, { sunsetAt: avant(DAY_MS) }),
  purpose_granted: (c) => avecFaits(c, { grantedPurposes: {} }),
  filters_match: (c) => avecCtx(c, { filters: { ...c.ctx.filters, languages: ["es"] } }),
};
const PAS_DE_SUIVI: Violation = (c) => avecFaits(c, { trackingConsent: false });

interface Scenario {
  temoin: Cas;
  violations: Record<string, Violation>;
}

const ev = (id: number, type: string, at: string, method: string | null = "widget_doi", purpose: string | null = null) => ({
  id,
  type,
  method,
  purpose,
  at,
});

const SCENARIOS: Record<Exclude<TriggerId, "soft_bounce_rule">, Scenario> = {
  confirmation_reminder: {
    temoin: {
      facts: facts({ status: "pending", events: [ev(10, "optin_request", avant(30 * HOUR_MS), "capture_bridge_doi")] }),
      ctx: ctx({ purpose: null, steps: [{ delay_hours: 24, template_version_id: TV }, { delay_hours: 72, template_version_id: TV }] }),
    },
    violations: {
      pending: (c) => avecFaits(c, { status: "active" }),
      not_suppressed: COMMUNES.not_suppressed!,
      not_demo: COMMUNES.not_demo!,
      filters_match: COMMUNES.filters_match!,
      confirmation_sent: (c) => avecFaits(c, { confirmationSent: false }),
      not_confirmed: (c) => avecFaits(c, { tokenConfirmed: true }),
      within_7_days: (c) => avecFaits(c, { events: [ev(10, "optin_request", avant(8 * DAY_MS))] }),
      delay_reached: (c) => avecFaits(c, { events: [ev(10, "optin_request", avant(10 * HOUR_MS))] }),
      not_already_sent: (c) => avecFaits(c, { sends: [envoi(1, "10", { trigger: "confirmation_reminder" })] }),
      previous_step_done: (c) =>
        avecCtx(avecFaits(c, { events: [ev(10, "optin_request", avant(80 * HOUR_MS))] }), { step: 2 }),
    },
  },
  preferences_updated: {
    temoin: {
      facts: facts({ events: [ev(20, "granted", avant(2 * HOUR_MS), "preference_center", "offers")] }),
      ctx: ctx({ eventCursor: 5 }),
    },
    violations: {
      ...COMMUNES,
      after_cursor: (c) => avecCtx(c, { eventCursor: 20 }),
      within_horizon: (c) => avecFaits(c, { events: [ev(20, "granted", avant(8 * DAY_MS), "preference_center", "offers")] }),
      delay_reached: (c) => avecFaits(c, { events: [ev(20, "granted", avant(10 * 60_000), "preference_center", "offers")] }),
      not_already_sent: (c) => avecFaits(c, { sends: [envoi(1, "20", { trigger: "preferences_updated" })] }),
    },
  },
  welcome_back: {
    temoin: {
      facts: facts({
        events: [
          ev(1, "optin_request", avant(300 * DAY_MS)),
          ev(2, "optin_confirm", avant(299 * DAY_MS)),
          ev(3, "unsubscribe", avant(100 * DAY_MS), "list_unsub"),
          ev(29, "optin_request", avant(3 * HOUR_MS)),
          ev(30, "optin_confirm", avant(2 * HOUR_MS)),
        ],
      }),
      ctx: ctx({ eventCursor: 10 }),
    },
    violations: {
      ...COMMUNES,
      returning: (c) => avecFaits(c, { events: c.facts.events.filter((e) => e.type !== "unsubscribe") }),
      after_cursor: (c) => avecCtx(c, { eventCursor: 30 }),
      within_horizon: (c) =>
        avecFaits(c, { events: c.facts.events.map((e) => (e.id === 30 ? { ...e, at: avant(8 * DAY_MS) } : e)) }),
      delay_reached: (c) =>
        avecFaits(c, { events: c.facts.events.map((e) => (e.id === 30 ? { ...e, at: avant(10 * 60_000) } : e)) }),
      not_already_sent: (c) => avecFaits(c, { sends: [envoi(1, "30", { trigger: "welcome_back" })] }),
      previous_step_done: (c) =>
        avecCtx(
          avecFaits(c, { events: c.facts.events.map((e) => (e.id === 30 ? { ...e, at: avant(30 * HOUR_MS) } : e)) }),
          { step: 2, steps: [{ delay_hours: 1, template_version_id: TV }, { delay_hours: 24, template_version_id: TV }] },
        ),
    },
  },
  reengagement: {
    temoin: {
      facts: facts({ consentAt: avant(100 * DAY_MS), createdAt: avant(100 * DAY_MS), lastClickAt: avant(70 * DAY_MS) }),
      ctx: ctx({ steps: [{ delay_hours: 60 * 24, template_version_id: TV }, { delay_hours: 120 * 24, template_version_id: TV }] }),
    },
    violations: {
      ...COMMUNES,
      tracking_consented: PAS_DE_SUIVI,
      delay_reached: (c) => avecFaits(c, { lastClickAt: avant(10 * DAY_MS) }),
      not_already_sent: (c) => avecFaits(c, { sends: [envoi(1, utcDay(new Date(avant(70 * DAY_MS))))] }),
      previous_step_done: (c) =>
        avecCtx(avecFaits(c, { consentAt: avant(130 * DAY_MS), createdAt: avant(130 * DAY_MS), lastClickAt: null }), {
          step: 2,
        }),
    },
  },
  sunset: {
    temoin: {
      facts: facts({
        consentAt: avant(300 * DAY_MS),
        lastClickAt: avant(200 * DAY_MS),
        sends: [envoi(1, "x", { automationId: "autre-reengagement", at: avant(30 * DAY_MS) })],
      }),
      ctx: ctx({ purpose: null, steps: [{ delay_hours: 180 * 24 }] }),
    },
    violations: {
      active: COMMUNES.active!,
      not_suppressed: COMMUNES.not_suppressed!,
      not_demo: COMMUNES.not_demo!,
      not_sunset: COMMUNES.not_sunset!,
      filters_match: COMMUNES.filters_match!,
      tracking_consented: PAS_DE_SUIVI,
      delay_reached: (c) => avecFaits(c, { lastClickAt: avant(100 * DAY_MS) }),
      reengaged_without_answer: (c) => avecFaits(c, { sends: [] }),
      not_already_sent: (c) =>
        avecFaits(c, {
          sends: [
            ...c.facts.sends,
            envoi(1, utcDay(new Date(avant(200 * DAY_MS))), { trigger: "sunset" }),
          ],
        }),
    },
  },
  anniversary: {
    temoin: {
      facts: facts({ createdAt: "2025-09-23T15:00:00Z" }),
      ctx: ctx({ steps: [{ delay_hours: 0, template_version_id: TV }] }),
    },
    violations: {
      ...COMMUNES,
      one_year_old: (c) => avecFaits(c, { createdAt: "2026-09-23T10:00:00Z" }),
      delay_reached: (c) => avecCtx(c, { steps: [{ delay_hours: 48, template_version_id: TV }] }),
      within_catchup: (c) => avecFaits(c, { createdAt: "2025-09-10T15:00:00Z" }),
      not_already_sent: (c) => avecFaits(c, { sends: [envoi(1, "2026", { trigger: "anniversary" })] }),
    },
  },
  consent_renewal: {
    temoin: {
      facts: facts({ consentAt: "2024-09-01T00:00:00Z" }),
      ctx: ctx({ purpose: null, steps: [{ delay_hours: 0, template_version_id: TV }] }),
    },
    violations: {
      active: COMMUNES.active!,
      not_suppressed: COMMUNES.not_suppressed!,
      not_demo: COMMUNES.not_demo!,
      not_sunset: COMMUNES.not_sunset!,
      filters_match: COMMUNES.filters_match!,
      delay_reached: (c) => avecFaits(c, { consentAt: "2024-10-01T00:00:00Z" }),
      not_already_sent: (c) => avecFaits(c, { sends: [envoi(1, "2024-09-01", { trigger: "consent_renewal" })] }),
    },
  },
  optin_promo: {
    temoin: {
      facts: facts({ events: [ev(40, "optin_confirm", avant(2 * HOUR_MS))] }),
      ctx: ctx({ purpose: "offers", filters: { optin_ids: [OPT] }, eventCursor: 10 }),
    },
    violations: {
      ...COMMUNES,
      purpose_granted: (c) => avecFaits(c, { grantedPurposes: { content: true, offers: false } }),
      optin_matches: (c) => avecCtx(c, { filters: {} }),
      after_cursor: (c) => avecCtx(c, { eventCursor: 40 }),
      within_horizon: (c) => avecFaits(c, { events: [ev(40, "optin_confirm", avant(8 * DAY_MS))] }),
      delay_reached: (c) => avecFaits(c, { events: [ev(40, "optin_confirm", avant(10 * 60_000))] }),
      not_already_sent: (c) => avecFaits(c, { sends: [envoi(1, OPT, { trigger: "optin_promo" })] }),
      previous_step_done: (c) =>
        avecCtx(avecFaits(c, { events: [ev(40, "optin_confirm", avant(30 * HOUR_MS))] }), {
          step: 2,
          steps: [{ delay_hours: 1, template_version_id: TV }, { delay_hours: 24, template_version_id: TV }],
        }),
    },
  },
};

for (const [id, sc] of Object.entries(SCENARIOS) as [Exclude<TriggerId, "soft_bounce_rule">, Scenario][]) {
  const spec = TRIGGERS[id];
  describe(`${id} (ligne ${spec.sheetRow}) — ${spec.policy}`, () => {
    test("TÉMOIN — le cas nominal est éligible", () => {
      const r = evaluate(id, sc.temoin.facts, sc.temoin.ctx);
      expect(r).toMatchObject({ eligible: true });
    });

    for (const g of spec.guards) {
      test(`garde « ${g.id} » : la violation est refusée PAR ELLE, et son mutant la laisserait passer`, () => {
        const casser = sc.violations[g.id];
        // Une garde sans violation écrite n'est pas prouvée : le banc refuse de s'en contenter.
        expect(casser === undefined ? `garde sans témoin : ${g.id}` : "ok").toBe("ok");
        if (!casser) return;
        const cas = casser(sc.temoin);
        expect(evaluate(id, cas.facts, cas.ctx)).toEqual({ eligible: false, reason: g.id });
        const mutant = spec.guards.filter((x) => x !== g);
        expect(evaluateWith(spec, mutant, cas.facts, cas.ctx)).toMatchObject({ eligible: true });
      });
    }

    test("aucune violation écrite pour une garde qui n'existe pas (le banc suit le catalogue)", () => {
      const gardes = new Set(spec.guards.map((g) => g.id));
      expect(Object.keys(sc.violations).filter((k) => !gardes.has(k))).toEqual([]);
    });
  });
}

describe("optin_promo par LABEL (0095) — la série Libertadores", () => {
  const LIB = "libertadores-2026";
  const confirme = [ev(40, "optin_confirm", avant(2 * HOUR_MS))];
  const parLabel = (f: Partial<SubscriptionFacts> = {}, filtres: EvalContext["filters"] = { labels: [LIB] }) =>
    evaluate("optin_promo", facts({ optinId: null, labels: [LIB], events: confirme, ...f }), ctx({ purpose: "content", filters: filtres, eventCursor: 10 }));

  test("un label seul suffit, même sans opt-in : la période est '' (comme coalesce(optin_id, '') en SQL)", () => {
    expect(parLabel()).toMatchObject({ eligible: true, anchor: { periodKey: "" } });
  });

  test("le label est normalisé comme en SQL (lower(btrim))", () => {
    expect(parLabel({}, { labels: [" Libertadores-2026 "] })).toMatchObject({ eligible: true });
  });

  test("⛔ sans le label, ou avec un autre : refusé par filters_match", () => {
    expect(parLabel({ labels: [] })).toEqual({ eligible: false, reason: "filters_match" });
    expect(parLabel({ labels: ["sul-americana"] })).toEqual({ eligible: false, reason: "filters_match" });
  });

  test("ni opt-in ni label : refusé par optin_matches (le SQL rend missing_optin_filter)", () => {
    expect(parLabel({}, {})).toEqual({ eligible: false, reason: "optin_matches" });
    expect(parLabel({}, { labels: [] })).toEqual({ eligible: false, reason: "optin_matches" });
  });

  test("opt-in ET label : les deux doivent correspondre", () => {
    expect(parLabel({ optinId: OPT }, { optin_ids: [OPT], labels: [LIB] })).toMatchObject({ eligible: true });
    expect(parLabel({ optinId: OPT, labels: ["autre"] }, { optin_ids: [OPT], labels: [LIB] })).toEqual({
      eligible: false,
      reason: "filters_match",
    });
    expect(parLabel({ optinId: null }, { optin_ids: [OPT], labels: [LIB] })).toEqual({ eligible: false, reason: "filters_match" });
  });

  test("le filtre labels vaut pour les autres déclencheurs (welcome_back)", () => {
    const retour = [ev(30, "optin_confirm", avant(40 * DAY_MS)), ev(35, "unsubscribe", avant(20 * DAY_MS), "list_unsub"), ev(40, "optin_confirm", avant(2 * HOUR_MS))];
    const c = ctx({ filters: { labels: [LIB] }, eventCursor: 10 });
    expect(evaluate("welcome_back", facts({ events: retour, labels: [LIB] }), c)).toMatchObject({ eligible: true });
    expect(evaluate("welcome_back", facts({ events: retour, labels: [] }), c)).toEqual({ eligible: false, reason: "filters_match" });
  });
});

describe("confirmation_reminder — les deux étapes de D2", () => {
  const base = SCENARIOS.confirmation_reminder.temoin;
  const deuxEtapes = base.ctx.steps;

  test("étape 2 : éligible quand l'étape 1 est partie DANS LE MÊME MODE, 48 h plus tôt", () => {
    const f = { ...base.facts, events: [ev(10, "optin_request", avant(80 * HOUR_MS))], sends: [envoi(1, "10", { trigger: "confirmation_reminder", at: avant(50 * HOUR_MS) })] };
    expect(evaluate("confirmation_reminder", f, ctx({ purpose: null, steps: deuxEtapes, step: 2 }))).toMatchObject({ eligible: true });
  });

  test("⛔ une étape 1 SIMULÉE n'ouvre pas l'étape 2 réelle : armer ne rejoue pas une vague", () => {
    const f = { ...base.facts, events: [ev(10, "optin_request", avant(80 * HOUR_MS))], sends: [envoi(1, "10", { trigger: "confirmation_reminder", at: avant(50 * HOUR_MS), simulated: true })] };
    expect(evaluate("confirmation_reminder", f, ctx({ purpose: null, steps: deuxEtapes, step: 2 }))).toEqual({ eligible: false, reason: "previous_step_done" });
  });

  test("⛔ deux étapes ne partent pas dans le même souffle : l'écart des délais est exigé", () => {
    const f = { ...base.facts, events: [ev(10, "optin_request", avant(80 * HOUR_MS))], sends: [envoi(1, "10", { trigger: "confirmation_reminder", at: avant(HOUR_MS) })] };
    expect(evaluate("confirmation_reminder", f, ctx({ purpose: null, steps: deuxEtapes, step: 2 }))).toEqual({ eligible: false, reason: "previous_step_done" });
  });

  test("une réinscription ouvre une période neuve (la clé est la DERNIÈRE demande)", () => {
    const f = { ...base.facts, events: [ev(4, "optin_request", avant(20 * DAY_MS)), ev(10, "optin_request", avant(30 * HOUR_MS))], sends: [envoi(1, "4", { trigger: "confirmation_reminder" })] };
    const r = evaluate("confirmation_reminder", f, base.ctx);
    expect(r).toMatchObject({ eligible: true, anchor: { periodKey: "10" } });
  });

  test("sans demande d'inscription au journal, rien à relancer", () => {
    expect(evaluate("confirmation_reminder", { ...base.facts, events: [] }, base.ctx)).toEqual({ eligible: false, reason: "no_anchor" });
  });
});

describe("preferences_updated — ce qui compte comme un changement de préférences", () => {
  test("le `granted` écrit par la CONFIRMATION (widget_doi) n'est pas un changement de préférences", () => {
    const f = facts({ events: [ev(20, "granted", avant(2 * HOUR_MS), "widget_doi", "content")] });
    expect(evaluate("preferences_updated", f, ctx({ eventCursor: 5 }))).toEqual({ eligible: false, reason: "no_anchor" });
  });

  test("plusieurs clics = UN e-mail, qui ne raconte que ce qui n'a pas déjà été confirmé", () => {
    const f = facts({
      events: [
        ev(18, "granted", avant(3 * DAY_MS), "preference_center", "events"),
        ev(21, "granted", avant(3 * HOUR_MS), "preference_center", "offers"),
        ev(22, "withdrawn", avant(2 * HOUR_MS), "preference_center", "partners"),
      ],
      sends: [envoi(1, "18", { trigger: "preferences_updated", at: avant(3 * DAY_MS) })],
    });
    const r = evaluate("preferences_updated", f, ctx({ eventCursor: 5 }));
    expect(r).toMatchObject({ eligible: true, anchor: { periodKey: "22" } });
    if (r.eligible) {
      expect(r.anchor.info).toEqual({
        updated_fields: [
          { field: "offers", value: true },
          { field: "partners", value: false },
        ],
      });
    }
  });

  test("un curseur jamais initialisé ne laisse RIEN passer (pas de rattrapage rétroactif)", () => {
    const sc = SCENARIOS.preferences_updated.temoin;
    expect(evaluate("preferences_updated", sc.facts, { ...sc.ctx, eventCursor: null })).toEqual({ eligible: false, reason: "after_cursor" });
  });
});

describe("welcome_back — D3 : après la nouvelle confirmation, jamais avant", () => {
  test("une réinscription par le centre de préférences est un retour", () => {
    const f = facts({ events: [ev(30, "resubscribe", avant(2 * HOUR_MS), "preference_center")] });
    expect(evaluate("welcome_back", f, ctx({ eventCursor: 10 }))).toMatchObject({ eligible: true });
  });

  test("une réinscription encore `pending` (pas reconfirmée) ne reçoit rien", () => {
    const sc = SCENARIOS.welcome_back.temoin;
    const f = { ...sc.facts, status: "pending", events: sc.facts.events.filter((e) => e.id !== 30) };
    expect(evaluate("welcome_back", f, sc.ctx)).toMatchObject({ eligible: false });
  });

  test("une première confirmation n'est pas un retour", () => {
    const f = facts({ events: [ev(29, "optin_request", avant(3 * HOUR_MS)), ev(30, "optin_confirm", avant(2 * HOUR_MS))] });
    expect(evaluate("welcome_back", f, ctx({ eventCursor: 10 }))).toEqual({ eligible: false, reason: "returning" });
  });

  // L'interrupteur « Newsletter » du centre de préférences écrit `withdrawn`/`content`, jamais `unsubscribe`
  // (même règle que `subscription_note_return`, 0087, et que `automation_due`, 0090).
  const retourApres = (depart: ReturnType<typeof ev>) =>
    facts({
      events: [
        ev(1, "optin_request", avant(300 * DAY_MS)),
        ev(2, "optin_confirm", avant(299 * DAY_MS)),
        depart,
        ev(29, "optin_request", avant(3 * HOUR_MS)),
        ev(30, "optin_confirm", avant(2 * HOUR_MS)),
      ],
    });

  test("une confirmation après la newsletter coupée au centre de préférences est un retour", () => {
    const f = retourApres(ev(3, "withdrawn", avant(100 * DAY_MS), "preference_center", "content"));
    expect(evaluate("welcome_back", f, ctx({ eventCursor: 10 }))).toMatchObject({ eligible: true });
  });

  test("le retrait d'une AUTRE finalité n'est pas un départ", () => {
    for (const purpose of ["offers", "events", "partners", null]) {
      const f = retourApres(ev(3, "withdrawn", avant(100 * DAY_MS), "preference_center", purpose));
      expect(evaluate("welcome_back", f, ctx({ eventCursor: 10 }))).toEqual({ eligible: false, reason: "returning" });
    }
  });

  test("un `withdrawn`/`content` APRÈS la confirmation ne fait pas de celle-ci un retour", () => {
    const f = facts({
      events: [
        ev(29, "optin_request", avant(3 * HOUR_MS)),
        ev(30, "optin_confirm", avant(2 * HOUR_MS)),
        ev(31, "withdrawn", avant(HOUR_MS), "preference_center", "content"),
      ],
    });
    expect(evaluate("welcome_back", f, ctx({ eventCursor: 10 }))).toEqual({ eligible: false, reason: "returning" });
  });
});

describe("reengagement / sunset — D4 : l'engagement mesurable seulement", () => {
  test("refus du suivi + réglage explicite `include_untracked` : éligible", () => {
    const sc = SCENARIOS.reengagement.temoin;
    const f = { ...sc.facts, trackingConsent: false };
    expect(evaluate("reengagement", f, { ...sc.ctx, settings: { include_untracked: true } })).toMatchObject({ eligible: true });
  });

  test("une visite du centre de préférences compte comme engagement (repousse l'ancre)", () => {
    const sc = SCENARIOS.reengagement.temoin;
    const f = { ...sc.facts, lastResponseAt: avant(5 * DAY_MS) };
    expect(evaluate("reengagement", f, sc.ctx)).toEqual({ eligible: false, reason: "delay_reached" });
  });

  test("days_inactive est fourni en variable", () => {
    const sc = SCENARIOS.reengagement.temoin;
    const r = evaluate("reengagement", sc.facts, sc.ctx);
    expect(r).toMatchObject({ eligible: true, anchor: { info: { days_inactive: 70 } } });
  });

  test("sunset sans exiger de réengagement : réglage explicite, éligible sans relance préalable", () => {
    const sc = SCENARIOS.sunset.temoin;
    expect(
      evaluate("sunset", { ...sc.facts, sends: [] }, { ...sc.ctx, settings: { require_reengagement: false } }),
    ).toMatchObject({ eligible: true });
  });

  test("⛔ un réengagement SIMULÉ ne justifie pas un sunset réel", () => {
    const sc = SCENARIOS.sunset.temoin;
    const f = { ...sc.facts, sends: sc.facts.sends.map((s) => ({ ...s, simulated: true })) };
    expect(evaluate("sunset", f, sc.ctx)).toEqual({ eligible: false, reason: "reengaged_without_answer" });
  });

  test("le délai de grâce n'est pas écoulé : pas encore", () => {
    const sc = SCENARIOS.sunset.temoin;
    const f = { ...sc.facts, sends: sc.facts.sends.map((s) => ({ ...s, at: avant(5 * DAY_MS) })) };
    expect(evaluate("sunset", f, sc.ctx)).toEqual({ eligible: false, reason: "reengaged_without_answer" });
  });
});

describe("anniversary — la période est l'année", () => {
  test("le 29 février tombe le 28 les années non bissextiles (comme Postgres)", () => {
    expect(anniversaryOf(new Date("2024-02-29T10:00:00Z"), 2027).toISOString()).toBe("2027-02-28T00:00:00.000Z");
    expect(anniversaryOf(new Date("2024-02-29T10:00:00Z"), 2028).toISOString()).toBe("2028-02-29T00:00:00.000Z");
  });

  test("une passe manquée le 31/12 est rattrapée le 1er janvier, sur l'année écoulée", () => {
    const f = facts({ createdAt: "2024-12-31T09:00:00Z" });
    const r = evaluate("anniversary", f, ctx({ now: new Date("2026-01-01T10:00:00Z"), steps: [{ delay_hours: 0, template_version_id: TV }] }));
    expect(r).toMatchObject({ eligible: true, anchor: { periodKey: "2025" } });
  });

  test("la clé de période est l'année courante", () => {
    const sc = SCENARIOS.anniversary.temoin;
    expect(evaluate("anniversary", sc.facts, sc.ctx)).toMatchObject({ eligible: true, anchor: { periodKey: "2026" } });
  });
});

describe("consent_renewal — D5", () => {
  test("le seuil se règle en mois (30 mois : pas encore)", () => {
    const sc = SCENARIOS.consent_renewal.temoin;
    expect(evaluate("consent_renewal", sc.facts, { ...sc.ctx, settings: { months: 30 } })).toEqual({ eligible: false, reason: "delay_reached" });
  });

  test("sans date de consentement, aucune ancre", () => {
    const sc = SCENARIOS.consent_renewal.temoin;
    expect(evaluate("consent_renewal", { ...sc.facts, consentAt: null }, sc.ctx)).toEqual({ eligible: false, reason: "no_anchor" });
  });

  test("ajout de mois à la Postgres : le 31 janvier + 1 mois = le 28 février", () => {
    expect(addMonthsUtc(new Date("2025-01-31T08:00:00Z"), 1).toISOString()).toBe("2025-02-28T08:00:00.000Z");
  });

  test("désactivé pour le réel tant que la route de renouvellement n'existe pas", () => {
    expect(TRIGGERS.consent_renewal.liveBlockedReason).not.toBeNull();
  });
});

describe("soft_bounce_rule — affichage seul", () => {
  test("le moteur ne l'exécute jamais", () => {
    expect(evaluate("soft_bounce_rule", facts(), ctx())).toEqual({ eligible: false, reason: "no_engine" });
    expect(TRIGGERS.soft_bounce_rule.engine).toBe(false);
  });

  test("le seuil affiché est celui de 0081 (4), en lecture seule", () => {
    expect(TRIGGERS.soft_bounce_rule.settings.threshold).toMatchObject({ default: 4, readOnly: true });
  });
});

describe("cohérence du catalogue", () => {
  test("les neuf déclencheurs du plan, ni plus ni moins", () => {
    expect([...TRIGGER_IDS].sort() as string[]).toEqual(Object.keys(TRIGGERS).sort());
    expect(Object.values(TRIGGERS).map((t) => t.sheetRow).sort((a, b) => a - b)).toEqual([2, 4, 6, 7, 8, 9, 11, 13, 15]);
  });

  test("politique ↔ kind : marketing = automation, transactionnel = automation_tx, les autres n'envoient rien", () => {
    for (const t of Object.values(TRIGGERS)) {
      const attendu = t.policy === "marketing" ? "automation" : t.policy === "transactional" ? "automation_tx" : null;
      expect(`${t.id}:${t.kind}`).toBe(`${t.id}:${attendu}`);
    }
  });

  test("⛔ l'exception transactionnelle est exactement la liste des déclencheurs transactionnels", () => {
    const tx = Object.values(TRIGGERS).filter((t) => t.policy === "transactional").map((t) => t.id).sort();
    expect(Object.keys(TX_TRIGGER_STATUS).sort()).toEqual(tx);
  });

  test("un marketing a une finalité par défaut, un non-marketing n'en a pas", () => {
    for (const t of Object.values(TRIGGERS)) {
      expect(`${t.id}:${t.defaultPurpose !== null}`).toBe(`${t.id}:${t.policy === "marketing"}`);
    }
  });

  test("chaque déclencheur ne déclare que des variables du catalogue", () => {
    for (const t of Object.values(TRIGGERS)) for (const v of t.variables) expect(VARIABLES[v]).toBeDefined();
  });

  test("les délais par défaut respectent les bornes du déclencheur", () => {
    for (const t of Object.values(TRIGGERS)) {
      const d = t.steps.defaultDelaysHours;
      expect(d.length >= t.steps.min && d.length <= t.steps.max).toBe(true);
      for (const h of d) expect(h >= t.steps.minDelayHours && h <= t.steps.maxDelayHours).toBe(true);
    }
  });

  test("⛔ un déclencheur événementiel ne peut pas attendre plus longtemps que la fenêtre de lecture", () => {
    for (const t of Object.values(TRIGGERS).filter((x) => x.source === "event")) {
      expect(t.steps.maxDelayHours < 7 * 24).toBe(true);
    }
  });
});
