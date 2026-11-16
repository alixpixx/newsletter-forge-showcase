/**
 * PATCH /api/campaigns/[id] — ENREGISTRER UNE NOUVELLE VERSION REPOINTE LES ÉDITIONS À VENIR
 * (décision d'Alix du 25/09/2026, « A »), mesuré de bout en bout sans session ni base.
 *
 * ⛔ POURQUOI UNE BASE EN MÉMOIRE ET PAS `fauxDb`. `fauxDb` enregistre la requête construite ; il ne
 * dit pas QUELLES lignes elle aurait touchées. Or tout le risque est là : une édition gelée, retenue
 * ou d'une autre marque déplacée sous ses pieds. Le double ci-dessous APPLIQUE les filtres PostgREST
 * utilisés (`eq`, `in`, `gt`, `gte`, `not … is null`) avec la sémantique SQL (NULL ne passe aucune
 * comparaison) sur de vraies lignes, et LÈVE sur toute méthode qu'il n'émule pas — un filtre ajouté
 * plus tard ne peut pas passer en silence.
 *
 * Ce sont les VRAIES fonctions `findCampaign` / `updateCampaign` / `buildCampaignPatch` /
 * `repointUpcomingOccurrences` qui tournent ; seules la session, la version publiée (qui lit les
 * cookies) et l'horloge sont injectées.
 */
import { describe, expect, test } from "bun:test";

// ⚠️ `campaigns.ts` tire `@/lib/session` → `auth.ts`, qui LÈVE à l'import si AUTH_SECRET manque.
process.env.AUTH_SECRET = "secret-de-test-uniquement-25092026";
const { patchCampaign } = await import("./handler");
const { seuilDeRepointage } = await import("@/lib/data/campaigns");

const CAMP = "11111111-1111-4111-8111-111111111111";
const ASSET = "22222222-2222-4222-8222-222222222222";
const AUTRE_CAMP = "33333333-3333-4333-8333-333333333333";
const AUTRE_ASSET = "44444444-4444-4444-8444-444444444444";
const V8 = "88888888-8888-4888-8888-888888888888";
const V10 = "10101010-1010-4010-8010-101010101010";
const SEG = "55555555-5555-4555-8555-555555555555";
const SEG2 = "66666666-6666-4666-8666-666666666666";

/** Les segments de la marque, pour `findSegment` (appelé par `buildCampaignPatch` sur un `segmentId`). */
const SEGMENTS: Ligne[] = [
  { id: SEG, asset_id: ASSET, name: "Tricolores", rule_json: { type: "group", op: "and", children: [] } },
  { id: SEG2, asset_id: ASSET, name: "Sócios", rule_json: { type: "group", op: "and", children: [] } },
];

const MAINTENANT = new Date("2026-09-25T12:00:00.000Z");
const dans = (minutes: number) => new Date(MAINTENANT.getTime() + minutes * 60_000).toISOString();
const JOUR = 24 * 60;

type Ligne = Record<string, unknown>;
type Filtre = [op: string, col: string, val: unknown];
interface Appel {
  table: string;
  op: "select" | "update";
  filtres: Filtre[];
  patch?: Ligne;
}

/** Sémantique SQL : une comparaison avec NULL n'est jamais vraie. */
function passe(l: Ligne, [op, col, val]: Filtre): boolean {
  const v = l[col];
  switch (op) {
    case "eq":
      return v !== null && v !== undefined && v === val;
    case "in":
      return v !== null && v !== undefined && (val as unknown[]).includes(v);
    case "gt":
      return typeof v === "string" && Date.parse(v) > Date.parse(String(val));
    case "gte":
      return typeof v === "string" && Date.parse(v) >= Date.parse(String(val));
    case "not-is-null":
      return v !== null && v !== undefined;
    default:
      throw new Error(`filtre non émulé : ${op}`);
  }
}

function baseEnMemoire(opts: {
  campagne: Ligne;
  occurrences: Ligne[];
  panne?: { campagne?: string; lectureOcc?: string; ecritureOcc?: string };
}) {
  const campagne: Ligne = { ...opts.campagne };
  const occurrences = opts.occurrences.map((o) => ({ ...o }));
  const appels: Appel[] = [];

  const from = (table: string) => {
    const appel: Appel = { table, op: "select", filtres: [] };
    appels.push(appel);
    const repondre = (): { data: unknown; error: unknown } => {
      const lignes =
        table === "campaign"
          ? [campagne]
          : table === "campaign_occurrence"
            ? occurrences
            : table === "segment"
              ? SEGMENTS
              : null;
      if (!lignes) throw new Error(`table non émulée : ${table}`);
      if (table === "segment" && appel.op === "update") throw new Error("segment : écriture non émulée");
      const touchees = lignes.filter((l) => appel.filtres.every((f) => passe(l, f)));
      if (appel.op === "update") {
        const panne = table === "campaign" ? opts.panne?.campagne : opts.panne?.ecritureOcc;
        if (panne) return { data: null, error: { message: panne } };
        for (const l of touchees) Object.assign(l, appel.patch);
        return { data: touchees.map((l) => ({ id: l.id })), error: null };
      }
      if (table === "campaign_occurrence" && opts.panne?.lectureOcc) {
        return { data: null, error: { message: opts.panne.lectureOcc } };
      }
      if (table === "campaign" || table === "segment") {
        return { data: touchees[0] ? { ...touchees[0] } : null, error: null };
      }
      return { data: touchees.map((l) => ({ ...l })), error: null };
    };
    // Chaque méthode rend le PROXY : une méthode non émulée lève, où qu'elle soit dans la chaîne.
    let p: unknown = null;
    const chaine: Record<string, unknown> = {
      select: () => p,
      update: (patch: Ligne) => {
        appel.op = "update";
        appel.patch = patch;
        return p;
      },
      eq: (col: string, val: unknown) => (appel.filtres.push(["eq", col, val]), p),
      in: (col: string, val: unknown[]) => (appel.filtres.push(["in", col, val]), p),
      gt: (col: string, val: unknown) => (appel.filtres.push(["gt", col, val]), p),
      gte: (col: string, val: unknown) => (appel.filtres.push(["gte", col, val]), p),
      not: (col: string, op: string, val: unknown) => {
        if (op !== "is" || val !== null) throw new Error(`not(${op}, ${String(val)}) non émulé`);
        appel.filtres.push(["not-is-null", col, null]);
        return p;
      },
      maybeSingle: () => p,
      then: (ok: (v: unknown) => void) => ok(repondre()),
    };
    p = new Proxy(chaine, {
      get(t, prop: string | symbol) {
        if (typeof prop === "string" && prop in t) return t[prop];
        throw new Error(`méthode non émulée : ${String(prop)}`);
      },
    });
    return p;
  };

  return { db: { from }, campagne, occurrences, appels };
}

const campagneDeBase = (extra: Ligne = {}): Ligne => ({
  id: CAMP,
  asset_id: ASSET,
  name: "Giro do Tricolor",
  status: "draft",
  subject: "Sujet",
  template_version_id: V8,
  locked_at: null,
  freeze_lead_minutes: 90,
  recurrence_days: [5],
  recurrence_time: "10:00:00",
  // ⛔ Série ARRÊTÉE sans annulation : ses éditions planifiées partent quand même (ni le gel ni le
  // fan-out ne lisent l'interrupteur). Le repointage ne doit donc PAS le lire non plus.
  recurrence_active: false,
  updated_at: "2026-09-20T10:00:00.000Z",
  ...extra,
});

const occ = (id: string, status: string, scheduled_at: string | null, extra: Ligne = {}): Ligne => ({
  id,
  campaign_id: CAMP,
  asset_id: ASSET,
  status,
  scheduled_at,
  template_version_id: V8,
  subject: "Sujet de l'édition",
  preheader: "Preheader de l'édition",
  segment_id: SEG,
  review_overrides: null,
  review_rev: 0,
  review_applied_rev: 0,
  review_error: null,
  review_base: null,
  updated_at: "2026-09-20T10:00:00.000Z",
  ...extra,
});

/** Le jeu de lignes : chaque état qu'une série peut avoir, et ce que le repointage doit en faire. */
const JEU = (): Ligne[] => [
  // À déplacer : planned, datées au-delà de maintenant + 90 min + 10 min.
  occ("p1", "planned", dans(2 * JOUR)),
  occ("p2", "planned", dans(7 * JOUR)),
  occ("p3", "planned", dans(14 * JOUR), {
    review_overrides: { subject: "Sujet relu" },
    review_rev: 2,
    review_applied_rev: 0,
    review_error: "ancienne erreur",
    review_base: { version: 1 },
  }),
  // Version supprimée (`on delete set null`) : elle aussi part sur la nouvelle.
  occ("p4", "planned", dans(3 * JOUR), { template_version_id: null }),
  // Dans la fenêtre de gel (90 min) et dans la marge d'une période du cron (10 min) : intactes, SIGNALÉES.
  occ("w1", "planned", dans(60)),
  occ("w2", "planned", dans(95)),
  // Contenu déjà arrêté : intactes, signalées.
  occ("f1", "frozen", dans(30)),
  occ("f2", "frozen", dans(3 * JOUR)),
  // Retenue : intacte, comptée à part.
  occ("h1", "held", dans(3 * JOUR), { hold_reason: "identical to the edition of 2026-09-19" }),
  // Terminales ou en vol — datées dans le futur EXPRÈS : seul le filtre de statut les protège.
  occ("c1", "cancelled", dans(5 * JOUR)),
  occ("sg1", "sending", dans(4 * JOUR)),
  occ("s1", "sent", dans(6 * JOUR)),
  occ("x1", "failed", dans(8 * JOUR)),
  // Passée (manquée) et sans date : intactes, non comptées.
  occ("past1", "planned", dans(-JOUR)),
  occ("nd1", "planned", null),
  // Une autre campagne de la même marque, et la même campagne vue d'une AUTRE marque.
  occ("autreCamp", "planned", dans(2 * JOUR), { campaign_id: AUTRE_CAMP }),
  occ("autreMarque", "planned", dans(2 * JOUR), { asset_id: AUTRE_ASSET }),
  // …et une gelée et une retenue de cette autre marque : la LECTURE des comptes est scopée elle aussi.
  occ("autreMarqueF", "frozen", dans(30), { asset_id: AUTRE_ASSET }),
  occ("autreMarqueH", "held", dans(3 * JOUR), { asset_id: AUTRE_ASSET, hold_reason: "autre marque" }),
];

const DEPLACEES = ["p1", "p2", "p3", "p4"];

async function patcher(body: unknown, opts: Partial<Parameters<typeof baseEnMemoire>[0]> = {}) {
  const base = baseEnMemoire({
    campagne: opts.campagne ?? campagneDeBase(),
    occurrences: opts.occurrences ?? JEU(),
    panne: opts.panne,
  });
  const avant = base.occurrences.map((o) => ({ ...o }));
  const res = await patchCampaign(
    new Request("http://x/api", { method: "PATCH", body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: CAMP }) },
    {
      requireContext: async () => ({
        ok: true as const,
        ctx: { db: base.db as never, asset: { id: ASSET, name: "Northwind Sports" } as never, user: { email: "a@staff.invalid" } as never },
      }),
      versionPubliee: async (_db, id) =>
        id === V10 ? { id: V10, templateId: "tpl", version: 10 } : id === V8 ? { id: V8, templateId: "tpl", version: 8 } : null,
      maintenant: () => MAINTENANT,
    },
  );
  const json = (await res.json()) as Record<string, unknown>;
  const ligne = (id: string) => base.occurrences.find((o) => o.id === id)!;
  const ligneAvant = (id: string) => avant.find((o) => o.id === id)!;
  const appelsOcc = base.appels.filter((a) => a.table === "campaign_occurrence");
  return { res, json, base, ligne, ligneAvant, appelsOcc };
}

describe("repointage — ce qui bouge", () => {
  test("⛔ les éditions planned au-delà de la fenêtre passent sur la nouvelle version, et le nombre est rendu", async () => {
    const { res, json, ligne } = await patcher({ templateVersionId: V10 });
    expect(res.status).toBe(200);
    for (const id of DEPLACEES) expect(ligne(id).template_version_id).toBe(V10);
    expect(json.occurrences).toEqual({ moved: 4, skippedInFreezeWindow: 4, held: 1 });
  });

  test("⛔ une série ARRÊTÉE (recurrence_active = false) est repointée quand même", async () => {
    // MUTATION QUI DOIT TUER CE TEST : conditionner le repointage à `campaign.recurrenceActive`.
    const { ligne } = await patcher({ templateVersionId: V10 }, { campagne: campagneDeBase({ recurrence_active: false }) });
    expect(ligne("p1").template_version_id).toBe(V10);
  });

  test("⛔ seules template_version_id et updated_at sont écrites : review_*, sujet, preheader, segment préservés", async () => {
    const { ligne, ligneAvant, appelsOcc } = await patcher({ templateVersionId: V10 });
    const ecriture = appelsOcc.find((a) => a.op === "update")!;
    expect(Object.keys(ecriture.patch!).sort()).toEqual(["template_version_id", "updated_at"]);
    const apres = ligne("p3");
    const avant = ligneAvant("p3");
    for (const col of [
      "review_overrides", "review_rev", "review_applied_rev", "review_error", "review_base",
      "subject", "preheader", "segment_id", "status", "scheduled_at",
    ]) {
      expect(apres[col]).toEqual(avant[col]);
    }
    expect(apres.updated_at).toBe(MAINTENANT.toISOString());
  });
});

describe("repointage — ce qui ne bouge JAMAIS", () => {
  const INTACTES = [
    "w1", "w2", "f1", "f2", "h1", "c1", "sg1", "s1", "x1", "past1", "nd1",
    "autreCamp", "autreMarque", "autreMarqueF", "autreMarqueH",
  ];

  test("⛔ frozen / held / sending / sent / cancelled / failed : intactes, même datées dans le futur", async () => {
    // MUTATION QUI DOIT TUER CE TEST : retirer `.eq("status", "planned")` de l'écriture.
    const { ligne, ligneAvant } = await patcher({ templateVersionId: V10 });
    for (const id of ["f1", "f2", "h1", "c1", "sg1", "s1", "x1"]) expect(ligne(id)).toEqual(ligneAvant(id));
  });

  test("⛔ dans la fenêtre de gel ET dans la marge d'une période du cron : intactes, et SIGNALÉES", async () => {
    // MUTATIONS QUI DOIVENT TUER CE TEST : retirer `.gt("scheduled_at", seuil)` ; ramener la marge à 0
    // (w2, à 95 min, tombe entre maintenant + 90 et maintenant + 100).
    const { json, ligne, ligneAvant } = await patcher({ templateVersionId: V10 });
    expect(ligne("w1")).toEqual(ligneAvant("w1"));
    expect(ligne("w2")).toEqual(ligneAvant("w2"));
    const o = json.occurrences as { skippedInFreezeWindow: number };
    // w1, w2 (planned sous le seuil) + f1, f2 (déjà gelées).
    expect(o.skippedInFreezeWindow).toBe(4);
  });

  test("passées ou sans date : intactes, et non comptées", async () => {
    const { ligne, ligneAvant } = await patcher({ templateVersionId: V10 });
    expect(ligne("past1")).toEqual(ligneAvant("past1"));
    expect(ligne("nd1")).toEqual(ligneAvant("nd1"));
  });

  test("⛔ une autre campagne, et la même campagne vue d'une autre marque : intactes", async () => {
    // MUTATION QUI DOIT TUER CE TEST : retirer `.eq("asset_id", assetId)` de l'écriture.
    const { ligne, ligneAvant } = await patcher({ templateVersionId: V10 });
    expect(ligne("autreCamp")).toEqual(ligneAvant("autreCamp"));
    expect(ligne("autreMarque")).toEqual(ligneAvant("autreMarque"));
  });

  test("la liste complète des intactes, d'un coup (aucune autre ligne ne bouge)", async () => {
    const { base, ligne, ligneAvant } = await patcher({ templateVersionId: V10 });
    for (const id of INTACTES) expect(ligne(id)).toEqual(ligneAvant(id));
    expect(base.occurrences.filter((o) => o.template_version_id === V10).map((o) => o.id).sort()).toEqual(
      [...DEPLACEES].sort(),
    );
  });

  test("held : comptée, pas déplacée — une retenue relâchée partirait avec la version qu'elle porte", async () => {
    const { json, ligne } = await patcher({ templateVersionId: V10 });
    expect(ligne("h1").template_version_id).toBe(V8);
    expect((json.occurrences as { held: number }).held).toBe(1);
  });
});

describe("quand repointer — la version doit avoir CHANGÉ", () => {
  /*
   * ⚠️ Jusqu'au 25/09/2026 au soir, ce test prenait le SUJET comme exemple de champ qui ne repointe
   * rien. La décision « même règle » l'a rendu faux : le sujet repointe désormais (voir plus bas). Ses
   * assertions sont gardées telles quelles, sur un champ qui, lui, n'est copié dans aucune édition.
   */
  test("⛔ PATCH du nom seul : aucune édition lue ni touchée, et pas de bilan dans la réponse", async () => {
    // MUTATION QUI DOIT TUER CE TEST : repointer sur tout PATCH, ou compter `name` parmi les champs d'édition.
    const { res, json, appelsOcc, base, ligneAvant } = await patcher({ name: "Nouveau nom" });
    expect(res.status).toBe(200);
    expect(appelsOcc).toHaveLength(0);
    for (const o of base.occurrences) expect(o).toEqual(ligneAvant(String(o.id)));
    expect(json.occurrences).toBeUndefined();
    expect(json.occurrencesFields).toBeUndefined();
  });

  test("⛔ version inchangée : aucune édition touchée", async () => {
    // MUTATION QUI DOIT TUER CE TEST : repointer dès que `templateVersionId` est dans le corps.
    const { appelsOcc } = await patcher({ templateVersionId: V8, subject: "Sujet" });
    expect(appelsOcc).toHaveLength(0);
  });

  test("⛔ templateVersionId: null : la campagne perd sa version, AUCUNE édition n'est repointée", async () => {
    const { res, appelsOcc, base } = await patcher({ templateVersionId: null });
    expect(res.status).toBe(200);
    expect(base.campagne.template_version_id).toBeNull();
    expect(appelsOcc).toHaveLength(0);
  });

  test("⛔ ORDRE — la campagne est écrite AVANT les éditions", async () => {
    const { base } = await patcher({ templateVersionId: V10 });
    const iCampagne = base.appels.findIndex((a) => a.table === "campaign" && a.op === "update");
    const iOcc = base.appels.findIndex((a) => a.table === "campaign_occurrence" && a.op === "update");
    expect(iCampagne).toBeGreaterThan(-1);
    expect(iOcc).toBeGreaterThan(iCampagne);
  });
});

describe("échecs", () => {
  test("⛔ écriture des éditions en échec ⇒ 207 : la campagne EST enregistrée, et la réponse le dit", async () => {
    // MUTATION QUI DOIT TUER CE TEST : rendre 500. Annoncer un échec ferait recommencer un geste à
    // moitié fait, sur un écran qui dit le contraire.
    const { res, json, base, ligneAvant } = await patcher({ templateVersionId: V10 }, { panne: { ecritureOcc: "boom" } });
    expect(res.status).toBe(207);
    expect(json.occurrencesError).toBe("boom");
    expect(json.occurrences).toBeNull();
    expect(base.campagne.template_version_id).toBe(V10);
    expect((json.campaign as { templateVersionId: string }).templateVersionId).toBe(V10);
    for (const o of base.occurrences) expect(o).toEqual(ligneAvant(String(o.id)));
  });

  test("⛔ lecture des éditions en échec ⇒ 207, et RIEN n'est écrit sur les éditions (la lecture passe avant)", async () => {
    const { res, json, appelsOcc } = await patcher({ templateVersionId: V10 }, { panne: { lectureOcc: "lecture en panne" } });
    expect(res.status).toBe(207);
    expect(json.occurrencesError).toBe("lecture en panne");
    expect(appelsOcc.filter((a) => a.op === "update")).toHaveLength(0);
  });

  test("écriture de la campagne en échec ⇒ 500, et aucune édition n'est touchée", async () => {
    const { res, appelsOcc } = await patcher({ templateVersionId: V10 }, { panne: { campagne: "campagne en panne" } });
    expect(res.status).toBe(500);
    expect(appelsOcc).toHaveLength(0);
  });

  test("campagne verrouillée ⇒ 409, rien n'est écrit", async () => {
    const { res, base } = await patcher({ templateVersionId: V10 }, { campagne: campagneDeBase({ locked_at: "2026-09-24T10:00:00Z" }) });
    expect(res.status).toBe(409);
    expect(base.appels.filter((a) => a.op === "update")).toHaveLength(0);
  });

  test("version non publiée de la marque ⇒ 400, rien n'est écrit", async () => {
    const { res, base } = await patcher({ templateVersionId: "99999999-9999-4999-8999-999999999999" });
    expect(res.status).toBe(400);
    expect(base.appels.filter((a) => a.op === "update")).toHaveLength(0);
  });
});

describe("seuilDeRepointage — délai de gel de la campagne + une période du cron", () => {
  test("90 min par défaut quand la colonne est absente, + 10 min de marge", () => {
    expect(seuilDeRepointage(MAINTENANT, null).toISOString()).toBe(dans(100));
    expect(seuilDeRepointage(MAINTENANT, undefined).toISOString()).toBe(dans(100));
  });

  test("le délai réglé sur la campagne fait foi (0 compris)", () => {
    expect(seuilDeRepointage(MAINTENANT, 240).toISOString()).toBe(dans(250));
    expect(seuilDeRepointage(MAINTENANT, 0).toISOString()).toBe(dans(10));
  });
});

/* ------------------------------------------------------------------ *
 * « MÊME RÈGLE » — le sujet, le preheader et le segment (décision d'Alix du 25/09/2026 au soir)
 *
 * Le matérialiseur copie aussi `subject ?? ""`, `preheader` et `segment_id` de la campagne dans chaque
 * édition, et le gel comme le fan-out lisent ceux de l'ÉDITION. Les éditions `planned` à venir reçoivent
 * donc les nouvelles valeurs des champs qui ont CHANGÉ — et de ceux-là seulement — aux mêmes conditions
 * que la version : même seuil, même scope, mêmes exclusions, mêmes comptes, même 207.
 * ------------------------------------------------------------------ */

/** Les colonnes d'une édition que le repointage peut écrire — hors `updated_at`. */
const COLONNES_D_EDITION = ["template_version_id", "subject", "preheader", "segment_id"];

/** Seules `colonnes` (et `updated_at`) ont bougé sur les éditions déplacées ; tout le reste est intact. */
function seulesOntBouge(
  ligne: (id: string) => Ligne,
  ligneAvant: (id: string) => Ligne,
  attendu: Record<string, unknown>,
) {
  for (const id of DEPLACEES) {
    const apres = ligne(id);
    const avant = ligneAvant(id);
    for (const col of Object.keys(avant)) {
      if (col === "updated_at") continue;
      if (col in attendu) expect([id, col, apres[col]]).toEqual([id, col, attendu[col]]);
      else expect([id, col, apres[col]]).toEqual([id, col, avant[col]]);
    }
    expect(apres.updated_at).toBe(MAINTENANT.toISOString());
  }
}

describe("même règle — le champ qui change, et lui seul, suit", () => {
  test("⛔ sujet seul : propagé aux éditions à venir ; version, preheader et segment intacts", async () => {
    // MUTATIONS QUI DOIVENT TUER CE TEST : ne repointer que sur la version ; oublier le sujet dans
    // `champsAPropager` ; écrire une colonne qui n'a pas changé.
    const { res, json, ligne, ligneAvant, appelsOcc } = await patcher({ subject: "Nouveau sujet" });
    expect(res.status).toBe(200);
    seulesOntBouge(ligne, ligneAvant, { subject: "Nouveau sujet" });
    const ecriture = appelsOcc.find((a) => a.op === "update")!;
    expect(Object.keys(ecriture.patch!).sort()).toEqual(["subject", "updated_at"]);
    expect(json.occurrences).toEqual({ moved: 4, skippedInFreezeWindow: 4, held: 1 });
    expect(json.occurrencesFields).toEqual(["subject"]);
  });

  test("⛔ preheader seul : propagé ; le reste intact", async () => {
    const { json, ligne, ligneAvant, appelsOcc } = await patcher({ preheader: "Nouveau preheader" });
    seulesOntBouge(ligne, ligneAvant, { preheader: "Nouveau preheader" });
    expect(Object.keys(appelsOcc.find((a) => a.op === "update")!.patch!).sort()).toEqual(["preheader", "updated_at"]);
    expect(json.occurrencesFields).toEqual(["preheader"]);
  });

  test("⛔ segment seul (« Save audience ») : propagé ; le reste intact, la finalité et la case n'y entrent pas", async () => {
    const { json, ligne, ligneAvant, appelsOcc } = await patcher(
      { segmentId: SEG2, contactsIgnorePurpose: true },
      { campagne: campagneDeBase({ segment_id: SEG }) },
    );
    seulesOntBouge(ligne, ligneAvant, { segment_id: SEG2 });
    expect(Object.keys(appelsOcc.find((a) => a.op === "update")!.patch!).sort()).toEqual(["segment_id", "updated_at"]);
    expect(json.occurrencesFields).toEqual(["segmentId"]);
  });

  test("⛔ segment RETIRÉ (null) : propagé — sans segment, le fan-out vise la marque entière, il ne refuse pas", async () => {
    // MUTATION QUI DOIT TUER CE TEST : traiter un segment `null` comme une version `null` (jamais propagé).
    // Le matérialiseur copierait `null` dans l'édition suivante : les éditions déjà créées doivent suivre.
    const { json, ligne, ligneAvant } = await patcher({ segmentId: null }, { campagne: campagneDeBase({ segment_id: SEG }) });
    seulesOntBouge(ligne, ligneAvant, { segment_id: null });
    expect(json.occurrencesFields).toEqual(["segmentId"]);
  });

  test("⛔ version ET sujet : UNE écriture, les deux colonnes, les deux nommées dans l'ordre", async () => {
    const { json, ligne, ligneAvant, appelsOcc } = await patcher({ templateVersionId: V10, subject: "Nouveau sujet" });
    seulesOntBouge(ligne, ligneAvant, { template_version_id: V10, subject: "Nouveau sujet" });
    const ecritures = appelsOcc.filter((a) => a.op === "update");
    expect(ecritures).toHaveLength(1);
    expect(Object.keys(ecritures[0]!.patch!).sort()).toEqual(["subject", "template_version_id", "updated_at"]);
    expect(json.occurrencesFields).toEqual(["templateVersionId", "subject"]);
  });

  test("la version seule se nomme aussi (ce que l'écran lit pour garder « moved to v10 »)", async () => {
    const { json } = await patcher({ templateVersionId: V10 });
    expect(json.occurrencesFields).toEqual(["templateVersionId"]);
  });

  test("⛔ « Save content » tel que l'écran l'envoie (sujet, preheader \"\", même version) : seul le sujet suit", async () => {
    // MUTATIONS QUI DOIVENT TUER CE TEST : comparer le preheader strictement (`null` ≠ "") — l'écran
    // envoie "" pour un champ vide, et trois semaines d'éditions verraient leur preheader réécrit ;
    // écrire tout ce que le corps touche au lieu de ce qui a changé.
    const { json, ligne, ligneAvant, appelsOcc } = await patcher({
      subject: "Nouveau sujet",
      preheader: "",
      templateVersionId: V8,
    });
    seulesOntBouge(ligne, ligneAvant, { subject: "Nouveau sujet" });
    expect(Object.keys(appelsOcc.find((a) => a.op === "update")!.patch!).sort()).toEqual(["subject", "updated_at"]);
    expect(json.occurrencesFields).toEqual(["subject"]);
  });
});

describe("même règle — ce qui ne repointe RIEN", () => {
  test("⛔ valeurs identiques à celles enregistrées : aucune édition lue ni touchée", async () => {
    // MUTATION QUI DOIT TUER CE TEST : propager dès que le champ est dans le corps.
    const a = await patcher({ subject: "Sujet", preheader: null, segmentId: null, templateVersionId: V8 });
    expect(a.res.status).toBe(200);
    expect(a.appelsOcc).toHaveLength(0);
    expect(a.json.occurrences).toBeUndefined();

    const b = await patcher(
      { subject: "Sujet", preheader: "P", segmentId: SEG },
      { campagne: campagneDeBase({ preheader: "P", segment_id: SEG }) },
    );
    expect(b.appelsOcc).toHaveLength(0);
  });

  test("« Save audience » sans changer le segment (la case des contacts seule) : rien", async () => {
    const { appelsOcc, json } = await patcher({ segmentId: null, contactsIgnorePurpose: true });
    expect(appelsOcc).toHaveLength(0);
    expect(json.occurrences).toBeUndefined();
  });
});

describe("même règle — mêmes exclusions que la version", () => {
  const INTACTES = [
    "w1", "w2", "f1", "f2", "h1", "c1", "sg1", "s1", "x1", "past1", "nd1",
    "autreCamp", "autreMarque", "autreMarqueF", "autreMarqueH",
  ];

  test("⛔ sujet et segment : statuts, fenêtre de gel, passées, autre campagne, autre marque — intactes", async () => {
    // MUTATIONS QUI DOIVENT TUER CE TEST : retirer de l'écriture `.eq("status", "planned")`,
    // `.eq("asset_id", …)` ou `.gt("scheduled_at", seuil)`.
    const { base, ligne, ligneAvant } = await patcher(
      { subject: "Nouveau sujet", segmentId: SEG2 },
      { campagne: campagneDeBase({ segment_id: SEG }) },
    );
    for (const id of INTACTES) expect(ligne(id)).toEqual(ligneAvant(id));
    expect(base.occurrences.filter((o) => o.subject === "Nouveau sujet").map((o) => o.id).sort()).toEqual(
      [...DEPLACEES].sort(),
    );
  });

  test("⛔ review_* préservés sur une édition relue avant le gel", async () => {
    const { ligne, ligneAvant } = await patcher({ subject: "Nouveau sujet", preheader: "Nouveau preheader" });
    for (const col of ["review_overrides", "review_rev", "review_applied_rev", "review_error", "review_base"]) {
      expect(ligne("p3")[col]).toEqual(ligneAvant("p3")[col]);
    }
    expect(ligne("p3").subject).toBe("Nouveau sujet");
  });

  test("⛔ une campagne verrouillée garde son ciblage ajustable : le segment suit, le contenu reste refusé", async () => {
    const verrou = { locked_at: "2026-09-24T10:00:00Z", segment_id: SEG };
    const ok = await patcher({ segmentId: SEG2 }, { campagne: campagneDeBase(verrou) });
    expect(ok.res.status).toBe(200);
    expect(ok.ligne("p1").segment_id).toBe(SEG2);

    const refus = await patcher({ subject: "Nouveau sujet" }, { campagne: campagneDeBase(verrou) });
    expect(refus.res.status).toBe(409);
    expect(refus.appelsOcc).toHaveLength(0);
  });
});

describe("même règle — les comptes et les échecs", () => {
  test("⛔ une édition qui porte DÉJÀ le nouveau sujet ne « garde » rien : elle n'est pas annoncée", async () => {
    // MUTATION QUI DOIT TUER CE TEST : ne plus sauter les éditions déjà à jour (ou ne tester que la version).
    const jeu = JEU().map((o) => (o.id === "f2" || o.id === "h1" ? { ...o, subject: "Nouveau sujet" } : o));
    const { json } = await patcher({ subject: "Nouveau sujet" }, { occurrences: jeu });
    expect(json.occurrences).toEqual({ moved: 4, skippedInFreezeWindow: 3, held: 0 });
  });

  test("⛔ écriture des éditions en échec ⇒ 207 : la campagne EST enregistrée, les champs sont nommés", async () => {
    const { res, json, base, ligneAvant } = await patcher({ subject: "Nouveau sujet" }, { panne: { ecritureOcc: "boom" } });
    expect(res.status).toBe(207);
    expect(json.occurrencesError).toBe("boom");
    expect(json.occurrences).toBeNull();
    expect(json.occurrencesFields).toEqual(["subject"]);
    expect(base.campagne.subject).toBe("Nouveau sujet");
    for (const o of base.occurrences) expect(o).toEqual(ligneAvant(String(o.id)));
  });

  test("⛔ lecture des éditions en échec ⇒ 207, et rien n'est écrit sur les éditions", async () => {
    const { res, appelsOcc } = await patcher({ segmentId: SEG2 }, { panne: { lectureOcc: "lecture en panne" } });
    expect(res.status).toBe(207);
    expect(appelsOcc.filter((a) => a.op === "update")).toHaveLength(0);
  });

  test("seules les colonnes d'édition connues peuvent être écrites", async () => {
    const { appelsOcc } = await patcher(
      { templateVersionId: V10, subject: "S2", preheader: "P2", segmentId: SEG2, name: "N2" },
      { campagne: campagneDeBase({ segment_id: SEG }) },
    );
    const cles = Object.keys(appelsOcc.find((a) => a.op === "update")!.patch!).filter((k) => k !== "updated_at");
    expect(cles.sort()).toEqual([...COLONNES_D_EDITION].sort());
  });
});
