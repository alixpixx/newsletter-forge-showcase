"use client";

import { useState } from "react";
import { Check, Copy, ExternalLink, Code2, Braces } from "lucide-react";
import { Card, Pill, Btn, type Tone } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { FormRow } from "@/lib/data/forms";

type Mode = "iframe" | "script";

function iframeSnippet(base: string, slug: string): string {
  return `<iframe
  src="${base}/embed/${slug}"
  title="Newsletter signup"
  width="100%"
  height="220"
  style="border:0;max-width:480px"
  loading="lazy">
</iframe>`;
}

function scriptSnippet(base: string, slug: string): string {
  return `<script
  src="${base}/w.js"
  data-asset="${slug}"
  async>
</script>`;
}

const REGIME_LABEL: Record<string, string> = { gdpr: "GDPR", lgpd: "LGPD" };

export function EmbedCard({ form, base }: { form: FormRow; base: string }) {
  const [mode, setMode] = useState<Mode>("iframe");
  const [copied, setCopied] = useState(false);
  const url = `${base}/embed/${form.slug}`;
  const code = mode === "iframe" ? iframeSnippet(base, form.slug) : scriptSnippet(base, form.slug);

  const copy = async (text: string, all = false) => {
    try {
      await navigator.clipboard.writeText(text);
      if (all) {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      }
    } catch {
      /* clipboard unavailable */
    }
  };

  const consentTone: Tone = form.consentMode === "granular" ? "violet" : "blue";

  return (
    <Card className="flex flex-col gap-3.5">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[14px] font-semibold">{form.name}</h3>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Pill tone={consentTone} dot>
              {form.consentMode === "granular" ? "Granular consent" : "Single opt-in"}
            </Pill>
            <Pill tone="grey">{form.language}</Pill>
            <Pill tone="amber">{REGIME_LABEL[form.regime] ?? form.regime.toUpperCase()}</Pill>
          </div>
        </div>
      </div>

      {/* Public widget URL */}
      <div>
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.02em] text-foreground/55">
          Public widget
        </div>
        <div className="flex items-center gap-2">
          <code className="flex-1 truncate rounded-[8px] border border-border bg-accent px-2.5 py-1.5 text-[12px] text-muted-foreground">
            {url}
          </code>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] border border-border bg-card text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="Open widget"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      </div>

      {/* Snippet toggle */}
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <div className="inline-flex rounded-[8px] border border-border bg-card p-0.5">
            <ToggleBtn active={mode === "iframe"} onClick={() => setMode("iframe")} icon={<Code2 className="h-3.5 w-3.5" />}>
              iframe
            </ToggleBtn>
            <ToggleBtn active={mode === "script"} onClick={() => setMode("script")} icon={<Braces className="h-3.5 w-3.5" />}>
              script
            </ToggleBtn>
          </div>
        </div>
        <pre className="max-h-44 overflow-auto rounded-[10px] border border-border bg-foreground/[0.03] p-3 text-[12px] leading-relaxed text-foreground/80">
          <code>{code}</code>
        </pre>
      </div>

      <Btn variant="primary" onClick={() => copy(code, true)} className="justify-center">
        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        {copied ? "Copied!" : "Copy embed code"}
      </Btn>
    </Card>
  );
}

function ToggleBtn({
  active, onClick, icon, children,
}: { active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-[6px] px-2.5 py-1 text-[12px] font-medium transition-colors",
        active ? "bg-brand text-brand-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      {children}
    </button>
  );
}
