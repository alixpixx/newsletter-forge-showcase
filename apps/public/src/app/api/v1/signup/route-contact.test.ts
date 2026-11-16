/**
 * LA ROUTE D'INSCRIPTION, EN ENTIER, SUR LE MODE CONTACT (0088, lot E3).
 *
 * ⛔ POURQUOI UN BANC DE ROUTE, ALORS QUE LA DÉCISION EST DÉJÀ SOUS BANC (`decideSignup`). La
 * décision dit QUOI faire ; c'est la route qui l'écrit. Un statut pris en dur au lieu de
 * `seq.createStatus`, une barrière de consentement restée en travers, un `consent_version_id` recopié
 * ou un prénom rafraîchi sur une ligne qu'on promet de ne pas toucher : aucun banc de `capture.ts` ne
 * les voit. Ici, la base est en mémoire et c'est ce qu'elle CONTIENT après l'appel qui est lu.
 *
 * Ce qui se tient, en une phrase chacun :
 *  · un contact n'écrit AUCUNE preuve d'opt-in, AUCUN jeton, AUCUN e-mail ;
 *  · une souscription existante (active, pending, désinscrite) ressort IDENTIQUE, octet pour octet ;
 *  · une adresse sous suppression COMPLÈTE est refusée, même venue du popup ;
 *  · contre-épreuve : sans le mode, la même entrée écrit bien preuve, jeton et e-mail — le banc
 *    sait donc les voir.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { fausseBasePostgrest, type Ligne } from "@/lib/faux-postgrest";

let base: ReturnType<typeof fausseBasePostgrest> | null = null;
mock.module("@/lib/supabase", () => ({ getDb: () => base?.db ?? null }));
const { POST } = await import("./route");

const SECRET = "secret-de-banc-0123456789";
const ASSET = "asset-pixel-daily";
const EDITION = "edition-pixel-daily-br";
const SUBR = "subscriber-1";
const ADRESSE = "leitora@example.org";

const envAvant = { secret: process.env.NF_INGEST_SECRET, base: process.env.PUBLIC_BASE_URL };
beforeAll(() => {
  process.env.NF_INGEST_SECRET = SECRET;
  process.env.PUBLIC_BASE_URL = "https://nf.example.org";
});
afterAll(() => {
  process.env.NF_INGEST_SECRET = envAvant.secret;
  process.env.PUBLIC_BASE_URL = envAvant.base;
});

function monter(o: { existante?: Ligne; supprime?: boolean } = {}) {
  base = fausseBasePostgrest(
    {
      asset: [{ id: ASSET, name: "Pixel Daily", slug: "pixel-daily" }],
      asset_edition: [
        {
          id: EDITION, asset_id: ASSET, language: "pt-BR", market: "BR", compliance_regime: "lgpd",
          consent_mode: "single", slug: "br", is_primary: true, created_at: "2026-01-01T00:00:00Z",
        },
      ],
      consent_version: [{ id: "cv-1", asset_id: ASSET, effective_from: "2026-01-01T00:00:00Z" }],
      subscriber: o.existante ? [{ id: SUBR, email: ADRESSE, first_name: "Ana" }] : [],
      subscription: o.existante ? [{ id: "sub-1", subscriber_id: SUBR, asset_id: ASSET, edition_id: EDITION, ...o.existante }] : [],
    },
    {
      rpc: (nom) => {
        if (nom === "signup_rate_take") return { allowed: true };
        if (nom === "is_suppressed" || nom === "is_hard_suppressed") return o.supprime === true;
        return null;
      },
    },
  );
  return base;
}

async function envoyer(corps: Record<string, unknown>, o: { pont?: boolean } = {}) {
  const res = await POST(
    new Request("https://nf.example.org/api/v1/signup", {
      method: "POST",
      headers: { "content-type": "application/json", ...(o.pont === false ? {} : { "x-nf-ingest-secret": SECRET }) },
      body: JSON.stringify(corps),
    }),
  );
  return { status: res.status, corps: (await res.json()) as Record<string, unknown> };
}

const contact = (extra: Record<string, unknown> = {}) => ({
  email: ADRESSE,
  first_name: "Beatriz",
  asset: "pixel-daily",
  mode: "contact",
  source_detail: { origin: "optinforge", lead_id: "lead-1" },
  capture: { v: 2, lead_id: "lead-1" },
  ...extra,
});

const lignes = (f: ReturnType<typeof monter>, t: string) => f.tables[t] ?? [];
const rpcAppelees = (f: ReturnType<typeof monter>) => f.appels.filter((a) => a.cible.startsWith("rpc:")).map((a) => a.cible);

describe("mode contact — nouvelle adresse", () => {
  /**
   * ⛔ MUTATIONS QUI DOIVENT LE TUER : statut `pending` en dur à l'insert ; barrière `consent`
   * restée en travers (422) ; `consent_version_id` recopié ; `content` forcé dans les finalités.
   */
  test("sans consentement ⇒ souscription `contact`, 0 preuve, 0 jeton, 0 e-mail, l'événement de capture écrit", async () => {
    const f = monter();
    const r = await envoyer(contact());
    expect(r.status).toBe(200);
    expect(lignes(f, "subscription")).toHaveLength(1);
    const s = lignes(f, "subscription")[0]!;
    expect(s.status).toBe("contact");
    expect(s.granted_purposes).toEqual({});
    expect(s.consent_version_id).toBeNull();
    expect(s.tracking_consent).toBe(false);
    expect(lignes(f, "consent_event")).toHaveLength(0);
    expect(lignes(f, "doi_token")).toHaveLength(0);
    expect(f.outbox()).toHaveLength(0);
    expect(lignes(f, "capture_event")).toHaveLength(1);
    // L'écho du contrat v2 : l'émetteur asserte ces deux identifiants.
    expect(r.corps.subscription_id).toBe(s.id as string);
    expect(r.corps.capture_event_id).toBe(lignes(f, "capture_event")[0]!.id as string);
    // ⛔ ET LE MODE APPLIQUÉ : l'émetteur refuse un contact dont l'écho ne dit pas `contact`.
    expect(r.corps.mode).toBe("contact");
  });

  test("les finalités transmises sont gardées telles quelles, sans `content` ajouté", async () => {
    const f = monter();
    await envoyer(contact({ granted_purposes: { offers: true, events: false } }));
    expect(lignes(f, "subscription")[0]!.granted_purposes).toEqual({ offers: true, events: false });
  });

  test("un consentement au suivi envoyé n'est pas écrit : rien n'en porterait la preuve", async () => {
    const f = monter();
    await envoyer(contact({ tracking_consent: true, consent: true }));
    const s = lignes(f, "subscription")[0]!;
    expect(s.tracking_consent).toBe(false);
    expect(s.tracking_consent_at).toBeNull();
    expect(lignes(f, "consent_event")).toHaveLength(0);
    expect(f.outbox()).toHaveLength(0);
  });
});

describe("mode contact — une souscription existante ne bouge pas", () => {
  for (const status of ["active", "pending", "unsubscribed"]) {
    /**
     * ⛔ MUTATIONS QUI DOIVENT LE TUER : laisser le contact tomber dans la branche d'inscription
     * (un désinscrit repasserait `pending` et recevrait un lien) ; rafraîchir le prénom.
     */
    test(`« ${status} » ⇒ ligne et abonné identiques, seul l'événement de capture s'ajoute`, async () => {
      const f = monter({
        existante: {
          status, granted_purposes: { content: true }, tracking_consent: true,
          tracking_consent_at: "2026-02-01T00:00:00Z", consent_version_id: "cv-1", source_detail: {},
        },
      });
      const avantSouscription = structuredClone(lignes(f, "subscription"));
      const avantAbonne = structuredClone(lignes(f, "subscriber"));
      const r = await envoyer(contact());
      expect(r.status).toBe(200);
      expect(lignes(f, "subscription")).toEqual(avantSouscription);
      expect(lignes(f, "subscriber")).toEqual(avantAbonne);
      expect(lignes(f, "consent_event")).toHaveLength(0);
      expect(lignes(f, "doi_token")).toHaveLength(0);
      expect(f.outbox()).toHaveLength(0);
      expect(lignes(f, "capture_event")).toHaveLength(1);
      expect(r.corps.subscription_id).toBe("sub-1");
      expect(r.corps.mode).toBe("contact");
    });
  }
});

describe("mode contact — les tags suivent la même règle", () => {
  const touchesTags = (f: ReturnType<typeof monter>) =>
    f.appels.filter((a) => a.cible === "tag" || a.cible === "subscription_tag").length;
  // Corps v1 (sans `capture`) : c'est le seul chemin où des intérêts deviennent des tags.
  const avecInterets = () => {
    const { capture: _capture, ...v1 } = contact({ interests: ["futebol"] });
    return v1;
  };

  /** ⛔ MUTATION QUI DOIT LE TUER : poser les tags sans lire `seq.applyTags`. */
  test("souscription existante ⇒ aucun tag posé", async () => {
    const f = monter({ existante: { status: "active", granted_purposes: { content: true }, source_detail: {} } });
    expect((await envoyer(avecInterets())).status).toBe(200);
    expect(touchesTags(f)).toBe(0);
  });

  test("contre-épreuve : nouveau contact ⇒ les intérêts v1 sont bien posés (le banc les voit)", async () => {
    const f = monter();
    expect((await envoyer(avecInterets())).status).toBe(200);
    expect(touchesTags(f)).toBeGreaterThan(0);
  });
});

describe("mode contact — les portes", () => {
  /** ⛔ MUTATION QUI DOIT LE TUER : ne pas passer le mode à `verificationSuppression`. */
  test("adresse sous suppression, venue du popup ⇒ rien n'est créé, et c'est `is_suppressed` qui a été demandé", async () => {
    const f = monter({ supprime: true });
    const r = await envoyer(contact());
    expect(r.status).toBe(200);
    expect(r.corps.capture_event_id).toBeNull();
    // L'écho de suppression porte lui aussi le mode : c'est le même contrat, clé pour clé.
    expect(r.corps.mode).toBe("contact");
    expect(lignes(f, "subscription")).toHaveLength(0);
    expect(lignes(f, "subscriber")).toHaveLength(0);
    expect(rpcAppelees(f)).toContain("rpc:is_suppressed");
    expect(rpcAppelees(f)).not.toContain("rpc:is_hard_suppressed");
  });

  test("un mode inconnu ⇒ 422 nommé, rien n'est écrit", async () => {
    const f = monter();
    const r = await envoyer(contact({ mode: "contacts" }));
    expect(r.status).toBe(422);
    expect(r.corps.error).toBe("mode-inconnu");
    expect(lignes(f, "subscription")).toHaveLength(0);
    expect(f.outbox()).toHaveLength(0);
  });

  test("un appelant anonyme ⇒ rien n'est écrit", async () => {
    const f = monter();
    await envoyer(contact(), { pont: false });
    expect(lignes(f, "subscription")).toHaveLength(0);
    expect(lignes(f, "subscriber")).toHaveLength(0);
    expect(f.outbox()).toHaveLength(0);
  });
});

describe("contre-épreuve — sans le mode, le banc voit bien preuve, jeton et e-mail", () => {
  test("même entrée avec `consent: true` et sans `mode` ⇒ pending, 1 preuve, 1 jeton, 1 e-mail", async () => {
    const f = monter();
    const { mode: _mode, ...inscription } = contact({ consent: true });
    const r = await envoyer(inscription);
    expect(r.status).toBe(200);
    expect(lignes(f, "subscription")[0]!.status).toBe("pending");
    expect(lignes(f, "consent_event")).toHaveLength(1);
    expect(lignes(f, "doi_token")).toHaveLength(1);
    expect(f.outbox()).toHaveLength(1);
    // ⛔ MUTATION QUI DOIT LE TUER : un écho qui rendrait `contact` en dur. Sans le mode, c'est
    //    une inscription, et l'écho doit le dire.
    expect(r.corps.mode).toBe("subscribe");
  });

  test("sans le mode ni le consentement ⇒ 422 `consentement-requis`, comme avant", async () => {
    const f = monter();
    const { mode: _mode, ...inscription } = contact();
    const r = await envoyer(inscription);
    expect(r.status).toBe(422);
    expect(r.corps.error).toBe("consentement-requis");
    expect(lignes(f, "subscription")).toHaveLength(0);
  });
});
