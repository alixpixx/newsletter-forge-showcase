/**
 * Centre de préférences — qui reçoit l'accusé de désinscription (22/09/2026).
 *
 * L'interrupteur « Newsletter » (`set_purpose` / `content`) est le VRAI bouton de désinscription de
 * l'écran ; « Unsubscribe from all brands » (`unsub_all`) le second. Règles d'Alix : UN accusé par
 * geste humain qui change quelque chose, jamais sur un second clic, jamais après un effacement,
 * jamais un par marque. Base en mémoire : les écritures conditionnelles s'y appliquent vraiment.
 */
import { describe, expect, test } from "bun:test";
import { fausseBasePostgrest, type Appel, type Ligne, type Panne } from "@/lib/faux-postgrest";
import { handlePreferences } from "./handler";

const SUBR = "22222222-2222-4222-8222-222222222222";
const ADRESSE = "lectrice@example.invalid";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const JETON = "jeton-prefs";
/** `email_outbox.id` d'une relance de l'abonné — pour l'action `engagement`. */
const RELANCE = "44444444-4444-4444-8444-444444444444";

function sub(id: string, asset_id: string, p: Ligne): Ligne {
  return { id, subscriber_id: SUBR, asset_id, status: "active", granted_purposes: { content: true, offers: true }, ...p };
}

/**
 * Trois marques : Northwind Sports (la plus ancienne), Copper Kettle (la plus récente ACTIVE), Atlas Review
 * (la plus récente de toutes, mais DÉJÀ désinscrite — elle ne doit jamais recevoir l'accusé global).
 */
function monter(panne?: (a: Appel) => Panne) {
  return fausseBasePostgrest(
    {
      // `deleted_at: null` EXPLICITE : seul un `null` lu prouve que l'abonné est vivant.
      subscriber: [{ id: SUBR, email: ADRESSE, first_name: null, created_at: "2026-01-01T00:00:00Z", deleted_at: null }],
      lifecycle_send: [{ id: "ls-1", outbox_id: RELANCE, subscription_id: "sa", responded_at: null }],
      subscription: [
        sub("sa", A, { created_at: "2026-01-01T00:00:00Z", language: "pt-BR", asset: { name: "Northwind Sports" } }),
        sub("sb", B, { created_at: "2026-06-01T00:00:00Z", language: "es", asset: { name: "Copper Kettle" } }),
        sub("sc", C, {
          status: "unsubscribed",
          granted_purposes: { content: true },
          created_at: "2026-08-01T00:00:00Z",
          language: "en",
          asset: { name: "Atlas Review" },
        }),
      ],
    },
    { panne },
  );
}

async function repondre(f: ReturnType<typeof monter>, corps: Record<string, unknown>) {
  const res = await handlePreferences(
    new Request("http://x/api/v1/preferences", { method: "POST", body: JSON.stringify({ token: JETON, ...corps }) }),
    { getDb: () => f.db as never, verifyPrefs: (t) => (t === JETON ? SUBR : null) },
  );
  return { status: res.status, corps: await res.text() };
}

async function agir(f: ReturnType<typeof monter>, corps: Record<string, unknown>) {
  return (await repondre(f, corps)).status;
}

const statut = (f: ReturnType<typeof monter>, id: string) => f.tables.subscription.find((s) => s.id === id)!.status;
const traces = (f: ReturnType<typeof monter>) => f.tables.consent_event ?? [];
const couperNewsletter = { action: "set_purpose", purpose: "content", active: false };

describe("l'interrupteur « Newsletter » (set_purpose / content)", () => {
  test("couper ⇒ UN accusé, pour CETTE marque, dans la langue de la souscription", async () => {
    const f = monter();
    expect(await agir(f, { ...couperNewsletter, asset_id: A })).toBe(200);

    expect(f.outbox()).toHaveLength(1);
    expect(f.outbox()[0]).toMatchObject({ kind: "unsubscribe_ack", asset_id: A, subscription_id: "sa", to_email: ADRESSE });
    expect(f.outbox()[0]!.subject).toBe("Cancelamento confirmado — Northwind Sports");
    expect(statut(f, "sa")).toBe("unsubscribed");
    // Le comportement d'avant est gardé : la finalité est écrite, la trace `withdrawn` aussi.
    expect(f.tables.subscription.find((s) => s.id === "sa")!.granted_purposes).toMatchObject({ content: false });
    expect(traces(f)).toHaveLength(1);
    expect(traces(f)[0]).toMatchObject({ subscription_id: "sa", event_type: "withdrawn", purpose: "content" });
  });

  test("⛔ couper une seconde fois ⇒ AUCUN second accusé (la trace, elle, s'écrit comme avant)", async () => {
    const f = monter();
    await agir(f, { ...couperNewsletter, asset_id: A });
    expect(await agir(f, { ...couperNewsletter, asset_id: A })).toBe(200);
    expect(f.outbox()).toHaveLength(1);
    expect(traces(f)).toHaveLength(2);
  });

  test("⛔ deux clics CROISÉS ⇒ un seul accusé", async () => {
    const f = monter();
    await Promise.all([agir(f, { ...couperNewsletter, asset_id: A }), agir(f, { ...couperNewsletter, asset_id: A })]);
    expect(f.outbox()).toHaveLength(1);
  });

  test("déjà désinscrite par le lien d'un e-mail ⇒ aucun accusé, mais l'interrupteur s'éteint", async () => {
    // Sans la seconde écriture, l'écran rallumerait « Newsletter » au prochain chargement.
    const f = monter();
    expect(await agir(f, { ...couperNewsletter, asset_id: C })).toBe(200);
    expect(f.outbox()).toHaveLength(0);
    expect(f.tables.subscription.find((s) => s.id === "sc")!.granted_purposes).toMatchObject({ content: false });
  });

  test("une autre finalité coupée, ou la newsletter rallumée ⇒ aucun accusé", async () => {
    const f = monter();
    await agir(f, { action: "set_purpose", purpose: "offers", active: false, asset_id: A });
    expect(statut(f, "sa")).toBe("active");
    await agir(f, { action: "set_purpose", purpose: "content", active: true, asset_id: C });
    expect(statut(f, "sc")).toBe("active");
    expect(f.outbox()).toHaveLength(0);
  });

  test("⛔ une mise en file ratée ne change pas la réponse", async () => {
    const f = monter((a) => (a.cible === "email_outbox" ? "lever" : null));
    const erreur = console.error;
    console.error = () => {};
    try {
      expect(await agir(f, { ...couperNewsletter, asset_id: A })).toBe(200);
    } finally {
      console.error = erreur;
    }
    expect(statut(f, "sa")).toBe("unsubscribed");
  });
});

/**
 * ⛔ UN CONTACT HORS NEWSLETTER (0088) NE DEVIENT PAS ABONNÉ PAR UN INTERRUPTEUR : rallumer
 * « Newsletter » écrirait `active` sans double opt-in.
 * MUTATION QUI DOIT LE TUER : retirer `.neq("status", "contact")` de `trouverSouscription`.
 */
describe("⛔ une ligne contact n'est pas réglable ici", () => {
  const D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  function avecContact() {
    const f = monter();
    f.tables.subscription.push(
      sub("sd", D, { status: "contact", granted_purposes: {}, created_at: "2026-09-01T00:00:00Z", language: "pt-BR", asset: { name: "Pixel Daily" } }),
    );
    return f;
  }

  for (const corps of [
    { action: "set_purpose", purpose: "content", active: true },
    { action: "set_purpose", purpose: "offers", active: true },
    { action: "set_asset", active: true },
    { action: "set_tracking", active: true },
  ]) {
    test(`${corps.action} ${"purpose" in corps ? corps.purpose : ""} ⇒ 404, la ligne reste contact, aucune trace`, async () => {
      const f = avecContact();
      expect(await agir(f, { ...corps, asset_id: D })).toBe(404);
      const ligne = f.tables.subscription.find((s) => s.id === "sd")!;
      expect(ligne.status).toBe("contact");
      expect(ligne.granted_purposes).toEqual({});
      expect(traces(f)).toHaveLength(0);
    });
  }

  test("« Unsubscribe from all brands » désinscrit AUSSI le contact", async () => {
    const f = avecContact();
    expect(await agir(f, { action: "unsub_all" })).toBe(200);
    expect(statut(f, "sd")).toBe("unsubscribed");
  });
});

describe("set_asset (l'écran ne l'appelle plus, la route reste ouverte)", () => {
  test("désactiver ⇒ un accusé, une seule fois", async () => {
    const f = monter();
    await agir(f, { action: "set_asset", asset_id: B, active: false });
    await agir(f, { action: "set_asset", asset_id: B, active: false });
    expect(f.outbox()).toHaveLength(1);
    expect(f.outbox()[0]).toMatchObject({ subscription_id: "sb", asset_id: B });
  });
});

describe("« Unsubscribe from all brands » (unsub_all)", () => {
  test("⛔ UN accusé au total — la plus récente des souscriptions réellement désinscrites", async () => {
    const f = monter();
    expect(await agir(f, { action: "unsub_all" })).toBe(200);

    expect(f.outbox()).toHaveLength(1);
    // Copper Kettle, pas Atlas Review : celle-ci était déjà désinscrite, ce geste ne l'a pas changée.
    expect(f.outbox()[0]).toMatchObject({ kind: "unsubscribe_ack", subscription_id: "sb", asset_id: B });
    expect(f.outbox()[0]!.subject).toBe("Baja confirmada — Copper Kettle");
    expect([statut(f, "sa"), statut(f, "sb"), statut(f, "sc")]).toEqual(["unsubscribed", "unsubscribed", "unsubscribed"]);
    // Une trace par souscription réellement changée, et la suppression globale.
    expect(traces(f).map((t) => t.subscription_id).sort()).toEqual(["sa", "sb"]);
    const rpc = f.appels.filter((a) => a.cible === "rpc:suppress").map((a) => a.methodes[0]!.args[0]);
    expect(rpc).toEqual([{ p_email: ADRESSE, p_asset_id: null, p_reason: "global_optout", p_scope: "global" }]);
  });

  test("⛔ la mise en file vient APRÈS les écritures", async () => {
    const f = monter();
    await agir(f, { action: "unsub_all" });
    const derniereMaj = f.appels.map((a) => a.cible === "subscription" && a.methodes.some((m) => m.m === "update")).lastIndexOf(true);
    expect(f.appels.findIndex((a) => a.cible === "email_outbox")).toBeGreaterThan(derniereMaj);
  });

  test("une marque désignée parmi celles qui ont changé est préférée", async () => {
    const f = monter();
    await agir(f, { action: "unsub_all", asset_id: A });
    expect(f.outbox()).toHaveLength(1);
    expect(f.outbox()[0]).toMatchObject({ subscription_id: "sa" });
  });

  test("⛔ un second « tout désinscrire » ⇒ aucun accusé", async () => {
    const f = monter();
    await agir(f, { action: "unsub_all" });
    await agir(f, { action: "unsub_all" });
    expect(f.outbox()).toHaveLength(1);
  });

  test("déjà désinscrite partout (par l'interrupteur) ⇒ l'accusé de l'interrupteur, et aucun de plus", async () => {
    const f = monter();
    await agir(f, { ...couperNewsletter, asset_id: A });
    await agir(f, { ...couperNewsletter, asset_id: B });
    await agir(f, { action: "unsub_all" });
    expect(f.outbox().map((o) => o.subscription_id)).toEqual(["sa", "sb"]);
  });
});

describe("⛔ droit à l'oubli : aucun accusé, ni pendant ni après", () => {
  test("erase ⇒ aucun accusé", async () => {
    const f = monter();
    expect(await agir(f, { action: "erase" })).toBe(200);
    expect(f.outbox()).toHaveLength(0);
    expect([statut(f, "sa"), statut(f, "sb"), statut(f, "sc")]).toEqual(["deleted", "deleted", "deleted"]);
  });

  test("un vieux lien de préférences après l'effacement ⇒ aucun accusé, aucun statut ne bouge, aucune trace", async () => {
    const f = monter();
    await agir(f, { action: "erase" });
    await agir(f, { ...couperNewsletter, asset_id: A });
    await agir(f, { action: "set_purpose", purpose: "content", active: true, asset_id: B });
    await agir(f, { action: "set_purpose", purpose: "offers", active: false, asset_id: C });
    await agir(f, { action: "set_asset", asset_id: B, active: false });
    await agir(f, { action: "set_asset", asset_id: C, active: true });
    await agir(f, { action: "unsub_all" });
    expect(f.outbox()).toHaveLength(0);
    expect([statut(f, "sa"), statut(f, "sb"), statut(f, "sc")]).toEqual(["deleted", "deleted", "deleted"]);
    // Aucune trace (IP, user-agent) réécrite dans le dossier d'une personne qui a demandé l'oubli.
    expect(traces(f)).toHaveLength(0);
  });
});

/**
 * ⛔ UN EFFACEMENT EST DÉFINITIF (22/09/2026). Le jeton de préférences survit à l'effacement (HMAC
 * sans état) et la ligne `subscriber` aussi (pseudonymisée) : l'écran se rouvre depuis un vieil
 * e-mail. Aucun geste ne doit y ramener une souscription `deleted` à la vie — qui veut revenir passe
 * par le formulaire public, qui crée une NOUVELLE souscription.
 */
describe("⛔ une souscription effacée ne revient jamais", () => {
  /** Northwind Sports effacée, les deux autres intactes — on isole la ligne, pas tout l'abonné. */
  function avecNorthwindSportsEffacee() {
    const f = monter();
    const northwindSports = f.tables.subscription.find((s) => s.id === "sa")!;
    northwindSports.status = "deleted";
    northwindSports.granted_purposes = { content: false, offers: false };
    return f;
  }
  const northwindSports = (f: ReturnType<typeof monter>) => f.tables.subscription.find((s) => s.id === "sa")!;

  /** MUTATION QUI DOIT LE TUER : retirer `.neq('status','deleted')` de `ecrireSaufEffacee`. */
  test("rallumer « Newsletter » ⇒ rien ne change, aucune trace, aucune réaction", async () => {
    const f = avecNorthwindSportsEffacee();
    expect(await agir(f, { action: "set_purpose", purpose: "content", active: true, asset_id: A })).toBe(200);
    expect(northwindSports(f).status).toBe("deleted");
    expect(northwindSports(f).granted_purposes).toEqual({ content: false, offers: false });
    expect(northwindSports(f).last_response_at).toBeUndefined();
    expect(traces(f)).toHaveLength(0);
  });

  test("set_asset active=true ⇒ rien ne change, aucune trace", async () => {
    const f = avecNorthwindSportsEffacee();
    expect(await agir(f, { action: "set_asset", asset_id: A, active: true })).toBe(200);
    expect(northwindSports(f).status).toBe("deleted");
    expect(traces(f)).toHaveLength(0);
  });

  test("aucune autre écriture de finalité ni de statut ne porte non plus", async () => {
    const f = avecNorthwindSportsEffacee();
    await agir(f, { action: "set_purpose", purpose: "offers", active: true, asset_id: A });
    await agir(f, { action: "set_purpose", purpose: "content", active: false, asset_id: A });
    await agir(f, { action: "set_asset", asset_id: A, active: false });
    expect(northwindSports(f).status).toBe("deleted");
    expect(northwindSports(f).granted_purposes).toEqual({ content: false, offers: false });
    expect(traces(f)).toHaveLength(0);
    expect(f.outbox()).toHaveLength(0);
  });

  test("⛔ la réponse est celle d'un geste réussi, au caractère près : rien ne trahit l'effacement", async () => {
    const effacee = await repondre(avecNorthwindSportsEffacee(), { action: "set_purpose", purpose: "content", active: true, asset_id: A });
    const vivante = await repondre(monter(), { action: "set_purpose", purpose: "content", active: true, asset_id: B });
    expect(effacee).toEqual(vivante);
    const assetEffacee = await repondre(avecNorthwindSportsEffacee(), { action: "set_asset", asset_id: A, active: true });
    expect(assetEffacee).toEqual(vivante);
  });

  test("les autres marques du même abonné restent réglables", async () => {
    const f = avecNorthwindSportsEffacee();
    await agir(f, { ...couperNewsletter, asset_id: B });
    expect(statut(f, "sb")).toBe("unsubscribed");
    expect(f.outbox()).toHaveLength(1);
  });
});

/**
 * ⛔ LE JETON D'UN ABONNÉ EFFACÉ EST MORT, SUR TOUTE LA ROUTE (22/09/2026). Contrôlé une fois, là où
 * l'abonné est résolu, avant toute action. Réponse : celle d'un jeton faux, au caractère près.
 * Écritures : AUCUNE.
 *
 * ⚠️ Les souscriptions sont laissées ACTIVES à dessein, alors que `erase_subscriber` les passe
 * `deleted` : ainsi les gardes par ligne de d0a1dd9 ne peuvent rien arrêter, et c'est le contrôle
 * à la racine, et lui seul, que ce bloc mesure.
 * MUTATION QUI DOIT LE TUER : retirer le test `deleted_at` de `resoudreAbonnePrefs`.
 */
describe("⛔ abonné effacé : jeton mort sur toute la route", () => {
  function avecAbonneEfface() {
    const f = monter();
    Object.assign(f.tables.subscriber[0]!, {
      email: `erased+${SUBR}@deleted.invalid`,
      first_name: null,
      deleted_at: "2026-09-20T10:00:00Z",
    });
    return f;
  }

  const ACTIONS: Record<string, unknown>[] = [
    { action: "engagement", ls: RELANCE },
    { action: "set_asset", asset_id: A, active: false },
    { action: "set_asset", asset_id: C, active: true },
    { action: "set_purpose", purpose: "content", active: false, asset_id: A },
    { action: "set_purpose", purpose: "content", active: true, asset_id: C },
    { action: "set_purpose", purpose: "offers", active: true, asset_id: B },
    { action: "set_tracking", asset_id: A, active: true },
    { action: "unsub_all" },
    { action: "export" },
    { action: "erase" },
    { action: "action-inventee" },
    {},
  ];
  const ECRITURES = new Set(["update", "insert", "upsert", "delete"]);

  for (const corps of ACTIONS) {
    test(`${String(corps.action ?? "(sans action)")} ${corps.active ?? ""} ⇒ la réponse d'un jeton faux, et zéro écriture`, async () => {
      const f = avecAbonneEfface();
      const efface = await repondre(f, corps);
      const faux = await repondre(monter(), { ...corps, token: "jeton-contrefait" });
      expect(faux.status).toBe(403);
      expect(efface).toEqual(faux);

      // Zéro écriture, relevé sur les appels enregistrés : ni update, ni insert, ni RPC.
      const ecritures = f.appels.filter((a) => a.cible.startsWith("rpc:") || a.methodes.some((m) => ECRITURES.has(m.m)));
      expect(ecritures).toEqual([]);
      // Et rien d'autre que la résolution de l'abonné n'a été lu.
      expect(f.appels.map((a) => a.cible)).toEqual(["subscriber"]);
      expect(f.outbox()).toHaveLength(0);
      expect(traces(f)).toHaveLength(0);
    });
  }

  test("après un vrai `erase`, le même lien est mort pour la suite", async () => {
    const f = monter();
    expect(await agir(f, { action: "erase" })).toBe(200);
    const apres = f.appels.length;
    for (const corps of ACTIONS) {
      expect(await repondre(f, corps)).toEqual({ status: 403, corps: JSON.stringify({ error: "lien-invalide" }) });
    }
    const ecritures = f.appels
      .slice(apres)
      .filter((a) => a.cible.startsWith("rpc:") || a.methodes.some((m) => ECRITURES.has(m.m)));
    expect(ecritures).toEqual([]);
  });
});

describe("rallumer une souscription simplement désinscrite marche toujours", () => {
  test("set_purpose content=true sur `unsubscribed` ⇒ `active`, finalité, trace `granted` PUIS `resubscribe`", async () => {
    const f = monter();
    expect(await agir(f, { action: "set_purpose", purpose: "content", active: true, asset_id: C })).toBe(200);
    expect(statut(f, "sc")).toBe("active");
    expect(f.tables.subscription.find((s) => s.id === "sc")!.granted_purposes).toMatchObject({ content: true });
    // `resubscribe` + `preference_center` : l'ancre de « Welcome back » (0082).
    expect(traces(f).map((t) => [t.subscription_id, t.event_type, t.purpose ?? null, t.method])).toEqual([
      ["sc", "granted", "content", "preference_center"],
      ["sc", "resubscribe", null, "preference_center"],
    ]);
  });

  test("⛔ déjà active ⇒ `granted` seul : pas de retour pour qui n'est jamais parti", async () => {
    const f = monter();
    expect(await agir(f, { action: "set_purpose", purpose: "content", active: true, asset_id: A })).toBe(200);
    expect(traces(f).map((t) => t.event_type)).toEqual(["granted"]);
  });

  test("⛔ `pending` ⇒ aucun `resubscribe` (« Welcome back » accueillerait quelqu'un qui n'est jamais venu)", async () => {
    const f = monter();
    f.tables.subscription.find((s) => s.id === "sb")!.status = "pending";
    expect(await agir(f, { action: "set_purpose", purpose: "content", active: true, asset_id: B })).toBe(200);
    expect(traces(f).map((t) => t.event_type)).toEqual(["granted"]);
  });

  test("⛔ deux clics CROISÉS ⇒ un seul `resubscribe`", async () => {
    const f = monter();
    const rallumer = { action: "set_purpose", purpose: "content", active: true, asset_id: C };
    await Promise.all([agir(f, rallumer), agir(f, rallumer)]);
    expect(statut(f, "sc")).toBe("active");
    expect(traces(f).filter((t) => t.event_type === "resubscribe")).toHaveLength(1);
  });

  test("une autre finalité rallumée sur `unsubscribed` ⇒ ni retour ni changement de statut", async () => {
    const f = monter();
    expect(await agir(f, { action: "set_purpose", purpose: "offers", active: true, asset_id: C })).toBe(200);
    expect(statut(f, "sc")).toBe("unsubscribed");
    expect(traces(f).map((t) => t.event_type)).toEqual(["granted"]);
  });

  test("set_asset active=true sur `unsubscribed` ⇒ `active`, trace `resubscribe`", async () => {
    const f = monter();
    expect(await agir(f, { action: "set_asset", asset_id: C, active: true })).toBe(200);
    expect(statut(f, "sc")).toBe("active");
    expect(traces(f)).toHaveLength(1);
    expect(traces(f)[0]).toMatchObject({ subscription_id: "sc", event_type: "resubscribe" });
  });

  test("set_asset active=false sur une souscription déjà désinscrite : tracé comme avant, sans accusé", async () => {
    const f = monter();
    expect(await agir(f, { action: "set_asset", asset_id: C, active: false })).toBe(200);
    expect(statut(f, "sc")).toBe("unsubscribed");
    expect(traces(f)).toHaveLength(1);
    expect(f.outbox()).toHaveLength(0);
  });
});

describe("l'interrupteur « suivi » (set_tracking) et le refus explicite (0092)", () => {
  const ligne = (f: ReturnType<typeof monter>, id: string) => f.tables.subscription.find((s) => s.id === id)!;
  /** Panne sur la SEULE écriture du refus : un update de `subscription` qui porte `tracking_refused_at`. */
  const surLeRefus = (message: string) => (a: Appel): Panne =>
    a.cible === "subscription" && a.methodes.some((m) => m.m === "update" && JSON.stringify(m.args).includes("tracking_refused_at"))
      ? { message }
      : null;

  test("couper le suivi ⇒ refus posé, consentement faux, trace `withdrawn`", async () => {
    const f = monter();
    expect(await agir(f, { action: "set_tracking", asset_id: A, active: false })).toBe(200);
    expect(typeof ligne(f, "sa").tracking_refused_at).toBe("string");
    expect(ligne(f, "sa").tracking_consent).toBe(false);
    expect(traces(f)).toHaveLength(1);
    expect(traces(f)[0]).toMatchObject({ subscription_id: "sa", event_type: "withdrawn", metadata: { tracking_consent: false } });
  });

  test("rallumer le suivi ⇒ refus effacé, consentement vrai", async () => {
    const f = monter();
    await agir(f, { action: "set_tracking", asset_id: A, active: false });
    expect(await agir(f, { action: "set_tracking", asset_id: A, active: true })).toBe(200);
    expect(ligne(f, "sa").tracking_refused_at).toBeNull();
    expect(ligne(f, "sa").tracking_consent).toBe(true);
  });

  test("⛔ le refus n'a pas pu s'écrire ⇒ 500, et RIEN d'autre n'est écrit (ni consentement, ni trace)", async () => {
    const f = monter(surLeRefus("connection reset"));
    expect(await agir(f, { action: "set_tracking", asset_id: A, active: false })).toBe(500);
    expect(ligne(f, "sa").tracking_consent).toBeUndefined();
    expect(traces(f)).toHaveLength(0);
  });

  test("base d'avant 0092 (colonne inconnue) ⇒ le geste marche comme avant", async () => {
    const f = monter(surLeRefus("Could not find the 'tracking_refused_at' column of 'subscription' in the schema cache"));
    expect(await agir(f, { action: "set_tracking", asset_id: A, active: false })).toBe(200);
    expect(ligne(f, "sa").tracking_consent).toBe(false);
    expect(traces(f)).toHaveLength(1);
  });
});
