/**
 * 404 racine. Rendue dans le layout racine (donc hors sidebar/topbar) :
 * on garde un écran centré autonome avec une sortie explicite vers Overview.
 */

import Link from "next/link";
import { Compass } from "lucide-react";

export default function NotFound() {
  return (
    <div className="animate-fade-up flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-[420px] rounded-[14px] border border-border bg-card p-7 text-center">
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-brand-soft">
          <Compass className="h-5 w-5 text-brand" strokeWidth={1.9} />
        </div>

        <div className="mt-4 font-mono text-[12px] font-medium text-muted-foreground">404</div>
        <h1 className="mt-1 text-[17px] font-bold tracking-tight">Page not found</h1>
        <p className="mx-auto mt-1.5 max-w-[36ch] text-[13px] text-muted-foreground">
          This page does not exist, or it has been moved.
        </p>

        <Link
          href="/"
          className="mt-6 inline-flex items-center gap-2 rounded-[9px] bg-brand px-3.5 py-2 text-[13px] font-medium text-brand-foreground shadow-[0_1px_3px_rgba(255,54,141,0.35)] transition-colors hover:bg-[#ec2079] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 focus-visible:ring-offset-2"
        >
          Back to Overview
        </Link>
      </div>
    </div>
  );
}
