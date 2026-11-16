/**
 * L'ORIGINE D'UN LIEN D'E-MAIL — le banc du défaut du 18/09/2026.
 *
 * Le cas de tête est reproduit à l'identique : conteneur Next qui écoute sur `0.0.0.0:3000`,
 * derrière un reverse proxy. Avant le correctif, le lien de confirmation partait sur
 * `https://0.0.0.0:3000/confirm?token=…` et n'ouvrait rien.
 */
import { describe, expect, test } from "bun:test";
import { origineEmail, origineJoignable, type SourcesOrigine } from "./origine-publique";

const enTetes = (h: Record<string, string>) => ({
  get: (n: string): string | null => h[n.toLowerCase()] ?? null,
});

const s = (p: Partial<SourcesOrigine> = {}): SourcesOrigine => ({
  urlRequete: "https://0.0.0.0:3000/api/v1/signup",
  enTetes: enTetes({}),
  env: {},
  production: true,
  ...p,
});

describe("origineEmail", () => {
  /**
   * ⛔ LE BANC CENTRAL. MUTATION QUI DOIT LE TUER : revenir à `new URL(req.url).origin`.
   * Symptôme en production : chaque confirmation part avec un lien vers l'adresse d'écoute du
   * conteneur, la personne clique et lit « This site can't be reached ». Son inscription reste
   * `pending` pour toujours.
   */
  test("le conteneur qui écoute sur 0.0.0.0 ne fournit JAMAIS l'origine", () => {
    const r = origineEmail(s());
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.raison).toBe("origine-non-publique:0.0.0.0:3000");
  });

  test("la variable d'environnement gagne, et le / final est retiré", () => {
    const r = origineEmail(s({ env: { PUBLIC_BASE_URL: "https://newsletter-public.example.com/" } }));
    expect(r).toEqual({ ok: true, origine: "https://newsletter-public.example.com", source: "env" });
  });

  test("à défaut de variable, l'en-tête du proxy donne le nom d'entrée", () => {
    const r = origineEmail(
      s({ enTetes: enTetes({ "x-forwarded-host": "newsletter-public.example.com", "x-forwarded-proto": "https" }) }),
    );
    expect(r).toEqual({ ok: true, origine: "https://newsletter-public.example.com", source: "proxy" });
  });

  /**
   * ⛔ MUTATION QUI DOIT LE TUER : préférer l'en-tête à la variable. Un `x-forwarded-host` forgé
   * ferait alors pointer NOTRE lien de confirmation, signé de la marque, vers le domaine d'un tiers.
   */
  test("un en-tête forgé ne déplace pas un lien quand la variable est posée", () => {
    const r = origineEmail(
      s({
        env: { PUBLIC_BASE_URL: "https://newsletter-public.example.com" },
        enTetes: enTetes({ "x-forwarded-host": "pirate.test" }),
      }),
    );
    expect(r.ok === true && r.origine).toBe("https://newsletter-public.example.com");
  });

  test("plusieurs sauts dans l'en-tête : le premier est l'entrée publique", () => {
    const r = origineEmail(s({ enTetes: enTetes({ "x-forwarded-host": "a.exemple.test, interne", "x-forwarded-proto": "https, http" }) }));
    expect(r.ok === true && r.origine).toBe("https://a.exemple.test");
  });

  test("sans en-tête de schéma, on suppose https (un lien d'e-mail ne part pas en clair)", () => {
    const r = origineEmail(s({ enTetes: enTetes({ host: "a.exemple.test" }) }));
    expect(r.ok === true && r.origine).toBe("https://a.exemple.test");
  });

  test("une variable illisible n'empêche pas le proxy de fournir l'origine", () => {
    const r = origineEmail(
      s({ env: { PUBLIC_BASE_URL: "pas une url" }, enTetes: enTetes({ "x-forwarded-host": "a.exemple.test" }) }),
    );
    expect(r).toEqual({ ok: true, origine: "https://a.exemple.test", source: "proxy" });
  });

  test("en développement, localhost redevient une origine acceptable", () => {
    const r = origineEmail(s({ urlRequete: "http://localhost:3000/api/v1/signup", production: false }));
    expect(r).toEqual({ ok: true, origine: "http://localhost:3000", source: "requete" });
  });

  test("en production, localhost reste refusé", () => {
    expect(origineEmail(s({ urlRequete: "http://localhost:3000/x" })).ok).toBe(false);
  });
});

describe("origineJoignable", () => {
  test("refuse les adresses d'écoute", () => {
    for (const u of ["https://0.0.0.0:3000", "http://127.0.0.1", "http://[::1]:3000", "http://localhost"]) {
      expect(origineJoignable(new URL(u), true)).toBe(false);
    }
  });

  /** Un nom de service Docker résout dans le réseau du conteneur, et nulle part chez l'abonné. */
  test("refuse un nom sans point en production, l'accepte en développement", () => {
    expect(origineJoignable(new URL("http://public:3000"), true)).toBe(false);
    expect(origineJoignable(new URL("http://public:3000"), false)).toBe(true);
  });

  /**
   * ⛔ MUTATION QUI DOIT LE TUER : traiter `0.0.0.0` comme `localhost` (acceptable en dev).
   * `0.0.0.0` n'est joignable NULLE PART, pas même localement : c'est « toutes les interfaces ».
   */
  test("0.0.0.0 reste refusé même en développement, contrairement à localhost", () => {
    expect(origineJoignable(new URL("https://0.0.0.0:3000"), false)).toBe(false);
    expect(origineJoignable(new URL("http://localhost:3000"), false)).toBe(true);
  });

  test("refuse un schéma qui n'est pas http(s)", () => {
    expect(origineJoignable(new URL("ftp://exemple.test"), true)).toBe(false);
  });

  test("accepte un domaine public", () => {
    expect(origineJoignable(new URL("https://newsletter-public.example.com"), true)).toBe(true);
  });
});
