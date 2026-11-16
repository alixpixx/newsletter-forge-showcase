import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, Archive, ArrowLeft, Lock } from "lucide-react";
import { estUneSerie } from "@/components/campaigns/cadence";
import { ArchiveButton, ReactivateButton } from "@/components/campaigns/archive-controls";
import { avantArchivage, planDeReactivation } from "@/lib/campaign-archive";
import { Pill } from "@/components/ui";
import { getCurrentAsset } from "@/lib/asset-context";
import {
  CAMPAIGN_PURPOSES,
  dernierIncidentDeCampagne,
  getCampaign,
  seuilDeRepointage,
  type CampaignIncident,
  type CampaignRow,
} from "@/lib/data/campaigns";
import {
  compterBlocsClassables,
  describeSegment,
  describeVersion,
  listPublishedVersions,
  listSegmentOptions,
} from "@/components/campaigns/campaign-data";
import { MixLatestToggle } from "@/components/campaigns/mix-latest-toggle";
import { SeriesPanel } from "@/components/campaigns/series-panel";
import { listEditions } from "@/lib/data/wp-sources";
import { CampaignActions } from "@/components/campaigns/campaign-actions";
import { OccurrenceList } from "@/components/campaigns/occurrence-list";
import { classerEcheances, compterEditionsParties, listOccurrences } from "@/lib/data/occurrences";
import { getDb } from "@/lib/supabase";
import { formatBytes, formatDateTime } from "@/components/templates/format";
import { etatDUnePonctuelle, fmtInt, pastilleDeCampagne, purposeLabel } from "@/components/campaigns/shared";

// Chaque action (verrou, planification, annulation) change l'état lu ici : jamais de cache.
export const dynamic = "force-dynamic";

export default async function CampaignDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const asset = await getCurrentAsset();

  if (!asset.id) {
    return (
      <div className="animate-fade-up">
        <BackLink />
        <div className="flex items-start gap-2.5 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>Database unavailable — the brand could not be resolved, so this campaign cannot be read.</span>
        </div>
      </div>
    );
  }

  // Une campagne d'une AUTRE marque doit être indiscernable d'une campagne inexistante → 404.
  const campaign = await getCampaign(id, asset.id);
  if (!campaign) notFound();

  const db = getDb();
  const [versions, segments, versionLabel, segment, occurrences, blocsClassables, editions, incident, editionsParties] =
    await Promise.all([
    listPublishedVersions(asset.id),
    listSegmentOptions(asset.id),
    describeVersion(campaign.templateVersionId, asset.id),
    describeSegment(campaign.segmentId, asset.id),
    db ? listOccurrences(db, id, asset.id) : Promise.resolve([]),
    // ⛔ Ce que la case de mélange a RÉELLEMENT à commander. Sans ce compte, un interrupteur qui ne
    // touche aucun bloc reste muet, et on cherche la panne ailleurs.
    compterBlocsClassables(campaign.templateVersionId, asset.id),
    listEditions(asset.id),
    /*
     * ⭐ POURQUOI LE WORKER N'A PAS FAIT PARTIR CETTE CAMPAGNE. Pour une campagne PONCTUELLE, cette
     * ligne d'audit est la SEULE source : `campaign` n'a pas de colonne `hold_reason` — l'occurrence
     * d'une série, si. C'est ce qui rendait la même panne lisible sur une série et parfaitement
     * muette sur un envoi unique.
     */
    db ? dernierIncidentDeCampagne(db, id, asset.id) : Promise.resolve(null),
    // Éditions déjà parties : « Resume series » plutôt que « Start », et une suppression qui dit ce
    // qu'elle emporte. Compté en base — la liste ci-dessus s'arrête à 40 lignes.
    db && estUneSerie(campaign) ? compterEditionsParties(db, id, asset.id) : Promise.resolve(0),
  ]);

  /*
   * ⛔ « DRAFT » N'EST PAS LE STATUT D'UNE SÉRIE. Elle reste `draft` en base pour toujours — ce sont
   * ses éditions qui se figent et partent — et la pastille disait donc « Draft » au-dessus d'une série
   * qui envoie chaque semaine. Elle dit maintenant « Running » ou « Stopped » (`statutDeSerie`, le
   * même mot que la liste et le panneau) — et « Archived » pour une campagne rangée (0077), par la
   * MÊME fonction que la liste (`pastilleDeCampagne`).
   */
  const { libelle: statut, ton } = pastilleDeCampagne(campaign);
  const archivee = Boolean(campaign.archivedAt);
  /** La prochaine édition qui partira vraiment — la même règle que la colonne « Next » de la liste. */
  const prochaineEdition =
    classerEcheances(
      occurrences.map((o) => ({ campaign_id: id, scheduled_at: o.scheduledAt, status: o.status })),
      new Date().toISOString(),
    ).get(id)?.prochaine ?? null;

  /*
   * Combien d'éditions un enregistrement sur une nouvelle version DÉPLACERAIT — le même seuil que la
   * route (`seuilDeRepointage` : délai de gel de la campagne + une période du cron). Compté sur la liste
   * lue ci-dessus : elle s'arrête à 40 lignes par `seq` décroissant, et les éditions à venir portent
   * les `seq` les plus hauts (horizon de 21 jours, au plus une par jour local) — elles y sont toutes.
   */
  const seuilRepointage = seuilDeRepointage(new Date(), campaign.freezeLeadMinutes).getTime();
  const editionsARepointer = db
    ? occurrences.filter(
        (o) => o.status === "planned" && o.scheduledAt !== null && Date.parse(o.scheduledAt) > seuilRepointage,
      ).length
    : null;

  /*
   * Fuseau de l'édition, pour pré-remplir la cadence d'une série — PAS celui du navigateur : une
   * newsletter chilienne réglée depuis Paris partirait avec cinq heures d'écart, et rien à l'écran
   * ne le dirait. `null` quand l'édition n'en déclare pas : on ne devine pas à sa place.
   */
  const editionTimezone = editions.find((e) => e.timezone)?.timezone ?? null;

  const facts: { label: string; value: string }[] = [
    { label: "Status", value: statut },
    {
      label: "Version",
      value: versionLabel ? `${versionLabel.templateName} · v${versionLabel.version}` : "—",
    },
    { label: "Segment", value: segment?.name ?? (campaign.segmentId ? "Segment removed" : "—") },
    { label: "Purpose", value: campaign.purpose ? purposeLabel(campaign.purpose) : "—" },
    { label: "Recipients planned", value: fmtInt(campaign.recipientsPlanned) },
    { label: "Email size", value: formatBytes(campaign.sizeBytes) },
    { label: "Locked at", value: formatDateTime(campaign.lockedAt) },
    { label: "Scheduled for", value: formatDateTime(campaign.scheduledAt) },
    /*
     * ⭐ LE FAIT QUI TRANCHE, ET IL MANQUAIT. Les dix faits affichés ici venaient TOUS du plan : ce
     * qu'on avait demandé, jamais ce qui s'était produit. « Queued at » est posé par le worker au
     * moment où il remplit la file d'envoi. Vide + une date planifiée passée = la mise en file n'a
     * jamais eu lieu, la cause est EN AMONT de l'envoi. Rempli + zéro envoyé = la file s'est remplie
     * et c'est l'envoi qui n'a pas suivi. Deux pannes différentes, deux endroits différents où
     * chercher, et rien ne les distinguait.
     */
    { label: "Queued at", value: formatDateTime(campaign.enqueuedAt) },
    { label: "Sent at", value: formatDateTime(campaign.sentAt) },
    { label: "Last updated", value: formatDateTime(campaign.updatedAt) },
  ];

  /*
   * ⛔ LES TROIS COMPTEURS N'APPARAISSENT QUE QUAND ILS EXISTENT. Ils sont écrits par la
   * réconciliation, APRÈS un envoi ; `null` ne veut pas dire « zéro », il veut dire « la
   * réconciliation n'est jamais passée ». Trois cases à « 0 » sur une campagne en brouillon
   * annonceraient un envoi raté qui n'a jamais été tenté.
   */
  if (
    campaign.recipientsSent !== null ||
    campaign.recipientsFailed !== null ||
    campaign.recipientsSkipped !== null
  ) {
    facts.push(
      { label: "Sent", value: fmtInt(campaign.recipientsSent) },
      { label: "Failed", value: fmtInt(campaign.recipientsFailed) },
      // « Skipped » porte les refus du gate d'envoi — consentement, suppression, liste blanche. Il
      // est le seul chiffre qui explique un « 1 prévu, 0 envoyé » sans une seule erreur nulle part.
      { label: "Skipped", value: fmtInt(campaign.recipientsSkipped) },
    );
  }

  return (
    <div className="animate-fade-up">
      <BackLink />

      <div className="mb-5">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-[22px] font-bold tracking-tight">{campaign.name}</h1>
          <Pill tone={ton} dot>
            {statut}
          </Pill>
          {campaign.lockedAt && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-accent px-2.5 py-[3px] text-[11.5px] font-semibold text-muted-foreground">
              <Lock className="h-3 w-3" strokeWidth={2.4} /> Content locked
            </span>
          )}
          {!archivee && (
            <span className="ml-auto">
              <ArchiveButton
                campaign={{
                  id: campaign.id,
                  name: campaign.name,
                  status: campaign.status,
                  recurrenceDays: campaign.recurrenceDays,
                  recurrenceActive: campaign.recurrenceActive,
                  scheduledAt: campaign.scheduledAt,
                  timezone: campaign.timezone,
                }}
              />
            </span>
          )}
        </div>
        <p className="mt-1 text-[13px] text-muted-foreground">
          {campaign.subject.trim() === "" ? "No subject yet" : campaign.subject}
        </p>
        {campaign.preheader && campaign.preheader.trim() !== "" && (
          <p className="mt-0.5 text-[12px] text-muted-foreground/70">{campaign.preheader}</p>
        )}
      </div>

      {/*
        ⭐ UNE CAMPAGNE ARCHIVÉE LE DIT EN PREMIER, avec ce qu'elle faisait et le seul geste qui lui
        reste. ⛔ Les panneaux d'action (série, envoi, mélange) sont MASQUÉS tant qu'elle est rangée :
        `/arm` et `/schedule` la refusent, et un bouton qu'on voit mais que la route refuse enseigne à
        ne plus croire les boutons. Supprimer passe aussi par Restore d'abord.
      */}
      {archivee ? (
        <div className="mb-5 flex flex-wrap items-start gap-3 rounded-[10px] border border-border bg-accent/50 px-4 py-3">
          <Archive className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-muted-foreground">
            <b className="text-foreground">Archived on {formatDateTime(campaign.archivedAt)}.</b>{" "}
            {avantArchivage(campaign, formatDateTime)} Nothing is sent while it is archived.
          </div>
          <ReactivateButton
            campaign={{ id: campaign.id, name: campaign.name, timezone: campaign.timezone }}
            plan={planDeReactivation(campaign, Date.now())}
          />
        </div>
      ) : (
        <EtatDeLEnvoi campaign={campaign} incident={incident} maintenantIso={new Date().toISOString()} />
      )}

      {campaign.lockedAt && (
        <div className="mb-5 flex items-start gap-2.5 rounded-[10px] border border-border bg-accent/50 px-4 py-3 text-[12.5px] text-muted-foreground">
          <Lock className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2} />
          <span>
            The rendered email was frozen on {formatDateTime(campaign.lockedAt)}. Subject, preheader and
            version can no longer change: what goes out to subscribers must not change under their feet.
            Republishing the template does not affect this campaign.
          </span>
        </div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {facts.map((f) => (
          <div key={f.label} className="rounded-xl border border-border bg-card p-3.5">
            <div className="text-[11.5px] font-medium text-muted-foreground">{f.label}</div>
            <div className="mt-0.5 truncate text-[14px] font-semibold" title={f.value}>
              {f.value}
            </div>
          </div>
        ))}
      </div>

      {/*
        ⭐ LA CADENCE, RELUE. Elle était écrite par `/api/campaigns/[id]/recurrence` depuis les
        migrations 0027/0067 et affichée par PERSONNE : une série enregistrée avec succès
        n'existait nulle part à l'écran — « quand je crée une repeating stories rien ne se
        sauvegarde » (18/09/2026).

        ⛔ ET LA DISTINCTION QUI COMPTE : ENREGISTRÉE ≠ EN MARCHE. Seul `/arm` (« Start series »)
        pose `recurrence_active`, et le planificateur ne lit que les séries en marche. Une cadence
        sauvée mais jamais démarrée ne crée aucune occurrence : l'écran dit « Stopped », sinon il
        promet des envois qui ne partiront pas.
      */}
      {!archivee && (
        <SeriesPanel
          key={campaign.updatedAt}
          campaign={{
            id: campaign.id,
            status: campaign.status,
            lockedAt: campaign.lockedAt,
            recurrenceDays: campaign.recurrenceDays,
            recurrenceTime: campaign.recurrenceTime,
            recurrenceEveryWeeks: campaign.recurrenceEveryWeeks,
            recurrenceUntil: campaign.recurrenceUntil,
            recurrenceActive: campaign.recurrenceActive,
            timezone: campaign.timezone,
            freezeLeadMinutes: campaign.freezeLeadMinutes,
            editionStart: campaign.editionStart,
          }}
          editionTimezone={editionTimezone}
          prochaineEdition={prochaineEdition}
          editionsParties={editionsParties}
        />
      )}

      {/*
        `key` = updatedAt : après un router.refresh(), le composant repart de l'état réellement en
        base au lieu de garder une saisie locale devenue fausse (ex. sujet figé par un verrou).
      */}
      {!archivee && (
        <CampaignActions
          key={campaign.updatedAt}
          campaign={campaign}
          versions={versions}
          segments={segments}
          purposes={[...CAMPAIGN_PURPOSES]}
          editionsParties={editionsParties}
          editionsARepointer={editionsARepointer}
        />
      )}

      {/*
        ⭐ L'INTERRUPTEUR DE MÉLANGE VIT DANS LA CAMPAGNE, pas dans le modèle : un modèle sert
        plusieurs campagnes (« Friday NL TW » et « Resumo da rodada » partagent la version
        509c87c3), et le mélange doit pouvoir être armé sur l'une sans l'être sur l'autre.
      */}
      {!archivee && (
        <MixLatestToggle
          key={campaign.updatedAt}
          campaignId={campaign.id}
          initial={campaign.mixLatest}
          blocs={blocsClassables}
          locked={Boolean(campaign.lockedAt)}
        />
      )}

      {/*
        L'INTRODUCTION ÉCRITE PAR LE MODÈLE, pour une campagne PONCTUELLE (elle naît au
        verrouillage). Une série a la sienne par occurrence, affichée dans la liste plus bas.

        ⛔ L'ÉCHEC DOIT SE VOIR. La campagne se verrouille même quand la génération rate — un
        service tiers ne doit pas empêcher d'arrêter un contenu — mais elle partira avec un blanc à
        la place de son introduction. Sans ce bloc, la seule trace serait une colonne en base.
        ⚠️ `aiStatus` nul = aucun jeton IA dans le contenu, donc aucun appel : ce n'est pas un échec
        et rien ne doit s'afficher.
      */}
      {campaign.aiStatus === "failed" && (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-[12.5px] text-amber-900">
            <b>No AI intro in this campaign.</b> It ships without it — the text was never generated:{" "}
            {campaign.aiReason ?? "no reason recorded"}
          </p>
          <p className="mt-1 text-[11.5px] text-amber-800/80">
            The rest of the content is unaffected. Unlocking and locking again re-runs the
            generation.
          </p>
        </div>
      )}

      {campaign.aiStatus === "ok" && (campaign.aiPreheader || campaign.aiIntro) && (
        <div className="mt-4 rounded-xl border border-border bg-accent/20 px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">
            Written for this campaign
          </p>
          {campaign.aiPreheader && (
            <p className="mt-1 text-[12.5px] font-medium text-foreground/85">{campaign.aiPreheader}</p>
          )}
          {campaign.aiIntro && <p className="mt-1 text-[12.5px] text-foreground/75">{campaign.aiIntro}</p>}
        </div>
      )}

      {/*
        La liste des occurrences n'apparaît que pour une SÉRIE. Sur une campagne à date unique elle
        serait vide en permanence, et une section vide se lit comme une fonction cassée.
      */}
      {occurrences.length > 0 && (
        <div className="mt-7">
          <h2 className="mb-2.5 text-[15px] font-bold tracking-tight">Occurrences</h2>
          <p className="mb-3 max-w-[74ch] text-[12.5px] text-muted-foreground">
            Each occurrence carries its own frozen content — the articles of that day, not the ones
            from the first week. A held occurrence stops the series until someone acts on it.
          </p>
          <OccurrenceList occurrences={occurrences} archived={archivee} />
        </div>
      )}

      {/*
        ⚠️ CE TEXTE A MENTI. Il affirmait « campaign sending is not wired » ; depuis le fan-out (S-6)
        et la réconciliation (S-7), la mise en file existe et l'envoi ne dépend plus que du mode du
        worker. Un texte visible en production qui décrit un état révolu est plus coûteux qu'un
        texte absent : il éteint la question au lieu de l'ouvrir.
        ⚠️ ET IL A MENTI UNE SECONDE FOIS : les événements (remises, rebonds, plaintes, ouvertures,
        clics) sont collectés depuis 0041, et depuis 0085 (24/09/2026) ils sont lus par campagne sur
        Analytics. On y renvoie, au lieu d'annoncer un rapport « pas encore » disponible.
      */}
      <p className="mt-4 max-w-[74ch] text-[12px] text-muted-foreground/80">
        The counters above come from the send queue itself — they say what was queued, sent, failed or
        skipped. What happened next (delivered, bounced, marked as spam, opened, clicked) is on{" "}
        <Link href={`/analytics/campaigns/${id}`} className="font-medium text-brand hover:underline">
          this campaign&apos;s analytics
        </Link>
        .
      </p>
    </div>
  );
}

/**
 * ⭐ CE QUI S'EST PASSÉ APRÈS LA PLANIFICATION — ou ce qui ne s'est PAS passé.
 *
 * ⛔ LE DÉFAUT QU'IL FERME (18/09/2026). « J'ai fait une campagne one shot et rien ne s'est
 * envoyé. » La campagne annonçait « Scheduled », un cadenas, 1 destinataire, une date passée depuis
 * quinze minutes — exactement ce qu'elle aurait annoncé quinze minutes AVANT. L'écran n'avait aucun
 * moyen de dire la différence entre « ça va partir » et « ça ne partira jamais », parce qu'il ne
 * lisait que le plan, jamais la file d'envoi.
 *
 * ⛔ AUCUN DE CES QUATRE ÉTATS NE DEVINE UNE CAUSE. Chacun nomme un fait lu en base et dit où
 * regarder. La différence est décisive : l'écran ne peut pas savoir si le worker est arrêté, en
 * `dry-run`, ou sans cron — et une phrase qui affirmerait l'un des trois enverrait chercher au
 * mauvais endroit deux fois sur trois. [[une-seule-phrase-pour-plusieurs-etats]]
 *
 * ⚠️ UNE SÉRIE EST EXCLUE, et ce n'est pas un oubli : `campaign.scheduled_at` n'est pas sa vérité —
 * ses dates vivent dans `campaign_occurrence`, et la liste des occurrences plus bas les dit déjà,
 * chacune avec son propre état. Juger une série sur la date de son modèle afficherait une alerte
 * permanente sur une série qui tourne très bien.
 */
function EtatDeLEnvoi({
  campaign,
  incident,
  maintenantIso,
}: {
  campaign: CampaignRow;
  incident: CampaignIncident | null;
  /** Injecté par l'appelant : le composant reste pur, et le banc peut choisir l'instant. */
  maintenantIso: string;
}) {
  if (estUneSerie(campaign)) return null;

  /*
   * ⭐⛔ LA MÊME FONCTION QUE LA LISTE, ET C'EST TOUT L'INTÉRÊT. « L'heure est passée et rien n'est
   * en file » est une règle qui porte un délai de grâce et une comparaison d'INSTANTS (jamais de
   * chaînes ISO : PostgREST rend `+00:00` là où `toISOString()` rend `.000Z`). Deux copies de cette
   * règle, c'est deux écrans du même produit qui finissent par s'affirmer le contraire à la même
   * seconde — le défaut exact qu'on vient de corriger ailleurs. Une seule définition, testée une
   * fois.
   */
  const etat = etatDUnePonctuelle(campaign, maintenantIso);

  // 1. LE WORKER A LAISSÉ UNE RAISON. C'est le seul état qui explique, parce que c'est le seul où
  //    quelqu'un a écrit pourquoi. Il passe avant tout le reste.
  if (incident) {
    const arretee = incident.action === "campaign-held";
    return (
      <Bandeau
        ton="rouge"
        titre={arretee ? "The send worker stopped this campaign." : "Queueing failed for this campaign."}
      >
        <>
          Reason recorded on {formatDateTime(incident.at)}: <b>{incident.reason}</b>.{" "}
          {arretee
            ? "It will not go out on its own. Fix the cause, then schedule it again — the worker does not retry a stopped campaign."
            : "It was handed back and will be retried on the next pass. If this keeps repeating, the retry is a loop and the cause needs fixing."}
        </>
      </Bandeau>
    );
  }

  // 2. LA DATE EST PASSÉE ET RIEN N'EST ENTRÉ EN FILE. Le cas d'Alix, mot pour mot.
  if (etat.quoi === "bloque") {
    return (
      <Bandeau ton="ambre" titre="The scheduled time has passed and nothing was queued.">
        <>
          Not a single recipient entered the send queue, so nothing went out and nothing is about to.
          The campaign itself is complete — this stops between scheduling and sending. Check that the
          worker that fills the queue is running and in live mode; it is a separate service from the
          one that sends.
        </>
      </Bandeau>
    );
  }

  // 3. LA FILE S'EST REMPLIE, MAIS RIEN N'EST PARTI. La panne a changé d'endroit : c'est l'envoi.
  if (campaign.enqueuedAt && campaign.recipientsSent === 0) {
    const ecartes = campaign.recipientsSkipped ?? 0;
    return (
      <Bandeau ton="ambre" titre="The queue was filled, but nothing was sent.">
        <>
          Queued on {formatDateTime(campaign.enqueuedAt)}, and not one message went out
          {ecartes > 0 ? (
            <>
              {" "}
              — {fmtInt(campaign.recipientsSkipped)} recipient{ecartes > 1 ? "s were" : " was"} skipped
              by the send gate. That is consent, suppression or the sending allowlist, not
              deliverability
            </>
          ) : null}
          . <Link href="/deliverability" className="font-semibold underline underline-offset-2">Deliverability</Link>{" "}
          lists the exact reason per queued message.
        </>
      </Bandeau>
    );
  }

  // 4. RIEN À SIGNALER. ⛔ Et on le dit en n'affichant RIEN : un bandeau « tout va bien » permanent
  //    est le meilleur moyen de rendre invisible celui qui compte.
  return null;
}

/** L'enveloppe commune des états ci-dessus — une seule forme, pour qu'on les lise au même endroit. */
function Bandeau({
  ton,
  titre,
  children,
}: {
  ton: "rouge" | "ambre";
  titre: string;
  children: ReactNode;
}) {
  const couleurs =
    ton === "rouge"
      ? "border-red-200 bg-red-50 text-red-900"
      : "border-amber-200 bg-amber-50 text-amber-900";
  return (
    <div className={`mb-5 flex items-start gap-2.5 rounded-[10px] border px-4 py-3 ${couleurs}`}>
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="text-[12.5px] leading-relaxed">
        <b>{titre}</b> <span className="opacity-90">{children}</span>
      </div>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/campaigns"
      className="mb-3 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="h-4 w-4" /> Campaigns
    </Link>
  );
}
