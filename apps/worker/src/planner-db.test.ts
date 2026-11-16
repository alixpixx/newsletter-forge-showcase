/**
 * LES GARDES DU GEL — mesurées, pas relues.
 *
 * Ces trois gardes ont été posées le 26/08/2026 après qu'une cartographie a montré qu'armer
 * l'automatisation en l'état détruisait de l'état de façon irréversible. Elles n'ont l'air de rien
 * une fois écrites : c'est exactement pour ça qu'elles ont besoin d'un test. Sans lui, la première
 * relecture qui trouve `campaignCanStillSend` « redondant avec le fan-out » le retire, et la
 * newsletter recommence à brûler ses articles en silence.
 *
 * ⚠️ AUCUNE ÉCRITURE EN BASE. On substitue le client Supabase de `PlannerDb` par un double qui rend
 * des lignes fabriquées et enregistre ce qu'on lui a demandé. Ce qui est mesuré ici est le
 * FILTRAGE, qui vit en TypeScript ; ce que PostgREST fait de son côté n'est pas le sujet.
 */
import { describe, expect, test } from "bun:test";
import { createClient } from "@supabase/supabase-js";
import { PlannerDb, tranchesDeLiens } from "./planner-db";
import { campaignCanStillSend } from "./campaign-status";

/**
 * Un double chaînable : chaque méthode de PostgREST rend `this`, et l'objet se comporte comme une
 * promesse rendant la réponse programmée. Les appels sont enregistrés pour qu'un test puisse
 * vérifier NON SEULEMENT le résultat, mais que la requête portait bien les filtres attendus.
 */
function fauxClient(reponse: { data?: unknown; error?: unknown; count?: number }) {
  const appels: { methode: string; args: unknown[] }[] = [];
  const cible: Record<string, unknown> = {};
  const proxy: Record<string, unknown> = new Proxy(cible, {
    get(_t, prop: string) {
      if (prop === "then") {
        // Awaité : on rend la réponse programmée, une seule fois par chaîne.
        return (resoudre: (v: unknown) => void) =>
          resoudre({ data: reponse.data ?? null, error: reponse.error ?? null, count: reponse.count ?? null });
      }
      return (...args: unknown[]) => {
        appels.push({ methode: prop, args });
        return proxy;
      };
    },
  }) as Record<string, unknown>;
  return { sb: proxy, appels };
}

/** Un PlannerDb dont le client est le double. Le constructeur réel exige une config complète. */
function dbAvec(reponse: { data?: unknown; error?: unknown; count?: number }) {
  const { sb, appels } = fauxClient(reponse);
  const db = Object.create(PlannerDb.prototype) as PlannerDb;
  (db as unknown as { sb: unknown }).sb = sb;
  return { db, appels };
}

/** Une occurrence candidate au gel, dont on ne fait varier que le statut de sa campagne. */
function candidat(statutCampagne: string | null, id = "occ_1") {
  return {
    id,
    campaign_id: "camp_1",
    asset_id: "asset_1",
    // Dans 30 min : la fenêtre de gel par défaut est de 90 min, donc l'heure de gel est atteinte.
    scheduled_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    subject: "Sujet",
    preheader: "Preheader",
    segment_id: null,
    template_version_id: "ver_1",
    duplicate_ack_at: null,
    campaign: { freeze_lead_minutes: 90, name: "Campagne", status: statutCampagne },
  };
}

describe("campaignCanStillSend — le critère partagé par le gel et le fan-out", () => {
  test("refuse exactement les deux statuts qu'un humain a posés pour arrêter la campagne", () => {
    expect(campaignCanStillSend("paused")).toBe(false);
    expect(campaignCanStillSend("cancelled")).toBe(false);
  });

  test("laisse passer tout le reste, y compris draft et sending", () => {
    for (const s of ["draft", "scheduled", "sending", "sent"]) {
      expect(campaignCanStillSend(s)).toBe(true);
    }
  });

  test("un statut ABSENT passe : refuser sur une absence de signal ferait d'une jointure ratée un arrêt muet", () => {
    expect(campaignCanStillSend(null)).toBe(true);
    expect(campaignCanStillSend(undefined)).toBe(true);
  });
});

describe("listOccurrencesToFreeze — ne gèle pas ce que le fan-out refusera", () => {
  test("une campagne en pause ne rend AUCUN candidat, alors que son occurrence est due", async () => {
    const { db } = dbAvec({ data: [candidat("paused")] });
    expect(await db.listOccurrencesToFreeze(new Date().toISOString())).toHaveLength(0);
  });

  test("une campagne annulée non plus", async () => {
    const { db } = dbAvec({ data: [candidat("cancelled")] });
    expect(await db.listOccurrencesToFreeze(new Date().toISOString())).toHaveLength(0);
  });

  /*
   * LE TÉMOIN. Sans lui, un filtre qui refuserait TOUT passerait les deux tests précédents — et la
   * série s'arrêterait entièrement, ce qui est pire que le défaut qu'on corrige.
   */
  test("TÉMOIN — une campagne planifiée rend bien son candidat", async () => {
    const { db } = dbAvec({ data: [candidat("scheduled")] });
    expect(await db.listOccurrencesToFreeze(new Date().toISOString())).toHaveLength(1);
  });

  test("le tri sépare : sur un lot mêlé, seules les campagnes envoyables restent", async () => {
    const { db } = dbAvec({
      data: [candidat("paused", "a"), candidat("scheduled", "b"), candidat("cancelled", "c"), candidat("draft", "d")],
    });
    const gardes = (await db.listOccurrencesToFreeze(new Date().toISOString())).map((r) => r.id);
    expect(gardes).toEqual(["b", "d"]);
  });

  test("la fenêtre de gel continue de mordre : une occurrence trop lointaine est écartée", async () => {
    const loin = candidat("scheduled");
    // Dans 10 jours : l'heure de gel (scheduled_at − 90 min) n'est pas atteinte.
    loin.scheduled_at = new Date(Date.now() + 10 * 24 * 3600_000).toISOString();
    const { db } = dbAvec({ data: [loin] });
    expect(await db.listOccurrencesToFreeze(new Date().toISOString())).toHaveLength(0);
  });
});

/** Le contenu LU de l'édition — la garde du gel l'exige depuis le 25/09/2026 au soir (« même règle »). */
const LU = { subject: "Sujet lu", preheader: "Preheader lu", segment_id: "seg_lu" };

describe("freezeOccurrence — lit son propre UPDATE", () => {
  test("aucune ligne touchée (une autre passe a gelé avant) rend false", async () => {
    const { db } = dbAvec({ data: [] });
    expect(await db.freezeOccurrence("occ_1", {}, "ver_1", LU)).toBe(false);
  });

  test("une ligne touchée rend true", async () => {
    const { db } = dbAvec({ data: [{ id: "occ_1" }] });
    expect(await db.freezeOccurrence("occ_1", {}, "ver_1", LU)).toBe(true);
  });

  test("⛔ le gel est gardé par la VERSION LUE : une édition repointée entre-temps n'est pas gelée", async () => {
    // MUTATION QUI DOIT TUER CE TEST : retirer `.eq("template_version_id", versionLue)`. Le gel
    // figerait alors le contenu de l'ancienne version sous une ligne qui porte la nouvelle.
    const { db, appels } = dbAvec({ data: [] });
    await db.freezeOccurrence("occ_1", {}, "ver_8", LU);
    const eqs = appels.filter((a) => a.methode === "eq").map((a) => a.args);
    expect(eqs).toContainEqual(["template_version_id", "ver_8"]);
    expect(eqs).toContainEqual(["id", "occ_1"]);
  });

  test("la requête demande bien le résultat, sinon supabase-js ne remonte RIEN à lire", async () => {
    const { db, appels } = dbAvec({ data: [{ id: "occ_1" }] });
    await db.freezeOccurrence("occ_1", {}, "ver_1", LU);
    expect(appels.some((a) => a.methode === "select")).toBe(true);
    // Et la garde de concurrence reste : on n'écrase pas une ligne qui a déjà bougé.
    expect(appels.filter((a) => a.methode === "eq").some((a) => a.args[0] === "status" && a.args[1] === "planned")).toBe(
      true,
    );
  });

  test("⛔ le gel est gardé par le SUJET, le PREHEADER et le SEGMENT LUS : repointés entre-temps, pas de gel", async () => {
    // MUTATIONS QUI DOIVENT TUER CE TEST : retirer la garde du sujet, du preheader ou du segment. Le gel
    // réécrirait alors l'ancien sujet par-dessus celui que l'enregistrement de la campagne vient de poser.
    const { db, appels } = dbAvec({ data: [] });
    await db.freezeOccurrence("occ_1", {}, "ver_8", LU);
    const eqs = appels.filter((a) => a.methode === "eq").map((a) => a.args);
    expect(eqs).toContainEqual(["subject", "Sujet lu"]);
    expect(eqs).toContainEqual(["preheader", "Preheader lu"]);
    expect(eqs).toContainEqual(["segment_id", "seg_lu"]);
    expect(appels.some((a) => a.methode === "is")).toBe(false);
  });

  test("⛔ une valeur lue NULLE se garde par `is null`, JAMAIS par `eq` (un NULL ne passe aucune égalité)", async () => {
    // MUTATION QUI DOIT TUER CE TEST : `.eq(colonne, lu)` pour tout le monde. Toute édition sans
    // preheader ou sans segment verrait alors son gel refusé à chaque passe, jusqu'à manquer son heure.
    const { db, appels } = dbAvec({ data: [{ id: "occ_1" }] });
    await db.freezeOccurrence("occ_1", {}, "ver_8", { subject: "Sujet lu", preheader: null, segment_id: null });
    const eqs = appels.filter((a) => a.methode === "eq").map((a) => a.args);
    const iss = appels.filter((a) => a.methode === "is").map((a) => a.args);
    expect(iss).toContainEqual(["preheader", null]);
    expect(iss).toContainEqual(["segment_id", null]);
    expect(eqs.some((a) => a[0] === "preheader" || a[0] === "segment_id")).toBe(false);
    expect(eqs).toContainEqual(["subject", "Sujet lu"]);
  });

  test("la garde passe telle quelle dans l'URL du VRAI supabase-js : `eq.<texte>` et `is.null`", () => {
    // Un sujet avec virgules, parenthèses, point et accents : `eq` ne découpe pas, contrairement à `in`.
    const sujet = "Giro do Tricolor, (edição 7). Olá";
    const b = vraiClient
      .from("campaign_occurrence")
      .update({ status: "frozen" })
      .eq("id", "occ_1")
      .eq("subject", sujet)
      .is("preheader", null);
    const params = (b as unknown as { url: URL }).url.searchParams;
    expect(params.get("subject")).toBe(`eq.${sujet}`);
    expect(params.get("preheader")).toBe("is.null");
  });
});

describe("countOverdueOccurrences — rend visible ce que le gel ne rattrapera jamais", () => {
  test("compte les occurrences restées planned après leur heure", async () => {
    const { db } = dbAvec({ count: 3 });
    expect(await db.countOverdueOccurrences(new Date().toISOString())).toBe(3);
  });

  test("un compte absent vaut 0, pas null : un rapport ne doit pas propager un trou", async () => {
    const { db } = dbAvec({});
    expect(await db.countOverdueOccurrences(new Date().toISOString())).toBe(0);
  });

  test("la requête regarde bien le PASSÉ et le statut planned", async () => {
    const { db, appels } = dbAvec({ count: 0 });
    await db.countOverdueOccurrences(new Date().toISOString());
    expect(appels.some((a) => a.methode === "lt" && a.args[0] === "scheduled_at")).toBe(true);
    expect(appels.some((a) => a.methode === "eq" && a.args[0] === "status" && a.args[1] === "planned")).toBe(true);
  });
});

/**
 * LE 414 DU 23/09 — l'édition Copper Kettle · CL retenue parce que l'anti-répétition passait tout le
 * pool d'une semaine dans l'URL d'un GET.
 *
 * ⚠️ La longueur est mesurée sur l'URL que construit le VRAI supabase-js (aucune requête ne part :
 * l'hôte est `.invalid` et on ne l'attend jamais). Un calcul refait à la main dans le test
 * mesurerait notre idée de l'encodage, pas ce que nginx reçoit.
 */
const CAMP = "8fa29f69-0000-4000-8000-000000000000";
const DEPUIS = "2026-08-24T19:05:00.000Z";
const vraiClient = createClient("https://exemple.invalid", "cle-factice", {
  db: { schema: "newsletter" },
  auth: { persistSession: false, autoRefreshToken: false },
});
function urlReelle(tranche: string[]): string {
  const b = vraiClient
    .from("feed_article_sent")
    .select("article_url")
    .eq("campaign_id", CAMP)
    .gte("sent_at", DEPUIS)
    .in("article_url", tranche);
  return (b as unknown as { url: URL }).url.href;
}

/** Une semaine de Copper Kettle : des liens longs, à accents encodés, comme le site les publie. */
const SEMAINE = Array.from(
  { length: 700 },
  (_, i) =>
    `https://www.copper-kettle.example/futbol-chileno/2026/09/${String(1 + (i % 28)).padStart(2, "0")}/colo-colo-y-la-u-de-chile-igualan-en-un-cl%C3%A1sico-${i}/`,
);

/** Un client dont chaque chaîne répond selon SA tranche, et qui garde les tranches demandées. */
function clientParTranche(dejaPartis: Set<string>, echoueA?: number) {
  const tranches: string[][] = [];
  const sb = {
    from() {
      let tranche: string[] = [];
      const chaine: Record<string, unknown> = {
        select: () => chaine,
        eq: () => chaine,
        gte: () => chaine,
        in: (_colonne: string, valeurs: string[]) => {
          tranche = valeurs;
          tranches.push(valeurs);
          return chaine;
        },
        then: (resoudre: (v: unknown) => void) =>
          resoudre(
            tranches.length === echoueA
              ? { data: null, error: { message: "414 Request-URI Too Large" } }
              : {
                  data: tranche.filter((h) => dejaPartis.has(h)).map((article_url) => ({ article_url })),
                  error: null,
                },
          ),
      };
      return chaine;
    },
  };
  const db = Object.create(PlannerDb.prototype) as PlannerDb;
  (db as unknown as { sb: unknown }).sb = sb;
  return { db, tranches };
}

describe("sentArticleUrls — l'anti-répétition tient sur un pool d'une semaine", () => {
  test("TÉMOIN — d'un bloc, ce pool fait une URL au-delà des 8 Ko de nginx : c'est le 414", () => {
    expect(urlReelle(SEMAINE).length).toBeGreaterThan(8192);
  });

  test("aucune requête ne dépasse 4 Ko, même le pool entier, et chaque lien est demandé une fois", async () => {
    const { db, tranches } = clientParTranche(new Set());
    await db.sentArticleUrls(CAMP, SEMAINE, DEPUIS);
    expect(tranches.length).toBeGreaterThan(1);
    for (const t of tranches) expect(urlReelle(t).length).toBeLessThan(4096);
    expect(tranches.flat()).toEqual(SEMAINE);
  });

  test("les déjà-partis sont retrouvés dans TOUTES les tranches, pas seulement la première", async () => {
    const partis = new Set([SEMAINE[0]!, SEMAINE[350]!, SEMAINE[699]!]);
    const { db, tranches } = clientParTranche(partis);
    const deja = await db.sentArticleUrls(CAMP, SEMAINE, DEPUIS);
    expect(tranches.length).toBeGreaterThan(2);
    expect([...deja].sort()).toEqual([...partis].sort());
  });

  test("une tranche en échec fait lever l'ensemble : jamais un anti-répétition à moitié lu", async () => {
    const { db } = clientParTranche(new Set([SEMAINE[699]!]), 2);
    let leve = "";
    await db.sentArticleUrls(CAMP, SEMAINE, DEPUIS).catch((e: Error) => {
      leve = e.message;
    });
    expect(leve).toBe("sentArticleUrls: 414 Request-URI Too Large");
  });

  test("aucun lien, aucune requête", async () => {
    const { db, tranches } = clientParTranche(new Set());
    expect((await db.sentArticleUrls(CAMP, [], DEPUIS)).size).toBe(0);
    expect(tranches.length).toBe(0);
  });
});

describe("tranchesDeLiens", () => {
  test("un lien plus long que le budget part seul, entier", () => {
    const geant = `https://exemple.cl/${"a".repeat(5000)}`;
    expect(tranchesDeLiens(["https://exemple.cl/1", geant, "https://exemple.cl/2"])).toEqual([
      ["https://exemple.cl/1"],
      [geant],
      ["https://exemple.cl/2"],
    ]);
  });

  test("les doublons sont retirés, l'ordre est gardé", () => {
    expect(tranchesDeLiens(["b", "a", "b", "c", "a"])).toEqual([["b", "a", "c"]]);
  });
});
