import { Hammer } from "lucide-react";

export function ComingSoon({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="animate-fade-up">
      <h1 className="text-[22px] font-bold tracking-tight">{title}</h1>
      <p className="mt-1 max-w-[62ch] text-[13px] text-muted-foreground">{desc}</p>
      <div className="mt-6 flex flex-col items-center justify-center gap-3 rounded-[14px] border border-dashed border-border bg-card py-20 text-center">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-soft">
          <Hammer className="h-5 w-5 text-brand" strokeWidth={1.9} />
        </div>
        <div className="text-[14px] font-semibold">Screen under construction</div>
        <p className="max-w-[46ch] text-[12.5px] text-muted-foreground">
          The approved mockup is in <code className="rounded bg-accent px-1.5 py-0.5 font-mono text-[11px]">docs/mockup.html</code>.
          This screen will be implemented in an upcoming task of the plan.
        </p>
      </div>
    </div>
  );
}
