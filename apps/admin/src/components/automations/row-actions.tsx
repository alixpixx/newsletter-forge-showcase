"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Copy, Loader2, Trash2 } from "lucide-react";
import type { AutomationStatus } from "@nf/automations";
import { Btn } from "@/components/ui";
import { ModalPortal } from "@/components/modal-portal";
import { readError } from "@/components/campaigns/shared";
import { actionsFor } from "@/lib/automation-edit";
import { CLASSE_GESTE, EditButton } from "./edit-button";

/**
 * Les gestes d'une automation — Edit, Duplicate, Delete (plan AUTO-EDIT du 25/09/2026, étape 3).
 * Sur chaque ligne de la liste (`edit`), et en tête de sa page (sans Edit : la page d'un brouillon EST
 * le formulaire, celle d'une autre a déjà son « Edit »).
 *
 * ⛔ CE QUI EST PROPOSÉ vient de `actionsFor` (fonction pure testée) ; ce qui est PERMIS, de la route :
 *  - `POST /api/automations/[id]/duplicate` → 201 `{ id }` : la copie (un brouillon) s'ouvre aussitôt ;
 *  - `DELETE /api/automations/[id]` → 200, ou 409 `{ error }` (déjà un envoi…) affiché TEL QUEL.
 * Supprimer demande une confirmation : c'est le seul geste de cet écran qui ne se défait pas.
 */
export function AutomationActions({
  id,
  name,
  status,
  trigger,
  edit = true,
  afterDelete = "refresh",
}: {
  id: string;
  name: string;
  status: AutomationStatus;
  trigger: string;
  /** `false` en tête de page : l'édition y est déjà. */
  edit?: boolean;
  /** `list` depuis la page de l'automation (elle n'existe plus) ; `refresh` depuis la liste. */
  afterDelete?: "refresh" | "list";
}) {
  const router = useRouter();
  const gestes = actionsFor(status, trigger);
  const [copie, setCopie] = useState(false);
  const [erreurCopie, setErreurCopie] = useState<string | null>(null);
  const [supprimer, setSupprimer] = useState(false);

  async function dupliquer() {
    setCopie(true);
    setErreurCopie(null);
    try {
      const res = await fetch(`/api/automations/${id}/duplicate`, { method: "POST" });
      if (!res.ok) {
        setErreurCopie(await readError(res));
        return;
      }
      const b = (await res.json()) as { id?: unknown };
      if (typeof b.id !== "string" || !b.id) {
        setErreurCopie("The server did not return the copy's id.");
        return;
      }
      // La copie est un brouillon : sa page EST le formulaire.
      router.push(`/automations/${b.id}?saved=1`);
    } catch {
      setErreurCopie("Network error: nothing was copied.");
    } finally {
      setCopie(false);
    }
  }

  const aucun = !(edit && gestes.edit) && !gestes.duplicate && !gestes.delete;
  if (aucun) return null;

  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex flex-wrap items-center gap-1">
        {edit && gestes.edit && <EditButton id={id} status={status} compact />}
        {gestes.duplicate && (
          <button type="button" onClick={dupliquer} disabled={copie} className={CLASSE_GESTE}>
            {copie ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Copy className="h-3.5 w-3.5" />} Duplicate
          </button>
        )}
        {gestes.delete && (
          <button type="button" onClick={() => setSupprimer(true)} className={`${CLASSE_GESTE} hover:text-red-700`}>
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </button>
        )}
      </div>
      {erreurCopie && <p className="text-[11.5px] text-red-700">{erreurCopie}</p>}
      {supprimer && (
        <ConfirmerSuppression
          id={id}
          name={name}
          onCancel={() => setSupprimer(false)}
          onDeleted={() => {
            setSupprimer(false);
            if (afterDelete === "list") router.push("/automations");
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

function ConfirmerSuppression({
  id,
  name,
  onCancel,
  onDeleted,
}: {
  id: string;
  name: string;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirmer() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/automations/${id}`, { method: "DELETE" });
      if (!res.ok) {
        // 409 : la phrase de la route se lit telle quelle (« already sent… »).
        setError(await readError(res));
        return;
      }
      onDeleted();
    } catch {
      setError("Network error: nothing was deleted.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalPortal>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Delete">
        <div className="absolute inset-0 bg-black/40" onClick={busy ? undefined : onCancel} />
        <div className="relative z-10 w-full max-w-[460px] rounded-2xl border border-border bg-card p-5 shadow-2xl">
          <p className="text-[14px] font-semibold">Delete “{name}”?</p>
          <ul className="mt-2.5 list-inside list-disc text-[12.5px] leading-relaxed text-foreground/80">
            <li>It disappears from this brand&apos;s automations. This cannot be undone.</li>
            <li>An automation that has already selected someone cannot be deleted: its history is kept.</li>
          </ul>
          {error && <p className="mt-2 text-[12px] text-red-700">{error}</p>}
          <div className="mt-4 flex justify-end gap-2">
            <Btn onClick={onCancel} disabled={busy}>
              Cancel
            </Btn>
            <Btn variant="dark" disabled={busy} onClick={confirmer} className="bg-red-700 hover:bg-red-800">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              Delete
            </Btn>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}
