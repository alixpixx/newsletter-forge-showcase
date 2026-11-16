import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, AlertTriangle, FileClock } from "lucide-react";
import { PageHead, Card, CardHead, Pill, Th, Td } from "@/components/ui";
import { getCurrentAsset } from "@/lib/asset-context";
import { canEditTemplate, getSessionUser } from "@/lib/session";
import { getDb } from "@/lib/supabase";
import { DuplicateButton, RestoreButton } from "@/components/templates/template-actions";
import { EditLink } from "@/components/templates/template-table";
import { categoryLabel, categoryTone } from "@/components/templates/categories";
import { LifecycleBinding } from "@/components/templates/lifecycle-binding";
import { listLifecycleBindings } from "@/lib/data/lifecycle-templates";
import { formatDateTime, formatBytes, GMAIL_CLIP_BYTES } from "@/components/templates/format";

// Historique lu en base à chaque requête (une publication doit apparaître immédiatement).
export const dynamic = "force-dynamic";

interface TemplateRow {
  id: string;
  name: string;
  slug: string;
  category: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface VersionRow {
  version: number;
  status: "draft" | "published";
  subject: string;
  preheader: string | null;
  note: string | null;
  author_email: string | null;
  size_bytes: number | null;
  warnings: unknown;
  restored_from_version: number | null;
  compiled_at: string | null;
  updated_at: string;
  created_at: string;
}

/**
 * Lecture directe du couple template / template_version.
 * Le filtre `asset_id` n'est PAS cosmétique : sans lui, l'URL d'un modèle d'une autre marque
 * serait lisible depuis n'importe quel contexte de marque.
 */
async function loadTemplate(assetId: string, id: string) {
  const db = getDb();
  if (!db) return null;

  const { data: template, error } = await db
    .from("template")
    .select("id, name, slug, category, created_at, updated_at, archived_at")
    .eq("id", id)
    .eq("asset_id", assetId)
    .maybeSingle();

  // Un id non-uuid déclenche une erreur PostgREST (22P02) → traité comme « introuvable ».
  if (error || !template) return null;

  const { data: versions } = await db
    .from("template_version")
    .select(
      "version, status, subject, preheader, note, author_email, size_bytes, warnings, restored_from_version, compiled_at, updated_at, created_at",
    )
    .eq("template_id", id)
    .order("version", { ascending: false });

  return {
    template: template as TemplateRow,
    versions: (versions ?? []) as VersionRow[],
  };
}

function warningCount(warnings: unknown): number {
  return Array.isArray(warnings) ? warnings.length : 0;
}

export default async function TemplateDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const asset = await getCurrentAsset();

  // Base injoignable : on ne peut ni confirmer ni infirmer l'existence du modèle — on le dit.
  if (!asset.id) {
    return (
      <div className="animate-fade-up">
        <Link
          href="/templates"
          className="mb-4 inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground hover:text-brand"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Template library
        </Link>
        <PageHead title="Template" />
        <div className="flex items-start gap-2.5 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>Database unavailable — this template cannot be loaded right now.</span>
        </div>
      </div>
    );
  }

  const loaded = await loadTemplate(asset.id, id);

  // Même invariant que dans le builder : un template non octroyé se comporte comme inexistant,
  // y compris entre deux personnes d'une même marque. L'historique de publication d'un template
  // (sujets, notes, auteurs) en dit assez pour ne pas le laisser lire sans droit.
  const user = await getSessionUser();
  if (loaded && (!user || !(await canEditTemplate(user, loaded.template.id)))) notFound();
  if (!loaded) notFound();

  const { template, versions } = loaded;
  /* Quels e-mails de cycle de vie ce modèle sert-il sur cette marque ? (`lifecycle_template`, 0059)
     ⚠️ TOUS, pas le premier : la clé primaire est (asset_id, kind), un modèle peut en servir deux.
     N'en montrer qu'un rendait le second invisible ici alors que la liste, elle, le badgeait — deux
     écrans, deux vérités sur le même fait. */
  /* ⛔ ON GARDE `known`, ON NE LE JETTE PAS. Sur une lecture ratée, `value` vaut `[]` — et cette
     carte, qui porte les BOUTONS D'ÉCRITURE, prononcerait « Not used for a lifecycle email » et
     proposerait « Use this » sur les quatre lignes, pendant que la liste, au même instant, refuse
     d'affirmer quoi que ce soit. C'est le pire des deux écrans qui mentirait : un clic partirait
     alors en ATTACHEMENT là où la personne croyait détacher. */
  const lectureCycle = await listLifecycleBindings(asset.id);
  const lifecycleKinds = lectureCycle.value
    .filter((b) => b.templateId === template.id)
    .map((b) => b.kind);
  const draft = versions.find((v) => v.status === "draft") ?? null;
  const published = versions.filter((v) => v.status === "published");
  const latest = published[0] ?? null;

  return (
    <div className="animate-fade-up">
      <Link
        href="/templates"
        className="mb-4 inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground hover:text-brand"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Template library
      </Link>

      <PageHead
        title={template.name}
        desc={`${asset.name} · ${template.slug} · last modified ${formatDateTime(template.updated_at)}`}
      >
        <DuplicateButton id={template.id} name={template.name} variant="default" />
        <EditLink id={template.id} name={template.name} />
      </PageHead>

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Pill tone={categoryTone(template.category)}>{categoryLabel(template.category)}</Pill>
        {latest ? (
          <Pill tone="green" dot>
            Published v{latest.version}
          </Pill>
        ) : (
          <Pill tone="amber" dot>
            Never published
          </Pill>
        )}
        {template.archived_at && <Pill tone="grey">Archived</Pill>}
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.15fr_1fr]">
        {/* Brouillon courant — la seule chose que le builder édite. */}
        <Card>
          <CardHead
            title="Current draft"
            sub={draft ? `Last saved ${formatDateTime(draft.updated_at)}` : "No draft row"}
          />
          {draft ? (
            <>
              <div className="mb-3 space-y-1.5 rounded-[10px] border border-border bg-accent/50 px-3.5 py-3 text-[12.5px]">
                <div>
                  <span className="text-muted-foreground">Subject:</span>{" "}
                  <span className="font-medium">{draft.subject || <span className="text-muted-foreground">— empty —</span>}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Preheader:</span>{" "}
                  {draft.preheader || <span className="text-muted-foreground">— empty —</span>}
                </div>
              </div>
              {draft.restored_from_version !== null && (
                <p className="mb-3 text-[12px] text-muted-foreground">
                  Restored from v{draft.restored_from_version}.
                </p>
              )}
              <p className="text-[12px] leading-relaxed text-muted-foreground">
                The draft is what the builder edits and what a test send uses. Recipients only ever
                receive a <b className="font-semibold">published</b> version.
              </p>
            </>
          ) : (
            <p className="text-[12.5px] leading-relaxed text-muted-foreground">
              This template has no draft row. Open it in the builder to start a new draft.
            </p>
          )}
        </Card>

        {/* Rattachement au cycle de vie (5A) — le seul écran qui change le contenu d'un e-mail
            que personne ne relit avant qu'il parte. */}
        <Card>
          <CardHead
            title="Lifecycle email"
            sub={
              !lectureCycle.known
                ? "This setting could not be read"
                : lifecycleKinds.length > 0
                  ? "This template replaces a built-in email"
                  : "Not used for a lifecycle email"
            }
          />
          <LifecycleBinding
            templateId={template.id}
            current={lifecycleKinds}
            published={latest !== null}
            known={lectureCycle.known}
          />
        </Card>

        {/* Historique RÉEL des versions publiées. */}
        <Card>
          <CardHead
            title="Version history"
            sub={`${published.length} published version${published.length === 1 ? "" : "s"}`}
          />
          {published.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 rounded-[10px] border border-dashed border-border bg-accent/30 px-5 py-10 text-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent">
                <FileClock className="h-[18px] w-[18px] text-muted-foreground" strokeWidth={1.9} />
              </div>
              <div className="text-[13px] font-semibold">No published version</div>
              <p className="max-w-[42ch] text-[12px] leading-relaxed text-muted-foreground">
                Publish from the builder to freeze the current draft as v1. Until then there is
                nothing to restore.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr>
                    <Th>Version</Th>
                    <Th>Published</Th>
                    <Th>Size</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {published.map((v, i) => {
                    const warns = warningCount(v.warnings);
                    const oversize = (v.size_bytes ?? 0) > GMAIL_CLIP_BYTES;
                    return (
                      <tr key={v.version} className="align-top">
                        <Td>
                          <div className="flex items-center gap-2">
                            <span className="font-semibold tabular-nums">v{v.version}</span>
                            {i === 0 && <Pill tone="grey">Latest</Pill>}
                          </div>
                          {v.note && <p className="mt-1 text-[12px] text-muted-foreground">{v.note}</p>}
                          {v.author_email && (
                            <p className="mt-0.5 text-[11.5px] text-muted-foreground/80">{v.author_email}</p>
                          )}
                          {warns > 0 && (
                            <p className="mt-1 text-[11.5px] text-amber-700">
                              {warns} compiler warning{warns === 1 ? "" : "s"}
                            </p>
                          )}
                        </Td>
                        <Td className="whitespace-nowrap text-muted-foreground">
                          {formatDateTime(v.compiled_at ?? v.updated_at)}
                        </Td>
                        <Td className={`whitespace-nowrap tabular-nums ${oversize ? "text-amber-700" : "text-muted-foreground"}`}>
                          {formatBytes(v.size_bytes)}
                          {oversize && <span title="Above the 102 kB Gmail clipping threshold"> ⚠</span>}
                        </Td>
                        <Td className="text-right">
                          <RestoreButton id={template.id} version={v.version} />
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="mt-3 text-[12px] leading-relaxed text-muted-foreground/80">
                Restoring copies that version back into the draft. Published versions are frozen and
                are never rewritten.
              </p>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
