"use client";

import { createContext, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, X, FolderPlus, Loader2, AlertTriangle, Save, ChevronsUpDown } from "lucide-react";
import {
  FIELDS, CATEGORIES, CTA_OPTIONS, getField, defaultValue, makePredicate,
  summarize, updateNode, removeNode, addChild,
  INITIAL_TREE,
  type FieldCategory, type Group, type LabelBook, type Option, type Predicate,
  type RuleNode, type Operator, type PredValue,
} from "@nf/segments/fields";
import { cn } from "@/lib/utils";
import { SIZE_UNAVAILABLE, segmentSize } from "./segment-size";

/**
 * Une option de provenance, avec son NOMBRE D'ABONNÉS.
 *
 * ⛔ POURQUOI LE COMPTEUR EST INDISPENSABLE. Sans lui, on coche un intérêt que personne n'a jamais
 * choisi, le segment rend 0, et rien à l'écran ne distingue « personne n'a coché ça » de « le
 * filtre est cassé ». Le compteur est mesuré par la route sur la MÊME population que le compte du
 * segment (`sendable_subscription`) : une pastille ne peut donc pas contredire le chiffre affiché.
 */
interface CountedOption extends Option {
  count?: number;
  archived?: boolean;
}

const selectCls =
  "rounded-lg border border-border bg-card px-2.5 py-1.5 text-[12.5px] text-foreground outline-none transition-colors focus:border-brand focus:ring-2 focus:ring-brand/20";

/**
 * Les valeurs RÉELLES de la marque courante (tags, formulaires d'opt-in), chargées une fois.
 *
 * ⛔ POURQUOI UN CONTEXTE ET PAS DES PROPS. `GroupEditor` est récursif : faire descendre ces listes
 * en props les ferait traverser trois niveaux et chaque groupe imbriqué, pour une valeur qui ne
 * change jamais pendant l'édition. Le jour où un niveau oublie de les passer, ses selects
 * repartiraient silencieusement sur les exemples codés en dur — c'est-à-dire sur le défaut qu'on
 * est en train de corriger.
 *
 * `null` = pas encore chargé, ou lecture en échec. C'est DIFFÉRENT d'une liste vide, qui veut dire
 * « cette marque n'a réellement aucun tag » : les deux appellent des gestes opposés.
 */
interface RealLists {
  /**
   * ⛔ « PAS ENCORE LU » N'EST PAS « LECTURE EN ÉCHEC », ET `null` NE PEUT PAS DIRE LES DEUX.
   *
   * Sans ce drapeau, le premier rendu — celui d'avant la réponse de `/api/segments/options`, donc
   * celui que tout le monde voit — affiche « Capture campaigns could not be loaded for this
   * brand. » alors que rien n'a échoué : la lecture n'est simplement pas revenue. Une panne
   * annoncée pendant un chargement normal apprend à ignorer le message le jour où il est vrai.
   */
  charge: boolean;
  tags: Option[] | null;
  optins: Option[] | null;
  /** Campagnes d'acquisition optinforge (`newsletter.capture_campaign`). */
  captureCampaigns: CountedOption[] | null;
  /** Créatives (`newsletter.optin`), désambiguïsées par leur campagne quand elles sont homonymes. */
  captureCreatives: CountedOption[] | null;
  /** Intérêts cochés au formulaire (`newsletter.tag` de `kind = 'interest'`). */
  interests: CountedOption[] | null;
  /** Toutes les automations de la marque, tous statuts (`newsletter.automation`). */
  automations: CountedOption[] | null;
  /** Les e-mails système du registre, avec leurs compteurs. */
  systemEmails: CountedOption[] | null;
}

const LISTES_VIDES: RealLists = {
  charge: false,
  tags: null, optins: null, captureCampaigns: null, captureCreatives: null, interests: null,
  automations: null, systemEmails: null,
};

const RealOptions = createContext<RealLists>(LISTES_VIDES);

/**
 * Quelle liste alimente quel champ multi, et ce que l'écran dit quand elle manque.
 *
 * ⚠️ Les phrases sont PAR CHAMP : « Capture automations could not be loaded » serait faux, et une
 * phrase fausse apprend à ignorer la vraie.
 */
const MULTI_LIST: Record<
  string,
  {
    cle: "captureCampaigns" | "captureCreatives" | "interests" | "automations" | "systemEmails";
    noun: string;
    echec: string;
    vide: string;
  }
> = {
  capture_campaign: {
    cle: "captureCampaigns", noun: "campaigns",
    echec: "Capture campaigns could not be loaded for this brand.", vide: "No capture campaigns on this brand yet.",
  },
  capture_creative: {
    cle: "captureCreatives", noun: "creatives",
    echec: "Capture creatives could not be loaded for this brand.", vide: "No capture creatives on this brand yet.",
  },
  interest: {
    cle: "interests", noun: "interests",
    echec: "Capture interests could not be loaded for this brand.", vide: "No capture interests on this brand yet.",
  },
  automation_email: {
    cle: "automations", noun: "automations",
    echec: "Automations could not be loaded for this brand.", vide: "No automations on this brand yet.",
  },
  lifecycle_email: {
    cle: "systemEmails", noun: "system emails",
    echec: "System emails could not be loaded.", vide: "No system emails.",
  },
};

/**
 * Les options à afficher pour ce prédicat, et la valeur courante GARDÉE VISIBLE.
 *
 * ⛔ Une valeur enregistrée qui n'est plus dans la liste (tag supprimé, optin d'une autre marque)
 * ne doit pas disparaître : un `<select>` dont la `value` n'existe pas affiche sa PREMIÈRE option.
 * L'écran montrerait alors « futebol » là où la règle dit « vip », et le premier enregistrement
 * remplacerait la règle sans que personne n'ait rien demandé. On la réinjecte, marquée.
 */
function optionsFor(valueType: string, statiques: Option[] | undefined, dyn: Option[] | null, courante: string): Option[] {
  const base = valueType === "optin"
    // « No opt-in form » est une valeur du registre, pas de la base : elle reste en tête.
    ? [...(statiques ?? []), ...(dyn ?? [])]
    : (dyn ?? statiques ?? []);
  if (!courante || base.some((o) => o.value === courante)) return base;
  return [...base, { value: courante, label: `${courante} (not found)` }];
}

/**
 * Le même geste, ÉLÉMENT PAR ÉLÉMENT, pour une multi-sélection.
 *
 * ⛔ Un multi-select qui se contente d'intersecter la valeur avec les options disponibles reproduit
 * le défaut ci-dessus, en pire : il efface des valeurs à CHAQUE rendu. Une campagne supprimée
 * disparaîtrait des pastilles, l'écran montrerait cinq valeurs là où la règle en porte six, et le
 * premier enregistrement réécrirait la règle sans que personne ne l'ait demandé.
 */
function multiOptionsFor(dyn: CountedOption[] | null, choisies: string[]): CountedOption[] {
  const base = dyn ?? [];
  const disparues = choisies
    .filter((v) => !base.some((o) => o.value === v))
    .map((v) => ({ value: v, label: `${v.length > 12 ? `${v.slice(0, 8)}…` : v} (not found)` }));
  return [...base, ...disparues];
}

/** La règle porte-t-elle au moins une condition de PROVENANCE ? (décide de l'état vide nommé) */
function usesCapture(node: RuleNode): boolean {
  if (node.type === "predicate") return getField(node.field)?.category === "Capture";
  return node.children.some(usesCapture);
}

/* ---------- multi-sélection, DÉPLIÉE EN FLUX ---------- */
/**
 * ⛔ NI `position: fixed`, NI `position: absolute` — ET LES DEUX RAISONS SONT DIFFÉRENTES.
 *
 * `fixed` : la page des segments est enveloppée dans `.animate-fade-up`, défini avec `backwards`
 * et PAS `both` (globals.css). Pendant l'animation, le `translateY` fait de l'ancêtre un
 * containing block pour tout descendant `fixed` : le calque se cale sur le bloc de contenu au lieu
 * de la fenêtre. Constaté deux fois en production le 08/09/2026 (drawer, barre d'actions), au point
 * qu'un portail dédié existe dans ce dépôt pour le contourner.
 *
 * `absolute` : c'est la solution du seul précédent maison (le sélecteur de marque), et elle est
 * mauvaise ICI pour une autre raison — le panneau recouvrirait les lignes de prédicat suivantes et
 * le bouton « Add condition », dans un conteneur qui n'a aucun `overflow` pour l'accueillir.
 *
 * En flux, les deux problèmes disparaissent, et « aucun calque flottant introduit » se vérifie par
 * un `grep` à zéro occurrence.
 */
function MultiSelect({
  choisies, options, noun, indisponible, onChange,
}: {
  choisies: string[];
  options: CountedOption[];
  noun: string;
  /** Non-null = la liste n'est pas exploitable, et on DIT pourquoi au lieu d'ouvrir un panneau vide. */
  indisponible: string | null;
  onChange: (v: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filtre, setFiltre] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemsRef = useRef<Array<HTMLInputElement | null>>([]);
  const panelId = useId();

  // Clic extérieur + Échap qui REND LE FOCUS au déclencheur (sinon le focus retombe sur le body et
  // la tabulation suivante repart du haut de la page).
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const q = filtre.trim().toLowerCase();
  const visibles = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;

  function focusAt(i: number) {
    itemsRef.current[i]?.focus();
  }

  function onPanelKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const last = visibles.length - 1;
    if (last < 0) return;
    const cur = itemsRef.current.findIndex((el) => el !== null && el === document.activeElement);
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        focusAt(cur < last ? cur + 1 : 0);
        break;
      case "ArrowUp":
        e.preventDefault();
        focusAt(cur > 0 ? cur - 1 : last);
        break;
      case "Home":
        e.preventDefault();
        focusAt(0);
        break;
      case "End":
        e.preventDefault();
        focusAt(last);
        break;
      case "Tab":
        setOpen(false);
        break;
      default:
        break;
    }
  }

  const toggle = (v: string) =>
    onChange(choisies.includes(v) ? choisies.filter((x) => x !== v) : [...choisies, v]);

  const libelle = (v: string) => options.find((o) => o.value === v)?.label ?? v;

  if (indisponible) {
    return (
      <p className="rounded-lg border border-dashed border-border px-2.5 py-1.5 text-[11.5px] text-muted-foreground">
        {indisponible}
      </p>
    );
  }

  return (
    <div ref={rootRef} className="flex flex-col gap-1.5">
      {/* Les valeurs choisies, AU-DESSUS du panneau : elles restent lisibles panneau fermé, et une
          valeur disparue de la base reste visible, marquée « (not found) ». */}
      {choisies.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {choisies.map((v) => (
            <span
              key={v}
              className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-2 py-[2px] text-[11.5px] font-medium text-brand-soft-foreground"
            >
              {libelle(v)}
              <button
                type="button"
                onClick={() => toggle(v)}
                aria-label={`Remove ${libelle(v)}`}
                className="rounded-full text-current/70 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
          }
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        className={cn(selectCls, "inline-flex w-fit items-center gap-2 text-left")}
      >
        {choisies.length === 0 ? `Select ${noun}…` : `${choisies.length} selected`}
        <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" aria-hidden="true" />
      </button>

      {open && (
        <div
          id={panelId}
          role="group"
          aria-label={`Choose ${noun}`}
          onKeyDown={onPanelKeyDown}
          className="rounded-xl border border-border bg-card p-1.5"
        >
          {/* Au-delà de 8 options, on cherche au lieu de faire défiler. */}
          {options.length > 8 && (
            <input
              value={filtre}
              onChange={(e) => setFiltre(e.target.value)}
              placeholder={`Filter ${noun}…`}
              className="mb-1.5 w-full rounded-lg border border-border bg-background px-2 py-1 text-[12px] outline-none focus:border-brand"
            />
          )}
          <div className="max-h-[220px] overflow-y-auto">
            {visibles.length === 0 && (
              <p className="px-2 py-1.5 text-[11.5px] text-muted-foreground">No match.</p>
            )}
            {visibles.map((o, i) => (
              <label
                key={o.value}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] hover:bg-accent"
              >
                <input
                  ref={(el) => {
                    itemsRef.current[i] = el;
                  }}
                  type="checkbox"
                  checked={choisies.includes(o.value)}
                  onChange={() => toggle(o.value)}
                  className="h-3.5 w-3.5 accent-[#e0246f]"
                />
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {/* Une créative retirée du site garde ses contacts : elle reste cochable, et le
                    dire évite de croire la liste incomplète. */}
                {o.archived && (
                  <span className="shrink-0 rounded-full bg-accent px-1.5 text-[10.5px] text-muted-foreground">
                    archived
                  </span>
                )}
                {/* ⚠️ Un compteur ABSENT n'est pas un compteur à zéro : on n'affiche rien plutôt
                    que d'inventer un « 0 » qui ferait renoncer à cocher une option valide. */}
                {o.count != null && (
                  <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">
                    {o.count.toLocaleString("en-US")}
                  </span>
                )}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- contrôle de valeur selon le type de champ ---------- */
function ValueControl({ pred, onChange }: { pred: Predicate; onChange: (v: PredValue) => void }) {
  const f = getField(pred.field);
  const real = useContext(RealOptions);
  if (!f) return null;

  switch (f.valueType) {
    case "select":
    case "tag":
    case "optin": {
      const dyn = f.valueType === "tag" ? real.tags : f.valueType === "optin" ? real.optins : null;
      const options = optionsFor(f.valueType, f.options, dyn, String(pred.value));
      if (options.length === 0) {
        // Une marque sans aucun tag : le dire, plutôt que d'ouvrir un select vide qui ne
        // sélectionnera jamais rien et laissera la règle sur une valeur invisible.
        return (
          <select className={cn(selectCls, "text-muted-foreground")} disabled>
            <option>No tags on this brand yet</option>
          </select>
        );
      }
      return (
        <select className={selectCls} value={String(pred.value)} onChange={(e) => onChange(e.target.value)}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      );
    }
    case "multi": {
      const spec = MULTI_LIST[f.key];
      /*
       * ⛔ UN `return null` ICI SERAIT LA MÊME PANNE QUE LA LISTE DE CATÉGORIES ÉCRITE À LA MAIN :
       * la ligne rendrait son champ et son opérateur, RIEN pour choisir une valeur, et aucune
       * erreur nulle part — on croirait le champ livré. Le cas n'est pas théorique : le plan prévoit
       * un quatrième champ multi (`interest_on`, la colonne de paires), et TypeScript ne reliera
       * jamais `FIELDS` à ce `Record` indexé par chaîne. On le DIT, en attendant.
       */
      if (!spec) {
        return (
          <p className="rounded-lg border border-dashed border-border px-2.5 py-1.5 text-[11.5px] text-muted-foreground">
            No value list is wired for “{f.label}” — this condition cannot be filled in.
          </p>
        );
      }
      // Un champ dont le REGISTRE porte les options (les e-mails système) reste utilisable pendant
      // le chargement et après un échec : la route n'y ajoute que les compteurs.
      const statiques = f.options ?? null;
      const dyn = real[spec.cle] ?? statiques;
      const choisies = Array.isArray(pred.value) ? pred.value : [];
      // ⛔ `null` (pas chargé / lecture en échec) et `[]` (cette marque n'a réellement rien) sont
      // DEUX situations, et elles appellent deux gestes opposés. Les confondre ferait accuser la
      // règle qu'on écrit alors que c'est la provenance qui manque.
      const indisponible = statiques
        ? null
        : !real.charge
          ? `Loading ${spec.noun}…`
          : dyn === null
            ? spec.echec
            : dyn.length === 0 && choisies.length === 0
              ? spec.vide
              : null;
      return (
        <MultiSelect
          choisies={choisies}
          options={multiOptionsFor(dyn, choisies)}
          noun={spec.noun}
          indisponible={indisponible}
          onChange={onChange}
        />
      );
    }
    case "number":
      return (
        <input
          type="number" min={0} className={cn(selectCls, "w-20 tabular-nums")}
          value={Number(pred.value)} onChange={(e) => onChange(Number(e.target.value))}
        />
      );
    case "days": {
      // « ever » ne porte aucune fenêtre : un champ de jours affiché ferait croire qu'il compte.
      if (pred.op === "ever") return null;
      // ⚠️ `!Array.isArray` en plus du `typeof "object"` : depuis que `PredValue` accepte une
      // liste, un tableau EST un objet — sans cette exclusion, TypeScript refuse `.days`, et à
      // l'exécution une règle mal formée aurait rendu `undefined` dans un champ nombre.
      const days = typeof pred.value === "object" && !Array.isArray(pred.value) ? pred.value.days : 30;
      return (
        <span className="inline-flex items-center gap-1.5">
          <input
            type="number" min={1} className={cn(selectCls, "w-16 tabular-nums")}
            value={days} onChange={(e) => onChange({ days: Number(e.target.value) })}
          />
          <span className="text-[12px] text-muted-foreground">days</span>
        </span>
      );
    }
    case "cta_window": {
      const v = typeof pred.value === "object" && !Array.isArray(pred.value)
        ? pred.value
        : { days: 14, cta: "paris" };
      return (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <select className={selectCls} value={v.cta} onChange={(e) => onChange({ ...v, cta: e.target.value })}>
            {CTA_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          {/* ⚠️ PAS de « · in the last » écrit ici : le sélecteur d'opérateur l'imprime déjà via
              `OP_LABEL_UI.within_days`, et `clicked_cta` ne déclare que cet opérateur — la ligne
              disait donc deux fois la même chose sur la capture d'écran d'Alix. */}
          <input
            type="number" min={1} className={cn(selectCls, "w-16 tabular-nums")}
            value={v.days} onChange={(e) => onChange({ ...v, days: Number(e.target.value) })}
          />
          <span className="text-[12px] text-muted-foreground">days</span>
        </span>
      );
    }
    case "bool":
    default:
      return null;
  }
}

/* ---------- ligne de prédicat ---------- */
function PredicateRow({
  pred, onChange, onRemove,
}: { pred: Predicate; onChange: (p: Predicate) => void; onRemove: () => void }) {
  const f = getField(pred.field)!;

  const changeField = (key: string) => {
    const nf = getField(key)!;
    onChange({ ...pred, field: key, op: nf.ops[0], value: defaultValue(nf) });
  };

  // Une multi-sélection se déplie SOUS la ligne, jamais dedans : six pastilles rendues dans la
  // rangée `flex-wrap` passeraient à la ligne et emmèneraient avec elles le bouton de suppression,
  // qui est en `ml-auto`.
  const multi = f.valueType === "multi";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <select className={cn(selectCls, "font-medium")} value={pred.field} onChange={(e) => changeField(e.target.value)}>
          {CATEGORIES.map((cat) => (
            <optgroup key={cat} label={CATEGORY_LABEL_UI[cat]}>
              {FIELDS.filter((x) => x.category === cat).map((x) => (
                <option key={x.key} value={x.key}>{x.label}</option>
              ))}
            </optgroup>
          ))}
        </select>

        <select className={selectCls} value={pred.op} onChange={(e) => onChange({ ...pred, op: e.target.value as Operator })}>
          {f.ops.map((op) => (
            <option key={op} value={op}>{OP_LABEL_UI[op]}</option>
          ))}
        </select>

        {!multi && <ValueControl pred={pred} onChange={(v) => onChange({ ...pred, value: v })} />}

        <button
          onClick={onRemove}
          className="ml-auto rounded-md p-1.5 text-muted-foreground/60 transition-colors hover:bg-destructive/10 hover:text-destructive"
          aria-label="Delete condition"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {multi && <ValueControl pred={pred} onChange={(v) => onChange({ ...pred, value: v })} />}
    </div>
  );
}

/**
 * Libellés de catégorie côté UI (les clés restent en français côté data).
 *
 * ⛔ LE TYPE EST DÉRIVÉ, ET C'EST LUI QUI FAIT MORDRE LE TYPECHECK. Ce `Record` était écrit sur
 * l'union littérale des trois anciennes catégories ; élargir `FieldDef.category` ne déclenchait donc
 * RIEN, et un champ rangé dans une catégorie neuve devenait invisible à l'écran sans une seule
 * erreur. Avec `FieldCategory`, une catégorie ajoutée au registre est une clé manquante ici, donc
 * une erreur de compilation — c'est la seule moitié de la garantie qu'un test peut tenir, faute de
 * moteur de rendu React de test dans ce dépôt.
 */
const CATEGORY_LABEL_UI: Record<FieldCategory, string> = {
  Attribut: "Attribute", Engagement: "Engagement", Comportement: "Behavior", Capture: "Capture",
  Automations: "Automations",
};

// libellés d'opérateurs côté UI (un poil plus explicites que le résumé)
const OP_LABEL_UI: Record<Operator, string> = {
  eq: "is", neq: "is not", gte: "≥", lte: "≤",
  within_days: "in the last", older_than_days: "more than",
  has: "contains", not_has: "does not contain",
  is_true: "= true", is_false: "= false",
  any_of: "is any of", none_of: "is none of",
  ever: "ever",
};

/* ---------- éditeur de groupe (récursif) ---------- */
function GroupEditor({
  group, depth, newId, onChange, onRemove,
}: {
  group: Group;
  depth: number;
  newId: () => string;
  onChange: (g: Group) => void;
  onRemove?: () => void;
}) {
  const setOp = (op: "AND" | "OR") => onChange({ ...group, op });
  const patchChild = (id: string, fn: (n: RuleNode) => RuleNode) => onChange(updateNode(group, id, fn));
  const removeChild = (id: string) => onChange(removeNode(group, id));
  const addCondition = () => onChange(addChild(group, group.id, makePredicate(newId())));
  const addGroup = () =>
    onChange(addChild(group, group.id, { id: newId(), type: "group", op: "OR", children: [makePredicate(newId())] }));

  return (
    <div className={cn("rounded-xl border p-3.5", depth === 0 ? "border-border bg-[#fcfcfe]" : "border-border bg-card")}>
      <div className="mb-3 flex items-center gap-2.5">
        <span className="text-[12px] font-semibold text-muted-foreground">Match</span>
        <div className="inline-flex overflow-hidden rounded-lg border border-border">
          {(["AND", "OR"] as const).map((op) => (
            <button
              key={op}
              onClick={() => setOp(op)}
              className={cn(
                "px-3 py-1 text-[12px] font-semibold transition-colors",
                group.op === op ? "bg-brand text-white" : "bg-card text-muted-foreground hover:bg-accent",
              )}
            >
              {op === "AND" ? "AND" : "OR"}
            </button>
          ))}
        </div>
        <span className="text-[12px] text-muted-foreground/70">
          {group.op === "AND" ? "all conditions" : "at least one"}
        </span>
        {onRemove && (
          <button onClick={onRemove} className="ml-auto rounded-md p-1.5 text-muted-foreground/60 hover:bg-destructive/10 hover:text-destructive" aria-label="Delete group">
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div className="flex flex-col gap-2.5">
        {group.children.map((child) =>
          child.type === "group" ? (
            <GroupEditor
              key={child.id} group={child} depth={depth + 1} newId={newId}
              onChange={(g) => patchChild(child.id, () => g)}
              onRemove={() => removeChild(child.id)}
            />
          ) : (
            <PredicateRow
              key={child.id} pred={child}
              onChange={(p) => patchChild(child.id, () => p)}
              onRemove={() => removeChild(child.id)}
            />
          ),
        )}
        {group.children.length === 0 && (
          <div className="rounded-lg border border-dashed border-border py-4 text-center text-[12px] text-muted-foreground/70">
            No conditions — the group targets the entire list.
          </div>
        )}
      </div>

      <div className="mt-3 flex items-center gap-4">
        <button onClick={addCondition} className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-brand transition-colors hover:text-[#c01f66]">
          <Plus className="h-3.5 w-3.5" /> Add condition
        </button>
        {depth < 2 && (
          <button onClick={addGroup} className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-muted-foreground transition-colors hover:text-foreground">
            <FolderPlus className="h-3.5 w-3.5" /> Add group
          </button>
        )}
      </div>
    </div>
  );
}

/* ---------- composant principal ---------- */
export function SegmentBuilder({ baseTotal = 0 }: { baseTotal?: number }) {
  const [tree, setTree] = useState<Group>(INITIAL_TREE);
  const counter = useRef(100);
  const newId = () => `nn${++counter.current}`;

  const [live, setLive] = useState<{
    count: number | null;
    unsupported: string[];
    demoExcluded: number | null;
    sunsetExcluded: number | null;
    widened: boolean;
    /** Abonnés de la marque dont on connaît la PROVENANCE (`capture_event_count > 0`). */
    originKnown: number | null;
    /** Le dénominateur de cette couverture : les abonnés que le compte peut atteindre. */
    inScope: number | null;
    /** Pourquoi il n'y a pas de compte : `"no-db"`, `"bad-request"`, `"query-failed"`… */
    reason: string | null;
    /** Qui la règle désigne (0088) : « Newsletter: No » compte les contacts hors newsletter. */
    population: "subscribers" | "contacts";
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  // Les tags et formulaires d'opt-in RÉELS de la marque. Chargés une fois : ils ne changent pas
  // pendant qu'on écrit une règle. Un échec laisse `null`, donc le repli sur les exemples du
  // registre — mieux qu'un écran sans aucune valeur sélectionnable.
  const [real, setReal] = useState<RealLists>(LISTES_VIDES);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/segments/options");
        const d = (await res.json()) as {
          tags?: Option[];
          optins?: Option[];
          captureCampaigns?: CountedOption[];
          captureCreatives?: CountedOption[];
          interests?: CountedOption[];
          automations?: CountedOption[];
          systemEmails?: CountedOption[];
        };
        if (!cancelled) {
          setReal({
            charge: true,
            tags: d.tags ?? null,
            optins: d.optins ?? null,
            // ⚠️ `?? null` et jamais `?? []` : une clé absente de la réponse veut dire « cette
            // version de la route ne sert pas encore ces listes », pas « cette marque n'a aucune
            // campagne ». L'écran doit pouvoir dire lequel des deux.
            captureCampaigns: d.captureCampaigns ?? null,
            captureCreatives: d.captureCreatives ?? null,
            interests: d.interests ?? null,
            automations: d.automations ?? null,
            systemEmails: d.systemEmails ?? null,
          });
        }
      } catch {
        // Silence volontaire pour les listes (le repli est le registre), mais la LECTURE, elle, est
        // terminée : sans ça l'écran resterait indéfiniment sur « Loading… » après un échec réseau.
        if (!cancelled) setReal((r) => ({ ...r, charge: true }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Compte réel en base, recalculé à chaque changement de règle (debounce) ou retry manuel.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch("/api/segments/count", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ rule: tree }),
        });
        const d = (await res.json()) as {
          count: number | null;
          unsupported?: string[];
          demoExcluded?: number | null;
          sunsetExcluded?: number | null;
          widened?: boolean;
          originKnown?: number | null;
          inScope?: number | null;
          reason?: string;
          population?: string;
        };
        if (!cancelled) {
          setLive({
            count: d.count,
            unsupported: d.unsupported ?? [],
            demoExcluded: d.demoExcluded ?? null,
            sunsetExcluded: d.sunsetExcluded ?? null,
            widened: d.widened === true,
            originKnown: d.originKnown ?? null,
            inScope: d.inScope ?? null,
            // ⛔ « la base n'a pas répondu » et « la base a REFUSÉ CETTE RÈGLE » demandent deux
            //    gestes opposés. Sans ce motif, l'écran disait « database unavailable » dans les
            //    deux cas — un message faux, précisément quand la règle est en cause.
            reason: typeof d.reason === "string" ? d.reason : null,
            // Fermé : seule la valeur exacte nomme les contacts, tout le reste se lit « abonnés ».
            population: d.population === "contacts" ? "contacts" : "subscribers",
          });
        }
      } catch {
        if (!cancelled) setLive(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [tree, retryKey]);

  /* ⛔ AUCUN CHIFFRE HORS LECTURE : sans compte de la base, la case dit « Size unavailable » et
     pourquoi (`segment-size.ts`). L'estimation locale (128 450 abonnés fictifs × une sélectivité
     inventée) a été retirée le 24/09/2026. */
  const taille = segmentSize(live, baseTotal, loading);
  const isLive = taille.kind === "count";
  const size = taille.kind === "count" ? taille.size : 0;
  const unsupported = live?.unsupported ?? [];
  const demoExcluded = live?.demoExcluded ?? 0;
  const sunsetExcluded = live?.sunsetExcluded ?? 0;
  /**
   * ⛔ Le ciblage s'est ÉLARGI : un terme d'un ET n'a pas pu être compilé, donc le filtre porte sur
   * plus de monde que la règle affichée. Sans ce cas, l'écran retombait sur l'estimation simulée
   * avec le badge « database unavailable » — un message faux (la base répond) qui invite à ignorer
   * l'avertissement, pour la seule situation où il ne faut surtout pas.
   */
  const widened = live?.widened === true;

  /**
   * ⛔ LA BASE A RÉPONDU ET A REFUSÉ LA RÈGLE — à ne pas confondre avec « base indisponible ».
   * Comparaison FERMÉE sur le motif nommé par la route : tout autre échec (`no-db`, réseau coupé,
   * `live` à null) garde le message d'origine. Un `!== "no-db"` aurait fait basculer en « règle
   * refusée » le cas d'une base vraiment injoignable, c'est-à-dire l'exact contraire.
   */
  const rejet = live?.reason === "query-failed";
  /**
   * ⛔ UN COMPTE DE CONTACTS NE SE DIT PAS « SUBSCRIBERS », ET NE SE RAPPORTE PAS AUX ACTIFS : le
   * pourcentage diviserait des contacts par des abonnés, deux populations disjointes (0088).
   */
  const contacts = live?.population === "contacts";

  /**
   * Le carnet de libellés du résumé : identifiant → nom lisible.
   *
   * ⛔ SANS LUI, LA LIGNE « Preview » RENDRAIT DES UUID BRUTS — « Capture campaign is any of
   * 3f2a8c11-…, 9c1b4d02-… ». La règle, elle, ne retient QUE des identifiants : dénormaliser le nom
   * dans la règle rendrait le résumé faux au premier renommage, sans le dire.
   */
  const labels: LabelBook = useMemo(() => {
    const book: LabelBook = {};
    for (const liste of [
      real.tags, real.optins, real.captureCampaigns, real.captureCreatives, real.interests, real.automations,
    ]) {
      for (const o of liste ?? []) book[o.value] = o.label;
    }
    return book;
  }, [real]);

  const capture = usesCapture(tree);
  const originKnown = live?.originKnown ?? null;
  const inScope = live?.inScope ?? null;
  /**
   * ⛔ LE ZÉRO QUI NE S'EXPLIQUE PAS. Les 1 202 contacts de démonstration ne portent AUCUNE
   * provenance : ils ne matchent ni une règle de capture ni son complément, donc les deux lignes
   * qui rendent un zéro lisible (« demo contacts excluded », « excluded by sunset ») ne sont pas
   * rendues du tout. Sans cet état vide NOMMÉ, l'écran affiche « 0 » sous une pastille verte
   * « Exact count », trois centimètres sous « 1 056 active subscribers in scope ».
   */
  const captureVide = isLive && !widened && size === 0 && capture && originKnown !== null && originKnown === 0;
  const captureIndetermine = isLive && !widened && size === 0 && capture && originKnown === null;

  return (
    <RealOptions.Provider value={real}>
    <div className="grid gap-4 lg:grid-cols-[1.7fr_1fr]">
      {/* règles */}
      <div className="rounded-[14px] border border-border bg-card p-[18px]">
        <div className="mb-3.5 flex items-center justify-between">
          <h3 className="text-[13.5px] font-semibold">Rules</h3>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-soft px-2.5 py-[3px] text-[11.5px] font-semibold text-brand-soft-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-current" /> Dynamic · auto-updating
          </span>
        </div>
        <GroupEditor group={tree} depth={0} newId={newId} onChange={setTree} />
      </div>

      {/* preview + résumé */}
      <div className="flex flex-col gap-4">
        <div className="rounded-[14px] border border-brand-soft bg-gradient-to-br from-[#fff6fb] to-white p-5 text-center">
          <div className="mb-1.5 flex items-center justify-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
            Segment size
            {loading && <Loader2 className="h-3 w-3 animate-spin" />}
          </div>
          {taille.kind === "unavailable" || taille.kind === "loading" ? (
            <div className="text-[22px] font-bold leading-tight tracking-tight text-muted-foreground">
              {taille.kind === "loading" ? "Counting…" : SIZE_UNAVAILABLE}
            </div>
          ) : (
            <div className="text-[34px] font-extrabold leading-none tracking-tight text-[#c01f66] tabular-nums">
              {taille.kind === "widened" ? "—" : taille.size.toLocaleString("en-US")}
            </div>
          )}
          <div className="mt-1 text-[12px] text-muted-foreground">
            {taille.kind === "widened"
              ? "no count while the targeting is incomplete"
              : taille.kind === "unavailable"
                ? taille.message
                : taille.kind === "loading"
                  ? "reading the database"
                  : contacts
                    ? "contacts — not newsletter subscribers"
                    : taille.pct === null
                      ? "subscribers"
                      : `subscribers · ${taille.pct.toLocaleString("en-US", { maximumFractionDigits: 1 })}% of active`}
          </div>
          {widened ? (
            <div className="mt-3 inline-flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-left text-[11.5px] leading-snug text-red-700">
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
              <span>
                <strong className="font-semibold">Targeting incomplete.</strong> {unsupported.join(", ")}{" "}
                could not be resolved for this brand. Dropping a condition from an AND makes the
                audience <em>wider</em>, so no count is shown and this segment will not send.
              </span>
            </div>
          ) : captureVide || captureIndetermine ? (
            /* ⛔ PAS DE PASTILLE VERTE SOUS UN ZÉRO DE CAPTURE. « Exact count » à côté de « 0 » est
               vrai et illisible : il ne dit pas si ce sont les GENS qui manquent ou la DONNÉE. */
            <div className="mt-3 inline-flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-left text-[11.5px] leading-snug text-amber-800">
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
              <span>
                {captureVide ? (
                  <>
                    <strong className="font-semibold">No capture data yet</strong> — the optinforge
                    bridge has not delivered a lead to this brand, so no subscriber carries a
                    campaign, a creative or an interest. The count is a true zero about an empty
                    source, not about your rule.
                  </>
                ) : (
                  <>
                    <strong className="font-semibold">Zero matches, coverage unknown</strong> — this
                    count does not report how many subscribers carry an origin, so we cannot tell
                    whether the people or the data are missing.
                  </>
                )}
              </span>
            </div>
          ) : isLive ? (
            <div className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-[#e2f5e9] px-2.5 py-[3px] text-[11.5px] font-semibold text-[#1f9d57]">
              <span className="h-1.5 w-1.5 rounded-full bg-current" /> Exact count · database
            </div>
          ) : taille.kind === "unavailable" ? (
            /* ⛔ DEUX ÉCHECS, DEUX MESSAGES. Un refus de la base porte sur LA RÈGLE affichée, et
               « database unavailable » ferait croire à une panne passagère qu'il suffit d'attendre.
               Réessayer ne changerait rien : c'est la règle qu'il faut reprendre. Dans les deux cas,
               AUCUN nombre n'est affiché (voir `segment-size.ts`). */
            <div className={`mt-3 inline-flex items-center gap-2 rounded-full border px-2.5 py-[3px] text-[11.5px] font-semibold ${
              rejet ? "border-red-300 bg-red-50 text-red-700" : "border-amber-300 bg-amber-50 text-amber-700"
            }`}>
              <AlertTriangle className="h-3 w-3" />
              {rejet ? "No count — this rule was rejected" : "No count — database unavailable"}
              <button onClick={() => setRetryKey((k) => k + 1)} disabled={loading}
                className={`rounded-full px-2 py-px text-[10.5px] font-semibold text-white disabled:opacity-60 ${
                  rejet ? "bg-red-600" : "bg-amber-600"
                }`}>
                Retry
              </button>
            </div>
          ) : null}
          {/* Le cas restant : un terme perdu dans un OU. L'ensemble RÉTRÉCIT, donc le compte est sûr
              — mais il faut quand même nommer ce qui a été écarté. L'ancien texte affirmait « requires
              the send event stream », vrai pour `clicked_cta` seul et faux pour un tag introuvable. */}
          {!widened && unsupported.length > 0 && (
            <p className="mt-2.5 text-[11px] leading-snug text-[#b9790a]">
              {unsupported.length} predicate{unsupported.length > 1 ? "s" : ""} could not be applied
              ({unsupported.join(", ")}). They sit under an OR, so this count is not inflated.
            </p>
          )}
          {/* Ce que la barrière d'envoi vient de retirer du compte. Sans cette ligne, une base de
              recette affiche « 0 » et c'est la règle qu'on vient d'écrire qu'on soupçonne. */}
          {demoExcluded > 0 && (
            <p className="mt-2.5 text-[11px] leading-snug text-muted-foreground">
              {demoExcluded.toLocaleString("en-US")} demo contact{demoExcluded > 1 ? "s" : ""} excluded
              — addresses on a reserved domain (example.com) can never receive mail.
            </p>
          )}
          {/* L'autre moitié : depuis 0057 la barrière écarte aussi les abonnés marqués par le
              sunset. Ils restent abonnés — sans cette ligne ils manquaient partout. */}
          {sunsetExcluded > 0 && (
            <p className="mt-2.5 text-[11px] leading-snug text-muted-foreground">
              {sunsetExcluded.toLocaleString("en-US")} subscriber{sunsetExcluded > 1 ? "s" : ""} excluded
              by sunset — they stopped opening, so we stopped writing. Still subscribed.
            </p>
          )}
          {/* ⛔ AFFICHÉE EN PERMANENCE, ET PAS SEULEMENT QUAND ELLE EST NULLE. C'est la seule ligne
              qui distingue « personne ne correspond » de « personne ne porte encore d'origine ».
              La couverture se mesure sur `capture_event_count > 0` — une colonne SCALAIRE : sur un
              tableau, `cs.{}` matcherait tout le monde et `ov.{}` personne, deux façons opposées de
              se tromper sur la même question.
              ⚠️ Sauf sans compte du tout (« Size unavailable ») : elle qualifierait « ce compte »
              sous une case qui n'en affiche aucun. */}
          {taille.kind !== "unavailable" && (
            <p className="mt-2.5 text-[11px] leading-snug text-muted-foreground">
              {originKnown != null && inScope != null
                ? `Origin known for ${originKnown.toLocaleString("en-US")} of ${inScope.toLocaleString("en-US")} subscribers in scope.`
                : "Origin coverage not reported — this count does not say how many subscribers carry a campaign, a creative or an interest."}
            </p>
          )}
        </div>

        <div className="rounded-[14px] border border-border bg-card p-4">
          <h3 className="mb-2 text-[13.5px] font-semibold">Preview</h3>
          <p className="text-[12.5px] leading-relaxed text-foreground/80">
            {contacts ? "Contacts who match" : "Subscribers who match"}:{" "}
            <span className="font-medium text-foreground">{summarize(tree, labels)}</span>.
          </p>
          <div className="mt-3 flex items-center justify-between border-t border-border pt-3 text-[12px] text-muted-foreground">
            <span>Consent re-checked at send</span>
            <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-[#e2f5e9] text-[#1f9d57]">
              <span className="h-1.5 w-1.5 rounded-full bg-current" />
            </span>
          </div>
        </div>

        <SaveSegment rule={tree} count={isLive ? size : null} />
      </div>
    </div>
    </RealOptions.Provider>
  );
}

/**
 * Enregistrement du segment.
 *
 * Vit ICI et non dans l'en-tête de la page parce que c'est ce composant qui détient la règle et le
 * compte : un bouton ailleurs devrait dupliquer l'état, et les deux dériveraient.
 *
 * On enregistre la RÈGLE, jamais la liste des abonnés qu'elle désigne aujourd'hui — un segment figé
 * mentirait dès demain et contournerait le re-contrôle du consentement au moment de l'envoi.
 */
function SaveSegment({ rule, count }: { rule: Group; count: number | null }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/segments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed, rule, cachedCount: count }),
      });
      if (!res.ok) {
        let msg = `Request failed (${res.status})`;
        try {
          const b = (await res.json()) as { error?: string };
          if (b?.error) msg = b.error;
        } catch {
          /* corps non-JSON */
        }
        setError(msg);
        setBusy(false);
        return;
      }
      setSaved(trimmed);
      setName("");
      setBusy(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="rounded-[14px] border border-border bg-card p-4">
      <h3 className="mb-2 text-[13.5px] font-semibold">Save this segment</h3>
      <p className="mb-3 text-[12px] leading-relaxed text-muted-foreground">
        The rule is stored, not the list of people it matches today — so it stays accurate, and
        consent is still re-checked for every recipient at send time.
      </p>
      <div className="flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Active readers · BR"
          maxLength={120}
          className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2.5 py-2 text-[13px] outline-none focus:border-brand"
        />
        <button
          type="submit"
          disabled={busy || name.trim().length === 0}
          className={cn(
            "flex items-center gap-1.5 rounded-[9px] bg-brand px-3.5 py-2 text-[13px] font-medium text-brand-foreground",
            (busy || name.trim().length === 0) && "cursor-not-allowed opacity-50",
          )}
        >
          {busy ? <Loader2 className="h-[14px] w-[14px] animate-spin" /> : <Save className="h-[14px] w-[14px]" />}
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
      {count === null && (
        <p className="mt-2 text-[11.5px] text-amber-700">
          The exact count is unavailable, so this segment is saved without one.
        </p>
      )}
      {error && <p className="mt-2 rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-[12px] text-red-700">{error}</p>}
      {saved && !error && <p className="mt-2 text-[12px] text-[#1f9d57]">Saved “{saved}”.</p>}
    </form>
  );
}
