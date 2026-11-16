/**
 * Limite de débit de l'inscription publique (24/09/2026) — par IP ET par adresse.
 *
 * La base est un double de `signup_rate_take` (0081) qui applique la même règle : compter dans la
 * fenêtre, refuser à partir du seuil, ne réserver une place que si la tentative passe. La règle SQL
 * elle-même est éprouvée DANS la migration (contre-épreuve qui l'exécute sur des clés jetables) ;
 * ici on tient ce que le site envoie et ce qu'il fait de la réponse : clés pseudonymisées,
 * normalisation de l'adresse, seuils, 429, et la panne qui laisse passer.
 * MUTATIONS QUI DOIVENT LE TUER : ne plus envoyer la clé IP ; ne plus normaliser l'adresse ; ne plus
 * lire le verdict dans la route ; fermer sur panne.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  adresseDeDebit,
  empreinteDebit,
  limiterInscription,
  LIMITE_PAR_ADRESSE,
  LIMITE_PAR_IP,
  reponseTropDeTentatives,
} from "./debit-inscription";

type Args = {
  p_ip_key: string | null;
  p_address_key: string;
  p_ip_max: number;
  p_ip_window_seconds: number;
  p_address_max: number;
  p_address_window_seconds: number;
};

/** Le double de `signup_rate_take` : même règle que la fonction SQL, horloge figée. */
function compteur(o: { panne?: "erreur" | "lever" | "illisible" } = {}) {
  const lignes: { genre: "ip" | "address"; cle: string }[] = [];
  const appels: Args[] = [];
  const db = {
    rpc: async (nom: string, a: Args) => {
      appels.push(a);
      if (nom !== "signup_rate_take") return { data: null, error: { message: `rpc inconnue ${nom}` } };
      if (o.panne === "lever") throw new Error("connexion perdue");
      if (o.panne === "erreur") return { data: null, error: { message: "function newsletter.signup_rate_take does not exist" } };
      if (o.panne === "illisible") return { data: null, error: null };
      const n = (genre: "ip" | "address", cle: string) => lignes.filter((l) => l.genre === genre && l.cle === cle).length;
      if (n("address", a.p_address_key) >= a.p_address_max) {
        return { data: { allowed: false, limited_by: "address", retry_after_seconds: 3599.2 }, error: null };
      }
      if (a.p_ip_key && n("ip", a.p_ip_key) >= a.p_ip_max) {
        return { data: { allowed: false, limited_by: "ip", retry_after_seconds: 120 }, error: null };
      }
      lignes.push({ genre: "address", cle: a.p_address_key });
      if (a.p_ip_key) lignes.push({ genre: "ip", cle: a.p_ip_key });
      return { data: { allowed: true }, error: null };
    },
  };
  return { db: db as never, appels, lignes };
}

/** Capture `console.error` le temps d'un appel (le banc public n'a ni `spyOn` ni `afterEach`). */
async function journal<T>(f: () => Promise<T>): Promise<{ r: T; lignes: Record<string, unknown>[] }> {
  const lignes: Record<string, unknown>[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => {
    try {
      lignes.push(JSON.parse(String(a[0])) as Record<string, unknown>);
    } catch {
      /* ignoré */
    }
  };
  try {
    return { r: await f(), lignes };
  } finally {
    console.error = original;
  }
}

describe("par adresse : les N premières passent, la N+1ᵉ est refusée", () => {
  test(`${LIMITE_PAR_ADRESSE.max} inscriptions de la même adresse (IP différentes) passent, la suivante ⇒ refus « address »`, async () => {
    const c = compteur();
    for (let i = 0; i < LIMITE_PAR_ADRESSE.max; i++) {
      expect((await limiterInscription(c.db, { ip: `198.51.100.${i + 1}`, email: "victime@example.invalid" })).ok).toBe(true);
    }
    const v = await limiterInscription(c.db, { ip: "198.51.100.200", email: "victime@example.invalid" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.limitePar).toBe("address");
  });

  test("⛔ le suffixe `+…`, la casse et les espaces ne contournent pas la limite", async () => {
    const c = compteur();
    const variantes = ["victime+1@example.invalid", "Victime+2@Example.Invalid", " VICTIME@example.invalid ", "victime+abc@example.invalid", "victime@example.invalid"];
    expect(variantes).toHaveLength(LIMITE_PAR_ADRESSE.max);
    for (const [i, e] of variantes.entries()) {
      expect((await limiterInscription(c.db, { ip: `198.51.100.${i + 1}`, email: e })).ok).toBe(true);
    }
    expect((await limiterInscription(c.db, { ip: "198.51.100.99", email: "victime+6@example.invalid" })).ok).toBe(false);
  });

  test("une autre adresse n'est pas gênée par la première", async () => {
    const c = compteur();
    for (let i = 0; i < LIMITE_PAR_ADRESSE.max + 1; i++) await limiterInscription(c.db, { ip: null, email: "a@example.invalid" });
    expect((await limiterInscription(c.db, { ip: null, email: "b@example.invalid" })).ok).toBe(true);
  });
});

describe("par IP : les N premières passent, la N+1ᵉ est refusée", () => {
  test(`${LIMITE_PAR_IP.max} adresses différentes depuis la même IP passent, la suivante ⇒ refus « ip »`, async () => {
    const c = compteur();
    for (let i = 0; i < LIMITE_PAR_IP.max; i++) {
      expect((await limiterInscription(c.db, { ip: "203.0.113.7", email: `p${i}@example.invalid` })).ok).toBe(true);
    }
    const v = await limiterInscription(c.db, { ip: "203.0.113.7", email: "encore@example.invalid" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.limitePar).toBe("ip");
    // Une autre IP passe toujours.
    expect((await limiterInscription(c.db, { ip: "203.0.113.8", email: "encore@example.invalid" })).ok).toBe(true);
  });

  test("IP inconnue ⇒ seule la limite par adresse s'applique (clé IP nulle, jamais une clé vide)", async () => {
    const c = compteur();
    await limiterInscription(c.db, { ip: null, email: "x@example.invalid" });
    expect(c.appels[0]!.p_ip_key).toBeNull();
  });
});

describe("⛔ ce qui part en base", () => {
  test("des empreintes sha256, jamais l'adresse ni l'IP en clair", async () => {
    const c = compteur();
    await limiterInscription(c.db, { ip: "203.0.113.7", email: "Lectrice+news@Example.invalid" });
    const a = c.appels[0]!;
    expect(/^[0-9a-f]{64}$/.test(a.p_address_key)).toBe(true);
    expect(/^[0-9a-f]{64}$/.test(String(a.p_ip_key))).toBe(true);
    expect(a.p_address_key).toBe(empreinteDebit("address", "lectrice@example.invalid"));
    expect(a.p_ip_key).toBe(empreinteDebit("ip", "203.0.113.7"));
    const tout = JSON.stringify(a).toLowerCase();
    expect(tout).not.toContain("lectrice");
    expect(tout).not.toContain("203.0.113.7");
  });

  test("les seuils envoyés sont les constantes documentées", async () => {
    const c = compteur();
    await limiterInscription(c.db, { ip: "203.0.113.7", email: "x@example.invalid" });
    expect(c.appels[0]).toEqual({
      p_ip_key: empreinteDebit("ip", "203.0.113.7"),
      p_address_key: empreinteDebit("address", "x@example.invalid"),
      p_ip_max: 20,
      p_ip_window_seconds: 3600,
      p_address_max: 5,
      p_address_window_seconds: 86400,
    });
  });

  test("adresseDeDebit : ce qui se normalise, et ce qui ne se touche pas", () => {
    expect(adresseDeDebit("  A.B+promo@Gmail.COM ")).toBe("a.b@gmail.com");
    expect(adresseDeDebit("+seul@example.invalid")).toBe("+seul@example.invalid");
    expect(adresseDeDebit("sans-arobase")).toBe("sans-arobase");
  });
});

describe("⚠️ une panne du compteur LAISSE PASSER, et se dit", () => {
  for (const panne of ["erreur", "lever", "illisible"] as const) {
    test(`panne « ${panne} » ⇒ inscription acceptée, journal signup-rate-limit-unavailable`, async () => {
      const c = compteur({ panne });
      const { r, lignes } = await journal(() => limiterInscription(c.db, { ip: "203.0.113.7", email: "x@example.invalid" }));
      expect(r.ok).toBe(true);
      const j = lignes.filter((l) => l.event === "signup-rate-limit-unavailable");
      expect(j).toHaveLength(1);
      expect(j[0]!.passed).toBe(true);
      expect(JSON.stringify(j)).not.toContain("x@example.invalid");
    });
  }
});

describe("le 429", () => {
  test("statut 429, Retry-After entier, code d'erreur que le widget traduit, sans dire quelle limite", async () => {
    const { r: res } = await journal(async () => reponseTropDeTentatives({ ok: false, limitePar: "address", reessayerDans: 3600 }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("3600");
    const corps = (await res.json()) as Record<string, unknown>;
    expect(corps.error).toBe("trop-de-tentatives");
    expect(Object.keys(corps).sort()).toEqual(["error", "message", "retry_after_seconds"]);
    expect(JSON.stringify(corps)).not.toContain("address");
  });

  test("le délai rendu par la base est arrondi au-dessus", async () => {
    const c = compteur();
    for (let i = 0; i < LIMITE_PAR_ADRESSE.max; i++) await limiterInscription(c.db, { ip: null, email: "x@example.invalid" });
    const v = await limiterInscription(c.db, { ip: null, email: "x@example.invalid" });
    expect(v.ok ? 0 : v.reessayerDans).toBe(3600);
  });

  test("les six langues du widget ont le message du 429", () => {
    const source = readFileSync(new URL("./i18n.ts", import.meta.url), "utf8");
    expect(source.split('"trop-de-tentatives":').length - 1).toBe(6);
  });
});

describe("⛔ la route d'inscription consulte la limite AVANT d'écrire quoi que ce soit", () => {
  /*
   * La route n'est pas sous banc (elle lit ses secrets au chargement) : on lit son CODE,
   * commentaires retirés.
   */
  const source = readFileSync(new URL("../app/api/v1/signup/route.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const position = (motif: string) => {
    const i = source.indexOf(motif);
    expect(i).toBeGreaterThan(-1);
    return i;
  };

  test("appel, puis refus lu et rendu, avant la première lecture de marque et toute écriture", () => {
    const appel = position("await limiterInscription(db, { ip, email })");
    const refus = position("if (!debit.ok) return reponseTropDeTentatives(debit);");
    expect(refus).toBeGreaterThan(appel);
    for (const ensuite of ['.from("asset")', '.from("subscriber")', "newDoiToken()", "queueEmail(db"]) {
      expect(position(ensuite)).toBeGreaterThan(refus);
    }
  });

  test("après les gardes anti-robot : un robot rejeté en silence ne consomme pas la place d'un humain", () => {
    expect(position("await limiterInscription(db, { ip, email })")).toBeGreaterThan(position("verifyForm(body.ft)"));
  });
});
