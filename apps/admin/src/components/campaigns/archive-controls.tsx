"use client";

/**
 * ARCHIVER ET RÉACTIVER — les deux boutons, et les deux confirmations qui disent AVANT le clic ce que
 * le geste va faire (demande d'Alix du 22/09/2026 ; routes : `archive/handler.ts`).
 *
 * ⛔ LA CONFIRMATION DÉPEND DE L'ÉTAT, parce que le geste en dépend :
 *  - série en marche : elle s'arrête ET ses éditions planifiées sont annulées — les dates sont RELUES
 *    (`GET /arm`, la requête même de l'annulation) et LISTÉES, le bouton dit « Archive and cancel N » ;
 *  - envoi unique programmé : il sort du calendrier, et « Reactivate » peut l'y remettre ;
 *  - le reste : la campagne change seulement d'onglet.
 * Un geste destructeur annoncé seulement par son résultat est un geste non annoncé (même règle que
 * « Stop and cancel N » dans le panneau de série).
 *
 * ⛔ « Reactivate » ANNONCE CE QUI REPART, lu à la route (`GET /reactivate`) : la première édition et
 * le nombre de destinataires pour une série, la date pour un envoi unique. La réponse du geste est
 * ensuite affichée TELLE QUELLE, jusqu'à « Close » : un redémarrage refusé (finalité retirée, version
 * dépubliée) doit se lire, pas disparaître avec la ligne.
 *
 * ⚠️ Les modales passent par `ModalPortal` : `.animate-fade-up` pose un `transform` sur la page, qui
 * rend `position: fixed` relatif à la page et non à l'écran.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, ArchiveRestore, Loader2 } from "lucide-react";
import { ModalPortal } from "@/components/modal-portal";
import { Action } from "@/components/campaigns/campaign-actions";
import { quandDansLeFuseau } from "@/components/campaigns/cadence";
import { readError } from "@/components/campaigns/shared";
import { formatDateTime } from "@/components/templates/format";

/* ------------------------------------------------------------------ *
 * La coquille commune
 * ------------------------------------------------------------------ */

function Fenetre({
  titre,
  onClose,
  children,
}: {
  titre: string;
  onClose: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <ModalPortal>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={titre}>
        <div className="absolute inset-0 bg-black/40" onClick={onClose} />
        <div className="relative z-10 w-full max-w-[480px] rounded-2xl border border-border bg-card p-5 shadow-2xl">
          <p className="text-[14px] font-semibold">{titre}</p>
          {children}
        </div>
      </div>
    </ModalPortal>
  );
}

/** Déclencheur compact de la liste ou bouton plein de la page — le même geste derrière. */
function Declencheur({
  compact,
  onClick,
  busy,
  disabled,
  title,
  icon,
  children,
}: {
  compact: boolean;
  onClick: () => void;
  busy: boolean;
  disabled?: boolean;
  title?: string;
  icon: React.ReactNode;
  children: string;
}): React.ReactElement {
  if (!compact) {
    return (
      <Action onClick={onClick} busy={busy} disabled={disabled} title={title} icon={icon}>
        {children}
      </Action>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || disabled}
      title={title}
      className="inline-flex items-center gap-1.5 rounded-[8px] border border-border bg-card px-2.5 py-1 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : icon}
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * Archiver
 * ------------------------------------------------------------------ */

export interface ArchivableCampaign {
  id: string;
  name: string;
  status: string;
  recurrenceDays: number[];
  recurrenceActive: boolean;
  scheduledAt: string | null;
  timezone: string | null;
}

type Apercu = { count: number; dates: string[] };

export function ArchiveButton({
  campaign,
  compact = false,
}: {
  campaign: ArchivableCampaign;
  /** `true` dans la liste : un petit bouton par ligne. */
  compact?: boolean;
}): React.ReactElement {
  const router = useRouter();
  const [ouvert, setOuvert] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Le résultat d'un archivage à moitié réussi (207) — gardé à l'écran jusqu'à « Close ». */
  const [note, setNote] = useState<string | null>(null);
  /** Les éditions qu'archiver va annuler — RELUES à l'ouverture, jamais devinées. */
  const [aVenir, setAVenir] = useState<Apercu | null>(null);

  const enMarche = campaign.recurrenceDays.length > 0 && campaign.recurrenceActive;
  const programmee = campaign.status === "scheduled";
  const enVol = campaign.status === "sending";

  async function ouvrir(): Promise<void> {
    setError(null);
    setNote(null);
    setAVenir(null);
    if (!enMarche) {
      setOuvert(true);
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/campaigns/${campaign.id}/arm`);
      if (!res.ok) {
        setError(await readError(res));
      } else {
        const body = (await res.json()) as { upcoming?: Apercu };
        setAVenir(body.upcoming ?? { count: 0, dates: [] });
      }
      setOuvert(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setOuvert(true);
    } finally {
      setBusy(false);
    }
  }

  function fermer(): void {
    if (busy) return;
    setOuvert(false);
    // Un 207 a déjà changé la base : la page se relit en fermant.
    if (note) router.refresh();
  }

  async function archiver(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/campaigns/${campaign.id}/archive`, { method: "POST" });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { cancelError?: string };
      if (res.status === 207 || body.cancelError) {
        // ⚠️ Les deux moitiés, séparément : la série EST arrêtée et archivée, l'annulation non.
        setNote(
          `Archived and the series is stopped, but its planned editions could NOT all be cancelled: ${String(body.cancelError ?? "unknown error")}. While archived they are not sent; check the campaign page.`,
        );
        return;
      }
      setOuvert(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  const n = aVenir?.count ?? 0;
  const libelle = enMarche && n > 0 ? `Archive and cancel ${n}` : "Archive";

  return (
    <>
      <Declencheur
        compact={compact}
        onClick={ouvrir}
        busy={busy && !ouvert}
        disabled={enVol}
        title={enVol ? "This campaign is sending right now — it can be archived once the send has finished." : undefined}
        icon={<Archive className={compact ? "h-3.5 w-3.5" : "h-[14px] w-[14px]"} aria-hidden="true" />}
      >
        Archive
      </Declencheur>

      {ouvert && (
        <Fenetre titre={`Archive “${campaign.name}”?`} onClose={fermer}>
          {note ? (
            <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900">{note}</p>
          ) : enMarche ? (
            <>
              <p className="mt-2 text-[12.5px] text-muted-foreground">
                The series is running. Archiving <b className="font-semibold text-foreground">stops it</b>
                {n > 0 ? (
                  <>
                    {" "}
                    <b className="font-semibold text-foreground">
                      and cancels the {n} edition{n > 1 ? "s" : ""} already planned
                    </b>{" "}
                    — {n > 1 ? "they" : "it"} will not be sent:
                  </>
                ) : aVenir ? (
                  ". Nothing is planned right now, so nothing is cancelled."
                ) : (
                  ". Its planned editions could not be read just now; any that exist are cancelled."
                )}
              </p>
              {aVenir && aVenir.dates.length > 0 && (
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
                Reactivate in the Archived tab starts the series again from its next date. A cancelled date is
                never re-created.
              </p>
            </>
          ) : programmee ? (
            <p className="mt-2 text-[12.5px] text-muted-foreground">
              It is scheduled for <b className="font-semibold text-foreground">{formatDateTime(campaign.scheduledAt)}</b>.
              Archiving <b className="font-semibold text-foreground">takes that send off the schedule</b> — nothing goes
              out. Reactivate in the Archived tab puts it back on that date, if the date has not passed.
            </p>
          ) : (
            <p className="mt-2 text-[12.5px] text-muted-foreground">
              It only moves to the Archived tab. Nothing is sent, nothing is deleted, and Restore brings it back.
            </p>
          )}

          {error && <p className="mt-2 text-[12px] text-red-600">{error}</p>}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {note ? (
              <Action onClick={fermer} primary>
                Close
              </Action>
            ) : (
              <>
                <Action onClick={archiver} busy={busy} primary icon={<Archive className="h-[14px] w-[14px]" aria-hidden="true" />}>
                  {libelle}
                </Action>
                <Action onClick={fermer} disabled={busy}>
                  Keep it
                </Action>
              </>
            )}
          </div>
        </Fenetre>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Réactiver
 * ------------------------------------------------------------------ */

/** Le plan décidé par `planDeReactivation` (serveur), transmis tel quel. */
export type PlanAffiche =
  | { quoi: "serie" }
  | { quoi: "programmee"; scheduledAt: string }
  | { quoi: "date-passee"; scheduledAt: string }
  | { quoi: "liste" };

interface ApercuReactivation {
  upcoming?: { count: number; first: string | null; excluded: number } | null;
  recipients?: number | null;
  recipientsReason?: string | null;
  horizonDays?: number;
}

export function ReactivateButton({
  campaign,
  plan,
  compact = false,
}: {
  campaign: { id: string; name: string; timezone: string | null };
  plan: PlanAffiche;
  compact?: boolean;
}): React.ReactElement {
  const router = useRouter();
  const [ouvert, setOuvert] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [apercu, setApercu] = useState<ApercuReactivation | null>(null);
  /** La phrase de la route après le geste — affichée telle quelle jusqu'à « Close ». */
  const [resultat, setResultat] = useState<{ message: string; refuse: boolean } | null>(null);

  const libelle = plan.quoi === "liste" ? "Restore" : "Reactivate";
  const icone = <ArchiveRestore className={compact ? "h-3.5 w-3.5" : "h-[14px] w-[14px]"} aria-hidden="true" />;

  async function ouvrir(): Promise<void> {
    setError(null);
    setResultat(null);
    setApercu(null);
    if (plan.quoi !== "serie" && plan.quoi !== "programmee") {
      setOuvert(true);
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/campaigns/${campaign.id}/reactivate`);
      if (!res.ok) setError(await readError(res));
      else setApercu((await res.json()) as ApercuReactivation);
      setOuvert(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setOuvert(true);
    } finally {
      setBusy(false);
    }
  }

  function fermer(): void {
    if (busy) return;
    setOuvert(false);
    // La campagne a quitté l'onglet : la liste se relit en fermant, pas avant — sinon la ligne
    // disparaîtrait avec la phrase qui dit ce qui a (ou n'a pas) redémarré.
    if (resultat) router.refresh();
  }

  async function reactiver(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/campaigns/${campaign.id}/reactivate`, { method: "POST" });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      setResultat({ message: String(body.message ?? "Done."), refuse: res.status === 207 });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  const destinataires = (() => {
    if (!apercu) return null;
    if (apercu.recipients === null || apercu.recipients === undefined) {
      return `The number of recipients could not be counted just now${apercu.recipientsReason ? `: ${apercu.recipientsReason}` : ""}.`;
    }
    const r = apercu.recipients;
    return `${r.toLocaleString("en-US")} recipient${r === 1 ? "" : "s"} today.`;
  })();

  return (
    <>
      <Declencheur compact={compact} onClick={ouvrir} busy={busy && !ouvert} icon={icone}>
        {libelle}
      </Declencheur>

      {ouvert && (
        <Fenetre titre={`${libelle} “${campaign.name}”?`} onClose={fermer}>
          {resultat ? (
            <p
              className={
                resultat.refuse
                  ? "mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900"
                  : "mt-2 rounded-lg border border-border bg-accent/40 px-3 py-2 text-[12.5px] text-foreground/85"
              }
            >
              {resultat.message}
            </p>
          ) : plan.quoi === "serie" ? (
            <>
              <p className="mt-2 text-[12.5px] text-muted-foreground">
                The series <b className="font-semibold text-foreground">starts again</b> and real emails go out.
                {apercu?.upcoming ? (
                  apercu.upcoming.count > 0 ? (
                    <>
                      {" "}
                      First edition on{" "}
                      <b className="font-semibold text-foreground">{quandDansLeFuseau(apercu.upcoming.first, campaign.timezone)}</b>,{" "}
                      {apercu.upcoming.count} in the next {apercu.horizonDays ?? 21} days.
                    </>
                  ) : (
                    ` No edition falls in the next ${apercu.horizonDays ?? 21} days — check the cadence.`
                  )
                ) : (
                  " Its next dates could not be read just now."
                )}{" "}
                {destinataires}
              </p>
              {apercu?.upcoming && apercu.upcoming.excluded > 0 && (
                <p className="mt-1.5 text-[11.5px] text-muted-foreground">
                  {apercu.upcoming.excluded} date{apercu.upcoming.excluded > 1 ? "s" : ""} cancelled earlier{" "}
                  {apercu.upcoming.excluded > 1 ? "are" : "is"} not re-created.
                </p>
              )}
              <p className="mt-1.5 text-[11.5px] text-muted-foreground">
                The same checks as Start series apply. If one fails, the campaign comes back to the list stopped, and
                you are told why.
              </p>
            </>
          ) : plan.quoi === "programmee" ? (
            <p className="mt-2 text-[12.5px] text-muted-foreground">
              It is <b className="font-semibold text-foreground">scheduled again for {formatDateTime(plan.scheduledAt)}</b>{" "}
              and real emails go out then. {destinataires}
            </p>
          ) : plan.quoi === "date-passee" ? (
            <p className="mt-2 text-[12.5px] text-muted-foreground">
              Its send date ({formatDateTime(plan.scheduledAt)}) has passed. It comes back as a{" "}
              <b className="font-semibold text-foreground">draft</b> — nothing is sent. Pick a new date on its page.
            </p>
          ) : (
            <p className="mt-2 text-[12.5px] text-muted-foreground">
              It goes back to the campaigns list as it was. Nothing was running, so nothing is sent.
            </p>
          )}

          {error && <p className="mt-2 text-[12px] text-red-600">{error}</p>}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {resultat ? (
              <Action onClick={fermer} primary>
                Close
              </Action>
            ) : (
              <>
                <Action onClick={reactiver} busy={busy} primary icon={icone}>
                  {libelle}
                </Action>
                <Action onClick={fermer} disabled={busy}>
                  Cancel
                </Action>
              </>
            )}
          </div>
        </Fenetre>
      )}
    </>
  );
}
