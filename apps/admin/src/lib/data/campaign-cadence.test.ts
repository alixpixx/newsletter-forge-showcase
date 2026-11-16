/**
 * Banc de la résolution « suivre la cadence » côté APERÇU.
 *
 * ⛔ CE QUI SE JOUE ICI : un modèle sert plusieurs campagnes, et c'est déjà le cas en production —
 * « Quartz Tips — Resumo da Semana (importé) » v1 sert deux campagnes. Ce module doit donc trancher
 * entre « je sais quelle période afficher » et « je refuse de choisir », et rendre le MOTIF dans
 * les deux cas. Un motif perdu, c'est un auteur qui relit « sept jours » sans savoir s'il doit
 * armer une récurrence, en choisir une, ou simplement attendre son deuxième envoi.
 *
 * Le double du client journalise ce qui part réellement : les assertions portent sur la forme des
 * requêtes émises (jointure par `template_id`, scoping par marque), pas seulement sur le verdict.
 */
import { describe, expect, test } from "bun:test";

const { cadenceDeCampagne, cadenceDuModele } = await import("./campaign-cadence");

type Requete = { table: string; filtres: Record<string, unknown> };
type Reponse = { data: unknown; error: null | { message: string } };

const ASSET = "aaaaaaaa-0000-0000-0000-000000000001";
const MODELE = "5e82230d-d6de-48ad-b4a1-a87dda9fd62c";
const MAINTENANT = new Date("2026-09-03T12:00:00Z");

/** Une campagne récurrente complète — chaque test n'en modifie que ce qu'il éprouve. */
const campagne = (o: Partial<Record<string, unknown>> = {}) => ({
  id: "c1",
  name: "Resumo da rodada — domingo",
  timezone: "America/Sao_Paulo",
  recurrence_active: true,
  // ⛔ ISO 8601 : dimanche vaut 7, pas 0 (contrainte `campaign_recurrence_days_valid`, migration
  // 0027, et `extract(isodow)` dans la RPC 0025). Un 0 ici ne rendrait aucune occurrence.
  recurrence_days: [7],
  recurrence_time: "20:00",
  recurrence_every_weeks: 1,
  recurrence_anchor: "2026-09-06",
  ...o,
});

/**
 * Les dimanches à 20 h de São Paulo, au format que PostgREST transmet (`+00:00`) — relevé sur la
 * RPC le 03/09. Le rendu texte de Postgres (`+00`) n'est PAS parsable en JS.
 */
const DIMANCHES = [
  { fires_at: "2026-08-23T23:00:00+00:00" },
  { fires_at: "2026-08-30T23:00:00+00:00" },
  { fires_at: "2026-09-06T23:00:00+00:00" },
  { fires_at: "2026-09-13T23:00:00+00:00" },
];

/** Lundi + vendredi : 4 jours puis 3. C'est la cadence qui rend « 7 jours fixes » faux. */
const LUN_VEN = [
  { fires_at: "2026-08-28T12:00:00+00:00" },
  { fires_at: "2026-08-31T12:00:00+00:00" },
  { fires_at: "2026-09-04T12:00:00+00:00" },
  { fires_at: "2026-09-07T12:00:00+00:00" },
];

function fauxDb(
  repondre: (r: Requete) => Reponse,
  occurrences: (params: Record<string, unknown>) => Reponse,
) {
  const journal: Requete[] = [];
  const rpcs: Record<string, unknown>[] = [];

  const from = (table: string) => {
    const ctx: Requete = { table, filtres: {} };
    const terminer = (): Reponse => {
      journal.push(ctx);
      return repondre(ctx);
    };
    const q = {
      select: (_c?: string) => q,
      eq: (k: string, v: unknown) => {
        ctx.filtres[k] = v;
        return q;
      },
      in: (k: string, v: unknown[]) => {
        ctx.filtres[`${k}:in`] = [...v].sort();
        return q;
      },
      is: (k: string, v: unknown) => {
        ctx.filtres[`${k}:is`] = v;
        return q;
      },
      maybeSingle: async () => terminer(),
      then: (resoudre: (v: Reponse) => unknown, rejeter?: (e: unknown) => unknown) => {
        try {
          return Promise.resolve(resoudre(terminer()));
        } catch (e) {
          return rejeter ? Promise.resolve(rejeter(e)) : Promise.reject(e);
        }
      },
    };
    return q;
  };

  const rpc = async (_nom: string, params: Record<string, unknown>) => {
    rpcs.push(params);
    return occurrences(params);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: { from, rpc } as any, journal, rpcs };
}

const OK = (data: unknown): Reponse => ({ data, error: null });

/**
 * Le cas courant : une version publiée, N campagnes qui la servent. Le double APPLIQUE le filtre
 * `archived_at is null` quand la requête le porte — une campagne archivée ne sort que s'il manque.
 */
function dbModele(campagnes: unknown[], occ: Reponse = OK(DIMANCHES)) {
  return fauxDb(
    (r) =>
      r.table === "template_version"
        ? OK([{ id: "v1" }])
        : OK(
            r.filtres["archived_at:is"] === null
              ? campagnes.filter((c) => !(c as { archived_at?: unknown }).archived_at)
              : campagnes,
          ),
    () => occ,
  );
}

/**
 * ⛔ LES ARCHIVÉES NE VOTENT PAS (0077). MUTATION QUI DOIT TUER CE BANC : retirer
 * `.is("archived_at", null)` de `campagnesDuModele`. Une série rangée ferait basculer le vote en
 * « several » ou retournerait le mélange d'un modèle qui n'a plus qu'une campagne vivante.
 */
describe("archivage — une campagne archivée ne compte ni pour la cadence ni pour le mélange", () => {
  test("une série vivante + une archivée d'une autre période ⇒ la période de la vivante, et son nom", async () => {
    const { db, journal } = fauxDb(
      (r) =>
        r.table === "template_version"
          ? OK([{ id: "v1" }])
          : OK(
              [campagne(), campagne({ id: "c2", name: "Friday NL TW", recurrence_days: [1, 5], archived_at: "2026-09-20T08:00:00Z" })].filter(
                (c) => !(r.filtres["archived_at:is"] === null && (c as { archived_at?: unknown }).archived_at),
              ),
            ),
      (p) => OK(Array.isArray(p.p_days) && (p.p_days as number[])[0] === 7 ? DIMANCHES : LUN_VEN),
    );
    const r = await cadenceDuModele(db, MODELE, ASSET, MAINTENANT);
    expect(r.raison).toBe("ok");
    expect(r.jours).toBe(7);
    expect(r.campagne).toBe("Resumo da rodada — domingo");
    expect(journal.find((j) => j.table === "campaign")?.filtres["archived_at:is"]).toBeNull();
  });

  test("le mélange suit la seule campagne vivante", async () => {
    const { melangeDuModele } = await import("./campaign-cadence");
    const { db } = dbModele([
      { id: "c1", name: "Vivante", mix_latest: true },
      { id: "c2", name: "Rangée", mix_latest: false, archived_at: "2026-09-20T08:00:00Z" },
    ]);
    expect(await melangeDuModele(db, MODELE, ASSET)).toEqual({ actif: true, raison: "ok", campagne: "Vivante" });
  });
});

describe("cadenceDuModele — la période que « suivre la cadence » désigne", () => {
  test("une seule campagne récurrente : sa période, et son nom", async () => {
    const { db } = dbModele([campagne()]);
    const r = await cadenceDuModele(db, MODELE, ASSET, MAINTENANT);
    expect(r.raison).toBe("ok");
    expect(r.jours).toBe(7);
    expect(r.campagne).toBe("Resumo da rodada — domingo");
    // La cible est la prochaine échéance À VENIR, pas la dernière passée.
    expect(r.prochain).toBe("2026-09-06T23:00:00+00:00");
  });

  test("⛔ deux campagnes aux périodes différentes : aucune n'est élue", async () => {
    // Le cas de production. Élire la première afficherait une période juste pour l'une et fausse
    // pour l'autre, sans que rien ne distingue les deux à l'écran.
    const { db } = fauxDb(
      (r) =>
        r.table === "template_version"
          ? OK([{ id: "v1" }])
          : // L'une le dimanche (7 jours), l'autre lundi + vendredi (4 puis 3).
            OK([campagne(), campagne({ id: "c2", name: "Friday NL TW", recurrence_days: [1, 5] })]),
      (p) => OK(Array.isArray(p.p_days) && (p.p_days as number[])[0] === 7 ? DIMANCHES : LUN_VEN),
    );
    const r = await cadenceDuModele(db, MODELE, ASSET, MAINTENANT);
    expect(r.raison).toBe("several");
    expect(r.jours).toBe(null);
    expect(r.campagne).toBe(null);
  });

  test("deux campagnes de MÊME période : la période s'applique, sans nommer l'une des deux", async () => {
    const { db } = dbModele([campagne(), campagne({ id: "c2", name: "Friday NL TW" })]);
    const r = await cadenceDuModele(db, MODELE, ASSET, MAINTENANT);
    expect(r.raison).toBe("ok");
    expect(r.jours).toBe(7);
    // ⛔ Nommer une seule des deux laisserait croire que l'autre ne compte pas.
    expect(r.campagne).toBe(null);
  });

  test("une cadence irrégulière rend l'écart du PROCHAIN envoi, pas sept jours", async () => {
    const { db } = dbModele([campagne({ recurrence_days: [1, 5] })], OK(LUN_VEN));
    const r = await cadenceDuModele(db, MODELE, ASSET, MAINTENANT);
    // Prochain = vendredi 04/09 ; précédent = lundi 31/08 ⇒ 4 jours, pas 7.
    expect(r.raison).toBe("ok");
    expect(r.jours).toBe(4);
  });

  test("aucune campagne n'utilise le modèle ⇒ `no-campaign`, jamais une période inventée", async () => {
    const { db } = dbModele([]);
    const r = await cadenceDuModele(db, MODELE, ASSET, MAINTENANT);
    expect(r.raison).toBe("no-campaign");
    expect(r.jours).toBe(null);
  });

  test("des campagnes, aucune récurrence armée ⇒ `not-recurring` — un geste différent", async () => {
    // C'est le cas des 4 campagnes existantes au 03/09. « Personne n'utilise ce modèle » et
    // « personne n'a armé de récurrence » appellent deux actions opposées.
    const { db } = dbModele([campagne({ recurrence_active: false })]);
    const r = await cadenceDuModele(db, MODELE, ASSET, MAINTENANT);
    expect(r.raison).toBe("not-recurring");
  });

  test("une récurrence incomplète ne compte pas comme armée", async () => {
    const { db } = dbModele([campagne({ recurrence_anchor: null })]);
    expect((await cadenceDuModele(db, MODELE, ASSET, MAINTENANT)).raison).toBe("not-recurring");
    const { db: db2 } = dbModele([campagne({ recurrence_days: [] })]);
    expect((await cadenceDuModele(db2, MODELE, ASSET, MAINTENANT)).raison).toBe("not-recurring");
  });

  test("plus aucune échéance à venir ⇒ `no-next`", async () => {
    const { db } = dbModele([campagne()], OK([{ fires_at: "2026-08-30T23:00:00+00:00" }]));
    const r = await cadenceDuModele(db, MODELE, ASSET, MAINTENANT);
    expect(r.raison).toBe("no-next");
  });

  test("le prochain envoi est le premier ⇒ `no-previous`, pas une fenêtre de zéro jour", async () => {
    const { db } = dbModele([campagne()], OK([{ fires_at: "2026-09-06T23:00:00+00:00" }]));
    const r = await cadenceDuModele(db, MODELE, ASSET, MAINTENANT);
    expect(r.raison).toBe("no-previous");
    expect(r.jours).toBe(null);
    // La cible est connue même sans période : l'écran peut dire de quel envoi il parle.
    expect(r.prochain).toBe("2026-09-06T23:00:00+00:00");
  });

  test("⛔ la jointure passe par `template_id`, et la marque borne la recherche", async () => {
    const { db, journal, rpcs } = dbModele([campagne()]);
    await cadenceDuModele(db, MODELE, ASSET, MAINTENANT);
    // Le builder édite le BROUILLON (version 0) alors qu'une campagne pointe une version PUBLIÉE :
    // joindre sur `template_version_id` ne rendrait jamais rien.
    expect(journal[0]).toEqual({ table: "template_version", filtres: { template_id: MODELE } });
    expect(journal[1]?.table).toBe("campaign");
    expect(journal[1]?.filtres.asset_id).toBe(ASSET);
    expect(journal[1]?.filtres["template_version_id:in"]).toEqual(["v1"]);
    // Le fuseau vient de la CAMPAGNE, jamais du serveur.
    expect(rpcs[0]?.p_timezone).toBe("America/Sao_Paulo");
  });
});

describe("cadenceDeCampagne — quand l'appelant sait de quelle campagne il parle", () => {
  test("scope par marque : une campagne d'une autre marque est introuvable", async () => {
    const { db, journal } = fauxDb(() => OK(null), () => OK(DIMANCHES));
    const r = await cadenceDeCampagne(db, "c1", ASSET, MAINTENANT);
    expect(r.raison).toBe("not-found");
    expect(journal[0]?.filtres).toEqual({ id: "c1", asset_id: ASSET });
  });

  test("une campagne récurrente rend sa période", async () => {
    const { db } = fauxDb(() => OK(campagne()), () => OK(DIMANCHES));
    const r = await cadenceDeCampagne(db, "c1", ASSET, MAINTENANT);
    expect(r.raison).toBe("ok");
    expect(r.jours).toBe(7);
  });
});

/**
 * L'INTERRUPTEUR DE MÉLANGE VU DEPUIS LE BUILDER (04/09/2026).
 *
 * ⛔ CE QUI SE JOUE ICI : le builder s'ouvre depuis la LISTE DES MODÈLES et n'a jamais de campagne
 * sous la main, alors que le réglage vit dans la campagne. Il faut donc remonter du modèle aux
 * campagnes qui l'emploient — et trancher quand elles ne sont pas d'accord.
 *
 * Le désaccord n'est pas théorique : « Friday NL TW » et « Resumo da rodada — domingo » partagent
 * la version 509c87c3 en production. Appliquer le réglage de l'une rendrait un aperçu juste pour
 * elle et faux pour l'autre — sans que rien ne le signale à l'écran.
 */
describe("melangeDuModele — l'unanimité, ou rien", () => {
  const mixte = (o: Partial<Record<string, unknown>> = {}) => ({
    id: "c1",
    name: "Resumo da rodada — domingo",
    mix_latest: true,
    ...o,
  });

  test("une seule campagne : son réglage, et son nom", async () => {
    const { melangeDuModele } = await import("./campaign-cadence");
    const { db } = dbModele([mixte()]);
    const r = await melangeDuModele(db, MODELE, ASSET);
    expect(r).toEqual({ actif: true, raison: "ok", campagne: "Resumo da rodada — domingo" });
  });

  test("plusieurs campagnes D'ACCORD : le réglage passe, sans nommer une seule d'entre elles", async () => {
    const { melangeDuModele } = await import("./campaign-cadence");
    const { db } = dbModele([mixte(), mixte({ id: "c2", name: "Friday NL TW" })]);
    const r = await melangeDuModele(db, MODELE, ASSET);
    // ⛔ `campagne: null` — en nommer une laisserait croire que l'autre ne compte pas.
    expect(r).toEqual({ actif: true, raison: "ok", campagne: null });
  });

  /**
   * ⛔ LE CAS DE PRODUCTION. Deux campagnes du même modèle, réglées différemment.
   * MUTATION QUI DOIT TUER CE TEST : élire `lignes[0]` au lieu de refuser.
   */
  test("⛔ deux campagnes en désaccord : aucune n'est élue", async () => {
    const { melangeDuModele } = await import("./campaign-cadence");
    const { db } = dbModele([mixte(), mixte({ id: "c2", name: "Friday NL TW", mix_latest: false })]);
    const r = await melangeDuModele(db, MODELE, ASSET);
    expect(r).toEqual({ actif: null, raison: "several", campagne: null });
  });

  test("aucune campagne n'utilise ce modèle : le motif le dit, ce n'est pas « pas de mélange »", async () => {
    const { melangeDuModele } = await import("./campaign-cadence");
    const { db } = dbModele([]);
    // ⛔ « personne ne porte de réglage » et « le réglage est off » appellent deux gestes
    // différents : créer une campagne, ou cocher la case. Un `false` nu les confondrait.
    expect(await melangeDuModele(db, MODELE, ASSET)).toEqual({
      actif: null,
      raison: "no-campaign",
      campagne: null,
    });
  });

  /**
   * ⛔ TEST NÉ D'UNE MUTATION SURVIVANTE (04/09). Une campagne à `null` est OFF, une à `true` est
   * ON : c'est un désaccord. Une lecture assouplie (`!== false`) les rangeait du même côté, et le
   * verdict retombait ensuite sur la valeur de la première — le mélange s'éteignait pour celle qui
   * l'avait allumé, sans que rien ne le signale.
   */
  test("⛔ `null` contre `true`, c'est un désaccord — pas un accord sur « on »", async () => {
    const { melangeDuModele } = await import("./campaign-cadence");
    const { db } = dbModele([mixte({ mix_latest: null }), mixte({ id: "c2", name: "Friday NL TW" })]);
    expect((await melangeDuModele(db, MODELE, ASSET)).raison).toBe("several");
  });

  test("`mix_latest` absent ou nul se lit « off », jamais « on »", async () => {
    const { melangeDuModele } = await import("./campaign-cadence");
    const nul = dbModele([mixte({ mix_latest: null })]);
    expect((await melangeDuModele(nul.db, MODELE, ASSET)).actif).toBe(false);
    const absent = dbModele([{ id: "c1", name: "X" }]);
    expect((await melangeDuModele(absent.db, MODELE, ASSET)).actif).toBe(false);
  });

  /**
   * ⛔ MÊME JOINTURE QUE LA CADENCE : par `template_version.template_id`, jamais par
   * `template_version_id`. Le builder édite le brouillon v0, une campagne pointe une version
   * publiée — joindre sur la version ne rendrait jamais rien, en silence.
   */
  test("la remontée passe par les VERSIONS du modèle, et reste scopée à la marque", async () => {
    const { melangeDuModele } = await import("./campaign-cadence");
    const { db, journal } = dbModele([mixte()]);
    await melangeDuModele(db, MODELE, ASSET);
    const versions = journal.find((r) => r.table === "template_version");
    const campagnes = journal.find((r) => r.table === "campaign");
    expect(versions?.filtres.template_id).toBe(MODELE);
    expect(campagnes?.filtres.asset_id).toBe(ASSET);
    expect(campagnes?.filtres["template_version_id:in"]).toEqual(["v1"]);
  });

  test("une base qui refuse rend `not-found`, jamais un « off » inventé", async () => {
    const { melangeDuModele } = await import("./campaign-cadence");
    const { db } = fauxDb(
      (r) => (r.table === "template_version" ? OK([{ id: "v1" }]) : { data: null, error: { message: "boom" } }),
      () => OK([]),
    );
    expect(await melangeDuModele(db, MODELE, ASSET)).toEqual({
      actif: null,
      raison: "not-found",
      campagne: null,
    });
  });
});

describe("melangeDeCampagne — quand l'appelant sait de qui il parle", () => {
  test("le réglage de cette campagne, et son nom", async () => {
    const { melangeDeCampagne } = await import("./campaign-cadence");
    const { db, journal } = fauxDb(() => OK({ id: "c1", name: "Friday NL TW", mix_latest: true }), () => OK([]));
    const r = await melangeDeCampagne(db, "c1", ASSET);
    expect(r).toEqual({ actif: true, raison: "ok", campagne: "Friday NL TW" });
    // ⛔ Scopée à la marque : une campagne d'une autre marque doit être indiscernable d'une absente.
    expect(journal[0]?.filtres.asset_id).toBe(ASSET);
  });

  test("campagne introuvable : `not-found`, pas « pas de mélange »", async () => {
    const { melangeDeCampagne } = await import("./campaign-cadence");
    const { db } = fauxDb(() => OK(null), () => OK([]));
    expect(await melangeDeCampagne(db, "c1", ASSET)).toEqual({
      actif: null,
      raison: "not-found",
      campagne: null,
    });
  });
});
