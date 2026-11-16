/**
 * PIEDS LÉGAUX RÉUTILISABLES — les refus que le serveur porte avant qu'un e-mail parte.
 *
 * ⛔ CE QUE CE BANC EXISTE POUR EMPÊCHER. Un pied légal choisi est lu EN DIRECT à l'envoi. Un choix
 * introuvable qui retomberait sur le pied de l'édition expédierait une autre entité juridique sans le
 * dire ; un pied incomplet mettrait en veto tous les envois qui l'utilisent ; un filtre d'archivage
 * à la publication ferait changer de pied des e-mails que personne n'a touchés.
 *
 * Aucun accès réseau : le client est un double qui enregistre la requête et sert des réponses
 * préparées, dans l'ordre.
 */
import { describe, expect, test } from "bun:test";

// `legal-footer-templates.ts` tire `@/lib/data/templates` → `@/lib/session` → `auth.ts`, qui lève à
// l'import sans AUTH_SECRET : même parade que `brand-partials.test.ts`.
process.env.AUTH_SECRET = "secret-de-test-uniquement-16092026";
const {
  archiveLegalFooterTemplate,
  createLegalFooterTemplate,
  getLegalFooterTemplate,
  legalTemplateIdOf,
  manquantsPourEditions,
  poserChoixLegal,
  resoudreChoixLegal,
  updateLegalFooterTemplate,
} = await import("./legal-footer-templates");
const { heaviestFooterOf } = await import("@/lib/weight");

type Appel = { table: string; methodes: { m: string; args: unknown[] }[] };
type Reponse = { data: unknown; error: unknown };

function fauxDb(...reponses: Reponse[]) {
  const appels: Appel[] = [];
  let i = 0;
  const db = {
    from(table: string) {
      const appel: Appel = { table, methodes: [] };
      appels.push(appel);
      const chaine: unknown = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === "then") {
              const reponse = reponses[i++] ?? { data: null, error: null };
              return (resoudre: (v: unknown) => void) => resoudre(reponse);
            }
            return (...args: unknown[]) => {
              appel.methodes.push({ m: prop, args });
              return chaine;
            };
          },
        },
      );
      return chaine;
    },
  };
  return { db: db as unknown as Parameters<typeof resoudreChoixLegal>[0], appels };
}

const eqs = (a: Appel) => a.methodes.filter((m) => m.m === "eq").map((m) => [m.args[0], m.args[1]]);
const utilise = (a: Appel, m: string) => a.methodes.some((x) => x.m === m);

const ASSET = { id: "asset_tw", name: "Harbor Tech" };
const UUID = "33333333-3333-4333-8333-333333333333";
const COMPLET = { privacy_url: "https://tw.example/privacy", controller: "TW Ltd" };

const ligneTemplate = (config: unknown = COMPLET) => ({
  id: UUID,
  name: "Partner footer",
  config,
  archived_at: null,
  updated_by: null,
  updated_at: "2026-09-16T10:00:00Z",
  created_at: "2026-09-16T10:00:00Z",
});
const edition = (regime: string, market = "GB", language = "en") => ({
  id: `ed_${market}`,
  market,
  language,
  compliance_regime: regime,
  is_primary: true,
  legal_footer: {},
});

const docAvec = (bloc: Record<string, unknown> | null) => ({
  rows: [
    { id: "r1", layout: "1", columns: [{ id: "c1", blocks: [{ id: "t", type: "text", paragraphs: [] }] }] },
    ...(bloc ? [{ id: "r2", layout: "1", columns: [{ id: "c2", blocks: [bloc] }] }] : []),
  ],
}) as unknown as Parameters<typeof legalTemplateIdOf>[0];

describe("manquantsPourEditions — c'est buildFooter qui juge", () => {
  test("une édition GDPR sans privacy_url est nommée, marché et langue compris", () => {
    expect(manquantsPourEditions({}, [{ regime: "gdpr", market: "CL", language: "es" }], "PF")).toEqual([
      "privacy_url (CL · es)",
    ]);
  });

  test("CAN-SPAM exige en plus l'adresse postale", () => {
    const m = manquantsPourEditions({ privacy_url: "https://x.example/p" }, [
      { regime: "canspam", market: "US", language: "en" },
    ], "X");
    expect(m).toEqual(["physical_address (US · en)"]);
  });

  test("une config complète pour chaque édition ne manque de rien", () => {
    expect(
      manquantsPourEditions(COMPLET, [
        { regime: "gdpr", market: "GB", language: "en" },
        { regime: "lgpd", market: "BR", language: "pt-BR" },
      ], "X"),
    ).toEqual([]);
  });
});

describe("legalTemplateIdOf", () => {
  test("lit le choix posé sur le bloc légal", () => {
    expect(legalTemplateIdOf(docAvec({ id: "l", type: "footer_legal", legalTemplateId: UUID }))).toBe(UUID);
  });
  test("bloc légal sans choix, ou pas de bloc : null (= pied de l'édition)", () => {
    expect(legalTemplateIdOf(docAvec({ id: "l", type: "footer_legal" }))).toBeNull();
    expect(legalTemplateIdOf(docAvec(null))).toBeNull();
  });
});

describe("resoudreChoixLegal — les refus avant l'envoi", () => {
  test("aucun choix : pied de l'édition, sans aucune lecture", async () => {
    const { db, appels } = fauxDb();
    expect(await resoudreChoixLegal(db, ASSET, null)).toEqual({ ok: true, templateId: null, cfg: null });
    expect(appels).toHaveLength(0);
  });

  test("lecture en erreur : 503, jamais un repli silencieux", async () => {
    const { db } = fauxDb({ data: null, error: { message: "boom" } });
    const r = await resoudreChoixLegal(db, ASSET, UUID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(503);
  });

  test("template introuvable (autre marque, supprimé) : 422, pas le pied de l'édition", async () => {
    const { db, appels } = fauxDb({ data: null, error: null });
    const r = await resoudreChoixLegal(db, ASSET, UUID);
    expect(r).toMatchObject({ ok: false, status: 422 });
    // La marque filtre la lecture : un id d'une autre marque est un id inexistant.
    expect(eqs(appels[0]!)).toContainEqual(["asset_id", ASSET.id]);
  });

  test("un template ARCHIVÉ reste résolu : la lecture ne filtre pas archived_at", async () => {
    const { db, appels } = fauxDb(
      { data: { ...ligneTemplate(), archived_at: "2026-09-16T11:00:00Z" }, error: null },
      { data: [edition("gdpr")], error: null },
    );
    const r = await resoudreChoixLegal(db, ASSET, UUID);
    expect(r).toEqual({ ok: true, templateId: UUID, cfg: COMPLET });
    expect(utilise(appels[0]!, "is")).toBe(false);
  });

  test("incomplet pour une édition de la marque : 422 qui nomme le champ", async () => {
    const { db } = fauxDb(
      { data: ligneTemplate({ controller: "TW Ltd" }), error: null },
      { data: [edition("gdpr")], error: null },
    );
    const r = await resoudreChoixLegal(db, ASSET, UUID);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(422);
      expect(r.error).toContain("privacy_url (GB · en)");
      expect(r.error).toContain("Partner footer");
    }
  });

  test("éditions illisibles : 503 — « pas vérifié » n'est pas « complet »", async () => {
    const { db } = fauxDb(
      { data: ligneTemplate(), error: null },
      { data: null, error: { message: "boom" } },
    );
    expect(await resoudreChoixLegal(db, ASSET, UUID)).toMatchObject({ ok: false, status: 503 });
  });

  test("config qui n'est pas un objet : illisible (503), jamais « config vide »", async () => {
    const { db } = fauxDb({ data: ligneTemplate([]), error: null });
    expect(await resoudreChoixLegal(db, ASSET, UUID)).toMatchObject({ ok: false, status: 503 });
  });
});

describe("lectures et écritures", () => {
  test("la bibliothèque (sans includeArchived) écarte les archivés", async () => {
    const { db, appels } = fauxDb({ data: ligneTemplate(), error: null });
    await getLegalFooterTemplate(db, UUID, ASSET.id);
    expect(appels[0]!.methodes).toContainEqual({ m: "is", args: ["archived_at", null] });
  });

  test("un id qui n'est pas un uuid ne touche pas la base", async () => {
    const { db, appels } = fauxDb();
    expect(await getLegalFooterTemplate(db, "pas-un-uuid", ASSET.id)).toEqual({ known: true, value: null });
    expect(appels).toHaveLength(0);
  });

  test("poserChoixLegal écrit AUSSI null, et seulement sur un brouillon", async () => {
    const { db, appels } = fauxDb({ data: { id: "v0" }, error: null });
    expect(await poserChoixLegal(db, "v0", null)).toEqual({ ok: true });
    const update = appels[0]!.methodes.find((m) => m.m === "update");
    expect(update?.args[0]).toEqual({ legal_footer_template_id: null });
    expect(eqs(appels[0]!)).toContainEqual(["status", "draft"]);
  });

  test("poserChoixLegal sans ligne touchée : échec, jamais « posé »", async () => {
    const { db } = fauxDb({ data: null, error: null });
    expect((await poserChoixLegal(db, "v0", UUID)).ok).toBe(false);
  });

  test("création : nom déjà pris → 409 name_taken", async () => {
    const { db } = fauxDb({ data: null, error: { code: "23505", message: "dup" } });
    const r = await createLegalFooterTemplate(db, { assetId: ASSET.id, name: "X", config: COMPLET, author: null });
    expect(r).toMatchObject({ ok: false, refusal: { status: 409, kind: "name_taken" } });
  });

  test("mise à jour : le compare-and-swap filtre sur updated_at", async () => {
    const { db, appels } = fauxDb({ data: { updated_at: "t2" }, error: null });
    const r = await updateLegalFooterTemplate(db, {
      id: UUID,
      assetId: ASSET.id,
      config: COMPLET,
      author: null,
      baseUpdatedAt: "t1",
    });
    expect(r).toEqual({ ok: true, updatedAt: "t2" });
    expect(eqs(appels[0]!)).toContainEqual(["updated_at", "t1"]);
    expect(eqs(appels[0]!)).toContainEqual(["asset_id", ASSET.id]);
  });

  test("mise à jour sans ligne touchée, template toujours là : 409 stale", async () => {
    const { db } = fauxDb({ data: null, error: null }, { data: ligneTemplate(), error: null });
    const r = await updateLegalFooterTemplate(db, { id: UUID, assetId: ASSET.id, name: "Y", author: null, baseUpdatedAt: "t0" });
    expect(r).toMatchObject({ ok: false, refusal: { status: 409, kind: "stale" } });
  });

  test("mise à jour sans ligne touchée, template disparu : 404", async () => {
    const { db } = fauxDb({ data: null, error: null }, { data: null, error: null });
    const r = await updateLegalFooterTemplate(db, { id: UUID, assetId: ASSET.id, name: "Y", author: null });
    expect(r).toMatchObject({ ok: false, refusal: { status: 404 } });
  });

  test("archivage sans ligne touchée : 404, jamais « archivé »", async () => {
    const { db } = fauxDb({ data: null, error: null });
    expect(await archiveLegalFooterTemplate(db, UUID, ASSET.id, null)).toMatchObject({ ok: false, status: 404 });
  });
});

describe("heaviestFooterOf — on pèse le pied qui partira", () => {
  const editions = [{ market: "GB", language: "en", compliance_regime: "gdpr", legal_footer: { controller: "Court" } }];

  test("le pied choisi REMPLACE celui de l'édition", () => {
    const choisi = { controller: "Une entité juridique au nom nettement plus long que celui de l'édition" };
    const html = heaviestFooterOf(editions, "TW", choisi);
    expect(html).toContain("Une entité juridique");
    expect(html).not.toContain("Court");
  });

  test("sans choix, c'est le pied de l'édition", () => {
    expect(heaviestFooterOf(editions, "TW")).toContain("Court");
  });

  test("aucune édition : chaîne vide (l'appelant le voit dans footerProvided)", () => {
    expect(heaviestFooterOf([], "TW", COMPLET)).toBe("");
  });
});
