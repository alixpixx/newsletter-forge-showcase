import Link from "next/link";
import { ChevronRight, Pencil, LayoutTemplate } from "lucide-react";
import type { LifecycleKind } from "@nf/render/lifecycle-checks";
import { Pill, Th, Td } from "@/components/ui";
import { ArchiveButton, DuplicateButton, RenameButton } from "@/components/templates/template-actions";
import { categoryLabel, categoryTone } from "@/components/templates/categories";
import { lifecycleLabel } from "@/components/templates/lifecycle-labels";
import { formatDate } from "@/components/templates/format";

/*
 * Forme MINIMALE attendue d'une ligne de `listTemplates()` — alignée sur le contrat figé
 * GET /api/builder/templates. Structurelle à dessein : la couche data peut renvoyer plus de
 * champs, seuls ceux-ci sont affichés.
 */
export interface TemplateListRow {
  id: string;
  name: string;
  slug: string;
  category: string;
  updatedAt: string;
  /** null tant que le modèle n'a jamais été publié (il n'existe qu'un brouillon). */
  publishedVersion: number | null;
}

/** Lien stylé comme un bouton — `Btn` est un <button>, il ne peut pas porter la navigation. */
export function EditLink({ id, name, compact = false }: { id: string; name: string; compact?: boolean }) {
  return (
    <Link
      href={`/builder/${id}`}
      aria-label={`Edit ${name}`}
      className={`inline-flex items-center gap-2 rounded-[9px] bg-foreground font-medium text-background transition-colors hover:bg-black ${
        compact ? "px-3 py-1.5 text-[12.5px]" : "px-3.5 py-2 text-[13px]"
      }`}
    >
      <Pencil className={compact ? "h-[13px] w-[13px]" : "h-[15px] w-[15px]"} strokeWidth={2} /> Edit
    </Link>
  );
}

/*
 * Repérer un e-mail de cycle de vie SANS ouvrir la fiche du modèle.
 *
 * ⚠️ LE MÊME MOT DEUX FOIS SUR LA MÊME LIGNE. La catégorie « Welcome » (pastille rose, colonne
 * d'à côté) et le kind `welcome` sont deux choses sans rapport : l'une classe le modèle, l'autre
 * décide de ce qui part vraiment à l'inscription. D'où le mot « Lifecycle » en tête du groupe et un
 * ton qui n'est pas celui de la catégorie homonyme — sinon la ligne dit deux fois « Welcome » sans
 * que rien ne distingue le réglage d'envoi du simple rangement.
 *
 * ⚠️ Plusieurs badges possibles : la clé primaire de `lifecycle_template` est (asset_id, kind), donc
 * un même modèle peut servir deux e-mails. N'en montrer qu'un laisserait croire que l'autre est libre.
 */
function LifecycleBadges({ kinds, published }: { kinds?: LifecycleKind[]; published: boolean }) {
  if (!kinds || kinds.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 font-normal">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
        Lifecycle
      </span>
      {kinds.map((kind) => (
        <Pill key={kind} tone="blue">
          {lifecycleLabel(kind)}
        </Pill>
      ))}
      {!published && (
        /* ⚠️ Rattaché mais jamais publié : le worker n'a rien à servir et envoie le texte livré avec
           le produit. Le taire ici laisserait croire le réglage actif. Même ambre et même vocabulaire
           que l'avertissement de la fiche, et la même définition de « publié » que la colonne d'à
           côté — un troisième critère sur le même écran finirait par le contredire. */
        <span title="Publish a version to put this template live.">
          <Pill tone="amber">Built-in email still goes out</Pill>
        </span>
      )}
    </div>
  );
}

export function TemplateTable({
  rows,
  lifecycle,
}: {
  rows: TemplateListRow[];
  /** Kinds rattachés, par id de modèle. Absent sur les écrans qui ne lisent pas ce réglage. */
  lifecycle?: Map<string, LifecycleKind[]>;
}) {
  return (
    <div className="overflow-x-auto rounded-[14px] border border-border bg-card">
      <table className="w-full min-w-[760px] border-collapse text-[13px]">
        <thead>
          <tr className="bg-[#fcfcfe]">
            <Th>Template</Th>
            <Th>Category</Th>
            <Th>Published version</Th>
            <Th>Last modified</Th>
            <Th />
            <Th />
            <Th />
            <Th />
            <Th />
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id} className="group transition-colors hover:bg-brand-soft/40">
              <Td className="font-semibold">
                <Link href={`/templates/${t.id}`} className="hover:text-brand">
                  {t.name}
                </Link>
                <div className="mt-0.5 font-normal text-[11.5px] text-muted-foreground">{t.slug}</div>
                <LifecycleBadges kinds={lifecycle?.get(t.id)} published={t.publishedVersion !== null} />
              </Td>
              <Td>
                <Pill tone={categoryTone(t.category)}>{categoryLabel(t.category)}</Pill>
              </Td>
              <Td>
                {t.publishedVersion === null ? (
                  <span className="text-[12.5px] text-muted-foreground">Draft only</span>
                ) : (
                  <span className="tabular-nums font-medium">v{t.publishedVersion}</span>
                )}
              </Td>
              <Td className="whitespace-nowrap text-muted-foreground">{formatDate(t.updatedAt)}</Td>
              <Td>
                <EditLink id={t.id} name={t.name} compact />
              </Td>
              <Td>
                <DuplicateButton id={t.id} name={t.name} />
              </Td>
              <Td>
                <RenameButton id={t.id} name={t.name} category={t.category} />
              </Td>
              <Td>
                <ArchiveButton id={t.id} name={t.name} published={t.publishedVersion} />
              </Td>
              <Td>
                <Link
                  href={`/templates/${t.id}`}
                  aria-label={`Open ${t.name}`}
                  className="inline-flex text-muted-foreground/50 group-hover:text-brand"
                >
                  <ChevronRight className="h-4 w-4" />
                </Link>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** État vide soigné — c'est l'état de DÉPART de chaque marque, il doit expliquer quoi faire. */
export function TemplateEmptyState({ brand, children }: { brand: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2.5 rounded-[14px] border border-dashed border-border bg-accent/30 px-6 py-14 text-center">
      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-soft">
        <LayoutTemplate className="h-5 w-5 text-brand" strokeWidth={1.9} />
      </div>
      <div className="text-[14px] font-semibold">No templates for {brand} yet</div>
      <p className="max-w-[54ch] text-[12.5px] leading-relaxed text-muted-foreground">
        Templates are scoped per brand. Create one to open the builder: it starts as a draft
        (nothing is sent until you publish a version).
      </p>
      {children && <div className="mt-1.5">{children}</div>}
    </div>
  );
}
