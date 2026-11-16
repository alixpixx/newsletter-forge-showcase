import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * ⛔ UN FICHIER SERVEUR N'IMPORTE D'UN MODULE `"use client"` QUE DES COMPOSANTS.
 *
 * Next remplace chaque export d'un module `"use client"` par une RÉFÉRENCE client quand un composant
 * serveur l'importe. Rendre un composant ainsi référencé marche ; appeler une fonction ou lire une
 * constante reçue ainsi LÈVE côté serveur. Le 24/09/2026, `/automations/new` et `/automations/[id]/edit`
 * appelaient `defaultsFor` exporté par `automation-form.tsx` : « Something went wrong » à l'ouverture
 * (Alix, Copper Kettle, réf. 1765541213). Ni `tsc`, ni le build, ni un test qui importe le module
 * directement ne le voient — d'où ce garde, qui lit les sources.
 *
 * Règle : dans `src/**`, tout fichier SANS `"use client"` qui importe un module `"use client"` n'en
 * prend que des noms de composants (PascalCase) ou des types.
 */

const SRC = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
// Tout `src`, pas seulement `app` : un composant serveur de `components/` (ex. `automations/views.tsx`)
// tombe de la même façon. Mesuré le 24/09 : 0 violation hors des deux pages corrigées.
const APP = SRC;

function fichiers(dir: string): string[] {
  const out: string[] = [];
  for (const nom of readdirSync(dir)) {
    const p = join(dir, nom);
    if (statSync(p).isDirectory()) out.push(...fichiers(p));
    else if (/\.(ts|tsx)$/.test(nom) && !/\.test\.(ts|tsx)$/.test(nom)) out.push(p);
  }
  return out;
}

/** La directive est la première instruction du fichier (commentaires et lignes vides tolérés avant). */
export function estClient(source: string): boolean {
  const sansCommentaires = source.replace(/^(\s*(\/\/[^\n]*\n|\/\*[\s\S]*?\*\/))*/, "");
  return /^\s*["']use client["']/.test(sansCommentaires);
}

function resoudre(depuis: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(depuis), spec);
  else return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

/** Les noms de VALEUR importés (les types sont ignorés), avec leur nom d'export d'origine. */
export function nomsImportes(clause: string): string[] {
  const noms: string[] = [];
  const accolades = clause.match(/\{([\s\S]*)\}/);
  const avant = clause.replace(/\{[\s\S]*\}/, "").replace(/,\s*$/, "").trim();
  if (avant && !avant.startsWith("* as")) noms.push(avant.replace(/,$/, "").trim()); // import par défaut
  if (accolades) {
    for (const brut of accolades[1].split(",")) {
      const e = brut.trim();
      if (!e || e.startsWith("type ")) continue;
      noms.push(e.split(/\s+as\s+/)[0].trim());
    }
  }
  return noms.filter(Boolean);
}

const COMPOSANT = /^[A-Z][a-z0-9]/;

export function violations(): string[] {
  const out: string[] = [];
  const cache = new Map<string, boolean>();
  for (const f of fichiers(APP)) {
    const source = readFileSync(f, "utf8");
    if (estClient(source)) continue;
    // `[^;'"]` : un `import "x.css";` sans `from` ne doit pas déborder sur l'import suivant.
    for (const m of source.matchAll(/import\s+(?!type\s)([^;'"]*?)\s+from\s+["']([^"']+)["']/g)) {
      const cible = resoudre(f, m[2]);
      if (!cible) continue;
      if (!cache.has(cible)) cache.set(cible, estClient(readFileSync(cible, "utf8")));
      if (!cache.get(cible)) continue;
      for (const nom of nomsImportes(m[1])) {
        if (!COMPOSANT.test(nom)) out.push(`${relative(SRC, f)} importe « ${nom} » de ${relative(SRC, cible)} ("use client")`);
      }
    }
  }
  return out;
}

describe("imports serveur ← modules client", () => {
  test("aucun fichier serveur n'importe autre chose qu'un composant d'un module \"use client\"", () => {
    expect(violations()).toEqual([]);
  });

  test("le garde reconnaît son motif (import d'une fonction, d'une constante ; types et composants permis)", () => {
    expect(nomsImportes("{ AutomationForm, defaultsFor, type FormValue }")).toEqual(["AutomationForm", "defaultsFor"]);
    expect(nomsImportes("Form, { TRIGGERS as T }")).toEqual(["Form", "TRIGGERS"]);
    expect(["AutomationForm", "defaultsFor", "TRIGGERS"].filter((n) => !COMPOSANT.test(n))).toEqual(["defaultsFor", "TRIGGERS"]);
    expect(estClient('// en-tête\n"use client";\nexport const x = 1;')).toBe(true);
    expect(estClient('import x from "y";\n"use client";')).toBe(false);
  });
});
