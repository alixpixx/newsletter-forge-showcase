import Link from "next/link";
import { AlertTriangle, ArrowRight } from "lucide-react";
import { PageHead, Pill } from "@/components/ui";
import { getCurrentAsset } from "@/lib/asset-context";
import { getDb } from "@/lib/supabase";
import { listTemplatesRead } from "@/lib/data/templates";
import { listBrandPartials, type BrandPartial } from "@/lib/data/brand-partials";
import { listLegalFooterTemplates, type LegalFooterTemplate } from "@/lib/data/legal-footer-templates";
import {
  BrandPartialsPanel,
  type BrandPartialVu,
} from "@/components/templates/brand-partials-panel";
import { listLifecycleBindings, type LifecycleBinding } from "@/lib/data/lifecycle-templates";
import { listEditionLegalFooters, type EditionLegalFooter } from "@/lib/data/asset-editions";
import { LegalFooterForm } from "@/components/templates/legal-footer-form";
import { LegalFooterTemplatesPanel } from "@/components/templates/legal-footer-templates-panel";
import { lifecycleParModele } from "@/lib/lifecycle-slots";
import { ADRESSE_LIFECYCLE } from "@/lib/adresses-demenagees";
import { NewTemplateButton } from "@/components/templates/template-actions";
import { GenerateWithAiButton } from "@/components/templates/generate-link";
import { ImportTemplateButton } from "@/components/templates/import-button";
import { TemplateEmptyState, type TemplateListRow } from "@/components/templates/template-table";
import { TemplateLibrary } from "@/components/templates/template-library";
import { cn } from "@/lib/utils";

// Les modèles sont lus en base à chaque requête (création/duplication doivent être visibles aussitôt).
export const dynamic = "force-dynamic";

/**
 * Les deux moitiés de cet écran. ⛔ La marque est le SUJET des deux : les modèles appartiennent à
 * une marque, l'en-tête et le pied aussi. C'est ce qui justifie un onglet plutôt qu'une autre page
 * — le contexte de marque, le sélecteur, le fil d'Ariane sont les mêmes.
 */
const ONGLETS = [
  { cle: "templates", label: "Templates" },
  { cle: "brand", label: "Headers, footers & blocks" },
  { cle: "legal", label: "Legal footers" },
] as const;
type Onglet = (typeof ONGLETS)[number]["cle"];

export default async function TemplatesPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const sp = await searchParams;
  /* ⛔ LE PANNEAU « Lifecycle emails » ET SON FILTRE `?lifecycle=1` ONT QUITTÉ CET ÉCRAN le 24/09
     (demande d'Alix) : ils vivent sous Automations › Lifecycle emails (`automations/lifecycle`).
     `/templates?lifecycle=1` y est redirigé par `proxy.ts` (308) — la page ne lit donc plus ce
     paramètre. Les badges « Lifecycle » de la liste restent : ils disent ce que sert un modèle. */
  // ⚠️ Comparaison fermée : une valeur inconnue retombe sur l'onglet par défaut, jamais sur un écran
  // vide. Un lien périmé doit montrer quelque chose, pas rien.
  const onglet: Onglet =
    sp.tab === "brand" ? "brand" : sp.tab === "legal" ? "legal" : "templates";

  const asset = await getCurrentAsset();
  /* ⚠️ Le client est pris UNE fois et testé, jamais forcé par un `!` : `getCurrentAsset` sait rendre
     une marque issue de la configuration alors même que la base est injoignable — les deux
     conditions ne sont donc pas équivalentes, et le raccourci produirait un plantage de page là où
     l'écran sait déjà s'afficher dégradé. */
  const db = getDb();
  // Base injoignable → asset.id null : on n'invente rien, on affiche l'état dégradé.
  const [lectureModeles, lecture, lecturePartials]: [
    { known: boolean; value: TemplateListRow[] },
    { known: boolean; value: LifecycleBinding[] },
    { known: boolean; value: BrandPartial[] },
  ] = asset.id && db
    ? await Promise.all([
        listTemplatesRead(asset.id),
        // Les rattachements ne servent plus ici qu'aux badges de la liste (le panneau est parti).
        listLifecycleBindings(asset.id),
        listBrandPartials(db, asset.id),
      ])
    : [
        { known: false, value: [] },
        { known: false, value: [] },
        { known: false, value: [] },
      ];
  /* Le pied légal n'est lu que sur SON onglet — même règle que `subscribers/capture`, qui ne charge
     que le jeu de données ouvert. Il ajoute une requête et un `buildFooter` par édition ; les payer
     sur l'onglet des modèles serait payer pour un écran que personne ne regarde. */
  const [lectureLegal, lectureModelesLegaux]: [
    { known: boolean; value: EditionLegalFooter[] },
    { known: boolean; value: LegalFooterTemplate[] },
  ] =
    onglet === "legal" && asset.id && db
      ? await Promise.all([
          listEditionLegalFooters(db, asset.id, asset.name),
          listLegalFooterTemplates(db, asset.id),
        ])
      : [
          { known: false, value: [] },
          { known: false, value: [] },
        ];

  const rows = lectureModeles.value;
  // L'intersection avec la liste, jamais les rattachements bruts : voir `lifecycleParModele`.
  const cycleParModele = lifecycleParModele(lecture.value, rows);

  const modelesProposables = rows.map((t) => ({
    id: t.id,
    name: t.name,
    publishedVersion: t.publishedVersion,
  }));

  // Plus de compteur « used by N templates » : l'import est une copie (Alix, 16/09), aucun modèle ne
  // pointe sur un header ou un footer de la bibliothèque.
  const partialsVus: BrandPartialVu[] = lecturePartials.value.map((p) => ({
    id: p.id,
    slot: p.slot,
    name: p.name,
    updatedAt: p.updatedAt,
    rows: p.rows,
  }));

  return (
    <div className="animate-fade-up">
      <PageHead
        title="Template library"
        desc="Reusable email templates for the current brand. Open one in the builder to edit its draft, then publish a version."
      >
        {/* Ces trois gestes créent des MODÈLES. Les laisser sur l'onglet du pied légal ou de la
            bibliothèque de marque proposerait une action qui n'a rien à voir avec ce qu'on regarde
            — et « New template » à côté d'un formulaire de conformité est une invitation à se
            tromper d'écran. */}
        {onglet === "templates" && (
          <>
            <GenerateWithAiButton disabled={!asset.id} />
            <ImportTemplateButton
              disabled={!asset.id}
              disabledReason="Database unavailable — cannot import a template"
            />
            <NewTemplateButton
              disabled={!asset.id}
              disabledReason="Database unavailable — cannot create a template"
            />
          </>
        )}
      </PageHead>

      <div className="mb-4 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone="pink" dot>
            {asset.name}
          </Pill>
          <span className="text-[12px] text-muted-foreground">
            {/* ⚠️ Un compteur qui ignore le filtre actif annonce la marque entière avec le chiffre
                d'une sous-liste. Il nomme donc ce qu'il compte — y compris l'onglet : afficher
                « 4 templates » au-dessus de la bibliothèque d'en-têtes compterait autre chose que
                ce que l'écran montre. */}
            {onglet === "legal"
              ? lectureModelesLegaux.known
                ? `${lectureModelesLegaux.value.length} legal footer${lectureModelesLegaux.value.length === 1 ? "" : "s"} + brand default`
                : "legal footers could not be read"
              : onglet === "brand"
                ? lecturePartials.known
                  ? `${partialsVus.length} item${partialsVus.length === 1 ? "" : "s"} in this brand’s library`
                  : "headers, footers & blocks could not be read"
                : `${rows.length} template${rows.length === 1 ? "" : "s"} in scope`}
          </span>
          {/* Ce n'est plus un filtre : c'est le chemin vers le réglage, qui a déménagé sous
              Automations. Il n'existe que si la marque a au moins un rattachement effectivement
              listé — le même critère qu'avant, et le même compte que les badges de la liste. */}
          {onglet === "templates" && cycleParModele.size > 0 && (
            <Link
              href={ADRESSE_LIFECYCLE}
              className="inline-flex items-center gap-2 rounded-[9px] border border-border bg-card px-3 py-[7px] text-[12.5px] font-medium text-foreground/75 transition-colors hover:bg-accent"
            >
              Lifecycle emails <span className="tabular-nums opacity-70">{cycleParModele.size}</span>
              <ArrowRight className="h-3.5 w-3.5 opacity-60" strokeWidth={2} />
            </Link>
          )}
        </div>

        {/* Le paragraphe gris qui expliquait où trouver ce réglage a disparu avec la raison de son
            existence : le panneau ci-dessous EST le réglage, sur place. Deux textes concurrents pour
            un même état finissent toujours par se contredire. */}
      </div>

      {/* Onglets SERVEUR, comme ceux de `subscribers/capture` : des `<Link>`, pas un état client.
          L'onglet vit alors dans l'URL — donc il se partage, se met en favori, et revient tel quel
          après un retour arrière ou un `router.refresh()` depuis l'éditeur d'un partial. */}
      <nav className="mb-4 flex flex-wrap gap-2" aria-label="Template library sections">
        {ONGLETS.map((o) => (
          <Link
            key={o.cle}
            href={o.cle === "templates" ? "/templates" : `/templates?tab=${o.cle}`}
            aria-current={onglet === o.cle ? "page" : undefined}
            className={cn(
              "inline-flex items-center gap-2 rounded-[9px] border px-3 py-[7px] text-[12.5px] font-medium transition-colors",
              onglet === o.cle
                ? "border-brand-soft bg-brand-soft text-brand-soft-foreground"
                : "border-border bg-card text-foreground/75 hover:bg-accent",
            )}
          >
            {o.label}
            {o.cle === "brand" && lecturePartials.known && partialsVus.length > 0 && (
              <span className="tabular-nums opacity-70">{partialsVus.length}</span>
            )}
          </Link>
        ))}
      </nav>

      {!asset.id && (
        <div className="mb-4 flex items-start gap-2.5 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Database unavailable — the brand could not be resolved, so no template can be listed or
            created right now.
          </span>
        </div>
      )}

      {onglet === "legal" ? (
        <>
          {/* La bibliothèque d'abord — c'est ce qu'on vient y chercher ; le pied par défaut ensuite,
              qui sert tout e-mail sans choix et les e-mails intégrés du cycle de vie. */}
          <LegalFooterTemplatesPanel
            templates={lectureModelesLegaux.value.map((t) => ({
              id: t.id,
              name: t.name,
              config: t.config,
              updatedAt: t.updatedAt,
            }))}
            known={lectureModelesLegaux.known}
            brandKnown={Boolean(asset.id)}
            brandName={asset.name}
            editions={lectureLegal.value}
            editionsKnown={lectureLegal.known}
          />
          <LegalFooterForm
            editions={lectureLegal.value}
            known={lectureLegal.known}
            brandKnown={Boolean(asset.id)}
            brandName={asset.name}
          />
        </>
      ) : onglet === "brand" ? (
        /* ⛔ L'ONGLET NE REMET PAS LE PANNEAU DANS UN TERNAIRE DE LISTE. L'invariant d'origine —
           « frère du ternaire, jamais dedans » — visait le cas où la liste des modèles est vide :
           c'est justement le moment où l'on cherche où régler l'en-tête de sa marque. Ici le panneau
           ne dépend plus d'AUCUNE liste ; il a son propre onglet, toujours présent, à zéro partial
           comme à dix. */
        <BrandPartialsPanel
          partials={partialsVus}
          known={lecturePartials.known}
          brandKnown={Boolean(asset.id)}
          assetSlug={asset.slug}
          templates={modelesProposables.map((t) => ({ id: t.id, name: t.name }))}
        />
      ) : rows.length === 0 ? (
        asset.id ? (
          <TemplateEmptyState brand={asset.name}>
            <NewTemplateButton />
          </TemplateEmptyState>
        ) : null
      ) : (
        /* Recherche + filtre par catégorie (`?q=&type=`) : côté navigateur, sur la liste déjà lue.
           La page ne lit donc PAS ces paramètres — voir `template-library.tsx`. Le compteur de
           l'en-tête reste celui du périmètre (« in scope ») ; le « N of M » vit au-dessus de la liste. */
        <TemplateLibrary rows={rows} lifecycle={cycleParModele} />
      )}
    </div>
  );
}
