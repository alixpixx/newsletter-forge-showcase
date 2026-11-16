"use client";

import { useEffect, useState } from "react";
import { Check, KeyRound, Loader2, TriangleAlert, X } from "lucide-react";
import { ModalPortal } from "@/components/modal-portal";
import { Btn } from "@/components/ui";

/**
 * « Change password » — pied de la barre latérale, pour SON propre compte (POST
 * /api/auth/change-password). Le mot de passe d'un autre compte se pose depuis « Manage access ».
 *
 * ⚠️ Le seuil de 12 caractères est revérifié par la route (`refusMotDePasse`, lib/auth.ts) : celui
 * d'ici ne sert qu'à griser le bouton, il ne protège rien.
 *
 * ⚠️ Le calque est au-dessus de z-50 : dans la navigation mobile, ce pied vit déjà dans un panneau
 * en z-50 monté sur <body>.
 */

const MIN = 12;

const CHAMP =
  "rounded-[10px] border border-border bg-background px-3 py-2.5 text-[13.5px] outline-none focus:border-brand focus:ring-2 focus:ring-brand/20";

function Champ({
  label,
  value,
  onChange,
  autoComplete,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: "current-password" | "new-password";
  autoFocus?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-foreground/80">{label}</span>
      <input
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        className={CHAMP}
      />
    </label>
  );
}

export function ChangePassword({ email }: { email: string }) {
  const [ouvert, setOuvert] = useState(false);
  const [actuel, setActuel] = useState("");
  const [nouveau, setNouveau] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [fait, setFait] = useState(false);

  function fermer() {
    setOuvert(false);
    setActuel("");
    setNouveau("");
    setConfirmation("");
    setErr("");
    setFait(false);
  }

  useEffect(() => {
    if (!ouvert) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") fermer();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [ouvert]);

  async function envoyer(e: React.FormEvent) {
    e.preventDefault();
    if (nouveau !== confirmation) {
      setErr("The two new passwords do not match.");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentPassword: actuel, newPassword: nouveau }),
      });
      const d = (await res.json().catch(() => ({}))) as { error?: unknown };
      if (!res.ok) {
        setErr(
          res.status === 401
            ? "Your session has expired. Sign in again."
            : typeof d.error === "string"
              ? d.error
              : `Request failed (${res.status}).`,
        );
        return;
      }
      setFait(true);
    } catch {
      setErr("Network error.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOuvert(true)}
        title="Change password"
        aria-label="Change password"
        className="rounded-md p-1.5 text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
      >
        <KeyRound className="h-[15px] w-[15px]" />
      </button>

      {ouvert && (
        <ModalPortal>
          <div
            className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8"
            onClick={fermer}
            role="dialog"
            aria-modal="true"
            aria-label="Change password"
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-[420px] rounded-[14px] border border-border bg-card shadow-[0_12px_40px_rgba(20,20,30,0.18)]"
            >
              <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
                <h2 className="text-[14px] font-semibold">Change password</h2>
                <button
                  type="button"
                  onClick={fermer}
                  aria-label="Close"
                  className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {fait ? (
                <div className="px-5 py-4">
                  <div className="flex items-start gap-2 rounded-[10px] border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-[12.5px] text-emerald-800">
                    <Check className="mt-[1px] h-4 w-4 shrink-0" strokeWidth={2.2} />
                    <span>
                      Password changed. You stay signed in here; every other session is signed out.
                    </span>
                  </div>
                  <div className="mt-4 flex justify-end">
                    <Btn variant="dark" onClick={fermer}>
                      Done
                    </Btn>
                  </div>
                </div>
              ) : (
                <form onSubmit={envoyer} className="flex flex-col gap-3.5 px-5 py-4">
                  {/* Rattache le formulaire au bon compte dans le gestionnaire de mots de passe. */}
                  <input type="email" autoComplete="username" value={email} readOnly hidden />
                  <Champ
                    label="Current password"
                    value={actuel}
                    onChange={setActuel}
                    autoComplete="current-password"
                    autoFocus
                  />
                  <Champ label="New password" value={nouveau} onChange={setNouveau} autoComplete="new-password" />
                  <Champ
                    label="Confirm new password"
                    value={confirmation}
                    onChange={setConfirmation}
                    autoComplete="new-password"
                  />
                  <p className="text-[11.5px] text-muted-foreground">
                    At least {MIN} characters. Every other session on this account is signed out.
                  </p>

                  {err && (
                    <div className="flex items-start gap-2 rounded-[10px] border border-destructive/25 bg-destructive/5 px-3 py-2 text-[12.5px] text-destructive">
                      <TriangleAlert className="mt-[1px] h-4 w-4 shrink-0" strokeWidth={2} />
                      <span>{err}</span>
                    </div>
                  )}

                  <div className="mt-1 flex justify-end gap-2">
                    <Btn type="button" onClick={fermer}>
                      Cancel
                    </Btn>
                    <Btn
                      type="submit"
                      variant="dark"
                      disabled={busy || !actuel || nouveau.length < MIN || !confirmation}
                    >
                      {busy && <Loader2 className="h-[15px] w-[15px] animate-spin" />} Change password
                    </Btn>
                  </div>
                </form>
              )}
            </div>
          </div>
        </ModalPortal>
      )}
    </>
  );
}
