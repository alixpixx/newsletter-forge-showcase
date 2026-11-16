/**
 * Banc de l'authentification : hachage des mots de passe et jetons de session.
 *
 * Jusqu'au 31/08/2026 ce chemin n'était couvert par AUCUN test — la première modification de
 * auth.ts n'aurait été rattrapée par rien.
 *
 * ⚠️ `auth.ts` lève à l'import si AUTH_SECRET manque. Le module est donc chargé DYNAMIQUEMENT,
 * après avoir posé la variable : un `import` statique serait hissé avant l'affectation et le
 * fichier de test échouerait au chargement, pas sur une assertion.
 */
import { describe, expect, test } from "bun:test";

process.env.AUTH_SECRET = "secret-de-test-uniquement-31082026";
const auth = await import("./auth");
const {
  hashPassword,
  verifyPassword,
  hashToken,
  nouveauJeton,
  signSession,
  verifySession,
  requeteEnHttps,
  sessionPerimee,
  refusMotDePasse,
} = auth;

const IDENTITE = {
  uid: "11111111-2222-3333-4444-555555555555",
  email: "test@example.com",
  role: "member" as const,
};

describe("hachage des mots de passe (PBKDF2 via Web Crypto)", () => {
  test("un mot de passe haché se vérifie", async () => {
    const h = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", h)).toBe(true);
  });

  test("un mot de passe faux est refusé", async () => {
    const h = await hashPassword("le bon");
    expect(await verifyPassword("le mauvais", h)).toBe(false);
  });

  test("le sel change à chaque hachage, et les deux empreintes se vérifient", async () => {
    const a = await hashPassword("identique");
    const b = await hashPassword("identique");
    expect(a === b).toBe(false);
    expect(await verifyPassword("identique", a)).toBe(true);
    expect(await verifyPassword("identique", b)).toBe(true);
  });

  test("le format annoncé est bien celui produit", async () => {
    const h = await hashPassword("x");
    const parts = h.split("$");
    expect(parts.length).toBe(4);
    expect(parts[0]).toBe("pbkdf2");
    expect(Number(parts[1])).toBe(210_000);
  });

  test("une empreinte illisible refuse sans lever (fail closed)", async () => {
    for (const mauvais of ["", "pas-un-hash", "pbkdf2$210000$seul", "bcrypt$1$a$b", "$$$"]) {
      expect(await verifyPassword("x", mauvais)).toBe(false);
    }
    expect(await verifyPassword("x", null)).toBe(false);
  });

  test("une empreinte au nombre d'itérations affaibli est refusée", async () => {
    // Une ligne écrite avec 10 itérations serait cassable ; l'accepter reviendrait à faire
    // confiance à une empreinte que l'on sait faible.
    const h = await hashPassword("x");
    const parts = h.split("$");
    const affaibli = `pbkdf2$10$${parts[2]}$${parts[3]}`;
    expect(await verifyPassword("x", affaibli)).toBe(false);
  });
});

describe("jetons d'invitation", () => {
  test("l'empreinte d'un jeton est déterministe", async () => {
    const j = nouveauJeton();
    expect(await hashToken(j)).toBe(await hashToken(j));
  });

  test("deux jetons tirés se suivent ne se ressemblent pas", () => {
    const a = nouveauJeton();
    const b = nouveauJeton();
    expect(a === b).toBe(false);
    expect(a.length > 20).toBe(true);
  });

  test("l'empreinte ne laisse pas retrouver le jeton", async () => {
    const j = nouveauJeton();
    const h = await hashToken(j);
    expect(h.includes(j)).toBe(false);
    expect(j.includes(h)).toBe(false);
  });
});

describe("sessions", () => {
  test("une session signée se relit avec la même identité", async () => {
    const jeton = await signSession(IDENTITE);
    const lu = await verifySession(jeton);
    expect(lu?.uid).toBe(IDENTITE.uid);
    expect(lu?.email).toBe(IDENTITE.email);
    expect(lu?.role).toBe("member");
  });

  test("le rôle traverse la session", async () => {
    const jeton = await signSession({ ...IDENTITE, role: "super_admin" });
    expect((await verifySession(jeton))?.role).toBe("super_admin");
  });

  test("une signature altérée est refusée", async () => {
    const jeton = await signSession(IDENTITE);
    const [payload, sig] = jeton.split(".");
    const sigCassee = sig.slice(0, -2) + (sig.endsWith("AA") ? "BB" : "AA");
    expect(await verifySession(`${payload}.${sigCassee}`)).toBe(null);
  });

  test("un payload modifié est refusé (le rôle ne se promeut pas)", async () => {
    const jeton = await signSession(IDENTITE);
    const sig = jeton.slice(jeton.indexOf(".") + 1);
    const forge = btoa(JSON.stringify({ ...IDENTITE, role: "super_admin", exp: Date.now() + 9e6 }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(await verifySession(`${forge}.${sig}`)).toBe(null);
  });

  test("une session expirée est refusée", async () => {
    const jeton = await signSession(IDENTITE, -10);
    expect(await verifySession(jeton)).toBe(null);
  });

  test("un jeton vide ou malformé est refusé", async () => {
    expect(await verifySession(undefined)).toBe(null);
    expect(await verifySession("")).toBe(null);
    expect(await verifySession("sans-point")).toBe(null);
    expect(await verifySession(".")).toBe(null);
  });

  /**
   * ⛔ LE test de non-régression du chantier : une session à l'ANCIEN format `{email, exp}`,
   * signée avec le VRAI secret, doit être refusée. Si elle passait, le cloisonnement par compte
   * serait contournable par n'importe quel cookie émis avant le 31/08/2026 — et le chemin de
   * repli resterait ouvert pour toujours.
   */
  test("une session de l'ancien format (sans uid) est refusée malgré une signature valide", async () => {
    const enc = new TextEncoder();
    const b64url = (b: Uint8Array) => {
      let s = "";
      for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
      return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    };
    const cle = await crypto.subtle.importKey(
      "raw",
      enc.encode(process.env.AUTH_SECRET as string),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const fabriquer = async (charge: object) => {
      const payload = b64url(enc.encode(JSON.stringify(charge)));
      const sig = b64url(new Uint8Array(await crypto.subtle.sign("HMAC", cle, enc.encode(payload))));
      return `${payload}.${sig}`;
    };

    // CALIBRATION, sans laquelle ce test ne prouverait rien : la même fabrication, avec un
    // payload au NOUVEAU format, doit être ACCEPTÉE. Elle établit que la signature produite ici
    // est authentique — et donc que le refus ci-dessous vient du format, pas d'une signature
    // ratée par le test lui-même.
    const temoin = await fabriquer({ ...IDENTITE, exp: Date.now() + 9e6 });
    expect((await verifySession(temoin))?.uid).toBe(IDENTITE.uid);

    const ancien = await fabriquer({ email: "test@example.com", exp: Date.now() + 9e6 });
    expect(await verifySession(ancien)).toBe(null);
  });

  test("un rôle inconnu dans le payload est refusé", async () => {
    const jeton = await signSession({ ...IDENTITE, role: "root" as never });
    expect(await verifySession(jeton)).toBe(null);
  });
});


/**
 * ⛔ CE BANC EXISTE POUR UN COOKIE DE SESSION QUI PARTAIT SANS `Secure` EN PRODUCTION.
 *
 * La mesure d'origine lisait `new URL(req.url).protocol`. Derrière Vercel ou un reverse proxy,
 * TLS est terminé au bord et l'application est rappelée EN CLAIR : `req.url` porte l'hôte interne
 * et `http:`. Le drapeau valait donc `false` exactement là où il devait valoir `true`.
 *
 * Le commentaire au-dessus affirmait que la mesure était prise « sur la requête réelle ». Elle
 * l'était — sur la mauvaise requête réelle.
 */
describe("requeteEnHttps — le protocole vu par le NAVIGATEUR, pas par le proxy", () => {
  const req = (url: string, proto?: string): Request =>
    new Request(url, proto === undefined ? undefined : { headers: { "x-forwarded-proto": proto } });

  test("⛔ LE CAS QUI ÉTAIT CASSÉ : le bord a vu https, l'application est rappelée en clair", () => {
    expect(requeteEnHttps(req("http://interne.local/api/auth/login", "https"))).toBe(true);
  });

  test("l'en-tête fait foi quand il est là", () => {
    expect(requeteEnHttps(req("http://x.test/", "https"))).toBe(true);
    expect(requeteEnHttps(req("https://x.test/", "http"))).toBe(false);
  });

  test("⛔ une CHAÎNE de mandataires : seul le premier maillon a vu le navigateur", () => {
    // « https,http » comparé en entier à "https" rendrait false — le défaut d'origine, revenu.
    expect(requeteEnHttps(req("http://x.test/", "https,http"))).toBe(true);
    expect(requeteEnHttps(req("http://x.test/", " https , http "))).toBe(true);
    expect(requeteEnHttps(req("http://x.test/", "http,https"))).toBe(false);
  });

  test("la casse ne décide pas", () => {
    expect(requeteEnHttps(req("http://x.test/", "HTTPS"))).toBe(true);
  });

  test("sans en-tête, on retombe sur l'URL — c'est le cas du développement local", () => {
    expect(requeteEnHttps(req("https://x.test/"))).toBe(true);
    expect(requeteEnHttps(req("http://localhost:3000/"))).toBe(false);
  });

  test("⛔ un en-tête vide n'est pas un en-tête présent", () => {
    // Une chaîne vide est falsy : on retombe sur l'URL plutôt que de conclure « pas https ».
    expect(requeteEnHttps(req("https://x.test/", ""))).toBe(true);
  });
});

/**
 * ⛔ CE BANC TIENT « CHANGER UN MOT DE PASSE FERME LES AUTRES SESSIONS » (0091, 01/10/2026).
 *
 * La base ne tient aucune liste de sessions : un cookie signé reste valable sept jours. La seule
 * chose qui le rend caduc après un changement, c'est la comparaison entre son instant d'émission
 * (`iat`) et la date posée sur le compte. Le mutant le plus facile à écrire — laisser passer un
 * cookie SANS `iat` — rouvrirait pendant sept jours l'accès qu'on vient de fermer.
 */
describe("sessions et changement de mot de passe (0091)", () => {
  test("une session neuve porte son instant d'émission", async () => {
    const avant = Date.now();
    const lu = await verifySession(await signSession(IDENTITE));
    expect(typeof lu?.iat).toBe("number");
    expect((lu?.iat as number) >= avant).toBe(true);
    expect((lu?.iat as number) <= Date.now()).toBe(true);
  });

  test("un cookie d'avant `iat` (uid présent, iat absent) reste RECEVABLE", async () => {
    const enc = new TextEncoder();
    const b64url = (b: Uint8Array) => {
      let s = "";
      for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
      return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    };
    const cle = await crypto.subtle.importKey(
      "raw",
      enc.encode(process.env.AUTH_SECRET as string),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const fabriquer = async (charge: object) => {
      const payload = b64url(enc.encode(JSON.stringify(charge)));
      const sig = b64url(new Uint8Array(await crypto.subtle.sign("HMAC", cle, enc.encode(payload))));
      return `${payload}.${sig}`;
    };
    // Sinon, la mise en ligne déconnecterait tout le monde d'un coup.
    const ancien = await verifySession(await fabriquer({ ...IDENTITE, exp: Date.now() + 9e6 }));
    expect(ancien?.uid).toBe(IDENTITE.uid);
    expect(ancien?.iat).toBeUndefined();
    // Un `iat` qui n'est pas un nombre n'a été écrit par aucune version de ce code.
    expect(await verifySession(await fabriquer({ ...IDENTITE, exp: Date.now() + 9e6, iat: "0" }))).toBe(null);
  });

  test("aucun changement daté : aucune session n'est périmée", () => {
    expect(sessionPerimee(undefined, null)).toBe(false);
    expect(sessionPerimee(1, null)).toBe(false);
  });

  test("émise AVANT le changement : périmée ; émise après, ou au même instant : valable", () => {
    const change = "2026-10-01T18:30:00.500Z";
    const t = Date.parse(change);
    expect(sessionPerimee(t - 1, change)).toBe(true);
    expect(sessionPerimee(t, change)).toBe(false);
    expect(sessionPerimee(t + 1, change)).toBe(false);
    // La forme que PostgREST rend pour un timestamptz : même instant, autre écriture.
    expect(sessionPerimee(t - 1, "2026-10-01T18:30:00.5+00:00")).toBe(true);
    expect(sessionPerimee(t, "2026-10-01T18:30:00.5+00:00")).toBe(false);
  });

  test("⛔ un cookie SANS iat est périmé dès qu'un changement est daté", () => {
    expect(sessionPerimee(undefined, "2026-10-01T18:30:00Z")).toBe(true);
  });

  test("⛔ une date illisible ferme la session (fail closed)", () => {
    expect(sessionPerimee(Date.now(), "pas-une-date")).toBe(true);
  });
});

describe("refusMotDePasse — le seuil commun aux deux routes", () => {
  test("12 caractères passent, 11 non", () => {
    expect(refusMotDePasse("a".repeat(12))).toBe(null);
    expect(refusMotDePasse("a".repeat(11))).toContain("at least 12");
  });

  test("ni vide, ni autre chose qu'une chaîne", () => {
    for (const v of ["", undefined, null, 123456789012, ["a".repeat(12)]]) {
      expect(refusMotDePasse(v)).toBe("Enter a password.");
    }
  });

  test("plafond à 256 : PBKDF2 hache l'entrée entière", () => {
    expect(refusMotDePasse("a".repeat(256))).toBe(null);
    expect(refusMotDePasse("a".repeat(257))).toContain("at most 256");
  });

  test("les espaces comptent : aucun trim", () => {
    expect(refusMotDePasse("   " + "a".repeat(9))).toBe(null);
  });
});
