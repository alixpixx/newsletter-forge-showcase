"use client";

/**
 * Petits éléments d'affichage de l'inspecteur, partagés par ses modules.
 *
 * Sortis d'`inspector.tsx` pour une seule raison : les champs d'apparence d'article
 * (`article-look-fields.tsx`) et les éditeurs d'appoint (`extra-fields.tsx`) en ont besoin, et ces
 * modules ne peuvent pas importer l'inspecteur qui les importe lui-même. Une copie aurait divergé
 * au premier changement de style.
 *
 * ⚠️ AUCUN HOOK ICI. Les bancs de l'inspecteur appellent les composants comme des fonctions pour
 * atteindre le `onChange` réel de chaque contrôle (le dépôt n'a pas de banc de rendu React) ; un
 * hook dans un de ces éléments ne casserait rien à l'écran, mais rendrait ces bancs impossibles.
 */
import { AlertTriangle, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { SelectInput } from "./fields";

/** Encadré explicatif. `warn` = piège potentiel (rendu client, publication refusée…). */
export function Note({ tone = "info", children }: { tone?: "info" | "warn"; children: React.ReactNode }) {
  return (
    <p
      className={cn(
        "mb-3 flex items-start gap-1.5 rounded-[9px] border px-2.5 py-2 text-[11px] leading-snug",
        tone === "warn"
          ? "border-amber-200 bg-amber-50 text-amber-800"
          : "border-border bg-accent/40 text-muted-foreground",
      )}
    >
      {tone === "warn" && <AlertTriangle className="mt-[1px] h-3 w-3 shrink-0" strokeWidth={2} />}
      <span>{children}</span>
    </p>
  );
}

/**
 * « Use for all titles » (24/09/2026) — posé sous le champ de couleur d'un titre quand CE titre a sa
 * propre couleur. Un clic : le style global des titres prend cette couleur et les autres titres perdent
 * la leur (action `useForAllTitles` du reducer, une étape d'annulation). Sans ce lien, un modèle importé
 * (une couleur par bloc) se recolorait bloc par bloc.
 */
export function UseForAllTitles({ color, onUse }: { color: string; onUse: (color: string) => void }) {
  return (
    <div className="-mt-1.5 mb-3 flex flex-wrap items-center gap-x-2 gap-y-1">
      <MiniBtn label={`Use ${color} for every title in this email`} onClick={() => onUse(color)}>
        Use for all titles
      </MiniBtn>
      <span className="text-[10.5px] text-muted-foreground">Titles on a coloured background keep their own.</span>
    </div>
  );
}

export function MiniBtn({
  onClick,
  label,
  danger,
  disabled,
  children,
}: {
  onClick: () => void;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded-[7px] border border-border px-1.5 py-[3px] text-[10.5px] font-semibold transition-colors",
        disabled
          ? "cursor-not-allowed opacity-40"
          : danger
            ? "text-muted-foreground hover:bg-[#fdecec] hover:text-[#c33]"
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * Sous-sections repliables
 * ------------------------------------------------------------------ */

/**
 * Mémoire ouvert / fermé des groupes, SANS HOOK (voir l'en-tête du fichier) : une `Map` du module,
 * doublée de `sessionStorage` pour survivre à un rechargement de l'onglet.
 *
 * - `sessionStorage` et pas `localStorage` : un groupe ouvert une fois ne doit pas rouvrir la colonne
 *   pour toujours ; la mémoire vaut pour la session d'édition.
 * - Tout accès au stockage est sous try/catch : navigation privée, stockage bloqué ou plein, rendu
 *   serveur (pas de `sessionStorage`) → la `Map` seule, sans jamais casser le rendu.
 * - La clé est l'`id` du groupe, pas le bloc : deux articles partagent « article.title ».
 */
const openGroups = new Map<string, boolean>();
const STORAGE_PREFIX = "nf.builder.group:";

function remembered(id: string): boolean | undefined {
  if (openGroups.has(id)) return openGroups.get(id);
  try {
    const v = globalThis.sessionStorage?.getItem(STORAGE_PREFIX + id);
    if (v === "1" || v === "0") {
      openGroups.set(id, v === "1");
      return v === "1";
    }
  } catch {
    /* stockage indisponible : la Map suffit */
  }
  return undefined;
}

function remember(id: string, open: boolean) {
  openGroups.set(id, open);
  try {
    globalThis.sessionStorage?.setItem(STORAGE_PREFIX + id, open ? "1" : "0");
  } catch {
    /* stockage indisponible : la Map suffit */
  }
}

/**
 * Ouvre d'avance le groupe `id` : l'écrit « ouvert » dans la mémoire (module + `sessionStorage`),
 * que `Group` relira au prochain rendu. SANS HOOK : c'est un appel de fonction ordinaire, posé dans
 * le `onClick` d'un bouton.
 *
 * Usage : « Add row » / « Add link » l'appellent avec l'`id` de la carte qu'ils créent, AVANT
 * d'écrire la liste. Sans ça, la carte ajoutée arrivait fermée (« Row 4 · empty ») et il fallait
 * la rouvrir pour y taper.
 * ⛔ C'est le GESTE qui ouvre, jamais le contenu : un `defaultOpen` tiré du vide refermerait la carte
 * à la première frappe. Les autres cartes ne sont pas touchées.
 */
export function openGroup(id: string): void {
  remember(id, true);
}

/**
 * Sous-section repliable de l'inspecteur. Un flux porte à lui seul quatre apparences complètes (une,
 * brèves, titre de section, filet) : dépliées ensemble, elles noieraient les réglages de la requête
 * sous cent champs. Le résumé dit l'essentiel sans avoir à ouvrir.
 *
 * - `id` : clé de mémoire, convention `<type de bloc>.<partie>` (`article.title`,
 *   `article-feed.lead.title`). UNIQUE dans tout le builder (`inspector-groups.test.ts` le garde pour
 *   les littéraux). Sans `id`, rien n'est mémorisé : le groupe s'ouvre selon `defaultOpen`, et le DOM
 *   garde l'état que l'utilisateur lui a donné tant que React réutilise le nœud (comportement
 *   d'avant).
 * - `defaultOpen` : état quand rien n'est mémorisé (fermé sinon).
 * - `summary` : UNE seule forme, celle d'`overrides()` — « defaults » ou « N set ».
 *
 * ⛔ Pas de hook : le banc `inspector-controls.test.ts` appelle `Group` comme une fonction. L'état
 * est relu à chaque rendu dans la mémoire du module, et écrit par l'événement `onToggle` (une prop,
 * pas un hook).
 * ⛔ `key={id}` : sans elle, React réutilise le `<details>` d'un bloc à l'autre quand l'arbre a la
 * même forme ; si la prop `open` n'a pas changé entre les deux rendus, un groupe ouvert à la main
 * resterait ouvert sous un autre `id`.
 */
export function Group({
  id,
  title,
  summary,
  defaultOpen = false,
  children,
}: {
  id?: string;
  title: string;
  summary?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const open = (id === undefined ? undefined : remembered(id)) ?? defaultOpen;
  return (
    <details
      key={id}
      open={open}
      // Le navigateur émet aussi `toggle` quand React POSE `open` (montage d'un groupe `defaultOpen`) :
      // on n'écrit que ce qui s'écarte de l'état déjà servi, sinon le simple affichage d'un groupe
      // ouvert par défaut figerait « ouvert » pour tous les blocs du même type.
      onToggle={
        id === undefined
          ? undefined
          : (e: React.SyntheticEvent<HTMLDetailsElement>) => {
              const now = e.currentTarget.open;
              if (now !== (remembered(id) ?? defaultOpen)) remember(id, now);
            }
      }
      suppressHydrationWarning
      className="mb-3 rounded-[10px] border border-border"
    >
      <summary className="flex cursor-pointer select-none list-none items-center gap-1 rounded-[9px] px-2.5 py-2 text-[11.5px] font-semibold text-foreground transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 motion-reduce:transition-none [&::-webkit-details-marker]:hidden [[open]>&]:rounded-b-none">
        <ChevronRight
          aria-hidden
          strokeWidth={2.25}
          className="h-3 w-3 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none [[open]>summary>&]:rotate-90"
        />
        <span className="min-w-0 flex-1">{title}</span>
        {summary && <span className="shrink-0 whitespace-nowrap font-normal text-muted-foreground">{summary}</span>}
      </summary>
      <div className="border-t border-border px-2.5 pb-1 pt-2.5">{children}</div>
    </details>
  );
}

/**
 * Résumé d'un groupe replié : combien de ses clés sont posées. « defaults » = rien n'est surchargé,
 * l'abonné reçoit le rendu par défaut — c'est ce qu'on veut lire sans ouvrir le groupe. C'est LA
 * forme de résumé de l'inspecteur : aucun autre vocabulaire (« customised », « on »…).
 *
 * `value` absent (un look jamais posé) = « defaults ». Sans `keys`, compte toutes les clés posées de
 * `value` : c'est le cas d'un sous-objet que le groupe édite en entier (look de une, filet).
 */
export function overrides(value: object | undefined, keys?: readonly string[]): string {
  const v = (value ?? {}) as Record<string, unknown>;
  const n = (keys ?? Object.keys(v)).filter((k) => v[k] !== undefined).length;
  return n === 0 ? "defaults" : `${n} set`;
}

/* ------------------------------------------------------------------ *
 * Menus à valeur par défaut
 * ------------------------------------------------------------------ */

/** Libellés des graisses — le chiffre d'abord : c'est lui que la maquette donne. */
export const WEIGHT_LABELS: Record<string, string> = {
  "300": "300 — light",
  "400": "400 — regular",
  "500": "500 — medium",
  "600": "600 — semibold",
  "700": "700 — bold",
  "800": "800 — extrabold",
  "900": "900 — black",
};
export const TRANSFORM_LABELS: Record<string, string> = {
  none: "As typed",
  uppercase: "UPPERCASE",
  lowercase: "lowercase",
  capitalize: "Capitalize",
};
export const LINE_STYLE_LABELS: Record<string, string> = { solid: "Solid", dashed: "Dashed", dotted: "Dotted" };

/**
 * Menu d'une énumération dont l'ABSENCE a un sens : la valeur `def` est celle que le compilateur
 * applique quand la clé manque, et la choisir écrit l'absence (comme la graisse 700 du titre).
 *
 * ⛔ `def` DOIT ÊTRE LA VALEUR QUI S'APPLIQUE VRAIMENT, calculée par l'appelant quand le défaut est une
 * règle (« la graisse du bloc, sinon 700 ») : écrire l'absence en croyant écrire 700 donnerait 600 à
 * l'abonné sous un bloc en 600. Le « (default) » est posé sur CETTE valeur, jamais sur une constante.
 */
export function ChoiceInput<T extends string>({
  label,
  value,
  def,
  options,
  labels,
  onChange,
  hint,
}: {
  label: string;
  value: T | undefined;
  def: T;
  options: readonly T[];
  labels?: Record<string, string>;
  onChange: (v: T | undefined) => void;
  hint?: string;
}) {
  return (
    <SelectInput<T>
      label={label}
      value={value ?? def}
      options={options.map((o) => ({ value: o, label: `${labels?.[o] ?? o}${o === def ? " (default)" : ""}` }))}
      onChange={(v) => onChange(v === def ? undefined : v)}
      hint={hint}
    />
  );
}
