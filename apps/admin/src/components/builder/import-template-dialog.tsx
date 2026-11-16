"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Blocks, Check, ExternalLink, Loader2, PanelBottom, PanelTop, Scale } from "lucide-react";
import { newId, type EmailDoc, type Row } from "@nf/render/schema";
import { Btn } from "@/components/ui";
import { cn } from "@/lib/utils";
import {
  fetchLegalLibrary,
  fetchPartialRows,
  fetchPartials,
  legalFooterPreviewHtml,
  type LegalLibrary,
  type PartialEntry,
} from "@/components/templates/library-client";
import type { ActiveColumn, Selection } from "./canvas";
import { newRowWith } from "./factories";
import { actionImport, ouInsererBloc } from "./library-insert";
import { Modal } from "./modal";
import type { BuilderAction } from "./reducer";

/**
 * « IMPORT TEMPLATE » — verser un header, un footer, un bloc ou un pied légal de la bibliothèque dans
 * l'e-mail.
 *
 * Alix, 16/09 : « on les crees autant qu'on veut […] et ensuite je peux les importer facilement dans
 * mon email builder avec un bouton genre import template ».
 *
 * ⛔ HEADER, FOOTER ET BLOC SONT COPIÉS (décision d'Alix). Les rows entrent dans le document et y restent
 * éditables ; modifier le header dans la bibliothèque ne touche pas cet e-mail. D'où la phrase au pied
 * de la modale : le geste ne doit pas laisser croire à un lien.
 *
 * ⛔ LE PIED LÉGAL, LUI, EST UN CHOIX — pas une copie. Son contenu n'entre pas dans le document : le
 * bloc légal reçoit l'id du template, et l'envoi lit sa config à jour. Les liens de désinscription
 * restent générés par destinataire.
 *
 * ⭐ LE BLOC (0080, Alix le 23/09 : « des blocks qu'on peut importer où on veut »). Contrairement au
 * header et au footer, il n'a pas de place fixe : il se pose juste APRÈS la row de la colonne
 * sélectionnée sur le canevas, sinon au-dessus du pied — la règle vit dans `library-insert.ts`, la même
 * que la section « Saved blocks » de la palette.
 */

export type Onglet = "header" | "footer" | "legal" | "block";

/** Le pied légal choisi : un template, ou `null` pour le pied par défaut de la marque. */
type ChoixLegal = string | null;

export const ONGLETS: { cle: Onglet; label: string; icone: typeof PanelTop }[] = [
  { cle: "header", label: "Header", icone: PanelTop },
  { cle: "footer", label: "Footer", icone: PanelBottom },
  { cle: "legal", label: "Legal footer", icone: Scale },
  { cle: "block", label: "Blocks", icone: Blocks },
];

/**
 * Les entrées qu'un onglet liste ET compte — une seule définition pour la liste et le compteur de
 * l'onglet, sinon l'un finit par annoncer ce que l'autre ne montre pas.
 *
 * ⛔ PAR FENTE EXACTE. Un bloc sous l'onglet Header serait posé en tête de l'e-mail à l'import.
 */
export function entreesDeLOnglet(partials: readonly PartialEntry[], onglet: Onglet): PartialEntry[] {
  return partials.filter((p) => p.slot === onglet);
}

/** Plafond du document (`MAX_DOC_ROWS`) : le reducer refuserait en silence au-delà. */
const MAX_ROWS = 200;

function blocLegalDe(doc: EmailDoc): { id: string; legalTemplateId: string | null } | null {
  for (const row of doc.rows) {
    for (const column of row.columns) {
      for (const block of column.blocks) {
        if (block.type === "footer_legal") return { id: block.id, legalTemplateId: block.legalTemplateId ?? null };
      }
    }
  }
  return null;
}

export function ImportTemplateDialog({
  doc,
  assetName,
  activeColumn,
  dispatch,
  onSelect,
  onClose,
}: {
  doc: EmailDoc;
  assetName: string;
  /** La colonne sélectionnée sur le canevas : un bloc se pose juste après SA row. */
  activeColumn: ActiveColumn | null;
  dispatch: React.Dispatch<BuilderAction>;
  onSelect: (sel: Selection) => void;
  onClose: () => void;
}) {
  const [onglet, setOnglet] = useState<Onglet>("header");
  const [partials, setPartials] = useState<PartialEntry[] | null>(null);
  const [legal, setLegal] = useState<LegalLibrary | null>(null);
  const [erreurLecture, setErreurLecture] = useState<string | null>(null);
  const [choixPartial, setChoixPartial] = useState<string | null>(null);
  const [choixLegal, setChoixLegal] = useState<ChoixLegal | undefined>(undefined);
  const [envoi, setEnvoi] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  const blocLegal = blocLegalDe(doc);

  useEffect(() => {
    let annule = false;
    Promise.all([fetchPartials(), fetchLegalLibrary()])
      .then(([p, l]) => {
        if (annule) return;
        setPartials(p);
        setLegal(l);
      })
      .catch((e: Error) => {
        if (!annule) setErreurLecture(e.message);
      });
    return () => {
      annule = true;
    };
  }, []);

  const dansLOnglet = useMemo(
    () => entreesDeLOnglet(partials ?? [], onglet),
    [partials, onglet],
  );

  // Sélection par défaut : le premier de l'onglet, et pour le légal, le choix actuel de l'e-mail.
  const partialAffiche =
    dansLOnglet.find((p) => p.id === choixPartial) ?? dansLOnglet[0] ?? null;
  const legalAffiche: ChoixLegal =
    choixLegal !== undefined ? choixLegal : (blocLegal?.legalTemplateId ?? null);

  const inserer = useCallback(async () => {
    if (envoi) return;
    setErreur(null);

    if (onglet === "legal") {
      const legalTemplateId = legalAffiche ?? undefined;
      if (blocLegal) {
        dispatch({ type: "updateBlock", blockId: blocLegal.id, patch: { legalTemplateId } as never });
        onSelect({ kind: "block", id: blocLegal.id });
      } else {
        if (doc.rows.length >= MAX_ROWS) {
          setErreur(`This email already has ${MAX_ROWS} rows — remove one before adding the legal footer.`);
          return;
        }
        // Pas de bloc légal : on l'ajoute à la fin, là où le compilateur et la publication l'attendent.
        const block = { id: newId("blk"), type: "footer_legal" as const, ...(legalTemplateId ? { legalTemplateId } : {}) };
        const row = newRowWith(block);
        dispatch({ type: "insertRow", row, index: doc.rows.length });
        onSelect({ kind: "block", id: block.id });
      }
      onClose();
      return;
    }

    if (!partialAffiche) return;
    setEnvoi(true);
    try {
      const rows: Row[] = await fetchPartialRows(partialAffiche.id);
      if (doc.rows.length + rows.length > MAX_ROWS) {
        setErreur(`This would take the email past ${MAX_ROWS} rows — remove some rows first.`);
        return;
      }
      // Header : tout en haut. Footer : juste avant le pied légal. Bloc : après la row sélectionnée.
      dispatch(actionImport(onglet, rows, doc, activeColumn));
      onSelect({ kind: "row", id: rows[0]!.id });
      onClose();
    } catch (e) {
      setErreur((e as Error).message);
    } finally {
      setEnvoi(false);
    }
  }, [envoi, onglet, legalAffiche, blocLegal, dispatch, onSelect, onClose, doc, activeColumn, partialAffiche]);

  const libelleAction =
    onglet === "header"
      ? "Insert at the top"
      : onglet === "block"
        ? `Insert ${ouInsererBloc(doc, activeColumn)}`
        : onglet === "footer"
          ? blocLegal
            ? "Insert above the legal footer"
            : "Insert at the end"
          : blocLegal
            ? "Use this legal footer"
            : "Add this legal footer";

  const pret = onglet === "legal" ? legal !== null : partialAffiche !== null;

  return (
    <Modal
      title="Import template"
      onClose={onClose}
      width="max-w-[900px]"
      footer={
        <>
          <p className="mr-auto max-w-[52ch] text-[11.5px] leading-snug text-muted-foreground">
            {onglet === "legal"
              ? "The legal footer stays linked: editing it in Templates › Legal footers updates every email that uses it. Unsubscribe links are always generated per recipient."
              : "A copy goes into this email. Edit it freely here — the library version doesn’t change, and changing the library later won’t touch this email."}
          </p>
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" disabled={!pret || envoi} onClick={() => void inserer()}>
            {envoi && <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />}
            {libelleAction}
          </Btn>
        </>
      }
    >
      <div role="tablist" aria-label="Template type" className="mb-3 flex gap-1.5">
        {ONGLETS.map(({ cle, label, icone: Icone }) => {
          const n =
            cle === "legal"
              ? legal
                ? legal.legalFooters.length + 1
                : null
              : partials
                ? entreesDeLOnglet(partials, cle).length
                : null;
          return (
            <button
              key={cle}
              role="tab"
              type="button"
              aria-selected={onglet === cle}
              onClick={() => {
                setOnglet(cle);
                setErreur(null);
              }}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-[9px] border px-3 py-[7px] text-[12.5px] font-medium transition-colors",
                onglet === cle
                  ? "border-brand-soft bg-brand-soft text-brand-soft-foreground"
                  : "border-border bg-card text-foreground/75 hover:bg-accent",
              )}
            >
              <Icone className="h-3.5 w-3.5" strokeWidth={1.9} />
              {label}
              {n !== null && <span className="tabular-nums opacity-70">{n}</span>}
            </button>
          );
        })}
        <Link
          href={onglet === "legal" ? "/templates?tab=legal" : "/templates?tab=brand"}
          target="_blank"
          className="ml-auto inline-flex items-center gap-1 self-center text-[12px] text-muted-foreground hover:text-foreground"
        >
          Manage library <ExternalLink className="h-3 w-3" strokeWidth={2} />
        </Link>
      </div>

      {erreurLecture ? (
        <Alerte>{erreurLecture}</Alerte>
      ) : partials === null || legal === null ? (
        <p className="flex items-center gap-1.5 py-10 text-[12.5px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} /> Loading the brand library…
        </p>
      ) : (
        <div className="grid gap-3 md:grid-cols-[230px_minmax(0,1fr)]">
          <ul className="flex flex-col gap-1" aria-label={`${onglet} templates`}>
            {onglet === "legal" ? (
              <>
                <Choix
                  nom="Brand default"
                  detail="The edition’s legal footer"
                  actif={legalAffiche === null}
                  enUsage={blocLegal !== null && blocLegal.legalTemplateId === null}
                  onClick={() => setChoixLegal(null)}
                />
                {legal.legalFooters.map((t) => (
                  <Choix
                    key={t.id}
                    nom={t.name}
                    actif={legalAffiche === t.id}
                    enUsage={blocLegal?.legalTemplateId === t.id}
                    onClick={() => setChoixLegal(t.id)}
                  />
                ))}
              </>
            ) : dansLOnglet.length === 0 ? (
              <li className="rounded-[9px] border border-dashed border-border px-3 py-3 text-[12px] leading-snug text-muted-foreground">
                No {onglet} in this brand’s library yet. Create one in{" "}
                <Link href="/templates?tab=brand" target="_blank" className="font-medium text-brand underline">
                  Templates › Headers, footers &amp; blocks
                </Link>
                {onglet === "block" && (
                  <>
                    , or use <span className="font-medium text-foreground/80">Save this row</span> on any row of this email
                  </>
                )}
                .
              </li>
            ) : (
              dansLOnglet.map((p) => (
                <Choix
                  key={p.id}
                  nom={p.name}
                  detail={`${p.rows.length} row${p.rows.length === 1 ? "" : "s"}`}
                  actif={partialAffiche?.id === p.id}
                  onClick={() => setChoixPartial(p.id)}
                />
              ))
            )}
          </ul>

          <div className="min-h-[260px] overflow-hidden rounded-[10px] border border-border bg-muted/30">
            {onglet === "legal" ? (
              <ApercuLegal library={legal} choix={legalAffiche} assetName={assetName} />
            ) : partialAffiche ? (
              <ApercuRows key={partialAffiche.id} partial={partialAffiche} doc={doc} />
            ) : null}
          </div>
        </div>
      )}

      {erreur && <Alerte className="mt-3">{erreur}</Alerte>}
    </Modal>
  );
}

function Choix({
  nom,
  detail,
  actif,
  enUsage = false,
  onClick,
}: {
  nom: string;
  detail?: string;
  actif: boolean;
  enUsage?: boolean;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        aria-pressed={actif}
        onClick={onClick}
        className={cn(
          "flex w-full items-center gap-2 rounded-[9px] border px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40",
          actif ? "border-brand bg-brand-soft/60" : "border-border bg-card hover:border-brand/60",
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-medium">{nom}</span>
          {detail && <span className="block truncate text-[11px] text-muted-foreground">{detail}</span>}
        </span>
        {enUsage && (
          <span className="inline-flex shrink-0 items-center gap-1 text-[10.5px] font-medium text-[#1f7a47]">
            <Check className="h-3 w-3" strokeWidth={2.2} /> In use
          </span>
        )}
      </button>
    </li>
  );
}

/**
 * Aperçu d'un header, d'un footer ou d'un bloc AVEC LE THÈME DE CET E-MAIL — c'est là qu'il va vivre. Même route que
 * l'aperçu du builder : ce qu'on montre est ce que le compilateur produit.
 */
function ApercuRows({ partial, doc }: { partial: PartialEntry; doc: EmailDoc }) {
  const [html, setHtml] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  useEffect(() => {
    let annule = false;
    (async () => {
      try {
        const res = await fetch("/api/builder/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            doc: {
              schema: 2,
              meta: { subject: partial.name, preheader: "", assetSlug: doc.meta.assetSlug, locale: doc.meta.locale },
              theme: doc.theme,
              rows: partial.rows,
            },
          }),
        });
        const data = (await res.json()) as { html?: string; error?: string };
        if (annule) return;
        if (!res.ok) setErreur(data.error ?? `preview failed (${res.status})`);
        else setHtml(data.html ?? "");
      } catch (e) {
        if (!annule) setErreur((e as Error).message);
      }
    })();
    return () => {
      annule = true;
    };
    // Le thème est lu à l'ouverture : l'aperçu n'a pas à se recompiler pendant qu'on édite derrière.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partial]);

  if (erreur) return <p className="p-4 text-[12.5px] text-amber-800">{erreur}</p>;
  if (html === null) {
    return (
      <p className="flex items-center gap-1.5 p-4 text-[12.5px] text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} /> Compiling…
      </p>
    );
  }
  // `sandbox` vide : du HTML d'e-mail n'a rien à exécuter dans l'admin.
  return <iframe title={`Preview of ${partial.name}`} srcDoc={html} sandbox="" className="h-[340px] w-full bg-white" />;
}

function ApercuLegal({
  library,
  choix,
  assetName,
}: {
  library: LegalLibrary;
  choix: ChoixLegal;
  assetName: string;
}) {
  const cfg = choix === null ? library.defaultConfig : library.legalFooters.find((t) => t.id === choix)?.config;
  if (!cfg) {
    return (
      <p className="p-4 text-[12.5px] text-muted-foreground">
        {choix === null
          ? "This brand has no edition yet, so there is no default legal footer to show."
          : "This legal footer is no longer in the library (archived). Emails that already use it keep it; pick another one to change."}
      </p>
    );
  }
  const edition = library.editions[0];
  return (
    <div>
      <iframe
        title="Legal footer preview"
        srcDoc={legalFooterPreviewHtml(cfg, edition, assetName)}
        sandbox=""
        className="h-[300px] w-full bg-white"
      />
      {edition && (
        <p className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
          Shown as the {edition.market} · {edition.language} edition receives it. Links are placeholders here.
        </p>
      )}
    </div>
  );
}

function Alerte({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={cn("flex items-start gap-1.5 text-[12px] leading-snug text-[#a33]", className)}>
      <AlertTriangle className="mt-[2px] h-3.5 w-3.5 shrink-0" strokeWidth={2} />
      {children}
    </p>
  );
}
