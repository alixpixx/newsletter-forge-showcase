/**
 * BORNES NUMÉRIQUES LUES DANS LE SCHÉMA — jamais recopiées à la main.
 *
 * ⛔ POURQUOI. Un champ numérique de l'inspecteur qui borne à 8–72 alors que le schéma dit 8–40
 * laisse écrire une valeur que la sauvegarde refusera ensuite, loin du geste ; l'inverse interdit
 * une valeur légitime. Les deux dérivent dès que le schéma bouge — et il bouge : un autre chantier
 * ajoute des propriétés en parallèle. Lire les bornes dans l'objet Zod lui-même garde UNE vérité.
 *
 * ⛔ UNE CLÉ QUI N'EST PLUS UN NOMBRE BORNÉ LÈVE AU CHARGEMENT. Les constantes sont calculées à
 * l'import du module : un schéma modifié fait donc échouer les bancs et le typecheck de la build,
 * jamais un champ en silence à l'écran.
 */
import { NEW_PROPS_2026_09_22, newPropKey, type NewPropSpec } from "@nf/render";

/**
 * Un objet Zod vu par sa seule forme. Typé structurellement : `z.ZodObject` est générique sur sa
 * configuration (`strict`, `strip`…), et un objet `.strict()` du schéma ne s'y assignerait pas.
 */
export interface ShapeHolder {
  shape: Record<string, unknown>;
}

/** Enveloppes qui ne changent pas la nature de la valeur portée. */
const WRAPPERS = new Set(["optional", "default", "prefault", "nullable", "readonly", "catch", "nonoptional"]);

interface Introspectable {
  def?: { type?: string; innerType?: unknown; element?: unknown };
  shape?: Record<string, unknown>;
  minValue?: number | null;
  maxValue?: number | null;
  isInt?: boolean;
}

/** Déballe `optional` / `default` / `prefault`… jusqu'au type qui porte la valeur. */
export function unwrapSchema(schema: unknown): Introspectable {
  let cur = schema as Introspectable;
  while (cur?.def?.type !== undefined && WRAPPERS.has(cur.def.type) && cur.def.innerType !== undefined) {
    cur = cur.def.innerType as Introspectable;
  }
  return cur;
}

/** L'objet Zod porté par une clé (sous ses enveloppes). Lève si ce n'en est pas un. */
export function objectAt(object: ShapeHolder, key: string): ShapeHolder {
  const inner = unwrapSchema(object.shape[key]);
  if (inner?.def?.type !== "object" || inner.shape === undefined) throw new Error(`schema: "${key}" is not an object`);
  return inner as ShapeHolder;
}

export interface NumberBounds {
  min: number;
  max: number;
  /** Le schéma exige un entier : le champ doit arrondir, sinon le document devient insauvegardable. */
  int: boolean;
}

export function boundsOf(object: ShapeHolder, key: string): NumberBounds {
  const s = unwrapSchema(object.shape[key]);
  if (s?.def?.type !== "number" || typeof s.minValue !== "number" || typeof s.maxValue !== "number") {
    throw new Error(`schema: "${key}" is not a bounded number`);
  }
  return { min: s.minValue, max: s.maxValue, int: s.isInt === true };
}

/** L'objet Zod des ÉLÉMENTS d'une liste (`segments[]`, `webFonts[]`…). Lève si ce n'en est pas un. */
export function elementObjectAt(object: ShapeHolder, key: string): ShapeHolder {
  const list = unwrapSchema(object.shape[key]);
  const element = list?.def?.type === "array" ? unwrapSchema(list.def.element) : undefined;
  if (element?.def?.type !== "object" || element.shape === undefined) {
    throw new Error(`schema: "${key}" is not a list of objects`);
  }
  return element as ShapeHolder;
}

/**
 * Longueurs admises d'une liste ou d'une chaîne (`min`/`max` du schéma). Une borne absente du schéma
 * vaut 0 (minimum) ou l'infini (maximum) — jamais une valeur inventée ici.
 */
export function lengthOf(object: ShapeHolder, key: string): { min: number; max: number } {
  const s = unwrapSchema(object.shape[key]) as Introspectable & {
    _zod?: { bag?: { minimum?: unknown; maximum?: unknown } };
  };
  if (s?.def?.type !== "array" && s?.def?.type !== "string") throw new Error(`schema: "${key}" has no length`);
  const bag = s._zod?.bag ?? {};
  return {
    min: typeof bag.minimum === "number" ? bag.minimum : 0,
    max: typeof bag.maximum === "number" ? bag.maximum : Number.POSITIVE_INFINITY,
  };
}

/**
 * Les valeurs d'une énumération du schéma, dans l'ordre du schéma. Une valeur AJOUTÉE au schéma
 * apparaît donc d'elle-même dans le menu (avec son nom brut tant qu'aucun libellé ne la décrit),
 * au lieu d'être inatteignable depuis l'éditeur.
 */
export function enumOf(object: ShapeHolder, key: string): string[] {
  const s = unwrapSchema(object.shape[key]) as Introspectable & { options?: unknown };
  if (s?.def?.type !== "enum" || !Array.isArray(s.options)) throw new Error(`schema: "${key}" is not an enum`);
  return s.options.map(String);
}

/** Ramène une saisie dans les bornes du schéma. `undefined` reste `undefined` (= héritage). */
export function clampTo(b: NumberBounds, v: number | undefined): number | undefined {
  if (v === undefined || Number.isNaN(v)) return undefined;
  const n = Math.min(Math.max(v, b.min), b.max);
  return b.int ? Math.round(n) : Math.round(n * 100) / 100;
}

/* ------------------------------------------------------------------ *
 * Le manifeste des réglages du 22/09/2026 — indication, bornes, défaut
 * ------------------------------------------------------------------ */

const SPECS = new Map(NEW_PROPS_2026_09_22.map((p) => [newPropKey(p), p]));

/**
 * L'entrée du manifeste `NEW_PROPS_2026_09_22` pour `target:path` (`pick:kickoffSize`,
 * `article-feed.card:kickerGap`, `theme:textPresets.h1.size`…).
 *
 * ⛔ UNE ENTRÉE ABSENTE LÈVE AU CHARGEMENT, comme une borne absente plus haut : un champ qui
 * inventerait son indication ou son défaut dériverait du compilateur sans que rien ne le dise.
 * Le manifeste est tenu contre le schéma par `packages/render/src/compile/reglages.test.ts`.
 */
export function propSpec(target: string, path: string): NewPropSpec {
  const spec = SPECS.get(`${target}:${path}`);
  if (spec === undefined) throw new Error(`manifest: no entry for "${target}:${path}"`);
  return spec;
}

/**
 * Les bornes numériques d'une entrée du manifeste. Le manifeste ne dit pas « entier » : il donne un
 * `step` aux seuls nombres décimaux (interlignes, interlettrage) — tout autre nombre est un entier
 * pour le schéma, et le champ doit arrondir.
 */
export function specBounds(spec: NewPropSpec): NumberBounds {
  if (spec.min === undefined || spec.max === undefined) throw new Error(`manifest: "${newPropKey(spec)}" has no bounds`);
  return { min: spec.min, max: spec.max, int: spec.step === undefined };
}

/**
 * Le défaut LITTÉRAL d'une entrée, tel qu'on l'affiche en grisé. `undefined` quand le défaut est une
 * règle (`computed`) : c'est alors à l'appelant de la calculer avec la cascade qu'il connaît — le
 * texte de la règle (« max(13, block font size − 2) ») n'est pas une valeur que l'abonné reçoit.
 */
export function literalDefault(spec: NewPropSpec): string | undefined {
  return spec.computed === true ? undefined : String(spec.default);
}

/** Bornes, pas et indication d'un champ numérique, tels que `NumberInput` les prend. */
export function numberField(spec: NewPropSpec): { min: number; max: number; step?: number; hint: string } {
  const b = specBounds(spec);
  return { min: b.min, max: b.max, ...(spec.step === undefined ? {} : { step: spec.step }), hint: spec.hint };
}
