"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Mail, Lock, Loader2, ArrowRight, TriangleAlert } from "lucide-react";

export default function LoginPage() {
  const router = useRouter();
  // Champ vide : le formulaire ne désigne plus un compte en particulier — il y a
  // désormais plusieurs utilisateurs, et le navigateur remplit lui-même via autoComplete.
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setErr("");
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (res.ok) {
      router.replace("/");
      router.refresh();
    } else {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      setErr(d.error ?? "Sign-in error.");
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-[380px] animate-fade-up">
        {/* logo */}
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-brand shadow-[0_2px_10px_rgba(255,54,141,0.4)]">
            <Mail className="h-[18px] w-[18px] text-white" strokeWidth={2} />
          </div>
          <div className="text-[16px] font-semibold tracking-tight">
            newsletter<span className="text-brand">·</span>forge
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-card p-7 shadow-[0_2px_6px_rgba(20,20,30,0.04),0_12px_40px_rgba(20,20,30,0.08)]">
          <h1 className="text-[19px] font-bold tracking-tight">Sign in</h1>
          <p className="mt-1 mb-5 text-[13px] text-muted-foreground">Management workspace · Example Media</p>

          <form onSubmit={onSubmit} className="flex flex-col gap-3.5">
            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-foreground/80">Email</span>
              <span className="flex items-center gap-2.5 rounded-[10px] border border-border bg-background px-3 py-2.5 transition-colors focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/20">
                <Mail className="h-[15px] w-[15px] text-muted-foreground/60" />
                <input
                  type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
                  className="flex-1 border-0 bg-transparent text-[13.5px] outline-none placeholder:text-muted-foreground"
                  placeholder="vous@example.com" autoComplete="username"
                />
              </span>
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-foreground/80">Password</span>
              <span className="flex items-center gap-2.5 rounded-[10px] border border-border bg-background px-3 py-2.5 transition-colors focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/20">
                <Lock className="h-[15px] w-[15px] text-muted-foreground/60" />
                <input
                  type="password" required value={password} onChange={(e) => setPassword(e.target.value)}
                  className="flex-1 border-0 bg-transparent text-[13.5px] outline-none placeholder:text-muted-foreground"
                  placeholder="••••••••" autoComplete="current-password"
                />
              </span>
            </label>

            {err && (
              <div className="flex items-center gap-2 rounded-[10px] border border-destructive/25 bg-destructive/5 px-3 py-2 text-[12.5px] text-destructive">
                <TriangleAlert className="h-4 w-4 shrink-0" strokeWidth={2} /> {err}
              </div>
            )}

            <button
              type="submit" disabled={loading}
              className="mt-1 flex items-center justify-center gap-2 rounded-[10px] bg-brand py-2.5 text-[13.5px] font-semibold text-brand-foreground shadow-[0_1px_3px_rgba(255,54,141,0.35)] transition-colors hover:bg-[#ec2079] disabled:opacity-70"
            >
              {loading ? <Loader2 className="h-[15px] w-[15px] animate-spin" /> : <>Sign in <ArrowRight className="h-[15px] w-[15px]" strokeWidth={2} /></>}
            </button>
          </form>
        </div>

        <p className="mt-4 text-center text-[11.5px] text-muted-foreground/70">
          Secure session · single sign-on coming soon.
        </p>
      </div>
    </div>
  );
}
