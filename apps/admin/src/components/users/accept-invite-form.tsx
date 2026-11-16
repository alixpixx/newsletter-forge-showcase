"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Lock, Loader2, ArrowRight, TriangleAlert, Mail } from "lucide-react";

/**
 * Acceptation d'une invitation : la personne pose son mot de passe, la session s'ouvre.
 *
 * ⚠️ Le jeton n'est jamais affiché ni rejoué ailleurs : il vient de l'URL et part une seule fois
 * vers /api/auth/accept-invite. Cette page ne sait rien du compte visé — elle ne peut donc pas
 * révéler à un curieux qui suit un lien mort à quelle adresse il correspondait.
 */

const LONGUEUR_MIN = 12;

export function AcceptInviteForm({ token }: { token: string }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const trop_court = password.length > 0 && password.length < LONGUEUR_MIN;
  const discordant = confirm.length > 0 && confirm !== password;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (trop_court || discordant) return;
    setLoading(true);
    setErr("");
    const res = await fetch("/api/auth/accept-invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, password }),
    });
    if (res.ok) {
      router.replace("/");
      router.refresh();
    } else {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      setErr(d.error ?? "Could not activate this account.");
      setLoading(false);
    }
  }

  const champ =
    "flex items-center gap-2.5 rounded-[10px] border border-border bg-background px-3 py-2.5 transition-colors focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/20";

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-[380px] animate-fade-up">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-brand shadow-[0_2px_10px_rgba(255,54,141,0.4)]">
            <Mail className="h-[18px] w-[18px] text-white" strokeWidth={2} />
          </div>
          <div className="text-[16px] font-semibold tracking-tight">
            newsletter<span className="text-brand">·</span>forge
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-card p-7 shadow-[0_2px_6px_rgba(20,20,30,0.04),0_12px_40px_rgba(20,20,30,0.08)]">
          <h1 className="text-[19px] font-bold tracking-tight">Choose your password</h1>
          <p className="mt-1 mb-5 text-[13px] text-muted-foreground">
            This link activates your account. It works once.
          </p>

          <form onSubmit={onSubmit} className="flex flex-col gap-3.5">
            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-foreground/80">Password</span>
              <span className={champ}>
                <Lock className="h-[15px] w-[15px] text-muted-foreground/60" />
                <input
                  type="password"
                  required
                  minLength={LONGUEUR_MIN}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="flex-1 border-0 bg-transparent text-[13.5px] outline-none placeholder:text-muted-foreground"
                  placeholder="••••••••••••"
                  autoComplete="new-password"
                />
              </span>
              <span className="text-[11.5px] text-muted-foreground">
                {LONGUEUR_MIN} characters minimum.
              </span>
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-foreground/80">Confirm password</span>
              <span className={champ}>
                <Lock className="h-[15px] w-[15px] text-muted-foreground/60" />
                <input
                  type="password"
                  required
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  className="flex-1 border-0 bg-transparent text-[13.5px] outline-none placeholder:text-muted-foreground"
                  placeholder="••••••••••••"
                  autoComplete="new-password"
                />
              </span>
              {discordant && (
                <span className="text-[11.5px] text-destructive">Both passwords must match.</span>
              )}
            </label>

            {err && (
              <div className="flex items-center gap-2 rounded-[10px] border border-destructive/25 bg-destructive/5 px-3 py-2 text-[12.5px] text-destructive">
                <TriangleAlert className="h-4 w-4 shrink-0" strokeWidth={2} /> {err}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || trop_court || discordant || password.length === 0}
              className="mt-1 flex items-center justify-center gap-2 rounded-[10px] bg-brand py-2.5 text-[13.5px] font-semibold text-brand-foreground shadow-[0_1px_3px_rgba(255,54,141,0.35)] transition-colors hover:bg-[#ec2079] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? (
                <Loader2 className="h-[15px] w-[15px] animate-spin" />
              ) : (
                <>
                  Activate account <ArrowRight className="h-[15px] w-[15px]" strokeWidth={2} />
                </>
              )}
            </button>
          </form>
        </div>

        <p className="mt-4 text-center text-[11.5px] text-muted-foreground/70">
          Already activated? <a className="underline hover:text-foreground" href="/login">Sign in</a>
        </p>
      </div>
    </div>
  );
}
