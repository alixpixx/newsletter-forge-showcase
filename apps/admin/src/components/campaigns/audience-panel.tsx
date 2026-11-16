"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtInt, purposeLabel, readError } from "@/components/campaigns/shared";

/**
 * Compte d'audience RÉEL — `GET /api/campaigns/[id]/audience`.
 *
 * Deux chiffres, et surtout leur ÉCART. `sendable` = qui matche le ciblage et reste envoyable ;
 * `eligible` = le sous-ensemble ayant accordé la finalité de la campagne. Le second seul serait
 * rassurant et faux : c'est la différence entre les deux qui dit combien d'abonnés le gate de
 * consentement écartera, un par un, au moment du départ. L'afficher est le seul moyen qu'un écart
 * anormal (mauvaise finalité, segment trop large) se voie AVANT la planification.
 *
 * ⛔ Aucune PII ne transite : la route ne renvoie que des compteurs.
 */

export interface AudienceResult {
  segmentId: string | null;
  purpose: string | null;
  sendable: number | null;
  eligible: number | null;
  /** Contacts de démonstration écartés par la barrière d'envoi — ce qui explique un zéro. */
  demoExcluded?: number | null;
  /** Abonnés réels écartés par le sunset (0057/0059) — l'autre moitié de l'explication d'un zéro. */
  sunsetExcluded?: number | null;
  /** Prédicats de la règle que le compilateur de segment ne sait pas évaluer — affichés, jamais tus. */
  unsupported: string[];
  /** Pourquoi un compte manque. `null` quand tout a été calculé. */
  reason: string | null;
  countedAt: string;
  /** Qui la règle désigne (0088) : les abonnés newsletter, ou les contacts hors newsletter. */
  population?: "subscribers" | "contacts";
  /** Contacts + case cochée : la barrière de finalité ne s'applique pas à ce compte. */
  purposeIgnored?: boolean;
}

/** La case de la campagne, pilotée par l'écran qui l'enregistre (assistant ou fiche). */
export interface ContactsPurposeControl {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

export interface AudienceState {
  data: AudienceResult | null;
  loading: boolean;
  /** Erreur de TRANSPORT (réseau, 4xx/5xx). Distincte de `data.reason`, qui est un refus motivé. */
  error: string | null;
}

/**
 * Recompte à chaque changement de campagne, de segment ou de finalité.
 *
 * Un jeton de séquence écarte les réponses périmées : sans lui, une requête lente déclenchée sur
 * l'ancien segment pourrait écraser le compte du nouveau — l'écran afficherait alors, en silence,
 * l'audience d'un ciblage que l'utilisateur vient d'abandonner.
 */
export function useAudience(
  campaignId: string | null,
  segmentId: string | null,
  purpose: string | null,
  /** La case EN COURS (non encore enregistrée) — même règle que le segment : le choix de l'écran. */
  contactsIgnorePurpose = false,
): AudienceState {
  const [state, setState] = useState<AudienceState>({ data: null, loading: false, error: null });

  useEffect(() => {
    if (!campaignId) {
      setState({ data: null, loading: false, error: null });
      return;
    }

    let stale = false;
    const params = new URLSearchParams();
    // ⛔ TOUJOURS POSÉ, MÊME VIDE. Les deux écrans qui appellent ce hook lui passent le choix EN
    // COURS, pas celui enregistré : `null` y veut dire « aucun ciblage », jamais « je ne sais pas ».
    // Omettre le paramètre laissait la route retomber sur le segment stocké en base — le compte
    // affiché restait alors celui d'un ciblage que l'opérateur venait justement d'abandonner.
    params.set("segmentId", segmentId ?? "");
    if (purpose) params.set("purpose", purpose);
    // Toujours posé, pour la même raison que le segment : sinon la route relit la case en base.
    params.set("contactsIgnorePurpose", String(contactsIgnorePurpose));
    const qs = params.toString();

    setState((s) => ({ ...s, loading: true, error: null }));

    fetch(`/api/campaigns/${campaignId}/audience${qs ? `?${qs}` : ""}`, { cache: "no-store" })
      .then(async (res) => {
        if (stale) return;
        if (!res.ok) {
          setState({ data: null, loading: false, error: await readError(res) });
          return;
        }
        const body = (await res.json()) as AudienceResult;
        setState({ data: body, loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (stale) return;
        setState({
          data: null,
          loading: false,
          error: err instanceof Error ? err.message : "Network error",
        });
      });

    return () => {
      stale = true;
    };
  }, [campaignId, segmentId, purpose, contactsIgnorePurpose]);

  return state;
}

/** Le compte est-il exploitable pour armer un garde-fou ? */
export const eligibleCount = (state: AudienceState): number | null => state.data?.eligible ?? null;

export function AudienceReadout({
  state,
  segmentName,
  className,
  contactsControl,
}: {
  state: AudienceState;
  segmentName?: string | null;
  className?: string;
  /** La case « sans finalité » — affichée SEULEMENT quand le compte porte sur des contacts. */
  contactsControl?: ContactsPurposeControl;
}) {
  const { data, loading, error } = state;

  if (error) {
    return (
      <div className={cn("rounded-lg border border-red-200 bg-red-50 px-3.5 py-3", className)}>
        <div className="flex items-start gap-2 text-[12.5px] text-red-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>Audience could not be counted: {error}</span>
        </div>
      </div>
    );
  }

  if (loading && !data) {
    return (
      <div className={cn("flex items-center gap-2 rounded-lg border border-border bg-accent/30 px-3.5 py-3 text-[12.5px] text-muted-foreground", className)}>
        <Loader2 className="h-4 w-4 animate-spin" /> Counting recipients…
      </div>
    );
  }

  if (!data) {
    return (
      <div className={cn("rounded-lg border border-border bg-accent/30 px-3.5 py-3 text-[12.5px] text-muted-foreground", className)}>
        Pick a purpose to count the audience — a segment is optional.
      </div>
    );
  }

  // Refus motivé par l'API (pas de segment, règle illisible…) : on répète SA raison, mot pour mot.
  if (data.eligible === null || data.sendable === null) {
    return (
      <div className={cn("rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-3", className)}>
        <div className="flex items-start gap-2 text-[12.5px] text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            No recipient count yet — {data.reason ?? "the audience could not be computed"}.
          </span>
        </div>
      </div>
    );
  }

  const skipped = Math.max(0, data.sendable - data.eligible);
  const label = data.purpose ? purposeLabel(data.purpose) : "this purpose";

  /*
   * De quoi ce compte est-il le compte ? La réponse vient de `data.segmentId` — ce que l'API a
   * RÉELLEMENT compté — et non de l'état de l'écran, qui peut avoir changé depuis la requête.
   * Sans ciblage, écrire « in this segment » désignerait un segment qui n'existe pas et masquerait
   * précisément ce qu'il faut voir : le compte porte sur toute la marque.
   */
  const portee =
    data.segmentId === null ? "in this brand" : segmentName ? `in ${segmentName}` : "in this segment";

  // ⛔ LES CONTACTS SE NOMMENT. Un compte de contacts affiché « subscribers » laisserait croire que la
  // campagne part à la newsletter — la population vient de l'API (ce qui a été COMPTÉ), pas de l'écran.
  const contacts = data.population === "contacts";
  const qui = contacts ? "contacts (not newsletter subscribers)" : "sendable subscribers";

  return (
    <div className={cn("rounded-lg border border-border bg-[#fcfcfe] px-3.5 py-3", className)}>
      <div className="flex items-baseline gap-2">
        <Users className="h-4 w-4 shrink-0 translate-y-[2px] text-brand" strokeWidth={2} />
        <span className="text-[19px] font-bold tabular-nums">{fmtInt(data.eligible)}</span>
        <span className="text-[12.5px] text-muted-foreground">
          {data.purposeIgnored
            ? `${qui} ${portee} will receive this campaign`
            : `of ${fmtInt(data.sendable)} ${qui} ${portee} have granted ${label}`}
        </span>
        {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      </div>

      {/* L'ÉCART est l'information la plus utile de l'écran : ce que le gate écartera en silence.
          Case cochée : il n'y a plus d'écart, et l'écran dit POURQUOI — sinon l'égalité des deux
          chiffres se lirait « tout le monde a consenti ». */}
      <p className={cn("mt-1.5 text-[12px]", skipped > 0 || data.purposeIgnored ? "text-amber-700" : "text-muted-foreground")}>
        {data.purposeIgnored
          ? `The ${label} check is off for these contacts: they get it whether or not they granted it.`
          : skipped > 0
            ? `${fmtInt(skipped)} will be skipped at send time — they never granted this purpose.`
            : "Everyone counted has granted this purpose — nobody is skipped."}
      </p>

      {contacts && contactsControl && (
        <label className="mt-2 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-[12px] text-amber-900">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={contactsControl.checked}
            disabled={contactsControl.disabled}
            onChange={(e) => contactsControl.onChange(e.target.checked)}
          />
          <span>
            Send to these contacts even if they never granted {label}. They did not sign up for the
            newsletter: only send if you have the right to write to them.
          </span>
        </label>
      )}

      {/* ⛔ UN ZÉRO NON EXPLIQUÉ SE LIT COMME UNE PANNE. Depuis que la barrière d'envoi écarte les
          contacts fictifs, une base de recette compte 0 destinataire — et l'opérateur soupçonne sa
          règle de segment, pas la base. On nomme donc ce qui a été retiré, et pourquoi. */}
      {typeof data.demoExcluded === "number" && data.demoExcluded > 0 && (
        <p className="mt-1.5 text-[11.5px] text-muted-foreground">
          {fmtInt(data.demoExcluded)} demo contact{data.demoExcluded > 1 ? "s" : ""} {portee}
          {" "}
          {data.demoExcluded > 1 ? "are" : "is"} excluded: their address is on a reserved domain
          (example.com), so no mail server would ever accept it.
        </p>
      )}

      {/* Même raison, autre cause : depuis 0057 la barrière écarte aussi les abonnés marqués par le
          sunset. Ils sont toujours abonnés et consentants — ils ne reçoivent simplement plus. Sans
          cette ligne, ils manquaient aux DEUX chiffres et le zéro redevenait inexplicable. */}
      {typeof data.sunsetExcluded === "number" && data.sunsetExcluded > 0 && (
        <p className="mt-1.5 text-[11.5px] text-muted-foreground">
          {fmtInt(data.sunsetExcluded)} subscriber{data.sunsetExcluded > 1 ? "s" : ""} {portee}
          {" "}
          {data.sunsetExcluded > 1 ? "are" : "is"} excluded by sunset: they stopped opening, so we
          stopped writing. They are still subscribed — clearing the sunset mark brings them back.
        </p>
      )}

      {data.unsupported.length > 0 && (
        <p className="mt-1.5 text-[11.5px] text-amber-700">
          Ignored by the count (no event stream yet): {data.unsupported.join(", ")}. The real audience
          may be smaller than the figure above.
        </p>
      )}

      <p className="mt-1.5 text-[11px] text-muted-foreground/70">
        Counted at {new Date(data.countedAt).toISOString().replace("T", " ").slice(0, 16)} UTC. This is
        an estimate: consent is re-checked for every recipient at send time.
      </p>
    </div>
  );
}
