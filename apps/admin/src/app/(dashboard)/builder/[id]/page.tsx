import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, ArrowLeft } from "lucide-react";
import { EmailDoc } from "@nf/render/schema";
import { Card, CardHead } from "@/components/ui";
import { getCurrentAsset } from "@/lib/asset-context";
import { getTemplateWithDraft } from "@/lib/data/templates";
import { listLifecycleBindings } from "@/lib/data/lifecycle-templates";
import { canEditTemplate, getSessionUser } from "@/lib/session";
import { BuilderShell } from "@/components/builder/shell";

/*
 * ÉDITEUR — charge le brouillon EN BASE (pas via HTTP : une page RSC qui fetch sa propre route est
 * un aller-retour inutile) puis passe la main au shell client.
 *
 * Le document est VALIDÉ ici. Un brouillon illisible n'ouvre PAS un éditeur vide : ouvrir un
 * document neuf par-dessus une donnée qu'on n'a pas su lire, c'est écraser au premier autosave.
 * On affiche donc l'erreur et on laisse la restauration de version faire son travail.
 */
export const dynamic = "force-dynamic";

function Fallback({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="animate-fade-up">
      <Link
        href="/builder"
        className="mb-4 inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-[15px] w-[15px]" strokeWidth={2} /> Back to templates
      </Link>
      <Card className="max-w-[720px]">
        <CardHead title={title} />
        <div className="flex items-start gap-2.5 text-[12.5px] leading-relaxed text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#b9790a]" strokeWidth={2} />
          <div>{children}</div>
        </div>
      </Card>
    </div>
  );
}

export default async function BuilderEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const asset = await getCurrentAsset();

  if (!asset.id) {
    return (
      <Fallback title="Database unavailable">
        The brand could not be resolved, so this template cannot be loaded. Nothing was changed — reload once the
        database is reachable.
      </Fallback>
    );
  }

  // Un template d'une autre marque est indiscernable d'un template inexistant (invariant de scope).
  const data = await getTemplateWithDraft(id, asset.id);
  if (!data) notFound();

  // Même invariant entre deux personnes d'une MÊME marque : un template non octroyé se comporte
  // comme un template inexistant. Garder la route seule laisserait l'URL ouvrir l'éditeur.
  const user = await getSessionUser();
  if (!user || !(await canEditTemplate(user, data.template.id))) notFound();

  // Quels e-mails de cycle de vie ce template sert-il ? Le pré-vol en a besoin pour exiger les jetons
  // sans lesquels ces e-mails ne font rien — et pour n'exiger RIEN de tous les autres templates.
  // ⚠️ `.value` sans regarder `known` : ici l'inconnu se comporte comme « aucun rattachement », et
  // c'est le bon défaut pour un PRÉ-VOL — il n'exige alors rien de plus, et la publication, elle,
  // refuse net si elle ne peut pas lire le réglage. Un pré-vol qui échouerait faute de lecture
  // bloquerait l'écriture de toutes les campagnes ordinaires.
  // ⛔ TOUS LES KINDS, PAS LE PREMIER. La clé est (asset_id, kind) : un template peut en servir deux,
  // et `POST …/publish` les contrôle TOUS. Un `.find` rendait celui de plus petit indice — donc
  // `welcome`, qui n'exige rien — et le bouton « Publish » s'annonçait vert juste avant un 422 sur
  // le `reengagement` que l'écran venait de déclarer sain.
  const lifecycleKinds = (await listLifecycleBindings(asset.id)).value
    .filter((b) => b.templateId === data.template.id)
    .map((b) => b.kind);

  if (!data.draft) {
    return (
      <Fallback title={`${data.template.name} — no draft`}>
        This template has no draft version (version 0), which should never happen: every template is created with one.
        Restore a published version from the{" "}
        <Link href={`/templates/${data.template.id}`} className="underline hover:text-brand">
          version history
        </Link>{" "}
        to get an editable draft back.
      </Fallback>
    );
  }

  const parsed = EmailDoc.safeParse(data.draft.doc);
  if (!parsed.success) {
    return (
      <Fallback title={`${data.template.name} — draft cannot be opened`}>
        The stored document does not match the current schema, so the editor stays closed rather than risk overwriting
        it:
        <ul className="mt-2 list-disc space-y-1 pl-4 font-mono text-[11.5px]">
          {parsed.error.issues.slice(0, 8).map((issue, i) => (
            <li key={i}>{`${issue.path.join(".") || "(root)"}: ${issue.message}`}</li>
          ))}
        </ul>
        <p className="mt-2">
          Restoring a published version from the{" "}
          <Link href={`/templates/${data.template.id}`} className="underline hover:text-brand">
            version history
          </Link>{" "}
          rewrites the draft with a valid document.
        </p>
      </Fallback>
    );
  }

  return (
    <BuilderShell
      templateId={data.template.id}
      templateName={data.template.name}
      doc={parsed.data}
      subject={data.draft.subject}
      preheader={data.draft.preheader}
      updatedAt={data.draft.updatedAt}
      assetName={asset.name}
      publishedVersion={data.versions[0]?.version ?? null}
      lifecycleKinds={lifecycleKinds}
    />
  );
}
