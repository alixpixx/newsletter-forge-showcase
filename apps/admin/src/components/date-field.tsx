"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { addDaysYmd, addMonthsYmd, avant, grilleDuMois, joursDansLeMois, parseYmd, toYmd } from "@/components/calendar";

/**
 * Sélecteur de date — remplace les `<input type="date">` de l'admin.
 *
 * Le panneau s'ouvre DANS LE FLUX (il pousse le contenu), il ne flotte pas : le corps de
 * l'assistant de campagne est en `overflow-hidden` + `overflow-y-auto` (campaign-wizard.tsx:474 et
 * :516), un calendrier en position absolue y serait coupé dès qu'il dépasse le bas du panneau.
 *
 * Ce composant ne connaît QUE des dates civiles ("YYYY-MM-DD"). La conversion vers un instant UTC
 * reste à `campaigns/shared.ts` (`zonedToIso`), qui sait gérer les changements d'heure.
 */

const JOURS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const F_MOIS = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const F_JOUR = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** "YYYY-MM-DD" → instant UTC de midi (midi : à l'abri de tout arrondi d'affichage). */
function instantDe(ymd: string): number {
  const p = parseYmd(ymd);
  return p ? Date.UTC(p[0], p[1] - 1, p[2], 12) : Number.NaN;
}

/** "2026-09-18" → "Fri, 18 Sep 2026". Chaîne vide si la date est illisible. */
export function libelleDate(ymd: string): string {
  const t = instantDe(ymd);
  return Number.isNaN(t) ? "" : F_JOUR.format(t);
}

/** La date du jour dans un fuseau donné, en date civile. Sert de plancher « pas dans le passé ». */
export function aujourdHuiDans(timeZone: string | null): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: timeZone ?? "UTC",
  }).format(new Date());
  return parts; // en-CA rend déjà "YYYY-MM-DD"
}

export interface DateFieldProps {
  /** Date civile "YYYY-MM-DD", ou "" si rien n'est choisi. */
  value: string;
  onChange: (ymd: string) => void;
  /** Première date choisissable (incluse). Les jours antérieurs sont affichés mais inertes. */
  min?: string;
  /** Texte du bouton quand aucune date n'est choisie. */
  placeholder?: string;
  /** Affiche une croix pour revenir à "" (champ facultatif, ex. « Until »). */
  clearable?: boolean;
  disabled?: boolean;
  id?: string;
  className?: string;
  /** Contenu ajouté sous le calendrier — l'heure, par exemple. */
  children?: React.ReactNode;
}

export function DateField({
  value,
  onChange,
  min,
  placeholder = "Pick a date",
  clearable = false,
  disabled = false,
  id,
  className,
  children,
}: DateFieldProps): React.ReactElement {
  const [ouvert, setOuvert] = useState(false);
  // Le curseur porte À LA FOIS la date qui a le focus clavier et le mois affiché : une seule source,
  // donc le mois suit toujours les flèches, sans état à resynchroniser.
  const [curseur, setCurseur] = useState(() => value || min || aujourdHuiDans(null));
  const grille = useRef<HTMLDivElement | null>(null);
  const aBouge = useRef(false);

  useEffect(() => {
    if (value) setCurseur(value);
  }, [value]);

  // Le focus ne suit le curseur QUE si le déplacement vient du clavier : sinon, ouvrir le panneau
  // volerait le focus à la page, et chaque rendu le reprendrait.
  useEffect(() => {
    if (!ouvert || !aBouge.current) return;
    aBouge.current = false;
    grille.current?.querySelector<HTMLButtonElement>(`[data-jour="${curseur}"]`)?.focus();
  }, [curseur, ouvert]);

  const [annee, mois] = useMemo(() => {
    const p = parseYmd(curseur) ?? parseYmd(aujourdHuiDans(null))!;
    return [p[0], p[1]] as const;
  }, [curseur]);

  const jours = useMemo(() => grilleDuMois(annee, mois), [annee, mois]);
  const bloque = (ymd: string): boolean => (min ? avant(ymd, min) : false);

  const deplacer = (suivant: string): void => {
    aBouge.current = true;
    setCurseur(min && avant(suivant, min) ? min : suivant);
  };

  const auClavier = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const pas: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (e.key in pas) {
      e.preventDefault();
      deplacer(addDaysYmd(curseur, pas[e.key]!));
      return;
    }
    if (e.key === "PageUp" || e.key === "PageDown") {
      e.preventDefault();
      deplacer(addMonthsYmd(curseur, e.key === "PageUp" ? -1 : 1));
      return;
    }
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const p = parseYmd(curseur);
      if (p) deplacer(toYmd(p[0], p[1], e.key === "Home" ? 1 : joursDansLeMois(p[0], p[1])));
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setOuvert(false);
    }
  };

  const choisir = (ymd: string): void => {
    if (bloque(ymd)) return;
    onChange(ymd);
    setCurseur(ymd);
    setOuvert(false);
  };

  const raccourcis: Array<[string, string]> = useMemo(() => {
    const base = min && avant(aujourdHuiDans(null), min) ? min : aujourdHuiDans(null);
    return [
      ["Today", base],
      ["Tomorrow", addDaysYmd(base, 1)],
      ["In a week", addDaysYmd(base, 7)],
    ];
  }, [min]);

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-stretch gap-1.5">
        <button
          type="button"
          id={id}
          disabled={disabled}
          aria-expanded={ouvert}
          onClick={() => setOuvert((o) => !o)}
          className={cn(
            "flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-[13.5px] outline-none transition-colors motion-reduce:transition-none",
            "focus-visible:ring-2 focus-visible:ring-brand/40",
            ouvert ? "border-brand bg-card" : "border-border bg-card hover:border-brand/40",
            disabled && "cursor-not-allowed opacity-50",
          )}
        >
          <CalendarDays className="h-[15px] w-[15px] shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className={cn("tabular-nums", !value && "text-muted-foreground")}>
            {value ? libelleDate(value) : placeholder}
          </span>
        </button>
        {clearable && value !== "" && !disabled && (
          <button
            type="button"
            onClick={() => onChange("")}
            aria-label="Clear the date"
            className="rounded-lg border border-border px-2 text-muted-foreground outline-none hover:border-brand/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            <X className="h-[15px] w-[15px]" aria-hidden="true" />
          </button>
        )}
      </div>

      {ouvert && (
        /*
         * ⛔ LARGEUR PROPRE, PAS CELLE DE LA COLONNE. Le panneau héritait de son conteneur : dans la
         * grille à quatre colonnes de la cadence (`recurrence-picker.tsx`), affichée à l'intérieur
         * de l'assistant, une colonne fait ~150 px — sept cases et six gouttières n'y tiennent pas,
         * les quantièmes se chevauchent et les raccourcis se cassent en trois lignes. C'est le
         * « date picker cassé » signalé par Alix le 18/09/2026.
         *
         * `z-20` + fond opaque : dans une colonne étroite, le panneau passe PAR-DESSUS la colonne
         * voisine au lieu d'être compressé. Il reste dans le flux — le corps de l'assistant est en
         * `overflow-hidden` + `overflow-y-auto`, un panneau en position absolue y serait coupé.
         */
        <div className="relative z-20 w-[240px] rounded-xl border border-border bg-card p-3 shadow-md">
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              onClick={() => deplacer(addMonthsYmd(curseur, -1))}
              aria-label="Previous month"
              className="rounded-lg border border-transparent p-1 text-muted-foreground outline-none hover:border-border hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand/40"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            </button>
            <span aria-live="polite" className="text-[13px] font-semibold">
              {F_MOIS.format(Date.UTC(annee, mois - 1, 15))}
            </span>
            <button
              type="button"
              onClick={() => deplacer(addMonthsYmd(curseur, 1))}
              aria-label="Next month"
              className="rounded-lg border border-transparent p-1 text-muted-foreground outline-none hover:border-border hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand/40"
            >
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>

          <div className="mb-1 grid grid-cols-7 gap-0.5 text-center text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">
            {JOURS.map((j) => (
              <span key={j}>{j.slice(0, 2)}</span>
            ))}
          </div>

          {/* Une seule tabulation entre dans la grille, les flèches font le reste (tabindex mobile). */}
          <div ref={grille} role="grid" onKeyDown={auClavier} className="grid grid-cols-7 gap-0.5">
            {jours.map((ymd) => {
              const horsMois = !ymd.startsWith(`${toYmd(annee, mois, 1).slice(0, 7)}-`);
              const inerte = bloque(ymd);
              const choisi = ymd === value;
              return (
                <button
                  key={ymd}
                  type="button"
                  data-jour={ymd}
                  role="gridcell"
                  aria-selected={choisi}
                  aria-label={libelleDate(ymd)}
                  disabled={inerte}
                  tabIndex={ymd === curseur ? 0 : -1}
                  onClick={() => choisir(ymd)}
                  className={cn(
                    "h-8 rounded-lg border text-[12.5px] tabular-nums outline-none transition-colors motion-reduce:transition-none",
                    "focus-visible:ring-2 focus-visible:ring-brand/40",
                    choisi
                      ? "border-brand bg-brand/10 font-semibold text-brand"
                      : "border-transparent hover:border-brand/40",
                    !choisi && horsMois && "text-muted-foreground/50",
                    inerte && "cursor-not-allowed text-muted-foreground/30 hover:border-transparent",
                  )}
                >
                  {Number(ymd.slice(8, 10))}
                </button>
              );
            })}
          </div>

          <div className="mt-2 flex flex-wrap gap-1.5 border-t border-border pt-2">
            {raccourcis.map(([label, ymd]) => (
              <button
                key={label}
                type="button"
                onClick={() => choisir(ymd)}
                className="rounded-lg border border-border px-2 py-1 text-[11.5px] text-muted-foreground outline-none hover:border-brand/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand/40"
              >
                {label}
              </button>
            ))}
          </div>

          {children}
        </div>
      )}
    </div>
  );
}

export interface DateTimeFieldProps extends Omit<DateFieldProps, "children"> {
  /** Heure civile "HH:MM". */
  time: string;
  onTimeChange: (hhmm: string) => void;
  /** Phrase sous l'heure : fuseau, équivalent UTC… */
  hint?: React.ReactNode;
}

/** Date + heure dans UN seul champ : le calendrier, puis l'heure sous la grille. */
export function DateTimeField({ time, onTimeChange, hint, ...rest }: DateTimeFieldProps): React.ReactElement {
  // `useId` et pas un identifiant en dur : l'admin affiche DEUX formulaires de programmation
  // (l'assistant et le panneau latéral), et deux `id` identiques cassent le lien label ↔ champ.
  const idHeure = useId();
  return (
    <DateField {...rest}>
      <div className="mt-2 flex items-center gap-2 border-t border-border pt-2">
        <label htmlFor={idHeure} className="text-[12px] font-medium text-muted-foreground">
          Time
        </label>
        <input
          id={idHeure}
          type="time"
          value={time}
          onChange={(e) => onTimeChange(e.target.value)}
          className="rounded-lg border border-border bg-card px-2.5 py-1.5 text-[13px] tabular-nums outline-none focus:border-brand"
        />
        {hint}
      </div>
    </DateField>
  );
}
