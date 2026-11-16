"use client";

/**
 * ÉTAPE 2 — la direction graphique, ÉDITABLE avant composition.
 *
 * Ce panneau existe pour une seule raison : une couleur mal lue sur l'image se corrige en deux
 * secondes ici, alors qu'elle coûterait une composition entière (jusqu'à 4 minutes) si on la
 * découvrait après coup. Chaque champ correspond exactement à un champ de `Theme`.
 */
import { AlertTriangle } from "lucide-react";
import {
  DENSITIES,
  PALETTE_LABELS,
  PALETTE_ROLES,
  directionErrors,
  hexError,
  type ArtDirection,
  type Density,
  type PaletteRole,
} from "./types";
import { cn } from "@/lib/utils";

const FONT_STACKS = [
  "Arial, Helvetica, sans-serif",
  "Helvetica, Arial, sans-serif",
  "Georgia, 'Times New Roman', serif",
  "'Trebuchet MS', Verdana, sans-serif",
  "Verdana, Geneva, sans-serif",
  "'Courier New', Courier, monospace",
];

const DENSITY_HINT: Record<Density, string> = {
  compact: "tight padding, more content above the fold",
  cozy: "balanced padding — the default",
  airy: "generous whitespace, editorial feel",
};

function Swatch({
  role,
  value,
  onChange,
}: {
  role: PaletteRole;
  value: string;
  onChange: (hex: string) => void;
}) {
  const err = hexError(value);
  // `<input type="color">` n'accepte que la forme #rrggbb : on ne le pilote qu'avec une valeur sûre.
  const safe = /^#[0-9a-fA-F]{6}$/.test(value) ? value : "#888888";

  return (
    <div className="rounded-[10px] border border-border bg-background p-2.5">
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={safe}
          aria-label={`${PALETTE_LABELS[role]} colour picker`}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          className="h-8 w-8 shrink-0 cursor-pointer rounded-[7px] border border-border bg-transparent p-0.5"
        />
        <div className="min-w-0 flex-1">
          <label className="block truncate text-[11px] font-semibold text-muted-foreground" htmlFor={`hex-${role}`}>
            {PALETTE_LABELS[role]}
          </label>
          <input
            id={`hex-${role}`}
            value={value}
            spellCheck={false}
            maxLength={7}
            onChange={(e) => onChange(e.target.value.trim())}
            className={cn(
              "w-full bg-transparent font-mono text-[12.5px] uppercase outline-none",
              err ? "text-red-700" : "text-foreground",
            )}
          />
        </div>
      </div>
      {err && <p className="mt-1 text-[11px] leading-snug text-red-700">{err}</p>}
    </div>
  );
}

export function DirectionEditor({
  direction,
  onChange,
  disabled = false,
}: {
  direction: ArtDirection;
  onChange: (next: ArtDirection) => void;
  disabled?: boolean;
}) {
  const errors = directionErrors(direction);
  const set = <K extends keyof ArtDirection>(key: K, value: ArtDirection[K]) =>
    onChange({ ...direction, [key]: value });

  return (
    <fieldset disabled={disabled} className="space-y-4 disabled:opacity-60">
      <div>
        <label className="mb-1.5 block text-[11px] font-semibold text-muted-foreground" htmlFor="ad-mood">
          Mood read from the artwork
        </label>
        <textarea
          id="ad-mood"
          value={direction.mood}
          rows={2}
          maxLength={400}
          onChange={(e) => set("mood", e.target.value)}
          className="w-full resize-y rounded-lg border border-border bg-background px-2.5 py-2 text-[13px] leading-relaxed outline-none focus:border-brand"
        />
      </div>

      <div>
        <p className="mb-2 text-[11px] font-semibold text-muted-foreground">
          Palette — these are the exact theme colours of the generated document
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {PALETTE_ROLES.map((role) => (
            <Swatch
              key={role}
              role={role}
              value={direction.palette[role] ?? ""}
              onChange={(hex) => onChange({ ...direction, palette: { ...direction.palette, [role]: hex } })}
            />
          ))}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1.5 block text-[11px] font-semibold text-muted-foreground" htmlFor="ad-font">
            Body typeface
          </label>
          <select
            id="ad-font"
            value={FONT_STACKS.includes(direction.fontFamily) ? direction.fontFamily : "custom"}
            onChange={(e) => {
              if (e.target.value !== "custom") set("fontFamily", e.target.value);
            }}
            className="w-full rounded-lg border border-border bg-background px-2.5 py-2 text-[13px] outline-none focus:border-brand"
          >
            {!FONT_STACKS.includes(direction.fontFamily) && (
              <option value="custom">{direction.fontFamily} (from the model)</option>
            )}
            {FONT_STACKS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[11px] leading-snug text-muted-foreground/80">
            Email clients only render locally installed fonts — web fonts are not an option here.
          </p>
        </div>

        <div>
          <label className="mb-1.5 block text-[11px] font-semibold text-muted-foreground" htmlFor="ad-density">
            Density
          </label>
          <select
            id="ad-density"
            value={direction.density}
            onChange={(e) => set("density", e.target.value as Density)}
            className="w-full rounded-lg border border-border bg-background px-2.5 py-2 text-[13px] outline-none focus:border-brand"
          >
            {DENSITIES.map((d) => (
              <option key={d} value={d}>
                {d[0].toUpperCase() + d.slice(1)} — {DENSITY_HINT[d]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {(
          [
            { key: "radius", label: "Corner radius (px)", min: 0, max: 48 },
            { key: "baseFontSize", label: "Base font size (px)", min: 10, max: 24 },
            { key: "contentWidth", label: "Content width (px)", min: 320, max: 800 },
          ] as const
        ).map(({ key, label, min, max }) => (
          <div key={key}>
            <label className="mb-1.5 block text-[11px] font-semibold text-muted-foreground" htmlFor={`ad-${key}`}>
              {label}
            </label>
            <input
              id={`ad-${key}`}
              type="number"
              min={min}
              max={max}
              value={direction[key]}
              onChange={(e) => set(key, Number(e.target.value))}
              className="w-full rounded-lg border border-border bg-background px-2.5 py-2 text-[13px] tabular-nums outline-none focus:border-brand"
            />
          </div>
        ))}
      </div>

      {direction.notes && (
        <p className="rounded-[10px] border border-border bg-accent/30 px-3 py-2.5 text-[12px] leading-relaxed text-muted-foreground">
          {direction.notes}
        </p>
      )}

      {errors.length > 0 && (
        <div className="rounded-[10px] border border-red-200 bg-red-50 px-3 py-2.5">
          <div className="mb-1.5 flex items-center gap-1.5 text-[11.5px] font-semibold text-red-700">
            <AlertTriangle className="h-3.5 w-3.5" strokeWidth={2} />
            Fix {errors.length} value{errors.length === 1 ? "" : "s"} before composing
          </div>
          <ul className="list-disc space-y-1 pl-4 text-[11.5px] leading-snug text-red-700">
            {errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}
    </fieldset>
  );
}
