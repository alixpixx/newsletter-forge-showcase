/**
 * Squelette de chargement du shell dashboard (Suspense boundary implicite).
 * Discret et générique : titre + rangée de tuiles + bloc tableau.
 */

function Bar({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-accent ${className ?? ""}`} />;
}

export default function DashboardLoading() {
  return (
    <div className="animate-fade-in" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>

      <div className="mb-6">
        <Bar className="h-[22px] w-[210px]" />
        <Bar className="mt-2.5 h-[13px] w-[320px]" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="rounded-[14px] border border-border bg-card p-[18px]">
            <Bar className="h-[12px] w-[86px]" />
            <Bar className="mt-3 h-[24px] w-[64px]" />
            <Bar className="mt-2.5 h-[11px] w-[104px]" />
          </div>
        ))}
      </div>

      <div className="mt-4 rounded-[14px] border border-border bg-card p-[18px]">
        <Bar className="h-[13px] w-[150px]" />
        <div className="mt-4 space-y-3">
          {[0, 1, 2, 3, 4].map((i) => (
            <Bar key={i} className="h-[15px] w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}
