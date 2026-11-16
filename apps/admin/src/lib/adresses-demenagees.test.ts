/**
 * PARITÉ DES ROUTES — le déménagement sous « Automations » (24/09/2026) ne perd aucune adresse.
 *
 * Ce qui est tenu :
 *  1. chaque ANCIENNE adresse d'écran mène à la NOUVELLE (table de `adresseDemenagee`) ;
 *  2. chaque nouvelle adresse est servie par une page qui EXISTE sur le disque — une redirection
 *     vers un 404 serait pire que pas de redirection ;
 *  3. l'ancienne page Segments n'existe plus (sinon deux écrans pour un même réglage) ;
 *  4. ce qui ne doit PAS bouger ne bouge pas : `?lifecycle=0`, `/api/segments/*`, `/segmentsX` ;
 *  5. le panneau « Lifecycle emails » a quitté `/templates`, puis sa page : il vit sur la page de chaque
 *     e-mail (`/automations/system/[kind]`), et `/automations/lifecycle` mène à la carte System ;
 *  6. plus aucun lien interne ne pointe une ancienne adresse (il coûterait une 308 à chaque clic,
 *     et dirait à qui lit le code que l'écran est encore là).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { adresseDemenagee, ADRESSE_LIFECYCLE } from "./adresses-demenagees";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const DASHBOARD = path.join(SRC, "app", "(dashboard)");

/** L'URL complète (chemin + requête) vers laquelle une adresse est déménagée, ou null. */
function vers(adresse: string): string | null {
  const u = new URL(adresse, "http://admin.local");
  const d = adresseDemenagee(u.pathname, u.searchParams);
  return d ? d.pathname + d.search : null;
}

/** Le fichier `page.tsx` qui sert un chemin d'écran du groupe (dashboard), segments statiques seuls. */
function pageDe(chemin: string): string {
  return path.join(DASHBOARD, ...chemin.split("/").filter(Boolean), "page.tsx");
}

/** ⛔ LA TABLE DE PARITÉ : toute ancienne adresse d'écran du déménagement, et sa nouvelle place. */
const PARITE: ReadonlyArray<[ancienne: string, nouvelle: string]> = [
  ["/segments", "/automations/targeting"],
  ["/templates?lifecycle=1", "/automations"],
  ["/automations/lifecycle", "/automations"],
];

describe("parité des routes — chaque ancienne adresse mène à la nouvelle", () => {
  for (const [ancienne, nouvelle] of PARITE) {
    test(`${ancienne} → ${nouvelle}`, () => {
      expect(vers(ancienne)).toBe(nouvelle);
    });

    test(`${nouvelle} est servie par une page qui existe`, () => {
      expect(existsSync(pageDe(new URL(nouvelle, "http://x").pathname))).toBe(true);
    });
  }

  test("l'ancienne page Segments n'existe plus (un seul écran pour ce réglage)", () => {
    expect(existsSync(path.join(DASHBOARD, "segments"))).toBe(false);
  });

  test("la page d'accueil de la section existe", () => {
    expect(existsSync(pageDe("/automations"))).toBe(true);
  });

  test("ADRESSE_LIFECYCLE est la page de la carte System", () => {
    expect(ADRESSE_LIFECYCLE).toBe("/automations");
  });

  test("l'ancienne page « Lifecycle emails » n'existe plus (un seul écran par e-mail)", () => {
    expect(existsSync(path.join(DASHBOARD, "automations", "lifecycle"))).toBe(false);
  });
});

describe("sous-chemins et requête — rien ne se perd en route", () => {
  test("un sous-chemin de /segments suit le préfixe", () => {
    expect(vers("/segments/abc")).toBe("/automations/targeting/abc");
  });

  test("la requête d'un écran Segments est conservée", () => {
    expect(vers("/segments?x=1&y=deux")).toBe("/automations/targeting?x=1&y=deux");
  });

  test("les paramètres de la LISTE des modèles ne suivent pas vers le panneau", () => {
    // `tab`, `lifecycle` n'ont aucun sens sur la page du cycle de vie.
    expect(vers("/templates?lifecycle=1&tab=brand")).toBe("/automations");
    expect(vers("/automations/lifecycle?x=1")).toBe("/automations");
  });
});

describe("ce qui ne doit PAS déménager", () => {
  test("⛔ `?lifecycle=0` reste sur /templates — comparaison FERMÉE, comme l'ancienne page", () => {
    expect(vers("/templates?lifecycle=0")).toBeNull();
    expect(vers("/templates?lifecycle=")).toBeNull();
    expect(vers("/templates?lifecycle=true")).toBeNull();
  });

  test("/templates sans filtre, et ses onglets, restent en place", () => {
    expect(vers("/templates")).toBeNull();
    expect(vers("/templates?tab=legal")).toBeNull();
  });

  test("⛔ les routes de DONNÉES /api/segments/* ne bougent pas", () => {
    expect(vers("/api/segments")).toBeNull();
    expect(vers("/api/segments/count")).toBeNull();
  });

  test("`/segmentsX` n'est pas un sous-chemin de `/segments`", () => {
    expect(vers("/segments-archive")).toBeNull();
  });

  test("les nouvelles adresses ne redirigent pas (pas de boucle)", () => {
    for (const [, nouvelle] of PARITE) expect(vers(nouvelle)).toBeNull();
    expect(vers("/automations")).toBeNull();
  });
});

describe("le panneau « Lifecycle emails » a quitté /templates", () => {
  const templates = readFileSync(pageDe("/templates"), "utf8");
  const lifecycle = readFileSync(path.join(DASHBOARD, "automations", "system", "[kind]", "page.tsx"), "utf8");

  test("/templates ne monte plus LifecyclePanel", () => {
    expect(templates.includes("LifecyclePanel")).toBe(false);
    expect(templates.includes("lifecycle-panel")).toBe(false);
  });

  test("/automations/system/[kind] monte LifecyclePanel", () => {
    expect(lifecycle).toContain('from "@/components/templates/lifecycle-panel"');
    expect(lifecycle).toContain("<LifecyclePanel");
  });
});

/** Tous les fichiers source de l'admin, hors bancs. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const nom of readdirSync(dir)) {
    const p = path.join(dir, nom);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.(ts|tsx)$/.test(nom) && !/\.test\.tsx?$/.test(nom)) out.push(p);
  }
  return out;
}

describe("aucun lien interne vers une ancienne adresse", () => {
  // Une adresse de CODE : entre guillemets (`href="/segments"`, `push('/segments/x')`) ou gabarit
  // (`` `/segments/${id}` ``) — PAS `/api/segments`, et pas les commentaires qui racontent le
  // déménagement entre accents graves.
  const ANCIENNE_SEGMENTS = /["']\/segments(?=["'/?#])|`\/segments\/\$\{/;
  const ANCIENNE_FILTRE = /["']\/templates\?lifecycle=1/;
  const ANCIENNE_LIFECYCLE = /["'`]\/automations\/lifecycle(?=["'`/?#])/;

  const fautifs = sources(SRC)
    // La table des déménagements NOMME les anciennes adresses : c'est son rôle.
    .filter((f) => !f.endsWith(`${path.sep}adresses-demenagees.ts`))
    .filter((f) => {
      const texte = readFileSync(f, "utf8");
      return ANCIENNE_SEGMENTS.test(texte) || ANCIENNE_FILTRE.test(texte) || ANCIENNE_LIFECYCLE.test(texte);
    })
    .map((f) => path.relative(SRC, f));

  test("0 fichier source ne pointe `/segments`, `/templates?lifecycle=1` ou `/automations/lifecycle`", () => {
    expect(fautifs).toEqual([]);
  });

  test("le motif attrape bien un ancien lien (témoin du détecteur)", () => {
    expect(ANCIENNE_SEGMENTS.test('<Link href="/segments">')).toBe(true);
    expect(ANCIENNE_SEGMENTS.test("router.push(`/segments/${id}`)")).toBe(true);
    expect(ANCIENNE_FILTRE.test('<Link href="/templates?lifecycle=1">')).toBe(true);
    expect(ANCIENNE_LIFECYCLE.test('<Link href="/automations/lifecycle" />')).toBe(true);
    expect(ANCIENNE_LIFECYCLE.test('<Link href="/automations/system/welcome" />')).toBe(false);
    expect(ANCIENNE_SEGMENTS.test('fetch("/api/segments/count")')).toBe(false);
  });
});
