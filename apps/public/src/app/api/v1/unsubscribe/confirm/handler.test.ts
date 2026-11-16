/**
 * Le bouton de `/unsubscribe` — et l'accusé de désinscription qui le suit (22/09/2026).
 *
 * Base en mémoire (`lib/faux-postgrest.ts`) : l'écriture conditionnelle de `lib/desabonnement.ts`
 * s'y applique VRAIMENT, donc un second clic trouve la ligne déjà désinscrite, exactement comme en
 * production. Ce qui compte : UN accusé quand le geste change quelque chose, AUCUN sinon, et une
 * mise en file ratée qui ne change jamais la réponse.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fausseBasePostgrest, type Ligne, type Panne, type Appel } from "@/lib/faux-postgrest";
import { handleDesinscriptionHumaine } from "./handler";

const SUB = "11111111-1111-4111-8111-111111111111";
const ASSET = "ed806139-74f6-46e9-9769-7c0bc005789a";
const ADRESSE = "lecteur@example.invalid";
const JETON = "jeton-signe";

function souscription(p: Ligne = {}): Ligne {
  return {
    id: SUB,
    status: "active",
    language: "es",
    asset_id: ASSET,
    subscriber_id: "subr-1",
    subscriber: { email: ADRESSE },
    asset: { name: "Copper Kettle" },
    ...p,
  };
}

function monter(ligne: Ligne | null = souscription(), panne?: (a: Appel) => Panne) {
  return fausseBasePostgrest({ subscription: ligne ? [ligne] : [] }, { panne });
}

async function cliquer(f: ReturnType<typeof monter>, corps: Record<string, unknown> = { token: JETON }) {
  const res = await handleDesinscriptionHumaine(
    new Request("http://x/api/v1/unsubscribe/confirm", { method: "POST", body: JSON.stringify(corps) }),
    { getDb: () => f.db as never, verifyUnsub: (t) => (t === JETON ? SUB : null) },
  );
  return res.status;
}

const estUneMaj = (a: Appel) => a.cible === "subscription" && a.methodes.some((m) => m.m === "update");

let espion: { mockRestore: () => void } | null = null;
let lignesJournal: string[] = [];
afterEach(() => {
  espion?.mockRestore();
  espion = null;
  lignesJournal = [];
});
/** Capture `console.error` le temps d'un test. */
function ecouterJournal() {
  espion = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lignesJournal.push(String(args[0]));
  });
}
/** Les journaux structurés, relus en JSON. */
function journaux(): Record<string, unknown>[] {
  return lignesJournal.filter((s) => s.startsWith("{")).map((s) => JSON.parse(s) as Record<string, unknown>);
}

describe("le geste humain qui désinscrit met en file UN accusé", () => {
  test("`fait` ⇒ une ligne `unsubscribe_ack`, bonne marque, bonne adresse, objet dans la langue", async () => {
    const f = monter();
    expect(await cliquer(f)).toBe(200);

    expect(f.outbox()).toHaveLength(1);
    expect(f.outbox()[0]).toMatchObject({
      kind: "unsubscribe_ack",
      asset_id: ASSET,
      subscription_id: SUB,
      to_email: ADRESSE,
      status: "pending",
    });
    // Langue de la SOUSCRIPTION (`es`) : la marque est dans l'objet.
    expect(f.outbox()[0]!.subject).toBe("Baja confirmada — Copper Kettle");
    expect(f.tables.subscription[0]!.status).toBe("unsubscribed");
  });

  test("⛔ la mise en file vient APRÈS l'écriture du désabonnement", async () => {
    const f = monter();
    await cliquer(f);
    const iMaj = f.appels.findIndex(estUneMaj);
    const iFile = f.appels.findIndex((a) => a.cible === "email_outbox");
    expect(iMaj).toBeGreaterThanOrEqual(0);
    expect(iFile).toBeGreaterThan(iMaj);
  });

  test("⛔ second clic (`deja`) ⇒ 200, et AUCUN second accusé", async () => {
    const f = monter();
    expect(await cliquer(f)).toBe(200);
    expect(await cliquer(f)).toBe(200);
    expect(f.outbox()).toHaveLength(1);
  });

  test("⛔ deux clics CROISÉS ⇒ un seul accusé", async () => {
    // Le perdant de la course voit zéro ligne revenir de l'écriture conditionnelle.
    const f = monter();
    const statuts = await Promise.all([cliquer(f), cliquer(f), cliquer(f)]);
    expect(statuts).toEqual([200, 200, 200]);
    expect(f.outbox()).toHaveLength(1);
  });

  test("déjà désinscrit avant le clic ⇒ 200, aucun accusé", async () => {
    const f = monter(souscription({ status: "unsubscribed" }));
    expect(await cliquer(f)).toBe(200);
    expect(f.outbox()).toHaveLength(0);
  });

  test("⛔ souscription EFFACÉE ⇒ 200, aucun accusé, et elle reste `deleted`", async () => {
    const f = monter(souscription({ status: "deleted", subscriber: { email: "erased+x@deleted.invalid" } }));
    expect(await cliquer(f)).toBe(200);
    expect(f.outbox()).toHaveLength(0);
    expect(f.tables.subscription[0]!.status).toBe("deleted");
  });

  test("`echec` ⇒ 503, et aucun accusé : la personne est toujours abonnée", async () => {
    const f = monter(souscription(), (a) => (estUneMaj(a) ? { message: "boom" } : null));
    expect(await cliquer(f)).toBe(503);
    expect(f.outbox()).toHaveLength(0);
  });

  test("plus de ligne (droit à l'oubli passé) ⇒ 200, rien d'écrit", async () => {
    const f = monter(null);
    expect(await cliquer(f)).toBe(200);
    expect(f.appels.some(estUneMaj)).toBe(false);
    expect(f.outbox()).toHaveLength(0);
  });

  test("jeton invalide ⇒ 403, la base n'est pas lue", async () => {
    const f = monter();
    expect(await cliquer(f, { token: "faux" })).toBe(403);
    expect(f.appels).toHaveLength(0);
  });
});

describe("⛔ une mise en file ratée ne change JAMAIS la réponse", () => {
  const cas: [string, Panne][] = [
    ["refus de la base", { message: "violates check constraint" }],
    ["exception du client", "lever"],
  ];
  for (const [nom, panne] of cas) {
    test(`${nom} ⇒ toujours 200, désinscription faite, échec journalisé sans l'adresse`, async () => {
      ecouterJournal();
      const f = monter(souscription(), (a) => (a.cible === "email_outbox" ? panne : null));
      expect(await cliquer(f)).toBe(200);
      expect(f.tables.subscription[0]!.status).toBe("unsubscribed");

      const j = journaux().filter((l) => l.event === "unsubscribe-ack-queue-failed");
      expect(j).toHaveLength(1);
      expect(j[0]!.subscription_id).toBe(SUB);
      expect(JSON.stringify(j)).not.toContain(ADRESSE);
    });
  }
});

describe("⛔ le one-click RFC 8058 ne met JAMAIS d'accusé en file", () => {
  /*
   * Décision d'Alix du 22/09/2026 : la messagerie confirme déjà le geste dans sa propre interface.
   * La route one-click n'est pas sous banc (elle lit ses secrets au chargement) : on lit son CODE,
   * commentaires retirés, et on y refuse toute trace d'une mise en file. Un commentaire qui
   * expliquerait l'interdit reste permis ; un appel, non.
   */
  test("`api/v1/unsubscribe/route.ts` n'enfile rien", () => {
    const source = readFileSync(new URL("../route.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    for (const interdit of ["mettreEnFileAccuse", "accuse-desabonnement", "queueEmail", "@/lib/mailer", "email_outbox", "unsubscribe_ack"]) {
      expect(source).not.toContain(interdit);
    }
    // Contre-épreuve : le banc lit bien le bon fichier — celui qui trace le geste machine.
    expect(source).toContain("METHODE_MACHINE");
  });
});
