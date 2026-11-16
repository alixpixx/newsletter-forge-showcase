"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, Pencil } from "lucide-react";
import type { AutomationStatus } from "@nf/automations";
import { Btn } from "@/components/ui";
import { ModalPortal } from "@/components/modal-portal";
import { readError } from "@/components/campaigns/shared";

const CLASSE_LIEN =
  "inline-flex items-center gap-2 rounded-[9px] border border-border bg-card px-3.5 py-2 text-[13px] font-medium hover:bg-accent";

/** Le style des gestes d'une ligne de la liste : petits, lisibles, sans cadre. */
export const CLASSE_GESTE =
  "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] font-medium text-foreground/75 hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45";

/**
 * « Edit » d'une automation — sur sa page et sur chaque ligne de la liste (feature 3 du 24/09/2026,
 * puis plan AUTO-EDIT du 25/09 : la page d'un brouillon EST le formulaire).
 *
 * ⛔ SEUL UN BROUILLON SE MODIFIE (la route `PUT /api/automations/[id]` refuse le reste, 409). Hors
 * brouillon, le bouton le DIT avant d'agir : modifier = ramener au brouillon, ce qui l'ARRÊTE, et il
 * faudra simuler de nouveau avant de repasser en live. Le retour au brouillon passe par la même route
 * que « Back to draft » (`POST /api/automations/[id]/status`, `{ to: "draft" }`), qui seule décide ;
 * si elle refuse, on reste où l'on est avec sa raison, sans ouvrir le formulaire.
 */
export function EditButton({ id, status, compact = false }: { id: string; status: AutomationStatus; compact?: boolean }) {
  const router = useRouter();
  const [ouvert, setOuvert] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (status === "draft") {
    return (
      <Link href={`/automations/${id}`} className={compact ? CLASSE_GESTE : CLASSE_LIEN}>
        <Pencil className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} /> Edit
      </Link>
    );
  }

  async function arreterPuisModifier() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/automations/${id}/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: "draft" }),
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      // Même adresse depuis la fiche : `refresh` la relit, et le brouillon s'y ouvre en formulaire.
      router.push(`/automations/${id}`);
      router.refresh();
    } catch {
      setError("Network error: nothing was changed.");
    } finally {
      setBusy(false);
    }
  }

  const fermer = () => {
    setOuvert(false);
    setError(null);
  };

  return (
    <>
      {compact ? (
        <button type="button" onClick={() => setOuvert(true)} className={CLASSE_GESTE}>
          <Pencil className="h-3.5 w-3.5" /> Edit
        </button>
      ) : (
        <Btn onClick={() => setOuvert(true)}>
          <Pencil className="h-4 w-4" /> Edit
        </Btn>
      )}
      {ouvert && (
        <ModalPortal>
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Edit">
            <div className="absolute inset-0 bg-black/40" onClick={busy ? undefined : fermer} />
            <div className="relative z-10 w-full max-w-[460px] rounded-2xl border border-border bg-card p-5 shadow-2xl">
              <p className="text-[14px] font-semibold">Editing stops this automation</p>
              <ul className="mt-2.5 list-inside list-disc text-[12.5px] leading-relaxed text-foreground/80">
                <li>It goes back to draft now: nothing is sent while you edit.</li>
                <li>Simulate it again before going live.</li>
              </ul>
              {error && <p className="mt-2 text-[12px] text-red-700">{error}</p>}
              <div className="mt-4 flex justify-end gap-2">
                <Btn onClick={fermer} disabled={busy}>
                  Cancel
                </Btn>
                <Btn variant="dark" disabled={busy} onClick={arreterPuisModifier}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pencil className="h-4 w-4" />}
                  Stop and edit
                </Btn>
              </div>
            </div>
          </div>
        </ModalPortal>
      )}
    </>
  );
}
