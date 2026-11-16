"use client";

/**
 * Error boundary du shell dashboard. Sans ce fichier, la moindre coupure
 * Supabase (ou n'importe quelle exception serveur) renvoyait l'écran d'erreur
 * brut de Next. Ici : message sobre, retry réel (`reset()`), sortie vers Overview.
 */

import { useEffect } from "react";
import Link from "next/link";
import { TriangleAlert, RotateCcw, LayoutDashboard } from "lucide-react";
import { Btn } from "@/components/ui";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Trace côté client — le détail serveur reste dans les logs Next.
    console.error("[dashboard] unhandled error:", error);
  }, [error]);

  return (
    <div className="animate-fade-up flex min-h-[60vh] items-center justify-center">
      <div className="w-full max-w-[440px] rounded-[14px] border border-border bg-card p-7 text-center">
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-[#fdf0dd]">
          <TriangleAlert className="h-5 w-5 text-[#b9790a]" strokeWidth={1.9} />
        </div>

        <h1 className="mt-4 text-[17px] font-bold tracking-tight">Something went wrong</h1>
        <p className="mx-auto mt-1.5 max-w-[38ch] text-[13px] text-muted-foreground">
          This screen could not be loaded. The data source may be temporarily unreachable.
        </p>

        {error.digest && (
          <p className="mt-3 font-mono text-[11px] text-muted-foreground/70">
            ref {error.digest}
          </p>
        )}

        <div className="mt-6 flex items-center justify-center gap-2.5">
          <Btn variant="primary" onClick={() => reset()}>
            <RotateCcw className="h-4 w-4" strokeWidth={2} />
            Try again
          </Btn>
          <Link
            href="/"
            className="inline-flex items-center gap-2 rounded-[9px] border border-border bg-card px-3.5 py-2 text-[13px] font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 focus-visible:ring-offset-2"
          >
            <LayoutDashboard className="h-4 w-4" strokeWidth={2} />
            Back to Overview
          </Link>
        </div>
      </div>
    </div>
  );
}
