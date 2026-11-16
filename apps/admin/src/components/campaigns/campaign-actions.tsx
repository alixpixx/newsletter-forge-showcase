"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CalendarClock, CalendarX2, Loader2, Lock, Save, Send, Trash2, Undo2, Unlock } from "lucide-react";
import { cn } from "@/lib/utils";
import { GMAIL_CLIP_BYTES, formatBytes } from "@/components/templates/format";
import { AudienceReadout, useAudience } from "@/components/campaigns/audience-panel";
import { DateTimeField, aujourdHuiDans } from "@/components/date-field";
import { PREHEADER, SubjectTokens } from "@/components/campaigns/subject-tokens";
import { estUneSerie } from "@/components/campaigns/cadence";
import { avisDeRepointage, type AvisDeRepointage } from "@/components/campaigns/repointage";
import {
  LARGE_SEND,
  browserTimeZone,
  fmtInt,
  isoToZonedFields,
  purposeLabel,
  readError,
  readScheduleTimeZone,
  saveScheduleTimeZone,
  timeZoneOptions,
  zoneOffsetLabel,
  zonedToIso,
  derniereVersionParModele,
  type CampaignSummary,
  type PublishedVersion,
  type SegmentOption,
} from "@/components/campaigns/shared";

/**
 * Actions d'une campagne, filtrées par son ÉTAT.
 *
 * Le principe : un bouton qui serait refusé par l'API n'est pas affiché actif — il est désactivé
 * AVEC sa raison. Découvrir en cliquant qu'une campagne verrouillée refuse la modification du
 * sujet est une mauvaise façon d'apprendre une règle de conformité.
 *
 * ⚠️ Ce composant est monté avec `key={campaign.updatedAt}` par la page : après un `router.refresh()`
 * il REDÉMARRE sur l'état fraîchement lu en base, au lieu de conserver un état local devenu faux.
 *
 * ⛔ Aucune de ces actions n'envoie d'email ni n'écrit dans `email_outbox`.
 */

const JSON_HEADERS = { "Content-Type": "application/json" };
/** Préfixe du relais de date entre la déplanification et le remontage du composant. */
const STASH = "nf:unscheduled:";
/**
 * Relais du bilan de repointage entre « Save content » / « Save audience » et le remontage
 * (`key={campaign.updatedAt}` : l'enregistrement change `updated_at`, donc l'état local est perdu).
 * Horodaté : un bilan de plus d'une minute n'est plus celui de ce clic.
 */
const REPOINT = "nf:repointed:";
/*
 * ⭐ Le fuseau de planification est retenu GLOBALEMENT (`readScheduleTimeZone`, `shared.ts`), pas
 * par campagne : quelqu'un qui prépare depuis São Paulo les envois d'une marque chilienne le règle
 * une fois, pas à chaque édition. Le prix de ce choix est qu'un fuseau retenu peut ne plus
 * correspondre au marché de la campagne suivante — c'est pourquoi cet écran ÉCRIT toujours le
 * fuseau utilisé et l'instant UTC qui en découle. Un réglage mémorisé mais invisible serait pire
 * que pas de réglage du tout.
 */
const INPUT =
  "w-full rounded-lg border border-border bg-card px-3 py-2 text-[13.5px] outline-none focus:border-brand";

export function CampaignActions({
  campaign,
  versions,
  segments,
  purposes,
  editionsParties = 0,
  editionsARepointer = null,
}: {
  campaign: CampaignSummary;
  versions: PublishedVersion[];
  segments: SegmentOption[];
  purposes: string[];
  /**
   * Éditions de la série déjà parties, comptées en base par la page. `null` = compte illisible.
   * Sert UNIQUEMENT à dire la vérité avant une suppression — voir `destroy`.
   */
  editionsParties?: number | null;
  /**
   * Éditions `planned` que l'enregistrement d'une nouvelle version déplacerait (même seuil que la
   * route, `seuilDeRepointage`), comptées par la page. `null` = inconnu : l'écran se tait sur le chiffre.
   */
  editionsARepointer?: number | null;
}) {
  const router = useRouter();

  const [subject, setSubject] = useState(campaign.subject);
  /** Le champ sujet : les puces de shortcode inserent a la position du curseur. */
  const subjectRef = useRef<HTMLInputElement>(null);
  // L'insertion d'une puce se fait à la POSITION DU CURSEUR : chaque champ a donc besoin du sien.
  const preheaderRef = useRef<HTMLInputElement>(null);
  const [preheader, setPreheader] = useState(campaign.preheader ?? "");
  /**
   * ⛔ ON CHOISIT UN MODÈLE, PLUS UNE VERSION (décision d’Alix, 18/09/2026). Le modèle est
   * déduit de la version déjà enregistrée ; ce qui part est sa dernière publiée AU MOMENT DE
   * L'ENREGISTREMENT. ⛔ Pas « toujours la dernière » : une publication ultérieure ne change rien tant
   * que la campagne n'est pas réenregistrée (décision d'Alix du 25/09/2026, qui refuse le suivi auto).
   */
  const [templateId, setTemplateId] = useState(
    versions.find((v) => v.versionId === campaign.templateVersionId)?.templateId ?? "",
  );
  const [segmentId, setSegmentId] = useState(campaign.segmentId ?? "");
  const [purpose, setPurpose] = useState(campaign.purpose ?? "");
  const [contactsIgnorePurpose, setContactsIgnorePurpose] = useState(campaign.contactsIgnorePurpose === true);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("10:00");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Le bilan du dernier « Save content » ou « Save audience » : éditions mises à jour, et celles qui
   * gardent l'ancienne version, l'ancien sujet, preheader ou segment.
   */
  const [avis, setAvis] = useState<AvisDeRepointage | null>(null);
  /**
   * Fuseau de planification, date pré-remplie et instant de référence : résolus APRÈS montage.
   *
   * ⛔ Rien de ceci ne peut être calculé au rendu serveur — `localStorage`, `Intl` et `Date.now()`
   * y répondent autrement que dans le navigateur, et l'hydratation casserait. `tz === null` est
   * donc l'état « pas encore su », distinct de « UTC ».
   */
  const [tz, setTz] = useState<string | null>(null);
  const [browserTz, setBrowserTz] = useState<string | null>(null);
  const [mountedAt, setMountedAt] = useState<number | null>(null);

  useEffect(() => {
    const browser = browserTimeZone();
    const chosen = readScheduleTimeZone(browser);
    setBrowserTz(browser);
    setTz(chosen);
    setMountedAt(Date.now());

    // Déplanifier remet `scheduled_at` à null ET remonte ce composant (`key={campaign.updatedAt}`) :
    // sans ce relais, les champs repartiraient vides alors que l'utilisateur vient justement de
    // déplanifier POUR décaler de quelques heures. On repêche la date quittée, une seule fois.
    const stash = campaign.scheduledAt ?? sessionStorage.getItem(`${STASH}${campaign.id}`);
    if (stash && !campaign.scheduledAt) sessionStorage.removeItem(`${STASH}${campaign.id}`);
    if (!stash) return;
    // ⛔ Relu dans le fuseau CHOISI, pas dans celui du navigateur : sinon l'écran afficherait
    // « 10:00 · America/Santiago » pour une campagne réellement planifiée à 11:00 là-bas, et
    // chaque réouverture de la page décalerait l'envoi d'une heure de plus.
    const fields = isoToZonedFields(stash, chosen);
    if (!fields) return;
    setDate(fields.date);
    setTime(fields.time);
  }, [campaign.scheduledAt, campaign.id]);

  // Le bilan du repointage survit au remontage qui suit « Save content » — une seule fois.
  useEffect(() => {
    try {
      const brut = sessionStorage.getItem(`${REPOINT}${campaign.id}`);
      if (!brut) return;
      sessionStorage.removeItem(`${REPOINT}${campaign.id}`);
      const lu = JSON.parse(brut) as { at?: number; avis?: AvisDeRepointage };
      if (lu.avis && typeof lu.at === "number" && Date.now() - lu.at < 60_000) setAvis(lu.avis);
    } catch {
      /* stockage indisponible ou relais illisible : le bilan est perdu, pas la page */
    }
  }, [campaign.id]);

  /** La liste du select : `Intl.supportedValuesOf` n'est lisible qu'après montage. */
  const zones = useMemo(
    () => (browserTz === null ? { common: [], rest: [] } : timeZoneOptions(browserTz)),
    [browserTz],
  );

  const audience = useAudience(campaign.id, segmentId || null, purpose || null, contactsIgnorePurpose);
  const eligible = audience.data?.eligible ?? null;
  const isLarge = eligible !== null && eligible >= LARGE_SEND;
  const typedOk = !isLarge || typed.trim().toUpperCase() === "SCHEDULE";

  const status = campaign.status;
  const locked = campaign.lockedAt !== null;
  const terminal = status === "sending" || status === "sent" || status === "cancelled";
  /**
   * Cette campagne se répète : elle n'a PAS de date d'envoi unique.
   *
   * ⛔ Ce n'est pas une préférence d'affichage, c'est le seul état où le panneau de date ment. Le
   * fan-out ne ramasse une campagne ponctuelle que si `recurrence_days is null`
   * (`apps/worker/src/fanout-db.ts`) : une série datée à la main affichait « Scheduled » sans
   * jamais être scannée, et rien à l'écran ne le disait. La route refuse désormais (409) — l'écran
   * doit refuser AVANT, sinon le bouton n'existe que pour produire une erreur.
   */
  const serie = campaign.recurrenceDays.length > 0;

  const editableContent = status === "draft" && !locked;
  const editableTargeting = status === "draft" || status === "paused";
  const schedulable = status === "draft" || status === "paused";
  const canCancel = status === "draft" || status === "scheduled" || status === "paused";
  const canDelete = status === "draft" || status === "cancelled";

  // ⛔ `tz === null` (avant montage) ne vaut PAS « UTC » : tant que le fuseau n'est pas su, il n'y
  // a pas d'instant, donc pas de planification possible. Le bouton reste désactivé avec sa raison.
  const scheduledIso = tz === null ? null : zonedToIso(date, time, tz);
  const inFuture = scheduledIso !== null && new Date(scheduledIso).getTime() > Date.now();
  /**
   * L'instant qui sert à AFFICHER les décalages — celui visé si connu, sinon celui du montage.
   *
   * ⛔ Il ne peut pas valoir `Date.now()` : évalué à chaque rendu, il différerait entre le serveur
   * et le navigateur et casserait l'hydratation. Le repli `0` (1970, où les règles de fuseau
   * étaient autres) n'est JAMAIS lu : `mountedAt` et `tz` sont posés par le même effet, et rien
   * n'affiche de décalage tant que `tz` est `null`. ⚠️ Séparer ces deux `setState` ferait afficher
   * les décalages de 1970 — silencieusement justes pour la plupart des fuseaux, faux pour le Chili.
   */
  const offsetAt = scheduledIso !== null ? Date.parse(scheduledIso) : (mountedAt ?? 0);

  const modeles = useMemo(() => derniereVersionParModele(versions), [versions]);
  const selected = modeles.find((v) => v.templateId === templateId) ?? null;
  /** Ce qui partira : jamais choisi, toujours déduit — et envoyé tel quel à la route. */
  const versionId = selected?.versionId ?? "";
  const overClip = selected?.sizeBytes != null && selected.sizeBytes > GMAIL_CLIP_BYTES;
  /**
   * La campagne pointe encore une version PLUS ANCIENNE que la dernière publiée.
   *
   * ⛔ LE DIRE, PAS LE FAIRE EN SILENCE. « Save content » va la déplacer : un contenu qui change
   * sous une campagne sans que l’écran l’annonce est exactement le défaut qu’on corrige ailleurs.
   * ⚠️ Comparé À MODÈLE ÉGAL : après un changement de modèle, l’ancien numéro ne veut plus rien
   * dire, et l’afficher ferait lire « v7 → v2 » comme une régression.
   */
  const ancienne = versions.find((v) => v.versionId === campaign.templateVersionId) ?? null;
  const versionPerimee =
    ancienne !== null
    && selected !== null
    && ancienne.templateId === selected.templateId
    && ancienne.versionId !== selected.versionId;

  /**
   * Prérequis de l'envoi, évalués ici pour les MONTRER au lieu de les faire découvrir.
   *
   * ⛔ « content is not locked » N'Y EST PLUS : le bouton gèle lui-même avant de dater. L'y laisser
   * afficherait comme un manque ce que le geste fait — et grisserait le bouton qui doit le réparer.
   * ⛔ Le segment n'y figure pas non plus : sans lui, la campagne vise toute la marque, ce que la
   * route accepte. Un blocage affiché que le serveur n'applique pas envoie chercher une panne
   * inexistante.
   * ⚠️ Une date VIDE et une date PASSÉE ne se disent pas de la même façon : le même message pour
   * les deux faisait relire une date correcte que l'utilisateur n'avait simplement pas saisie.
   */
  const missing: string[] = [];
  if (!campaign.purpose) missing.push("no purpose saved");
  if (campaign.subject.trim() === "") missing.push("subject is empty");
  // L'envoi immédiat n'a pas de date à choisir : seuls les manques ci-dessus le bloquent.
  const missingNow = [...missing];
  if (date.trim() === "" || time.trim() === "") missing.push("no send date picked");
  else if (!inFuture) missing.push("the date is in the past");

  /* ------------------------------------------------------------------ Appels */

  async function call(
    key: string,
    url: string,
    init: RequestInit,
    onOk?: (body: unknown) => void,
  ): Promise<void> {
    if (busy) return;
    setBusy(key);
    setError(null);
    try {
      const res = await fetch(url, init);
      if (!res.ok) {
        setError(await readError(res));
        setBusy(null);
        return;
      }
      const body = (await res.json().catch(() => null)) as unknown;
      onOk?.(body);
      setBusy(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setBusy(null);
    }
  }

  /**
   * Lit le bilan de repointage de la réponse et le garde pour le remontage.
   * ⛔ Un 207 est `res.ok` : sans cette lecture, « campagne enregistrée, éditions non mises à jour » se
   * lirait comme un succès complet. ⛔ Les DEUX boutons d'enregistrement en ont besoin : le segment
   * (« Save audience ») repointe les éditions à venir au même titre que le sujet ou la version.
   */
  const noterAvis = (versionEnregistree: number | null) => (body: unknown) => {
    const a = avisDeRepointage(body, versionEnregistree);
    setAvis(a);
    if (!a) return;
    try {
      sessionStorage.setItem(`${REPOINT}${campaign.id}`, JSON.stringify({ at: Date.now(), avis: a }));
    } catch {
      /* stockage indisponible : le bilan reste affiché tant que le composant n'est pas remonté */
    }
  };

  const saveContent = () =>
    call(
      "content",
      `/api/campaigns/${campaign.id}`,
      {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          subject: subject.trim(),
          preheader: preheader.trim(),
          templateVersionId: versionId || null,
        }),
      },
      // Le numéro AU MOMENT du clic : c'est lui que la route vient d'enregistrer.
      noterAvis(selected?.version ?? null),
    );

  const saveTargeting = () =>
    call(
      "targeting",
      `/api/campaigns/${campaign.id}`,
      {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify({ segmentId: segmentId || null, purpose: purpose || null, contactsIgnorePurpose }),
      },
      // Pas de version dans ce corps : le bilan ne peut nommer que le segment.
      noterAvis(null),
    );

  /**
   * Déverrouiller : rendre le contenu à l'édition.
   *
   * ⛔ CE GESTE MANQUAIT, ET L'ÉCRAN LE PROMETTAIT DÉJÀ (« Unlocking and locking again re-runs the
   * generation »). Sans lui, un verrou posé par erreur était définitif : il fallait annuler la
   * campagne, la supprimer et tout ressaisir. Le dialogue de confirmation dit ce qu'on perd — le
   * rendu figé et le texte écrit par le modèle — parce que reverrouiller les régénère depuis le
   * contenu du moment, qui n'est pas forcément celui qu'on avait relu.
   */
  const unlock = () => {
    if (
      !window.confirm(
        "Unlock the content? The frozen email and the AI intro are discarded. Locking again rebuilds them from the template as it is then.",
      )
    ) {
      return;
    }
    return call("unlock", `/api/campaigns/${campaign.id}/unlock`, { method: "POST" });
  };

  /**
   * ⭐ LE GESTE UNIQUE : figer puis dater, dans le même clic.
   *
   * ⛔ LE VERROU EST UNE ÉTAPE, PAS UNE INTENTION. Il existe pour qu'une republication du modèle ne
   * réécrive pas un envoi déjà approuvé — une garantie, pas une décision d'utilisateur. Exposé en
   * bouton séparé, il obligeait à franchir ses refus (poids, shortcodes, jetons de série) AVANT
   * même d'avoir choisi une date, et laissait derrière lui un état « verrouillé mais pas planifié »
   * dont personne ne savait sortir, faute de déverrouillage.
   *
   * ⛔ SI LE VERROU REFUSE, ON NE PLANIFIE PAS. Enchaîner quand même écrirait une date sur une
   * campagne sans contenu figé — exactement ce que `/schedule` refuse, mais découvert un écran plus
   * loin. L'erreur du verrou est celle qu'on affiche : c'est elle qui dit quoi corriger.
   */
  async function scheduleSend(now = false): Promise<void> {
    if ((!now && !scheduledIso) || busy) return;
    if (!locked) {
      setBusy("lock");
      setError(null);
      try {
        const res = await fetch(`/api/campaigns/${campaign.id}/lock`, { method: "POST" });
        if (!res.ok) {
          setError(await readError(res));
          setBusy(null);
          return;
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Network error");
        setBusy(null);
        return;
      }
      setBusy(null);
    }
    // ⛔ « Maintenant » se DEMANDE, il ne se calcule pas ici : l'horloge du navigateur n'est pas
    // celle du serveur. La route date l'envoi immédiat elle-même (`resolveSendWhen`).
    await call(now ? "send-now" : "schedule", `/api/campaigns/${campaign.id}/schedule`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(now ? { sendNow: true } : { scheduledAt: scheduledIso }),
    });
  }

  /**
   * Déplanifier : changer d'avis sur le QUAND sans rien perdre. Pas de `window.confirm` — le verrou,
   * le HTML gelé et l'id survivent, donc l'action est réversible d'un clic sur « Schedule ». Garder
   * le dialogue pour `cancel` et `delete`, qui eux ne se rejouent pas.
   */
  const unschedule = () => {
    if (campaign.scheduledAt) sessionStorage.setItem(`${STASH}${campaign.id}`, campaign.scheduledAt);
    return call("unschedule", `/api/campaigns/${campaign.id}/unschedule`, { method: "POST" });
  };

  const cancel = () => {
    if (!window.confirm(`Cancel "${campaign.name}"? The scheduled date is kept as a record of what was planned.`))
      return;
    return call("cancel", `/api/campaigns/${campaign.id}/cancel`, { method: "POST" });
  };

  /*
   * ⛔ LA CONFIRMATION AFFIRMAIT « Nothing was ever sent from it » SUR UNE SÉRIE DONT DES ÉDITIONS
   * ÉTAIENT PARTIES. Une série reste `draft` : elle passe la garde de la route, et la suppression
   * emporte ses éditions (`on delete cascade`). La phrase dit donc ce qui disparaît, chiffre compris ;
   * quand le compte est illisible, elle le dit au lieu de promettre zéro.
   */
  const destroy = () => {
    const parties = serie ? editionsParties : 0;
    const bilan =
      parties === null
        ? "If editions of this series were already sent, their record is deleted with it."
        : parties > 0
          ? `${parties} edition${parties > 1 ? "s" : ""} of this series ${parties > 1 ? "were" : "was"} already sent — ${
              parties > 1 ? "their" : "its"
            } record (date, content, counts) is deleted with it. The emails already delivered stay in the inboxes.`
          : "Nothing was ever sent from it.";
    if (!window.confirm(`Delete "${campaign.name}"? This cannot be undone. ${bilan}`)) return;
    return call("delete", `/api/campaigns/${campaign.id}`, { method: "DELETE" }, () => {
      router.push("/campaigns");
    });
  };

  /* ------------------------------------------------------------------ Rendu */

  return (
    <div className="space-y-4">
      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-[12.5px] text-red-700">
          {error}
        </p>
      )}
      {avis && (
        <p
          className={cn(
            "rounded-lg border px-3.5 py-2.5 text-[12.5px]",
            avis.ton === "warn"
              ? "border-amber-200 bg-amber-50 text-amber-800"
              : "border-border bg-accent/50 text-foreground/80",
          )}
        >
          {avis.texte}
        </p>
      )}

      {/* ---------------------------------------------------------- Contenu */}
      <Panel
        title="Content"
        sub={
          locked
            ? "Locked — what goes out to subscribers must not change under their feet."
            : "Subject, preheader and the template version that will be sent — the one saved here. Publishing the template again changes nothing until you save this campaign."
        }
        icon={locked ? <Lock className="h-4 w-4 text-muted-foreground" strokeWidth={2} /> : undefined}
      >
        {editableContent ? (
          <>
            <label className="mb-1 block text-[11.5px] font-semibold text-foreground/80">Subject</label>
            <input
              ref={subjectRef}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              maxLength={200}
              className={INPUT}
            />
            <SubjectTokens
              inputRef={subjectRef}
              value={subject}
              onChange={setSubject}
              connu={{ campaign_name: campaign.name }}
              serie={estUneSerie(campaign)}
            />

            <label className="mb-1 mt-3 block text-[11.5px] font-semibold text-foreground/80">Preheader</label>
            <input
              ref={preheaderRef}
              value={preheader}
              onChange={(e) => setPreheader(e.target.value)}
              maxLength={200}
              className={INPUT}
            />
            {/*
              ⭐ LA LIGNE D'APERÇU A SES PROPRES PUCES (demande d'Alix, 18/09/2026). Elle n'avait
              RIEN : ni puces, ni aperçu, ni alerte sur un shortcode inconnu — alors que c'est le même
              moteur d'hydratation qui la traite, et donc les mêmes pièges. Un jeton hors registre y
              était retiré en silence, exactement comme dans le sujet.

              ⛔ ET CE N'EST PAS LA MÊME LISTE : `PREHEADER` met `{{ai_preheader}}` en tête (c'est son
              champ naturel) et en retire `campaign_name`, un libellé interne qui gaspillerait la
              seule phrase que le lecteur voit avant d'ouvrir.
            */}
            <SubjectTokens
              inputRef={preheaderRef}
              value={preheader}
              onChange={setPreheader}
              jetons={PREHEADER}
              serie={estUneSerie(campaign)}
              apercuLabel="Preview line"
            />

            <label className="mb-1 mt-3 block text-[11.5px] font-semibold text-foreground/80">
              Template
            </label>
            {modeles.length === 0 ? (
              <p className="text-[12.5px] text-amber-700">
                No published version in this brand — publish one from the builder first.
              </p>
            ) : (
              <>
                <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} className={INPUT}>
                  <option value="">Select a template…</option>
                  {modeles.map((v) => (
                    <option key={v.templateId} value={v.templateId}>
                      {v.etiquette}
                    </option>
                  ))}
                </select>
                {/* La version ne se choisit plus, mais elle part quand même : elle doit rester LISIBLE. */}
                {selected && (
                  <div className="mt-1 text-[11.5px] text-muted-foreground">
                    Version v{selected.version} · {formatBytes(selected.sizeBytes)} — the latest published
                    version today. A later publish is not picked up on its own: open this campaign and save it
                    again{serie ? " (its upcoming editions move with it)" : ""}.
                  </div>
                )}
                {versionPerimee && (
                  <p className="mt-1 text-[11.5px] text-amber-700">
                    This campaign still points at v{ancienne?.version}. Saving moves it to v{selected?.version} —
                    the latest published version
                    {serie && typeof editionsARepointer === "number" && editionsARepointer > 0
                      ? ` — and its ${editionsARepointer} upcoming ${editionsARepointer === 1 ? "edition" : "editions"}`
                      : ""}
                    .
                  </p>
                )}
              </>
            )}

            {overClip && (
              <p className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
                {formatBytes(selected?.sizeBytes)} — above the {formatBytes(GMAIL_CLIP_BYTES)} Gmail
                clipping threshold. Gmail would cut the legal footer and its unsubscribe link; locking
                will be refused.
              </p>
            )}

            <div className="mt-3">
              <Action onClick={saveContent} busy={busy === "content"} icon={<Save className="h-[14px] w-[14px]" />}>
                Save content
              </Action>
            </div>
          </>
        ) : (
          <p className="text-[12.5px] text-muted-foreground">
            {locked
              ? "The subject, preheader and version are frozen. Targeting can still be adjusted below until the campaign is scheduled."
              : `A ${status} campaign can no longer be edited.`}
          </p>
        )}
      </Panel>

      {/* ---------------------------------------------------------- Ciblage */}
      <Panel title="Audience" sub="Who this campaign targets, and who the consent gate will let through.">
        {editableTargeting ? (
          <>
            <label className="mb-1 block text-[11.5px] font-semibold text-foreground/80">Segment</label>
            {/* Le sélecteur reste affiché même sans segment enregistré : « pas de ciblage » est un
                choix valide, et le masquer priverait d'un moyen de REVENIR à ce choix. Son libellé
                dit l'effet, pas l'absence — « rien de sélectionné » se lit comme un oubli. */}
            <select value={segmentId} onChange={(e) => setSegmentId(e.target.value)} className={INPUT}>
              <option value="">No segment — the whole brand</option>
              {segments.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            {segments.length === 0 && (
              <p className="mt-1 text-[11.5px] text-muted-foreground">
                No segment saved for this brand yet — the campaign targets everyone who granted the
                purpose below.
              </p>
            )}

            <label className="mb-1 mt-3 block text-[11.5px] font-semibold text-foreground/80">Purpose</label>
            <select value={purpose} onChange={(e) => setPurpose(e.target.value)} className={INPUT}>
              <option value="">No purpose selected</option>
              {purposes.map((p) => (
                <option key={p} value={p}>
                  {purposeLabel(p)}
                </option>
              ))}
            </select>

            <div className="mt-3">
              <AudienceReadout
                state={audience}
                contactsControl={{ checked: contactsIgnorePurpose, onChange: setContactsIgnorePurpose }}
              />
            </div>

            <div className="mt-3">
              <Action
                onClick={saveTargeting}
                busy={busy === "targeting"}
                icon={<Save className="h-[14px] w-[14px]" />}
              >
                Save audience
              </Action>
            </div>
          </>
        ) : (
          <>
            <p className="mb-3 text-[12.5px] text-muted-foreground">
              {status === "scheduled"
                ? "Targeting is frozen while the campaign is scheduled — unschedule it to change segment or purpose."
                : `A ${status} campaign can no longer be retargeted.`}
            </p>
            <AudienceReadout state={audience} />
          </>
        )}
      </Panel>

      {/* -------------------------------------------- Série : pas de date unique */}
      {!terminal && serie && (
        <Panel title="Schedule" sub="This campaign repeats — its dates come from the cadence, not from one date.">
          <p className="max-w-[74ch] text-[12.5px] text-muted-foreground">
            Editions are planned by the <b>Series</b> block above: each one gets its own date, its
            own content and its own number. Use <b>Stop series</b> there to stop sending, or remove the
            cadence to go back to a single send.
          </p>
          <p className="mt-2 max-w-[74ch] text-[11.5px] text-muted-foreground/80">
            A single send date is not offered here on purpose: the send worker only scans one-off
            campaigns, so a date set on a repeating campaign would read as “Scheduled” and never
            leave.
          </p>
        </Panel>
      )}

      {/* ------------------------------------------------------ Verrou / date */}
      {!terminal && !serie && (
        <Panel title="Schedule" sub="Pick a date, or send now — the content is frozen at the same moment.">
          {/*
            ⭐ UN SEUL GESTE, décision d'Alix du 18/09/2026 (« a quoi sert exactemnt le lock &
            schedule »). Verrouiller n'a jamais été une intention : personne ne veut « figer un
            email » pour lui-même. C'était une ÉTAPE TECHNIQUE — copier le HTML publié dans la
            campagne pour qu'une republication du modèle ne réécrive pas un envoi approuvé — promue
            au rang de bouton, avec son propre mur (poids, shortcodes) découvert avant même d'avoir
            choisi une date. Le verrou reste, comme conséquence et comme ÉTAT affiché ; il n'est
            plus un geste.

            ⛔ Ce qui apparaît ici quand le contenu est déjà figé n'est donc pas « Lock », c'est la
            sortie : déverrouiller. Elle manquait, et trois textes la promettaient déjà.
          */}
          {locked && (
            <div className="mb-3 flex flex-wrap items-center gap-2.5">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-accent px-2.5 py-[3px] text-[11.5px] font-semibold text-muted-foreground">
                <Lock className="h-3 w-3" strokeWidth={2.4} /> Content frozen
              </span>
              <span className="max-w-[46ch] text-[11.5px] text-muted-foreground">
                Republishing the template will not change what this campaign sends.
              </span>
              {(status === "draft" || status === "paused") && (
                <Action onClick={unlock} busy={busy === "unlock"} icon={<Unlock className="h-[14px] w-[14px]" />}>
                  Unlock to edit
                </Action>
              )}
            </div>
          )}

          {/*
            ⛔ `items-start`, PAS `items-end`. Les deux champs portent leur libellé au-dessus, donc
            c'est le HAUT qui doit s'aligner. Avec `items-end`, ouvrir le calendrier — qui s'ouvre
            dans le flux et fait grandir sa colonne de ~300 px — précipitait le sélecteur de fuseau
            tout en bas, à côté de la dernière ligne du calendrier, loin de son propre libellé resté
            en place. Le champ semblait sauter à chaque ouverture.
          */}
          <div className="flex flex-wrap items-start gap-2">
            {/*
              ⭐ UN SEUL CHAMP DATE + HEURE, demande d'Alix du 18/09/2026 : « j'aimerai que dans
              schedule tu me remplace date et time par un date picker ca sera plus simple ». Les
              deux `<input type="date">` / `type="time"` natifs affichaient « jj/mm/aaaa » et
              exigeaient de taper la date à l'aveugle.

              ⛔ `min` est calculé DANS LE FUSEAU CHOISI, pas celui du navigateur : préparer depuis
              Paris un envoi chilien est le cas normal, et un plancher pris à Paris interdirait une
              date encore valable au Chili.
            */}
            <div className="w-[240px]">
              <label className="mb-1 block text-[11.5px] font-semibold text-foreground/80">Send date</label>
              <DateTimeField
                value={date}
                onChange={setDate}
                time={time}
                onTimeChange={setTime}
                min={aujourdHuiDans(tz)}
                disabled={!schedulable}
                placeholder="Pick a date"
              />
            </div>
            <div>
              <label className="mb-1 block text-[11.5px] font-semibold text-foreground/80">
                Timezone
              </label>
              <select
                value={tz ?? ""}
                disabled={!schedulable || tz === null}
                onChange={(e) => {
                  setTz(e.target.value);
                  saveScheduleTimeZone(e.target.value);
                }}
                className={cn(INPUT, "w-[250px]", (!schedulable || tz === null) && "opacity-50")}
              >
                {tz === null ? (
                  <option value="">Reading your timezone…</option>
                ) : (
                  <>
                    <optgroup label="Where this brand publishes">
                      {zones.common.map((zone) => (
                        <option key={zone} value={zone}>
                          {zone} · {zoneOffsetLabel(zone, offsetAt)}
                        </option>
                      ))}
                    </optgroup>
                    {zones.rest.length > 0 && (
                      <optgroup label="All timezones">
                        {zones.rest.map((zone) => (
                          <option key={zone} value={zone}>
                            {zone}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </>
                )}
              </select>
            </div>
          </div>
          {/*
            ⛔ Cette phrase est la moitié utile du réglage. Un fuseau choisi mais non relu à l'écran
            se retourne contre son utilisateur : il est retenu d'une campagne à l'autre, et rien ne
            dirait qu'il ne correspond plus au marché visé. On écrit donc TOUJOURS l'instant UTC
            résolu, et on signale l'écart avec le navigateur — sans le traiter comme une faute,
            puisque préparer depuis São Paulo un envoi chilien est précisément le cas normal.
          */}
          <p className="mt-1.5 text-[11.5px] text-muted-foreground">
            {tz && scheduledIso
              ? `${time} in ${tz} (${zoneOffsetLabel(tz, offsetAt)}) is ${scheduledIso
                  .replace("T", " ")
                  .slice(0, 16)} UTC.`
              : tz
                ? `Times are read in ${tz}.`
                : ""}
            {tz && browserTz && tz !== browserTz ? ` Your browser is in ${browserTz}.` : ""}
          </p>

          {isLarge && schedulable && (
            <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3.5 py-3">
              <div className="mb-1.5 flex items-center gap-2 text-[12.5px] font-semibold text-amber-800">
                <AlertTriangle className="h-4 w-4" /> {fmtInt(eligible)} recipients — type SCHEDULE to
                continue
              </div>
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder="SCHEDULE"
                className="w-full rounded-lg border border-amber-300 bg-white px-3 py-2 text-[13.5px] uppercase tracking-widest outline-none"
              />
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2.5">
            <Action
              onClick={() => scheduleSend()}
              busy={busy === "schedule" || busy === "lock"}
              disabled={!schedulable || missing.length > 0 || !typedOk}
              title={
                !schedulable
                  ? status === "scheduled"
                    ? "Already scheduled — unschedule it to pick another date"
                    : `A ${status} campaign cannot be scheduled`
                  : missing.length > 0
                    ? `Missing: ${missing.join(", ")}`
                    : !typedOk
                      ? "Type SCHEDULE to confirm a large audience"
                      : undefined
              }
              primary
              icon={<CalendarClock className="h-[14px] w-[14px]" />}
            >
              {locked ? "Schedule" : "Lock & schedule"}
            </Action>
            {/* ⭐ L'envoi immédiat (demande d'Alix du 22/09/2026). Il ne saute aucune garde : mêmes
                refus que « Schedule », moins la date — et la confirmation d'une grosse audience. */}
            <Action
              onClick={() => scheduleSend(true)}
              busy={busy === "send-now"}
              disabled={!schedulable || missingNow.length > 0 || !typedOk}
              title={
                !schedulable
                  ? status === "scheduled"
                    ? "Already scheduled — unschedule it first"
                    : `A ${status} campaign cannot be sent`
                  : missingNow.length > 0
                    ? `Missing: ${missingNow.join(", ")}`
                    : !typedOk
                      ? "Type SCHEDULE to confirm a large audience"
                      : "Due now — it starts leaving within seconds"
              }
              icon={<Send className="h-[14px] w-[14px]" />}
            >
              {locked ? "Send now" : "Lock & send now"}
            </Action>
            {status === "scheduled" && (
              <Action
                onClick={unschedule}
                busy={busy === "unschedule"}
                icon={<CalendarX2 className="h-[14px] w-[14px]" />}
              >
                Unschedule
              </Action>
            )}
            {schedulable && missing.length > 0 && (
              <span className="text-[11.5px] text-amber-700">Missing: {missing.join(", ")}.</span>
            )}
          </div>

          {/*
            ⚠️ CE TEXTE A MENTI jusqu'au 18/09/2026 : il affirmait que rien ne partirait « until
            campaign sending is wired », alors que le fan-out (S-6) et la réconciliation (S-7)
            existent et que l'envoi ne dépend plus que du mode du worker. Un texte visible en
            production qui décrit un état révolu est plus coûteux qu'un texte absent : il éteint la
            question au lieu de l'ouvrir.
          */}
          <p className="mt-3 text-[11.5px] text-muted-foreground/80">
            Scheduling freezes the content, records the date and the planned recipient count. The send
            worker picks the campaign up at that date — nothing is queued before then. Send now makes it
            due immediately: it starts leaving within seconds.
          </p>
        </Panel>
      )}

      {/* ------------------------------------------------------------ Sortie */}
      <Panel title="Give up on this send" sub="Cancelling keeps the record; deleting removes a campaign that never sent.">
        <div className="flex flex-wrap items-center gap-2.5">
          <Action
            onClick={cancel}
            busy={busy === "cancel"}
            disabled={!canCancel}
            title={
              status === "cancelled"
                ? "Already cancelled"
                : status === "sent"
                  ? "A sent campaign is already in subscribers inboxes"
                  : status === "sending"
                    ? "A campaign that is sending cannot be cancelled from here"
                    : undefined
            }
            icon={<Undo2 className="h-[14px] w-[14px]" />}
          >
            Cancel campaign
          </Action>
          <Action
            onClick={destroy}
            busy={busy === "delete"}
            disabled={!canDelete}
            title={
              status === "scheduled"
                ? "Unschedule or cancel it before deleting"
                : !canDelete
                  ? "A sent campaign is the record of what subscribers received"
                  : undefined
            }
            icon={<Trash2 className="h-[14px] w-[14px]" />}
          >
            Delete
          </Action>
        </div>
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------------ Primitives */

function Panel({
  title,
  sub,
  icon,
  children,
}: {
  title: string;
  sub?: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[14px] border border-border bg-card p-[18px]">
      <div className="mb-3 flex items-start gap-2">
        {icon}
        <div>
          <h3 className="text-[13.5px] font-semibold">{title}</h3>
          {sub && <p className="text-[12px] text-muted-foreground">{sub}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

/** Exporté : le panneau de série s'en sert, et deux définitions du même bouton divergent toujours. */
export function Action({
  onClick,
  busy,
  disabled,
  title,
  primary,
  icon,
  children,
}: {
  onClick: () => void | Promise<void>;
  busy?: boolean;
  disabled?: boolean;
  title?: string;
  primary?: boolean;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  const off = disabled || busy;
  return (
    <button
      onClick={onClick}
      disabled={off}
      title={title}
      className={cn(
        "inline-flex items-center gap-2 rounded-[9px] px-3.5 py-2 text-[13px] font-medium transition-colors",
        primary
          ? "bg-brand text-brand-foreground shadow-[0_1px_3px_rgba(255,54,141,0.35)] hover:bg-[#ec2079]"
          : "border border-border bg-card hover:bg-accent",
        off && "cursor-not-allowed opacity-50",
      )}
    >
      {busy ? <Loader2 className="h-[14px] w-[14px] animate-spin" /> : icon}
      {children}
    </button>
  );
}
