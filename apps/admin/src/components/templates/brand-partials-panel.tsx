"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, Archive, Blocks, Eye, PanelTop, PanelBottom, Pencil, Plus, SquarePen, X } from "lucide-react";
import { newBlock, newRowWith } from "@/components/builder/factories";
import type { PartialSlot } from "@/components/templates/library-client";
import { Btn, Card, CardHead } from "@/components/ui";
import { cn } from "@/lib/utils";

/**
 * Les classes d'un `Btn` par défaut, pour un `<Link>` qui doit lui ressembler. Le dépôt recopie
 * déjà ces classes ailleurs (`(dashboard)/error.tsx`, `not-found.tsx`) : `Btn` rend un `<button>`
 * et n'accepte pas de `as`.
 */
const LIEN_BOUTON =
  "inline-flex items-center gap-2 rounded-[9px] border border-border bg-card px-3.5 py-2 text-[13px] font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 focus-visible:ring-offset-2";

/**
 * EN-TÊTE ET PIED DE MARQUE — la bibliothèque, sur l'écran des modèles.
 *
 * ⛔ POURQUOI CE PANNEAU EST PERMANENT, comme celui du cycle de vie. Un affichage piloté par les
 * INSTANCES est vide par construction tant qu'aucune n'existe — et c'est exactement le moment où
 * l'on cherche l'endroit pour en créer une. Le panneau tournait déjà en rond une fois sur cet écran :
 * pour voir un badge il fallait un rattachement, et pour en créer un il fallait ouvrir la fiche
 * introuvable. Les trois fentes sont donc toujours affichées, à zéro partial comme à dix.
 *
 * ⛔ « JE NE SAIS PAS » NE S'ÉCRIT PAS « AUCUN ». Une lecture ratée affiche un bandeau, jamais l'état
 * vide : dire « cette marque n'a pas d'en-tête » sur une panne invite à en recréer un par-dessus
 * celui qui existe — et le nom serait alors refusé en 409, sans que rien n'explique pourquoi.
 *
 * ⛔ UNE BIBLIOTHÈQUE, PAS UN RATTACHEMENT (Alix, 16/09). On crée autant de headers et de footers
 * qu'on veut ; le builder les IMPORTE par copie (« Import template »). Le bouton « Apply to… » et le
 * compteur « used by N templates » appartenaient au modèle à pointeurs, qu'Alix a écarté.
 *
 * ⭐ TROISIÈME SECTION, « Blocks » (Alix, 23/09 : « des blocks qu'on peut importer où on veut »). Même
 * table, mêmes gestes (New, Preview, Rename, Archive, Edit). Seule différence : pas de « Create from a
 * template » — un bloc n'a pas de place fixe dans un modèle, donc pas de row désignée à lever. Il
 * naît vide ici, ou par « Save this row » dans le builder.
 */

export interface BrandPartialVu {
  id: string;
  slot: PartialSlot;
  name: string;
  updatedAt: string;
  /** Les rows, pour l'aperçu — le panneau ne les modifie jamais. */
  rows: unknown[];
}

interface ModeleProposable {
  id: string;
  name: string;
}

const FENTES: {
  slot: PartialSlot;
  titre: string;
  icone: typeof PanelTop;
  /** Ce que l'état vide propose : un bloc ne se lève pas d'un modèle, il se compose ou s'enregistre. */
  vide: string;
  /** Toute la largeur, liste sur deux colonnes : les blocs seront nombreux (31 prévus au 23/09). */
  large?: boolean;
}[] = [
  {
    slot: "header",
    titre: "Header",
    icone: PanelTop,
    vide: "No shared header yet. Imported at the very top of an email. If your templates already carry one, “Create from a template…” lifts it out; otherwise “New” starts an empty one you can edit.",
  },
  {
    slot: "footer",
    titre: "Footer",
    icone: PanelBottom,
    vide: "No shared footer yet. Imported just above the legal footer — never in its place. If your templates already carry one, “Create from a template…” lifts it out; otherwise “New” starts an empty one you can edit.",
  },
  {
    slot: "block",
    titre: "Blocks",
    icone: Blocks,
    vide: "No block yet. A block is one or more rows you can import wherever you want in an email. “New” starts an empty one; in the builder, “Save this row” on any row adds it here.",
    large: true,
  },
];

export function BrandPartialsPanel({
  partials,
  known,
  brandKnown,
  assetSlug,
  templates,
}: {
  partials: BrandPartialVu[];
  known: boolean;
  brandKnown: boolean;
  assetSlug: string;
  templates: ModeleProposable[];
}) {
  const [apercu, setApercu] = useState<BrandPartialVu | null>(null);
  const [extraction, setExtraction] = useState(false);
  const [creation, setCreation] = useState<PartialSlot | null>(null);
  const [renommage, setRenommage] = useState<BrandPartialVu | null>(null);
  const [archivage, setArchivage] = useState<BrandPartialVu | null>(null);

  return (
    <Card className="mb-4">
      <CardHead
        title="Headers, footers & blocks"
        sub="Build as many as you like, then add them to any email with “Import template” in the builder. An import is a copy: editing it here doesn’t change emails already built."
        right={
          brandKnown && templates.length > 0 ? (
            <Btn onClick={() => setExtraction(true)}>Create from a template…</Btn>
          ) : undefined
        }
      />

      {!brandKnown ? (
        <Bandeau>
          Database unavailable — the brand could not be resolved, so its headers, footers and blocks
          cannot be listed.
        </Bandeau>
      ) : !known ? (
        <Bandeau>
          This library could not be read. This is not the same as having none — nothing is missing, the
          list simply did not load.
        </Bandeau>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {FENTES.map(({ slot, titre, icone: Icone, vide, large }) => {
            const dansLaFente = partials.filter((p) => p.slot === slot);
            return (
              <div
                key={slot}
                className={cn("rounded-[10px] border border-border bg-card/60 p-3", large && "md:col-span-2")}
              >
                <div className="mb-2 flex items-center gap-2">
                  <Icone className="h-4 w-4 text-brand" strokeWidth={1.9} />
                  <span className="text-[13px] font-semibold">{titre}</span>
                  <span className="text-[11.5px] tabular-nums text-muted-foreground">
                    {dansLaFente.length}
                  </span>
                  {/* ⛔ « New » est dans CHAQUE fente, y compris quand elle est vide : une marque qui
                      n'a aucun pied de page est justement celle qui a besoin d'en composer un, et
                      « Create from a template… » ne l'aide pas si ses modèles n'en portent pas. */}
                  <Btn
                    variant="ghost"
                    className="ml-auto"
                    onClick={() => setCreation(slot)}
                    aria-label={`New ${slot}`}
                  >
                    <Plus className="h-3.5 w-3.5" strokeWidth={1.9} />
                    New
                  </Btn>
                </div>

                {dansLaFente.length === 0 ? (
                  <p className="text-[12.5px] leading-relaxed text-muted-foreground">
                    {/* L'état vide dit ce qu'il faut FAIRE, pas seulement qu'il n'y a rien. */}
                    {vide}
                  </p>
                ) : (
                  <ul className={cn("space-y-1.5", large && "md:grid md:grid-cols-2 md:gap-1.5 md:space-y-0")}>
                    {dansLaFente.map((p) => (
                      <li
                        key={p.id}
                        className="flex items-center justify-between gap-2 rounded-[8px] border border-border bg-background px-2.5 py-2"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-[12.5px] font-medium">{p.name}</div>
                          <div className="text-[11.5px] text-muted-foreground">
                            {p.rows.length} row{p.rows.length === 1 ? "" : "s"}
                          </div>
                        </div>
                        {/* Actions secondaires en icônes : avec quatre libellés, la colonne ne laissait
                            qu'une douzaine de caractères au nom, et deux headers d'une même marque
                            devenaient indiscernables (« Harbor Tech he… »). */}
                        <div className="flex shrink-0 items-center justify-end gap-0.5">
                          <Btn
                            variant="ghost"
                            className="px-2"
                            onClick={() => setApercu(p)}
                            aria-label={`Preview ${p.name}`}
                            title="Preview"
                          >
                            <Eye className="h-3.5 w-3.5" strokeWidth={1.9} />
                          </Btn>
                          <Btn
                            variant="ghost"
                            className="px-2"
                            onClick={() => setRenommage(p)}
                            aria-label={`Rename ${p.name}`}
                            title="Rename"
                          >
                            <Pencil className="h-3.5 w-3.5" strokeWidth={1.9} />
                          </Btn>
                          <Btn
                            variant="ghost"
                            className="px-2"
                            onClick={() => setArchivage(p)}
                            aria-label={`Archive ${p.name}`}
                            title="Archive"
                          >
                            <Archive className="h-3.5 w-3.5" strokeWidth={1.9} />
                          </Btn>
                          {/* Un lien, pas un bouton : l'édition est une PAGE, donc elle doit
                              pouvoir s'ouvrir dans un onglet. `Btn` rend toujours un <button>. */}
                          <Link
                            href={`/templates/partials/${p.id}`}
                            className={LIEN_BOUTON}
                            aria-label={`Edit ${p.name}`}
                          >
                            <SquarePen className="h-3.5 w-3.5" strokeWidth={1.9} />
                            Edit
                          </Link>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}

      {apercu && <ApercuPartial partial={apercu} assetSlug={assetSlug} onClose={() => setApercu(null)} />}
      {extraction && (
        <ExtraireDUnModele templates={templates} onClose={() => setExtraction(false)} />
      )}
      {creation && <CreerPartial slot={creation} onClose={() => setCreation(null)} />}
      {renommage && <RenommerPartial partial={renommage} onClose={() => setRenommage(null)} />}
      {archivage && <ArchiverPartial partial={archivage} onClose={() => setArchivage(null)} />}
    </Card>
  );
}

function Bandeau({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

/**
 * L'aperçu passe par `POST /api/builder/preview` — la MÊME route que l'aperçu du builder.
 *
 * ⛔ Un second chemin de rendu finirait par ne plus ressembler au premier : ce qu'on montre ici doit
 * être ce que le compilateur produit, pas une approximation HTML écrite à côté.
 */
export function ApercuPartial({
  partial,
  assetSlug,
  onClose,
}: {
  partial: BrandPartialVu;
  assetSlug: string;
  onClose: () => void;
}) {
  const [html, setHtml] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  // ⛔ DANS UN EFFET, PAS DANS LE RENDU. Lancé pendant le rendu, cet appel repartirait à chaque
  // re-rendu — y compris à chaque `setState` qu'il provoque lui-même. `annule` couvre la fermeture
  // de la modale avant la réponse : écrire dans un composant démonté n'apprend rien à personne.
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
              meta: { subject: partial.name, preheader: "", assetSlug },
              theme: {},
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
  }, [partial, assetSlug]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Preview of ${partial.name}`}
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-[14px] border border-border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="min-w-0">
            <div className="text-[13.5px] font-semibold">{partial.name}</div>
            {/*
              ⛔ ON DIT CE QU'ON NE MONTRE PAS. Le partial ne transporte JAMAIS le thème (D7) : ses
              couleurs viennent du modèle qui l'applique, et les quatre modèles Copper Kettle portent
              quatre thèmes différents pour un en-tête identique à l'octet près. Cet aperçu compile
              donc avec les couleurs par défaut. Le taire ferait juger un fond qui n'existe nulle
              part ; y mettre le thème d'un modèle choisi au hasard serait une fausse précision.
            */}
            <div className="text-[11.5px] text-muted-foreground">
              Preview uses default theme colours — each template applies its own.
            </div>
          </div>
          <Btn variant="ghost" onClick={onClose} aria-label="Close preview">
            <X className="h-4 w-4" strokeWidth={1.9} />
          </Btn>
        </div>
        <div className="min-h-[220px] flex-1 overflow-auto bg-muted/30">
          {erreur ? (
            <p className="p-4 text-[12.5px] text-amber-800">{erreur}</p>
          ) : html === null ? (
            <p className="p-4 text-[12.5px] text-muted-foreground">Compiling…</p>
          ) : (
            // `sandbox` vide : l'aperçu est du HTML d'e-mail, il n'a aucune raison d'exécuter quoi
            // que ce soit dans l'admin.
            <iframe title={`Preview of ${partial.name}`} srcDoc={html} sandbox="" className="h-[60vh] w-full bg-white" />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * H5 minimal — LIFTER l'en-tête d'un modèle existant.
 *
 * ⛔ SANS CE GESTE, LA BIBLIOTHÈQUE RESTE VIDE. Les en-têtes existent déjà, copiés-collés dans chaque
 * modèle : sur Copper Kettle, les quatre modèles portent la MÊME première row, à l'octet près.
 * Demander à quelqu'un de recomposer à la main ce qui est déjà là serait la façon la plus sûre de
 * rendre cette bibliothèque inutile.
 */
function ExtraireDUnModele({
  templates,
  onClose,
}: {
  templates: ModeleProposable[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  const [slot, setSlot] = useState<"header" | "footer">("header");
  const [name, setName] = useState("");
  const [envoi, setEnvoi] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  async function soumettre() {
    setEnvoi(true);
    setErreur(null);
    try {
      const res = await fetch("/api/builder/brand-partials/from-template", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ templateId, slot, name: name.trim() }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setErreur(data.error ?? `could not create the ${slot} (${res.status})`);
        return;
      }
      onClose();
      router.refresh();
    } catch (e) {
      setErreur((e as Error).message);
    } finally {
      setEnvoi(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Create a brand header or footer from a template"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-[14px] border border-border bg-card p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 text-[14px] font-semibold">Create from a template</div>
        <p className="mb-3 text-[12.5px] leading-relaxed text-muted-foreground">
          Lifts the top row (header) or the row just above the legal footer (footer) out of a
          template’s current draft. The template itself is not changed.
        </p>

        <label className="mb-2 block text-[12.5px]">
          <span className="mb-1 block font-medium">Template</span>
          <select
            className="w-full rounded-[8px] border border-border bg-background px-2.5 py-2 text-[12.5px]"
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value)}
          >
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>

        <div className="mb-2 flex gap-2">
          {(["header", "footer"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSlot(s)}
              className={cn(
                "flex-1 rounded-[8px] border px-3 py-2 text-[12.5px] font-medium capitalize transition-colors",
                slot === s
                  ? "border-brand-soft bg-brand-soft text-brand-soft-foreground"
                  : "border-border bg-background text-foreground/75 hover:bg-accent",
              )}
            >
              {s}
            </button>
          ))}
        </div>

        <label className="mb-3 block text-[12.5px]">
          <span className="mb-1 block font-medium">Name</span>
          <input
            className="w-full rounded-[8px] border border-border bg-background px-2.5 py-2 text-[12.5px]"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Brand header"
          />
        </label>

        {erreur && <p className="mb-2 text-[12.5px] text-amber-800">{erreur}</p>}

        <div className="flex justify-end gap-2">
          <Btn variant="ghost" onClick={onClose}>
            Cancel
          </Btn>
          <Btn onClick={soumettre} disabled={envoi || !templateId || !name.trim()}>
            {envoi ? "Creating…" : "Create"}
          </Btn>
        </div>
      </div>
    </div>
  );
}

/** Coquille commune aux trois petites boîtes ci-dessous — même cadre que « Create from a template ». */
function Boite({
  titre,
  aide,
  label,
  onClose,
  children,
}: {
  titre: string;
  aide: string;
  label: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-[14px] border border-border bg-card p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 text-[14px] font-semibold">{titre}</div>
        <p className="mb-3 text-[12.5px] leading-relaxed text-muted-foreground">{aide}</p>
        {children}
      </div>
    </div>
  );
}

/**
 * Composer un en-tête ou un pied de A à Z.
 *
 * ⛔ POURQUOI CE GESTE MANQUAIT, ET À QUI IL SERT. « Create from a template… » ne sait que LEVER ce
 * qu'un modèle porte déjà. Deux marques n'ont aucun modèle, et deux autres n'ont aucun pied de page
 * à lever : sans ce bouton, elles n'avaient AUCUN chemin vers une bibliothèque de marque.
 *
 * ⚠️ Le partial naît avec une row de texte, jamais vide : le serveur refuse `rows: []` (422), et à
 * juste titre — un partial sans row se résout en « aucune row » et l'e-mail partirait sans son
 * en-tête. Cette row est un point de départ visible, que l'éditeur ouvre aussitôt.
 *
 * Un BLOC naît de la même façon : c'est le seul chemin vers un bloc hors du builder (« Save this row »).
 */
const PLACEHOLDER: Record<PartialSlot, string> = {
  header: "Brand header",
  footer: "Brand footer",
  block: "Podcast banner",
};

function CreerPartial({ slot, onClose }: { slot: PartialSlot; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [envoi, setEnvoi] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  async function soumettre() {
    setEnvoi(true);
    setErreur(null);
    try {
      const res = await fetch("/api/builder/brand-partials", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slot,
          name: name.trim(),
          rows: [newRowWith(newBlock("text"))],
        }),
      });
      const data = (await res.json()) as { id?: string; error?: string };
      if (!res.ok || !data.id) {
        setErreur(data.error ?? `could not create the ${slot} (${res.status})`);
        return;
      }
      // On enchaîne sur l'éditeur : un partial qui ne contient qu'un texte d'amorce n'a aucun
      // intérêt tant qu'on ne l'a pas composé, et personne ne devrait avoir à le retrouver.
      router.push(`/templates/partials/${data.id}`);
    } catch (e) {
      setErreur((e as Error).message);
    } finally {
      setEnvoi(false);
    }
  }

  return (
    <Boite
      titre={`New ${slot}`}
      aide={`Starts an empty ${slot} for this brand and opens it in the editor. Once saved, import it into any email from the builder.`}
      label={`Create a brand ${slot}`}
      onClose={onClose}
    >
      <label className="mb-3 block text-[12.5px]">
        <span className="mb-1 block font-medium">Name</span>
        <input
          className="w-full rounded-[8px] border border-border bg-background px-2.5 py-2 text-[12.5px]"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={PLACEHOLDER[slot]}
          autoFocus
        />
      </label>

      {erreur && <p className="mb-2 text-[12.5px] text-amber-800">{erreur}</p>}

      <div className="flex justify-end gap-2">
        <Btn variant="ghost" onClick={onClose}>
          Cancel
        </Btn>
        <Btn onClick={soumettre} disabled={envoi || !name.trim()}>
          {envoi ? "Creating…" : "Create and edit"}
        </Btn>
      </div>
    </Boite>
  );
}

/**
 * Renommer — le seul moyen de corriger un nom, et le nom est la seule prise de l'auteur sur sa
 * bibliothèque. `baseUpdatedAt` part avec le PATCH : renommer ne doit pas écraser en silence une
 * édition faite ailleurs entre-temps.
 */
function RenommerPartial({ partial, onClose }: { partial: BrandPartialVu; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(partial.name);
  const [envoi, setEnvoi] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  async function soumettre() {
    setEnvoi(true);
    setErreur(null);
    try {
      const res = await fetch(`/api/builder/brand-partials/${partial.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), baseUpdatedAt: partial.updatedAt }),
      });
      const data = (await res.json()) as { error?: string; kind?: "name_taken" | "stale" };
      if (res.status === 409 && data.kind === "stale") {
        // ⛔ `partial.updatedAt` EST FIGÉ AU RENDU SERVEUR DE LA LISTE. Si ce partial a été enregistré
        // depuis — y compris par l'auteur lui-même, depuis l'éditeur, puis retour par le lien « Back »
        // sur un cache de routeur périmé — le compare-and-swap refuse. Et réessayer renvoie le MÊME
        // horodatage périmé, donc le même 409, indéfiniment : sans cette phrase, l'écran affichait un
        // code nu sur la seule issue qui existe.
        //
        // ⛔ SUR CE `kind` SEULEMENT. Un nom déjà pris rend AUSSI un 409, et lui dire de recharger la
        // page était une impasse : le nom appartient à un autre partial, recharger ne le libérera
        // jamais. Son message à lui (« another library item… already has that name ») est déjà
        // juste et actionnable — il passe par la branche ci-dessous.
        setErreur(
          `This ${partial.slot} was saved elsewhere while this list was open. Reload the page, then rename it.`,
        );
        return;
      }
      if (!res.ok) {
        setErreur(data.error ?? `could not rename this ${partial.slot} (${res.status})`);
        return;
      }
      onClose();
      router.refresh();
    } catch (e) {
      setErreur((e as Error).message);
    } finally {
      setEnvoi(false);
    }
  }

  return (
    <Boite
      titre="Rename"
      aide="Only the name changes. Emails that already imported it keep their copy."
      label={`Rename ${partial.name}`}
      onClose={onClose}
    >
      <label className="mb-3 block text-[12.5px]">
        <span className="mb-1 block font-medium">Name</span>
        <input
          className="w-full rounded-[8px] border border-border bg-background px-2.5 py-2 text-[12.5px]"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
      </label>

      {erreur && <p className="mb-2 text-[12.5px] text-amber-800">{erreur}</p>}

      <div className="flex justify-end gap-2">
        <Btn variant="ghost" onClick={onClose}>
          Cancel
        </Btn>
        <Btn onClick={soumettre} disabled={envoi || !name.trim() || name.trim() === partial.name}>
          {envoi ? "Saving…" : "Save"}
        </Btn>
      </div>
    </Boite>
  );
}

/**
 * Archiver — invariant 4 : on RETIRE de la bibliothèque, on ne détruit jamais.
 *
 * ⛔ CE QUE LA BOÎTE DOIT DIRE, ET POURQUOI. Les modèles qui pointent déjà dessus continuent de se
 * compiler avec : archiver ne casse rien chez eux. Ce qu'on perd, c'est la possibilité de
 * l'appliquer à un NOUVEAU modèle. Écrire « delete » ou laisser croire à une disparition ferait
 * hésiter sur un geste sans danger — ou pire, chercher ensuite pourquoi l'en-tête est toujours là.
 *
 * ⛔ « usage unknown » N'EST PAS « 0 ». Sur une lecture ratée, la boîte le dit au lieu d'afficher un
 * zéro rassurant sous un bouton d'archivage.
 */
function ArchiverPartial({ partial, onClose }: { partial: BrandPartialVu; onClose: () => void }) {
  const router = useRouter();
  const [envoi, setEnvoi] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  async function soumettre() {
    setEnvoi(true);
    setErreur(null);
    try {
      const res = await fetch(`/api/builder/brand-partials/${partial.id}`, { method: "DELETE" });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setErreur(data.error ?? `could not archive this ${partial.slot} (${res.status})`);
        return;
      }
      onClose();
      router.refresh();
    } catch (e) {
      setErreur((e as Error).message);
    } finally {
      setEnvoi(false);
    }
  }

  return (
    <Boite
      titre={`Archive “${partial.name}”`}
      aide="It leaves the library, so it can no longer be imported. Emails that already imported it keep their copy, unchanged."
      label={`Archive ${partial.name}`}
      onClose={onClose}
    >

      {erreur && <p className="mb-2 text-[12.5px] text-amber-800">{erreur}</p>}

      <div className="flex justify-end gap-2">
        <Btn variant="ghost" onClick={onClose}>
          Cancel
        </Btn>
        <Btn onClick={soumettre} disabled={envoi}>
          {envoi ? "Archiving…" : "Archive"}
        </Btn>
      </div>
    </Boite>
  );
}
