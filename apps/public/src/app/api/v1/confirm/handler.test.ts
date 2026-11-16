/**
 * Le bouton de `/confirm` — la confirmation d'un double opt-in par un GESTE (24/09/2026).
 *
 * Base en mémoire (`lib/faux-postgrest.ts`) : l'écriture conditionnelle de l'activation s'y applique
 * VRAIMENT, donc un second clic trouve la souscription déjà active, exactement comme en production.
 * Ce qui compte : le POST valide fait tout ce que le GET faisait (active, preuve, jeton consommé,
 * bienvenue), une seule fois ; un lien expiré, inconnu ou effacé n'écrit rien.
 */
import { describe, expect, test } from "bun:test";
import { sha256 } from "@nf/tokens";
import { fausseBasePostgrest, type Appel, type Ligne, type Panne } from "@/lib/faux-postgrest";
import { handleConfirmation } from "./handler";

const SUB = "11111111-1111-4111-8111-111111111111";
const ASSET = "ed806139-74f6-46e9-9769-7c0bc005789a";
const ADRESSE = "lecteur@example.invalid";
const JETON = "jeton-brut-de-test";
const DEMAIN = "2099-01-01T00:00:00Z";

function souscription(p: Ligne = {}): Ligne {
  return {
    id: SUB,
    status: "pending",
    asset_id: ASSET,
    consent_version_id: "cv-1",
    granted_purposes: { content: true, offers: true, events: false },
    language: "es",
    source_detail: {},
    subscriber: { email: ADRESSE },
    asset: { name: "Copper Kettle" },
    ...p,
  };
}

function monter(o: { sub?: Ligne | null; jeton?: Ligne; panne?: (a: Appel) => Panne } = {}) {
  const sub = o.sub === undefined ? souscription() : o.sub;
  return fausseBasePostgrest(
    {
      subscription: sub ? [sub] : [],
      doi_token: [
        { id: "tok-1", subscription_id: SUB, token_hash: sha256(JETON), expires_at: DEMAIN, confirmed_at: null, ...o.jeton },
      ],
      asset_edition: [{ asset_id: ASSET, market: "CL", compliance_regime: "gdpr", language: "es" }],
    },
    { panne: o.panne },
  );
}

async function cliquer(
  f: ReturnType<typeof monter>,
  corps: Record<string, unknown> = { token: JETON, lang: "es" },
  o: { enTetes?: Record<string, string>; env?: Record<string, string> } = {},
) {
  const reportees: (() => Promise<void>)[] = [];
  const res = await handleConfirmation(
    new Request("http://x/api/v1/confirm", { method: "POST", body: JSON.stringify(corps), headers: o.enTetes }),
    {
      getDb: () => f.db as never,
      signUnsub: (id) => `signe:${id}`,
      apres: (t) => void reportees.push(t),
      env: o.env ?? {},
    },
  );
  const corpsRendu = (await res.json()) as { etat?: string };
  return { status: res.status, etat: corpsRendu.etat, reportees };
}

const ecritures = (f: ReturnType<typeof monter>) =>
  f.appels.filter((a) => a.cible.startsWith("rpc:") || a.methodes.some((m) => m.m === "update" || m.m === "insert"));
const preuves = (f: ReturnType<typeof monter>) => f.tables.consent_event ?? [];

describe("le POST valide fait ce que le GET faisait — une fois", () => {
  test("⛔ souscription active, jeton consommé, preuve par finalité, UN bienvenue dans la langue de la souscription", async () => {
    const f = monter();
    const r = await cliquer(f);
    expect(r.status).toBe(200);
    expect(r.etat).toBe("fait");

    const sub = f.tables.subscription[0]!;
    expect(sub.status).toBe("active");
    expect(sub.consent_state).toBe(true);
    expect(sub.consent_method).toBe("widget_doi");
    expect(typeof sub.consent_at).toBe("string");
    expect(typeof f.tables.doi_token[0]!.confirmed_at).toBe("string");

    // Une preuve parapluie + un `granted` par finalité accordée (content, offers — pas events).
    expect(preuves(f).map((p) => `${p.event_type}:${p.purpose ?? "-"}`)).toEqual([
      "optin_confirm:-",
      "granted:content",
      "granted:offers",
    ]);
    expect(preuves(f)[0]!.legal_basis).toBe("consent");
    expect(preuves(f)[0]!.country).toBe("CL");

    expect(f.outbox()).toHaveLength(1);
    const bienvenue = f.outbox()[0]!;
    expect(bienvenue.kind).toBe("welcome");
    expect(bienvenue.to_email).toBe(ADRESSE);
    expect(bienvenue.subscription_id).toBe(SUB);
    expect(bienvenue.payload).toEqual({ unsub_token: `signe:${SUB}` });
    // Langue de la SOUSCRIPTION (`es`) : la marque est dans l'objet.
    expect(String(bienvenue.subject)).toContain("Copper Kettle");

    // La levée des suppressions volontaires (0073) est bien demandée.
    expect(f.appels.some((a) => a.cible === "rpc:lift_voluntary_suppression")).toBe(true);
  });

  test("⛔ l'activation précède la preuve, qui précède le bienvenue", async () => {
    const f = monter();
    await cliquer(f);
    const i = (cible: string, m: string) => f.appels.findIndex((a) => a.cible === cible && a.methodes.some((x) => x.m === m));
    expect(i("subscription", "update")).toBeGreaterThan(-1);
    expect(i("consent_event", "insert")).toBeGreaterThan(i("subscription", "update"));
    expect(i("email_outbox", "insert")).toBeGreaterThan(i("consent_event", "insert"));
  });

  test("⛔ second clic ⇒ « déjà confirmé », AUCUNE seconde preuve, AUCUN second bienvenue", async () => {
    const f = monter();
    expect((await cliquer(f)).etat).toBe("fait");
    const r = await cliquer(f);
    expect(r.status).toBe(200);
    expect(r.etat).toBe("deja");
    expect(f.outbox()).toHaveLength(1);
    expect(preuves(f)).toHaveLength(3);
  });

  test("⛔ trois clics CROISÉS (deux onglets, double-clic) ⇒ un seul bienvenue", async () => {
    const f = monter();
    const rs = await Promise.all([cliquer(f), cliquer(f), cliquer(f)]);
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(rs.filter((r) => r.etat === "fait")).toHaveLength(1);
    expect(f.outbox()).toHaveLength(1);
    expect(preuves(f).filter((p) => p.event_type === "optin_confirm")).toHaveLength(1);
  });

  test("IP mal formée posée par un proxy ⇒ confirmé quand même, `consent_ip` nulle plutôt qu'un refus de la base", async () => {
    const f = monter();
    const r = await cliquer(f, undefined, { enTetes: { "x-forwarded-for": "unknown, 10.0.0.1" } });
    expect(r.etat).toBe("fait");
    expect(f.tables.subscription[0]!.consent_ip).toBeNull();
  });

  test("IP valide ⇒ la preuve la porte", async () => {
    const f = monter();
    await cliquer(f, undefined, { enTetes: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" } });
    expect(f.tables.subscription[0]!.consent_ip).toBe("203.0.113.7");
    expect(preuves(f)[0]!.ip_address).toBe("203.0.113.7");
  });

  test("lead optinforge ⇒ le retour vers la capture est REPORTÉ après la réponse, pas appelé pendant", async () => {
    const f = monter({ sub: souscription({ source_detail: { origin: "optinforge", lead_id: "lead-9" } }) });
    const r = await cliquer(f, undefined, { env: { OPTINFORGE_VERIFY_URL: "https://opf.invalid/v", OPTINFORGE_VERIFY_SECRET: "s" } });
    expect(r.etat).toBe("fait");
    expect(r.reportees).toHaveLength(1);
  });
});

describe("⛔ un lien qui ne mène à rien n'écrit RIEN", () => {
  test("jeton expiré ⇒ 410 `expire`, souscription toujours `pending`", async () => {
    const f = monter({ jeton: { expires_at: "2020-01-01T00:00:00Z" } });
    const r = await cliquer(f);
    expect(r.status).toBe(410);
    expect(r.etat).toBe("expire");
    expect(ecritures(f)).toHaveLength(0);
    expect(f.tables.subscription[0]!.status).toBe("pending");
  });

  test("jeton inconnu ⇒ 404 `inconnu`, aucune écriture", async () => {
    const f = monter();
    const r = await cliquer(f, { token: "jeton-invente" });
    expect(r.status).toBe(404);
    expect(r.etat).toBe("inconnu");
    expect(ecritures(f)).toHaveLength(0);
  });

  test("jeton absent ⇒ 400, la base n'est pas lue", async () => {
    const f = monter();
    const r = await cliquer(f, {});
    expect(r.status).toBe(400);
    expect(f.appels).toHaveLength(0);
  });

  test("⛔ souscription EFFACÉE ⇒ 404 `introuvable`, elle reste `deleted`, aucun bienvenue", async () => {
    const f = monter({ sub: souscription({ status: "deleted", subscriber: { email: "erased+x@deleted.invalid" } }) });
    const r = await cliquer(f);
    expect(r.status).toBe(404);
    expect(r.etat).toBe("introuvable");
    expect(f.tables.subscription[0]!.status).toBe("deleted");
    expect(ecritures(f)).toHaveLength(0);
  });

  /** MUTATION QUI DOIT LE TUER : retirer la garde `contact` de `lireConfirmation`. */
  test("⛔ souscription CONTACT (0088) ⇒ 404 `introuvable`, elle reste `contact`, aucune écriture", async () => {
    const f = monter({ sub: souscription({ status: "contact", granted_purposes: {} }) });
    const r = await cliquer(f);
    expect(r.status).toBe(404);
    expect(r.etat).toBe("introuvable");
    expect(f.tables.subscription[0]!.status).toBe("contact");
    expect(ecritures(f)).toHaveLength(0);
    expect(f.outbox()).toHaveLength(0);
  });

  test("déjà active avant le clic ⇒ 200 `deja`, aucune écriture", async () => {
    const f = monter({ sub: souscription({ status: "active" }) });
    const r = await cliquer(f);
    expect(r.etat).toBe("deja");
    expect(ecritures(f)).toHaveLength(0);
  });

  test("⛔ l'activation échoue ⇒ 503 `echec` : ni preuve, ni bienvenue, jamais « confirmé »", async () => {
    const f = monter({
      panne: (a) => (a.cible === "subscription" && a.methodes.some((m) => m.m === "update") ? { message: "boom" } : null),
    });
    const r = await cliquer(f);
    expect(r.status).toBe(503);
    expect(r.etat).toBe("echec");
    expect(preuves(f)).toHaveLength(0);
    expect(f.outbox()).toHaveLength(0);
  });
});

describe("la route elle-même", () => {
  test("⛔ GET ⇒ 405 : un scanner de liens ne confirme rien", async () => {
    const { GET } = await import("./route");
    const res = GET();
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });
});
