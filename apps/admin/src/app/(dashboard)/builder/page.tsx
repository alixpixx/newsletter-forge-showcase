import Link from "next/link";
import { AlertTriangle, ArrowRight, Pencil } from "lucide-react";
import { PageHead, Pill } from "@/components/ui";
import { getCurrentAsset } from "@/lib/asset-context";
import { listTemplates } from "@/lib/data/templates";
import { NewTemplateButton } from "@/components/templates/template-actions";
import { GenerateWithAiButton } from "@/components/templates/generate-link";
import { ImportTemplateButton } from "@/components/templates/import-button";
import { TemplateEmptyState, type TemplateListRow } from "@/components/templates/template-table";
import { categoryLabel, categoryTone } from "@/components/templates/categories";
import { formatDate } from "@/components/templates/format";

/*
 * ÉCRAN DE SÉLECTION du builder — l'éditeur lui-même vit dans /builder/[id].
 * Cette page ne rend plus aucune maquette : elle liste les modèles réels de la marque courante.
 */
export const dynamic = "force-dynamic";

export default async function BuilderIndexPage() {
  const asset = await getCurrentAsset();
  const rows: TemplateListRow[] = asset.id ? await listTemplates(asset.id) : [];

  return (
    <div className="animate-fade-up">
      <PageHead
        title="Email builder"
        desc="Pick a template to edit. Every change is saved to its draft — recipients only ever get a published version."
      >
        <GenerateWithAiButton disabled={!asset.id} />
        <ImportTemplateButton
          disabled={!asset.id}
          disabledReason="Database unavailable — cannot import a template"
        />
        <NewTemplateButton
          disabled={!asset.id}
          disabledReason="Database unavailable — cannot create a template"
        />
      </PageHead>

      <div className="mb-4 flex items-center gap-2">
        <Pill tone="pink" dot>
          {asset.name}
        </Pill>
        <span className="text-[12px] text-muted-foreground">
          {rows.length} template{rows.length === 1 ? "" : "s"} in scope
        </span>
      </div>

      {!asset.id && (
        <div className="mb-4 flex items-start gap-2.5 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>Database unavailable — the brand could not be resolved, so no template can be opened.</span>
        </div>
      )}

      {rows.length === 0 ? (
        asset.id ? (
          <TemplateEmptyState brand={asset.name}>
            <NewTemplateButton />
          </TemplateEmptyState>
        ) : null
      ) : (
        <div className="grid gap-3.5 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((t) => (
            <Link
              key={t.id}
              href={`/builder/${t.id}`}
              className="group flex flex-col rounded-[14px] border border-border bg-card p-[18px] transition-colors hover:border-brand"
            >
              <div className="mb-2 flex items-start justify-between gap-2">
                <h3 className="text-[13.5px] font-semibold group-hover:text-brand">{t.name}</h3>
                <Pill tone={categoryTone(t.category)}>{categoryLabel(t.category)}</Pill>
              </div>
              <p className="text-[12px] text-muted-foreground">{t.slug}</p>
              <div className="mt-3.5 flex items-center justify-between text-[12px] text-muted-foreground">
                <span>
                  {t.publishedVersion === null ? "Draft only" : `Published v${t.publishedVersion}`} ·{" "}
                  {formatDate(t.updatedAt)}
                </span>
                <span className="inline-flex items-center gap-1 font-medium text-foreground/70 group-hover:text-brand">
                  <Pencil className="h-[13px] w-[13px]" strokeWidth={2} /> Edit
                  <ArrowRight className="h-[13px] w-[13px]" strokeWidth={2} />
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}

      <p className="mt-4 text-[12px] text-muted-foreground/70">
        Looking for version history, duplication or restore?{" "}
        <Link href="/templates" className="underline hover:text-brand">
          Template library
        </Link>
        .
      </p>
    </div>
  );
}
