import { describe, expect, test } from "bun:test";
import {
  cumulAutomation,
  lireActiviteAbonne,
  lireAudience,
  lireEngagementCampagne,
  lireResultatsAutomations,
} from "./engagement";
import {
  lireActiviteDAbonne,
  lireAudienceDeMarque,
  lireEngagementDeCampagne,
  lireResultatsDesAutomations,
} from "./data/engagement";
import { lireReponse } from "./campaign-stats";
import { lireStatsCampagnes } from "./data/campaign-stats";

// Formes relevées le 07/10/2026 sur la base réelle (0092→0094 jouées dans une transaction ANNULÉE),
// valeurs remplacées : seules les CLÉS et les TYPES viennent de la base.
const ENGAGEMENT = {
  sent: 1089, tracked: 0, tracking_unknown: 0,
  opens: { unique: 2, total: 3, unique_human: 1, bot: 1 },
  clicks: { unique: 1, total: 1 },
  links: [{ url: "https://exemple.test/a", unique: 1, total: 1 }],
  first_action_hours: [{ hour: 0, opens: 1, clicks: 0 }, { hour: 72, opens: 1, clicks: 1 }],
  dimensions: {
    device: [{ value: "mobile", unique: 1, total: 2 }, { value: null, unique: 1, total: 1 }],
    country: [{ value: "GB", unique: 1, total: 2 }],
  },
};
const ENGAGEMENT_VIDE = {
  sent: 74, tracked: 0, tracking_unknown: 0,
  opens: { unique: 0, total: 0, unique_human: 0, bot: 0 }, clicks: { unique: 0, total: 0 },
  links: [], first_action_hours: [], dimensions: {},
};
const AUTOMATIONS = {
  automations: [{
    id: "a1", name: "Welcome", status: "live", trigger: "subscribed",
    steps: [
      { step: 1, real: 10, simulated: 2, sent: 8, failed: 1, skipped: 1, queued: 0, delivered: 7, bounced: 1,
        complained: 0, opened: 3, clicked: 1, tracked: 7, last_at: "2026-10-03T13:00:00.123+00:00" },
      { step: 2, real: 4, simulated: 0, sent: 4, failed: 0, skipped: 0, queued: 0, delivered: 4, bounced: 0,
        complained: 0, opened: 2, clicked: 0, tracked: 4, last_at: null },
    ],
  }],
};
const AUDIENCE = {
  timezone: "Europe/London", since: "2026-04-08T10:00:00+00:00",
  levels: { active: 900, dormant: 200 },
  heatmap: [{ dow: 1, hour: 9, opens: 4, clicks: 1 }, { dow: 7, hour: 23, opens: 1, clicks: 0 }],
  sources: [{ source: "organic", total: 481, active: 300, pending: 20, contacts: 0, unsubscribed: 10, engaged: 40, avg_score: 12 },
            { source: "import", total: 15000, active: 0, pending: 0, contacts: 15000, unsubscribed: 50, engaged: 0, avg_score: null }],
  weekly: [{ week: "2026-09-28", metric: "signups", count: 12 }, { week: "2026-09-28", metric: "readers", count: 5 }],
};
const ACTIVITE = {
  total_messages: 1,
  subscriptions: [{ id: "s1", status: "active", open_count: 2, click_count: 1, last_open_at: null, last_click_at: null,
    last_engagement_at: null, engagement_score: null, engagement_level: null, tracking_consent: false,
    created_at: "2026-09-01T00:00:00+00:00" }],
  messages: [{
    id: "o1", kind: "campaign", subject: "Hello", status: "sent", created_at: "2026-10-03T12:00:00+00:00",
    sent_at: "2026-10-03T13:00:00+00:00", tracked: true, campaign_id: "c1", campaign_name: "Arena",
    events: [{ type: "delivered", occurred_at: "2026-10-03T13:00:05+00:00", severity: null, reason: "ok", url: null,
      device_type: null, client_name: null, client_os: null, bot: null, country: null, city: null }],
  }],
};

describe("lecture stricte des analytics du comportement (0094)", () => {
  test("engagement : la forme réelle est lue, une dimension absente = liste vide", () => {
    const e = lireEngagementCampagne(ENGAGEMENT)!;
    expect(e.opens).toEqual({ unique: 2, total: 3, uniqueHuman: 1, bot: 1 });
    expect(e.dimensions.device[1].value).toBeNull();
    expect(e.dimensions.client).toEqual([]);
    expect(e.firstActionHours[1].hour).toBe(72);
    const vide = lireEngagementCampagne(ENGAGEMENT_VIDE)!;
    expect(vide.links).toEqual([]);
    expect(vide.dimensions.city).toEqual([]);
  });

  test("engagement : un compteur manquant ou négatif rend null, jamais des zéros", () => {
    expect(lireEngagementCampagne({ ...ENGAGEMENT, opens: { unique: 2, total: 3, bot: 1 } })).toBeNull();
    expect(lireEngagementCampagne({ ...ENGAGEMENT, clicks: { unique: -1, total: 1 } })).toBeNull();
    expect(lireEngagementCampagne({ ...ENGAGEMENT, links: [{ url: null, unique: 1, total: 1 }] })).toBeNull();
    expect(lireEngagementCampagne({ ...ENGAGEMENT, first_action_hours: [{ hour: 73, opens: 1, clicks: 0 }] })).toBeNull();
    expect(lireEngagementCampagne(null)).toBeNull();
  });

  test("automations : étapes lues, cumul exact", () => {
    const a = lireResultatsAutomations(AUTOMATIONS)!;
    expect(a[0].steps[1].lastAt).toBeNull();
    const c = cumulAutomation(a[0].steps);
    expect(c.real).toBe(14);
    expect(c.sent).toBe(12);
    expect(c.opened).toBe(5);
    expect(lireResultatsAutomations({ automations: [{ ...AUTOMATIONS.automations[0], steps: [{ step: 1 }] }] })).toBeNull();
  });

  test("audience : forme réelle lue ; jour hors 1..7 ou métrique inconnue = illisible", () => {
    const a = lireAudience(AUDIENCE)!;
    expect(a.levels.dormant).toBe(200);
    expect(a.sources[1].avgScore).toBeNull();
    expect(lireAudience({ ...AUDIENCE, heatmap: [{ dow: 0, hour: 9, opens: 1, clicks: 0 }] })).toBeNull();
    expect(lireAudience({ ...AUDIENCE, weekly: [{ week: "2026-09-28", metric: "visits", count: 1 }] })).toBeNull();
  });

  test("activité d'un abonné : forme réelle lue ; tracked mal typé = illisible", () => {
    const a = lireActiviteAbonne(ACTIVITE)!;
    expect(a.messages[0].events[0].reason).toBe("ok");
    expect(a.subscriptions[0].engagementScore).toBeNull();
    expect(lireActiviteAbonne({ ...ACTIVITE, messages: [{ ...ACTIVITE.messages[0], tracked: "yes" }] })).toBeNull();
  });
});

describe("appels des analytics du comportement", () => {
  const rpc = (reponse: { data: unknown; error: { message: string } | null }) => {
    const appels: { fn: string; args: Record<string, unknown> }[] = [];
    return {
      appels,
      db: { rpc: (fn: string, args: Record<string, unknown>) => { appels.push({ fn, args }); return Promise.resolve(reponse); } },
    };
  };

  test("la marque de la session est TOUJOURS passée, et la réponse lue", async () => {
    const { db, appels } = rpc({ data: ENGAGEMENT, error: null });
    const r = await lireEngagementDeCampagne(db, "asset-1", "c1");
    expect(r.known).toBe(true);
    expect(appels[0]).toEqual({ fn: "campaign_engagement", args: { p_asset_id: "asset-1", p_campaign_id: "c1", p_occurrence_id: null } });
  });

  test("sans base, sans marque, fonction absente, réponse illisible : known=false avec la raison", async () => {
    expect(await lireAudienceDeMarque(null, "a")).toEqual({ known: false, reason: "the database is not configured" });
    expect(await lireAudienceDeMarque(rpc({ data: AUDIENCE, error: null }).db, null)).toEqual({ known: false, reason: "no brand selected" });
    const absente = await lireResultatsDesAutomations(
      rpc({ data: null, error: { message: "Could not find the function newsletter.automation_send_stats in the schema cache" } }).db, "a");
    expect(absente).toEqual({ known: false, reason: "migration 0094 has not been applied" });
    const autre = await lireActiviteDAbonne(rpc({ data: null, error: { message: "permission denied" } }).db, "a", "s");
    expect(autre).toEqual({ known: false, reason: "permission denied" });
    const illisible = await lireAudienceDeMarque(rpc({ data: { timezone: "UTC" }, error: null }).db, "a");
    expect(illisible).toEqual({ known: false, reason: "the database answered in an unexpected shape" });
  });
});

describe("campagnes masquées des analytics (0093)", () => {
  const CAMPAGNE = {
    id: "c1", name: "Arena", status: "sent", archived: false, recurring: false, last_sent_at: "2026-10-03T13:00:00Z",
    editions: [],
  };

  test("hidden lu ; absente (base d'avant 0093) = false ; mal typée = illisible", () => {
    expect(lireReponse({ total: 1, campaigns: [{ ...CAMPAGNE, hidden: true }] })!.campaigns[0].hidden).toBe(true);
    expect(lireReponse({ total: 1, campaigns: [CAMPAGNE] })!.campaigns[0].hidden).toBe(false);
    expect(lireReponse({ total: 1, campaigns: [{ ...CAMPAGNE, hidden: "yes" }] })).toBeNull();
  });

  test("sans « Show hidden » : la signature à 6 arguments, jamais p_include_hidden", async () => {
    const appels: Record<string, unknown>[] = [];
    const db = { rpc: (_fn: string, args: Record<string, unknown>) => { appels.push(args); return Promise.resolve({ data: { total: 0, campaigns: [] }, error: null }); } };
    await lireStatsCampagnes(db, "a", {});
    expect("p_include_hidden" in appels[0]).toBe(false);
  });

  test("« Show hidden » : p_include_hidden=true ; base d'avant 0093 = repli sur 6 arguments", async () => {
    const appels: Record<string, unknown>[] = [];
    const db = {
      rpc: (_fn: string, args: Record<string, unknown>) => {
        appels.push(args);
        return Promise.resolve("p_include_hidden" in args
          ? { data: null, error: { message: "Could not find the function newsletter.campaign_send_stats(p_asset_id, p_campaign_id, p_include_hidden, p_limit, p_offset, p_search, p_since) in the schema cache" } }
          : { data: { total: 1, campaigns: [CAMPAGNE] }, error: null });
      },
    };
    const r = await lireStatsCampagnes(db, "a", { includeHidden: true });
    expect(appels[0].p_include_hidden).toBe(true);
    expect("p_include_hidden" in appels[1]).toBe(false);
    expect(r.known).toBe(true);
  });

  test("« Show hidden » : une AUTRE erreur n'est pas masquée par le repli", async () => {
    let n = 0;
    const db = { rpc: () => { n += 1; return Promise.resolve({ data: null, error: { message: "permission denied for function" } }); } };
    const r = await lireStatsCampagnes(db, "a", { includeHidden: true });
    expect(n).toBe(1);
    expect(r).toEqual({ known: false, reason: "permission denied for function" });
  });
});
