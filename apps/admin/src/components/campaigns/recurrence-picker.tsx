"use client";

/**
 * CADENCE D'UNE SÉRIE — « tous les vendredis et lundis à 10h », la demande d'origine :
 * « il nous faut la possibilité de pouvoir créer des recurring campaigns (nos newsletters
 * basiquement), donc avoir des champs pour pouvoir dire que je veux envoyer tous les vendredi et
 * lundi á 10h par exemple, pas juste une date specifique. »
 *
 * Trois choix qui ne se voient pas mais qui décident de tout :
 *
 *  1. **LE FUSEAU CESSE D'ÊTRE SUBI.** L'écran actuel écrit « saisi dans le fuseau de votre
 *     navigateur » : une newsletter chilienne programmée depuis Paris part alors avec cinq heures
 *     d'écart, et rien à l'écran ne le dit. Ici le fuseau est un champ, pré-rempli depuis
 *     l'édition, affiché avec son décalage.
 *  2. **L'APERÇU VIENT DU SERVEUR.** Le recalculer dans le navigateur donnerait un résultat juste
 *     onze mois sur douze : Node, le navigateur et Postgres n'ont pas la même tzdata. C'est la même
 *     fonction SQL qui répond ici et qui créera les occurrences.
 *  3. **L'HEURE DE GEL EST CALCULÉE, PAS RACONTÉE.** « le contenu est figé 90 min avant » n'aide
 *     personne ; « figé à 08:30 » se vérifie d'un coup d'œil sur un envoi de 10:00.
 *
 * ⛔ Ce composant ne crée RIEN. Il décrit une cadence ; l'écriture appartient à l'assistant, et la
 * matérialisation au worker (S-4).
 */
import { useCallback, useEffect, useId, useState } from "react";
import { AlertTriangle, CalendarClock, Loader2, Snowflake } from "lucide-react";
// ⚠️ Le calcul du gel vit dans `cadence.ts` (module PUR) : la page de campagne, qui est un composant
// serveur, doit l'afficher elle aussi. Deux copies de cette arithmétique, c'est deux heures de gel.
import { heureDeGel } from "@/components/campaigns/cadence";
import { DateField, aujourdHuiDans } from "@/components/date-field";
import { MAX_EDITION_START, parseEditionStart } from "@/lib/edition-start";
import { cn } from "@/lib/utils";

/** ISO 8601 : la semaine commence le lundi. Les valeurs sont celles de `extract(isodow)`. */
const DAYS: { iso: number; short: string; label: string }[] = [
  { iso: 1, short: "Mon", label: "Monday" },
  { iso: 2, short: "Tue", label: "Tuesday" },
  { iso: 3, short: "Wed", label: "Wednesday" },
  { iso: 4, short: "Thu", label: "Thursday" },
  { iso: 5, short: "Fri", label: "Friday" },
  { iso: 6, short: "Sat", label: "Saturday" },
  { iso: 7, short: "Sun", label: "Sunday" },
];

const EVERY: { value: number; label: string }[] = [
  { value: 1, label: "Every week" },
  { value: 2, label: "Every 2 weeks" },
  { value: 4, label: "Every 4 weeks" },
];

/** Fuseaux des neuf marques, en tête de liste — ce sont ceux qu'on choisit 99 fois sur 100. */
const HOUSE_ZONES = ["America/Sao_Paulo", "America/Santiago", "Europe/London", "Europe/Madrid", "UTC"];

const INPUT =
  "w-full rounded-lg border border-border bg-card px-3 py-2 text-[13.5px] outline-none focus:border-brand";

export interface Recurrence {
  days: number[];
  time: string;
  timezone: string;
  everyWeeks: number;
  /** `""` = sans fin. Une série sans fin est un choix, pas un oubli — l'écran le dit. */
  until: string;
  freezeLeadMinutes: number;
  /**
   * Numéro de la première édition (0067), imprimé en `{{edition_number}}`. Tant que le champ est
   * en cours de saisie il peut être invalide : la route le refuse, l'écran le signale.
   */
  editionStart: number;
}

export interface OccurrencePreview {
  localDate: string;
  firesAt: string;
  localText: string;
}

/** Ce fuseau existe-t-il pour ce navigateur ? Le champ est libre (`<input list>`), donc saisissable faux. */
export function zoneConnue(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ce qui MANQUE à une cadence pour être enregistrable, dit en une phrase — ou `null` si elle est
 * complète.
 *
 * ⛔ La liste doit rester CELLE DE LA ROUTE `/api/campaigns/[id]/recurrence` (handler.ts:92-121).
 * C'est le défaut du 18/09/2026 : l'assistant n'exigeait que `days`, `time` et `timezone`, laissait
 * « Next » actif, la route refusait en 400 — et le refus s'affichait tout en bas d'un conteneur qui
 * défile, donc hors écran. Vu de l'utilisateur : « je crée une série répétée, rien ne se sauvegarde ».
 */
export function cadenceIncomplete(r: Recurrence): string | null {
  if (r.days.length === 0) return "Pick at least one day of the week.";
  if (!/^\d{2}:\d{2}$/.test(r.time)) return "Set the time of day.";
  if (r.timezone.trim() === "") return "Set the timezone.";
  if (!zoneConnue(r.timezone)) return `“${r.timezone}” is not a timezone — pick one from the list.`;
  // `undefined` (champ absent) comme `null` (valeur refusée) sont des cadences non enregistrables.
  const premiere = parseEditionStart(r.editionStart);
  if (premiere === null || premiere === undefined) {
    return `First edition no. must be a whole number between 1 and ${MAX_EDITION_START}.`;
  }
  if (r.until !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(r.until)) return "The end date is not a valid date.";
  if (!Number.isInteger(r.freezeLeadMinutes) || r.freezeLeadMinutes < 0) {
    return "Content cut-off must be a whole number of minutes.";
  }
  return null;
}

/**
 * Les N prochains envois d'une cadence, calculés PAR LE SERVEUR (même fonction SQL que le
 * matérialiseur). Lève avec le message de la route en cas de refus.
 *
 * ⚠️ Exportée pour l'assistant : son récapitulatif annonce « First send » AVANT le clic sur
 * « Start series ». Il ne peut pas relire l'aperçu de ce sélecteur — démonté dès qu'on quitte
 * l'étape, et en retard de 250 ms sur la dernière frappe : un « Next » rapide aurait affiché le
 * premier envoi de l'ANCIENNE cadence. L'assistant recalcule donc, avec cette même fonction, la
 * cadence qu'il vient d'enregistrer.
 */
export async function chargerApercu(
  r: Pick<Recurrence, "days" | "time" | "timezone" | "everyWeeks" | "until">,
  limit: number,
): Promise<{ occurrences: OccurrencePreview[]; crossesDst: boolean }> {
  const res = await fetch("/api/campaigns/occurrences/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      days: r.days,
      time: r.time,
      timezone: r.timezone,
      everyWeeks: r.everyWeeks,
      until: r.until || undefined,
      limit,
    }),
  });
  const body = (await res.json()) as {
    error?: string;
    occurrences?: OccurrencePreview[];
    crossesDstChange?: boolean;
  };
  if (!res.ok) throw new Error(body.error ?? `preview failed (${res.status})`);
  return { occurrences: body.occurrences ?? [], crossesDst: Boolean(body.crossesDstChange) };
}

/** Décalage AUJOURD'HUI, pour étiqueter le sélecteur. L'aperçu, lui, donne celui de chaque envoi. */
function offsetLabel(tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(
      new Date(),
    );
    return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

/** Liste IANA complète, marques d'abord. Un `datalist` plutôt qu'un `select` de 400 entrées. */
function allZones(): string[] {
  let zones: string[] = [];
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    zones = supported ? supported("timeZone") : [];
  } catch {
    zones = [];
  }
  const rest = zones.filter((z) => !HOUSE_ZONES.includes(z));
  return [...HOUSE_ZONES, ...rest];
}

export function RecurrencePicker({
  value,
  onChange,
  /** Fuseau de l'édition — sert de valeur par défaut ET de repère (« celui de la marque »). */
  editionTimezone,
}: {
  value: Recurrence;
  onChange: (next: Recurrence) => void;
  editionTimezone: string | null;
}) {
  const idZones = useId();
  const [preview, setPreview] = useState<OccurrencePreview[] | null>(null);
  const [crossesDst, setCrossesDst] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zones] = useState<string[]>(() => allZones());

  const patch = (p: Partial<Recurrence>) => onChange({ ...value, ...p });

  const toggleDay = (iso: number) =>
    patch({
      days: value.days.includes(iso) ? value.days.filter((d) => d !== iso) : [...value.days, iso].sort((a, b) => a - b),
    });

  const load = useCallback(async () => {
    if (value.days.length === 0 || !value.time || !value.timezone) {
      setPreview(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const r = await chargerApercu(
        { days: value.days, time: value.time, timezone: value.timezone, everyWeeks: value.everyWeeks, until: value.until },
        5,
      );
      setPreview(r.occurrences);
      setCrossesDst(r.crossesDst);
    } catch (e) {
      // ⛔ Pas de liste vide en cas d'erreur : « aucun envoi ne correspond » et « le calcul a
      // échoué » amènent l'opérateur à faire deux choses opposées.
      setPreview(null);
      setError(e instanceof Error ? e.message : "the preview failed");
    } finally {
      setLoading(false);
    }
  }, [value.days, value.time, value.timezone, value.everyWeeks, value.until]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  const gel = heureDeGel(value.time, value.freezeLeadMinutes);
  const editionOk = parseEditionStart(value.editionStart) != null;
  const zoneOffset = offsetLabel(value.timezone);
  const zoneIsEdition = editionTimezone !== null && value.timezone === editionTimezone;

  return (
    <div className="flex flex-col gap-4">
      {/* --------------------------------------------------------- Jours */}
      <div>
        <span className="mb-1.5 block text-[12px] font-semibold">Repeat on</span>
        <div className="flex flex-wrap gap-1.5">
          {DAYS.map((d) => {
            const on = value.days.includes(d.iso);
            return (
              <button
                key={d.iso}
                type="button"
                aria-pressed={on}
                aria-label={d.label}
                onClick={() => toggleDay(d.iso)}
                className={cn(
                  "min-w-[52px] rounded-lg border px-2.5 py-1.5 text-[12.5px] font-medium transition-colors motion-reduce:transition-none",
                  on ? "border-brand bg-brand/10 text-brand" : "border-border text-muted-foreground hover:border-brand/40",
                )}
              >
                {d.short}
              </button>
            );
          })}
        </div>
        {value.days.length === 0 && (
          <p className="mt-1.5 text-[11.5px] text-muted-foreground">Pick at least one day to see the schedule.</p>
        )}
      </div>

      {/* ------------------------------------- Heure, cadence, fin, numéro */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block">
          <span className="mb-1 block text-[12px] font-semibold">At</span>
          <input
            type="time"
            value={value.time}
            onChange={(e) => patch({ time: e.target.value })}
            className={cn(INPUT, "tabular-nums")}
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-[12px] font-semibold">Repeat</span>
          <select
            value={value.everyWeeks}
            onChange={(e) => patch({ everyWeeks: Number(e.target.value) })}
            className={INPUT}
          >
            {EVERY.map((e) => (
              <option key={e.value} value={e.value}>
                {e.label}
              </option>
            ))}
          </select>
        </label>

        {/*
          ⛔ `clearable` : une série SANS FIN est un choix, pas un oubli — et un `<input type="date">`
          ne se vide qu'en sélectionnant son contenu au clavier. Sans la croix, « jusqu'au » serait
          une porte à sens unique.
        */}
        <div className="block">
          <span className="mb-1 block text-[12px] font-semibold">Until</span>
          <DateField
            value={value.until}
            onChange={(until) => patch({ until })}
            min={aujourdHuiDans(zoneConnue(value.timezone) ? value.timezone : null)}
            placeholder="No end date"
            clearable
          />
        </div>

        <label className="block">
          <span className="mb-1 block text-[12px] font-semibold">First edition no.</span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_EDITION_START}
            step={1}
            value={Number.isNaN(value.editionStart) ? "" : value.editionStart}
            onChange={(e) => patch({ editionStart: e.target.value === "" ? Number.NaN : Number(e.target.value) })}
            aria-invalid={!editionOk}
            aria-describedby="nf-edition-start-help"
            className={cn(INPUT, "tabular-nums", !editionOk && "border-[#c0334a]")}
          />
        </label>
      </div>
      <p id="nf-edition-start-help" className="-mt-2 text-[11.5px] text-muted-foreground">
        {editionOk ? (
          <>
            The first send prints <span className="font-semibold text-foreground">edition {value.editionStart}</span>{" "}
            wherever the template uses <code className="text-[11px]">{"{{edition_number}}"}</code>. Continuing an
            existing newsletter? Enter its next number.
          </>
        ) : (
          <span className="text-[#c0334a]">Enter a whole number between 1 and {MAX_EDITION_START.toLocaleString("en-US")}.</span>
        )}
      </p>

      {/* -------------------------------------------------------- Fuseau */}
      <div>
        <label className="block">
          <span className="mb-1 block text-[12px] font-semibold">Time zone</span>
          {/*
            ⛔ `useId()` ET PAS UN IDENTIFIANT EN DUR. Ce composant est désormais monté à DEUX
            endroits (l'assistant de création et le panneau de série de la page de campagne) : deux
            `datalist` portant le même id, et le navigateur n'en lit qu'un — la liste de fuseaux du
            second champ serait silencieusement vide. Même parade que l'heure de `DateTimeField`.
          */}
          <input
            list={idZones}
            value={value.timezone}
            onChange={(e) => patch({ timezone: e.target.value })}
            placeholder="America/Sao_Paulo"
            className={INPUT}
          />
        </label>
        <datalist id={idZones}>
          {zones.map((z) => (
            <option key={z} value={z} />
          ))}
        </datalist>
        <p className="mt-1 text-[11.5px] text-muted-foreground">
          {zoneOffset && (
            <>
              Currently <span className="font-semibold text-foreground tabular-nums">{zoneOffset}</span>.{" "}
            </>
          )}
          {zoneIsEdition ? (
            <>This is the edition&rsquo;s own zone — subscribers get the hour you typed, wherever you are.</>
          ) : editionTimezone ? (
            <>
              ⚠️ The edition is set to <span className="font-semibold">{editionTimezone}</span>. Sending on another zone
              is allowed, but subscribers will not get the local hour you might expect.
            </>
          ) : (
            <>The edition has no time zone recorded, so nothing could be pre-filled.</>
          )}
        </p>
      </div>

      {/* --------------------------------------------------------- Gel */}
      {gel && (
        <p className="flex items-start gap-2 rounded-lg border border-border bg-accent/40 px-3 py-2 text-[12px]">
          <Snowflake className="mt-[2px] h-3.5 w-3.5 shrink-0 text-muted-foreground" strokeWidth={2} />
          <span>
            Content cut-off is at <span className="font-semibold tabular-nums">{gel}</span> local time —{" "}
            {value.freezeLeadMinutes} minutes before each send. Edits made after that go to the{" "}
            <em>next</em> edition, not this one.
          </span>
        </p>
      )}

      {/* ------------------------------------------------------- Aperçu */}
      <div className="rounded-lg border border-border">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <CalendarClock className="h-3.5 w-3.5 text-muted-foreground" strokeWidth={2} />
          <span className="text-[12px] font-semibold">Your next 5 sends</span>
          {loading && (
            <Loader2 className="ml-auto h-3.5 w-3.5 animate-spin text-muted-foreground motion-reduce:animate-none" />
          )}
        </div>

        {error ? (
          <p className="flex items-start gap-2 px-3 py-2.5 text-[12px] text-[#c0334a]">
            <AlertTriangle className="mt-[2px] h-3.5 w-3.5 shrink-0" strokeWidth={2} />
            <span>{error}</span>
          </p>
        ) : loading ? (
          /* Pendant le calcul, `preview` vaut null — mais afficher l'invite « choisissez des jours »
             alors que l'opérateur VIENT de les choisir contredit son propre geste. On dit ce qui se
             passe réellement. */
          <p className="px-3 py-2.5 text-[12px] text-muted-foreground">Computing the schedule…</p>
        ) : preview === null ? (
          <p className="px-3 py-2.5 text-[12px] text-muted-foreground">
            Pick days, an hour and a time zone — the schedule is computed on the server, with the same calendar the
            sender uses.
          </p>
        ) : preview.length === 0 ? (
          <p className="px-3 py-2.5 text-[12px] text-muted-foreground">
            No send falls in the next year with these settings. Check the end date.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {preview.map((o, i) => (
              <li key={o.localDate} className="flex items-baseline justify-between gap-3 px-3 py-2 text-[12.5px]">
                <span className="font-medium tabular-nums">
                  {/* Numéro d'une série NEUVE : ce sélecteur ne sert qu'à la création. */}
                  {editionOk && <span className="mr-2 text-muted-foreground">#{value.editionStart + i}</span>}
                  {o.localText}
                </span>
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {new Date(o.firesAt).toISOString().replace("T", " ").slice(0, 16)} UTC
                </span>
              </li>
            ))}
          </ul>
        )}

        {crossesDst && (
          <p className="border-t border-border px-3 py-2 text-[11.5px] text-muted-foreground">
            The UTC column shifts within this list: a daylight-saving change falls in the window. The local hour stays
            the one you typed — that is the promise made to subscribers.
          </p>
        )}
      </div>

      {value.until === "" && value.days.length > 0 && (
        <p className="text-[11.5px] text-muted-foreground">
          No end date: this series keeps going until someone stops it.
        </p>
      )}
    </div>
  );
}
