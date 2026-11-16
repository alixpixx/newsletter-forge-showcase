"use client";

/**
 * LA SÉRIE, DEPUIS LA PAGE DE CAMPAGNE — allumer, éteindre, changer la cadence, la retirer.
 *
 * ⛔ CE QUE CE PANNEAU EXISTE POUR FERMER : UNE IMPASSE. Le bouton d'armement n'existait QUE dans
 * l'assistant de création, dans une modale qu'on ferme. Une fois fermée, plus aucun écran ne
 * pouvait armer une série — alors que la page de campagne affichait « arm the series to start it ».
 * L'instruction désignait un geste que l'interface n'offrait pas. Même chose pour la cadence :
 * `PATCH /recurrence` acceptait les modifications, aucun écran ne les proposait.
 *
 * ⛔ « ARMED » A DISPARU DU VOCABULAIRE. Alix, 18/09/2026 : « il y a un truc aussi "serie armed"
 * that we can arm or disarm its totally not clear of the purpose of this ». Le mot décrivait
 * l'implémentation (une colonne `recurrence_active` que le planificateur lit) et pas l'effet.
 * « On / Off » ne suffisait pas non plus (22/09/2026 : toujours incompris) : une série est
 * désormais « Running » ou « Stopped », les boutons disent le geste — « Start series » (« Resume
 * series » quand des éditions sont déjà parties) et « Stop series » —, et la prochaine édition est
 * datée sous la cadence. Les deux mots d'état viennent de `etatDeLaSerie`, partagé avec la liste.
 *
 * ⛔ ARRÊTER ANNULE CE QUI ÉTAIT DÉJÀ PRÉVU, ET LA LISTE EST MONTRÉE AVANT D'AGIR. Ni le gel ni la
 * mise en file ne lisent `recurrence_active` : sans annulation, une édition déjà planifiée partirait
 * série arrêtée. Le geste annule donc TOUJOURS (`cancelUpcoming=1`) — décision d'Alix du 18/09/2026.
 *
 * ⛔ ET CE N'EST PLUS UN CHOIX OFFERT AU MOMENT DU GESTE. La confirmation compte les éditions et les
 * NOMME pour qu'on vérifie avant de cliquer ; elle ne propose plus de les garder. Le bouton avait
 * deux comportements sous un seul mot, et celui qui partait par défaut était celui qui laissait des
 * envois sortir après l'arrêt. Le détail est sur `eteindre`, avec le sort de `cancelError`.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CalendarClock, Loader2, Play, Repeat, Snowflake, Square, Trash2 } from "lucide-react";
import { Pill } from "@/components/ui";
import { Action } from "@/components/campaigns/campaign-actions";
import { RecurrencePicker, cadenceIncomplete, type Recurrence } from "@/components/campaigns/recurrence-picker";
import {
  etatDeLaSerie,
  heureDeGel,
  phraseCadence,
  quandDansLeFuseau,
  type CadenceLue,
} from "@/components/campaigns/cadence";
import { readError } from "@/components/campaigns/shared";

export interface SeriesCampaign extends CadenceLue {
  id: string;
  status: string;
  lockedAt: string | null;
}

/** L'état de la base → la forme qu'attend le sélecteur de cadence. */
function versFormulaire(c: SeriesCampaign, zoneEdition: string | null): Recurrence {
  return {
    days: c.recurrenceDays,
    time: c.recurrenceTime ?? "10:00",
    timezone: c.timezone ?? zoneEdition ?? "UTC",
    everyWeeks: c.recurrenceEveryWeeks ?? 1,
    until: c.recurrenceUntil ?? "",
    freezeLeadMinutes: c.freezeLeadMinutes ?? 90,
    editionStart: c.editionStart ?? 1,
  };
}

type Vue = "repos" | "cadence" | "extinction";

export function SeriesPanel({
  campaign,
  editionTimezone,
  prochaineEdition = null,
  editionsParties = null,
}: {
  campaign: SeriesCampaign;
  editionTimezone: string | null;
  /**
   * La prochaine édition qui partira VRAIMENT (`planned`/`frozen`, date à venir), lue par la page
   * dans les occurrences — jamais calculée depuis la cadence : une date calculée promettrait un envoi
   * que le matérialiseur n'a pas (encore) créé.
   */
  prochaineEdition?: string | null;
  /** Éditions déjà parties (`sent`/`sending`). `null` = compte illisible. Décide « Start » ou « Resume ». */
  editionsParties?: number | null;
}): React.ReactElement | null {
  const router = useRouter();
  const [vue, setVue] = useState<Vue>("repos");
  const [busy, setBusy] = useState<null | "on" | "off" | "save" | "remove">(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [form, setForm] = useState<Recurrence>(() => versFormulaire(campaign, editionTimezone));
  /** Ce que l'extinction ne toucherait pas : chargé au moment de la demande, jamais deviné. */
  const [aVenir, setAVenir] = useState<{ count: number; dates: string[] } | null>(null);

  const serie = campaign.recurrenceDays.length > 0;
  const etat = etatDeLaSerie(campaign);
  const gel = heureDeGel(campaign.recurrenceTime, campaign.freezeLeadMinutes);
  const verrouille = Boolean(campaign.lockedAt);
  const terminal = campaign.status === "sent" || campaign.status === "cancelled" || campaign.status === "sending";
  const manque = cadenceIncomplete(form);
  /** « Resume » plutôt que « Start » dès qu'une édition est partie : on reprend, on ne découvre pas. */
  const reprise = (editionsParties ?? 0) > 0;
  const libelleDemarrer = reprise ? "Resume series" : "Start series";

  // Une campagne partie ou abandonnée n'a plus de cadence à régler ; et un envoi unique déjà
  // terminé n'a pas à proposer d'en devenir une.
  if (terminal && !serie) return null;

  async function appeler(
    url: string,
    init: RequestInit,
    quoi: NonNullable<typeof busy>,
    apres?: (body: Record<string, unknown>) => string | null,
  ): Promise<void> {
    setBusy(quoi);
    setError(null);
    setNote(null);
    try {
      const res = await fetch(url, init);
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      setNote(apres?.(body) ?? null);
      setVue("repos");
      // La page est un composant serveur : c'est elle qui relit la base. Sans ce rafraîchissement,
      // le panneau afficherait son propre état local — c'est-à-dire ce qu'il espère, pas ce qui est.
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(null);
    }
  }

  /**
   * Démarrer (ou reprendre). Les préconditions vivent dans la route : elle refuse en nommant ce qui
   * manque. ⛔ `upcoming: null` veut dire « la route n'a pas su relire », PAS « aucune date » : les
   * deux ne demandent pas le même geste, ils n'ont donc pas la même phrase.
   */
  const allumer = () =>
    appeler(`/api/campaigns/${campaign.id}/arm`, { method: "POST" }, "on", (b) => {
      const up = b.upcoming as { count?: number; first?: string | null; excluded?: number } | null | undefined;
      if (!up) return "Series running. Its next dates could not be read back just now — they appear below once the planner has created them.";
      const annulees =
        up.excluded && up.excluded > 0
          ? ` ${up.excluded} date${up.excluded > 1 ? "s" : ""} cancelled earlier ${up.excluded > 1 ? "are" : "is"} not re-created.`
          : "";
      if (!up.count) return `Series running, but no edition falls in the next 21 days — check the cadence.${annulees}`;
      return `Series running — first edition on ${quandDansLeFuseau(up.first, campaign.timezone)}, ${up.count} in the next 21 days.${annulees}`;
    });

  /** Demander l'extinction : on va D'ABORD chercher ce qui partirait quand même. */
  async function demanderExtinction(): Promise<void> {
    setBusy("off");
    setError(null);
    setNote(null);
    try {
      const res = await fetch(`/api/campaigns/${campaign.id}/arm`);
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      const body = (await res.json()) as { upcoming?: { count: number; dates: string[] } };
      setAVenir(body.upcoming ?? { count: 0, dates: [] });
      setVue("extinction");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(null);
    }
  }

  /*
   * ⛔ ÉTEINDRE ANNULE, TOUJOURS — décision d'Alix du 18/09/2026 (« désarmer une série : annule
   * aussi les éditions déjà planifiées »). Ce n'est plus un choix offert au moment du geste : le
   * bouton avait deux comportements sous un seul mot, et celui qui partait par défaut était celui
   * qui laissait des envois sortir après l'extinction.
   * ⚠️ `cancelError` ne fait PAS échouer le geste : la série EST éteinte (le désarmement est écrit
   * avant l'annulation, côté route). Le message doit donc dire les deux moitiés separément, sinon
   * on laisse croire que rien n'a marché alors que le plus important a marché.
   */
  const eteindre = () =>
    appeler(
      `/api/campaigns/${campaign.id}/arm?cancelUpcoming=1`,
      { method: "DELETE" },
      "off",
      (b) => {
        const n = Number(b.cancelled ?? 0);
        if (b.cancelError) {
          return `Series stopped, but the planned editions could NOT be cancelled — they will still go out: ${String(b.cancelError)}`;
        }
        if (n > 0) return `Series stopped — ${n} planned edition${n > 1 ? "s" : ""} cancelled.`;
        return "Series stopped. Nothing was planned, so nothing was cancelled.";
      },
    );

  const enregistrerCadence = () =>
    appeler(
      `/api/campaigns/${campaign.id}/recurrence`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          days: form.days,
          time: form.time,
          timezone: form.timezone,
          everyWeeks: form.everyWeeks,
          until: form.until === "" ? null : form.until,
          freezeLeadMinutes: form.freezeLeadMinutes,
          editionStart: form.editionStart,
        }),
      },
      "save",
      () =>
        campaign.recurrenceActive
          ? "Cadence saved. The series keeps running — the next editions follow the new cadence."
          : `Cadence saved. The series is stopped: click ${libelleDemarrer} to send it.`,
    );

  /*
   * ⛔ RETIRER LA CADENCE ANNULE AUSSI — aligné sur l'extinction (décision d'Alix, 18/09/2026).
   * C'est le geste le plus fort des trois : il serait absurde qu'il conserve ce que « Stop series »,
   * plus faible, annule. La phrase disait auparavant l'inverse (« Editions already planned are
   * kept ») : un texte qui promet le contraire de ce que fait le bouton est pire que pas de texte.
   */
  const retirerCadence = () => {
    const prevues = aVenir?.count ?? null;
    const combien = prevues === null ? "Any edition already planned is" : `The ${prevues} edition${prevues > 1 ? "s" : ""} already planned ${prevues > 1 ? "are" : "is"}`;
    const avertissement =
      prevues === 0
        ? "Remove the cadence? This campaign becomes a one-off send. Nothing is planned, so nothing is cancelled."
        : `Remove the cadence? This campaign becomes a one-off send. ${combien} cancelled too — a cancelled date is never re-created.`;
    if (!window.confirm(avertissement)) return;
    return appeler(
      `/api/campaigns/${campaign.id}/recurrence`,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ clear: true }) },
      "remove",
      (b) => {
        const n = Number(b.cancelled ?? 0);
        if (b.cancelError) {
          return `Cadence removed, but the planned editions could NOT be cancelled — they will still go out: ${String(b.cancelError)}`;
        }
        return n > 0
          ? `Cadence removed — this campaign now sends once, and ${n} planned edition${n > 1 ? "s were" : " was"} cancelled.`
          : "Cadence removed — this campaign now sends once.";
      },
    );
  };

  return (
    <div className="mb-6 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <Repeat className="h-4 w-4 text-muted-foreground" strokeWidth={2} aria-hidden="true" />
        <h2 className="text-[14px] font-bold tracking-tight">Series</h2>
        {serie && (
          <Pill tone={etat.arme ? "green" : "grey"} dot>
            {etat.libelle}
          </Pill>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-2 flex items-start gap-2 rounded-lg border border-[#f0b8c1] bg-[#fdeaec] px-3 py-2 text-[12.5px] text-[#c0334a]">
          <AlertTriangle className="mt-[1px] h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}
      {note && !error && (
        <p className="mt-2 rounded-lg border border-border bg-accent/40 px-3 py-2 text-[12.5px] text-muted-foreground">
          {note}
        </p>
      )}

      {/* ---------------------------------------------------- Campagne sans cadence */}
      {!serie && vue !== "cadence" && (
        <>
          <p className="mt-2 text-[13px]">This campaign sends once.</p>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">
            A series sends the same template again and again — every Monday and Friday at 10:00, for example — with
            the articles of each day.
          </p>
          <div className="mt-3">
            <Action
              onClick={() => setVue("cadence")}
              disabled={verrouille || terminal}
              title={
                verrouille
                  ? "The content is frozen for a single date — unlock it first"
                  : terminal
                    ? `A ${campaign.status} campaign cannot become a series`
                    : undefined
              }
              icon={<Repeat className="h-[14px] w-[14px]" />}
            >
              Make it repeating
            </Action>
          </div>
        </>
      )}

      {/* ---------------------------------------------------- Campagne à cadence, au repos */}
      {serie && vue === "repos" && (
        <>
          <p className="mt-2 text-[14px] font-semibold tabular-nums">{phraseCadence(campaign)}</p>
          {/*
            ⭐ LA PROCHAINE ÉDITION, DATÉE DANS LE FUSEAU DE LA SÉRIE. « Running » seul ne se vérifie
            contre rien ; une date se vérifie contre un calendrier. Elle vient des occurrences
            réellement créées — si aucune n'existe encore, on le dit au lieu d'en calculer une.
          */}
          {etat.arme && (
            <p className="mt-1 text-[12.5px] tabular-nums">
              <span className="text-muted-foreground">Next edition: </span>
              <span className="font-semibold">
                {prochaineEdition
                  ? quandDansLeFuseau(prochaineEdition, campaign.timezone)
                  : "none planned yet — the planner creates editions shortly after the start"}
              </span>
            </p>
          )}
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">
            {etat.arme
              ? "Editions are planned and sent automatically, one per date of the cadence."
              : reprise
                ? `Stopped — nothing is planned. ${libelleDemarrer} and the planner creates the next editions.`
                : `Stopped — nothing is planned and nothing is sent. ${libelleDemarrer} and the planner creates each edition.`}
          </p>

          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border pt-3 text-[12.5px] sm:grid-cols-4">
            <Fait label="Ends" value={campaign.recurrenceUntil ?? "No end date"} />
            <Fait label="Start numbering at" value={campaign.editionStart === null ? "—" : String(campaign.editionStart)} />
            <Fait
              label="Content cut-off"
              value={campaign.freezeLeadMinutes === null ? "—" : `${campaign.freezeLeadMinutes} min before`}
            />
            <Fait label="Timezone" value={campaign.timezone ?? "—"} />
          </dl>

          {gel && (
            <p className="mt-3 flex items-start gap-2 text-[12px] text-muted-foreground">
              <Snowflake className="mt-[2px] h-3.5 w-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
              <span>
                Content cut-off is at <span className="font-semibold tabular-nums">{gel}</span> local time before each
                send. Edits made after that go to the following edition.
              </span>
            </p>
          )}

          <div className="mt-3.5 flex flex-wrap items-center gap-2">
            {etat.arme ? (
              <Action
                onClick={demanderExtinction}
                busy={busy === "off"}
                icon={<Square className="h-[14px] w-[14px]" />}
                title="Stop planning new editions and cancel the planned ones — you see which before confirming"
              >
                Stop series
              </Action>
            ) : (
              <Action
                onClick={allumer}
                busy={busy === "on"}
                primary
                disabled={verrouille || terminal}
                title={
                  verrouille
                    ? "The content is frozen for a single date — unlock it first"
                    : terminal
                      ? `A ${campaign.status} campaign cannot run a series`
                      : "Plan and send the editions of this cadence, each at its own date"
                }
                icon={<Play className="h-[14px] w-[14px]" />}
              >
                {libelleDemarrer}
              </Action>
            )}
            <Action
              onClick={() => {
                setForm(versFormulaire(campaign, editionTimezone));
                setVue("cadence");
              }}
              disabled={verrouille || terminal}
              title={verrouille ? "The content is frozen — unlock it to change the cadence" : undefined}
              icon={<CalendarClock className="h-[14px] w-[14px]" />}
            >
              Edit cadence
            </Action>
            <Action
              onClick={retirerCadence}
              busy={busy === "remove"}
              disabled={verrouille || terminal}
              title={verrouille ? "The content is frozen — unlock it first" : "Turn this back into a one-off send"}
              icon={<Trash2 className="h-[14px] w-[14px]" />}
            >
              Remove cadence
            </Action>
          </div>
        </>
      )}

      {/* ---------------------------------------------------- Édition de la cadence */}
      {vue === "cadence" && (
        <div className="mt-3 border-t border-border pt-3">
          <RecurrencePicker value={form} onChange={setForm} editionTimezone={editionTimezone} />
          {manque && (
            <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900">
              {manque}
            </p>
          )}
          <p className="mt-2 text-[12px] text-muted-foreground">
            {campaign.recurrenceActive
              ? "The series keeps running: editions not created yet follow the new cadence."
              : `Saving does not start the series: nothing is planned and no email goes out until you click ${libelleDemarrer}.`}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Action
              onClick={enregistrerCadence}
              busy={busy === "save"}
              primary
              disabled={manque !== null}
              title={manque ?? undefined}
            >
              Save cadence
            </Action>
            <Action onClick={() => setVue("repos")} disabled={busy !== null}>
              Cancel
            </Action>
          </div>
        </div>
      )}

      {/* ---------------------------------------------------- Confirmation d'extinction */}
      {vue === "extinction" && (
        <div className="mt-3 border-t border-border pt-3">
          <p className="text-[13px] font-semibold">Stop the series?</p>
          {/* ⛔ CE QUI VA ETRE DÉTRUIT SE LIT AVANT LE GESTE, PAS APRÈS — et on NOMME les dates.
              « N editions will be cancelled » demande de croire sur parole ; la liste se vérifie.
              Les dates viennent d'être relues à l'ouverture de cette vue, jamais devinées. */}
          {aVenir && aVenir.count > 0 ? (
            <>
              <p className="mt-1 text-[12.5px] text-muted-foreground">
                The series stops planning new dates, <b className="font-semibold text-foreground">and the {aVenir.count} edition
                {aVenir.count > 1 ? "s" : ""} already planned {aVenir.count > 1 ? "are" : "is"} cancelled</b> — {aVenir.count > 1 ? "they" : "it"} will not be sent.
              </p>
              {aVenir.dates.length > 0 && (
                <ul className="mt-2 space-y-0.5 rounded-lg border border-border bg-accent/40 px-3 py-2">
                  {aVenir.dates.slice(0, 5).map((d) => (
                    <li key={d} className="text-[12px] tabular-nums text-foreground/80">
                      {quandDansLeFuseau(d, campaign.timezone)}
                    </li>
                  ))}
                  {aVenir.dates.length > 5 && (
                    <li className="text-[12px] text-muted-foreground">and {aVenir.dates.length - 5} more</li>
                  )}
                </ul>
              )}
              <p className="mt-2 text-[11.5px] text-muted-foreground">
                A cancelled date is never re-created, even if you resume the series later.
              </p>
            </>
          ) : (
            <p className="mt-1 text-[12.5px] text-muted-foreground">
              Nothing is planned right now, so there is nothing to cancel.
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {/* Le bouton NOMME ce qu'il fait : « Stop » seul cachait la moitié destructrice. */}
            <Action onClick={eteindre} busy={busy === "off"} primary icon={<Square className="h-[14px] w-[14px]" />}>
              {aVenir && aVenir.count > 0 ? `Stop and cancel ${aVenir.count}` : "Stop series"}
            </Action>
            <Action onClick={() => setVue("repos")} disabled={busy !== null}>
              Keep it running
            </Action>
          </div>
        </div>
      )}

      {busy && vue === "repos" && (
        <p className="mt-2 flex items-center gap-1.5 text-[12px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Working…
        </p>
      )}
    </div>
  );
}

function Fait({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div>
      <dt className="text-[11.5px] text-muted-foreground">{label}</dt>
      <dd className="truncate font-semibold tabular-nums" title={value}>
        {value}
      </dd>
    </div>
  );
}

