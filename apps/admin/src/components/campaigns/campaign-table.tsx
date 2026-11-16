import Link from "next/link";
import { ChevronRight, Lock, Repeat, Send } from "lucide-react";
import { Pill, Th, Td } from "@/components/ui";
import { formatBytes, formatDateTime } from "@/components/templates/format";
import { estUneSerie, etatDeLaSerie } from "@/components/campaigns/cadence";
import type { EcheanceSerie } from "@/lib/data/occurrences";
import { avantArchivage, planDeReactivation } from "@/lib/campaign-archive";
import { ArchiveButton, ReactivateButton } from "@/components/campaigns/archive-controls";
import {
  etatDUnePonctuelle,
  fmtInt,
  pastilleDeCampagne,
  type CampaignSummary,
  type EtatPonctuelle,
} from "@/components/campaigns/shared";

/**
 * Liste des campagnes RÉELLES de la marque. Présentationnel : aucune donnée n'est fabriquée ici,
 * tout vient de `listCampaigns()`.
 *
 * ⛔ CETTE LISTE NE DISAIT PAS CE QU'ELLE MONTRAIT. Signalé par Alix le 18/09/2026 : rien ne
 * distinguait une SÉRIE d'un ENVOI UNIQUE, ni une série qui tourne d'une cadence seulement
 * enregistrée, et la colonne de date affichait `sentAt ?? scheduledAt` pour tout le monde. Or pour
 * une série, `campaign.scheduled_at` n'est pas la vérité : les dates vivent dans
 * `campaign_occurrence`. Une série y affichait donc soit « — », soit une date de plan qui ne
 * correspondait à aucun envoi. Les trois faits manquants sont désormais lus, pas devinés.
 */
export function CampaignTable({
  rows,
  segmentNames,
  echeances,
  onglet = "active",
}: {
  rows: CampaignSummary[];
  /**
   * L'onglet affiché (0077). « archived » remplace la colonne « Next / sent » par ce que l'archivage
   * a fait, et le bouton Archive par Reactivate / Restore : une campagne rangée n'a pas de prochain
   * envoi, et lui en afficher un le promettrait.
   */
  onglet?: "active" | "archived";
  /** id de segment → nom, résolu par la page. Un id absent = segment supprimé depuis. */
  segmentNames: Record<string, string>;
  /**
   * id de campagne → ce que la série a devant elle, résolu par la page (`echeancesDesSeries`).
   * Absent = aucune occurrence matérialisée du tout, ce qui est un fait, pas un trou — et un fait
   * qui ne veut PAS dire la même chose selon que la série est allumée ou non.
   */
  echeances: Record<string, EcheanceSerie>;
}) {
  // Un seul instant pour toute la table : deux lignes de la même liste ne doivent pas être jugées à
  // deux secondes d'écart, sinon deux campagnes prévues à la même heure peuvent ne pas dire la même
  // chose.
  const maintenantIso = new Date().toISOString();
  const maintenantMs = Date.parse(maintenantIso);
  const archives = onglet === "archived";
  return (
    <div className="overflow-x-auto rounded-[14px] border border-border bg-card">
      <table className="w-full min-w-[820px] border-collapse text-[13px]">
        <thead>
          <tr className="bg-[#fcfcfe]">
            <Th>Campaign</Th>
            <Th>Status</Th>
            <Th>Segment</Th>
            <Th>Recipients planned</Th>
            <Th>{archives ? "Archived" : "Next / sent"}</Th>
            <Th>Size</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const serie = estUneSerie(c);
            const etat = etatDeLaSerie(c);
            // « Running » / « Stopped » À LA PLACE de « Draft » : une série reste `draft` en base pour
            // toujours, et « Draft » au-dessus d'une série qui envoie se lisait « rien n'est lancé ».
            // « Archived » pour une campagne rangée, série ou non — la règle vit dans `shared.ts`,
            // partagée avec la page de campagne.
            const pastille = pastilleDeCampagne(c);
            /*
             * ⛔ DEUX SOURCES DE DATE, PARCE QUE CE SONT DEUX CHOSES. Une campagne ponctuelle porte
             * sa date sur elle ; une série ne la porte PAS — ses dates sont les occurrences que le
             * planificateur a matérialisées. Lire `scheduledAt` sur une série afficherait un plan
             * qui ne correspond à aucun envoi.
             */
            const ponctuelle = serie ? null : etatDUnePonctuelle(c, maintenantIso);
            return (
              <tr key={c.id} className="group transition-colors hover:bg-brand-soft/40">
                <Td className="font-semibold">
                  <Link href={`/campaigns/${c.id}`} className="hover:text-brand">
                    {c.name}
                  </Link>
                  <div className="mt-0.5 max-w-[38ch] truncate text-[11.5px] font-normal text-muted-foreground">
                    {c.subject.trim() === "" ? "No subject yet" : c.subject}
                  </div>
                </Td>
                <Td>
                  <span className="inline-flex items-center gap-1.5">
                    <Pill tone={pastille.ton} dot>
                      {pastille.libelle}
                    </Pill>
                    {c.lockedAt && (
                      <Lock
                        className="h-3.5 w-3.5 text-muted-foreground"
                        strokeWidth={2}
                        aria-label="Content locked"
                      />
                    )}
                  </span>
                  {/*
                    ⛔ LA PASTILLE DIT L'ÉTAT, CETTE LIGNE DIT LA NATURE. « Series on / off » faisait
                    doublon avec une pastille « Draft » qui disait l'inverse ; l'état d'une série vit
                    désormais dans la pastille ci-dessus (« Running » / « Stopped », les mots de
                    `etatDeLaSerie`, partagés avec le panneau de série et la page de campagne).

                    ⛔ Et une ponctuelle le DIT, au lieu de n'afficher rien : une case vide se lit
                    « l'information manque », pas « il n'y a pas de cadence ».
                  */}
                  <span className="mt-1 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                    {serie ? (
                      <>
                        <Repeat className="h-3 w-3 shrink-0" strokeWidth={2} aria-hidden="true" />
                        Series
                      </>
                    ) : (
                      "One-off"
                    )}
                  </span>
                </Td>
                <Td className="text-muted-foreground">
                  {c.segmentId ? (segmentNames[c.segmentId] ?? "Segment removed") : "—"}
                </Td>
                <Td className="tabular-nums font-semibold">{fmtInt(c.recipientsPlanned)}</Td>
                {archives ? (
                  <Td className="text-muted-foreground">
                    <span className="whitespace-nowrap">Archived on {formatDateTime(c.archivedAt)}</span>
                    <div className="mt-0.5 max-w-[34ch] text-[11.5px] leading-snug">
                      {avantArchivage(c, formatDateTime)}
                    </div>
                  </Td>
                ) : (
                  <Td className="whitespace-nowrap text-muted-foreground">
                    {ponctuelle ? (
                      <EtatDUnEnvoiUnique etat={ponctuelle} />
                    ) : (
                      <EtatDeLaProchaine arme={etat.arme} echeance={echeances[c.id] ?? null} />
                    )}
                  </Td>
                )}
                <Td className="whitespace-nowrap tabular-nums text-muted-foreground">
                  {formatBytes(c.sizeBytes)}
                </Td>
                <Td>
                  <span className="inline-flex items-center gap-2">
                    {/* Des props RÉDUITES à ce que le bouton lit : la ligne entière partirait sinon dans
                        la charge du navigateur, une fois par campagne. */}
                    {archives ? (
                      <ReactivateButton
                        compact
                        campaign={{ id: c.id, name: c.name, timezone: c.timezone }}
                        plan={planDeReactivation(c, maintenantMs)}
                      />
                    ) : (
                      <ArchiveButton
                        compact
                        campaign={{
                          id: c.id,
                          name: c.name,
                          status: c.status,
                          recurrenceDays: c.recurrenceDays,
                          recurrenceActive: c.recurrenceActive,
                          scheduledAt: c.scheduledAt,
                          timezone: c.timezone,
                        }}
                      />
                    )}
                    <Link
                      href={`/campaigns/${c.id}`}
                      aria-label={`Open ${c.name}`}
                      className="inline-flex text-muted-foreground/50 group-hover:text-brand"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Link>
                  </span>
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** État de DÉPART de chaque marque : il doit expliquer quoi faire, pas seulement constater le vide. */
/**
 * L'écran d'une marque qui n'a encore aucune campagne.
 *
 * ⛔ IL NE PORTE PAS DE BOUTON. Il en recevait un en `children`, identique à celui de l'en-tête :
 * deux boutons « New campaign » à l'écran et deux assistants montés, alors qu'un seul geste existe.
 * Il renvoie vers le bouton de l'en-tête — au même endroit que sur tous les autres écrans, et au
 * même endroit une fois la première campagne créée.
 */
export function CampaignEmptyState({ brand }: { brand: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2.5 rounded-[14px] border border-dashed border-border bg-accent/30 px-6 py-14 text-center">
      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-soft">
        <Send className="h-5 w-5 text-brand" strokeWidth={1.9} />
      </div>
      <div className="text-[14px] font-semibold">No campaigns for {brand} yet</div>
      <p className="max-w-[56ch] text-[12.5px] leading-relaxed text-muted-foreground">
        A campaign points a published template version at a segment. It can go out once on a date you
        pick, or repeat on a weekly cadence. Use <b>New campaign</b> at the top of this page to
        create the first one.
      </p>
    </div>
  );
}

/**
 * Ce que la colonne « Next / sent » dit d'un ENVOI UNIQUE.
 *
 * ⛔ ELLE AFFICHAIT UNE DATE EN GRIS, ET RIEN D'AUTRE. « C'est parti », « ça va partir » et
 * « l'heure est passée et rien n'est parti » produisaient exactement le même pixel. Le troisième est
 * une panne, et c'est précisément celui qu'Alix a eu sous les yeux le 18/09/2026 sans qu'aucun écran
 * ne le lui dise.
 *
 * ⚠️ « Not queued » NE DEVINE PAS LA CAUSE — le worker peut être à l'arrêt, hors mode d'envoi, ou
 * sans planificateur, et la liste n'a pas de quoi trancher entre les trois. Elle dit le fait, et
 * renvoie à la fiche, qui porte la raison quand le worker en a écrit une.
 */
function EtatDUnEnvoiUnique({ etat }: { etat: EtatPonctuelle }) {
  if (etat.quoi === "rien") return <>—</>;
  if (etat.quoi === "bloque") {
    return (
      <span className="inline-flex flex-col">
        <span className="text-amber-700">{formatDateTime(etat.quand)}</span>
        <span
          className="text-[11px] font-semibold text-amber-700"
          title="The scheduled time has passed and not one recipient ever entered the send queue. Open the campaign for details."
        >
          Not queued
        </span>
      </span>
    );
  }
  return <>{formatDateTime(etat.quand)}</>;
}

/**
 * Ce que la colonne « Next / sent » dit d'une SÉRIE.
 *
 * ⛔ IL Y AVAIT UNE SEULE PHRASE POUR CINQ ÉTATS. « Nothing planned » s'affichait aussi bien sur une
 * série éteinte que sur une série allumée dont les éditions sont RETENUES ou EN RETARD — c'est-à-dire
 * aussi bien sur un état normal que sur une panne muette. Le commentaire qui vivait ici affirmait
 * « le pill à gauche dit lequel des deux » : c'était faux dès que le pill disait « Series on », et
 * c'est exactement le cas qu'Alix a signalé le 18/09/2026.
 *
 * ⚠️ AUCUN DE CES TEXTES NE DEVINE. Chacun nomme un fait lu en base (`classerEcheances`) ou un
 * booléen de la campagne — jamais une cause supposée. « No edition created yet » ne dit pas
 * pourquoi : le matérialiseur peut n'être pas encore passé, ou ne pas tourner du tout, et l'écran
 * n'a pas de quoi trancher. Il dit ce qu'il voit, et ce qu'il voit suffit à aller chercher.
 */
function EtatDeLaProchaine({ arme, echeance }: { arme: boolean; echeance: EcheanceSerie | null }) {
  if (echeance?.prochaine) {
    return (
      <span className="inline-flex flex-col">
        <span>{formatDateTime(echeance.prochaine)}</span>
        {echeance.retenues > 0 && (
          <span className="text-[11px] text-red-600" title="Held editions will not go out at their date.">
            {echeance.retenues} held
          </span>
        )}
      </span>
    );
  }
  if (echeance && echeance.retenues > 0) {
    return (
      <span
        className="text-[11.5px] text-red-600"
        title="The planner created these editions then held them back — open the campaign to see why."
      >
        {echeance.retenues} edition{echeance.retenues > 1 ? "s" : ""} held
      </span>
    );
  }
  if (echeance?.enRetard) {
    return (
      <span
        className="text-[11.5px] text-amber-700"
        title="This edition was due and has still not been sent. The send worker may not be running."
      >
        Overdue since {formatDateTime(echeance.enRetard)}
      </span>
    );
  }
  if (!arme) {
    return (
      <span
        className="text-[11.5px] italic"
        title="The series is stopped, so nothing is planned and nothing is sent. Open the campaign and click Start series."
      >
        Stopped — nothing planned
      </span>
    );
  }
  return (
    <span
      className="text-[11.5px] italic text-amber-700"
      title="The series is running, but no edition exists yet. The planner creates them on its own pass; if none appears, the planner is not running."
    >
      No edition created yet
    </span>
  );
}
