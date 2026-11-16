"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CalendarClock,
  Check,
  Loader2,
  Lock,
  Play,
  Snowflake,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { GMAIL_CLIP_BYTES, formatBytes } from "@/components/templates/format";
import { AudienceReadout, useAudience } from "@/components/campaigns/audience-panel";
import {
  RecurrencePicker,
  cadenceIncomplete,
  chargerApercu,
  type OccurrencePreview,
  type Recurrence,
} from "@/components/campaigns/recurrence-picker";
import { phraseCadence, quandDansLeFuseau } from "@/components/campaigns/cadence";
import { DateTimeField, aujourdHuiDans } from "@/components/date-field";
import { ModalPortal } from "@/components/modal-portal";
import { PREHEADER, SubjectTokens } from "@/components/campaigns/subject-tokens";
import {
  LARGE_SEND,
  browserTimeZone,
  fmtInt,
  purposeLabel,
  readError,
  readScheduleTimeZone,
  saveScheduleTimeZone,
  timeZoneOptions,
  zoneOffsetLabel,
  zonedToIso,
  derniereVersionParModele,
  type PublishedVersion,
  type SegmentOption,
} from "@/components/campaigns/shared";

/**
 * Assistant de campagne — contenu → audience → programmation → récapitulatif.
 *
 * Chaque étape ÉCRIT en base via `/api/campaigns/*` avant de passer à la suivante : la campagne
 * existe dès la fin de l'étape 1, ce qui est la condition pour compter une audience (la route
 * `/audience` compte pour UNE campagne donnée). Conséquence assumée et annoncée à l'écran :
 * fermer l'assistant en cours de route laisse un BROUILLON, pas rien.
 *
 * ⛔ Ce que l'assistant ne fait pas, et ne prétend pas faire : mettre en file d'envoi. La dernière
 * action verrouille puis PLANIFIE un envoi unique — ou DÉMARRE une série (« Start series »). Aucune
 * ligne n'entre dans `email_outbox` depuis ici : c'est le worker qui met en file, à l'heure dite.
 *
 * ⛔ UNE SÉRIE SE TERMINE PAR UN SEUL GESTE, ET C'EST LE BOUTON PRINCIPAL (Alix, 22/09/2026 :
 * « j'ai tjr dans ma creation de campagne le truc a la fin "arms" … c'est tjr pas comprehensible
 * a quoi ca sert si il y a besoin ou pas »). Avant, le bouton principal disait « Done — cadence
 * saved » et fermait l'assistant ; démarrer la série était un petit bouton ambre à côté, qu'on
 * pouvait ne jamais voir. Mesuré en production : une campagne « Test » avec sa cadence enregistrée,
 * jamais démarrée, qui n'enverra jamais rien — et personne ne savait pourquoi.
 */

type Step = 0 | 1 | 2 | 3;

/**
 * Ce que la dernière action a RÉELLEMENT produit, lu dans la réponse de l'API — jamais supposé.
 * Deux formes, parce qu'un envoi unique a UNE date et qu'une série a une première édition.
 */
type Fin =
  | { quoi: "ponctuelle"; scheduledAt: string; recipientsPlanned: number | null; sendNow: boolean }
  | {
      quoi: "serie";
      /** La première édition qui partira vraiment (dates annulées exclues, côté route). */
      premiere: string | null;
      /** Éditions dans l'horizon. `null` = la route n'a pas su le relire — pas zéro. */
      aVenir: number | null;
      horizonJours: number;
    };
const STEP_LABELS = ["Content", "Audience", "Schedule", "Review"];

/**
 * La cadence en une phrase — CELLE de la page de campagne (`phraseCadence`), plus sa fin. Deux
 * écrans qui décrivent la même série avec deux tournures obligent à vérifier qu'ils disent la même
 * chose ; l'assistant avait la sienne (« Mon, Fri at 10:00 … starts at edition 1 »).
 */
function phraseDeLaSerie(r: Recurrence): string {
  const base = phraseCadence({
    recurrenceDays: r.days,
    recurrenceTime: r.time,
    recurrenceEveryWeeks: r.everyWeeks,
    recurrenceUntil: r.until || null,
    recurrenceActive: false,
    timezone: r.timezone,
    freezeLeadMinutes: r.freezeLeadMinutes,
    editionStart: r.editionStart,
  });
  return `${base}${r.until ? `, until ${r.until}` : ", no end date"}`;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

const INPUT =
  "w-full rounded-lg border border-border bg-card px-3 py-2 text-[13.5px] outline-none focus:border-brand";

export interface CampaignWizardProps {
  open: boolean;
  onClose: () => void;
  /** Versions PUBLIÉES de la marque. Un brouillon n'a pas de HTML figé : il n'est pas proposable. */
  versions: PublishedVersion[];
  segments: SegmentOption[];
  /** Finalités acceptées par l'API (`CAMPAIGN_PURPOSES`), passées en props pour rester alignées. */
  purposes: string[];
  /**
   * Fuseau de l'édition de la marque. Pré-remplit la cadence — et sert de repère quand l'opérateur
   * en choisit un autre. `null` = l'édition n'en déclare pas ; on ne devine pas à sa place.
   */
  editionTimezone?: string | null;
}

export function CampaignWizard({
  open,
  onClose,
  versions,
  segments,
  purposes,
  editionTimezone = null,
}: CampaignWizardProps) {
  const router = useRouter();

  const [step, setStep] = useState<Step>(0);
  /** Id de la campagne réellement créée en base. `null` tant que l'étape 1 n'a pas été validée. */
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [versionId, setVersionId] = useState("");
  const [subject, setSubject] = useState("");
  const [preheader, setPreheader] = useState("");
  const [segmentId, setSegmentId] = useState("");
  const [purpose, setPurpose] = useState("");
  /** La case « contacts sans finalité » (0088) — décochée par défaut, montrée seulement pour des contacts. */
  const [contactsIgnorePurpose, setContactsIgnorePurpose] = useState(false);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("10:00");
  /** Fuseau de planification — résolu après montage, comme dans « Lock and schedule ». */
  const [tz, setTz] = useState<string | null>(null);
  const [browserTz, setBrowserTz] = useState<string | null>(null);
  const [mountedAt, setMountedAt] = useState<number | null>(null);

  useEffect(() => {
    const browser = browserTimeZone();
    setBrowserTz(browser);
    setTz(readScheduleTimeZone(browser));
    setMountedAt(Date.now());
  }, []);

  const zones = useMemo(
    () => (browserTz === null ? { common: [], rest: [] } : timeZoneOptions(browserTz)),
    [browserTz],
  );
  /**
   * Mode d'envoi. « once » reste le DÉFAUT : la récurrence et l'envoi immédiat sont des capacités
   * nouvelles, pas un changement de comportement pour qui ouvrait déjà cet assistant hier.
   * « now » (22/09/2026) : la campagne est due dès la confirmation, datée par le SERVEUR.
   */
  const [mode, setMode] = useState<"now" | "once" | "series">("once");
  const [recurrence, setRecurrence] = useState<Recurrence>(() => ({
    days: [],
    time: "10:00",
    // Le fuseau de l'édition, jamais celui du navigateur : voir `RecurrencePicker`.
    timezone: editionTimezone ?? "UTC",
    everyWeeks: 1,
    until: "",
    freezeLeadMinutes: 90,
    editionStart: 1,
  }));
  const [recurrenceSaved, setRecurrenceSaved] = useState(false);
  /**
   * Le premier envoi de la cadence ENREGISTRÉE, recalculé par le serveur en entrant dans le
   * récapitulatif. `null` = en cours de calcul. Un échec est gardé tel quel : « on ne sait pas » et
   * « aucune date » n'appellent pas le même geste.
   */
  const [apercuSerie, setApercuSerie] = useState<
    { premier: OccurrencePreview | null } | { erreur: string } | null
  >(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Le champ sujet : les puces de shortcode insèrent à la position du curseur, pas à la fin. */
  const subjectRef = useRef<HTMLInputElement>(null);
  // Chaque champ a son ref : une puce s inserer a la POSITION DU CURSEUR de SON champ.
  const preheaderRef = useRef<HTMLInputElement>(null);
  /** Le corps qui défile — on le remonte quand un refus apparaît, sinon le message reste hors écran. */
  const corps = useRef<HTMLDivElement>(null);
  /**
   * Renseigné UNIQUEMENT après une planification — ou un démarrage de série — réellement accepté
   * par l'API.
   * ⛔ LA SÉRIE AUSSI. Elle ne le renseignait jamais : `close()` ne remet l'assistant à zéro que
   * sur `done`, donc rouvrir « New campaign » après une série retombait sur le récapitulatif de
   * l'ANCIENNE — et la retoucher la modifiait sans le savoir.
   */
  const [done, setDone] = useState<Fin | null>(null);

  // Le compte ne peut exister qu'une fois la campagne créée — d'où `campaignId` en dépendance.
  const audience = useAudience(open ? campaignId : null, segmentId || null, purpose || null, contactsIgnorePurpose);

  const selected = useMemo(
    () => versions.find((v) => v.versionId === versionId) ?? null,
    [versions, versionId],
  );
  const segment = useMemo(() => segments.find((s) => s.id === segmentId) ?? null, [segments, segmentId]);
  /**
   * Un modèle, sa DERNIÈRE version publiée. On ne choisit plus une version à la création : dans la
   * quasi-totalité des cas c'est la plus récente qu'on veut, et proposer les cinq précédentes
   * transformait un choix évident en question piège.
   *
   * ⛔ Le maximum est recalculé ICI sur le numéro de version, et non pris comme « la première ligne
   * du tableau ». L'ordre vient de `listPublishedVersions`, ailleurs : s'y fier ferait partir une
   * campagne sur une version périmée le jour où ce tri changerait, sans que rien ne le signale.
   */
  const derniersParModele = useMemo(() => derniereVersionParModele(versions), [versions]);

  // ⛔ Le même fuseau que l'écran « Lock and schedule », lu à la même clé : une campagne créée ici
  // puis replanifiée là-bas doit parler du même instant. Deux écrans qui programment la même chose
  // avec deux fuseaux par défaut différents, c'est une heure d'écart que personne ne voit passer.
  const scheduledIso = tz === null ? null : zonedToIso(date, time, tz);
  const inFuture = scheduledIso !== null && new Date(scheduledIso).getTime() > Date.now();
  const offsetAt = scheduledIso !== null ? Date.parse(scheduledIso) : (mountedAt ?? 0);

  /** Ce qui manque à la cadence, en clair — `null` quand elle est complète. Affiché sous le sélecteur. */
  const cadenceManquante = useMemo(() => cadenceIncomplete(recurrence), [recurrence]);

  // Un refus doit se VOIR : on remonte le corps de l'assistant dès qu'un message d'erreur paraît.
  useEffect(() => {
    if (error) corps.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [error]);

  const eligible = audience.data?.eligible ?? null;
  const isLarge = eligible !== null && eligible >= LARGE_SEND;
  const typedOk = !isLarge || typed.trim().toUpperCase() === "SCHEDULE";
  const overClip = selected?.sizeBytes != null && selected.sizeBytes > GMAIL_CLIP_BYTES;

  const canNext =
    step === 0
      ? name.trim() !== "" && versionId !== "" && subject.trim() !== ""
      : step === 1
        ? // Le segment est FACULTATIF : sans lui la campagne vise toute la marque. La finalité, elle,
          // reste obligatoire — c'est elle, et non le ciblage, qui décide qui a le droit de recevoir.
          purpose !== ""
        : step === 2
          ? mode === "now"
            ? // Rien à choisir : la date est celle du serveur à la confirmation.
              true
            : mode === "once"
              ? inFuture
              : // Une série n'a pas de date unique : ce qu'il lui faut, c'est une cadence complète.
                // ⛔ EXACTEMENT les conditions de la route : un « Next » actif que la route refuse
                // ensuite en 400 se lit « rien ne se sauvegarde » (défaut du 18/09/2026).
                cadenceManquante === null
          : true;

  const canConfirm =
    !busy &&
    typedOk &&
    !overClip &&
    campaignId !== null &&
    (mode === "now" ? true : mode === "once" ? inFuture : recurrenceSaved);

  function reset() {
    setStep(0);
    setCampaignId(null);
    setName("");
    setVersionId("");
    setSubject("");
    setPreheader("");
    setSegmentId("");
    setPurpose("");
    setContactsIgnorePurpose(false);
    setDate("");
    setTime("10:00");
    setTyped("");
    setBusy(false);
    setError(null);
    setDone(null);
    // ⛔ La cadence AUSSI : sans ces quatre lignes, rouvrir l'assistant réaffichait la série
    // précédente comme si elle avait été gardée, alors que rien n'a été écrit — un mensonge à
    // l'écran qui n'apparaissait qu'au rechargement de la page.
    setMode("once");
    setRecurrence({
      days: [],
      time: "10:00",
      timezone: editionTimezone ?? "UTC",
      everyWeeks: 1,
      until: "",
      freezeLeadMinutes: 90,
      editionStart: 1,
    });
    setRecurrenceSaved(false);
    setApercuSerie(null);
  }

  function close() {
    // La liste doit refléter ce qui a réellement été écrit — y compris un brouillon abandonné.
    const touched = campaignId !== null;
    /*
     * ⛔⛔ FERMER N'OUBLIE PAS LE BROUILLON. `reset()` remettait `campaignId` à `null` alors que la
     * ligne, elle, existe en base depuis l'étape 1 : rouvrir l'assistant et refaire les mêmes
     * gestes repassait par `POST /api/campaigns` et créait une SECONDE campagne identique — le
     * dédoublement signalé par Alix le 18/09/2026 (« certains block se dedoublait »), dans l'ÉDITION
     * de la campagne et non dans le modèle.
     *
     * L'assistant reste monté (`if (!open) return null`) : garder l'état suffit, la réouverture
     * reprend le brouillon là où il a été laissé et enchaîne en `PATCH`. On n'oublie tout que
     * lorsque ce brouillon est CLOS — planifié ou série démarrée (`done`) — ou sur un « Start a new
     * one » explicite. Une série fermée SANS « Start series » reste un brouillon repris ici, et
     * s'affiche « Stopped » sur sa page : c'est la sortie voulue, pas un oubli.
     */
    if (done !== null) reset();
    else setError(null);
    onClose();
    if (touched) router.refresh();
  }

  /* ---------------------------------------------------------------- Écritures */

  /** Crée la campagne (première fois) ou met à jour son contenu. `false` = rien n'a bougé. */
  async function saveContent(): Promise<boolean> {
    const payload = {
      name: name.trim(),
      subject: subject.trim(),
      preheader: preheader.trim(),
      templateVersionId: versionId,
    };
    try {
      if (!campaignId) {
        const res = await fetch("/api/campaigns", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          setError(await readError(res));
          return false;
        }
        const body = (await res.json()) as { id?: string };
        if (!body?.id) {
          setError("The server did not return a campaign id.");
          return false;
        }
        setCampaignId(body.id);
        return true;
      }

      const res = await fetch(`/api/campaigns/${campaignId}`, {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        setError(await readError(res));
        return false;
      }
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      return false;
    }
  }

  async function saveTargeting(): Promise<boolean> {
    if (!campaignId) return false;
    try {
      const res = await fetch(`/api/campaigns/${campaignId}`, {
        method: "PATCH",
        headers: JSON_HEADERS,
        // ⛔ `|| null` et non la variable brute : l'API distingue `null` (pas de ciblage, accepté)
        // d'une chaîne vide, qu'elle cherche comme un identifiant de segment et rejette en 400.
        body: JSON.stringify({ segmentId: segmentId || null, purpose, contactsIgnorePurpose }),
      });
      if (!res.ok) {
        setError(await readError(res));
        return false;
      }
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      return false;
    }
  }

  /**
   * Verrouille puis planifie — deux appels, dans cet ordre, parce que `/schedule` EXIGE le verrou.
   *
   * Un 409 « already locked » n'est pas un échec : le contenu EST figé, c'est exactement l'état
   * recherché (cas d'un aller-retour dans l'assistant après un premier refus sur la date). On ne
   * poursuit que si la réponse le confirme par un `lockedAt` — un 409 d'une autre nature arrête tout.
   */
  async function lockAndSchedule() {
    const sendNow = mode === "now";
    if (!campaignId || busy || (!sendNow && !scheduledIso)) return;
    setBusy(true);
    setError(null);
    try {
      const lockRes = await fetch(`/api/campaigns/${campaignId}/lock`, { method: "POST" });
      if (!lockRes.ok) {
        const body = (await lockRes.json().catch(() => null)) as
          | { error?: string; lockedAt?: string }
          | null;
        if (!(lockRes.status === 409 && body?.lockedAt)) {
          setError(body?.error ?? `Request failed (${lockRes.status})`);
          setBusy(false);
          return;
        }
      }

      const res = await fetch(`/api/campaigns/${campaignId}/schedule`, {
        method: "POST",
        headers: JSON_HEADERS,
        // ⛔ Jamais une date calculée ici pour « maintenant » : l'horloge du navigateur n'est pas
        // celle du serveur. On DEMANDE l'envoi immédiat, la route le date.
        body: JSON.stringify(sendNow ? { sendNow: true } : { scheduledAt: scheduledIso }),
      });
      if (!res.ok) {
        setError(await readError(res));
        setBusy(false);
        return;
      }
      const body = (await res.json()) as { scheduledAt?: string; recipientsPlanned?: number | null };
      setDone({
        quoi: "ponctuelle",
        scheduledAt: body.scheduledAt ?? scheduledIso ?? new Date().toISOString(),
        recipientsPlanned: body.recipientsPlanned ?? null,
        sendNow,
      });
      setBusy(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setBusy(false);
    }
  }

  async function next() {
    if (busy || !canNext) return;
    setError(null);
    if (step === 0) {
      setBusy(true);
      const ok = await saveContent();
      setBusy(false);
      if (ok) setStep(1);
      return;
    }
    if (step === 1) {
      setBusy(true);
      const ok = await saveTargeting();
      setBusy(false);
      if (ok) setStep(2);
      return;
    }
    if (step === 2) {
      // En mode série, la cadence est ÉCRITE avant le récapitulatif : sinon l'écran final
      // résumerait une série que la base ne connaît pas. Puis son premier envoi est recalculé sur
      // CE qui vient d'être écrit — c'est lui que « Start series » va faire partir.
      if (mode === "series") {
        setBusy(true);
        const ok = await saveRecurrence();
        if (ok) await calculerPremierEnvoi();
        setBusy(false);
        if (!ok) return;
      }
      setStep(3);
    }
  }

  /**
   * Le premier envoi, demandé au serveur (même fonction SQL que le matérialiseur). Un échec NE
   * bloque PAS le récapitulatif : il s'y affiche tel quel, et la route de démarrage revalide tout.
   */
  async function calculerPremierEnvoi(): Promise<void> {
    setApercuSerie(null);
    try {
      const r = await chargerApercu(recurrence, 1);
      setApercuSerie({ premier: r.occurrences[0] ?? null });
    } catch (err) {
      setApercuSerie({ erreur: err instanceof Error ? err.message : "the preview failed" });
    }
  }

  /** Écrit la cadence sur la campagne. ⛔ Ne démarre rien : c'est « Start series », voir la route. */
  async function saveRecurrence(): Promise<boolean> {
    if (!campaignId) {
      setError("The campaign has not been created yet.");
      return false;
    }
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/recurrence`, {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          days: recurrence.days,
          time: recurrence.time,
          timezone: recurrence.timezone,
          everyWeeks: recurrence.everyWeeks,
          until: recurrence.until || undefined,
          freezeLeadMinutes: recurrence.freezeLeadMinutes,
          // NaN (champ vidé) part en `null` dans le JSON : la route le refuse avec un message clair.
          editionStart: recurrence.editionStart,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(body.error ?? `Could not save the cadence (${res.status})`);
        return false;
      }
      setRecurrenceSaved(true);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      return false;
    }
  }

  /**
   * ⭐ « START SERIES » — le geste qui fait partir une série, et la DERNIÈRE action de l'assistant.
   *
   * ⛔ LES MÊMES GARDES QU'UN ENVOI UNIQUE, PAS MOINS. Le petit bouton ambre qu'il remplace n'était
   * gardé que par « cadence enregistrée » : il sautait la saisie de SCHEDULE exigée au-delà de
   * 5 000 destinataires ET le contrôle de coupure Gmail — alors qu'une série fait partir ces
   * destinataires chaque semaine, pas une fois. `canConfirm` est la seule garde, pour les trois modes.
   *
   * ⛔ JAMAIS `/lock`. Une série n'est jamais verrouillée : `/arm` refuse une campagne verrouillée, et
   * le worker fige chaque édition lui-même au gel. Verrouiller ici rendrait la série impossible à
   * démarrer, avec un refus que l'utilisateur n'aurait aucun moyen de comprendre.
   *
   * ⛔ JAMAIS `cancelUpcoming` : démarrer n'annule rien. Seul l'arrêt annule (panneau de série).
   * Toutes les préconditions sont revalidées côté serveur ; un refus remonte tel quel, il NOMME ce
   * qui manque.
   */
  async function demarrerSerie(): Promise<void> {
    if (mode !== "series" || !campaignId || !canConfirm) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/arm`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        horizonDays?: number;
        upcoming?: { count: number; first: string | null } | null;
      };
      if (!res.ok) {
        setError(body.error ?? `Could not start the series (${res.status})`);
        setBusy(false);
        return;
      }
      setDone({
        quoi: "serie",
        premiere: body.upcoming?.first ?? null,
        aVenir: body.upcoming ? body.upcoming.count : null,
        horizonJours: body.horizonDays ?? 21,
      });
      setBusy(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setBusy(false);
    }
  }

  /**
   * On choisit un MODÈLE ; la version envoyée est sa dernière publiée, déduite ici.
   * Le sujet de la version ne COMBLE que le vide : une saisie éditoriale n'est jamais écrasée.
   */
  function pickTemplate(templateId: string) {
    const v = derniersParModele.find((x) => x.templateId === templateId) ?? null;
    setVersionId(v?.versionId ?? "");
    if (!v) return;
    setSubject((s) => (s.trim() === "" ? v.subject : s));
    setPreheader((p) => (p.trim() === "" ? v.preheader : p));
  }

  if (!open) return null;

  return (
    <ModalPortal>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
        role="dialog"
        aria-modal="true"
        aria-label="New campaign"
      >
        <div className="absolute inset-0 bg-black/40" onClick={close} />
        <div className="relative z-10 flex max-h-[88vh] w-full max-w-[600px] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
          <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
            <h2 className="text-[15px] font-semibold">
              {done ? (done.quoi === "serie" ? "Series running" : "Campaign scheduled") : "New campaign"}
            </h2>
            <button
              onClick={close}
              aria-label="Close"
              className="rounded-md p-1 text-muted-foreground hover:bg-accent"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {!done && (
            <div className="flex items-center gap-1.5 border-b border-border px-5 py-3">
              {STEP_LABELS.map((l, i) => (
                <div key={l} className="flex flex-1 items-center gap-1.5">
                  <span
                    className={cn(
                      "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10.5px] font-bold",
                      i < step
                        ? "bg-brand text-white"
                        : i === step
                          ? "border-2 border-brand text-brand"
                          : "border border-border text-muted-foreground",
                    )}
                  >
                    {i < step ? <Check className="h-3 w-3" /> : i + 1}
                  </span>
                  <span
                    className={cn(
                      "text-[11.5px] font-medium",
                      i === step ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {l}
                  </span>
                  {i < STEP_LABELS.length - 1 && <span className="h-px flex-1 bg-border" />}
                </div>
              ))}
            </div>
          )}

          <div ref={corps} className="flex-1 overflow-y-auto px-5 py-4">
            {/* ⛔ EN HAUT, pas en bas. Ce conteneur défile : un refus rendu après le contenu de
                l'étape restait sous la ligne de flottaison, et le clic sur « Next » paraissait sans
                effet — c'est ainsi qu'une série refusée se lisait « rien ne se sauvegarde ». */}
            {error && (
              <p
                role="alert"
                className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700"
              >
                {error}
              </p>
            )}
            {done?.quoi === "serie" ? (
              <div className="py-4">
                <div className="text-center">
                  <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[#e7f6ee]">
                    <Play className="h-6 w-6 text-[#1f9d57]" strokeWidth={2.2} />
                  </div>
                  {/*
                    ⛔ LA DATE VIENT DE LA RÉPONSE DE LA ROUTE, pas de l'aperçu d'avant le clic : c'est
                    celle que le matérialiseur va réellement créer, dates déjà annulées exclues.
                    `null` sur `aVenir` = la route n'a pas su relire — on le dit, sans inventer zéro.
                  */}
                  <h3 className="text-[16px] font-bold">
                    {done.premiere
                      ? `Series running — first edition on ${quandDansLeFuseau(done.premiere, recurrence.timezone)}`
                      : "Series running"}
                  </h3>
                  <p className="mx-auto mt-1 max-w-[48ch] text-[13px] text-muted-foreground">
                    {done.aVenir === null
                      ? "Its next dates could not be read back just now — the campaign page lists each edition once the planner has created it."
                      : done.aVenir === 0
                        ? `No edition falls in the next ${done.horizonJours} days — check the cadence on the campaign page.`
                        : `Each edition's content is frozen ${recurrence.freezeLeadMinutes} minutes before it is sent, with the articles of that day, then it goes out on its own. To stop the series, open the campaign and click Stop series.`}
                  </p>
                </div>
                <div className="mt-5 rounded-lg border border-border bg-[#fcfcfe] p-3.5 text-[13px]">
                  <SummaryRow k="Campaign" v={name} />
                  <SummaryRow k="Subject" v={subject} />
                  <SummaryRow k="Cadence" v={phraseDeLaSerie(recurrence)} />
                  <SummaryRow
                    k={`Editions in the next ${done.horizonJours} days`}
                    v={done.aVenir === null ? "Unknown" : fmtInt(done.aVenir)}
                  />
                  <SummaryRow k="Recipients today" v={fmtInt(eligible)} strong />
                </div>
                <p className="mt-3 text-[11.5px] text-muted-foreground/80">
                  Each edition is counted again when it goes out — consent is re-checked for every recipient at
                  send time.
                </p>
              </div>
            ) : done ? (
              <div className="py-4">
                <div className="text-center">
                  <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[#e6effe]">
                    <CalendarClock className="h-6 w-6 text-[#3d7fef]" strokeWidth={2.2} />
                  </div>
                  {/*
                    ⛔⛔ CE TEXTE A MENTI. Il disait « campaign sending is the next piece to be wired,
                    and no email leaves until it is » — vrai avant le fan-out (S-6) et la
                    réconciliation (S-7), faux depuis, et le worker envoie pour de vrai depuis le
                    18/09/2026 12:58 UTC. Un écran de confirmation qui promet que rien ne part est le
                    pire endroit où laisser un état révolu : c'est celui que l'on lit juste après
                    avoir cliqué.
                  */}
                  <h3 className="text-[16px] font-bold">{done.sendNow ? "Due now" : "Scheduled"}</h3>
                  <p className="mx-auto mt-1 max-w-[46ch] text-[13px] text-muted-foreground">
                    {done.sendNow
                      ? "The content is frozen and the campaign is due now. It starts leaving within seconds, in batches — the send rate is capped, so a large audience takes a while."
                      : "The content is frozen and the date is recorded. The send worker picks the campaign up at that date — nothing sits in the queue before then."}
                  </p>
                </div>
                <div className="mt-5 rounded-lg border border-border bg-[#fcfcfe] p-3.5 text-[13px]">
                  <SummaryRow k="Campaign" v={name} />
                  <SummaryRow k="Subject" v={subject} />
                  <SummaryRow
                    k={done.sendNow ? "Due since" : "Scheduled for"}
                    v={`${done.scheduledAt.replace("T", " ").slice(0, 16)} UTC`}
                  />
                  <SummaryRow k="Recipients planned" v={fmtInt(done.recipientsPlanned)} strong />
                </div>
                <p className="mt-3 text-[11.5px] text-muted-foreground/80">
                  The planned count is a snapshot taken now. Unsubscribes and erasures between today and
                  the send date will lower it — consent is re-checked for every recipient at send time.
                </p>
              </div>
            ) : (
              <>
                {step === 0 && (
                  <>
                    {/*
                      ⭐ CE QUE L'ON REPREND, DIT À VOIX HAUTE. Le brouillon survit à la fermeture
                      (voir `close()`) : sans cette ligne, l'utilisateur croirait commencer une
                      campagne neuve et modifierait la précédente sans le savoir. La sortie est
                      offerte au même endroit que le constat.
                    */}
                    {campaignId !== null && (
                      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-accent/40 px-3.5 py-2.5">
                        <span className="text-[12.5px] text-muted-foreground">
                          Continuing the draft you started
                          {name.trim() === "" ? "" : ` — ${name.trim()}`}. Saving updates it; it is not
                          created twice.
                        </span>
                        <button
                          type="button"
                          onClick={reset}
                          className="shrink-0 rounded-[7px] border border-border bg-card px-2.5 py-1 text-[12px] font-medium hover:bg-accent"
                        >
                          Start a new one instead
                        </button>
                      </div>
                    )}

                    <Field label="Campaign name" hint="Internal label — subscribers never see it.">
                      <input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        maxLength={120}
                        autoFocus
                        placeholder="Weekly roundup — week 34"
                        className={INPUT}
                      />
                    </Field>

                    {versions.length === 0 ? (
                      <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-3 text-[12.5px] text-amber-800">
                        <div className="mb-1 flex items-center gap-2 font-semibold">
                          <AlertTriangle className="h-4 w-4" /> No published version in this brand
                        </div>
                        A campaign can only send a PUBLISHED template version: a draft has no frozen HTML,
                        so there is nothing to send. Publish a version from the builder first.
                      </div>
                    ) : (
                      <Field
                        label="Template"
                        hint="Only templates with a published version appear here — the campaign takes their latest published version when you save it. A later publish is not picked up on its own: open the campaign and save it again."
                      >
                        <select
                          value={selected?.templateId ?? ""}
                          onChange={(e) => pickTemplate(e.target.value)}
                          className={INPUT}
                        >
                          <option value="">Select a template…</option>
                          {derniersParModele.map((v) => (
                            <option key={v.templateId} value={v.templateId}>
                              {v.etiquette}
                            </option>
                          ))}
                        </select>
                        {/* La version ne se choisit plus, mais elle part quand même : elle doit rester LISIBLE. */}
                        {selected && (
                          <div className="mt-1 text-[11.5px] text-muted-foreground">
                            Sending version v{selected.version} · {formatBytes(selected.sizeBytes)}
                          </div>
                        )}
                      </Field>
                    )}

                    {overClip && (
                      <p className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
                        This version weighs {formatBytes(selected?.sizeBytes)} — above the{" "}
                        {formatBytes(GMAIL_CLIP_BYTES)} Gmail clipping threshold. Gmail would cut the end of
                        the email, including the legal footer and its unsubscribe link. Locking will be refused.
                      </p>
                    )}

                    <Field
                      label="Subject line"
                      hint="Prefilled from the version — edit it freely, and click a shortcode to compose it."
                    >
                      <input
                        ref={subjectRef}
                        value={subject}
                        onChange={(e) => setSubject(e.target.value)}
                        maxLength={200}
                        placeholder="What lands in the inbox"
                        className={INPUT}
                      />
                      <div className="mt-0.5 text-right text-[10.5px] text-muted-foreground/70">
                        {subject.length}/200
                      </div>
                      {/* Le nom de campagne est déjà saisi : ce n'est PAS un exemple, c'est ce qui partira. */}
                      <SubjectTokens
                        inputRef={subjectRef}
                        value={subject}
                        onChange={setSubject}
                        connu={{ campaign_name: name.trim() }}
                      />
                    </Field>

                    <Field label="Preheader" hint="Preview text shown after the subject in the inbox.">
                      <input
                        ref={preheaderRef}
                        value={preheader}
                        onChange={(e) => setPreheader(e.target.value)}
                        maxLength={200}
                        placeholder="Short teaser…"
                        className={INPUT}
                      />
                      {/*
                        ⚠️ PAS DE `serie` ICI, ET C'EST DÉLIBÉRÉ. L'assistant crée la campagne ; la
                        cadence se règle APRÈS, sur l'écran de détail. On ne sait donc pas encore
                        répondre à « y a-t-il une cadence ? », et filtrer sur une supposition
                        retirerait les jetons de série à quelqu'un qui s'apprête justement à en
                        démarrer une. L'écran de détail, lui, sait — c'est là que le filtre s'applique.
                      */}
                      <SubjectTokens
                        inputRef={preheaderRef}
                        value={preheader}
                        onChange={setPreheader}
                        jetons={PREHEADER}
                        apercuLabel="Preview line"
                      />
                    </Field>
                  </>
                )}

                {step === 1 && (
                  <>
                    {/*
                      Le ciblage est facultatif, et « pas de ciblage » est un CHOIX EXPLICITE plutôt
                      qu'un champ laissé vide : la différence entre « je vise tout le monde » et « j'ai
                      oublié de choisir » ne doit pas se jouer sur un blanc. D'où une option à part
                      entière, en tête de liste, qui annonce son effet.
                    */}
                    <Field
                      label="Target segment"
                      hint="Optional — segments are scoped to the current brand."
                    >
                      <div className="space-y-1.5">
                        <label
                          className={cn(
                            "flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 text-[13px]",
                            segmentId === "" ? "border-brand bg-brand-soft/40" : "border-border",
                          )}
                        >
                          <input
                            type="radio"
                            name="seg"
                            checked={segmentId === ""}
                            onChange={() => setSegmentId("")}
                            className="mt-0.5 h-4 w-4 shrink-0"
                            style={{ accentColor: "#ff368d" }}
                          />
                          <span>
                            <span className="block font-medium">No segment — the whole brand</span>
                            <span className="mt-0.5 block text-[11.5px] text-muted-foreground">
                              Every sendable subscriber of this brand who granted the purpose below. The
                              count underneath is the real figure, not an estimate.
                            </span>
                          </span>
                        </label>

                        {segments.map((s) => (
                          <label
                            key={s.id}
                            className={cn(
                              "flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2.5 text-[13px]",
                              segmentId === s.id ? "border-brand bg-brand-soft/40" : "border-border",
                            )}
                          >
                            <input
                              type="radio"
                              name="seg"
                              checked={segmentId === s.id}
                              onChange={() => setSegmentId(s.id)}
                              className="h-4 w-4"
                              style={{ accentColor: "#ff368d" }}
                            />
                            {s.name}
                          </label>
                        ))}
                      </div>

                      {segments.length === 0 && (
                        <p className="mt-1.5 text-[11px] text-muted-foreground/70">
                          No segment saved for this brand yet — sending to the whole brand is still
                          available. Build one from the Segments screen to narrow it down.
                        </p>
                      )}
                    </Field>

                    <Field
                      label="Purpose"
                      hint="The consent purpose this campaign falls under. The send gate rejects every recipient who did not grant it."
                    >
                      <select value={purpose} onChange={(e) => setPurpose(e.target.value)} className={INPUT}>
                        <option value="">Select a purpose…</option>
                        {purposes.map((p) => (
                          <option key={p} value={p}>
                            {purposeLabel(p)}
                          </option>
                        ))}
                      </select>
                    </Field>

                    <AudienceReadout
                      state={audience}
                      segmentName={segment?.name ?? null}
                      contactsControl={{ checked: contactsIgnorePurpose, onChange: setContactsIgnorePurpose }}
                    />
                  </>
                )}

                {step === 2 && (
                  <>
                    {/* Bascule immédiat / ponctuel / série. Des boutons plutôt qu'une case à cocher :
                        ce sont des objets différents (maintenant, une date, une cadence), pas une
                        option de l'un. */}
                    <div className="mb-3 flex gap-1.5">
                      {(["now", "once", "series"] as const).map((m) => (
                        <button
                          key={m}
                          type="button"
                          aria-pressed={mode === m}
                          onClick={() => {
                            setMode(m);
                            setRecurrenceSaved(false);
                          }}
                          className={cn(
                            "flex-1 rounded-lg border px-3 py-2 text-[12.5px] font-medium transition-colors motion-reduce:transition-none",
                            mode === m
                              ? "border-brand bg-brand/10 text-brand"
                              : "border-border text-muted-foreground hover:border-brand/40",
                          )}
                        >
                          {m === "now" ? "Send now" : m === "once" ? "One send" : "Repeating series"}
                        </button>
                      ))}
                    </div>

                    {mode === "now" && (
                      <div className="space-y-2">
                        <p className="rounded-lg border border-border bg-accent/40 px-3.5 py-2.5 text-[12px] text-muted-foreground">
                          The campaign starts leaving <strong className="font-semibold text-foreground">within
                          seconds</strong> of your confirmation on the next screen. Emails go out in batches — the
                          send rate is capped, so a large audience takes a while.
                        </p>
                        <p className="text-[12px] text-muted-foreground">
                          Everything else is the same as a scheduled send: the content is frozen, the audience is
                          counted, and consent is re-checked for every recipient when it leaves.
                        </p>
                      </div>
                    )}

                    {mode === "series" && (
                      <>
                        <RecurrencePicker
                          value={recurrence}
                          onChange={(r) => {
                            setRecurrence(r);
                            setRecurrenceSaved(false);
                          }}
                          editionTimezone={editionTimezone}
                        />
                        {/* Dire CE QUI MANQUE, à l'endroit où ça manque : un bouton « Next » inerte
                            sans explication est la même impasse qu'un refus affiché hors écran. */}
                        {cadenceManquante && (
                          <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
                            {cadenceManquante}
                          </p>
                        )}
                        {/* Ce qui se passe ensuite, en une phrase : le bouton qui fait partir la série est
                            au bout de l'assistant, et il n'y en a qu'un. */}
                        <p className="mt-3 rounded-lg border border-border bg-accent/40 px-3.5 py-2.5 text-[12px] text-muted-foreground">
                          Nothing is sent yet. The next step shows the first send date, then{" "}
                          <strong className="font-semibold text-foreground">Start series</strong> makes it run.
                        </p>
                        {recurrenceSaved && (
                          <p className="mt-2 text-[12px] font-medium text-brand">
                            Cadence saved — the series is not running yet.
                          </p>
                        )}
                      </>
                    )}

                    {mode === "once" && (
                    <>
                    {/* Un seul champ : le calendrier s'ouvre dans le flux et porte l'heure sous la
                        grille. Les deux `<input type="date">` / `type="time"` d'avant obligeaient à
                        taper une date au format du navigateur, muet sur ce qu'il attendait. */}
                    <Field label="Send date">
                      <DateTimeField
                        value={date}
                        onChange={setDate}
                        time={time}
                        onTimeChange={setTime}
                        min={aujourdHuiDans(tz)}
                        placeholder="Pick a date"
                      />
                    </Field>

                    <Field label="Timezone">
                      <select
                        value={tz ?? ""}
                        disabled={tz === null}
                        onChange={(e) => {
                          setTz(e.target.value);
                          saveScheduleTimeZone(e.target.value);
                        }}
                        className={cn(INPUT, tz === null && "opacity-50")}
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
                    </Field>

                    <p className="text-[12px] text-muted-foreground">
                      {tz ? `Entered in ${tz} (${zoneOffsetLabel(tz, offsetAt)}).` : "Reading your timezone…"}
                      {tz && browserTz && tz !== browserTz ? ` Your browser is in ${browserTz}.` : ""}
                      {scheduledIso && (
                        <>
                          {" "}
                          That is{" "}
                          <span className="font-semibold text-foreground">
                            {scheduledIso.replace("T", " ").slice(0, 16)} UTC
                          </span>
                          .
                        </>
                      )}
                    </p>

                    {date !== "" && !inFuture && (
                      <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
                        That moment is in the past. Pick a future date and time — the API refuses anything else.
                      </p>
                    )}

                    <p className="mt-3 rounded-lg border border-border bg-accent/40 px-3.5 py-2.5 text-[12px] text-muted-foreground">
                      A campaign leaves at its scheduled date. Scheduling records that date and
                      freezes the content. To send right away, use Send now.
                    </p>
                    </>
                    )}
                  </>
                )}

                {step === 3 && (
                  <div className="space-y-3">
                    <div className="rounded-lg border border-border bg-[#fcfcfe] p-3.5 text-[13px]">
                      <SummaryRow k="Campaign" v={name} />
                      <SummaryRow k="Subject" v={subject} />
                      <SummaryRow k="Preheader" v={preheader} />
                      <SummaryRow
                        k="Template"
                        v={selected ? `${selected.templateName} · v${selected.version}` : ""}
                      />
                      <SummaryRow k="Size" v={formatBytes(selected?.sizeBytes)} />
                      {/* Un « — » laisserait croire à un champ oublié. Le récapitulatif nomme le
                          ciblage réel, y compris quand ce ciblage est « personne n'est exclu ». */}
                      <SummaryRow k="Segment" v={segment ? segment.name : "Whole brand — no segment"} />
                      <SummaryRow k="Purpose" v={purpose ? purposeLabel(purpose) : ""} />
                      {mode === "now" ? (
                        <SummaryRow k="Scheduled for" v="Now — as soon as you confirm" />
                      ) : mode === "once" ? (
                        <SummaryRow
                          k="Scheduled for"
                          v={scheduledIso ? `${scheduledIso.replace("T", " ").slice(0, 16)} UTC` : ""}
                        />
                      ) : (
                        /*
                         * ⭐ CE QUE « START SERIES » VA FAIRE, LU AVANT LE CLIC : la première date, le
                         * rythme ensuite, et à qui. La date vient du serveur, recalculée sur la cadence
                         * qui vient d'être enregistrée — pas de l'aperçu de l'étape précédente.
                         */
                        <>
                          <SummaryRow
                            k="First send"
                            strong
                            v={
                              apercuSerie === null
                                ? "Computing…"
                                : "erreur" in apercuSerie
                                  ? `Could not be computed — ${apercuSerie.erreur}`
                                  : apercuSerie.premier
                                    ? `${quandDansLeFuseau(apercuSerie.premier.firesAt, recurrence.timezone)} · edition ${recurrence.editionStart}`
                                    : "None in the next year — check the end date"
                            }
                          />
                          <SummaryRow k="Then" v={phraseDeLaSerie(recurrence)} />
                        </>
                      )}
                      <SummaryRow
                        k={mode === "series" ? "Audience" : "Recipients"}
                        v={
                          mode === "series" && eligible !== null
                            ? `${fmtInt(eligible)} recipient${eligible === 1 ? "" : "s"} today`
                            : fmtInt(eligible)
                        }
                        strong
                      />
                    </div>

                    <AudienceReadout state={audience} segmentName={segment?.name ?? null} />

                    {/*
                      Pré-vol : uniquement des contrôles RÉELLEMENT calculés ici. Les vérifications de
                      contenu (liens, alt, contraste, footer légal) ont déjà tourné à la PUBLICATION de
                      la version — les rejouer ici serait au mieux redondant, au pire divergent.
                    */}
                    <div className="rounded-lg border border-border p-3">
                      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Checks
                      </div>
                      <Preflight ok={subject.trim().length > 0} label="Subject line set" />
                      <Preflight ok={preheader.trim().length > 0} warn label="Preheader set (recommended)" />
                      <Preflight
                        ok={selected !== null}
                        label={
                          selected
                            ? `Template selected (sending v${selected.version})`
                            : "Template selected"
                        }
                      />
                      <Preflight
                        ok={!overClip}
                        label={`Under the Gmail clipping threshold (${formatBytes(selected?.sizeBytes)} of ${formatBytes(GMAIL_CLIP_BYTES)})`}
                      />
                      <Preflight ok={purpose !== ""} label="Purpose set" />
                      {/* ⛔ L'absence de ciblage est licite, mais elle ne doit pas passer inaperçue :
                          c'est le seul réglage de cet écran qui ÉLARGIT l'audience au lieu de la
                          restreindre. Il est donc dit ici, en jaune, à côté du compte réel. */}
                      {segmentId === "" && (
                        <Preflight
                          ok
                          warn
                          label="No segment — every eligible subscriber of this brand is targeted"
                        />
                      )}
                      {mode === "now" ? (
                        <Preflight ok label="Due on confirmation — it starts leaving within seconds" />
                      ) : mode === "once" ? (
                        <Preflight ok={inFuture} label="Scheduled in the future" />
                      ) : (
                        <Preflight ok={recurrenceSaved} label="Cadence saved on the campaign" />
                      )}
                      {/* ⛔ Des contacts hors newsletter, et sans la barrière de finalité : dit en jaune,
                          pour la même raison que « No segment » — c'est un réglage qui ÉLARGIT. */}
                      {audience.data?.population === "contacts" && (
                        <Preflight
                          ok
                          warn
                          label={
                            audience.data.purposeIgnored
                              ? "Contacts (not newsletter subscribers) — purpose check off"
                              : "Contacts (not newsletter subscribers) — only those who granted the purpose"
                          }
                        />
                      )}
                      <Preflight
                        ok={eligible !== null && eligible > 0}
                        warn={eligible === 0}
                        label={
                          eligible === null
                            ? "Recipient count unavailable"
                            : audience.data?.purposeIgnored
                              ? `${fmtInt(eligible)} recipient${eligible === 1 ? "" : "s"}`
                              : `${fmtInt(eligible)} recipient${eligible === 1 ? "" : "s"} eligible for this purpose`
                        }
                      />
                      <p className="mt-1.5 text-[11px] text-muted-foreground/70">
                        Content checks (links, alt text, contrast, legal footer) ran when the version was
                        published — they are not repeated here.
                      </p>
                    </div>

                    {isLarge && (
                      <div className="rounded-lg border border-amber-300 bg-amber-50 px-3.5 py-3">
                        <div className="mb-1.5 flex items-center gap-2 text-[12.5px] font-semibold text-amber-800">
                          <AlertTriangle className="h-4 w-4" /> {fmtInt(eligible)} recipients
                          {mode === "series" ? " at every edition" : ""} — type SCHEDULE to continue
                        </div>
                        <input
                          value={typed}
                          onChange={(e) => setTyped(e.target.value)}
                          placeholder="SCHEDULE"
                          className="w-full rounded-lg border border-amber-300 bg-white px-3 py-2 text-[13.5px] uppercase tracking-widest outline-none"
                        />
                      </div>
                    )}

                    {/*
                      ⛔ « CONFIRMING LOCKS THE CONTENT » ÉTAIT FAUX POUR UNE SÉRIE, affiché juste au-dessus
                      du bouton. Une série n'est jamais verrouillée : chaque édition fige SON contenu au
                      gel, avec les articles du jour. Chaque mode dit donc ce qui lui arrive vraiment —
                      et la série dit aussi comment sortir sans la démarrer, puisque c'est un choix réel.
                    */}
                    {mode === "series" ? (
                      <div className="flex items-start gap-2.5 rounded-lg border border-border bg-accent/50 px-3.5 py-2.5">
                        <Snowflake className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={2} />
                        <p className="text-[12px] text-muted-foreground">
                          <strong className="font-semibold text-foreground">Start series</strong> makes it run:
                          each edition is created ahead of time, its content is frozen{" "}
                          {recurrence.freezeLeadMinutes} minutes before it is sent — with the articles of that day
                          — and it goes out on its own. Until then you can still edit the campaign. Close instead,
                          and the series stays Stopped: nothing is sent until you start it from its campaign page.
                        </p>
                      </div>
                    ) : (
                      <div className="flex items-start gap-2.5 rounded-lg border border-border bg-accent/50 px-3.5 py-2.5">
                        <Lock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={2} />
                        <p className="text-[12px] text-muted-foreground">
                          Confirming locks the content: subject, preheader and version can no longer change,
                          because what goes out to subscribers must not change under their feet. Targeting
                          stays adjustable until the campaign is scheduled.
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}

          </div>

          <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-3.5">
            {done ? (
              <>
                <span className="text-[11.5px] text-muted-foreground">
                  {done.quoi === "serie" ? "Each edition is queued at its own send time." : "Nothing was queued."}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      const id = campaignId;
                      close();
                      if (id) router.push(`/campaigns/${id}`);
                    }}
                    className="rounded-[9px] border border-border px-3.5 py-2 text-[13px] font-medium hover:bg-accent"
                  >
                    View campaign
                  </button>
                  <button
                    onClick={close}
                    className="rounded-[9px] bg-brand px-4 py-2 text-[13px] font-semibold text-white"
                  >
                    Close
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="flex flex-col">
                  <button
                    onClick={() => (step === 0 ? close() : setStep((s) => (s - 1) as Step))}
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 self-start rounded-[9px] px-3 py-2 text-[13px] font-medium text-muted-foreground hover:bg-accent disabled:opacity-50"
                  >
                    {step === 0 ? (
                      "Cancel"
                    ) : (
                      <>
                        <ArrowLeft className="h-4 w-4" /> Back
                      </>
                    )}
                  </button>
                  {campaignId && (
                    <span className="px-3 text-[10.5px] text-muted-foreground/70">
                      {mode === "series" && recurrenceSaved
                        ? "Saved — closing keeps the series, stopped."
                        : "Saved as a draft — closing keeps it."}
                    </span>
                  )}
                </div>

                {step < 3 ? (
                  <button
                    disabled={!canNext || busy}
                    onClick={next}
                    className="inline-flex items-center gap-1.5 rounded-[9px] bg-brand px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50"
                  >
                    {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                    {busy ? "Saving…" : "Next"}
                    {!busy && <ArrowRight className="h-4 w-4" />}
                  </button>
                ) : (
                  /*
                   * ⛔ UN SEUL BOUTON FINAL, UNE SEULE GARDE. Pour une série il DÉMARRE (`/arm`), il ne
                   * ferme plus l'assistant : « Done — cadence saved » laissait finir sans jamais rien
                   * démarrer. `desarmement.test.ts` garde ce câblage et cette garde.
                   */
                  <button
                    disabled={!canConfirm}
                    onClick={mode === "series" ? demarrerSerie : lockAndSchedule}
                    className="inline-flex items-center gap-1.5 rounded-[9px] bg-brand px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50"
                  >
                    {busy ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : mode === "series" ? (
                      <Play className="h-4 w-4" />
                    ) : (
                      <Lock className="h-4 w-4" />
                    )}
                    {busy
                      ? mode === "series"
                        ? "Starting…"
                        : "Locking…"
                      : mode === "now"
                        ? "Lock & send now"
                        : mode === "once"
                          ? "Lock & schedule"
                          : "Start series"}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}

function Field({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("mb-3", className)}>
      <label className="mb-1 block text-[11.5px] font-semibold text-foreground/80">{label}</label>
      {children}
      {hint && <p className="mt-0.5 text-[11px] text-muted-foreground/70">{hint}</p>}
    </div>
  );
}

function Preflight({ ok, warn, label }: { ok: boolean; warn?: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2 py-0.5 text-[12px]">
      {ok ? (
        <Check className="h-3.5 w-3.5 shrink-0 text-[#1f9d57]" strokeWidth={2.5} />
      ) : (
        <AlertTriangle className={cn("h-3.5 w-3.5 shrink-0", warn ? "text-amber-600" : "text-[#d33]")} />
      )}
      <span className={cn(ok ? "text-foreground/75" : warn ? "text-amber-700" : "text-[#d33]")}>{label}</span>
    </div>
  );
}

function SummaryRow({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border/60 py-1.5 last:border-0">
      <span className="shrink-0 text-[12px] text-muted-foreground">{k}</span>
      {/* `title` : la valeur tronquée reste lisible au survol — un sujet coupé est une info perdue. */}
      <span title={v || undefined} className={cn("truncate text-[12.5px]", strong ? "font-bold" : "font-medium")}>
        {v || "—"}
      </span>
    </div>
  );
}
