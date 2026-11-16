"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pause, Play, Rocket, Undo2 } from "lucide-react";
import type { AutomationStatus } from "@nf/automations";
import { Btn } from "@/components/ui";
import { ModalPortal } from "@/components/modal-portal";
import { readError } from "@/components/campaigns/shared";

/**
 * Les boutons d'état d'une automation (étape 13) : Simulate, Go live, Pause, Resume, Back to draft.
 *
 * ⛔ « Go live », PAS « Arm » : le mot « arm » a disparu de l'écran le 22/09/2026 (décision d'Alix,
 * gardée par `campaigns/desarmement.test.ts`). Le plan disait « Arm » ; le geste est le même.
 *
 * ⛔ L'ÉCRAN N'EST PAS LA GARDE. Chaque refus affiché ici (membre, simulation pas encore tournée,
 * automation invalide) est REFAIT par la route `POST /api/automations/[id]/status`, qui seule décide.
 * Un bouton désarmé porte sa raison (au survol et en clair) : on ne clique pas dans le vide.
 *
 * ⛔ ARMER ET REPRENDRE ENVOIENT POUR DE VRAI : confirmation explicite, le nom de l'automation tapé en
 * entier. La route refuse un nom qui ne correspond pas.
 */
export interface StatusControlsProps {
  id: string;
  name: string;
  status: AutomationStatus;
  isSuperAdmin: boolean;
  simulationRan: boolean;
  /** Erreurs de `validateAutomation` pour `simulation` (vide = simulable). */
  simulateErrors: string[];
  /** Erreurs de `validateAutomation` pour `live` (vide = armable). */
  liveErrors: string[];
  dailyCap: number;
  window: string;
}

type Geste = { to: AutomationStatus; label: string };

export function StatusControls(p: StatusControlsProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<AutomationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [confirmer, setConfirmer] = useState<Geste | null>(null);

  async function envoyer(to: AutomationStatus, confirmName?: string) {
    setBusy(to);
    setError(null);
    setErrors([]);
    try {
      const res = await fetch(`/api/automations/${p.id}/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(confirmName === undefined ? { to } : { to, confirmName }),
      });
      if (!res.ok) {
        const clone = res.clone();
        setError(await readError(res));
        try {
          const b = (await clone.json()) as { errors?: unknown };
          if (Array.isArray(b.errors)) setErrors(b.errors.map(String));
        } catch {
          /* corps non-JSON : le message suffit */
        }
        return;
      }
      setConfirmer(null);
      router.refresh();
    } catch {
      setError("Network error: nothing was changed.");
    } finally {
      setBusy(null);
    }
  }

  const raisonArmer = !p.isSuperAdmin
    ? "Only a super admin can switch an automation to live: live sends real emails."
    : p.status === "simulation" && !p.simulationRan
      ? "The simulation has not run yet: wait for the worker's next planning pass."
      : p.liveErrors.length > 0
        ? p.liveErrors.join(" · ")
        : null;
  const raisonSimuler = p.simulateErrors.length > 0 ? p.simulateErrors.join(" · ") : null;

  const bouton = (to: AutomationStatus, label: string, icon: React.ReactNode, raison: string | null, variant: "default" | "primary" | "dark" = "default", confirmation = false) => (
    <Btn
      key={to}
      variant={variant}
      disabled={busy !== null || raison !== null}
      title={raison ?? undefined}
      onClick={() => (confirmation ? setConfirmer({ to, label }) : envoyer(to))}
    >
      {busy === to ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {label}
    </Btn>
  );

  const boutons: React.ReactNode[] = [];
  if (p.status === "draft") boutons.push(bouton("simulation", "Simulate", <Play className="h-4 w-4" />, raisonSimuler, "dark"));
  if (p.status === "simulation") boutons.push(bouton("live", "Go live", <Rocket className="h-4 w-4" />, raisonArmer, "primary", true));
  if (p.status === "live") boutons.push(bouton("paused", "Pause", <Pause className="h-4 w-4" />, null, "dark"));
  if (p.status === "paused") boutons.push(bouton("live", "Resume", <Play className="h-4 w-4" />, raisonArmer, "primary", true));
  if (p.status !== "draft") boutons.push(bouton("draft", "Back to draft", <Undo2 className="h-4 w-4" />, null));

  // La raison d'un bouton désarmé, écrite en clair sous les boutons (le survol ne se voit pas au doigt).
  const raisonVisible =
    p.status === "draft" ? raisonSimuler : p.status === "simulation" || p.status === "paused" ? raisonArmer : null;

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex flex-wrap justify-end gap-2">{boutons}</div>
      {raisonVisible && <p className="max-w-[46ch] text-right text-[11.5px] leading-snug text-muted-foreground">{raisonVisible}</p>}
      {error && !confirmer && (
        <div className="max-w-[46ch] text-right text-[12px] text-red-700">
          {error}
          {errors.length > 0 && (
            <ul className="mt-1 list-inside list-disc text-left">
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {confirmer && (
        <Confirmation
          geste={confirmer}
          name={p.name}
          dailyCap={p.dailyCap}
          window={p.window}
          busy={busy !== null}
          error={error}
          onCancel={() => {
            setConfirmer(null);
            setError(null);
          }}
          onConfirm={(typed) => envoyer(confirmer.to, typed)}
        />
      )}
    </div>
  );
}

function Confirmation({
  geste,
  name,
  dailyCap,
  window,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  geste: Geste;
  name: string;
  dailyCap: number;
  window: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (typed: string) => void;
}) {
  const [typed, setTyped] = useState("");
  const juste = typed.trim() === name.trim();
  return (
    <ModalPortal>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={geste.label}>
        <div className="absolute inset-0 bg-black/40" onClick={onCancel} />
        <div className="relative z-10 w-full max-w-[500px] rounded-2xl border border-border bg-card p-5 shadow-2xl">
          <p className="text-[14px] font-semibold">{geste.label}: this sends real emails</p>
          <ul className="mt-2.5 list-inside list-disc text-[12.5px] leading-relaxed text-foreground/80">
            <li>From the worker&apos;s next pass, matching subscribers receive this automation for real.</li>
            <li>At most {dailyCap.toLocaleString("en-US")} per day, only within {window}.</li>
            <li>Only addresses on the worker&apos;s allowlist; demo subscribers never.</li>
            <li>People already covered by the simulation are not sent to: only new cases go out.</li>
            <li>This is written to the audit log with your name.</li>
          </ul>
          <label className="mt-4 block text-[12.5px] font-medium" htmlFor="confirm-name">
            Type the automation&apos;s name to confirm: <span className="font-semibold">{name}</span>
          </label>
          <input
            id="confirm-name"
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            className="mt-1.5 w-full rounded-[9px] border border-border bg-card px-3 py-2 text-[13px] outline-none focus:ring-2 focus:ring-brand/30"
            autoComplete="off"
          />
          {error && <p className="mt-2 text-[12px] text-red-700">{error}</p>}
          <div className="mt-4 flex justify-end gap-2">
            <Btn onClick={onCancel} disabled={busy}>
              Cancel
            </Btn>
            <Btn variant="primary" disabled={!juste || busy} onClick={() => onConfirm(typed)}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
              {geste.label}
            </Btn>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}
