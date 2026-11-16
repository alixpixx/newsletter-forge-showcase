"use client";

/**
 * Champs contrôlés de l'inspecteur. Tous sont RÉELLEMENT branchés : `value` + `onChange`,
 * aucun champ décoratif. Chaque contrôle porte un `<label htmlFor>` (navigation clavier + lecteur
 * d'écran), et les contrôles à icône exposent un `aria-label`.
 *
 * CASCADE — un champ de style ne vit jamais seul : il est le dernier maillon d'une chaîne
 * thème → row → colonne → bloc résolue par le compilateur. Il expose donc deux états :
 *  • HÉRITÉ    — le champ est vide, la valeur qui s'appliquera est affichée en grisé (placeholder
 *                + ligne « Inherited from … ») ;
 *  • SURCHARGÉ — le champ porte une valeur locale et un bouton « Reset » rend la main à
 *                l'héritage. Sans ce bouton la surcharge serait irréversible à la souris :
 *                l'utilisateur devrait deviner que « vider le champ = revenir au thème ».
 */
import { useId } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { ALIGNMENTS, type Align, type Spacing } from "@nf/render/schema";
import { cn } from "@/lib/utils";

const INPUT =
  "w-full rounded-lg border border-border bg-card px-2.5 py-1.5 text-[12.5px] text-foreground " +
  "placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40";

/** Retire les clés `undefined` — le document part en jsonb, on n'y laisse pas de trous. */
export function prune<T extends object>(obj: T): T {
  const out = {} as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as T;
}

/**
 * Contrat d'héritage commun à tous les champs de style.
 *
 * Convention : `onReset` n'est fourni QUE si le champ est surchargé — c'est lui qui bascule
 * l'affichage entre « valeur héritée en grisé » et « bouton Reset ».
 */
export interface InheritProps {
  /** Valeur qui s'applique en l'absence de surcharge, déjà formatée pour l'humain. */
  inherited?: string;
  /** Étage qui la fournit : « Email styles », « Row », « Column ». */
  inheritedFrom?: string;
  /** Retour à l'héritage. Absent = champ non surchargé (ou portée racine, rien au-dessus). */
  onReset?: () => void;
}

export function Field({
  label,
  hint,
  warning,
  htmlFor,
  right,
  inherited,
  inheritedFrom,
  onReset,
  children,
}: {
  label: string;
  hint?: string;
  warning?: string;
  htmlFor?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
} & InheritProps) {
  return (
    <div className="mb-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <label htmlFor={htmlFor} className="block text-[11px] font-semibold text-muted-foreground">
          {label}
        </label>
        <div className="flex items-center gap-1">
          {onReset && (
            <button
              type="button"
              aria-label={`Reset ${label} to the inherited value`}
              title="Back to the inherited value"
              onClick={onReset}
              className="inline-flex items-center gap-1 rounded-[7px] border border-border px-1.5 py-[3px] text-[10.5px] font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <RotateCcw className="h-3 w-3" strokeWidth={2.2} />
              Reset
            </button>
          )}
          {right}
        </div>
      </div>
      {children}
      {inherited !== undefined && onReset === undefined && (
        <p className="mt-1 text-[10.5px] leading-snug text-muted-foreground/60">
          Inherited{inheritedFrom ? ` from ${inheritedFrom}` : ""}: <span className="font-medium">{inherited}</span>
        </p>
      )}
      {hint && <p className="mt-1 text-[11px] leading-snug text-muted-foreground/70">{hint}</p>}
      {warning && (
        <p className="mt-1 flex items-start gap-1.5 text-[11px] leading-snug text-[#b9790a]">
          <AlertTriangle className="mt-[1px] h-3 w-3 shrink-0" strokeWidth={2} />
          {warning}
        </p>
      )}
    </div>
  );
}

export function TextInput({
  label,
  value,
  onChange,
  placeholder,
  hint,
  warning,
  maxLength,
  right,
  inputRef,
  inherited,
  inheritedFrom,
  onReset,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
  warning?: string;
  maxLength?: number;
  right?: React.ReactNode;
  inputRef?: React.Ref<HTMLInputElement>;
} & InheritProps) {
  const id = useId();
  return (
    <Field
      label={label}
      hint={hint}
      warning={warning}
      htmlFor={id}
      right={right}
      inherited={inherited}
      inheritedFrom={inheritedFrom}
      onReset={onReset}
    >
      <input
        id={id}
        ref={inputRef}
        className={INPUT}
        value={value}
        maxLength={maxLength}
        // La valeur héritée sert de placeholder : le champ vide montre ce qui s'appliquera.
        placeholder={placeholder ?? inherited}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

export function TextAreaInput({
  label,
  value,
  onChange,
  rows = 4,
  hint,
  warning,
  placeholder,
  right,
  mono = false,
  maxLength,
  textareaRef,
  onFocus,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  hint?: string;
  warning?: string;
  placeholder?: string;
  right?: React.ReactNode;
  mono?: boolean;
  maxLength?: number;
  textareaRef?: React.Ref<HTMLTextAreaElement>;
  onFocus?: (e: React.FocusEvent<HTMLTextAreaElement>) => void;
}) {
  const id = useId();
  return (
    <Field label={label} hint={hint} warning={warning} htmlFor={id} right={right}>
      <textarea
        id={id}
        ref={textareaRef}
        rows={rows}
        maxLength={maxLength}
        placeholder={placeholder}
        className={cn(INPUT, "resize-y leading-relaxed", mono && "font-mono text-[11.5px]")}
        value={value}
        onFocus={onFocus}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

export function NumberInput({
  label,
  value,
  onChange,
  min,
  max,
  step,
  suffix,
  hint,
  placeholder,
  inherited,
  inheritedFrom,
  onReset,
}: {
  label: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  min?: number;
  max?: number;
  /** Pas fractionnaire (line-height) → la saisie garde 2 décimales au lieu d'être arrondie. */
  step?: number;
  suffix?: string;
  hint?: string;
  placeholder?: string;
} & InheritProps) {
  const id = useId();
  const decimals = step !== undefined && !Number.isInteger(step);
  return (
    <Field
      label={label}
      hint={hint}
      htmlFor={id}
      inherited={inherited}
      inheritedFrom={inheritedFrom}
      onReset={onReset}
    >
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="number"
          className={INPUT}
          value={value ?? ""}
          min={min}
          max={max}
          step={step}
          placeholder={placeholder ?? inherited}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === "") return onChange(undefined);
            const n = Number(raw);
            if (Number.isNaN(n)) return;
            // Le schéma attend un entier partout SAUF sur line-height : on n'écrit un float
            // que là où il est accepté, sinon le document deviendrait insauvegardable.
            onChange(decimals ? Math.round(n * 100) / 100 : Math.round(n));
          }}
        />
        {suffix && <span className="text-[11px] text-muted-foreground">{suffix}</span>}
      </div>
    </Field>
  );
}

export function SelectInput<T extends string>({
  label,
  value,
  options,
  onChange,
  hint,
  inherited,
  inheritedFrom,
  onReset,
}: {
  label: string;
  value: T;
  options: readonly T[] | readonly { value: T; label: string }[];
  onChange: (v: T) => void;
  hint?: string;
} & InheritProps) {
  const id = useId();
  const normalized = options.map((o) => (typeof o === "string" ? { value: o, label: o } : o));
  return (
    <Field
      label={label}
      hint={hint}
      htmlFor={id}
      inherited={inherited}
      inheritedFrom={inheritedFrom}
      onReset={onReset}
    >
      <select id={id} className={INPUT} value={value} onChange={(e) => onChange(e.target.value as T)}>
        {normalized.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** Case à cocher — `checked` est toujours un booléen franc, jamais un `undefined` déguisé. */
export function CheckboxInput({
  label,
  text,
  checked,
  onChange,
  hint,
  warning,
  inherited,
  inheritedFrom,
  onReset,
}: {
  label: string;
  /** Libellé cliquable posé à côté de la case. */
  text: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
  warning?: string;
} & InheritProps) {
  const id = useId();
  return (
    <Field
      label={label}
      hint={hint}
      warning={warning}
      htmlFor={id}
      inherited={inherited}
      inheritedFrom={inheritedFrom}
      onReset={onReset}
    >
      <label htmlFor={id} className="flex items-start gap-2 text-[12px] leading-snug">
        <input
          id={id}
          type="checkbox"
          className="mt-[2px] h-3.5 w-3.5 shrink-0 accent-brand"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        {text}
      </label>
    </Field>
  );
}

/** Sélecteur d'alignement — segmenté, chaque bouton annonce son état via `aria-pressed`. */
export function AlignInput({
  label = "Alignment",
  value,
  onChange,
  allowInherit = false,
  hint,
  inherited,
  inheritedFrom,
  onReset,
}: {
  label?: string;
  value: Align | undefined;
  onChange: (v: Align | undefined) => void;
  allowInherit?: boolean;
  hint?: string;
} & InheritProps) {
  const items: { v: Align | undefined; label: string }[] = [
    ...(allowInherit ? [{ v: undefined, label: "Auto" }] : []),
    ...ALIGNMENTS.map((a) => ({ v: a as Align, label: a[0].toUpperCase() + a.slice(1) })),
  ];
  return (
    <Field label={label} hint={hint} inherited={inherited} inheritedFrom={inheritedFrom} onReset={onReset}>
      <div className="inline-flex rounded-lg border border-border bg-card p-0.5">
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            aria-pressed={value === item.v}
            onClick={() => onChange(item.v)}
            className={cn(
              "rounded-[6px] px-2.5 py-1 text-[11.5px] font-medium transition-colors",
              value === item.v ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {item.label}
          </button>
        ))}
      </div>
    </Field>
  );
}

const SIDES = ["top", "bottom", "left", "right"] as const;

/**
 * Padding sur 4 côtés. Chaque côté se surcharge INDIVIDUELLEMENT (le compilateur fusionne
 * côté par côté) : vider une case rend ce côté seul à sa valeur par défaut, le bouton « Reset »
 * rend les quatre d'un coup.
 */
export function SpacingInput({
  label,
  value,
  defaults,
  onChange,
  hint,
  inheritedFrom,
  min = 0,
  max = 200,
}: {
  label: string;
  value: Spacing | undefined;
  /** Valeurs appliquées côté par côté quand rien n'est surchargé. */
  defaults: Spacing;
  onChange: (next: Spacing | undefined) => void;
  hint?: string;
  inheritedFrom?: string;
  min?: number;
  max?: number;
}) {
  const v: Spacing = value ?? {};
  const overridden = SIDES.some((s) => v[s] !== undefined);
  const set = (side: (typeof SIDES)[number], n: number | undefined) => {
    const next = prune({ ...v, [side]: n });
    onChange(Object.keys(next).length === 0 ? undefined : next);
  };

  return (
    <Field
      label={label}
      hint={hint}
      inherited={overridden ? undefined : SIDES.map((s) => defaults[s] ?? 0).join(" · ")}
      inheritedFrom={overridden ? undefined : inheritedFrom}
      onReset={overridden ? () => onChange(undefined) : undefined}
    >
      <div className="grid grid-cols-2 gap-x-2">
        {SIDES.map((side) => (
          <NumberInput
            key={side}
            label={side[0].toUpperCase() + side.slice(1)}
            value={v[side]}
            min={min}
            max={max}
            placeholder={String(defaults[side] ?? 0)}
            onChange={(n) => set(side, n)}
          />
        ))}
      </div>
    </Field>
  );
}

/**
 * Couleur hexadécimale. Le schéma REFUSE `#000000` / `#ffffff` purs (déclencheurs d'inversion
 * dark mode) : on n'écrit donc jamais une valeur invalide dans le document, on avertit.
 */
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const BANNED = new Set(["#000", "#000000", "#fff", "#ffffff"]);

export function isValidHex(v: string): boolean {
  return HEX_RE.test(v) && !BANNED.has(v.toLowerCase());
}

export function ColorInput({
  label,
  value,
  onChange,
  hint,
  inherited,
  inheritedFrom,
  onReset,
}: {
  label: string;
  value: string | undefined;
  onChange: (v: string | undefined) => void;
  hint?: string;
} & InheritProps) {
  const id = useId();
  const invalid = value !== undefined && value !== "" && !isValidHex(value);
  // Le sélecteur natif doit montrer QUELQUE CHOSE : à défaut de valeur locale, la couleur héritée.
  const swatch = value && HEX_RE.test(value) ? value : inherited && HEX_RE.test(inherited) ? inherited : "#1A1A20";
  return (
    <Field
      label={label}
      hint={hint}
      htmlFor={id}
      inherited={inherited}
      inheritedFrom={inheritedFrom}
      onReset={onReset}
      warning={invalid ? "Not a usable hex color. Pure #000000/#ffffff are rejected (dark-mode inversion)." : undefined}
    >
      <div className="flex items-center gap-2">
        <input
          id={id}
          className={INPUT}
          value={value ?? ""}
          placeholder={inherited ?? "#1A1A20"}
          onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
        />
        <input
          type="color"
          aria-label={`${label} color picker`}
          className="h-[30px] w-[34px] shrink-0 cursor-pointer rounded-lg border border-border bg-card p-0.5"
          value={swatch}
          onChange={(e) => onChange(e.target.value)}
        />
        {/* `onReset` prend le relais quand la cascade est en jeu — sinon deux boutons feraient la même chose. */}
        {onReset === undefined && value !== undefined && (
          <button
            type="button"
            aria-label={`Clear ${label}`}
            onClick={() => onChange(undefined)}
            className="shrink-0 rounded-lg border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent"
          >
            Clear
          </button>
        )}
      </div>
    </Field>
  );
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 mt-4 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground/70">
      {children}
    </div>
  );
}
