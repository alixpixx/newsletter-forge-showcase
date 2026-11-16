"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CalendarClock, FilePenLine, Loader2 } from "lucide-react";
import { Pill } from "@/components/ui";
import { EditionReview } from "@/components/campaigns/edition-review";
import { fmtInt } from "@/components/campaigns/shared";
import { fmtWhen } from "@/components/campaigns/shared";

/**
 * L'écran d'une SÉRIE : chaque échéance, son état, ce qu'elle a réellement produit.
 *
 * ⛔ CE QUE CET ÉCRAN EXISTE POUR RENDRE VISIBLE. Une occurrence retenue ne se débloque pas toute
 * seule : tant que personne ne republie ou n'autorise l'envoi, la série s'arrête. Jusqu'ici, la
 * seule trace d'un blocage était une alerte Slack et une ligne de journal — la collègue découvrait
 * le lundi que la newsletter de vendredi n'était jamais partie, sans savoir depuis quand ni
 * pourquoi. La raison du blocage est donc affichée ICI, à côté du geste qui le lève.
 *
 * ⚠️ LES TROIS COMPTEURS NE DISENT PAS LA MÊME CHOSE et l'écran ne les confond pas :
 * « planned » est ce qu'on visait, « sent » ce qui est parti, « skipped » ce que le gate de
 * conformité a écarté — un chiffre élevé n'est pas une panne technique, c'est un ciblage qui a visé
 * des abonnés sans consentement. Les afficher ensemble est le seul moyen de lire l'écart.
 */

export interface OccurrenceView {
  id: string;
  seq: number;
  localDate: string | null;
  scheduledAt: string | null;
  status: string;
  holdReason: string | null;
  subject: string;
  frozenAt: string | null;
  enqueuedAt: string | null;
  sentAt: string | null;
  recipientsPlanned: number | null;
  recipientsSent: number | null;
  recipientsFailed: number | null;
  recipientsSkipped: number | null;
  /** L'édition copiée, quand la retenue est un DOUBLON — la seule que « Send it anyway » peut lever. */
  duplicateOf: string | null;
  duplicateAckAt: string | null;
  duplicateAckBy: string | null;
  /** Les articles retenus par les blocs flux de cette échéance. Vide = contenu statique. */
  articles: { url: string; title: string }[];
  /** L'introduction écrite par le modèle au gel. NULL partout = aucun jeton IA dans ce modèle. */
  aiStatus: string | null;
  aiReason: string | null;
  aiIntro: string | null;
  aiPreheader: string | null;
  /** Relecture d'édition (0079) — absents tant que la migration n'est pas appliquée. */
  reviewPending?: boolean;
  reviewError?: string | null;
  reviewed?: boolean;
}

const TONE: Record<string, "grey" | "blue" | "green" | "amber" | "red"> = {
  planned: "grey",
  frozen: "blue",
  sending: "blue",
  sent: "green",
  held: "amber",
  cancelled: "grey",
  failed: "red",
};

/**
 * ⛔ UNE OCCURRENCE « planned » DONT L'HEURE EST PASSÉE N'EST PAS « planned ».
 *
 * Le gel ne rattrape jamais une édition en retard — c'est voulu, on n'envoie pas hier — et le
 * fan-out ne prend que du `frozen`. Une telle ligne est donc DÉFINITIVEMENT perdue : elle ne
 * partira pas, et rien dans son statut ne le dit. L'écran affichait « Date reserved. Content is
 * not frozen yet. », ce qui est faux au mot près : la date n'est plus réservée, et le contenu ne
 * sera jamais gelé. Un état qui ment est pire qu'un état manquant.
 *
 * Il n'existe pas de statut `missed` en base (la contrainte de 0027 fixe les sept valeurs
 * possibles) et en inventer un exigerait une migration pour une information que la DATE porte
 * déjà. On la dérive donc à l'affichage, là où elle se lit.
 */
function estManquee(o: OccurrenceView): boolean {
  if (o.status !== "planned" || !o.scheduledAt) return false;
  const t = new Date(o.scheduledAt).getTime();
  return !Number.isNaN(t) && t < Date.now();
}

/** Ce que chaque état veut dire pour quelqu'un qui n'a pas écrit le matérialiseur. */
const MEANING: Record<string, string> = {
  planned: "Date reserved. Content is not frozen yet.",
  frozen: "Content frozen with the articles of the day. Waiting for its send time.",
  sending: "Recipients are in the send queue.",
  sent: "Delivered to the queue and closed.",
  held: "Held on purpose — nothing went out.",
  cancelled: "Cancelled by a human.",
  failed: "Finished without a single delivery.",
};

export function OccurrenceList({ occurrences, archived = false }: { occurrences: OccurrenceView[]; archived?: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** L'occurrence dont l'annulation attend une confirmation : le geste est irréversible. */
  const [confirmId, setConfirmId] = useState<string | null>(null);
  /** L'édition dont le panneau de relecture est ouvert (une à la fois). */
  const [reviewId, setReviewId] = useState<string | null>(null);

  if (occurrences.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-accent/30 px-4 py-3 text-[12.5px] text-muted-foreground">
        No occurrence yet. They appear once the series is started and the planner has run.
      </div>
    );
  }

  async function ack(id: string) {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/campaigns/occurrences/${id}/duplicate-ack`, { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        // On répète la raison du serveur mot pour mot : « something went wrong » obligerait à
        // ouvrir les journaux pour apprendre ce que la route savait déjà.
        setError(body.error ?? `the server refused (${res.status})`);
        return;
      }
      startTransition(() => router.refresh());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  /**
   * Renoncer à une édition. Le serveur seul décide si l'état le permet : l'écran n'anticipe pas
   * son verdict, il le répète. Un avertissement (articles déjà brûlés) est affiché comme une
   * erreur : il dit une conséquence que l'opérateur doit lire, pas un échec.
   */
  async function cancelOccurrence(id: string) {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/campaigns/occurrences/${id}/cancel`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { error?: string; warning?: string };
      if (!res.ok) {
        setError(body.error ?? `the server refused (${res.status})`);
        return;
      }
      if (body.warning) setError(body.warning);
      setConfirmId(null);
      startTransition(() => router.refresh());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-2">
      {error && (
        <div className="flex items-start gap-2 rounded-[10px] border border-red-200 bg-red-50 px-3.5 py-2.5 text-[12.5px] text-red-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {occurrences.map((o) => {
        const manquee = estManquee(o);
        // Une édition manquée prend le ton d'un échec, parce que c'en est un : rien ne partira.
        const tone = manquee ? "red" : (TONE[o.status] ?? "grey");
        const gap =
          o.recipientsPlanned !== null && o.recipientsSent !== null ? o.recipientsPlanned - o.recipientsSent : null;
        return (
          <div key={o.id} className="rounded-xl border border-border bg-card px-4 py-3">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold tabular-nums">
                <CalendarClock className="h-3.5 w-3.5 text-muted-foreground" strokeWidth={2} />
                {o.localDate ?? "no date"}
              </span>
              <Pill tone={tone} dot>
                {manquee ? "missed" : o.status}
              </Pill>
              {/* ⛔ « changes pending » = le fan-out SAUTE cette édition tant que le worker ne l'a pas
                  reconstruite (même définition, `@nf/edition`). Une édition planifiée relue n'est pas
                  en attente de reconstruction : son écart s'applique au gel. */}
              {o.status === "frozen" && o.reviewPending && <Pill tone="amber">changes pending</Pill>}
              {o.reviewed && !(o.status === "frozen" && o.reviewPending) && <Pill tone="violet">reviewed</Pill>}
              <span className="text-[12.5px] text-muted-foreground">#{o.seq}</span>
              <span className="ml-auto text-[12px] text-muted-foreground">{fmtWhen(o.scheduledAt)}</span>
            </div>

            <p className="mt-1 truncate text-[12.5px] text-foreground/80" title={o.subject}>
              {o.subject.trim() === "" ? "No subject" : o.subject}
            </p>
            <p
              className={
                manquee ? "mt-0.5 text-[11.5px] font-medium text-red-700" : "mt-0.5 text-[11.5px] text-muted-foreground/80"
              }
            >
              {manquee
                ? "Its send time passed while it was still waiting for content. The freeze never runs late, so this edition will not go out. Check that the « plan » cron is running, then cancel this edition to record the decision — the date stays closed either way."
                : (MEANING[o.status] ?? "")}
            </p>

            {(o.recipientsPlanned !== null || o.recipientsSent !== null) && (
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] tabular-nums text-muted-foreground">
                <span>
                  planned <b className="text-foreground">{fmtInt(o.recipientsPlanned)}</b>
                </span>
                <span>
                  sent <b className="text-foreground">{fmtInt(o.recipientsSent)}</b>
                </span>
                {(o.recipientsFailed ?? 0) > 0 && (
                  <span className="text-red-700">
                    failed <b>{fmtInt(o.recipientsFailed)}</b>
                  </span>
                )}
                {(o.recipientsSkipped ?? 0) > 0 && (
                  <span className="text-amber-700" title="Held back by the consent gate — these subscribers never granted this purpose.">
                    skipped by consent <b>{fmtInt(o.recipientsSkipped)}</b>
                  </span>
                )}
                {gap !== null && gap > 0 && o.status === "sent" && (
                  <span>
                    {fmtInt(gap)} fewer than planned — the audience moved between planning and sending
                  </span>
                )}
              </div>
            )}

            {/* ⛔ CE QUI EST RÉELLEMENT PARTI, pas la règle qui l'a choisi. La règle se lit dans le
                modèle ; ici on répond à la seule question qu'on se pose devant une édition passée :
                « qu'est-ce qu'elle contenait ? ». Sans cette liste, une série dynamique n'expose
                qu'une empreinte, et plus personne ne vérifie. */}
            {o.articles.length > 0 && (
              <div className="mt-2 rounded-[10px] border border-border bg-accent/20 px-3 py-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">
                  Picked for this edition
                </p>
                <ol className="mt-1 space-y-0.5">
                  {o.articles.map((a, i) => (
                    <li key={`${a.url}-${i}`} className="flex gap-1.5 text-[12px] text-foreground/85">
                      <span className="tabular-nums text-muted-foreground/70">{i + 1}.</span>
                      <a
                        href={a.url}
                        target="_blank"
                        rel="noreferrer"
                        className="truncate hover:underline"
                        title={a.title}
                      >
                        {a.title}
                      </a>
                    </li>
                  ))}
                </ol>
              </div>
            )}

            {/*
              L'INTRODUCTION ÉCRITE PAR LE MODÈLE — le texte réel, ou la raison de son absence.

              ⛔ L'ÉCHEC DOIT SE VOIR ICI. L'édition part quand même quand la génération rate (un
              service tiers ne doit pas empêcher un envoi), mais avec un blanc à la place de son
              introduction. Sans cette ligne, la seule trace serait le journal du worker : personne
              ne l'apprendrait avant de recevoir l'e-mail.

              ⚠️ `aiStatus` nul n'est PAS un échec : c'est un modèle sans jeton IA, donc aucun
              appel. Les confondre afficherait une alerte sur toutes les séries du compte.
            */}
            {/* ⚠️ Depuis 0079, un humain peut ÉCRIRE l'intro d'une édition dont la génération a raté :
                `ai_intro` rempli malgré `ai_status = failed`. L'alerte ne parle alors plus d'un trou. */}
            {o.aiStatus === "failed" && !o.aiIntro && (
              <div className="mt-2.5 rounded-[10px] border border-amber-200 bg-amber-50 px-3 py-2.5">
                <p className="text-[12.5px] text-amber-900">
                  <b>No AI intro in this edition.</b> It ships without it — the text was never
                  generated: {o.aiReason ?? "no reason recorded"}
                </p>
                <p className="mt-1 text-[11.5px] text-amber-800/80">
                  The rest of the edition is unaffected. Fix the cause and the next occurrence picks
                  it up on its own{o.status === "frozen" ? " — for this one, you can write the intro with « Review edition »" : ""}.
                </p>
              </div>
            )}

            {(o.aiStatus === "ok" || o.reviewed) && (o.aiPreheader || o.aiIntro) && (
              <div className="mt-2 rounded-[10px] border border-border bg-accent/20 px-3 py-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">
                  Written for this edition
                </p>
                {o.aiPreheader && (
                  <p className="mt-1 text-[12px] font-medium text-foreground/85">{o.aiPreheader}</p>
                )}
                {o.aiIntro && <p className="mt-1 text-[12px] text-foreground/75">{o.aiIntro}</p>}
              </div>
            )}

            {o.status === "held" && (
              <div className="mt-2.5 rounded-[10px] border border-amber-200 bg-amber-50 px-3 py-2.5">
                <p className="text-[12.5px] text-amber-900">
                  <b>Nothing went out.</b> {o.holdReason ?? "no reason recorded"}
                </p>
                {/* Le geste n'est proposé QUE pour un doublon : c'est le seul blocage qu'un humain
                    peut lever en décidant. Un segment vide ou une audience hors plafond se corrige
                    ailleurs — offrir le bouton ferait croire qu'il suffit d'insister.
                    ⛔ Lu sur `duplicate_of`, LA condition de la route (`duplicate-ack`) — plus sur le
                    texte : le motif d'un doublon commence par « identical to the edition of », jamais
                    par « duplicate », et le bouton n'apparaissait donc JAMAIS (25/09/2026). */}
                {o.duplicateOf ? (
                  <button
                    type="button"
                    disabled={busyId === o.id || pending}
                    onClick={() => ack(o.id)}
                    className="mt-2 inline-flex items-center gap-1.5 rounded-[8px] bg-amber-700 px-2.5 py-1.5 text-[11.5px] font-semibold text-white disabled:opacity-60"
                  >
                    {busyId === o.id && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    Send it anyway
                  </button>
                ) : (
                  <p className="mt-1 text-[11.5px] text-amber-800/80">
                    This date will not go out: a held edition is never picked up again. Fix the cause before the next
                    edition, and cancel this one to close it.
                  </p>
                )}
                {o.duplicateAckAt && (
                  <p className="mt-1.5 text-[11.5px] text-amber-800/80">
                    Already approved by {o.duplicateAckBy} on {fmtWhen(o.duplicateAckAt)}.
                  </p>
                )}
              </div>
            )}

            {/*
              RELIRE L'ÉDITION (0079) — sujet, preheader, textes du modèle, articles du jour.

              ⛔ UNE RELECTURE QUI NE S'APPLIQUE PAS BLOQUE L'ENVOI (le fan-out saute une édition non
              reconstruite). La raison s'affiche donc ICI, sur la liste, pas seulement dans le panneau :
              c'est ici qu'on regarde avant l'heure d'envoi.
            */}
            {o.status === "frozen" && o.reviewError && (
              <div className="mt-2.5 rounded-[10px] border border-red-200 bg-red-50 px-3 py-2.5 text-[12.5px] text-red-800">
                <b>Reviewed changes not applied.</b> {o.reviewError} — this edition will not be sent until they are fixed or
                undone.
              </div>
            )}
            {reviewId === o.id ? (
              <EditionReview
                occurrenceId={o.id}
                onClose={() => setReviewId(null)}
                onSaved={() => startTransition(() => router.refresh())}
              />
            ) : (
              !archived &&
              ((o.status === "planned" && !manquee) || o.status === "frozen") && (
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setReviewId(o.id);
                  }}
                  className="mt-2 mr-3 inline-flex items-center gap-1.5 rounded-[8px] border border-border px-2.5 py-1 text-[11.5px] font-semibold text-foreground hover:bg-accent"
                >
                  <FilePenLine className="h-3.5 w-3.5" />
                  Review edition
                </button>
              )
            )}

            {/*
              LE GESTE DE RENONCEMENT, offert exactement sur les trois états qui n'ont rien envoyé.
              Il est en retrait — discret, pas caché : c'est une sortie, pas une action courante.
              La confirmation est en deux temps parce que rien ne remet une occurrence annulée en
              `planned` : un clic de trop coûterait une édition.
            */}
            {(o.status === "planned" || o.status === "held" || o.status === "frozen") &&
              (confirmId === o.id ? (
                <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[11.5px]">
                  <span className="text-muted-foreground">
                    Cancel this edition? It cannot be undone, and the date stays closed — the planner will not put
                    another edition on {o.localDate ?? "this day"}.
                  </span>
                  <button
                    type="button"
                    disabled={busyId === o.id || pending}
                    onClick={() => cancelOccurrence(o.id)}
                    className="inline-flex items-center gap-1.5 rounded-[8px] bg-red-700 px-2.5 py-1 font-semibold text-white disabled:opacity-60"
                  >
                    {busyId === o.id && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    Cancel it
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmId(null)}
                    className="rounded-[8px] border border-border px-2.5 py-1 font-medium text-foreground"
                  >
                    Keep it
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setConfirmId(o.id);
                  }}
                  className="mt-2 text-[11.5px] font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
                >
                  Cancel this edition
                </button>
              ))}
          </div>
        );
      })}
    </div>
  );
}
