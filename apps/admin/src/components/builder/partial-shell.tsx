"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowLeft, Check, Eye, Loader2 } from "lucide-react";
import { EmailDoc, MAX_BRAND_PARTIAL_ROWS, type Row } from "@nf/render/schema";
import { Canvas, type ActiveColumn, type Selection } from "@/components/builder/canvas";
import { Inspector } from "@/components/builder/inspector";
import { Palette } from "@/components/builder/palette";
import { builderReducer, initBuilderState } from "@/components/builder/reducer";
import { ApercuPartial } from "@/components/templates/brand-partials-panel";
import type { PartialSlot } from "@/components/templates/library-client";
import { Btn } from "@/components/ui";

/**
 * ÉDITER UN EN-TÊTE, UN PIED OU UN BLOC DE MARQUE — la même palette, le même canevas, le même
 * inspecteur que le builder de modèles.
 *
 * ⛔ POURQUOI RÉUTILISER ET NE PAS ÉCRIRE UN SECOND ÉDITEUR. Canvas, Palette, Inspector et le
 * réducteur sont déjà purs à props : ils prennent un `EmailDoc` et un `dispatch`, rien d'autre. Un
 * éditeur « léger » écrit à côté commencerait par ne pas savoir faire les colonnes, puis divergerait
 * sur le glisser-déposer, et un jour un bloc s'éditerait autrement ici que dans un modèle.
 *
 * ⚠️ LE DOCUMENT EST SYNTHÉTIQUE. Un partial n'est qu'une LISTE DE ROWS : il n'a ni sujet, ni
 * preheader, ni thème. On l'enveloppe donc dans un `EmailDoc` minimal pour le temps de l'édition, et
 * seules `rows` sont réécrites. Le thème affiché est celui par défaut, jamais celui d'un modèle :
 * chaque modèle applique le sien à la compilation, et en choisir un ici afficherait une couleur que
 * personne ne verra.
 *
 * ⛔ AUCUN PANNEAU DE PRÉ-VOL ICI. Le pré-vol exige un pied légal (`footerCount === 0` est bloquant)
 * et un partial n'en a par construction jamais : le monter afficherait un rouge permanent sur un
 * document parfaitement valide.
 */

export interface PartialAEditer {
  id: string;
  slot: PartialSlot;
  name: string;
  rows: unknown[];
  updatedAt: string;
}

/** Ce que l'écran sait de son enregistrement. `conflit` est terminal : il faut recharger. */
type Etat =
  | { kind: "propre" }
  | { kind: "modifie" }
  | { kind: "envoi" }
  | { kind: "enregistre"; a: number }
  | { kind: "conflit"; par: string | null }
  | { kind: "erreur"; message: string };

const DELAI_AUTOSAVE = 1200;

export function PartialShell({
  partial,
  assetSlug,
}: {
  partial: PartialAEditer;
  assetSlug: string;
}) {
  const router = useRouter();

  // `EmailDoc.parse` applique les défauts du schéma (thème compris) : le document de travail est
  // donc valide dès le premier rendu, sans qu'on ait à inventer un thème.
  const docInitial = useMemo(
    () =>
      EmailDoc.parse({
        schema: 2,
        meta: { subject: "", preheader: "", assetSlug, locale: "en" },
        theme: {},
        rows: partial.rows,
      }),
    [partial.rows, assetSlug],
  );

  // Le plafond du serveur (422 au-delà de 20 rows) est appliqué dès le geste, par le réducteur.
  const [state, dispatch] = useReducer(builderReducer, docInitial, (d) => initBuilderState(d, MAX_BRAND_PARTIAL_ROWS));
  const doc = state.present;

  const [selection, setSelection] = useState<Selection>(null);
  const [activeColumn, setActiveColumn] = useState<ActiveColumn | null>(null);
  const [etat, setEtat] = useState<Etat>({ kind: "propre" });
  const [apercu, setApercu] = useState(false);

  // L'horodatage du serveur, pour le compare-and-swap. Dans une ref : chaque enregistrement le
  // remplace, et le relire dans une dépendance d'effet relancerait l'enregistrement en boucle.
  const horodatage = useRef(partial.updatedAt);
  // Les rows telles que le serveur les a. Sert à savoir si l'auteur a vraiment changé quelque chose :
  // un `useReducer` rend un nouvel objet à chaque action, y compris une sélection sans effet.
  const rowsEnregistrees = useRef(JSON.stringify(docInitial.rows));

  /**
   * ⛔ UN SEUL PATCH EN VOL À LA FOIS.
   *
   * `horodatage` n'est remplacé qu'au RETOUR d'un enregistrement. Deux envois concurrents portent
   * donc le MÊME `baseUpdatedAt`, et le compare-and-swap refuse le second en 409 : un conflit
   * AUTO-INFLIGÉ — terminal, donc qui GÈLE l'autosave — alors que personne d'autre n'a touché au
   * partial. Le débounce ne protège de rien ici : il suffit que la requête dure plus de 1 200 ms.
   * Sa seconde vertu est de rendre impossible qu'une réponse en vol vienne réécrire l'état
   * « conflit » en « Saved » vert sur des rows que le serveur venait de refuser.
   */
  const enVol = useRef(false);
  /**
   * ⛔ LES ROWS DONT LE DERNIER ENVOI A ÉCHOUÉ, ET POURQUOI ELLES EXISTENT.
   *
   * Premier réflexe : ne réveiller l'autosave que sur un SUCCÈS, pour qu'une panne serveur
   * persistante ne reboucle pas toutes les 1 200 ms. **C'était une perte de travail** : une frappe
   * arrivée pendant un envoi est refusée par `enVol`, donc elle n'a plus de minuteur à elle — et si
   * cet envoi échoue, plus rien ne la réveille. Elle ne partait JAMAIS, alors qu'avant ce verrou
   * elle partait (au prix d'un 409 auto-infligé). Corriger un défaut en en créant un pire.
   *
   * On réveille donc TOUJOURS, et on refuse seulement de rejouer la charge EXACTE qui vient de
   * tomber : la frappe suivante repart, la tempête de requêtes n'a pas lieu.
   */
  const rowsEchouees = useRef<string | null>(null);
  const [reveil, setReveil] = useState(0);

  const enregistrer = useCallback(
    async (rows: Row[]): Promise<boolean> => {
      if (enVol.current) return false;
      enVol.current = true;
      const serialisees = JSON.stringify(rows);
      setEtat({ kind: "envoi" });
      try {
        const res = await fetch(`/api/builder/brand-partials/${partial.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ rows, baseUpdatedAt: horodatage.current }),
        });
        const data = (await res.json()) as {
          updatedAt?: string;
          updatedBy?: string | null;
          error?: string;
        };

        if (res.status === 409) {
          // ⛔ ON N'ÉCRASE PAS, ET ON NE RÉESSAIE PAS. Quelqu'un a enregistré entre-temps ; réessayer
          // avec le nouvel horodatage ferait exactement ce que le compare-and-swap existe pour
          // empêcher. L'auteur doit recharger et décider.
          setEtat({ kind: "conflit", par: data.updatedBy ?? null });
          return false;
        }
        if (!res.ok) {
          rowsEchouees.current = serialisees;
          setEtat({ kind: "erreur", message: data.error ?? `could not save (${res.status})` });
          return false;
        }

        if (data.updatedAt) horodatage.current = data.updatedAt;
        rowsEnregistrees.current = serialisees;
        rowsEchouees.current = null;
        setEtat({ kind: "enregistre", a: Date.now() });
        return true;
      } catch (e) {
        rowsEchouees.current = serialisees;
        setEtat({ kind: "erreur", message: (e as Error).message });
        return false;
      } finally {
        enVol.current = false;
        /*
         * ⛔ TOUJOURS, ÉCHEC COMPRIS. Les frappes arrivées PENDANT cet envoi ont été refusées par
         * `enVol` et n'ont plus de minuteur : ce réveil est le SEUL chemin qui les fasse partir.
         * Ce qui empêche la tempête de requêtes n'est pas de se taire ici, c'est `rowsEchouees`,
         * que l'effet consulte avant de replanifier.
         */
        setReveil((n) => n + 1);
      }
    },
    [partial.id],
  );

  // Autosave, comme le builder de modèles : un partial édité puis fermé sans bouton « Save » ne doit
  // pas perdre le travail. Le débounce évite un PATCH par frappe.
  useEffect(() => {
    if (etat.kind === "conflit") return; // terminal : plus rien ne part tant qu'on n'a pas rechargé
    const serialisees = JSON.stringify(doc.rows);
    if (serialisees === rowsEnregistrees.current) return;
    // ⛔ CE QUI EMPÊCHE LA TEMPÊTE DE REQUÊTES. Le réveil est inconditionnel (voir `rowsEchouees`),
    // donc c'est ICI qu'on refuse de rejouer la charge exacte qui vient d'échouer : sur une panne
    // serveur persistante, l'écran attend une nouvelle frappe au lieu de repartir toutes les 1,2 s.
    if (serialisees === rowsEchouees.current) return;

    setEtat((e) => (e.kind === "envoi" ? e : { kind: "modifie" }));
    const t = setTimeout(() => void enregistrer(doc.rows), DELAI_AUTOSAVE);
    return () => clearTimeout(t);
    // `etat` est volontairement hors des dépendances : le relire relancerait le minuteur à chaque
    // changement d'état d'enregistrement, donc en boucle. `reveil` y est, lui : c'est le seul moyen
    // pour les frappes arrivées pendant un envoi de retrouver un minuteur.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.rows, enregistrer, reveil]);

  // Fermer l'onglet avec un enregistrement en attente perdrait le travail sans rien dire.
  useEffect(() => {
    const enAttente = etat.kind === "modifie" || etat.kind === "envoi";
    if (!enAttente) return;
    const garde = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", garde);
    return () => window.removeEventListener("beforeunload", garde);
  }, [etat.kind]);

  const partialPourApercu = useMemo(
    () => ({ ...partial, rows: doc.rows as unknown[] }),
    [partial, doc.rows],
  );

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          {/* ⛔ `beforeunload` NE COUVRE PAS UNE NAVIGATION INTERNE. Next.js change de page sans
              décharger le document : le garde posé plus haut ne voit rien passer, et l'enregistrement
              encore en attente partait à la poubelle EN SILENCE — c'est-à-dire par le chemin le plus
              naturel de l'écran. On enregistre d'abord, et on ne quitte QUE si ça a réussi : sur un
              conflit ou une erreur, l'alerte est déjà là et l'auteur doit la voir.
              ⛔ `modifie` SEULEMENT, PAS `envoi` : un PATCH déjà parti aboutit même si le composant
              est démonté (la navigation douce n'annule pas le `fetch`), et l'intercepter rendrait le
              clic mort le temps de la requête. Ce qui se perd, c'est le minuteur de débounce PAS
              ENCORE ÉCOULÉ, que le nettoyage de l'effet annule au démontage. */}
          <Link
            href="/templates?tab=brand"
            onClick={(e) => {
              if (etat.kind !== "modifie") return;
              e.preventDefault();
              void enregistrer(doc.rows).then((ok) => {
                if (ok) router.push("/templates?tab=brand");
              });
            }}
            className="mb-1 inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.9} />
            Back to headers, footers &amp; blocks
          </Link>
          <h1 className="truncate text-[19px] font-semibold">{partial.name}</h1>
          <p className="text-[12.5px] text-muted-foreground">
            {/* Un bloc se pose où l'on veut : le dire ici, sinon l'auteur le compose comme un en-tête. */}
            {partial.slot === "block"
              ? "Brand block · import it anywhere in an email with “Import template” or “Saved blocks” in the builder"
              : `Brand ${partial.slot} · import it into any email with “Import template” in the builder`}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Indicateur etat={etat} />
          <Btn variant="ghost" onClick={() => setApercu(true)}>
            <Eye className="h-3.5 w-3.5" strokeWidth={1.9} />
            Preview
          </Btn>
        </div>
      </div>

      {etat.kind === "conflit" && (
        <Alerte>
          Someone else saved this {partial.slot}
          {etat.par ? ` (${etat.par})` : ""} while you had it open, so nothing you changed since has
          been saved — overwriting their work silently is exactly what we refuse to do.{" "}
          {/* ⛔ UN VRAI RECHARGEMENT, PAS `router.refresh()`. Le document de travail vit dans un
              `useReducer` initialisé AU MONTAGE, et `horodatage` dans une ref : rafraîchir le rendu
              serveur remplace les props mais NE RÉINITIALISE AUCUN état client. L'éditeur restait
              donc figé sur la version locale, cette alerte restait affichée, et l'autosave restait
              coupée par l'état terminal — le seul bouton de sortie de l'écran ne sortait de rien. */}
          <button
            type="button"
            className="font-semibold underline underline-offset-2"
            onClick={() => window.location.reload()}
          >
            Reload their version
          </button>{" "}
          and reapply your change.
        </Alerte>
      )}

      {etat.kind === "erreur" && <Alerte>{etat.message}</Alerte>}

      {/* ⛔ Ce que l'écran doit dire : l'import est une COPIE (décision d'Alix, 16/09). Sans cette
          phrase, on corrige ici en croyant corriger les e-mails qui l'ont déjà importé. */}
      <p className="mb-4 rounded-[10px] border border-border bg-card/60 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-muted-foreground">
        Changes here apply to the next imports. Emails that already imported this {partial.slot} keep
        their own copy — edit it in those emails if needed.
      </p>

      <div className="flex flex-col items-start gap-4 lg:flex-row">
        <Palette
          doc={doc}
          activeColumn={activeColumn}
          dispatch={dispatch}
          onSelect={setSelection}
          onSelectColumn={setActiveColumn}
          // Ni `onPasteHtml` ni `onImportWordPress` : ces deux gestes appartiennent à l'édition d'un
          // modèle, et la palette n'affiche pas un bouton qui n'a rien à faire.
          footerLegalInterdit
          maxRows={MAX_BRAND_PARTIAL_ROWS}
        />

        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex items-center justify-between text-[11px] text-muted-foreground/80">
            <span>Compiled rendering — each template applies its own theme colours to these rows.</span>
            <span className="tabular-nums">{doc.theme.contentWidth}px content width</span>
          </div>
          <div className="overflow-hidden rounded-[14px] border border-border bg-card">
            <Canvas
              doc={doc}
              selection={selection}
              activeColumn={activeColumn}
              dispatch={dispatch}
              onSelect={setSelection}
              onSelectColumn={setActiveColumn}
            />
          </div>
        </div>

        <Inspector doc={doc} selection={selection} dispatch={dispatch} />
      </div>

      {apercu && (
        <ApercuPartial
          partial={partialPourApercu}
          assetSlug={assetSlug}
          onClose={() => setApercu(false)}
        />
      )}
    </>
  );
}

function Indicateur({ etat }: { etat: Etat }) {
  if (etat.kind === "envoi") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.9} />
        Saving…
      </span>
    );
  }
  if (etat.kind === "modifie") {
    return <span className="text-[12px] text-muted-foreground">Unsaved changes</span>;
  }
  if (etat.kind === "enregistre") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[12px] text-[#1f7a47]">
        <Check className="h-3.5 w-3.5" strokeWidth={2.1} />
        Saved
      </span>
    );
  }
  return null;
}

function Alerte({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-4 flex items-start gap-2.5 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] leading-relaxed text-amber-800">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{children}</span>
    </div>
  );
}
