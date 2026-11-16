/**
 * Banc de « Create editable versions for all brands » (décision d'Alix du 22/09/2026).
 *
 * ⛔ CE QUI EST EN JEU : l'e-mail qu'une marque a DÉJÀ réglé. Si l'action écrasait un rattachement,
 * la marque enverrait dès le lendemain un e-mail générique qu'elle n'a pas écrit, sans que rien ne
 * le lui dise. Deux barrières le tiennent (lecture préalable + INSERT seul) ; chacune a son test, et
 * chacune a été retirée une fois pour voir ce test tomber.
 *
 * Aucun accès réseau, aucune écriture : un faux client rend des réponses préparées, et la création
 * est une fonction de banc qui ne fait que compter.
 */
import { describe, expect, test } from "bun:test";
import { ecrit, fauxDb, type ReponseDb } from "./testing/faux-db";
import { semerToutesLesMarques, type DepsSemis } from "./lifecycle-seed-all";
import { lifecycleStarterDoc } from "./lifecycle-starter";

const ok = (data: unknown): ReponseDb => ({ data, error: null });
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

/** Les lectures préalables, dans l'ordre où le module les fait. */
function lectures(p: { liens: { asset_id: string; kind: string }[] }): ReponseDb[] {
  return [
    ok([
      { id: A, slug: "quartz-tips", name: "Quartz Tips", languages: ["pt-BR"] },
      { id: B, slug: "northwind-sports", name: "Northwind Sports", languages: ["en"] },
    ]),
    ok(p.liens),
    ok([
      { asset_id: A, language: "en", is_primary: false },
      { asset_id: A, language: "pt-BR", is_primary: true },
      { asset_id: B, language: "pt-BR", is_primary: true },
    ]),
    // Modèles publiés : pour A, un e-mail de bienvenue (ignoré : c'est un cycle de vie) puis une newsletter.
    ok([
      { asset_id: A, category: "welcome", current_version_id: "v-welcome", updated_at: "2026-09-22" },
      { asset_id: A, category: "newsletter", current_version_id: "v-news", updated_at: "2026-09-20" },
    ]),
    ok([{ id: "v-news", doc: { theme: { brandColor: "#0A7B3E" } } }]),
  ];
}

function creation() {
  const appels: { asset: string; kind: string; locale: string; theme: unknown }[] = [];
  const retires: string[] = [];
  let n = 0;
  const deps: Pick<DepsSemis, "creer" | "retirer"> = {
    creer: async ({ marque, kind, locale, theme }) => {
      appels.push({ asset: marque.id, kind, locale, theme });
      return { ok: true, id: `tpl-${++n}` };
    },
    retirer: async (id) => {
      retires.push(id);
      return true;
    },
  };
  return { appels, retires, deps };
}

describe("l'action toutes marques n'écrase JAMAIS un rattachement", () => {
  /**
   * ⛔ MUTATIONS QUI DOIVENT LE TUER : (1) retirer la lecture préalable des rattachements ;
   * (2) poser le rattachement par `upsert` au lieu d'un `insert`.
   */
  test("une fente déjà servie n'est ni recréée ni touchée ; les cinq autres sont semées par INSERT", async () => {
    const insertions = Array.from({ length: 5 }, () => ok(null));
    const { db, appels: requetes, restantes } = fauxDb<DepsSemis["db"]>(
      ...lectures({ liens: [{ asset_id: A, kind: "welcome" }] }),
      ...insertions,
    );
    const c = creation();
    const r = await semerToutesLesMarques({ db, author: "demo-admin@x.invalid", ...c.deps });

    expect(r.known).toBe(true);
    expect(restantes()).toBe(0);

    // Barrière 1 : aucun modèle n'est même CRÉÉ pour la fente prise.
    expect(c.appels.some((a) => a.asset === A && a.kind === "welcome")).toBe(false);
    expect(c.appels).toHaveLength(5);

    // Barrière 2 : chaque écriture de rattachement est un INSERT, et aucune ne vise la fente prise.
    const liens = requetes.filter((q) => q.table === "lifecycle_template" && ecrit(q));
    expect(liens).toHaveLength(5);
    for (const q of liens) {
      const methodes = q.methodes.map((m) => m.m);
      expect(methodes).toContain("insert");
      expect(methodes).not.toContain("upsert");
      expect(methodes).not.toContain("update");
      expect(methodes).not.toContain("delete");
      const ligne = q.methodes.find((m) => m.m === "insert")!.args[0] as { asset_id: string; kind: string };
      expect(`${ligne.asset_id}:${ligne.kind}`).not.toBe(`${A}:welcome`);
    }

    const welcomeA = r.lignes.find((l) => l.assetId === A && l.kind === "welcome");
    expect(welcomeA?.statut).toBe("already_bound");
    expect(r.lignes.filter((l) => l.statut === "created")).toHaveLength(5);
  });

  test("⛔ la fente `reengagement` n'est plus semée : la relance est une automation du moteur", async () => {
    const { db } = fauxDb<DepsSemis["db"]>(...lectures({ liens: [] }), ...Array.from({ length: 6 }, () => ok(null)));
    const c = creation();
    const r = await semerToutesLesMarques({ db, author: null, ...c.deps });
    expect([...new Set(c.appels.map((a) => a.kind))]).toEqual(["confirmation", "welcome", "unsubscribe_ack"]);
    expect(r.lignes.some((l) => l.kind === "reengagement")).toBe(false);
  });

  test("rejouée quand tout est rattaché : rien n'est créé, rien n'est écrit", async () => {
    const tout = [A, B].flatMap((asset_id) =>
      ["confirmation", "welcome", "unsubscribe_ack", "reengagement"].map((kind) => ({ asset_id, kind })),
    );
    const { db, appels: requetes } = fauxDb<DepsSemis["db"]>(...lectures({ liens: tout }));
    const c = creation();
    const r = await semerToutesLesMarques({ db, author: null, ...c.deps });
    expect(c.appels).toHaveLength(0);
    expect(requetes.filter(ecrit)).toHaveLength(0);
    expect(r.lignes.every((l) => l.statut === "already_bound")).toBe(true);
    expect(r.lignes).toHaveLength(6);
  });

  test("⛔ la course : une fente prise ENTRE la lecture et l'écriture garde le modèle de l'autre", async () => {
    // Seule la marque B, un seul kind libre (confirmation) ; l'INSERT bute sur la clé primaire.
    const liens = [
      { asset_id: A, kind: "confirmation" }, { asset_id: A, kind: "welcome" },
      { asset_id: A, kind: "unsubscribe_ack" }, { asset_id: A, kind: "reengagement" },
      { asset_id: B, kind: "welcome" }, { asset_id: B, kind: "unsubscribe_ack" }, { asset_id: B, kind: "reengagement" },
    ];
    const { db, appels: requetes, restantes } = fauxDb<DepsSemis["db"]>(
      ...lectures({ liens }),
      { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } },
    );
    const c = creation();
    const r = await semerToutesLesMarques({ db, author: null, ...c.deps });

    expect(restantes()).toBe(0);
    expect(c.appels.map((a) => `${a.asset}:${a.kind}`)).toEqual([`${B}:confirmation`]);
    // Le modèle neuf, rattaché à rien, est retiré ; aucun second essai d'écriture (pas d'upsert de repli).
    expect(c.retires).toEqual(["tpl-1"]);
    expect(requetes.filter((q) => q.table === "lifecycle_template" && ecrit(q))).toHaveLength(1);
    expect(r.lignes.find((l) => l.assetId === B && l.kind === "confirmation")?.statut).toBe("taken_meanwhile");
  });

  test("⛔ une lecture ratée des rattachements n'est pas « rien de rattaché » : RIEN n'est créé", async () => {
    const [marques] = lectures({ liens: [] });
    const { db, appels: requetes } = fauxDb<DepsSemis["db"]>(marques!, { data: null, error: { message: "boom" } });
    const c = creation();
    const r = await semerToutesLesMarques({ db, author: null, ...c.deps });
    expect(r.known).toBe(false);
    expect(c.appels).toHaveLength(0);
    expect(requetes.filter(ecrit)).toHaveLength(0);
  });
});

describe("le thème de marque dans le document de départ", () => {
  test("un thème valide est appliqué ; un thème refusé par le schéma retombe sur le défaut, sans échouer", () => {
    const avec = lifecycleStarterDoc("welcome", { assetSlug: "quartz-tips", locale: "pt-BR", theme: { brandColor: "#0A7B3E" } });
    expect(avec.theme.brandColor).toBe("#0A7B3E");
    const refuse = lifecycleStarterDoc("welcome", { assetSlug: "quartz-tips", locale: "pt-BR", theme: { brandColor: "rose" } });
    expect(refuse.theme.brandColor).toBe(lifecycleStarterDoc("welcome", { assetSlug: "quartz-tips", locale: "pt-BR" }).theme.brandColor);
  });
});

describe("chaque marque reçoit sa langue et ses couleurs", () => {
  test("langue de l'édition PRINCIPALE, thème de la newsletter publiée (pas celui d'un cycle de vie)", async () => {
    const { db } = fauxDb<DepsSemis["db"]>(...lectures({ liens: [] }), ...Array.from({ length: 8 }, () => ok(null)));
    const c = creation();
    await semerToutesLesMarques({ db, author: null, ...c.deps });

    const deA = c.appels.filter((a) => a.asset === A);
    const deB = c.appels.filter((a) => a.asset === B);
    expect(deA).toHaveLength(3);
    for (const a of deA) {
      expect(a.locale).toBe("pt-BR");
      expect(a.theme).toEqual({ brandColor: "#0A7B3E" });
    }
    // B n'a aucun modèle publié : thème par défaut du builder (aucun thème transmis).
    for (const a of deB) {
      expect(a.locale).toBe("pt-BR");
      expect(a.theme).toBeUndefined();
    }
  });
});
