"use client";

/**
 * INSPECTEUR (panneau droit) — cinq onglets : Content, Style, Mobile, Rules (contenu
 * conditionnel) et Settings.
 *
 * Tous les champs sont CONTRÔLÉS et écrivent dans le document via `dispatch`. Aucun champ
 * décoratif : si une propriété du schéma n'est pas éditable ici, elle n'apparaît pas.
 *
 * ⛔ ET TOUTE PROPRIÉTÉ QUE LE LECTEUR REÇOIT A SON CHAMP (règle du propriétaire, 22/09/2026 :
 * « tout pouvoir modifier dans le builder ce que les users vont recevoir sans exception »).
 * `inspector-coverage.test.ts` dérive la liste des clés du schéma et échoue sur celle qu'aucun
 * contrôle n'écrit — d'où la règle d'écriture : TOUJOURS une clé littérale (`patch({ titleFont })`),
 * jamais une clé calculée, que le garde ne saurait pas lire.
 *
 * TROIS PORTÉES. Le compilateur résout une cascade thème → row → colonne → bloc AVANT génération
 * (Outlook n'hérite de rien de façon fiable) ; l'inspecteur en est le miroir exact, y compris pour
 * ses deux familles de propriétés, qui ne se comportent PAS pareil :
 *  • héritables (typo, couleurs de texte/lien, alignement) : elles descendent la chaîne ;
 *  • propres à la boîte (fond, padding, bordure, masquage mobile) : elles ne descendent JAMAIS,
 *    sinon le padding d'une row s'ajouterait à celui de chacun de ses blocs.
 * Un champ ment s'il affiche « hérité de la row » là où le moteur ne regarde que le bloc — d'où
 * `inheritedOf(...)` appelé avec la vraie chaîne de la propriété, et pas une chaîne générique.
 *
 * Le texte est édité en TEXTE BRUT, un textarea par paragraphe. Il n'y a pas de mise en forme
 * inline (gras / italique / lien) dans cette vague : le schéma la porte (`spans`), l'IA et l'import
 * peuvent la produire, mais l'éditeur ne sait pas encore la manipuler — d'où l'avertissement affiché
 * quand un paragraphe contient plusieurs spans, puisque le réécrire l'aplatit.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { AlertTriangle, ArrowDown, ArrowUp, Check, Images, Loader2, Lock, Plus, RefreshCw, Rss, Search, Trash2 } from "lucide-react";
import {
  CALLOUT_LAYOUTS,
  CALLOUT_LAYOUT_DEFAULTS,
  CONDITION_FIELDS,
  MAX_BUTTON_LABEL,
  MERGE_VARS,
  SECTION_RULES,
  TEXT_PRESETS,
  Theme,
  isPlaceholderSrc,
  type Align,
  type Block,
  type BoxStyle,
  type CalloutLayout,
  type Column,
  type EmailDoc,
  type FeedItem,
  type MenuItem,
  type MergeVarName,
  type OddsRow,
  type Paragraph,
  type Row,
  type ScoreboardRow,
  type Spacing,
  type TextPreset,
  type VisibleIf,
} from "@nf/render/schema";
import { defaultArticleCta } from "@nf/render/cta";
// ⛔ Le champ annonce ce que le RENDU fera : il interroge donc la définition du rendu, il n'en
// écrit pas une deuxième. Un « Inherited: Read more » affiché sous un lien mort promettrait un
// libellé que la compilation refuse de poser.
import { goesNowhere } from "@nf/render/links";
import { cn } from "@/lib/utils";
import { MediaPicker } from "@/components/media/picker";
import { findBlock, findRow, rowHasLockedBlock, type BuilderAction, type FeedPart } from "./reducer";
import { FEED_PRESETS, FEED_PRESET_LABELS, styleFluxActif } from "./feed-presets";
import { LegalFooterPicker } from "./legal-footer-picker";
import {
  ChoiceInput,
  Group,
  LINE_STYLE_LABELS,
  MiniBtn,
  Note,
  TRANSFORM_LABELS,
  UseForAllTitles,
  WEIGHT_LABELS,
  openGroup,
  overrides,
} from "./inspector-ui";
import {
  ArticleLookFields,
  CTA_STYLE_OPTIONS,
  FeedLookSections,
  FontInput,
  RULE_GAP_DEFAULT,
  SECTION_RULE_LABELS,
  resolveLookBase,
  type CtaStyle,
  type LookBase,
} from "./article-look-fields";
import {
  BrandPartialsField,
  BrandSettingsLink,
  ButtonLookFields,
  CardButtonFields,
  DividerSegmentsEditor,
  DocumentOutputFields,
  LanguageDefaultsFields,
  LocaleField,
  MenuLookFields,
  SocialItemsEditor,
  SocialLookFields,
  WebFontsEditor,
} from "./extra-fields";
import { clampTo, literalDefault, numberField, propSpec, specBounds } from "./schema-bounds";
import {
  AlignInput,
  CheckboxInput,
  ColorInput,
  Field,
  NumberInput,
  SectionTitle,
  SelectInput,
  SpacingInput,
  TextAreaInput,
  TextInput,
  prune,
} from "./fields";
import { MergeTagMenu } from "./merge-tags";
import { blockLabel } from "./canvas";
import type { Selection } from "./canvas";

type Tab = "content" | "style" | "mobile" | "visibility" | "settings";

/** Étages de la cascade. `theme` = la marque, racine de tout le document. */
type Scope = "theme" | "row" | "column" | "block";

/** Un étage parent, tel que l'inspecteur doit le NOMMER quand il fournit une valeur héritée. */
interface Layer {
  label: string;
  style: BoxStyle | undefined;
}

/** Patch typé par variante côté reducer ; ici on reste volontairement générique. */
type Patch = (p: Record<string, unknown>) => void;

const SCOPE_LABEL: Record<Scope, string> = {
  theme: "Email",
  row: "Row",
  column: "Column",
  block: "Block",
};

const ZERO_PAD: Spacing = { top: 0, right: 0, bottom: 0, left: 0 };

/** Valeurs livrées par le schéma — la seule « valeur par défaut » honnête pour un thème. */
const THEME_DEFAULTS = Theme.parse({});

/**
 * ⛔ Règle la plus stricte du projet : l'outil ne calcule, n'arrondit et n'invente aucune donnée
 * sportive. Ce rappel est collé à CHAQUE champ de type cote / valeur / cellule de classement.
 */
const REAL_DATA_HINT =
  "Copy this from your real source, or drop in a merge tag. Nothing here is fetched, computed or rounded — what you type is exactly what ships.";

/*
 * Réglages d'apparence du 22/09/2026 (manifeste `NEW_PROPS_2026_09_22`) : ce que le compilateur
 * décidait seul. Chaque champ affiche en grisé la valeur que l'abonné reçoit quand il est vide —
 * calculée ici avec la même cascade que `resolve` quand le défaut est une règle (« taille du bloc
 * − 4 »), lue dans le manifeste quand c'est une constante.
 */
type Weight = NonNullable<Extract<Block, { type: "pick" }>["ctaWeight"]>;
type Transform = NonNullable<Extract<Block, { type: "pick" }>["kickoffTransform"]>;
type LineStyle = NonNullable<Extract<Block, { type: "divider" }>["lineStyle"]>;

/** Rayon d'un bouton ou d'un cadre sans réglage : celui du BLOC seul, sinon le thème (propre à la boîte). */
function blockRadius(style: BoxStyle | undefined, theme: Theme): { value: number; from: string } {
  return style?.borderRadius !== undefined
    ? { value: style.borderRadius, from: "the block corner radius" }
    : { value: theme.radius, from: "the brand corner radius" };
}

/** Couleur de bordure sans réglage : celle du BLOC seul, sinon le thème — comme `resolve`. */
function blockBorder(style: BoxStyle | undefined, theme: Theme): { value: string; from: string } {
  return style?.borderColor !== undefined
    ? { value: style.borderColor, from: "the block border colour" }
    : { value: theme.borderColor, from: "the brand border colour" };
}

/** Ce que reçoit l'éditeur d'un bloc qui a des réglages d'apparence. */
interface LookProps<T> {
  block: T;
  patch: Patch;
  theme: Theme;
  /** Typographie RÉSOLUE du bloc (thème → row → colonne → bloc). */
  base: LookBase;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Un style entièrement vide vaut `undefined` (héritage) plutôt qu'un `{}` inutile. */
function normalizeStyle(style: BoxStyle): BoxStyle | undefined {
  const pruned = prune(style);
  for (const key of ["padding", "paddingMobile"] as const) {
    const spacing = pruned[key];
    if (spacing && Object.keys(prune(spacing)).length === 0) delete pruned[key];
  }
  return Object.keys(pruned).length === 0 ? undefined : pruned;
}

const clampNum = (v: number | undefined, fallback: number, min: number, max: number): number =>
  v === undefined || Number.isNaN(v) ? fallback : Math.min(Math.max(v, min), max);

const paragraphText = (p: Paragraph): string => p.spans.map((s) => s.text).join("");

/** Réécrit un paragraphe en texte brut, en CONSERVANT les marques du premier span. */
function withParagraphText(p: Paragraph, text: string): Paragraph {
  const first = p.spans[0];
  return {
    spans: [
      prune({
        text,
        bold: first?.bold,
        italic: first?.italic,
        underline: first?.underline,
        // `strike` fait partie des marques d'`InlineSpan` : l'oublier ici effacerait SILENCIEUSEMENT
        // un barré posé au canvas dès qu'on retouche le paragraphe depuis l'inspecteur.
        strike: first?.strike,
        href: first?.href,
        color: first?.color,
      }),
    ],
  };
}

/**
 * Valeur qui s'appliquera si le champ n'est PAS surchargé, et étage qui la fournit.
 *
 * `parents` doit contenir uniquement les étages que le compilateur consulte RÉELLEMENT pour cette
 * propriété : vide pour une propriété propre à la boîte, la chaîne complète pour une héritable.
 */
function inheritedOf<K extends keyof BoxStyle>(
  parents: Layer[],
  key: K,
  themeFallback?: BoxStyle[K],
  themeLabel = "Email styles",
): { value: NonNullable<BoxStyle[K]>; from: string } | undefined {
  for (let i = parents.length - 1; i >= 0; i--) {
    const v = parents[i].style?.[key];
    if (v !== undefined) return { value: v as NonNullable<BoxStyle[K]>, from: parents[i].label };
  }
  return themeFallback === undefined
    ? undefined
    : { value: themeFallback as NonNullable<BoxStyle[K]>, from: themeLabel };
}

/**
 * Un bloc dont le texte est un TITRE : il suit `theme.headingColor` / `headingFont` (24/09/2026), comme
 * `PRESETS_TITRE` et `sectionTitleHtml` du compilateur. ⛔ Garder les deux listes identiques.
 */
export function estBlocTitre(block: Block | null | undefined): boolean {
  if (!block) return false;
  if (block.type === "section_title") return true;
  return block.type === "text" && (block.preset === "h1" || block.preset === "h2" || block.preset === "h3");
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="px-1 py-6 text-center text-[12px] leading-relaxed text-muted-foreground">{children}</p>;
}

// `Note` et `MiniBtn` vivent dans `inspector-ui.tsx` : les modules d'apparence d'article et
// d'éditeurs d'appoint en ont besoin, et ne peuvent pas importer ce fichier qui les importe.

/**
 * En-tête d'une carte de liste coupé pour tenir sur UNE ligne. `Group` ne tronque pas son titre (et le
 * banc lit ce titre comme une chaîne) : on coupe donc le texte lui-même, sur une LARGEUR estimée et
 * pas sur un nombre de caractères — « MANCHESTER UNITED » est deux fois plus large que « manchester ».
 *
 * Relevé dans Edge (police système, 11,5 px, graisse 600, colonne de 302 px) : 238 px disponibles ;
 * i/l/espace ≈ 3, minuscules et chiffres ≈ 6, capitales ≈ 7,7, W/M ≈ 11. Les estimations sont
 * arrondies VERS LE HAUT et le budget garde une marge pour les autres polices système : couper un peu
 * tôt vaut mieux qu'un en-tête sur deux lignes.
 */
const LIST_HEAD_BUDGET = 220;
const glyphWidth = (ch: string): number =>
  /[\s.,:;'|!·(){}[\]iljtfrI1]/.test(ch) ? 4 : /[mwMW@%]/.test(ch) || ch.codePointAt(0)! > 0x2e7f ? 11.5 : /[A-Z]/.test(ch) ? 8.5 : 7;

function clipHead(text: string): string {
  const chars = Array.from(text); // par point de code : ne jamais couper une paire de substitution
  if (chars.reduce((w, c) => w + glyphWidth(c), 0) <= LIST_HEAD_BUDGET) return text;
  // Il faut couper : 10 px réservés à « … ».
  let width = 0;
  let n = 0;
  while (n < chars.length && width + glyphWidth(chars[n]) <= LIST_HEAD_BUDGET - 10) width += glyphWidth(chars[n++]);
  return `${chars.slice(0, n).join("").trimEnd()}…`;
}

/** L'`id` de mémoire de la carte n° `index` (base 0) d'une liste : `<group>.<index + 1>`. */
const listCardId = (group: string, index: number): string => `${group}.${index + 1}`;

/**
 * Carte d'un élément de liste (ligne de cotes, de classement, de bandeau) : REPLIABLE, et son en-tête
 * dit ce qu'elle contient (« Row 3 · Arsenal · 45 »), pour qu'une liste de 6 lignes se lise sans
 * rien ouvrir. Monter / descendre / retirer sont en tête du corps.
 *
 * - `group` : préfixe de mémoire (`standings.row`). L'`id` du groupe est `<group>.<n>`, construit
 *   ICI depuis l'index : deux lignes ne peuvent pas partager un état ouvert / fermé.
 * - ⛔ L'`id` suit la POSITION, jamais le contenu : un `id` tiré du nom de l'équipe changerait à
 *   chaque frappe, et le `key` de `Group` remonterait le champ sous le curseur (focus perdu, carte
 *   refermée). Pour la même raison, une carte vide n'est pas « ouverte par défaut » : la première
 *   frappe la rendrait non vide et la refermerait sous les doigts. Fermée, elle se lit « empty ».
 * - Pas de `summary` : ce n'est pas un groupe de réglages, le contenu est dans le titre.
 * - ⛔ Pas de hook : le banc appelle les éditeurs (et donc ce composant) comme des fonctions.
 * - Une carte AJOUTÉE s'ouvre par le GESTE : le bouton « Add » appelle `openGroup(listCardId(…))`
 *   avant d'écrire la liste — jamais par son contenu (voir plus haut).
 */
function ListCard({
  group,
  title,
  preview,
  index,
  total,
  min,
  onMove,
  onRemove,
  children,
}: {
  group: string;
  /** Position lisible (« Row 3 ») : reprise par les boutons (« Move Row 3 up »). */
  title: string;
  /** Ce que la ligne contient, tel que tapé. Vide = « empty ». */
  preview: string;
  index: number;
  total: number;
  /** Nombre d'éléments en dessous duquel le schéma refuse le document. */
  min: number;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  children: React.ReactNode;
}) {
  return (
    <Group id={listCardId(group, index)} title={clipHead(`${title} · ${preview.trim() === "" ? "empty" : preview.trim()}`)}>
      <div className="mb-2 flex items-center justify-end gap-1">
        <MiniBtn label={`Move ${title} up`} disabled={index === 0} onClick={() => onMove(-1)}>
          <ArrowUp className="h-3 w-3" strokeWidth={2.2} />
        </MiniBtn>
        <MiniBtn label={`Move ${title} down`} disabled={index === total - 1} onClick={() => onMove(1)}>
          <ArrowDown className="h-3 w-3" strokeWidth={2.2} />
        </MiniBtn>
        <MiniBtn label={`Remove ${title}`} danger disabled={total <= min} onClick={onRemove}>
          <Trash2 className="h-3 w-3" strokeWidth={2.2} />
        </MiniBtn>
      </div>
      {children}
    </Group>
  );
}

/** Ce qu'une ligne contient, pour l'en-tête de sa carte : les cellules non vides, dans l'ordre. */
const rowPreview = (cells: readonly (string | undefined)[]): string =>
  cells
    .map((c) => (c ?? "").trim())
    .filter((c) => c !== "")
    .join(" · ");

/** Déplace un élément dans une liste (copie). Aucun effet en butée : l'appelant borne déjà. */
function moved<T>(list: T[], index: number, dir: -1 | 1): T[] {
  const next = [...list];
  const [item] = next.splice(index, 1);
  next.splice(index + dir, 0, item);
  return next;
}

/**
 * Champ texte doublé du menu de merge tags, inséré AU CURSEUR du champ lui-même.
 *
 * C'est la seule façon honnête de remplir une cote ou un libellé de match : soit l'éditeur recopie
 * une valeur réelle, soit il pose un token que le worker résoudra par destinataire.
 */
function TokenTextInput({
  label,
  value,
  onChange,
  maxLength,
  placeholder,
  hint,
  warning,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  maxLength?: number;
  placeholder?: string;
  hint?: string;
  warning?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);

  function insert(token: string) {
    const el = ref.current;
    const focused = el !== null && document.activeElement === el;
    const start = focused ? (el.selectionStart ?? value.length) : value.length;
    const end = focused ? (el.selectionEnd ?? value.length) : value.length;
    const merged = value.slice(0, start) + token + value.slice(end);
    const next = maxLength === undefined ? merged : merged.slice(0, maxLength);
    onChange(next);
    const pos = Math.min(start + token.length, next.length);
    // Le re-rendu remet la valeur : on replace le curseur juste après le token inséré.
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  }

  return (
    <TextInput
      label={label}
      value={value}
      onChange={onChange}
      maxLength={maxLength}
      placeholder={placeholder}
      hint={hint}
      warning={warning}
      inputRef={ref}
      right={<MergeTagMenu onInsert={insert} />}
    />
  );
}

/**
 * Couple src + alt d'une image, avec accès à la médiathèque.
 *
 * `onPick` écrit les DEUX champs en un seul patch : une image choisie dans la bibliothèque arrive
 * avec son texte alternatif, et l'annuler d'un seul ⌘Z est le comportement attendu.
 */
function MediaField({
  src,
  alt = "",
  srcLabel,
  altLabel = "",
  onSrc,
  onAlt,
  onPick,
  srcHint,
  altHint,
  altRequired = true,
}: {
  src: string;
  alt?: string;
  srcLabel: string;
  altLabel?: string;
  onSrc: (v: string) => void;
  /**
   * Absent = pas de champ alt (23/09/2026). Réservé à une photo de FOND, sous du texte : elle n'est
   * pas un `<img>`, le lecteur d'écran lit le texte posé dessus, et un alt n'irait nulle part.
   */
  onAlt?: (v: string) => void;
  onPick: (m: { src: string; alt: string }) => void;
  srcHint?: string;
  altHint?: string;
  altRequired?: boolean;
}) {
  const [picking, setPicking] = useState(false);

  // L'ordre compte : un champ vide rend le DOCUMENT insauvegardable (le schéma exige `min(1)`),
  // c'est plus grave qu'une sentinelle ou qu'un http://.
  const srcWarning =
    src.trim() === ""
      ? "An image URL is required — the template cannot be saved while this is empty."
      : isPlaceholderSrc(src)
        ? "Still an AI placeholder — generate or upload the picture before publishing."
        : /^http:\/\//i.test(src)
          ? "Served over http:// — many clients block or flag it."
          : undefined;

  return (
    <>
      <TextInput
        label={srcLabel}
        value={src}
        onChange={onSrc}
        placeholder="https://cdn.example.com/hero.png"
        hint={srcHint ?? "Must be a public https:// URL — email clients cannot read local files."}
        warning={srcWarning}
        right={
          <MiniBtn label="Browse library" onClick={() => setPicking(true)}>
            <Images className="h-3 w-3" strokeWidth={2.2} />
            Library
          </MiniBtn>
        }
      />
      {onAlt !== undefined && (
        <TextInput
          label={altLabel}
          value={alt}
          onChange={onAlt}
          maxLength={300}
          placeholder="What the image shows"
          hint={altHint}
          warning={
            // ⛔ `altRequired` porte la moitié gauche du seuil de publication, ce `alt.trim() === ""`
            // en est la moitié droite. L'appelant qui laisse le défaut à `true` annonce donc un blocage
            // à chaque alt vide : juste pour une image seule, FAUX pour une vignette d'article titrée.
            altRequired && alt.trim() === ""
              ? "Alt text is empty — publishing is blocked until it is filled, and images-off readers see nothing."
              : undefined
          }
        />
      )}
      <MediaPicker
        open={picking}
        onClose={() => setPicking(false)}
        onPick={(m) => {
          onPick(m);
          setPicking(false);
        }}
      />
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Éditeur de texte (paragraphes + merge tags au curseur)
 * ------------------------------------------------------------------ */

function TextEditor({
  block,
  onPatch,
}: {
  block: Extract<Block, { type: "text" }>;
  onPatch: (patch: { preset?: TextPreset; paragraphs?: Paragraph[]; paragraphSpacing?: number }) => void;
}) {
  const spacingSpec = propSpec("text", "paragraphSpacing");
  // Dernière position de curseur connue — c'est là qu'un merge tag s'insère.
  const [caret, setCaret] = useState<{ index: number; start: number; end: number } | null>(null);
  const refs = useRef<(HTMLTextAreaElement | null)[]>([]);

  const setParagraph = useCallback(
    (index: number, text: string) => {
      onPatch({ paragraphs: block.paragraphs.map((p, i) => (i === index ? withParagraphText(p, text) : p)) });
    },
    [block.paragraphs, onPatch],
  );

  function insertToken(token: string) {
    if (!caret) return;
    const { index, start, end } = caret;
    const current = paragraphText(block.paragraphs[index] ?? { spans: [{ text: "" }] });
    const next = current.slice(0, start) + token + current.slice(end);
    setParagraph(index, next);
    const pos = start + token.length;
    // Le re-rendu remet la valeur : on replace le curseur juste après le token inséré.
    requestAnimationFrame(() => {
      const el = refs.current[index];
      if (!el) return;
      el.focus();
      el.setSelectionRange(pos, pos);
      setCaret({ index, start: pos, end: pos });
    });
  }

  const flattens = block.paragraphs.some(
    (p) =>
      p.spans.length > 1 ||
      p.spans.some((s) => s.href || s.bold || s.italic || s.underline || s.strike || s.color),
  );

  return (
    <>
      <SelectInput
        label="Preset"
        value={block.preset}
        options={TEXT_PRESETS}
        onChange={(v) => onPatch({ preset: v })}
        hint="Typography comes from the brand theme — h1/h2/h3 are headings, small is fine print. Their sizes are set under Style → Email → Advanced → Text presets."
      />
      <NumberInput
        label="Space between paragraphs"
        value={block.paragraphSpacing}
        {...numberField(spacingSpec)}
        suffix="px"
        inherited={literalDefault(spacingSpec)}
        inheritedFrom="the text default"
        onReset={block.paragraphSpacing === undefined ? undefined : () => onPatch({ paragraphSpacing: undefined })}
        onChange={(v) => onPatch({ paragraphSpacing: clampTo(specBounds(spacingSpec), v) })}
      />

      {flattens && (
        <p className="mb-3 flex items-start gap-1.5 rounded-[9px] border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] leading-snug text-amber-800">
          <AlertTriangle className="mt-[1px] h-3 w-3 shrink-0" strokeWidth={2} />
          This text carries inline formatting (bold, italic, underline, strikethrough, colour or links). Editing a
          paragraph here rewrites it as one plain run and keeps only the formatting of its first stretch. Double-click
          the block on the canvas to edit the formatting itself.
        </p>
      )}

      {block.paragraphs.map((p, i) => (
        <div key={i} className="relative">
          <TextAreaInput
            label={`Paragraph ${i + 1}`}
            value={paragraphText(p)}
            rows={3}
            textareaRef={(el) => {
              refs.current[i] = el;
            }}
            onFocus={(e) => setCaret({ index: i, start: e.target.selectionStart, end: e.target.selectionEnd })}
            onChange={(v) => {
              setParagraph(i, v);
              const el = refs.current[i];
              if (el) setCaret({ index: i, start: el.selectionStart, end: el.selectionEnd });
            }}
            right={
              <div className="flex items-center gap-1">
                <MergeTagMenu
                  onInsert={insertToken}
                  disabled={caret?.index !== i}
                  hint="Click inside this paragraph first"
                />
                <MiniBtn
                  label={`Remove paragraph ${i + 1}`}
                  danger
                  disabled={block.paragraphs.length <= 1}
                  onClick={() => onPatch({ paragraphs: block.paragraphs.filter((_, j) => j !== i) })}
                >
                  <Trash2 className="h-3 w-3" strokeWidth={2.2} />
                </MiniBtn>
              </div>
            }
          />
        </div>
      ))}

      <MiniBtn
        label="Add paragraph"
        onClick={() => onPatch({ paragraphs: [...block.paragraphs, { spans: [{ text: "" }] }] })}
      >
        <Plus className="h-3 w-3" strokeWidth={2.2} /> Add paragraph
      </MiniBtn>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Blocs métier — que des CHAÎNES, jamais un nombre saisi comme nombre
 * ------------------------------------------------------------------ */

/** Rembourrage d'une carte (pick, promo, bandeau) sans réglage : 16 px partout (`cardPadding`). */
const CARD_PADDING: Spacing = { top: 16, right: 16, bottom: 16, left: 16 };

export function PickEditor({ block, patch, theme, base }: LookProps<Extract<Block, { type: "pick" }>>) {
  const ctaWithoutLink = block.ctaLabel !== undefined && block.ctaLabel.trim() !== "" && !block.href?.trim();
  const spec = (path: string) => propSpec("pick", path);
  const fs = base.fontSize;
  const small = String(Math.max(11, fs - 4));
  const frame = blockBorder(block.style, theme);

  return (
    <>
      <SectionTitle>Match</SectionTitle>
      <TokenTextInput
        label="Match"
        value={block.matchLabel}
        maxLength={160}
        onChange={(v) => patch({ matchLabel: v })}
        placeholder="Home team — Away team"
        hint="Written exactly as it must appear. The block never recomposes a fixture name."
      />
      <TokenTextInput
        label="Kick-off (optional)"
        value={block.kickoffLabel ?? ""}
        maxLength={80}
        onChange={(v) => patch({ kickoffLabel: v.trim() === "" ? undefined : v })}
        placeholder="Sat 20:30"
        hint="No time zone conversion happens here — write the time your readers should see."
      />

      <SectionTitle>Selection</SectionTitle>
      <TokenTextInput
        label="Market"
        value={block.marketLabel}
        maxLength={80}
        onChange={(v) => patch({ marketLabel: v })}
        placeholder="Both teams to score"
      />
      <TokenTextInput
        label="Selection"
        value={block.selectionLabel}
        maxLength={120}
        onChange={(v) => patch({ selectionLabel: v })}
        placeholder="Yes"
      />
      <TokenTextInput
        label="Odds"
        value={block.oddsLabel}
        maxLength={40}
        onChange={(v) => patch({ oddsLabel: v })}
        placeholder="1.75"
        hint={REAL_DATA_HINT}
        warning={block.oddsLabel.trim() === "" ? "Empty — the odds badge is dropped from the card." : undefined}
      />
      <TokenTextInput
        label="Confidence (optional)"
        value={block.confidenceLabel ?? ""}
        maxLength={60}
        onChange={(v) => patch({ confidenceLabel: v.trim() === "" ? undefined : v })}
        hint={REAL_DATA_HINT}
      />

      <SectionTitle>Call to action</SectionTitle>
      <TextInput
        label="Link (optional)"
        value={block.href ?? ""}
        onChange={(v) => patch({ href: v.trim() === "" ? undefined : v })}
        placeholder="https://example.com"
      />
      <TextInput
        label="CTA label (optional)"
        value={block.ctaLabel ?? ""}
        maxLength={MAX_BUTTON_LABEL}
        onChange={(v) => patch({ ctaLabel: v.trim() === "" ? undefined : v })}
        warning={ctaWithoutLink ? "No link: the button is not rendered at all — a dead button costs unsubscribes." : undefined}
        hint={`Up to ${MAX_BUTTON_LABEL} characters. Both the link and the label are required for the button to appear.`}
      />

      {/* Des TAILLES et des COULEURS, jamais une donnée : la règle « rien n'est calculé » vise les
          cotes, pas la typographie. Repliés : la hiérarchie par défaut convient à presque tout. */}
      <SectionTitle>Appearance</SectionTitle>
      <Group
        id="pick.text-lines"
        title="Text lines"
        summary={overrides(block, [
          "kickoffSize",
          "kickoffColor",
          "kickoffTransform",
          "matchSize",
          "matchColor",
          "marketSize",
          "marketColor",
          "selectionSize",
          "selectionColor",
          "confidenceSize",
          "confidenceColor",
        ])}
      >
        <NumberInput
          label="Kick-off size"
          value={block.kickoffSize}
          {...numberField(spec("kickoffSize"))}
          suffix="px"
          inherited={small}
          inheritedFrom="the block font size minus 4 (at least 11)"
          onReset={block.kickoffSize === undefined ? undefined : () => patch({ kickoffSize: undefined })}
          onChange={(v) => patch({ kickoffSize: clampTo(specBounds(spec("kickoffSize")), v) })}
        />
        <ColorInput
          label="Kick-off colour"
          value={block.kickoffColor}
          inherited={theme.mutedColor}
          inheritedFrom="the brand muted colour"
          onReset={block.kickoffColor === undefined ? undefined : () => patch({ kickoffColor: undefined })}
          onChange={(v) => patch({ kickoffColor: v })}
        />
        <ChoiceInput<Transform>
          label="Kick-off case"
          value={block.kickoffTransform}
          def={spec("kickoffTransform").default as Transform}
          options={spec("kickoffTransform").options as readonly Transform[]}
          labels={TRANSFORM_LABELS}
          onChange={(v) => patch({ kickoffTransform: v })}
          hint={spec("kickoffTransform").hint}
        />
        <NumberInput
          label="Match size"
          value={block.matchSize}
          {...numberField(spec("matchSize"))}
          suffix="px"
          inherited={String(fs + 1)}
          inheritedFrom="the block font size plus 1"
          onReset={block.matchSize === undefined ? undefined : () => patch({ matchSize: undefined })}
          onChange={(v) => patch({ matchSize: clampTo(specBounds(spec("matchSize")), v) })}
        />
        <ColorInput
          label="Match colour"
          value={block.matchColor}
          inherited={base.textColor}
          inheritedFrom="the text colour"
          onReset={block.matchColor === undefined ? undefined : () => patch({ matchColor: undefined })}
          onChange={(v) => patch({ matchColor: v })}
        />
        <NumberInput
          label="Market size"
          value={block.marketSize}
          {...numberField(spec("marketSize"))}
          suffix="px"
          inherited={small}
          inheritedFrom="the block font size minus 4 (at least 11)"
          onReset={block.marketSize === undefined ? undefined : () => patch({ marketSize: undefined })}
          onChange={(v) => patch({ marketSize: clampTo(specBounds(spec("marketSize")), v) })}
        />
        <ColorInput
          label="Market colour"
          value={block.marketColor}
          inherited={theme.mutedColor}
          inheritedFrom="the brand muted colour"
          onReset={block.marketColor === undefined ? undefined : () => patch({ marketColor: undefined })}
          onChange={(v) => patch({ marketColor: v })}
        />
        <NumberInput
          label="Selection size"
          value={block.selectionSize}
          {...numberField(spec("selectionSize"))}
          suffix="px"
          inherited={String(fs)}
          inheritedFrom="the block font size"
          onReset={block.selectionSize === undefined ? undefined : () => patch({ selectionSize: undefined })}
          onChange={(v) => patch({ selectionSize: clampTo(specBounds(spec("selectionSize")), v) })}
        />
        <ColorInput
          label="Selection colour"
          value={block.selectionColor}
          inherited={theme.brandColor}
          inheritedFrom="the brand colour"
          onReset={block.selectionColor === undefined ? undefined : () => patch({ selectionColor: undefined })}
          onChange={(v) => patch({ selectionColor: v })}
        />
        <NumberInput
          label="Confidence size"
          value={block.confidenceSize}
          {...numberField(spec("confidenceSize"))}
          suffix="px"
          inherited={small}
          inheritedFrom="the block font size minus 4 (at least 11)"
          onReset={block.confidenceSize === undefined ? undefined : () => patch({ confidenceSize: undefined })}
          onChange={(v) => patch({ confidenceSize: clampTo(specBounds(spec("confidenceSize")), v) })}
        />
        <ColorInput
          label="Confidence colour"
          value={block.confidenceColor}
          inherited={theme.mutedColor}
          inheritedFrom="the brand muted colour"
          onReset={block.confidenceColor === undefined ? undefined : () => patch({ confidenceColor: undefined })}
          onChange={(v) => patch({ confidenceColor: v })}
        />
      </Group>
      <Group id="pick.odds-badge" title="Odds badge" summary={overrides(block, ["oddsBackground", "oddsTextColor", "oddsSize"])}>
        <ColorInput
          label="Badge background"
          value={block.oddsBackground}
          inherited={theme.brandColor}
          inheritedFrom="the brand colour"
          onReset={block.oddsBackground === undefined ? undefined : () => patch({ oddsBackground: undefined })}
          onChange={(v) => patch({ oddsBackground: v })}
          hint={spec("oddsBackground").hint}
        />
        <ColorInput
          label="Badge text colour"
          value={block.oddsTextColor}
          inherited={theme.buttonTextColor}
          inheritedFrom="the brand button text colour"
          onReset={block.oddsTextColor === undefined ? undefined : () => patch({ oddsTextColor: undefined })}
          onChange={(v) => patch({ oddsTextColor: v })}
        />
        <NumberInput
          label="Badge text size"
          value={block.oddsSize}
          {...numberField(spec("oddsSize"))}
          suffix="px"
          inherited={String(fs + 1)}
          inheritedFrom="the block font size plus 1"
          onReset={block.oddsSize === undefined ? undefined : () => patch({ oddsSize: undefined })}
          onChange={(v) => patch({ oddsSize: clampTo(specBounds(spec("oddsSize")), v) })}
        />
      </Group>
      <Group id="pick.card" title="Card" summary={overrides(block, ["innerPadding", "rowGap", "frameColor", "frameWidth"])}>
        <SpacingInput
          label="Inner padding (px)"
          value={block.innerPadding}
          defaults={CARD_PADDING}
          min={specBounds(spec("innerPadding")).min}
          max={specBounds(spec("innerPadding")).max}
          inheritedFrom="the card default"
          onChange={(next) => patch({ innerPadding: next })}
          hint={spec("innerPadding").hint}
        />
        <NumberInput
          label="Gap between lines"
          value={block.rowGap}
          {...numberField(spec("rowGap"))}
          suffix="px"
          inherited={literalDefault(spec("rowGap"))}
          inheritedFrom="the card default"
          onReset={block.rowGap === undefined ? undefined : () => patch({ rowGap: undefined })}
          onChange={(v) => patch({ rowGap: clampTo(specBounds(spec("rowGap")), v) })}
        />
        <NumberInput
          label="Frame thickness"
          value={block.frameWidth}
          {...numberField(spec("frameWidth"))}
          suffix="px"
          inherited={literalDefault(spec("frameWidth"))}
          inheritedFrom="the card default"
          onReset={block.frameWidth === undefined ? undefined : () => patch({ frameWidth: undefined })}
          onChange={(v) => patch({ frameWidth: clampTo(specBounds(spec("frameWidth")), v) })}
        />
        <ColorInput
          label="Frame colour"
          value={block.frameColor}
          inherited={frame.value}
          inheritedFrom={frame.from}
          onReset={block.frameColor === undefined ? undefined : () => patch({ frameColor: undefined })}
          onChange={(v) => patch({ frameColor: v })}
        />
      </Group>
      <Group
        id="pick.button"
        title="Button"
        summary={overrides(block, ["ctaBackground", "ctaTextColor", "ctaSize", "ctaWeight", "ctaPadding", "ctaRadius"])}
      >
        <CardButtonFields
          target="pick"
          value={block}
          onPatch={patch}
          theme={theme}
          fontSize={fs}
          radius={blockRadius(block.style, theme)}
        />
      </Group>
    </>
  );
}

export function OddsTableEditor({
  block,
  patch,
  theme,
  base,
}: LookProps<Extract<Block, { type: "odds_table" }>>) {
  const rows = block.rows;
  const spec = (path: string) => propSpec("odds_table", path);
  const setRow = (i: number, next: Partial<OddsRow>) =>
    patch({ rows: rows.map((r, j) => (j === i ? { ...r, ...next } : r)) });

  return (
    <>
      <Note>
        Two columns of plain strings: a label on the left, the value you typed on the right. Nothing is looked up or
        recalculated at send time.
      </Note>

      <SectionTitle>Rows ({rows.length}/12)</SectionTitle>
      {rows.map((row, i) => (
        <ListCard
          key={i}
          group="odds_table.row"
          title={`Row ${i + 1}`}
          preview={rowPreview([row.label, row.value])}
          index={i}
          total={rows.length}
          min={2}
          onMove={(dir) => patch({ rows: moved(rows, i, dir) })}
          onRemove={() => patch({ rows: rows.filter((_, j) => j !== i) })}
        >
          <TokenTextInput
            label="Label"
            value={row.label}
            maxLength={120}
            onChange={(v) => setRow(i, { label: v })}
            placeholder="Home win"
          />
          <TokenTextInput
            label="Value"
            value={row.value}
            maxLength={40}
            onChange={(v) => setRow(i, { value: v })}
            hint={i === 0 ? REAL_DATA_HINT : undefined}
          />
        </ListCard>
      ))}

      <MiniBtn
        label="Add odds row"
        disabled={rows.length >= 12}
        onClick={() => {
          openGroup(listCardId("odds_table.row", rows.length));
          patch({ rows: [...rows, { label: "", value: "" }] });
        }}
      >
        <Plus className="h-3 w-3" strokeWidth={2.2} /> Add row
      </MiniBtn>

      <SectionTitle>Caption</SectionTitle>
      <TextAreaInput
        label="Caption (optional)"
        value={block.caption ?? ""}
        rows={2}
        maxLength={200}
        onChange={(v) => patch({ caption: v.trim() === "" ? undefined : v })}
        hint="Where the odds come from, when they were captured, which operator — the reader deserves the context."
      />

      <SectionTitle>Appearance</SectionTitle>
      <Group
        id="odds_table.table-style"
        title="Table style"
        summary={overrides(block, ["textSize", "labelWeight", "valueWeight", "valueColor", "rowPadding", "ruleWidth"])}
      >
        <NumberInput
          label="Row text size"
          value={block.textSize}
          {...numberField(spec("textSize"))}
          suffix="px"
          inherited={String(Math.max(12, base.fontSize - 1))}
          inheritedFrom="the block font size minus 1 (at least 12)"
          onReset={block.textSize === undefined ? undefined : () => patch({ textSize: undefined })}
          onChange={(v) => patch({ textSize: clampTo(specBounds(spec("textSize")), v) })}
        />
        <ChoiceInput<Weight>
          label="Label weight"
          value={block.labelWeight}
          def={spec("labelWeight").default as Weight}
          options={spec("labelWeight").options as readonly Weight[]}
          labels={WEIGHT_LABELS}
          onChange={(v) => patch({ labelWeight: v })}
        />
        <ChoiceInput<Weight>
          label="Value weight"
          value={block.valueWeight}
          def={spec("valueWeight").default as Weight}
          options={spec("valueWeight").options as readonly Weight[]}
          labels={WEIGHT_LABELS}
          onChange={(v) => patch({ valueWeight: v })}
        />
        <ColorInput
          label="Value colour"
          value={block.valueColor}
          inherited={base.textColor}
          inheritedFrom="the text colour"
          onReset={block.valueColor === undefined ? undefined : () => patch({ valueColor: undefined })}
          onChange={(v) => patch({ valueColor: v })}
        />
        <NumberInput
          label="Row spacing"
          value={block.rowPadding}
          {...numberField(spec("rowPadding"))}
          suffix="px"
          inherited={literalDefault(spec("rowPadding"))}
          inheritedFrom="the table default"
          onReset={block.rowPadding === undefined ? undefined : () => patch({ rowPadding: undefined })}
          onChange={(v) => patch({ rowPadding: clampTo(specBounds(spec("rowPadding")), v) })}
        />
        <NumberInput
          label="Line between rows"
          value={block.ruleWidth}
          {...numberField(spec("ruleWidth"))}
          suffix="px"
          inherited={literalDefault(spec("ruleWidth"))}
          inheritedFrom="the table default"
          onReset={block.ruleWidth === undefined ? undefined : () => patch({ ruleWidth: undefined })}
          onChange={(v) => patch({ ruleWidth: clampTo(specBounds(spec("ruleWidth")), v) })}
        />
      </Group>
      <Group id="odds_table.caption" title="Caption" summary={overrides(block, ["captionSize", "captionColor"])}>
        <NumberInput
          label="Caption size"
          value={block.captionSize}
          {...numberField(spec("captionSize"))}
          suffix="px"
          inherited={String(Math.max(11, base.fontSize - 4))}
          inheritedFrom="the block font size minus 4 (at least 11)"
          onReset={block.captionSize === undefined ? undefined : () => patch({ captionSize: undefined })}
          onChange={(v) => patch({ captionSize: clampTo(specBounds(spec("captionSize")), v) })}
        />
        <ColorInput
          label="Caption colour"
          value={block.captionColor}
          inherited={theme.mutedColor}
          inheritedFrom="the brand muted colour"
          onReset={block.captionColor === undefined ? undefined : () => patch({ captionColor: undefined })}
          onChange={(v) => patch({ captionColor: v })}
        />
      </Group>
    </>
  );
}

export function StandingsEditor({
  block,
  patch,
  theme,
  base,
}: LookProps<Extract<Block, { type: "standings" }>>) {
  const { columns, rows } = block;
  const spec = (path: string) => propSpec("standings", path);
  // La taille des en-têtes se déduit de celle des LIGNES (réglée ou non) : max(10, lignes − 1).
  const rowSize = block.textSize ?? Math.max(12, base.fontSize - 2);

  /** Une ligne est TOUJOURS réécrite à la largeur du tableau : jamais de cellule devinée. */
  const normalizeRow = (row: string[], index: number, value: string): string[] =>
    Array.from({ length: columns.length }, (_, k) => (k === index ? value : (row[k] ?? "")));

  return (
    <>
      <Note>
        A grid of strings, nothing more. The block does not know what it displays, so it cannot sort, rank or complete
        anything — every cell is typed or comes from a merge tag.
      </Note>

      <SectionTitle>Columns ({columns.length}/5)</SectionTitle>
      {columns.map((header, i) => (
        <TextInput
          key={i}
          label={`Header ${i + 1}`}
          value={header}
          maxLength={40}
          onChange={(v) => patch({ columns: columns.map((c, j) => (j === i ? v : c)) })}
          right={
            <MiniBtn
              label={`Remove column ${i + 1}`}
              danger
              disabled={columns.length <= 2}
              onClick={() =>
                patch({
                  columns: columns.filter((_, j) => j !== i),
                  rows: rows.map((r) => r.filter((_, j) => j !== i)),
                })
              }
            >
              <Trash2 className="h-3 w-3" strokeWidth={2.2} />
            </MiniBtn>
          }
        />
      ))}
      <MiniBtn
        label="Add column"
        disabled={columns.length >= 5}
        onClick={() => patch({ columns: [...columns, ""], rows: rows.map((r) => [...r, ""]) })}
      >
        <Plus className="h-3 w-3" strokeWidth={2.2} /> Add column
      </MiniBtn>

      <SectionTitle>Rows ({rows.length}/30)</SectionTitle>
      {rows.length === 0 && <Note>No rows yet — the table renders its headers only.</Note>}
      {rows.map((row, ri) => (
        <ListCard
          key={ri}
          group="standings.row"
          title={`Row ${ri + 1}`}
          preview={rowPreview(columns.map((_, ci) => row[ci]))}
          index={ri}
          total={rows.length}
          min={0}
          onMove={(dir) => patch({ rows: moved(rows, ri, dir) })}
          onRemove={() => patch({ rows: rows.filter((_, j) => j !== ri) })}
        >
          {columns.map((header, ci) => (
            <TokenTextInput
              key={ci}
              label={header.trim() === "" ? `Column ${ci + 1}` : header}
              value={row[ci] ?? ""}
              maxLength={60}
              onChange={(v) => patch({ rows: rows.map((r, j) => (j === ri ? normalizeRow(r, ci, v) : r)) })}
              hint={ri === 0 && ci === 0 ? REAL_DATA_HINT : undefined}
            />
          ))}
        </ListCard>
      ))}
      <MiniBtn
        label="Add standings row"
        disabled={rows.length >= 30}
        onClick={() => {
          openGroup(listCardId("standings.row", rows.length));
          patch({ rows: [...rows, columns.map(() => "")] });
        }}
      >
        <Plus className="h-3 w-3" strokeWidth={2.2} /> Add row
      </MiniBtn>

      <SectionTitle>Caption</SectionTitle>
      <TextAreaInput
        label="Caption (optional)"
        value={block.caption ?? ""}
        rows={2}
        maxLength={200}
        onChange={(v) => patch({ caption: v.trim() === "" ? undefined : v })}
        hint="Competition, match day, cut-off date — say what this snapshot is, and when it was taken."
      />

      {/* Ordre de lecture du tableau : l'en-tête, les lignes, puis la légende sous le tableau. */}
      <SectionTitle>Appearance</SectionTitle>
      <Group
        id="standings.header-row"
        title="Header row"
        summary={overrides(block, ["headerSize", "headerColor", "headerTransform", "headerRuleWidth"])}
      >
        <NumberInput
          label="Header size"
          value={block.headerSize}
          {...numberField(spec("headerSize"))}
          suffix="px"
          inherited={String(Math.max(10, rowSize - 1))}
          inheritedFrom="the row text size minus 1 (at least 10)"
          onReset={block.headerSize === undefined ? undefined : () => patch({ headerSize: undefined })}
          onChange={(v) => patch({ headerSize: clampTo(specBounds(spec("headerSize")), v) })}
        />
        <ColorInput
          label="Header colour"
          value={block.headerColor}
          inherited={theme.mutedColor}
          inheritedFrom="the brand muted colour"
          onReset={block.headerColor === undefined ? undefined : () => patch({ headerColor: undefined })}
          onChange={(v) => patch({ headerColor: v })}
        />
        <ChoiceInput<Transform>
          label="Header case"
          value={block.headerTransform}
          def={spec("headerTransform").default as Transform}
          options={spec("headerTransform").options as readonly Transform[]}
          labels={TRANSFORM_LABELS}
          onChange={(v) => patch({ headerTransform: v })}
        />
        <NumberInput
          label="Line under the header"
          value={block.headerRuleWidth}
          {...numberField(spec("headerRuleWidth"))}
          suffix="px"
          inherited={literalDefault(spec("headerRuleWidth"))}
          inheritedFrom="the table default"
          onReset={block.headerRuleWidth === undefined ? undefined : () => patch({ headerRuleWidth: undefined })}
          onChange={(v) => patch({ headerRuleWidth: clampTo(specBounds(spec("headerRuleWidth")), v) })}
        />
      </Group>
      <Group
        id="standings.table-style"
        title="Table style"
        summary={overrides(block, ["textSize", "firstColumnWeight", "firstColumnPct", "rowPadding", "ruleWidth"])}
      >
        <NumberInput
          label="Row text size"
          value={block.textSize}
          {...numberField(spec("textSize"))}
          suffix="px"
          inherited={String(Math.max(12, base.fontSize - 2))}
          inheritedFrom="the block font size minus 2 (at least 12)"
          onReset={block.textSize === undefined ? undefined : () => patch({ textSize: undefined })}
          onChange={(v) => patch({ textSize: clampTo(specBounds(spec("textSize")), v) })}
        />
        <ChoiceInput<Weight>
          label="First column weight"
          value={block.firstColumnWeight}
          def={spec("firstColumnWeight").default as Weight}
          options={spec("firstColumnWeight").options as readonly Weight[]}
          labels={WEIGHT_LABELS}
          onChange={(v) => patch({ firstColumnWeight: v })}
          hint={spec("firstColumnWeight").hint}
        />
        <NumberInput
          label="First column width"
          value={block.firstColumnPct}
          {...numberField(spec("firstColumnPct"))}
          suffix="%"
          inherited={literalDefault(spec("firstColumnPct"))}
          inheritedFrom="the table default"
          onReset={block.firstColumnPct === undefined ? undefined : () => patch({ firstColumnPct: undefined })}
          onChange={(v) => patch({ firstColumnPct: clampTo(specBounds(spec("firstColumnPct")), v) })}
        />
        <NumberInput
          label="Row spacing"
          value={block.rowPadding}
          {...numberField(spec("rowPadding"))}
          suffix="px"
          inherited={literalDefault(spec("rowPadding"))}
          inheritedFrom="the table default"
          onReset={block.rowPadding === undefined ? undefined : () => patch({ rowPadding: undefined })}
          onChange={(v) => patch({ rowPadding: clampTo(specBounds(spec("rowPadding")), v) })}
        />
        <NumberInput
          label="Line between rows"
          value={block.ruleWidth}
          {...numberField(spec("ruleWidth"))}
          suffix="px"
          inherited={literalDefault(spec("ruleWidth"))}
          inheritedFrom="the table default"
          onReset={block.ruleWidth === undefined ? undefined : () => patch({ ruleWidth: undefined })}
          onChange={(v) => patch({ ruleWidth: clampTo(specBounds(spec("ruleWidth")), v) })}
        />
      </Group>
      <Group id="standings.caption" title="Caption" summary={overrides(block, ["captionSize", "captionColor"])}>
        <NumberInput
          label="Caption size"
          value={block.captionSize}
          {...numberField(spec("captionSize"))}
          suffix="px"
          inherited={String(Math.max(11, base.fontSize - 4))}
          inheritedFrom="the block font size minus 4 (at least 11)"
          onReset={block.captionSize === undefined ? undefined : () => patch({ captionSize: undefined })}
          onChange={(v) => patch({ captionSize: clampTo(specBounds(spec("captionSize")), v) })}
        />
        <ColorInput
          label="Caption colour"
          value={block.captionColor}
          inherited={theme.mutedColor}
          inheritedFrom="the brand muted colour"
          onReset={block.captionColor === undefined ? undefined : () => patch({ captionColor: undefined })}
          onChange={(v) => patch({ captionColor: v })}
        />
      </Group>
    </>
  );
}

function ArticleEditor({
  block,
  patch,
  locale,
  theme,
  layers,
  defaultCtaLabel,
  onUseForAllTitles,
}: {
  block: Extract<Block, { type: "article" }>;
  patch: Patch;
  locale: string;
  theme: Theme;
  /** Styles de la row et de la colonne : la typographie par défaut de la carte en descend. */
  layers: (BoxStyle | undefined)[];
  /** `meta.defaultCtaLabel` : posé, il remplace le libellé de la langue (`withDefaultCta`). */
  defaultCtaLabel?: string;
  /** « Use for all titles » sous la couleur du titre (action `useForAllTitles`). */
  onUseForAllTitles?: (color: string) => void;
}) {
  const docLabel = defaultCtaLabel !== undefined && defaultCtaLabel.trim() !== "";
  const hasImage = block.imageSrc !== undefined;
  // ⛔ Reconstitue le seuil de `schema.ts:889` : `MediaField` n'avertit que si
  // `altRequired && alt.trim() === ""`, donc passer `title.trim() === ""` ici redonne exactement
  // « imageAlt vide ET titre vide ». Laisser le défaut `true` faisait annoncer un blocage que la
  // publication n'oppose plus, et poussait à recopier le titre dans l'alt — le lecteur d'écran
  // lisait alors deux fois la même phrase.
  // ⚠️ Le seuil se lit sur le TITRE seul, pas sur `imageAlt` : sinon le libellé basculerait de
  // « required » à « optional » sous les doigts, au premier caractère tapé dans le champ.
  const altRequired = block.title.trim() === "";

  return (
    <>
      <TokenTextInput
        label="Title"
        value={block.title}
        maxLength={200}
        onChange={(v) => patch({ title: v })}
      />
      <TextAreaInput
        label="Excerpt"
        value={block.excerpt}
        rows={4}
        maxLength={1000}
        onChange={(v) => patch({ excerpt: v })}
        hint="Plain text. Line breaks become <br> — no HTML is accepted here."
      />
      <TextInput
        label="Link"
        value={block.href}
        onChange={(v) => patch({ href: v })}
        placeholder="https://example.com/article"
        warning={block.href.trim() === "" ? "A link is required — the whole card is clickable." : undefined}
      />

      {/* L'apparence (lien de lecture, surtitre, titre, pied, vignette) est le MÊME jeu de champs que
          la une et les brèves d'un flux : `ArticleLookFields`. Ne restent ici que les TEXTES qu'un
          article écrit à la main porte seul, passés en emplacements. */}
      <ArticleLookFields
        mode="article"
        value={block}
        onPatch={patch}
        theme={theme}
        base={resolveLookBase(theme, [...layers, block.style])}
        accent={{ color: theme.brandColor, from: "the brand colour" }}
        onUseForAllTitles={onUseForAllTitles}
        cta={{
          // Le vide est ACCEPTÉ et stocké ABSENT : le défaut se MONTRE en héritage (grisé) au lieu de
          // s'écrire, et n'est posé qu'à la compilation. Le réécrire DANS le `onChange` d'un champ
          // contrôlé sans debounce faisait ça : un Ctrl+A ⌫ réinjectait « Read more » sous le
          // curseur, et la frappe suivante partait en production sous la forme « Read moreFull
          // story » — 19 caractères, sous la limite, donc aucune alerte. C'est aussi ce qui garde
          // vraie l'équivalence dont le rendu dépend : un `ctaLabel` stocké signifie qu'un humain
          // l'a tapé.
          // ⛔ L'HÉRITAGE N'EST MONTRÉ QUE S'IL EST VRAI. Le rendu ne pose aucun défaut sur un href
          // qui ne mène nulle part : afficher « Inherited: Read more » sous un lien mort annonçait
          // un libellé que la compilation refuse de fabriquer, et l'auteur n'avait aucune raison
          // d'aller corriger le lien. Sans héritage, l'avertissement dit la cause à sa place.
          inherited: goesNowhere(block.href) ? undefined : defaultArticleCta(locale, defaultCtaLabel),
          inheritedFrom: docLabel ? "the document's default read-link label" : "this document's language",
          hint: "Left empty, the document's default read-link label (Settings) is sent — as long as the link above goes somewhere.",
          warning:
            goesNowhere(block.href) && (block.ctaLabel ?? "").trim() === ""
              ? "The link above goes nowhere, so no default label is added: this card ships with no call to action. Point the link at the article to get one."
              : undefined,
        }}
        slots={{
          kicker: (
            <>
              <TextInput
                label="Kicker"
                value={block.kicker ?? ""}
                maxLength={120}
                onChange={(v) => patch({ kicker: v.trim() === "" ? undefined : v })}
                onReset={block.kicker === undefined ? undefined : () => patch({ kicker: undefined })}
                hint="Rendered above the title — above the image when the card is stacked."
              />
              <TextInput
                label="Kicker accent"
                value={block.kickerAccent ?? ""}
                maxLength={80}
                onChange={(v) => patch({ kickerAccent: v.trim() === "" ? undefined : v })}
                onReset={block.kickerAccent === undefined ? undefined : () => patch({ kickerAccent: undefined })}
                hint="Follows the kicker on the same line, in the accent colour — one string cannot hold two colours. Include your own separator, e.g. “ · 13:50”."
              />
            </>
          ),
          meta: (
            <>
              <TextInput
                label="Meta"
                value={block.meta ?? ""}
                maxLength={200}
                onChange={(v) => patch({ meta: v.trim() === "" ? undefined : v })}
                onReset={block.meta === undefined ? undefined : () => patch({ meta: undefined })}
                hint="Under the excerpt — a byline, a date. Leave the trailing separator here, e.g. “Michael Kenrick · ”."
              />
              <TextInput
                label="Meta accent"
                value={block.metaAccent ?? ""}
                maxLength={80}
                onChange={(v) => patch({ metaAccent: v.trim() === "" ? undefined : v })}
                onReset={block.metaAccent === undefined ? undefined : () => patch({ metaAccent: undefined })}
                hint="The coloured half of the meta line — “27 comments”, “15:29”."
              />
            </>
          ),
          image: hasImage ? (
            <>
              <MediaField
                src={block.imageSrc ?? ""}
                alt={block.imageAlt}
                srcLabel="Image URL"
                altLabel={altRequired ? "Alt text (required)" : "Alt text (optional)"}
                altRequired={altRequired}
                altHint={
                  altRequired
                    ? undefined
                    : "The title beside it already names this image, so an empty alt is what screen readers should get — repeating the title makes them read it twice."
                }
                onSrc={(v) => patch({ imageSrc: v.trim() === "" ? undefined : v })}
                onAlt={(v) => patch({ imageAlt: v })}
                onPick={(m) => patch({ imageSrc: m.src, imageAlt: m.alt })}
              />
              <div className="mb-3">
                <MiniBtn label="Remove image" danger onClick={() => patch({ imageSrc: undefined })}>
                  <Trash2 className="h-3 w-3" strokeWidth={2.2} /> Remove image
                </MiniBtn>
              </div>
            </>
          ) : (
            <>
              <Note>No image — the card renders title, excerpt and link only, always stacked.</Note>
              <div className="mb-3">
                <MiniBtn label="Add an image" onClick={() => patch({ imageSrc: "https://placehold.co/600x360" })}>
                  <Plus className="h-3 w-3" strokeWidth={2.2} /> Add an image
                </MiniBtn>
              </div>
            </>
          ),
        }}
      />
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Châssis de marque — les blocs qui remplacent le HTML brut
 * ------------------------------------------------------------------ */

/**
 * Titre de section. Le bloc ne porte QUE la géométrie du filet : taille, graisse, casse et
 * interlettrage du libellé viennent de l'onglet Style, comme pour tout autre bloc. Les dupliquer
 * ici donnerait deux endroits pour régler la même chose, et ils divergeraient.
 */
export function SectionTitleEditor({ block, patch }: { block: Extract<Block, { type: "section_title" }>; patch: Patch }) {
  const gapSpec = propSpec("section_title", "ruleGap");
  return (
    <>
      <TokenTextInput
        label="Label"
        value={block.label}
        maxLength={120}
        onChange={(v) => patch({ label: v })}
        warning={block.label.trim() === "" ? "An empty label makes the block unpublishable." : undefined}
      />
      {/* Les formes viennent du SCHÉMA (`SECTION_RULES`) : « before » et « both », ajoutées le
          22/09/2026, apparaissent d'elles-mêmes — une liste tapée ici les avait laissées hors d'atteinte. */}
      <SelectInput<(typeof SECTION_RULES)[number]>
        label="Rule"
        value={block.rule}
        options={SECTION_RULES.map((r) => ({ value: r, label: SECTION_RULE_LABELS[r] ?? r }))}
        onChange={(v) => patch({ rule: v })}
        hint="“After” fills the width right of the label, on the same baseline; “Before” mirrors it for a right-aligned title, “Both sides” frames a centred one. “Vertical bar” sits against the label instead."
      />
      {block.rule !== "none" && (
        <>
          <NumberInput
            label="Rule thickness"
            value={block.ruleThickness}
            min={1}
            max={6}
            suffix="px"
            onChange={(v) => patch({ ruleThickness: clampNum(v, 2, 1, 6) })}
          />
          <ColorInput
            label="Rule color"
            value={block.ruleColor}
            inherited="Border color"
            inheritedFrom="the Style tab"
            onReset={block.ruleColor === undefined ? undefined : () => patch({ ruleColor: undefined })}
            onChange={(v) => patch({ ruleColor: v })}
          />
          <NumberInput
            label="Gap to the rule"
            value={block.ruleGap}
            {...numberField(gapSpec)}
            suffix="px"
            // Le défaut dépend de la forme choisie (12 / 9 / 8) : on montre celui qui s'applique.
            inherited={String(RULE_GAP_DEFAULT[block.rule] ?? 12)}
            inheritedFrom="this rule’s default"
            onReset={block.ruleGap === undefined ? undefined : () => patch({ ruleGap: undefined })}
            onChange={(v) => patch({ ruleGap: clampTo(specBounds(gapSpec), v) })}
          />
        </>
      )}
      <Note>Size, weight, letter-spacing and case come from the Style tab — they cascade like any other block.</Note>
    </>
  );
}

/** Les mises en page de l'encart, telles que la liste les propose (ordre du schéma). */
const CALLOUT_LAYOUT_LABELS: Record<CalloutLayout, string> = {
  poster: "Poster — text on a full picture",
  player: "Player — picture, play button, progress bar",
  cover: "Cover — square artwork beside the text",
  wave: "Wave — round thumbnail and waveform",
  gallery: "Gallery — up to three pictures",
  strip: "Strip — compact band, button on the right",
  ticket: "Ticket — picture and a dashed stub",
};

/**
 * Ce que chaque mise en page LIT (`compile/callout-layouts.ts`) : l'inspecteur n'offre que ces
 * champs-là. ⚠️ Un champ offert sous une mise en page qui l'ignore serait un réglage sans effet —
 * exactement ce que la règle « tout ce qui est réglable part chez l'abonné » interdit.
 */
const LAYOUT_READS = {
  background: ["poster", "player", "cover", "strip", "ticket"],
  vAlign: ["poster", "strip", "ticket"],
  badge: ["player", "cover", "strip"],
  progress: ["player", "wave"],
  stub: ["cover", "gallery", "ticket"],
  stubText: ["gallery", "ticket"],
} satisfies Record<string, CalloutLayout[]>;
const layoutReads = (what: keyof typeof LAYOUT_READS, layout: CalloutLayout | undefined): layout is CalloutLayout =>
  layout !== undefined && (LAYOUT_READS[what] as CalloutLayout[]).includes(layout);

const V_ALIGN_LABELS: Record<string, string> = { top: "Top", middle: "Middle", bottom: "Bottom" };
const KICKER_STYLE_LABELS: Record<string, string> = { plain: "Plain text", dot: "Leading dot", pill: "Pill" };
const FRAMING_LABELS: Record<string, string> = { left: "Left", center: "Centre", right: "Right — subject on the right" };

/** Encart d'appel : un aplat, du texte, et un bouton optionnel. */
export function CalloutEditor({
  block,
  patch,
  theme,
  base,
  onUseForAllTitles,
}: LookProps<Extract<Block, { type: "callout" }>> & { onUseForAllTitles?: (color: string) => void }) {
  const hasLabel = block.ctaLabel !== undefined && block.ctaLabel.trim() !== "";
  const spec = (path: string) => propSpec("callout", path);
  const layout = block.layout;
  const layoutDefault = layout === undefined ? undefined : CALLOUT_LAYOUT_DEFAULTS[layout];
  const tiles = block.gallery ?? [];
  // La graisse du titre suit celle du bloc (Style), sinon 700 : c'est la valeur à montrer ET à ne
  // pas écrire quand on la choisit (`ChoiceInput`).
  const titleWeightDefault: Weight = base.fontWeight ?? "700";
  return (
    <>
      <TokenTextInput
        label="Kicker (optional)"
        value={block.kicker}
        maxLength={80}
        onChange={(v) => patch({ kicker: v })}
        hint="Short line above the title. Empty = the line is not rendered."
      />
      <TokenTextInput label="Title" value={block.title} maxLength={200} onChange={(v) => patch({ title: v })} />
      <TextAreaInput label="Body" value={block.body} rows={3} maxLength={1000} onChange={(v) => patch({ body: v })} />

      <SectionTitle>Call to action</SectionTitle>
      {/*
        ⛔ Les deux champs sont OPTIONNELS et le restent. Un `href` de remplissage posé ici — même
        `https://example.com` — ferait exactement la faute réparée le 28/08 sur le CTA d'article :
        une valeur fabriquée devient indiscernable d'une saisie, et plus aucune garde en aval ne
        peut refuser de dessiner le bouton.
      */}
      <TextInput
        label="Link (optional)"
        value={block.href ?? ""}
        onChange={(v) => patch({ href: v.trim() === "" ? undefined : v })}
        placeholder="https://example.com/page"
        warning={hasLabel && block.href === undefined ? "A label without a link renders no button." : undefined}
      />
      <TextInput
        label="Button label (optional)"
        value={block.ctaLabel ?? ""}
        maxLength={MAX_BUTTON_LABEL}
        onChange={(v) => patch({ ctaLabel: v.trim() === "" ? undefined : v })}
        warning={block.href !== undefined && !hasLabel ? "A link without a label renders no button." : undefined}
      />

      <SectionTitle>Thumbnail</SectionTitle>
      {block.imageSrc === undefined ? (
        <>
          <Note>No thumbnail — the panel is one column.</Note>
          <MiniBtn label="Add a thumbnail" onClick={() => patch({ imageSrc: "https://placehold.co/300x300" })}>
            <Plus className="h-3 w-3" strokeWidth={2.2} /> Add a thumbnail
          </MiniBtn>
        </>
      ) : (
        <>
          <MediaField
            src={block.imageSrc}
            alt={block.imageAlt ?? ""}
            srcLabel="Image URL"
            altLabel="Alt text (optional)"
            altRequired={false}
            altHint="The title beside it already names this image, so an empty alt is what screen readers should get."
            onSrc={(v) => patch({ imageSrc: v.trim() === "" ? undefined : v })}
            onAlt={(v) => patch({ imageAlt: v })}
            onPick={(m) => patch({ imageSrc: m.src, imageAlt: m.alt })}
          />
          <MiniBtn label="Remove thumbnail" danger onClick={() => patch({ imageSrc: undefined })}>
            <Trash2 className="h-3 w-3" strokeWidth={2.2} /> Remove thumbnail
          </MiniBtn>
        </>
      )}

      {/* Ordre de lecture de l'encart : le texte (surtitre, titre, paragraphe), le bouton, puis l'aplat
          qui les porte (barre d'accent, part de la vignette, marges). */}
      <SectionTitle>Appearance</SectionTitle>
      {/*
        Mises en page (23/09/2026). En tête : la mise en page décide de quels autres réglages ont un
        effet. ⛔ `src` et `alt` sont listés parce qu'ils sont ÉCRITS ici (dans les cases de `gallery`) :
        ce ne sont pas des clés du bloc, ils ne comptent donc jamais dans le résumé.
      */}
      <Group
        id="callout.layout"
        title="Background & layout"
        summary={overrides(block, [
          "layout",
          "backgroundImage",
          "backgroundPosition",
          "minHeight",
          "contentVAlign",
          "kickerStyle",
          "kickerAccent",
          "playBackground",
          "playColor",
          "progress",
          "progressColor",
          "progressTrackColor",
          "waveSeed",
          "stubBackground",
          "stubTextColor",
          "gallery",
          "src",
          "alt",
          "ctaFullWidth",
        ])}
      >
        <SelectInput<CalloutLayout | "classic">
          label="Layout"
          value={layout ?? "classic"}
          options={[
            { value: "classic", label: "Classic panel" },
            ...CALLOUT_LAYOUTS.map((l) => ({ value: l, label: CALLOUT_LAYOUT_LABELS[l] })),
          ]}
          // « Classic panel » RETIRE la clé : l'encart d'avant, à l'octet près.
          onChange={(v) => patch({ layout: v === "classic" ? undefined : v })}
          hint="For a duo, put two poster callouts in a two-column row."
        />
        {layout === undefined && (
          <Note>Background colour, text and button. Pick a layout to put a picture behind the text, a player, a waveform or a gallery.</Note>
        )}
        {layoutReads("background", layout) &&
          (block.backgroundImage === undefined ? (
            <MiniBtn label="Add a background picture" onClick={() => patch({ backgroundImage: "https://placehold.co/1200x720" })}>
              <Plus className="h-3 w-3" strokeWidth={2.2} /> Add a background picture
            </MiniBtn>
          ) : (
            <>
              <MediaField
                src={block.backgroundImage}
                srcLabel="Background picture"
                srcHint={
                  layout === "cover"
                    ? "Shown as the square artwork. When images are off, readers see the picture box colour below."
                    : "Must be a public https:// URL. When images are off, readers see the block background (Style tab) instead."
                }
                onSrc={(v) => patch({ backgroundImage: v.trim() === "" ? undefined : v })}
                onPick={(m) => patch({ backgroundImage: m.src })}
              />
              {layout !== "cover" && block.style?.backgroundColor === undefined && (
                <Note>
                  No fallback colour yet — set the block background in the Style tab. Without it, text on the picture falls on the
                  page colour when images are off.
                </Note>
              )}
              <MiniBtn label="Remove background picture" danger onClick={() => patch({ backgroundImage: undefined })}>
                <Trash2 className="h-3 w-3" strokeWidth={2.2} /> Remove background picture
              </MiniBtn>
              <ChoiceInput
                label="Picture framing"
                value={block.backgroundPosition}
                def="center"
                options={spec("backgroundPosition").options as readonly ("left" | "center" | "right")[]}
                labels={FRAMING_LABELS}
                onChange={(v) => patch({ backgroundPosition: v })}
              />
            </>
          ))}
        {layoutReads("background", layout) && (
          <NumberInput
            label="Picture height"
            value={block.minHeight}
            {...numberField(spec("minHeight"))}
            suffix="px"
            inherited={String(layoutDefault?.minHeight)}
            inheritedFrom="the layout"
            onReset={block.minHeight === undefined ? undefined : () => patch({ minHeight: undefined })}
            onChange={(v) => patch({ minHeight: clampTo(specBounds(spec("minHeight")), v) })}
          />
        )}
        {layoutReads("vAlign", layout) && (
          <ChoiceInput
            label="Text position"
            value={block.contentVAlign}
            def={layoutDefault?.contentVAlign ?? "middle"}
            options={spec("contentVAlign").options as readonly ("top" | "middle" | "bottom")[]}
            labels={V_ALIGN_LABELS}
            onChange={(v) => patch({ contentVAlign: v })}
          />
        )}
        {layout === "wave" && <Note>The round picture is the Thumbnail above.</Note>}
        {layout !== undefined && (
          <ChoiceInput
            label="Kicker style"
            value={block.kickerStyle}
            def="plain"
            options={spec("kickerStyle").options as readonly ("plain" | "dot" | "pill")[]}
            labels={KICKER_STYLE_LABELS}
            onChange={(v) => patch({ kickerStyle: v })}
          />
        )}
        {layout !== undefined && (block.kickerStyle === "dot" || block.kickerStyle === "pill") && (
          <ColorInput
            label={block.kickerStyle === "dot" ? "Dot color" : "Pill color"}
            value={block.kickerAccent}
            inherited="Brand color"
            inheritedFrom="Email styles"
            onReset={block.kickerAccent === undefined ? undefined : () => patch({ kickerAccent: undefined })}
            onChange={(v) => patch({ kickerAccent: v })}
          />
        )}
        {layoutReads("badge", layout) && (
          <>
            <ColorInput
              label="Badge background"
              value={block.playBackground}
              inherited="Button background"
              inheritedFrom="this callout"
              hint={layout === "strip" ? "The round + on the left." : "The round ▶ play badge."}
              onReset={block.playBackground === undefined ? undefined : () => patch({ playBackground: undefined })}
              onChange={(v) => patch({ playBackground: v })}
            />
            <ColorInput
              label="Badge glyph"
              value={block.playColor}
              inherited="Button text"
              inheritedFrom="this callout"
              onReset={block.playColor === undefined ? undefined : () => patch({ playColor: undefined })}
              onChange={(v) => patch({ playColor: v })}
            />
          </>
        )}
        {layoutReads("progress", layout) && (
          <>
            <NumberInput
              label="Played share"
              value={block.progress}
              {...numberField(spec("progress"))}
              suffix="%"
              inherited={String(layoutDefault?.progress)}
              inheritedFrom="the layout"
              onReset={block.progress === undefined ? undefined : () => patch({ progress: undefined })}
              onChange={(v) => patch({ progress: clampTo(specBounds(spec("progress")), v) })}
            />
            <ColorInput
              label="Played color"
              value={block.progressColor}
              inherited="Brand color"
              inheritedFrom="Email styles"
              onReset={block.progressColor === undefined ? undefined : () => patch({ progressColor: undefined })}
              onChange={(v) => patch({ progressColor: v })}
            />
            <ColorInput
              label="Track color"
              value={block.progressTrackColor}
              inherited="Muted color"
              inheritedFrom="Email styles"
              onReset={block.progressTrackColor === undefined ? undefined : () => patch({ progressTrackColor: undefined })}
              onChange={(v) => patch({ progressTrackColor: v })}
            />
          </>
        )}
        {layout === "wave" && (
          <NumberInput
            label="Waveform shape"
            value={block.waveSeed}
            {...numberField(spec("waveSeed"))}
            inherited={literalDefault(spec("waveSeed"))}
            inheritedFrom="the layout"
            onReset={block.waveSeed === undefined ? undefined : () => patch({ waveSeed: undefined })}
            onChange={(v) => patch({ waveSeed: clampTo(specBounds(spec("waveSeed")), v) })}
          />
        )}
        {layoutReads("stub", layout) && (
          <ColorInput
            label={layout === "ticket" ? "Stub color" : "Picture box color"}
            value={block.stubBackground}
            inherited="Brand color"
            inheritedFrom="Email styles"
            hint={layout === "ticket" ? undefined : "What readers see in place of the picture when images are off."}
            onReset={block.stubBackground === undefined ? undefined : () => patch({ stubBackground: undefined })}
            onChange={(v) => patch({ stubBackground: v })}
          />
        )}
        {layoutReads("stubText", layout) && (
          <ColorInput
            label={layout === "ticket" ? "Stub text color" : "Alt text color"}
            value={block.stubTextColor}
            inherited={layout === "ticket" && block.bodyColor !== undefined ? block.bodyColor : "Button text color"}
            inheritedFrom={layout === "ticket" && block.bodyColor !== undefined ? "the body colour" : "Email styles"}
            onReset={block.stubTextColor === undefined ? undefined : () => patch({ stubTextColor: undefined })}
            onChange={(v) => patch({ stubTextColor: v })}
          />
        )}
        {layout === "gallery" && (
          <>
            {/* ⚠️ `gallery` est réécrit EN ENTIER : `updateBlock` fusionne au premier niveau seulement. */}
            {tiles.map((tile, i) => (
              <div key={i}>
                <MediaField
                  src={tile.src}
                  alt={tile.alt}
                  srcLabel={`Picture ${i + 1}`}
                  altLabel={`Picture ${i + 1} alt text`}
                  altRequired={false}
                  altHint="Empty = the picture is not linked: a link without a name only says “link” to screen readers."
                  onSrc={(v) => patch({ gallery: tiles.map((t, j) => (j === i ? { ...t, src: v } : t)) })}
                  onAlt={(v) => patch({ gallery: tiles.map((t, j) => (j === i ? { ...t, alt: v } : t)) })}
                  onPick={(m) => patch({ gallery: tiles.map((t, j) => (j === i ? { src: m.src, alt: m.alt } : t)) })}
                />
                <MiniBtn
                  label={`Remove picture ${i + 1}`}
                  danger
                  // Le schéma veut 1 case au moins : la dernière retirée, la grille disparaît.
                  onClick={() => patch({ gallery: tiles.length === 1 ? undefined : tiles.filter((_, j) => j !== i) })}
                >
                  <Trash2 className="h-3 w-3" strokeWidth={2.2} /> Remove picture {i + 1}
                </MiniBtn>
              </div>
            ))}
            {tiles.length < 3 && (
              <MiniBtn
                label="Add a gallery picture"
                onClick={() => patch({ gallery: [...tiles, { src: "https://placehold.co/400x400", alt: "" }] })}
              >
                <Plus className="h-3 w-3" strokeWidth={2.2} /> Add a gallery picture
              </MiniBtn>
            )}
          </>
        )}
        {layout !== undefined && block.href !== undefined && hasLabel && (
          <CheckboxInput
            label="Button width"
            text="Full width of its area"
            checked={block.ctaFullWidth === true}
            onChange={(v) => patch({ ctaFullWidth: v ? true : undefined })}
          />
        )}
      </Group>
      <Group
        id="callout.text"
        title="Text"
        summary={overrides(block, [
          "kickerSize",
          "kickerColor",
          "titleFont",
          "titleSize",
          "titleColor",
          "titleWeight",
          "titleLineHeight",
          "bodyFont",
          "bodyColor",
        ])}
      >
        <NumberInput
          label="Kicker size"
          value={block.kickerSize}
          min={8}
          max={40}
          suffix="px"
          onReset={block.kickerSize === undefined ? undefined : () => patch({ kickerSize: undefined })}
          onChange={(v) => patch({ kickerSize: v === undefined ? undefined : clampNum(v, 12, 8, 40) })}
        />
        <ColorInput
          label="Kicker color"
          value={block.kickerColor}
          inherited="Muted color"
          inheritedFrom="Email styles"
          onReset={block.kickerColor === undefined ? undefined : () => patch({ kickerColor: undefined })}
          onChange={(v) => patch({ kickerColor: v })}
        />
        {/* Même menu que partout ailleurs (bouton, code promo, looks d'article) ; une pile écrite à la
            main reste proposée telle quelle (« Custom: … »), la clé écrite ne change pas. */}
        <FontInput
          label="Title font"
          value={block.titleFont}
          inherited={base.headingFont}
          inheritedLabel={base.headingFontIsEmail ? "Email title font" : "Same as the block"}
          theme={theme}
          onChange={(v) => patch({ titleFont: v })}
          hint="Also used by the button, unless the button sets its own font."
        />
        <NumberInput
          label="Title size"
          value={block.titleSize}
          min={8}
          max={72}
          suffix="px"
          onReset={block.titleSize === undefined ? undefined : () => patch({ titleSize: undefined })}
          onChange={(v) => patch({ titleSize: v === undefined ? undefined : clampNum(v, 20, 8, 72) })}
        />
        <ColorInput
          label="Title color"
          value={block.titleColor}
          inherited={base.headingColor}
          inheritedFrom={base.headingColorIsEmail ? "the email title style" : "the text colour"}
          onReset={block.titleColor === undefined ? undefined : () => patch({ titleColor: undefined })}
          onChange={(v) => patch({ titleColor: v })}
        />
        {block.titleColor !== undefined && onUseForAllTitles && (
          <UseForAllTitles color={block.titleColor} onUse={onUseForAllTitles} />
        )}
        <ChoiceInput<Weight>
          label="Title weight"
          value={block.titleWeight}
          def={titleWeightDefault}
          options={spec("titleWeight").options as readonly Weight[]}
          labels={WEIGHT_LABELS}
          onChange={(v) => patch({ titleWeight: v })}
          hint={base.fontWeight === undefined ? undefined : "The default follows the font weight of the Style tab."}
        />
        <NumberInput
          label="Title line height"
          value={block.titleLineHeight}
          {...numberField(spec("titleLineHeight"))}
          inherited={literalDefault(spec("titleLineHeight"))}
          inheritedFrom="the callout default"
          onReset={block.titleLineHeight === undefined ? undefined : () => patch({ titleLineHeight: undefined })}
          onChange={(v) => patch({ titleLineHeight: clampTo(specBounds(spec("titleLineHeight")), v) })}
        />
        <FontInput
          label="Body font"
          value={block.bodyFont}
          inherited={base.fontFamily}
          inheritedLabel="Same as the block"
          theme={theme}
          onChange={(v) => patch({ bodyFont: v })}
        />
        <ColorInput
          label="Body color"
          value={block.bodyColor}
          inherited="Text color"
          inheritedFrom="the Style tab"
          onReset={block.bodyColor === undefined ? undefined : () => patch({ bodyColor: undefined })}
          onChange={(v) => patch({ bodyColor: v })}
        />
      </Group>
      {block.href !== undefined && hasLabel && (
        <Group
          id="callout.button"
          title="Button style"
          summary={overrides(block, [
            "ctaBackground",
            "ctaTextColor",
            "ctaFont",
            "ctaSize",
            "ctaWeight",
            "ctaPadding",
            "ctaRadius",
          ])}
        >
          <ColorInput
            label="Button background"
            value={block.ctaBackground}
            inherited="Brand color"
            inheritedFrom="Email styles"
            onReset={block.ctaBackground === undefined ? undefined : () => patch({ ctaBackground: undefined })}
            onChange={(v) => patch({ ctaBackground: v })}
          />
          <ColorInput
            label="Button text"
            value={block.ctaTextColor}
            inherited="Button text color"
            inheritedFrom="Email styles"
            onReset={block.ctaTextColor === undefined ? undefined : () => patch({ ctaTextColor: undefined })}
            onChange={(v) => patch({ ctaTextColor: v })}
          />
          <FontInput
            label="Button font"
            value={block.ctaFont}
            // Rendu : `ctaFont`, sinon la police du titre, sinon celle du bloc.
            inherited={block.titleFont ?? base.fontFamily}
            inheritedLabel={block.titleFont !== undefined ? "Same as the title" : "Same as the block"}
            theme={theme}
            onChange={(v) => patch({ ctaFont: v })}
            hint={spec("ctaFont").hint}
          />
          {/* Les couleurs du bouton sont juste au-dessus : elles existaient avant le jeu commun. */}
          <CardButtonFields
            target="callout"
            value={block}
            onPatch={patch}
            theme={theme}
            fontSize={base.fontSize}
            radius={blockRadius(block.style, theme)}
            withColours={false}
          />
        </Group>
      )}
      {/* La largeur de la vignette est de la géométrie de l'aplat (sa part du panneau) : elle vit ici,
          et n'apparaît qu'avec une vignette. */}
      <Group
        id="callout.panel"
        title="Panel"
        // `accentWidth` a un défaut de schéma (0 = pas de barre) : toujours présent, il ne compte comme
        // réglé qu'au-dessus de 0 — sinon un encart neuf se lirait « 1 set ».
        summary={overrides({ ...block, accentWidth: block.accentWidth > 0 ? block.accentWidth : undefined }, [
          "accentWidth",
          "accentColor",
          "imageWidthPct",
          "innerPadding",
        ])}
      >
        <Note>The panel background is the block background — set it in the Style tab.</Note>
        <NumberInput
          label="Accent bar"
          value={block.accentWidth}
          min={0}
          max={12}
          suffix="px"
          onChange={(v) => patch({ accentWidth: clampNum(v, 0, 0, 12) })}
          hint="Vertical bar on the left edge. 0 = none."
        />
        {block.accentWidth > 0 && (
          <ColorInput
            label="Accent color"
            value={block.accentColor}
            inherited="Brand color"
            inheritedFrom="Email styles"
            onReset={block.accentColor === undefined ? undefined : () => patch({ accentColor: undefined })}
            onChange={(v) => patch({ accentColor: v })}
          />
        )}
        {/* Une mise en page ne lit pas cette part (l'Onde pose sa vignette ronde à 72 px). */}
        {block.imageSrc !== undefined && layout === undefined && (
          <NumberInput
            label="Thumbnail width"
            value={block.imageWidthPct}
            min={10}
            max={60}
            suffix="%"
            onReset={block.imageWidthPct === undefined ? undefined : () => patch({ imageWidthPct: undefined })}
            onChange={(v) => patch({ imageWidthPct: v === undefined ? undefined : clampNum(v, 24, 10, 60) })}
            hint="Share of the panel taken by the image, on its right. Empty = 24%."
          />
        )}
        <SpacingInput
          label="Inner padding (px)"
          value={block.innerPadding}
          defaults={{ top: 20, right: 24, bottom: 20, left: 24 }}
          inheritedFrom="the callout default"
          onChange={(next) => patch({ innerPadding: next })}
        />
      </Group>
    </>
  );
}

/** Bandeau de résultat. Comme les autres blocs sportifs : rien n'est calculé, tout est saisi. */
export function ScoreboardEditor({ block, patch, theme, base }: LookProps<Extract<Block, { type: "scoreboard" }>>) {
  const rows = block.rows;
  const spec = (path: string) => propSpec("scoreboard", path);
  const border = blockBorder(block.style, theme);
  // ⚠️ Le tableau est remplacé EN ENTIER : `updateBlock` fusionne au premier niveau seulement, un
  // patch partiel du tableau perdrait les autres lignes.
  const setRow = (i: number, next: Partial<ScoreboardRow>) =>
    patch({ rows: rows.map((r, j) => (j === i ? { ...r, ...next } : r)) });

  return (
    <>
      <Note>
        Two columns of plain strings: a label on the left, the value you typed on the right. Nothing is looked up or
        recalculated at send time.
      </Note>
      <TokenTextInput
        label="Kicker (optional)"
        value={block.kicker}
        maxLength={80}
        onChange={(v) => patch({ kicker: v })}
        placeholder="Next match"
      />

      <SectionTitle>Rows ({rows.length}/4)</SectionTitle>
      {rows.map((row, i) => (
        <ListCard
          key={i}
          group="scoreboard.row"
          title={`Row ${i + 1}`}
          preview={rowPreview([row.label, row.value])}
          index={i}
          total={rows.length}
          min={2}
          onMove={(dir) => patch({ rows: moved(rows, i, dir) })}
          onRemove={() => patch({ rows: rows.filter((_, j) => j !== i) })}
        >
          <TokenTextInput label="Label" value={row.label} maxLength={120} onChange={(v) => setRow(i, { label: v })} />
          <TokenTextInput
            label="Value"
            value={row.value}
            maxLength={8}
            onChange={(v) => setRow(i, { value: v })}
            hint={i === 0 ? REAL_DATA_HINT : undefined}
          />
          <CheckboxInput
            label="Emphasis"
            text="Show this value in the brand color"
            checked={row.highlight}
            onChange={(v) => setRow(i, { highlight: v })}
          />
        </ListCard>
      ))}
      <MiniBtn
        label="Add scoreboard row"
        disabled={rows.length >= 4}
        onClick={() => {
          openGroup(listCardId("scoreboard.row", rows.length));
          patch({ rows: [...rows, { label: "", value: "", highlight: false }] });
        }}
      >
        <Plus className="h-3 w-3" strokeWidth={2.2} /> Add row
      </MiniBtn>

      <SectionTitle>Footer</SectionTitle>
      <Note>A rule, then a link and a note — “What we learned › — Thierno Barry was the star of the show.”</Note>
      <TextInput
        label="Footer link label"
        value={block.footerLabel ?? ""}
        maxLength={120}
        onChange={(v) => patch({ footerLabel: v.trim() === "" ? undefined : v })}
        onReset={block.footerLabel === undefined ? undefined : () => patch({ footerLabel: undefined })}
        hint="Without a URL below it stays plain text — no dead link is drawn."
      />
      <TextInput
        label="Footer link URL"
        value={block.footerHref ?? ""}
        onChange={(v) => patch({ footerHref: v.trim() === "" ? undefined : v })}
        onReset={block.footerHref === undefined ? undefined : () => patch({ footerHref: undefined })}
        placeholder="https://example.com/match-report"
      />
      <TextInput
        label="Footer note"
        value={block.footerNote ?? ""}
        maxLength={300}
        onChange={(v) => patch({ footerNote: v.trim() === "" ? undefined : v })}
        onReset={block.footerNote === undefined ? undefined : () => patch({ footerNote: undefined })}
      />

      {/* Ordre de lecture du bandeau : le surtitre et les lignes, leurs couleurs, le pied, puis l'aplat. */}
      <SectionTitle>Appearance</SectionTitle>
      <Group
        id="scoreboard.text"
        title="Text"
        summary={overrides(block, ["kickerSize", "kickerColor", "labelSize", "valueSize"])}
      >
        <NumberInput
          label="Kicker size"
          value={block.kickerSize}
          {...numberField(spec("kickerSize"))}
          suffix="px"
          inherited={String(Math.max(11, base.fontSize - 4))}
          inheritedFrom="the block font size minus 4 (at least 11)"
          onReset={block.kickerSize === undefined ? undefined : () => patch({ kickerSize: undefined })}
          onChange={(v) => patch({ kickerSize: clampTo(specBounds(spec("kickerSize")), v) })}
        />
        <ColorInput
          label="Kicker color"
          value={block.kickerColor}
          inherited="Muted color"
          inheritedFrom="Email styles"
          onReset={block.kickerColor === undefined ? undefined : () => patch({ kickerColor: undefined })}
          onChange={(v) => patch({ kickerColor: v })}
        />
        <NumberInput
          label="Label size"
          value={block.labelSize}
          {...numberField(spec("labelSize"))}
          suffix="px"
          inherited={String(base.fontSize)}
          inheritedFrom="the block font size"
          onReset={block.labelSize === undefined ? undefined : () => patch({ labelSize: undefined })}
          onChange={(v) => patch({ labelSize: clampTo(specBounds(spec("labelSize")), v) })}
        />
        <NumberInput
          label="Value size"
          value={block.valueSize}
          min={8}
          max={72}
          suffix="px"
          onReset={block.valueSize === undefined ? undefined : () => patch({ valueSize: undefined })}
          onChange={(v) => patch({ valueSize: v === undefined ? undefined : clampNum(v, 30, 8, 72) })}
          // ⚠️ L'ancien texte disait « les autres prennent la couleur du texte » : le compilateur leur
          // donne la couleur ATTÉNUÉE du thème (`scoreboardHtml`). Le repère dit ce que l'abonné voit.
          // « Row colours » est le groupe VOISIN, juste en dessous : ce renvoi doit rester vrai.
          hint="Highlighted values use the brand color, the others the brand muted color — both can be changed under Row colours."
        />
      </Group>
      <Group
        id="scoreboard.row-colours"
        title="Row colours"
        summary={overrides(block, ["labelColor", "valueColor", "highlightLabelColor", "highlightValueColor"])}
      >
        <ColorInput
          label="Label colour"
          value={block.labelColor}
          inherited={theme.mutedColor}
          inheritedFrom="the brand muted colour"
          onReset={block.labelColor === undefined ? undefined : () => patch({ labelColor: undefined })}
          onChange={(v) => patch({ labelColor: v })}
          hint={spec("labelColor").hint}
        />
        <ColorInput
          label="Value colour"
          value={block.valueColor}
          inherited={theme.mutedColor}
          inheritedFrom="the brand muted colour"
          onReset={block.valueColor === undefined ? undefined : () => patch({ valueColor: undefined })}
          onChange={(v) => patch({ valueColor: v })}
          hint={spec("valueColor").hint}
        />
        <ColorInput
          label="Highlighted label colour"
          value={block.highlightLabelColor}
          inherited={base.textColor}
          inheritedFrom="the text colour"
          onReset={block.highlightLabelColor === undefined ? undefined : () => patch({ highlightLabelColor: undefined })}
          onChange={(v) => patch({ highlightLabelColor: v })}
          hint={spec("highlightLabelColor").hint}
        />
        <ColorInput
          label="Highlighted value colour"
          value={block.highlightValueColor}
          inherited={theme.brandColor}
          inheritedFrom="the brand colour"
          onReset={block.highlightValueColor === undefined ? undefined : () => patch({ highlightValueColor: undefined })}
          onChange={(v) => patch({ highlightValueColor: v })}
          hint={spec("highlightValueColor").hint}
        />
      </Group>
      <Group
        id="scoreboard.footer"
        title="Footer"
        summary={overrides(block, ["footerColor", "footerLabelColor", "footerRuleWidth", "footerRuleColor"])}
      >
        <NumberInput
          label="Footer rule thickness"
          value={block.footerRuleWidth}
          {...numberField(spec("footerRuleWidth"))}
          suffix="px"
          inherited={literalDefault(spec("footerRuleWidth"))}
          inheritedFrom="the panel default"
          onReset={block.footerRuleWidth === undefined ? undefined : () => patch({ footerRuleWidth: undefined })}
          onChange={(v) => patch({ footerRuleWidth: clampTo(specBounds(spec("footerRuleWidth")), v) })}
        />
        <ColorInput
          label="Footer rule color"
          value={block.footerRuleColor}
          inherited={border.value}
          inheritedFrom={border.from}
          onReset={block.footerRuleColor === undefined ? undefined : () => patch({ footerRuleColor: undefined })}
          onChange={(v) => patch({ footerRuleColor: v })}
        />
        <ColorInput
          label="Footer link color"
          value={block.footerLabelColor}
          inherited={base.textColor}
          inheritedFrom="the text colour"
          onReset={block.footerLabelColor === undefined ? undefined : () => patch({ footerLabelColor: undefined })}
          onChange={(v) => patch({ footerLabelColor: v })}
          hint={spec("footerLabelColor").hint}
        />
        <ColorInput
          label="Footer note color"
          value={block.footerColor}
          inherited="Muted color"
          inheritedFrom="Email styles"
          onReset={block.footerColor === undefined ? undefined : () => patch({ footerColor: undefined })}
          onChange={(v) => patch({ footerColor: v })}
        />
      </Group>
      <Group id="scoreboard.panel" title="Panel" summary={overrides(block, ["innerPadding"])}>
        <SpacingInput
          label="Inner padding (px)"
          value={block.innerPadding}
          defaults={CARD_PADDING}
          min={specBounds(spec("innerPadding")).min}
          max={specBounds(spec("innerPadding")).max}
          inheritedFrom="the panel default"
          onChange={(next) => patch({ innerPadding: next })}
          hint={spec("innerPadding").hint}
        />
      </Group>
    </>
  );
}

export function PromoEditor({ block, patch, theme, base }: LookProps<Extract<Block, { type: "promo" }>>) {
  const spec = (path: string) => propSpec("promo", path);
  const hasCode = block.code !== undefined && block.code.trim() !== "";
  return (
    <>
      <TokenTextInput
        label="Headline"
        value={block.headline}
        maxLength={200}
        onChange={(v) => patch({ headline: v })}
      />
      <TextAreaInput
        label="Body (optional)"
        value={block.body ?? ""}
        rows={3}
        maxLength={1000}
        onChange={(v) => patch({ body: v.trim() === "" ? undefined : v })}
      />
      <TokenTextInput
        label="Promo code (optional)"
        value={block.code ?? ""}
        maxLength={60}
        onChange={(v) => patch({ code: v.trim() === "" ? undefined : v })}
        hint="Rendered in a boxed monospace line — its look is under Appearance › Promo code. Use a merge tag for per-recipient codes."
      />

      <SectionTitle>Call to action</SectionTitle>
      <TextInput
        label="Link"
        value={block.href}
        onChange={(v) => patch({ href: v })}
        placeholder="https://example.com/offer"
        warning={block.href.trim() === "" ? "A link is required to publish." : undefined}
      />
      <TextInput
        label="CTA label"
        value={block.ctaLabel}
        maxLength={MAX_BUTTON_LABEL}
        onChange={(v) => patch({ ctaLabel: v })}
        warning={block.ctaLabel.trim() === "" ? "An empty label makes the promo unpublishable." : undefined}
      />

      <SectionTitle>Terms</SectionTitle>
      <TextAreaInput
        label="Terms (optional)"
        value={block.terms ?? ""}
        rows={3}
        maxLength={1000}
        onChange={(v) => patch({ terms: v.trim() === "" ? undefined : v })}
        hint="Rendered small and muted, never hidden. Gambling offers carry legal wording per market — write it here, in the reader's language."
      />

      <SectionTitle>Appearance</SectionTitle>
      {/* Le pavé du code n'est offert qu'avec un code : sans lui, ces réglages ne toucheraient rien. */}
      {hasCode && (
        <Group
          id="promo.code"
          title="Promo code"
          summary={overrides(block, [
            "codeColor",
            "codeBorderColor",
            "codeBorderStyle",
            "codeBackground",
            "codeSize",
            "codeFont",
          ])}
        >
          <ColorInput
            label="Code colour"
            value={block.codeColor}
            inherited={base.textColor}
            inheritedFrom="the text colour"
            onReset={block.codeColor === undefined ? undefined : () => patch({ codeColor: undefined })}
            onChange={(v) => patch({ codeColor: v })}
          />
          <NumberInput
            label="Code size"
            value={block.codeSize}
            {...numberField(spec("codeSize"))}
            suffix="px"
            inherited={String(base.fontSize + 1)}
            inheritedFrom="the block font size plus 1"
            onReset={block.codeSize === undefined ? undefined : () => patch({ codeSize: undefined })}
            onChange={(v) => patch({ codeSize: clampTo(specBounds(spec("codeSize")), v) })}
          />
          <FontInput
            label="Code font"
            value={block.codeFont}
            inherited={String(spec("codeFont").default)}
            inheritedLabel="Default monospace"
            theme={theme}
            onChange={(v) => patch({ codeFont: v })}
            hint={spec("codeFont").hint}
          />
          <ColorInput
            label="Code border colour"
            value={block.codeBorderColor}
            inherited={theme.brandColor}
            inheritedFrom="the brand colour"
            onReset={block.codeBorderColor === undefined ? undefined : () => patch({ codeBorderColor: undefined })}
            onChange={(v) => patch({ codeBorderColor: v })}
          />
          <ChoiceInput<LineStyle>
            label="Code border style"
            value={block.codeBorderStyle}
            def={spec("codeBorderStyle").default as LineStyle}
            options={spec("codeBorderStyle").options as readonly LineStyle[]}
            labels={LINE_STYLE_LABELS}
            onChange={(v) => patch({ codeBorderStyle: v })}
          />
          <ColorInput
            label="Code background"
            value={block.codeBackground}
            inherited="none"
            inheritedFrom="the card default"
            onReset={block.codeBackground === undefined ? undefined : () => patch({ codeBackground: undefined })}
            onChange={(v) => patch({ codeBackground: v })}
            hint={spec("codeBackground").hint}
          />
        </Group>
      )}
      <Group id="promo.card" title="Card" summary={overrides(block, ["frameColor", "frameWidth", "innerPadding", "rowGap"])}>
        <NumberInput
          label="Frame thickness"
          value={block.frameWidth}
          {...numberField(spec("frameWidth"))}
          suffix="px"
          inherited={literalDefault(spec("frameWidth"))}
          inheritedFrom="the card default"
          onReset={block.frameWidth === undefined ? undefined : () => patch({ frameWidth: undefined })}
          onChange={(v) => patch({ frameWidth: clampTo(specBounds(spec("frameWidth")), v) })}
        />
        <ColorInput
          label="Frame colour"
          value={block.frameColor}
          inherited={theme.brandColor}
          inheritedFrom="the brand colour"
          onReset={block.frameColor === undefined ? undefined : () => patch({ frameColor: undefined })}
          onChange={(v) => patch({ frameColor: v })}
          hint="The card outline — the Style tab border does not reach it."
        />
        <SpacingInput
          label="Inner padding (px)"
          value={block.innerPadding}
          defaults={CARD_PADDING}
          min={specBounds(spec("innerPadding")).min}
          max={specBounds(spec("innerPadding")).max}
          inheritedFrom="the card default"
          onChange={(next) => patch({ innerPadding: next })}
          hint={spec("innerPadding").hint}
        />
        <NumberInput
          label="Gap between lines"
          value={block.rowGap}
          {...numberField(spec("rowGap"))}
          suffix="px"
          inherited={literalDefault(spec("rowGap"))}
          inheritedFrom="the card default"
          onReset={block.rowGap === undefined ? undefined : () => patch({ rowGap: undefined })}
          onChange={(v) => patch({ rowGap: clampTo(specBounds(spec("rowGap")), v) })}
        />
      </Group>
      <Group
        id="promo.button"
        title="Button"
        summary={overrides(block, ["ctaBackground", "ctaTextColor", "ctaSize", "ctaWeight", "ctaPadding", "ctaRadius"])}
      >
        <CardButtonFields
          target="promo"
          value={block}
          onPatch={patch}
          theme={theme}
          fontSize={base.fontSize}
          radius={blockRadius(block.style, theme)}
        />
      </Group>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Flux d'articles — on règle une REQUÊTE, on ne choisit pas des articles
 * ------------------------------------------------------------------ */

/** Ce que l'inspecteur a besoin de savoir d'une source. `kind` sert à dire ce qui sera ignoré. */
interface FeedSource {
  id: string;
  label: string;
  kind: "wp-rest" | "rss";
}

interface Term {
  id: number;
  name: string;
}

const MAX_TERMS = 10;
const FEED_MAX_COUNT = 12;
const FEED_MAX_DEDUPE_DAYS = 60;
/**
 * Les modes de sélection proposés à l'auteur.
 *
 * ⚠️ `mixed` y figure pour être AFFICHABLE, pas pour être choisi : il n'est offert qu'aux documents
 * qui le portent déjà (cf. le filtre au point d'usage). Le mélange se règle sur la campagne.
 */
const FEED_ORDER_OPTIONS = [
  { value: "date", label: "Newest first" },
  { value: "views", label: "Most viewed — from analytics" },
  { value: "mixed", label: "Half most viewed, half newest (now set on the campaign)" },
] as const;

/** Même plafond que `ArticleFeedBlock.viewsWindow` : au-delà, la fenêtre dépasse ce qu'une récolte
 * peut rapatrier chez une source qui publie 40 à 50 articles par jour, et le classement ne
 * porterait plus que sur la partie récente de la période annoncée. */
const FEED_MAX_WINDOW_DAYS = 90;
/** Ce qu'on propose en basculant sur une durée fixe — la cadence la plus courante. */
const FEED_DEFAULT_WINDOW_DAYS = 7;

/** Lecture d'erreur commune : le corps JSON `{error}` d'abord, le statut ensuite. */
async function feedErrorOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    /* corps illisible : on retombe sur le statut */
  }
  return `the request failed (${res.status})`;
}

/**
 * Sélecteur de catégories / étiquettes.
 *
 * ⚠️ MÊME ROUTE que l'assistant d'import (`/api/builder/wp/terms`) : les ids de taxonomie qu'on
 * écrit dans le bloc doivent être ceux que WordPress reconnaît, et une seconde source de vérité
 * pour la même liste finirait par proposer des termes que la requête d'envoi ne saurait pas lire.
 * Seule la présentation change — le panneau fait 300 px de large, pas 900.
 */
function FeedTermPicker({
  sourceId,
  taxonomy,
  label,
  selected,
  onToggle,
}: {
  sourceId: string;
  taxonomy: "categories" | "tags";
  label: string;
  selected: Term[];
  onToggle: (term: Term) => void;
}) {
  const inputId = useId();
  const [query, setQuery] = useState("");
  const [terms, setTerms] = useState<Term[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sourceId) return;
    let cancelled = false;
    // Anti-rebond : une frappe = une requête vers un site tiers, on attend la fin du mot.
    const timer = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const url = `/api/builder/wp/terms?sourceId=${encodeURIComponent(sourceId)}&taxonomy=${taxonomy}&q=${encodeURIComponent(query)}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(await feedErrorOf(res));
        const body = (await res.json()) as { terms?: Term[]; truncated?: boolean };
        if (cancelled) return;
        setTerms(Array.isArray(body.terms) ? body.terms : []);
        setTruncated(Boolean(body.truncated));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "could not load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sourceId, taxonomy, query]);

  const picked = (id: number) => selected.some((t) => t.id === id);

  return (
    <div className="mb-3">
      <label htmlFor={inputId} className="mb-1 block text-[11px] font-semibold text-muted-foreground">
        {label}
      </label>

      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
        <input
          id={inputId}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${label.toLowerCase()}…`}
          className="w-full rounded-lg border border-border bg-card py-1.5 pl-7 pr-7 text-[12px] text-foreground placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        />
        {loading && (
          <Loader2 className="absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-muted-foreground/60 motion-reduce:animate-none" />
        )}
      </div>

      {/* Ce qui est retenu reste visible même quand la recherche a changé de résultats : sans ça,
          on coche une étiquette, on tape autre chose, et plus rien ne dit ce qui filtre. */}
      {selected.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {selected.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => onToggle(t)}
              title="Remove from the filter"
              className="flex items-center gap-1 rounded-full border border-brand/40 bg-brand/10 px-2 py-[2px] text-[10.5px] font-medium text-brand"
            >
              {t.name}
              <span aria-hidden className="text-brand/60">
                ×
              </span>
            </button>
          ))}
        </div>
      )}

      {error && (
        <p className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-snug text-[#c0334a]">
          <AlertTriangle className="mt-[2px] h-3 w-3 shrink-0" strokeWidth={2} />
          {error}
        </p>
      )}

      <div className="mt-1.5 max-h-[118px] overflow-y-auto rounded-lg border border-border">
        {terms.length === 0 && !loading && !error ? (
          <p className="px-2.5 py-1.5 text-[11px] text-muted-foreground/80">
            {query ? "Nothing matches that search on this site." : "This site exposes none."}
          </p>
        ) : (
          <ul>
            {terms.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => onToggle(t)}
                  className={cn(
                    "flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-[11.5px] hover:bg-accent",
                    picked(t.id) && "font-semibold text-brand",
                  )}
                >
                  {picked(t.id) && <Check className="h-3 w-3 shrink-0" strokeWidth={2.5} />}
                  <span className="truncate">{t.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ⛔ Une liste coupée en silence se lit comme « cette étiquette n'existe pas sur ce site ». */}
      {truncated && (
        <p className="mt-1 text-[10.5px] leading-snug text-muted-foreground/80">
          Showing the most used ones only — type to search the whole site.
        </p>
      )}
    </div>
  );
}

/**
 * RÉGLAGES D'UN BLOC FLUX.
 *
 * ⛔ CE PANNEAU NE CHOISIT AUCUN ARTICLE. Il écrit une requête (site, filtres, combien, plancher,
 * fenêtre d'anti-répétition) ; les articles réels sont résolus 90 min avant chaque échéance par le
 * worker. « Refresh preview » ne sert qu'à VOIR ce que la règle rend aujourd'hui — c'est pour ça
 * que l'encadré le répète au-dessus du bouton plutôt qu'en pied de panneau.
 *
 * ⛔ `minCount` EST RAMENÉ À `count` DANS LES DEUX SENS. Le schéma laisse les deux champs monter à
 * 12 indépendamment ; un plancher au-dessus de la demande ne peut JAMAIS être atteint et retiendrait
 * toutes les échéances avec une phrase que personne ne peut satisfaire. Baisser « How many » doit
 * donc baisser le plancher avec lui, sinon la faute se fabrique en trois clics sans rien afficher.
 */
const CADENCE_REASONS: Record<string, string> = {
  "no-campaign":
    "This block follows the campaign cadence, and no campaign uses this template yet. The preview shows seven days; a real send will use the actual interval.",
  "not-recurring":
    "This block follows the campaign cadence, but no campaign using this template is a running series — the send would use seven days too.",
  several:
    "This template serves several campaigns whose send intervals differ, so no single period can be shown here. Each send will use its own campaign’s interval.",
  "no-next":
    "The recurrence on this template’s campaign has no upcoming send left, so there is no interval to measure. The preview shows seven days.",
  "no-previous":
    "The next send is the first one, so there is no earlier send to measure a period from. The preview shows seven days; later sends will use the real interval.",
  "not-found":
    "The campaign this period should come from could not be read. The preview shows seven days.",
};

/** Pourquoi la cadence n'a pas pu être suivie — chaque motif appelle un geste différent. */
function cadenceReason(raison: string | null | undefined): string {
  return (
    (raison ? CADENCE_REASONS[raison] : null) ??
    "This block follows the campaign cadence, which only exists once a campaign uses this template. The preview shows seven days; the real send will use the actual interval."
  );
}

/**
 * « Card style » — les trois styles prêts du flux (24/09/2026, feature 5, étape 6). Un clic = une étape
 * d'annulation (`applyFeedPreset`). Le bouton pressé est le style dont le choix ne changerait rien
 * (`styleFluxActif`) ; aucun ⇒ « Custom » : des réglages posés à la main, que rien n'efface tant qu'on ne
 * choisit pas. SANS HOOK : le banc l'appelle comme une fonction.
 */
export function FeedPresetPicker({
  block,
  dispatch,
}: {
  block: Extract<Block, { type: "article-feed" }>;
  dispatch: React.Dispatch<BuilderAction>;
}) {
  const actif = styleFluxActif(block);
  return (
    <Field
      label="Card style"
      hint={
        actif === null
          ? "Custom — set by hand below. Picking a style rewrites the arrangement and sizes, never the colours."
          : FEED_PRESET_LABELS[actif].hint
      }
    >
      <div className="inline-flex rounded-lg border border-border bg-card p-0.5">
        {FEED_PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            aria-pressed={actif === p}
            title={FEED_PRESET_LABELS[p].hint}
            onClick={() => dispatch({ type: "applyFeedPreset", blockId: block.id, preset: p })}
            className={cn(
              "rounded-[6px] px-2.5 py-1 text-[11.5px] font-medium transition-colors",
              actif === p ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {FEED_PRESET_LABELS[p].label}
          </button>
        ))}
      </div>
    </Field>
  );
}

/**
 * Les réglages des CARTES d'un flux (disposition, combien de unes, surtitre, heure, libellé de
 * lecture), sortis de `FeedEditor` le 22/09/2026 pour une seule raison : `FeedEditor` porte des hooks
 * (aperçu, sources), et ses champs ne pouvaient donc pas être déclenchés par le banc de l'inspecteur,
 * qui appelle les composants comme des fonctions. Ce composant n'en a AUCUN — garder ça ainsi.
 * « Arrangement » les a rejoints le 23/09/2026, pour la même raison (voir son commentaire).
 */
export function FeedCardFields({
  block,
  patch,
  dispatch,
  locale,
  defaultCtaLabel,
}: {
  block: Extract<Block, { type: "article-feed" }>;
  patch: Patch;
  /** Pour « Arrangement » seul : il écrit le bloc ET le look des brèves en UN pas d'historique. */
  dispatch: React.Dispatch<BuilderAction>;
  locale: string;
  /** `meta.defaultCtaLabel` : le libellé de lecture que ce modèle pose à la place de celui de la langue. */
  defaultCtaLabel?: string;
}) {
  // `leadCount` va de 0 à 3 depuis le 22/09/2026 : toute lecture « y a-t-il une une » passe par ici.
  const leads = block.leadCount ?? 0;
  const leadSpec = propSpec("article-feed", "leadCount");
  // La disposition que les brèves ont VRAIMENT : `toArticle` fait passer le look avant le flux.
  const cardLayout = block.card?.layout ?? block.layout;
  // Celle que la une garde pour elle, quand il y a une une et que son look en pose une.
  const leadLayout = leads >= 1 ? block.lead?.layout : undefined;
  const leadGroup = leads > 1 ? "Lead cards" : "Lead card";
  const feedCta = propSpec("article-feed", "ctaStyle");
  return (
    <>
      <FeedPresetPicker block={block} dispatch={dispatch} />
      {/* ⛔ LA VALEUR AFFICHÉE EST CELLE QUI PART (23/09/2026). Le sélecteur montrait `layout` du flux,
          alors que `toArticle` fait `look.layout ?? feed.layout` : sur « Boletín semanal genérico »,
          `card.layout` et `lead.layout` sont posés tous les deux, et changer « Arrangement » laissait
          l'e-mail identique à l'octet. Il gouverne désormais les brèves pour de bon : il retire le
          `layout` du look `card` (le reste du look est gardé), dans le MÊME pas d'historique — un
          seul Ctrl+Z pour un seul geste. La une garde le sien, et le repère le dit. */}
      <SelectInput
        label="Arrangement"
        value={cardLayout}
        options={
          [
            { value: "stacked", label: "Stacked — image above the text" },
            { value: "side", label: "Side by side — image left" },
          ] as const
        }
        onChange={(v) =>
          dispatch(
            block.card?.layout === undefined
              ? { type: "updateBlock", blockId: block.id, patch: { layout: v } }
              : {
                  type: "batch",
                  actions: [
                    { type: "updateBlock", blockId: block.id, patch: { layout: v } },
                    { type: "updateBlockPart", blockId: block.id, part: "card", patch: { layout: undefined } },
                  ],
                },
          )
        }
        hint={
          leadLayout === undefined
            ? "Applies to every card the feed produces — they are rendered by the same code as a manual article block."
            : `Applies to the other cards. ${leads > 1 ? "The lead cards keep their" : "The lead card keeps its"} own arrangement (${leadLayout === "side" ? "Side by side" : "Stacked"}) — change it under “${leadGroup}” below.`
        }
      />
      {/* ⛔ UN NOMBRE, PLUS UNE CASE (22/09/2026) : `leadCount` va de 0 à 3. Une case n'aurait écrit que
          0 ou 1, et une une de deux ou trois articles posée par l'import serait devenue impossible à
          relire (cochée ? décochée ?) et à changer. */}
      <SelectInput
        label="Lead cards"
        value={String(leads)}
        options={Array.from({ length: specBounds(leadSpec).max - specBounds(leadSpec).min + 1 }, (_, k) => {
          const n = specBounds(leadSpec).min + k;
          return {
            value: String(n),
            label: n === 0 ? "None (default)" : n === 1 ? "1 — the first article" : `${n} — the first ${n} articles`,
          };
        })}
        onChange={(v) => {
          const n = clampTo(specBounds(leadSpec), Number(v)) ?? 0;
          patch({ leadCount: n === 0 ? undefined : n });
        }}
        /* ⛔ LE REPÈRE NOMME LES TEXTES QUE CE RÉGLAGE FAIT PARAÎTRE. Le look de la une et le titre
           de section viennent de la marque, pas d'un champ visible : le 22/09/2026 un propriétaire
           a signalé comme « inventés » un « Destacada » et un « Más noticias » qui sont bel et bien
           dans son modèle. Le canvas les montre désormais ; ce repère dit d'où ils sortent.
           ⛔ Il ne promet plus « the lead styling of this brand » : un flux ajouté depuis la palette
           n'a AUCUN `lead`, et la une y ressemblait trait pour trait aux autres cartes. Le repère
           dit maintenant si un look de une existe, et où le régler. */
        hint={
          leads === 0
            ? "The first articles can be drawn bigger, as leads, with a heading after them."
            : block.lead === undefined
              ? // Sans look de une, la phrase principale est dans l'avertissement ci-dessous.
                block.midSection === undefined
                ? undefined
                : `It also inserts the “${block.midSection.label}” heading after the ${leads > 1 ? "lead cards" : "lead card"}.`
              : [
                  `${leads > 1 ? `The first ${leads} cards take` : "The first card takes"} the look set under “${leadGroup}” below.`,
                  block.lead.kickerMode === "text" && (block.lead.kickerText ?? "").trim() !== ""
                    ? `It also puts “${block.lead.kickerText as string}” above ${leads > 1 ? "each lead title" : "that first title"}.`
                    : "",
                  block.midSection === undefined ? "" : `And it inserts the “${block.midSection.label}” heading before the rest.`,
                ]
                  .filter((s) => s !== "")
                  .join(" ")
        }
      />
      {/* ⛔ UNE UNE SANS LOOK NE SE VOIT PAS (23/09/2026). Le compilateur rend la une avec `lead ?? {}` :
          sans look, elle ressemble trait pour trait aux autres cartes — c'est voulu (106 modèles réels
          sur 108 sortent identiques à l'octet, on n'y touche pas). Mais écrit en petit gris sous le
          sélecteur, ce repère n'a pas été lu : sur le second flux de « Boletín semanal … », « Lead
          cards » semblait cassé. Il passe en avertissement, et dit où créer le look. */}
      {leads >= 1 && block.lead === undefined && (
        <Note tone="warn">
          No lead look is set yet, so {leads > 1 ? `the first ${leads} cards look` : "the first card looks"} exactly
          like the others. Style {leads > 1 ? "them" : "it"} under “Card looks → {leadGroup}” below.
        </Note>
      )}
      {/* ⛔ CE QUI SE CHOISIT D'ABORD RESTE À PLAT (23/09/2026, lot L4) : « Arrangement », « Lead cards » et
          l'avertissement de une ci-dessus. Le reste — surtitre, heure, libellé de lecture — se règle une
          fois et pesait 650 px dépliés : deux sous-sections fermées, dans l'ordre de lecture d'une carte
          (le surtitre en haut, le lien de lecture en bas). Chaque résumé liste EXACTEMENT les clés que
          ses champs écrivent. Les `id` suivent `<type>.<partie>` et évitent `article-feed.lead.*` /
          `article-feed.card.*`, réservés aux sous-sections des looks. */}
      <Group
        id="article-feed.kicker-time"
        title="Kicker & time"
        summary={overrides(block, ["showKicker", "timeZone", "timeFormat", "timeColor", "kickerSeparator"])}
      >
        <CheckboxInput
          label="Kicker"
          text="Show category and time above each title"
          checked={block.showKicker === true}
          onChange={(v) => patch({ showKicker: v ? true : undefined })}
          /* Cette case COUPE VRAIMENT les surtitres depuis le 22/09/2026 : un `kickerMode` de marque,
             invisible ici, les laissait passer décochée. Le libellé fixe de la une, lui, suit « Lead
             card » — c'est une place dans l'édition, pas une catégorie. */
          hint="Uses what WordPress actually gives: no category on an article means no category shown — nothing is made up. Unticking it removes these kickers everywhere, including on brands that set their own."
        />
        {/* ⛔ LE FUSEAU ET LA COULEUR DE L'HEURE SUIVENT L'USAGE, PAS LA SEULE CASE « Kicker ». Un
            look en `metaMode: "time"` imprime l'heure sous la carte même case décochée : cacher ces
            deux champs laissait partir une heure en UTC et dans la couleur de marque sans qu'aucun
            réglage visible ne l'explique. */}
        {(block.showKicker === true ||
          (leads >= 1 && block.lead?.metaMode === "time") ||
          block.card?.metaMode === "time") && (
          <>
            <TextInput
              label="Time zone"
              value={block.timeZone ?? ""}
              maxLength={64}
              onChange={(v) => patch({ timeZone: v.trim() === "" ? undefined : v })}
              onReset={block.timeZone === undefined ? undefined : () => patch({ timeZone: undefined })}
              placeholder="America/Santiago"
              hint="IANA name. Empty = UTC — never the server's own clock, which would be right only by accident."
            />
            <ChoiceInput<"24h" | "12h">
              label="Time format"
              value={block.timeFormat}
              def={propSpec("article-feed", "timeFormat").default as "24h" | "12h"}
              options={propSpec("article-feed", "timeFormat").options as readonly ("24h" | "12h")[]}
              labels={{ "24h": "24-hour (18:30)", "12h": "12-hour (6:30 PM)" }}
              onChange={(v) => patch({ timeFormat: v })}
              hint={propSpec("article-feed", "timeFormat").hint}
            />
            <ColorInput
              label="Time color"
              value={block.timeColor}
              inherited="Brand color"
              inheritedFrom="Email styles"
              onReset={block.timeColor === undefined ? undefined : () => patch({ timeColor: undefined })}
              onChange={(v) => patch({ timeColor: v })}
            />
          </>
        )}
        {/* Le séparateur entre catégorie et heure : ses espaces COMPTENT (« · » collé ou aéré), donc la
            saisie est gardée telle quelle — seul le champ vidé revient au défaut. */}
        {block.showKicker === true && (
          <TextInput
            label="Kicker separator"
            value={block.kickerSeparator ?? ""}
            maxLength={propSpec("article-feed", "kickerSeparator").max}
            onChange={(v) => patch({ kickerSeparator: v === "" ? undefined : v })}
            /* Le défaut du manifeste est une DESCRIPTION (« · (non-breaking spaces) ») : la valeur montrée
               est celle que `feed.ts` pose vraiment, point médian entre deux espaces insécables. */
            inherited={" · "}
            inheritedFrom="the default"
            onReset={block.kickerSeparator === undefined ? undefined : () => patch({ kickerSeparator: undefined })}
            hint={`${propSpec("article-feed", "kickerSeparator").hint} Spaces are kept as typed.`}
          />
        )}
      </Group>
      <Group id="article-feed.read-link" title="Read link" summary={overrides(block, ["ctaStyle", "ctaLabel"])}>
        {/* La forme du lien de lecture de TOUTES les cartes, sans avoir à créer un look pour ça : un
            `ctaStyle` posé sur la une ou les brèves l'emporte pour leurs cartes (`toArticle`). Rangée
            ICI depuis le 23/09/2026 (audit §3.3), en tête du groupe comme au bloc article : elle
            décide si le libellé ci-dessous sert encore. Elle était seule, à plat, dans « Card looks ». */}
        <SelectInput<CtaStyle>
          label="Read link style — every card"
          value={block.ctaStyle ?? (feedCta.default as CtaStyle)}
          options={CTA_STYLE_OPTIONS}
          onChange={(v) => patch({ ctaStyle: v === feedCta.default ? undefined : v })}
          hint={feedCta.hint}
        />
        {/* Même faute qu'au bloc article, même correctif : le repli posé dans le `onChange` d'un champ
            contrôlé écrasait tout état vide INTERMÉDIAIRE de la frappe et se concaténait à la suite.
            Le vide se stocke absent et le défaut s'affiche en héritage — le dépliage le posera sur
            chaque carte, donc le champ vide n'est pas un flux sans bouton.
            ⚠️ L'héritage reste affiché ICI sans condition, contrairement au bloc article : le flux ne
            porte AUCUN href, chaque carte apporte le sien (`item.href`) et la source WordPress les
            fournit réels. Il n'y a donc rien à juger à cet étage — le `hint` dit la réserve, et le
            canvas la MONTRE carte par carte.
            ⛔ CE LIBELLÉ N'EST MONTRÉ QUE S'IL SERT À UNE CARTE. Un look qui porte son propre libellé,
            ou qui retire le lien de lecture (`ctaStyle: "none"`), ne lit jamais celui-ci : un champ
            modifiable sans effet sur l'envoi est le premier qu'on soupçonne quand le résultat
            surprend. Le repère dit QUELLES cartes le lisent. */}
        {(() => {
          const leadOn = leads >= 1;
          // ⛔ LE STYLE D'UN LOOK HÉRITE DU BLOC (`look.ctaStyle ?? feed.ctaStyle`) : un flux réglé en
          // « none » pour toutes les cartes ne lit plus ce libellé, même sur un look muet.
          const reads = (look: typeof block.lead) =>
            (look?.ctaStyle ?? block.ctaStyle) !== "none" && look?.ctaLabel === undefined;
          const users = [
            ...(leadOn && reads(block.lead) ? [leads > 1 ? "the lead cards" : "the lead card"] : []),
            ...(reads(block.card) ? [leadOn ? "the other cards" : "every card"] : []),
          ];
          if (users.length === 0) {
            // Le sélecteur juste au-dessus a retiré le lien de TOUTES les cartes (aucun look ne pose
            // sa propre forme) : c'est lui qu'il faut changer, pas un look.
            const noneHere =
              block.ctaStyle === "none" &&
              (leadOn ? [block.lead, block.card] : [block.card]).every((look) => look?.ctaStyle === undefined);
            return noneHere ? (
              <Note>No read link is sent on any card, so there is no label to set. Pick Button or Link above to bring it back.</Note>
            ) : (
              <Note>
                No card reads a block-wide read-link label: each look below sets its own label or removes the read link.
                Change it there.
              </Note>
            );
          }
          return (
            <TextInput
              label="CTA label"
              value={block.ctaLabel ?? ""}
              maxLength={MAX_BUTTON_LABEL}
              onChange={(v) => patch({ ctaLabel: v.trim() === "" ? undefined : v })}
              inherited={defaultArticleCta(locale, defaultCtaLabel)}
              inheritedFrom={
                defaultCtaLabel !== undefined && defaultCtaLabel.trim() !== ""
                  ? "the document's default read-link label"
                  : "this document's language"
              }
              onReset={block.ctaLabel === undefined ? undefined : () => patch({ ctaLabel: undefined })}
              hint={`The read link under ${users.join(" and ")} — ${block.ctaStyle === "link" ? "an underlined link" : "a button"} unless a card look says otherwise. Left empty, the default label for this document's language is used; a card whose link goes nowhere gets no read link at all.`}
            />
          );
        })()}
      </Group>
    </>
  );
}

function FeedEditor({
  block,
  patch,
  dispatch,
  locale,
  theme,
  layers,
  patchPart,
  renderStyle,
  defaultCtaLabel,
}: {
  block: Extract<Block, { type: "article-feed" }>;
  patch: Patch;
  /** Transmis à `FeedCardFields` pour « Arrangement », qui écrit deux choses en un seul pas. */
  dispatch: React.Dispatch<BuilderAction>;
  locale: string;
  theme: Theme;
  /** Styles de la row et de la colonne du flux : la typographie par défaut des cartes en descend. */
  layers: (BoxStyle | undefined)[];
  /** Écrit `lead` / `card` / `midSection` / `cardRule` ENTIERS — cf. `updateBlockPart`. */
  patchPart: (part: FeedPart, patch: Record<string, unknown> | null) => void;
  /**
   * `opts.typography: false` retire les réglages de texte (voir `StylePanel`). Le filet entre les cartes
   * doit le passer : c'est `CardRuleFields` qui l'appelle, dans `article-look-fields.tsx` (lot L2).
   */
  renderStyle: (
    style: BoxStyle | undefined,
    onChange: (next: BoxStyle | undefined) => void,
    opts?: { typography?: boolean; titre?: boolean },
  ) => React.ReactNode;
  /** `meta.defaultCtaLabel` : le libellé de lecture que ce modèle pose à la place de celui de la langue. */
  defaultCtaLabel?: string;
}) {
  /**
   * Le modèle en cours d'édition, lu sur la route `/builder/[id]`. Il sert à retrouver les
   * campagnes qui l'emploient, donc la période que « suivre la cadence » désigne.
   *
   * ⚠️ Absent sur `/builder/new` — un modèle pas encore enregistré n'est utilisé par aucune
   * campagne, donc il n'y a rien à résoudre et l'aperçu le dit au lieu de deviner.
   */
  const routeParams = useParams<{ id?: string }>();
  const templateId = typeof routeParams?.id === "string" ? routeParams.id : null;
  const [sources, setSources] = useState<FeedSource[] | null>(null);
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [shortfall, setShortfall] = useState<string | null>(null);
  const [notices, setNotices] = useState<string[]>([]);
  /**
   * La période que l'aperçu a RÉELLEMENT classée, et d'où elle vient.
   *
   * ⛔ Sans cet affichage, un bloc réglé sur « suivre la cadence » montrerait un classement sur
   * sept jours ici et en produirait un sur quatre à l'envoi, sans que rien ne signale l'écart :
   * l'aperçu ne connaît aucune campagne, donc il ne PEUT pas appliquer la vraie période.
   */
  const [windowInfo, setWindowInfo] = useState<{
    days: number;
    origin: string;
    from: string;
    to: string;
    pooled: number;
    cadence?: string | null;
    campaign?: string | null;
  } | null>(null);
  /**
   * D'où viennent les cartes, quand le bloc en compose deux moitiés.
   *
   * ⛔ SANS CE CHIFFRE, « 3 + 2 comme prévu » et « 5 + 0 parce que le site n'a rien publié depuis
   * deux jours » donnent le MÊME aperçu à l'écran. L'auteur croirait avoir armé un mélange qui ne
   * se produit pas, et il n'aurait aucun moyen de s'en apercevoir avant l'envoi.
   */
  const [composition, setComposition] = useState<{
    mostViewed: number;
    latest: number;
    wantedMostViewed: number;
    wantedLatest: number;
  } | null>(null);
  /**
   * L'interrupteur de mélange, tel que les CAMPAGNES de ce modèle le portent.
   *
   * ⛔ Le builder n'a aucune campagne sous la main : il s'ouvre depuis la liste des modèles. Sans
   * cette remontée, un auteur réglant un bloc sur « les plus vus » n'aurait aucun moyen de savoir
   * si la lettre partira mélangée ou non — l'aperçu et l'envoi diffèreraient en silence.
   */
  const [mix, setMix] = useState<{ active: boolean; reason: string; campaign: string | null } | null>(null);
  /**
   * L'article le plus récent d'un bloc « les derniers » a plus de 24 h (`stale` de la route d'aperçu).
   *
   * ⛔ Le 25/09/2026, un bloc Northwind Sports filtré sur des catégories que le site n'emploie plus a servi toute la
   * journée les mêmes articles, et cet écran montrait « 7 articles in the preview » sans un mot. Un
   * avertissement, pas un blocage : l'envoi n'est pas retenu pour ça.
   */
  const [stale, setStale] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/builder/wp/sources");
        if (!res.ok) throw new Error(await feedErrorOf(res));
        const body = (await res.json()) as { sources?: unknown; error?: unknown };
        if (cancelled) return;
        const list = Array.isArray(body.sources) ? body.sources : [];
        setSources(
          list.map((raw) => {
            const r = raw as Record<string, unknown>;
            return {
              id: String(r.id ?? ""),
              label: String(r.label ?? ""),
              kind: r.kind === "rss" ? ("rss" as const) : ("wp-rest" as const),
            };
          }),
        );
        // ⚠️ La base a refusé la lecture : ce n'est PAS « aucune source configurée ».
        if (typeof body.error === "string" && body.error) setSourcesError(body.error);
      } catch (e) {
        if (!cancelled) setSourcesError(e instanceof Error ? e.message : "could not load sources");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const current = sources?.find((s) => s.id === block.sourceId) ?? null;
  /**
   * ⛔ La source du bloc reste dans la liste même quand la marque ne la déclare plus. Sans cette
   * entrée, le `<select>` afficherait la PREMIÈRE source de la marque comme si c'était celle du
   * bloc : l'auteur lirait un site, l'envoi en interrogerait un autre. On la garde, marquée.
   */
  const options: { value: string; label: string }[] = [
    ...(sources ?? []).map((s) => ({ value: s.id, label: s.kind === "rss" ? `${s.label} (RSS)` : s.label })),
    ...(sources !== null && current === null && block.sourceId !== ""
      ? [{ value: block.sourceId, label: `${block.sourceLabel || block.sourceId} — no longer on this brand` }]
      : []),
  ];

  const categories: Term[] = block.categories.map((id, i) => ({ id, name: block.categoryNames[i] ?? `#${id}` }));
  const tags: Term[] = block.tags.map((id, i) => ({ id, name: block.tagNames[i] ?? `#${id}` }));

  /**
   * ⛔ IDS ET NOMS SE DÉPLACENT ENSEMBLE, PAR INDEX. `categoryNames` n'est pas décoratif : c'est ce
   * que `describeFeed` lit pour écrire la règle à l'écran et dans le journal du planificateur, sans
   * requêter WordPress. Un retrait qui n'enlèverait que l'id ferait dire au canvas « 5 latest from
   * Football » sur un flux qui ne filtre plus rien.
   */
  function toggleTerm(taxonomy: "categories" | "tags", term: Term) {
    const ids = taxonomy === "categories" ? block.categories : block.tags;
    const names = taxonomy === "categories" ? block.categoryNames : block.tagNames;
    const at = ids.indexOf(term.id);
    const nextIds = at >= 0 ? ids.filter((_, i) => i !== at) : [...ids, term.id].slice(0, MAX_TERMS);
    const nextNames = at >= 0 ? names.filter((_, i) => i !== at) : [...names, term.name].slice(0, MAX_TERMS);
    patch(
      taxonomy === "categories"
        ? { categories: nextIds, categoryNames: nextNames }
        : { tags: nextIds, tagNames: nextNames },
    );
  }

  /**
   * ⛔ CHANGER DE SITE VIDE LES FILTRES ET L'APERÇU. Les ids de catégories d'un site ne veulent rien
   * dire sur un autre : les garder filtrerait sur des identifiants au hasard. Et un aperçu qui vient
   * du site précédent montrerait des articles que cette règle ne peut plus rendre.
   */
  function pickSource(id: string) {
    const found = sources?.find((s) => s.id === id) ?? null;
    patch({
      sourceId: id,
      sourceLabel: found?.label ?? "",
      categories: [],
      categoryNames: [],
      tags: [],
      tagNames: [],
      previewItems: [],
      previewAt: undefined,
    });
    setShortfall(null);
    setNotices([]);
    setWindowInfo(null);
    setPreviewError(null);
    setStale(null);
  }

  async function refresh() {
    if (busy || block.sourceId === "") return;
    setBusy(true);
    setPreviewError(null);
    setShortfall(null);
    setNotices([]);
    setWindowInfo(null);
    setStale(null);
    try {
      const res = await fetch("/api/builder/wp/feed-preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceId: block.sourceId,
          categories: block.categories,
          tags: block.tags,
          count: block.count,
          minCount: block.minCount,
          dedupeDays: block.dedupeDays,
          // Envoyé à l'aperçu pour qu'il classe COMME le gel le fera : un aperçu qui ignorerait le
          // tri montrerait les plus récents et enverrait les plus vus.
          orderby: block.orderby,
          // ⚠️ `"cadence"` n'est pas résoluble ici — l'aperçu ne connaît aucune campagne. On
          // l'envoie quand même : c'est la route qui doit retomber sur sept jours et DIRE d'où
          // vient sa période, plutôt que l'écran qui déciderait dans son coin.
          viewsWindow: block.viewsWindow,
          // Sans lui, « suivre la cadence » resterait indécidable ici et l'aperçu afficherait
          // sept jours alors que l'envoi en produirait quatre.
          templateId,
        }),
      });
      if (!res.ok) throw new Error(await feedErrorOf(res));
      const body = (await res.json()) as {
        items?: FeedItem[];
        previewAt?: string;
        shortfall?: string | null;
        notices?: string[];
        window?: {
          days: number;
          origin: string;
          from: string;
          to: string;
          pooled: number;
          cadence?: string | null;
          campaign?: string | null;
        } | null;
        composition?: {
          mostViewed: number;
          latest: number;
          wantedMostViewed: number;
          wantedLatest: number;
        } | null;
        mix?: { active: boolean; reason: string; campaign: string | null } | null;
        stale?: { message: string; ageHours: number; newestPublishedAt: string } | null;
      };
      setWindowInfo(body.window ?? null);
      setComposition(body.composition ?? null);
      setMix(body.mix ?? null);
      setStale(typeof body.stale?.message === "string" ? body.stale.message : null);
      const items = Array.isArray(body.items) ? body.items : [];
      // ⛔ On écrit MÊME quand la liste est vide. Garder l'aperçu précédent à côté d'un refus
      // afficherait la règle d'hier comme si elle tenait encore aujourd'hui.
      patch({ previewItems: items, previewAt: body.previewAt ?? new Date().toISOString() });
      setShortfall(typeof body.shortfall === "string" ? body.shortfall : null);
      setNotices(Array.isArray(body.notices) ? body.notices : []);
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : "the preview failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Note>
        This block stores a <span className="font-semibold">rule</span>, not articles. Every send resolves it again, 90
        minutes before it goes out — which is what keeps a recurring newsletter from shipping last week&rsquo;s news.
      </Note>

      <SectionTitle>Source</SectionTitle>
      {sources === null ? (
        <Note>Loading this brand&rsquo;s WordPress sources…</Note>
      ) : options.length === 0 ? (
        <Note tone="warn">
          No WordPress source on this brand. Declare one in Settings — until then this block cannot resolve and every
          occurrence using it will be held.
        </Note>
      ) : (
        <SelectInput
          label="WordPress site"
          value={block.sourceId}
          options={options}
          onChange={pickSource}
          hint={
            current?.kind === "rss"
              ? "This site has no REST API — it is read as an RSS feed. Category and tag filters do not apply to it, here or at send time."
              : "Changing the site clears the filters and the preview: category ids mean nothing on another site."
          }
        />
      )}
      {sourcesError && <Note tone="warn">{sourcesError}</Note>}

      <SectionTitle>Filters</SectionTitle>
      {block.sourceId === "" ? (
        <Note tone="warn">Pick a source first — categories and tags are read from the site itself.</Note>
      ) : (
        <>
          <FeedTermPicker
            sourceId={block.sourceId}
            taxonomy="categories"
            label="Categories"
            selected={categories}
            onToggle={(t) => toggleTerm("categories", t)}
          />
          <FeedTermPicker
            sourceId={block.sourceId}
            taxonomy="tags"
            label="Tags"
            selected={tags}
            onToggle={(t) => toggleTerm("tags", t)}
          />
          {/* Cette sémantique est celle de `wp/v2/posts` et elle est INVISIBLE dans la requête :
              non écrite, elle se découvre en constatant qu'un article manque. */}
          <Note>
            Any of the categories <span className="font-semibold">or</span> any of the tags —{" "}
            <span className="font-semibold">and</span> between the two groups. No filter at all means the whole site.
          </Note>
        </>
      )}

      <SectionTitle>Selection</SectionTitle>
      <NumberInput
        label="How many"
        value={block.count}
        min={1}
        max={FEED_MAX_COUNT}
        suffix="articles"
        onChange={(v) => {
          const count = clampNum(v, block.count, 1, FEED_MAX_COUNT);
          // Le plancher suit la demande à la baisse — cf. l'en-tête du composant.
          patch({ count, minCount: Math.min(block.minCount, count) });
        }}
        hint="Above a dozen cards the email crosses the 102 KB where Gmail clips it."
      />
      <NumberInput
        label="Minimum to send"
        value={block.minCount}
        min={1}
        max={block.count}
        suffix={block.minCount > 1 ? "articles" : "article"}
        onChange={(v) => patch({ minCount: clampNum(v, block.minCount, 1, block.count) })}
        hint="Below this the occurrence is held with its reason, never sent thin and never cancelled in silence. Capped at How many — a floor above the ask could never be met."
      />
      <NumberInput
        label="Don't repeat for"
        value={block.dedupeDays}
        min={0}
        max={FEED_MAX_DEDUPE_DAYS}
        suffix="days"
        onChange={(v) => patch({ dedupeDays: clampNum(v, block.dedupeDays, 0, FEED_MAX_DEDUPE_DAYS) })}
        hint="Articles already sent by this campaign inside the window are excluded, which makes the floor bite for real. 0 assumes the repeat."
      />
      {/*
        ⛔ « Half most viewed, half newest » A QUITTÉ CE SÉLECTEUR le 04/09/2026 : le mélange est
        désormais un interrupteur de CAMPAGNE (`campaign.mix_latest`), parce qu'un modèle sert
        plusieurs campagnes et qu'Alix veut le mélange sur l'une sans l'autre.

        L'option reste OFFERTE aux seuls documents qui la portent déjà — le schéma continue de
        l'accepter, et un bloc réglé ainsi doit pouvoir se relire, s'afficher et se corriger. La
        retirer sèchement afficherait une valeur absente de la liste, donc un sélecteur vide sur un
        bloc qui, lui, fonctionne. (Mesuré le 04/09 : 0 document concerné en base.)
      */}
      <SelectInput
        label="Pick the articles"
        value={block.orderby}
        options={FEED_ORDER_OPTIONS.filter((o) => o.value !== "mixed" || block.orderby === "mixed")}
        onChange={(v) => patch({ orderby: v })}
        hint="Most viewed ranks the articles this rule already selects, never the whole site. Analytics lags two days, so articles published in the last 48 hours have no view counts yet. To put those back in the letter, turn on “Mix in the latest articles” on the campaign — the setting lives there because one template can serve several campaigns."
      />
      {/*
        ⛔ CE RÉGLAGE N'APPARAÎT QU'EN MODE « MOST VIEWED ». Montré en permanence, il annoncerait
        une période à un bloc qui n'en a pas — un champ sans effet est un réglage de plus à
        comprendre, et le premier qu'on soupçonnera quand le résultat surprendra.
      */}
      {block.orderby !== "date" && (
        <>
          <SelectInput
            label="Ranking period"
            value={block.viewsWindow === "cadence" ? "cadence" : "fixed"}
            options={
              [
                { value: "cadence", label: "Follow the campaign cadence" },
                { value: "fixed", label: "Fixed number of days" },
              ] as const
            }
            onChange={(v) =>
              patch({ viewsWindow: v === "cadence" ? "cadence" : FEED_DEFAULT_WINDOW_DAYS })
            }
            hint="A weekly campaign ranks seven days, a Monday-and-Friday one ranks four then three — so the same articles are never counted twice across two sends. The period is resolved when the edition is built, because one template can serve several campaigns."
          />
          {block.viewsWindow !== "cadence" && (
            <NumberInput
              label="Over the last"
              value={block.viewsWindow}
              min={1}
              max={FEED_MAX_WINDOW_DAYS}
              suffix="days"
              onChange={(v) =>
                patch({
                  viewsWindow: clampNum(
                    v,
                    typeof block.viewsWindow === "number" ? block.viewsWindow : FEED_DEFAULT_WINDOW_DAYS,
                    1,
                    FEED_MAX_WINDOW_DAYS,
                  ),
                })
              }
              hint="The window ends two days ago, where analytics stops — seven days means the seven days up to then, not up to today. Half-and-half blocks add the articles published since, which have no view counts yet."
            />
          )}
        </>
      )}

      {/* ⛔ L'APERÇU SUIT LA REQUÊTE, PAS LES LOOKS (23/09/2026, lot L4). C'est le retour de Source /
          Filters / Selection : il arrivait en dernier, à 2 400 px, sous quatre looks — on réglait la
          requête sans voir ce qu'elle rendait. `inspector-groups-feed.test.ts` garde cet ordre. */}
      <SectionTitle>Preview</SectionTitle>
      <Note tone="warn">
        Preview only — the real articles are picked 90 minutes before each send. It is what the canvas draws and what a
        test send uses as a stand-in, and it is never what ships.
      </Note>
      <MiniBtn label="Refresh preview" disabled={busy || block.sourceId === ""} onClick={() => void refresh()}>
        {busy ? (
          <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" strokeWidth={2.2} />
        ) : (
          <RefreshCw className="h-3 w-3" strokeWidth={2.2} />
        )}
        Refresh preview
      </MiniBtn>

      <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-snug text-muted-foreground">
        <Rss className="mt-[2px] h-3 w-3 shrink-0" strokeWidth={2} />
        <span>
          {/* UNE phrase, TOUJOURS terminée par son point : sans `previewAt` (aperçu d'un modèle importé),
              le point n'était posé qu'avec la date, et la ligne lisait « 3 articles in the preview The
              no-repeat… » (relevé par L4, 23/09/2026).
              ISO tranché plutôt que `toLocaleString` : un format dépendant de la locale diffère
              entre le rendu serveur et le client et casse l'hydratation. */}
          {block.previewItems.length === 0
            ? "Nothing previewed yet."
            : `${block.previewItems.length} article${block.previewItems.length > 1 ? "s" : ""} in the preview${
                block.previewAt === undefined ? "" : `, taken ${block.previewAt.slice(0, 16).replace("T", " ")} UTC`
              }.`}{" "}
          The no-repeat window is not applied here — a template being written has no send history yet.
        </span>
      </p>

      {/* Collé à la ligne « N articles in the preview, taken … UTC » : c'est de CET aperçu que l'âge est mesuré. */}
      {stale && <Note tone="warn">{stale}</Note>}

      {windowInfo && (
        <Note tone={windowInfo.origin === "fixed" || windowInfo.origin === "cadence" ? "info" : "warn"}>
          Ranked the <span className="font-semibold">{windowInfo.pooled}</span> article
          {windowInfo.pooled > 1 ? "s" : ""} published over {windowInfo.days} day
          {windowInfo.days > 1 ? "s" : ""} — {windowInfo.from} to {windowInfo.to}.{" "}
          {windowInfo.origin === "fixed"
            ? "That period is fixed in this template."
            : windowInfo.origin === "cadence"
              ? windowInfo.campaign
                ? `That period is the send interval of “${windowInfo.campaign}”.`
                : "That period is the send interval of every campaign using this template."
              : cadenceReason(windowInfo.cadence)}
        </Note>
      )}

      {/*
        ⛔ TROIS SITUATIONS, TROIS PHRASES. « le mélange est armé », « il ne l'est pas » et « aucune
        campagne n'utilise ce modèle » appellent trois gestes différents ; une phrase unique les
        confondrait, et l'auteur ne saurait pas s'il doit ouvrir une campagne ou en créer une. Le
        désaccord entre campagnes, lui, remonte par `notices` — c'est un avertissement, pas un état.
      */}
      {mix && mix.reason !== "several" && (
        <Note tone={mix.reason === "no-campaign" ? "warn" : "info"}>
          {mix.reason === "no-campaign"
            ? "No campaign uses this template yet, so the article mix cannot be applied here. The preview above ranks by views only."
            : mix.active
              ? `The mix is on${mix.campaign ? ` for “${mix.campaign}”` : ""} — this preview is half most viewed, half published in the last two days, exactly like the send.`
              : `The mix is off${mix.campaign ? ` for “${mix.campaign}”` : ""} — this preview ranks by views only. Turn on “Mix in the latest articles” on the campaign to cover the two-day analytics gap.`}
        </Note>
      )}

      {composition && (
        <Note tone={composition.mostViewed === composition.wantedMostViewed ? "info" : "warn"}>
          This preview is <span className="font-semibold">{composition.mostViewed}</span> most viewed +{" "}
          <span className="font-semibold">{composition.latest}</span> latest.{" "}
          {composition.mostViewed === composition.wantedMostViewed
            ? "That is the split this block asks for."
            : composition.latest > composition.wantedLatest
              ? "One half could not be filled from the measured period, so the latest articles made up the difference — check that analytics is matching this source."
              : "One half could not be filled from the last two days, so the most viewed made up the difference — this source has published nothing recently."}
        </Note>
      )}

      {shortfall && (
        <Note tone="warn">
          Today this rule would hold the send: {shortfall} The preview was emptied rather than left showing an older run.
        </Note>
      )}

      {notices.map((n) => (
        <Note key={n} tone="warn">
          {n}
        </Note>
      ))}

      {previewError && <Note tone="warn">{previewError}</Note>}

      {/* « Cards » et plus « Layout » (lot L4) : la section tient la disposition et le nombre de unes,
          puis le surtitre et le lien de lecture repliés — plus seulement de la mise en page.
          « Arrangement » vit dans `FeedCardFields` depuis le 23/09/2026 : il y reste le premier champ. */}
      <SectionTitle>Cards</SectionTitle>
      <FeedCardFields
        block={block}
        patch={patch}
        dispatch={dispatch}
        locale={locale}
        defaultCtaLabel={defaultCtaLabel}
      />

      <FeedLookSections
        block={block}
        locale={locale}
        theme={theme}
        layers={layers}
        patchPart={patchPart}
        renderStyle={renderStyle}
        defaultCtaLabel={defaultCtaLabel}
        onUseForAllTitles={(color) => dispatch({ type: "useForAllTitles", color })}
      />
    </>
  );
}

/**
 * Les liens d'un menu : une carte REPLIABLE par lien (`ListCard`, comme les lignes de cotes, de
 * classement et de bandeau), dont l'en-tête dit ce qu'elle porte (« Item 2 · Sport · https://… »).
 * Déroulés, quatre liens pesaient 1 002 px (audit du 23/09/2026).
 *
 * Sorti du `case "menu"` pour la même raison que `SocialItemsEditor` : SANS HOOK, le banc l'appelle
 * comme une fonction et atteint le `onClick` réel de « Add item » — qui ouvre la carte qu'il crée.
 * ⚠️ La liste est réécrite EN ENTIER : `updateBlock` fusionne au premier niveau seulement.
 */
export function MenuItemsEditor({ items, onChange }: { items: MenuItem[]; onChange: (items: MenuItem[]) => void }) {
  const setItem = (i: number, next: Partial<MenuItem>) =>
    onChange(items.map((it, j) => (j === i ? { ...it, ...next } : it)));
  return (
    <>
      <SectionTitle>Items</SectionTitle>
      {items.map((item, i) => (
        <ListCard
          key={i}
          group="menu.row"
          title={`Item ${i + 1}`}
          // L'en-tête montre l'adresse SANS son protocole : « https:// » mangeait la place de ce qui
          // distingue deux liens. Le champ, lui, garde l'adresse entière.
          preview={rowPreview([item.label, item.href.replace(/^https?:\/\//i, "")])}
          index={i}
          total={items.length}
          min={1}
          onMove={(dir) => onChange(moved(items, i, dir))}
          onRemove={() => onChange(items.filter((_, j) => j !== i))}
        >
          <TextInput label="Label" value={item.label} maxLength={40} onChange={(v) => setItem(i, { label: v })} />
          <TextInput label="URL" value={item.href} onChange={(v) => setItem(i, { href: v })} />
        </ListCard>
      ))}
      <MiniBtn
        label="Add menu item"
        disabled={items.length >= 8}
        onClick={() => {
          openGroup(listCardId("menu.row", items.length));
          onChange([...items, { label: "New link", href: "https://example.com" }]);
        }}
      >
        <Plus className="h-3 w-3" strokeWidth={2.2} /> Add item
      </MiniBtn>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Contenu par type de bloc
 * ------------------------------------------------------------------ */

function BlockContent({
  block,
  locale,
  theme,
  parents,
  dispatch,
  defaultCtaLabel,
}: {
  block: Block;
  // Langue du DOCUMENT (`meta.locale`), pas celle du navigateur : c'est elle qui décide du libellé
  // par défaut d'un CTA d'article, exactement comme au dépliage du flux côté rendu.
  locale: string;
  theme: Theme;
  /** Row et colonne du bloc : les valeurs grisées des cartes en héritent, comme au rendu. */
  parents: Layer[];
  dispatch: React.Dispatch<BuilderAction>;
  /** `meta.defaultCtaLabel` : il passe devant le libellé de la langue, au bloc article comme au flux. */
  defaultCtaLabel?: string;
}) {
  // `patch` est typé par variante côté reducer : impossible d'écrire `src` sur un bloc texte.
  const patch = useCallback<Patch>(
    (p) => dispatch({ type: "updateBlock", blockId: block.id, patch: p as never }),
    [block.id, dispatch],
  );
  /**
   * ⛔ `lead` / `card` / `midSection` / `cardRule` NE PASSENT JAMAIS PAR `patch`. `updateBlock`
   * fusionne sur UN niveau : `patch({ lead: { titleFont } })` effaçait tout le reste du look de la
   * une (son libellé « Destacada » compris). `updateBlockPart` fusionne DANS le sous-objet, contre
   * le document présent — pas contre la copie qu'avait ce rendu.
   */
  const patchPart = useCallback(
    (part: FeedPart, p: Record<string, unknown> | null) =>
      dispatch({ type: "updateBlockPart", blockId: block.id, part, patch: p }),
    [block.id, dispatch],
  );
  const layers = parents.map((l) => l.style);
  /**
   * La typographie que le compilateur applique à CE bloc quand un réglage du 22/09/2026 est absent
   * (« max(13, taille du bloc − 2) », « la graisse du bloc, sinon 700 »…) : sans elle, chaque champ
   * afficherait un défaut calculé sur le thème seul, faux dès qu'une row ou le bloc change la taille.
   */
  const base = resolveLookBase(theme, [...layers, "style" in block ? block.style : undefined]);
  /** « Use for all titles » : une seule étape d'annulation, calculée sur le document présent. */
  const useForAllTitles = (color: string) => dispatch({ type: "useForAllTitles", color });
  /**
   * Le même panneau Style + Mobile que la portée « Block », pour une boîte imbriquée (look, titre de
   * section, filet). `opts.typography: false` (lot L4) : le filet, qui ne dessine aucun texte.
   */
  const renderStyle = (
    style: BoxStyle | undefined,
    onChange: (next: BoxStyle | undefined) => void,
    opts?: { typography?: boolean; titre?: boolean },
  ) => (
    <>
      <StylePanel
        scope="block"
        style={style}
        theme={theme}
        parents={parents}
        defaultPadding={theme.blockPadding}
        onChange={onChange}
        typography={opts?.typography}
        titre={opts?.titre}
        onUseForAllTitles={opts?.titre ? useForAllTitles : undefined}
      />
      <MobilePanel
        scope="block"
        style={style}
        parents={parents}
        desktopPadding={{
          top: style?.padding?.top ?? theme.blockPadding.top ?? 0,
          right: style?.padding?.right ?? theme.blockPadding.right ?? 0,
          bottom: style?.padding?.bottom ?? theme.blockPadding.bottom ?? 0,
          left: style?.padding?.left ?? theme.blockPadding.left ?? 0,
        }}
        onChange={onChange}
        breakpoint={theme.mobileBreakpoint}
      />
    </>
  );

  switch (block.type) {
    case "text":
      return <TextEditor block={block} onPatch={patch} />;

    case "section_title":
      return <SectionTitleEditor block={block} patch={patch} />;

    case "callout":
      return (
        <CalloutEditor block={block} patch={patch} theme={theme} base={base} onUseForAllTitles={useForAllTitles} />
      );

    case "scoreboard":
      return <ScoreboardEditor block={block} patch={patch} theme={theme} base={base} />;

    case "image":
      return (
        <>
          <MediaField
            src={block.src}
            alt={block.alt}
            srcLabel="Image URL"
            altLabel="Alt text (required)"
            onSrc={(v) => patch({ src: v })}
            onAlt={(v) => patch({ alt: v })}
            onPick={(m) => patch({ src: m.src, alt: m.alt })}
          />
          <TextInput
            label="Link (optional)"
            value={block.href ?? ""}
            onChange={(v) => patch({ href: v.trim() === "" ? undefined : v })}
            placeholder="https://example.com"
          />
          <NumberInput
            label="Width"
            value={block.widthPct}
            min={5}
            max={100}
            suffix="%"
            onChange={(v) => patch({ widthPct: clampNum(v, 100, 5, 100) })}
          />
          <AlignInput value={block.align} onChange={(v) => patch({ align: v ?? "center" })} />
        </>
      );

    case "button":
      return (
        <>
          <TextInput
            label="Label"
            value={block.label}
            maxLength={MAX_BUTTON_LABEL}
            onChange={(v) => patch({ label: v })}
            right={
              <span
                className={cn(
                  "text-[10.5px] font-semibold tabular-nums",
                  block.label.length >= MAX_BUTTON_LABEL ? "text-[#b9790a]" : "text-muted-foreground",
                )}
              >
                {block.label.length}/{MAX_BUTTON_LABEL}
              </span>
            }
            warning={block.label.trim() === "" ? "An empty label makes the button unpublishable." : undefined}
            hint="Longer labels wrap inside Outlook buttons, which is why the field stops at 28 characters."
          />
          <TextInput
            label="Link"
            value={block.href}
            onChange={(v) => patch({ href: v })}
            placeholder="https://example.com"
            warning={block.href.trim() === "#" ? "\"#\" goes nowhere — recipients land on a dead link." : undefined}
          />
          <AlignInput value={block.align} onChange={(v) => patch({ align: v ?? "center" })} />
          {/* Couleurs, taille, graisse et marge du bouton : avant le 22/09/2026 elles venaient du
              seul thème, et un bouton d'une autre couleur que la marque était impossible. */}
          <ButtonLookFields block={block} theme={theme} base={base} patch={patch} />
        </>
      );

    case "divider":
      return (
        <>
          <NumberInput
            label="Thickness"
            value={block.thickness}
            min={1}
            max={12}
            suffix="px"
            onChange={(v) => patch({ thickness: clampNum(v, 1, 1, 12) })}
          />
          <NumberInput
            label="Width"
            value={block.widthPct}
            min={10}
            max={100}
            suffix="%"
            onChange={(v) => patch({ widthPct: clampNum(v, 100, 10, 100) })}
          />
          <ColorInput
            label="Color"
            value={block.color}
            onChange={(v) => patch({ color: v })}
            hint="Empty = the theme border color."
          />
          {/* ⛔ LE STYLE DE TRAIT NE VAUT QUE POUR UN FILET UNI : le compilateur dessine les segments
              en aplats, sans bordure. Montrer ce menu sous des segments ferait croire à un réglage
              qui n'atteint pas l'abonné. */}
          {block.segments === undefined ? (
            <ChoiceInput<LineStyle>
              label="Line style"
              value={block.lineStyle}
              def={propSpec("divider", "lineStyle").default as LineStyle}
              options={propSpec("divider", "lineStyle").options as readonly LineStyle[]}
              labels={LINE_STYLE_LABELS}
              onChange={(v) => patch({ lineStyle: v })}
              hint={propSpec("divider", "lineStyle").hint}
            />
          ) : (
            <Note>Line style (solid, dashed, dotted) applies to a single-colour divider — remove the segments to use it.</Note>
          )}
          <DividerSegmentsEditor
            segments={block.segments}
            fallbackColor={block.color ?? theme.borderColor}
            accentColor={theme.brandColor}
            onChange={(segments) => patch({ segments })}
          />
        </>
      );

    case "spacer":
      return (
        <>
          <NumberInput
            label="Height"
            value={block.height}
            min={1}
            max={200}
            suffix="px"
            onChange={(v) => patch({ height: clampNum(v, 24, 1, 200) })}
          />
          <NumberInput
            label="Height on mobile"
            value={block.heightMobile}
            min={1}
            max={200}
            suffix="px"
            hint="Empty = same height as desktop."
            onChange={(v) => patch({ heightMobile: v === undefined ? undefined : clampNum(v, 24, 1, 200) })}
          />
        </>
      );

    case "html":
      return (
        <>
          <TextAreaInput
            label="Raw HTML"
            value={block.raw}
            rows={14}
            mono
            onChange={(v) => patch({ raw: v.slice(0, 200_000) })}
            hint="Rendered untouched at compile time. Nothing here is sanitised, rewritten or checked for client support."
          />
          <p className="text-[11px] text-muted-foreground/70">{block.raw.length.toLocaleString()} / 200,000 characters</p>
        </>
      );

    case "social":
      return (
        <>
          {/* Icône et libellé par lien : TikTok, Telegram et WhatsApp n'ont pas d'icône MJML et
              partaient en globe sans que rien ne permette de le corriger. */}
          <SocialItemsEditor items={block.items} onChange={(items) => patch({ items })} />

          <SectionTitle>Display</SectionTitle>
          <NumberInput
            label="Icon size"
            value={block.iconSize}
            min={16}
            max={64}
            suffix="px"
            onChange={(v) => patch({ iconSize: clampNum(v, 24, 16, 64) })}
          />
          <SelectInput
            label="Direction"
            value={block.mode}
            options={["horizontal", "vertical"] as const}
            onChange={(v) => patch({ mode: v })}
          />
          <SocialLookFields block={block} theme={theme} patch={patch} />
        </>
      );

    case "menu":
      return (
        <>
          {/* Un lien = une carte repliée, ouverte par « Add item » (`MenuItemsEditor`). */}
          <MenuItemsEditor items={block.items} onChange={(items) => patch({ items })} />
          <SectionTitle>Display</SectionTitle>
          <TextInput
            label="Separator"
            value={block.separator}
            maxLength={8}
            onChange={(v) => patch({ separator: v })}
          />
          <MenuLookFields block={block} theme={theme} base={base} patch={patch} />
        </>
      );

    case "pick":
      return <PickEditor block={block} patch={patch} theme={theme} base={base} />;

    case "odds_table":
      return <OddsTableEditor block={block} patch={patch} theme={theme} base={base} />;

    case "standings":
      return <StandingsEditor block={block} patch={patch} theme={theme} base={base} />;

    case "article":
      return (
        <ArticleEditor
          block={block}
          patch={patch}
          locale={locale}
          theme={theme}
          layers={layers}
          defaultCtaLabel={defaultCtaLabel}
          onUseForAllTitles={useForAllTitles}
        />
      );

    case "promo":
      return <PromoEditor block={block} patch={patch} theme={theme} base={base} />;

    case "article-feed":
      return (
        <FeedEditor
          block={block}
          patch={patch}
          dispatch={dispatch}
          locale={locale}
          theme={theme}
          layers={layers}
          patchPart={patchPart}
          renderStyle={renderStyle}
          defaultCtaLabel={defaultCtaLabel}
        />
      );

    case "footer_legal":
      return <LegalFooterPicker block={block} patch={patch} />;
  }
}

/* ------------------------------------------------------------------ *
 * Style — row / colonne / bloc, avec la cascade rendue visible
 * ------------------------------------------------------------------ */

/**
 * Onglet Style, portée « Block » (24/09/2026, feature 5, étape 5). Styles globaux : un bloc SUIT les
 * styles de l'e-mail ; son propre style est l'exception, replié sous « Custom style » et annulable d'un
 * clic (« Reset to email styles » = le « Reset all » du panneau, dit à l'endroit où on le cherche).
 * SANS HOOK : le banc l'appelle comme une fonction et atteint le `onClick` réel du bouton.
 */
export function BlockCustomStyle({
  style,
  theme,
  parents,
  onChange,
  titre,
  onUseForAllTitles,
}: {
  style: BoxStyle | undefined;
  theme: Theme;
  parents: Layer[];
  onChange: (next: BoxStyle | undefined) => void;
  titre: boolean;
  onUseForAllTitles: (color: string) => void;
}) {
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
        {style === undefined ? (
          <span>Uses the email styles.</span>
        ) : (
          <>
            <span>Has its own style ({overrides(style)}).</span>
            <MiniBtn label="Reset this block to the email styles" onClick={() => onChange(undefined)}>
              Reset to email styles
            </MiniBtn>
          </>
        )}
      </div>
      <Group id="style.block.custom" title="Custom style" summary={overrides(style)} defaultOpen={style !== undefined}>
        <StylePanel
          scope="block"
          theme={theme}
          style={style}
          parents={parents}
          defaultPadding={theme.blockPadding}
          onChange={onChange}
          titre={titre}
          onUseForAllTitles={onUseForAllTitles}
        />
      </Group>
    </>
  );
}

export function StylePanel({
  scope,
  style,
  onChange,
  theme,
  parents,
  defaultPadding,
  typography = true,
  titre = false,
  onUseForAllTitles,
}: {
  scope: Exclude<Scope, "theme">;
  style: BoxStyle | undefined;
  onChange: (next: BoxStyle | undefined) => void;
  theme: Theme;
  /** Étages consultés pour les propriétés HÉRITABLES, du plus général au plus spécifique. */
  parents: Layer[];
  /** Padding appliqué à cet étage quand rien n'est surchargé. */
  defaultPadding: Spacing;
  /**
   * `false` : une boîte qui ne dessine AUCUN texte — le filet entre les cartes d'un flux, compilé en
   * `mj-divider` (lot L4, 23/09/2026). Ses huit réglages de texte (couleurs, police, taille, interligne,
   * graisse, approche, casse) ne changent pas l'e-mail d'un octet : ils sont retirés, pour ne plus
   * proposer un réglage sans effet. ⛔ « Content alignment » RESTE : il place un filet plus court que
   * la colonne (`align: r.align`, `packages/render/src/compile/mjml.ts`). Les deux faits sont prouvés
   * par compilation dans `inspector-groups-feed.test.ts`. Rien n'est effacé du document : une valeur
   * déjà posée reste, inerte, et « Reset all » la retire.
   */
  typography?: boolean;
  /**
   * Le bloc est un TITRE (h1-h3, titre de section) : sans couleur ni police dans la cascade, il prend
   * celles des titres de l'e-mail (`theme.headingColor` / `headingFont`) — c'est ce qui s'affiche hérité.
   */
  titre?: boolean;
  /** Titre à couleur propre : « Use for all titles » sous « Text color » (action `useForAllTitles`). */
  onUseForAllTitles?: (color: string) => void;
}) {
  const s: BoxStyle = style ?? {};
  const set = (patch: Partial<BoxStyle>) => onChange(normalizeStyle({ ...s, ...patch }));

  // Propres à la boîte : le compilateur ne regarde QUE l'étage courant → `parents` vide.
  const own: Layer[] = [];

  const couleurTitre = titre ? theme.headingColor : undefined;
  const policeTitre = titre ? theme.headingFont : undefined;
  const text = inheritedOf(parents, "textColor", couleurTitre ?? theme.textColor, couleurTitre === undefined ? undefined : "Email title style");
  const link = inheritedOf(parents, "linkColor", theme.linkColor);
  const family = inheritedOf(parents, "fontFamily", policeTitre ?? theme.fontFamily, policeTitre === undefined ? undefined : "Email title style");
  const size = inheritedOf(parents, "fontSize", theme.fontSize);
  const height = inheritedOf(parents, "lineHeight", theme.lineHeight);
  const align = inheritedOf(parents, "align", "left");
  const weight = inheritedOf(parents, "fontWeight", undefined);
  const spacing = inheritedOf(parents, "letterSpacing", undefined);
  const transform = inheritedOf(parents, "textTransform", undefined);
  const vAlign = inheritedOf(parents, "verticalAlign", "top");
  const background = inheritedOf(own, "backgroundColor", scope === "row" ? theme.contentBackground : undefined);
  const borderColor = inheritedOf(own, "borderColor", theme.borderColor);
  const radius = inheritedOf(own, "borderRadius", theme.radius);

  return (
    <>
      <SectionTitle>Box</SectionTitle>
      <ColorInput
        label="Background color"
        value={s.backgroundColor}
        inherited={background?.value}
        inheritedFrom={background?.from}
        onReset={s.backgroundColor === undefined ? undefined : () => set({ backgroundColor: undefined })}
        onChange={(v) => set({ backgroundColor: v })}
        hint={scope === "row" ? undefined : "Empty = the row background shows through."}
      />
      <SpacingInput
        label="Padding (px)"
        value={s.padding}
        defaults={defaultPadding}
        inheritedFrom={scope === "column" ? "the column default" : "Email styles"}
        onChange={(next) => set({ padding: next })}
        hint="Padding never cascades: a row padding is not added to the padding of its blocks."
      />

      <SectionTitle>{typography ? "Typography" : "Alignment"}</SectionTitle>
      {typography && (
        <>
          <ColorInput
            label="Text color"
            value={s.textColor}
            inherited={text?.value}
            inheritedFrom={text?.from}
            onReset={s.textColor === undefined ? undefined : () => set({ textColor: undefined })}
            onChange={(v) => set({ textColor: v })}
          />
          {titre && s.textColor !== undefined && onUseForAllTitles && (
            <UseForAllTitles color={s.textColor} onUse={onUseForAllTitles} />
          )}
          <ColorInput
            label="Link color"
            value={s.linkColor}
            inherited={link?.value}
            inheritedFrom={link?.from}
            onReset={s.linkColor === undefined ? undefined : () => set({ linkColor: undefined })}
            onChange={(v) => set({ linkColor: v })}
          />
          <TextInput
            label="Font family"
            value={s.fontFamily ?? ""}
            inherited={family?.value}
            inheritedFrom={family?.from}
            onReset={s.fontFamily === undefined ? undefined : () => set({ fontFamily: undefined })}
            onChange={(v) => set({ fontFamily: v.trim() === "" ? undefined : v })}
            hint="A full CSS stack. Web fonts are unreliable in email — always end with a system fallback."
          />
          <NumberInput
            label="Font size"
            value={s.fontSize}
            min={8}
            max={72}
            suffix="px"
            inherited={size === undefined ? undefined : String(size.value)}
            inheritedFrom={size?.from}
            onReset={s.fontSize === undefined ? undefined : () => set({ fontSize: undefined })}
            onChange={(v) => set({ fontSize: v === undefined ? undefined : clampNum(v, 16, 8, 72) })}
            hint="On a text block this replaces the preset's size, h1/h2/h3 included."
          />
          <NumberInput
            label="Line height"
            value={s.lineHeight}
            min={1}
            max={3}
            step={0.05}
            inherited={height === undefined ? undefined : String(height.value)}
            inheritedFrom={height?.from}
            onReset={s.lineHeight === undefined ? undefined : () => set({ lineHeight: undefined })}
            onChange={(v) => set({ lineHeight: v === undefined ? undefined : Math.min(Math.max(v, 1), 3) })}
          />
          <SelectInput
            label="Font weight"
            value={s.fontWeight ?? ""}
            options={[
              { value: "", label: "Inherit" },
              { value: "300", label: "300 — Light" },
              { value: "400", label: "400 — Regular" },
              { value: "500", label: "500 — Medium" },
              { value: "600", label: "600 — Semibold" },
              { value: "700", label: "700 — Bold" },
              { value: "800", label: "800 — Extrabold" },
              { value: "900", label: "900 — Black" },
            ]}
            inherited={weight?.value}
            inheritedFrom={weight?.from}
            onReset={s.fontWeight === undefined ? undefined : () => set({ fontWeight: undefined })}
            onChange={(v) => set({ fontWeight: v === "" ? undefined : (v as NonNullable<BoxStyle["fontWeight"]>) })}
            hint="Weights above 700 need a web font that actually carries them — otherwise the client fakes or ignores it."
          />
          <NumberInput
            label="Letter spacing"
            value={s.letterSpacing}
            min={-2}
            max={10}
            step={0.1}
            suffix="px"
            inherited={spacing === undefined ? undefined : String(spacing.value)}
            inheritedFrom={spacing?.from}
            onReset={s.letterSpacing === undefined ? undefined : () => set({ letterSpacing: undefined })}
            onChange={(v) => set({ letterSpacing: v === undefined ? undefined : Math.min(Math.max(v, -2), 10) })}
          />
          <SelectInput
            label="Text case"
            value={s.textTransform ?? ""}
            options={[
              { value: "", label: "Inherit" },
              { value: "none", label: "As typed" },
              { value: "uppercase", label: "UPPERCASE" },
              { value: "lowercase", label: "lowercase" },
              { value: "capitalize", label: "Capitalize" },
            ]}
            inherited={transform?.value}
            inheritedFrom={transform?.from}
            onReset={s.textTransform === undefined ? undefined : () => set({ textTransform: undefined })}
            onChange={(v) => set({ textTransform: v === "" ? undefined : (v as NonNullable<BoxStyle["textTransform"]>) })}
            hint="Changes the rendering only — the text stays as typed in the document and in the plain-text version."
          />
        </>
      )}
      <AlignInput
        label="Content alignment"
        value={s.align}
        allowInherit
        inherited={align?.value}
        inheritedFrom={align?.from}
        onReset={s.align === undefined ? undefined : () => set({ align: undefined })}
        onChange={(v) => set({ align: v as Align | undefined })}
      />

      {scope === "column" && (
        <SelectInput
          label="Vertical alignment"
          value={s.verticalAlign ?? ""}
          options={[
            { value: "", label: "Inherit" },
            { value: "top", label: "Top" },
            { value: "middle", label: "Middle" },
            { value: "bottom", label: "Bottom" },
          ]}
          inherited={vAlign?.value}
          inheritedFrom={vAlign?.from}
          onReset={s.verticalAlign === undefined ? undefined : () => set({ verticalAlign: undefined })}
          onChange={(v) => set({ verticalAlign: v === "" ? undefined : (v as NonNullable<BoxStyle["verticalAlign"]>) })}
          hint="How this column sits against its taller neighbours. Columns are the only level the renderer aligns."
        />
      )}

      <SectionTitle>Border</SectionTitle>
      {scope !== "row" && (
        <NumberInput
          label="Border width"
          value={s.borderWidth}
          min={0}
          max={12}
          suffix="px"
          inherited="0"
          inheritedFrom={scope === "column" ? "the column default" : "no border"}
          onReset={s.borderWidth === undefined ? undefined : () => set({ borderWidth: undefined })}
          onChange={(v) => set({ borderWidth: v === undefined ? undefined : clampNum(v, 0, 0, 12) })}
          hint={
            scope === "column"
              ? "0 = no border."
              : "0 = no border. Drawn by callout and scoreboard panels; the other blocks ignore it."
          }
        />
      )}
      {scope !== "row" && (
        <ColorInput
          label="Border color"
          value={s.borderColor}
          inherited={borderColor?.value}
          inheritedFrom={borderColor?.from}
          onReset={s.borderColor === undefined ? undefined : () => set({ borderColor: undefined })}
          onChange={(v) => set({ borderColor: v })}
          hint={
            scope === "block"
              ? "Used by the blocks that draw rules: divider, odds table, standings, and the pick card outline."
              : undefined
          }
        />
      )}
      {scope === "block" && (
        <NumberInput
          label="Corner radius"
          value={s.borderRadius}
          min={0}
          max={48}
          suffix="px"
          inherited={radius === undefined ? undefined : String(radius.value)}
          inheritedFrom={radius?.from}
          onReset={s.borderRadius === undefined ? undefined : () => set({ borderRadius: undefined })}
          onChange={(v) => set({ borderRadius: v === undefined ? undefined : clampNum(v, 8, 0, 48) })}
          hint="Applies to images, buttons and cards. Outlook desktop squares off table-based buttons whatever the value."
        />
      )}
      {scope === "row" && (
        <Note>Rows draw no border of their own — set one on the column inside, or on the block.</Note>
      )}

      {style !== undefined && (
        <div className="mt-4">
          <MiniBtn label={`Reset every ${SCOPE_LABEL[scope].toLowerCase()} style override`} onClick={() => onChange(undefined)}>
            Reset all {SCOPE_LABEL[scope].toLowerCase()} overrides
          </MiniBtn>
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Thème de marque — la racine de la cascade
 * ------------------------------------------------------------------ */

/** Libellés des presets du bloc texte, dans l'ordre du menu « Preset » de ce même bloc. */
const PRESET_TITLES: Record<TextPreset, string> = {
  h1: "Heading 1",
  h2: "Heading 2",
  h3: "Heading 3",
  body: "Body",
  small: "Small print",
};

type PresetSetting = NonNullable<NonNullable<Theme["textPresets"]>[TextPreset]>;

/**
 * STYLES DE L'E-MAIL (24/09/2026, feature 5) — les réglages qu'on change vraiment, à plat, sans
 * accordéon : titres, paragraphes, liens, boutons, fonds. Chacun écrit une clé du thème, donc s'applique
 * à tout bloc qui ne pose pas la sienne. Le thème complet reste dessous, replié (« Advanced »).
 *
 * ⛔ Honnêteté des libellés : `brandColor` et `radius` servent à plus que les boutons (badges, cadres) —
 * l'indication le dit, plutôt que de laisser croire qu'on ne touche qu'au bouton.
 */
export function EmailStylesPanel({
  theme,
  usedIn,
  onChange,
}: {
  theme: Theme;
  usedIn: string;
  onChange: (next: Theme) => void;
}) {
  const set = (patch: Partial<Theme>) => onChange({ ...theme, ...patch });
  const D = THEME_DEFAULTS;
  const resetIf = <K extends keyof Theme>(key: K) =>
    theme[key] === D[key] ? undefined : () => set({ [key]: D[key] } as Partial<Theme>);
  /**
   * ⛔ L'interligne des PARAGRAPHES est celui du preset « body » (1,55), pas `theme.lineHeight` : un bloc
   * texte prend l'interligne de son preset, et `theme.lineHeight` ne touche que les autres blocs (encart,
   * titre de section…). Mesuré le 24/09 : écrire `theme.lineHeight` ne changeait pas un octet d'un
   * paragraphe. `textPresets` est réécrit fusionné, comme dans `ThemePanel`.
   */
  const bodySpec = propSpec("theme", "textPresets.body.lineHeight");
  const bodyLineHeight = theme.textPresets?.body?.lineHeight;
  const setBodyLineHeight = (v: number | undefined) => {
    const presets = theme.textPresets ?? {};
    const merged = prune({ ...presets.body, lineHeight: v });
    const next = { ...presets };
    if (Object.keys(merged).length === 0) delete next.body;
    else next.body = merged;
    set({ textPresets: Object.keys(next).length === 0 ? undefined : next });
  };

  return (
    <>
      <Note>
        These styles apply to the whole email. A block keeps them until you customise it; a colour or font set on a row,
        column or block always wins.
      </Note>

      <SectionTitle>Titles</SectionTitle>
      <ColorInput
        label="Title colour"
        value={theme.headingColor}
        inherited={theme.textColor}
        inheritedFrom="the paragraph colour"
        onChange={(v) => set({ headingColor: v })}
        onReset={theme.headingColor === undefined ? undefined : () => set({ headingColor: undefined })}
        hint="H1–H3 text, section titles, article and callout titles."
      />
      <FontInput
        label="Title font"
        value={theme.headingFont}
        inherited={theme.fontFamily}
        inheritedLabel="Same as paragraphs"
        theme={theme}
        onChange={(v) => set({ headingFont: v })}
      />

      <SectionTitle>Paragraphs</SectionTitle>
      <ColorInput label="Text colour" value={theme.textColor} onChange={(v) => set({ textColor: v ?? D.textColor })} onReset={resetIf("textColor")} />
      <FontInput
        label="Text font"
        value={theme.fontFamily === D.fontFamily ? undefined : theme.fontFamily}
        inherited={D.fontFamily}
        inheritedLabel="Default"
        theme={theme}
        onChange={(v) => set({ fontFamily: v ?? D.fontFamily })}
      />
      <NumberInput
        label="Text size"
        value={theme.fontSize}
        min={10}
        max={24}
        suffix="px"
        onChange={(v) => set({ fontSize: clampNum(v, D.fontSize, 10, 24) })}
        onReset={resetIf("fontSize")}
      />
      <NumberInput
        label="Line height"
        value={bodyLineHeight}
        {...numberField(bodySpec)}
        inherited={literalDefault(bodySpec)}
        inheritedFrom="the paragraph preset"
        onChange={(v) => setBodyLineHeight(clampTo(specBounds(bodySpec), v))}
        onReset={bodyLineHeight === undefined ? undefined : () => setBodyLineHeight(undefined)}
      />

      <SectionTitle>Links</SectionTitle>
      <ColorInput label="Link colour" value={theme.linkColor} onChange={(v) => set({ linkColor: v ?? D.linkColor })} onReset={resetIf("linkColor")} />
      <CheckboxInput
        label="Link underline"
        text="Keep the underline mail apps add to links"
        checked={theme.resetLinkDecoration === false}
        onChange={(v) => set({ resetLinkDecoration: v ? false : undefined })}
        onReset={theme.resetLinkDecoration === undefined ? undefined : () => set({ resetLinkDecoration: undefined })}
      />

      <SectionTitle>Buttons</SectionTitle>
      <ColorInput
        label="Button background"
        value={theme.brandColor}
        onChange={(v) => set({ brandColor: v ?? D.brandColor })}
        onReset={resetIf("brandColor")}
        hint="The brand colour: also odds badges, accents and the promo outline."
      />
      <ColorInput label="Button text" value={theme.buttonTextColor} onChange={(v) => set({ buttonTextColor: v ?? D.buttonTextColor })} onReset={resetIf("buttonTextColor")} />
      <NumberInput
        label="Corner radius"
        value={theme.radius}
        min={0}
        max={48}
        suffix="px"
        onChange={(v) => set({ radius: clampNum(v, D.radius, 0, 48) })}
        onReset={resetIf("radius")}
        hint="Also rounds boxes and cards that set no radius of their own."
      />

      <SectionTitle>Background</SectionTitle>
      <ColorInput label="Page background" value={theme.bodyBackground} onChange={(v) => set({ bodyBackground: v ?? D.bodyBackground })} onReset={resetIf("bodyBackground")} />
      <ColorInput label="Content background" value={theme.contentBackground} onChange={(v) => set({ contentBackground: v ?? D.contentBackground })} onReset={resetIf("contentBackground")} />

      <Group id="theme.advanced" title="Advanced — every email setting">
        <ThemePanel theme={theme} usedIn={usedIn} onChange={onChange} />
      </Group>
    </>
  );
}

export function ThemePanel({
  theme,
  usedIn,
  onChange,
}: {
  theme: Theme;
  /** Tout le texte où une famille de police peut être nommée — cf. `WebFontsEditor`. */
  usedIn: string;
  onChange: (next: Theme) => void;
}) {
  const set = (patch: Partial<Theme>) => onChange({ ...theme, ...patch });
  const D = THEME_DEFAULTS;
  const spec = (path: string) => propSpec("theme", path);

  /** Bouton « Reset » présent uniquement quand la valeur s'écarte de celle livrée par le schéma. */
  const resetIf = <K extends keyof Theme>(key: K, equal: boolean) =>
    equal ? undefined : () => set({ [key]: D[key] } as Partial<Theme>);

  /**
   * ⛔ `textPresets` EST RÉÉCRIT ENTIER, preset par preset fusionné : `set` ne fusionne qu'au premier
   * niveau du thème, et écrire `{ h1: { size } }` seul effacerait les réglages de h2 et de body. Un
   * preset vidé disparaît, et un `textPresets` vide redevient absent — le rendu d'avant, à l'octet.
   */
  const presets = theme.textPresets ?? {};
  const setPreset = (name: TextPreset, p: Partial<PresetSetting>) => {
    const merged = prune({ ...presets[name], ...p });
    const next = { ...presets };
    if (Object.keys(merged).length === 0) delete next[name];
    else next[name] = merged;
    set({ textPresets: Object.keys(next).length === 0 ? undefined : next });
  };

  return (
    <>
      <Note>
        These values are the root of the cascade: every row, column and block falls back here. Changing one repaints
        the whole email.
      </Note>

      <SectionTitle>Canvas</SectionTitle>
      <ColorInput
        label="Page background"
        value={theme.bodyBackground}
        onChange={(v) => set({ bodyBackground: v ?? D.bodyBackground })}
        onReset={resetIf("bodyBackground", theme.bodyBackground === D.bodyBackground)}
        hint="Behind the content column, visible on wide screens."
      />
      <ColorInput
        label="Content background"
        value={theme.contentBackground}
        onChange={(v) => set({ contentBackground: v ?? D.contentBackground })}
        onReset={resetIf("contentBackground", theme.contentBackground === D.contentBackground)}
      />
      <NumberInput
        label="Content width"
        value={theme.contentWidth}
        min={320}
        max={800}
        suffix="px"
        onChange={(v) => set({ contentWidth: clampNum(v, D.contentWidth, 320, 800) })}
        onReset={resetIf("contentWidth", theme.contentWidth === D.contentWidth)}
        hint="600px is the safe default: every column width is derived from this number."
      />

      <SectionTitle>Typography</SectionTitle>
      <TextInput
        label="Font family"
        value={theme.fontFamily}
        onChange={(v) => set({ fontFamily: v.trim() === "" ? D.fontFamily : v })}
        onReset={resetIf("fontFamily", theme.fontFamily === D.fontFamily)}
        hint="A full CSS stack. To use a web font, add it under Web fonts below, name it first here and keep a system font after it — Outlook and Gmail fall back to that one."
      />
      <NumberInput
        label="Base font size"
        value={theme.fontSize}
        min={10}
        max={24}
        suffix="px"
        onChange={(v) => set({ fontSize: clampNum(v, D.fontSize, 10, 24) })}
        onReset={resetIf("fontSize", theme.fontSize === D.fontSize)}
      />
      <NumberInput
        label="Line height"
        value={theme.lineHeight}
        min={1}
        max={3}
        step={0.05}
        onChange={(v) => set({ lineHeight: v === undefined ? D.lineHeight : Math.min(Math.max(v, 1), 3) })}
        onReset={resetIf("lineHeight", theme.lineHeight === D.lineHeight)}
      />
      {/* Styles globaux des titres (24/09/2026) : absente = la police du texte. */}
      <FontInput
        label="Title font"
        value={theme.headingFont}
        inherited={theme.fontFamily}
        inheritedLabel="Same as the text"
        theme={theme}
        onChange={(v) => set({ headingFont: v })}
        hint={spec("headingFont").hint}
      />
      {/* Les feuilles de police que le compilateur charge (`mj-font`) — jusqu'ici posées par
          l'import des maquettes seulement, invisibles et impossibles à retirer. */}
      <WebFontsEditor fonts={theme.webFonts} usedIn={usedIn} onChange={(next) => set({ webFonts: next })} />

      {/* Les cinq presets du bloc texte : leurs tailles, graisses et interlignes étaient figés dans le
          compilateur. Repliés : on les règle une fois par marque, pas à chaque email. */}
      <SectionTitle>Text presets</SectionTitle>
      {TEXT_PRESETS.map((name) => {
        const own = presets[name] ?? {};
        const sizeSpec = spec(`textPresets.${name}.size`);
        const weightSpec = spec(`textPresets.${name}.weight`);
        const heightSpec = spec(`textPresets.${name}.lineHeight`);
        // Le body suit la taille de base du thème : son défaut est une règle, pas une constante.
        const sizeDefault = literalDefault(sizeSpec) ?? String(theme.fontSize);
        return (
          <Group key={name} title={PRESET_TITLES[name]} summary={overrides(own, ["size", "weight", "lineHeight"])}>
            <NumberInput
              label="Size"
              value={own.size}
              {...numberField(sizeSpec)}
              suffix="px"
              inherited={sizeDefault}
              inheritedFrom={literalDefault(sizeSpec) === undefined ? "the base font size" : "the preset default"}
              onReset={own.size === undefined ? undefined : () => setPreset(name, { size: undefined })}
              onChange={(v) => setPreset(name, { size: clampTo(specBounds(sizeSpec), v) })}
            />
            <ChoiceInput<Weight>
              label="Weight"
              value={own.weight}
              def={weightSpec.default as Weight}
              options={weightSpec.options as readonly Weight[]}
              labels={WEIGHT_LABELS}
              onChange={(v) => setPreset(name, { weight: v })}
              hint={weightSpec.hint}
            />
            <NumberInput
              label="Line height"
              value={own.lineHeight}
              {...numberField(heightSpec)}
              inherited={literalDefault(heightSpec)}
              inheritedFrom="the preset default"
              onReset={own.lineHeight === undefined ? undefined : () => setPreset(name, { lineHeight: undefined })}
              onChange={(v) => setPreset(name, { lineHeight: clampTo(specBounds(heightSpec), v) })}
            />
          </Group>
        );
      })}

      <SectionTitle>Colors</SectionTitle>
      <ColorInput
        label="Text"
        value={theme.textColor}
        onChange={(v) => set({ textColor: v ?? D.textColor })}
        onReset={resetIf("textColor", theme.textColor === D.textColor)}
      />
      <ColorInput
        label="Titles"
        value={theme.headingColor}
        inherited={theme.textColor}
        inheritedFrom="the text colour"
        onChange={(v) => set({ headingColor: v })}
        onReset={theme.headingColor === undefined ? undefined : () => set({ headingColor: undefined })}
        hint={spec("headingColor").hint}
      />
      <ColorInput
        label="Muted text"
        value={theme.mutedColor}
        onChange={(v) => set({ mutedColor: v ?? D.mutedColor })}
        onReset={resetIf("mutedColor", theme.mutedColor === D.mutedColor)}
        hint="Captions, kick-off lines, terms — everything the reader can skip."
      />
      <ColorInput
        label="Links"
        value={theme.linkColor}
        onChange={(v) => set({ linkColor: v ?? D.linkColor })}
        onReset={resetIf("linkColor", theme.linkColor === D.linkColor)}
      />
      <CheckboxInput
        label="Link underlines"
        text="Remove the underline mail apps add to links"
        checked={theme.resetLinkDecoration !== false}
        onChange={(v) => set({ resetLinkDecoration: v ? undefined : false })}
        onReset={theme.resetLinkDecoration === undefined ? undefined : () => set({ resetLinkDecoration: undefined })}
        hint={`${spec("resetLinkDecoration").hint} A link or menu item that sets its own underline keeps it either way.`}
      />
      <ColorInput
        label="Brand"
        value={theme.brandColor}
        onChange={(v) => set({ brandColor: v ?? D.brandColor })}
        onReset={resetIf("brandColor", theme.brandColor === D.brandColor)}
        hint="Buttons, odds badges, promo outline."
      />
      <ColorInput
        label="Button text"
        value={theme.buttonTextColor}
        onChange={(v) => set({ buttonTextColor: v ?? D.buttonTextColor })}
        onReset={resetIf("buttonTextColor", theme.buttonTextColor === D.buttonTextColor)}
      />
      <ColorInput
        label="Borders"
        value={theme.borderColor}
        onChange={(v) => set({ borderColor: v ?? D.borderColor })}
        onReset={resetIf("borderColor", theme.borderColor === D.borderColor)}
      />
      <NumberInput
        label="Corner radius"
        value={theme.radius}
        min={0}
        max={48}
        suffix="px"
        onChange={(v) => set({ radius: clampNum(v, D.radius, 0, 48) })}
        onReset={resetIf("radius", theme.radius === D.radius)}
      />

      <SectionTitle>Default padding</SectionTitle>
      <SpacingInput
        label="Rows (px)"
        value={theme.rowPadding}
        defaults={ZERO_PAD}
        onChange={(next) => set({ rowPadding: next ?? D.rowPadding })}
        hint="Applied to every row that does not set its own."
      />
      <SpacingInput
        label="Blocks (px)"
        value={theme.blockPadding}
        defaults={ZERO_PAD}
        onChange={(next) => set({ blockPadding: next ?? D.blockPadding })}
        hint="The left/right value is what keeps text off the edge of the email — do not take it to 0 lightly."
      />

      {/* Les deux seuils étaient des constantes du compilateur (600 et le 480 de MJML). */}
      <SectionTitle>Screen sizes</SectionTitle>
      <NumberInput
        label="Mobile below"
        value={theme.mobileBreakpoint}
        {...numberField(spec("mobileBreakpoint"))}
        suffix="px"
        inherited={literalDefault(spec("mobileBreakpoint"))}
        inheritedFrom="the default"
        onReset={theme.mobileBreakpoint === undefined ? undefined : () => set({ mobileBreakpoint: undefined })}
        onChange={(v) => set({ mobileBreakpoint: clampTo(specBounds(spec("mobileBreakpoint")), v) })}
        hint={`${spec("mobileBreakpoint").hint} Everything under the Mobile tab, including “hide on mobile”, switches at this width.`}
      />
      <NumberInput
        label="Columns side by side from"
        value={theme.columnBreakpoint}
        {...numberField(spec("columnBreakpoint"))}
        suffix="px"
        inherited={literalDefault(spec("columnBreakpoint"))}
        inheritedFrom="the default"
        onReset={theme.columnBreakpoint === undefined ? undefined : () => set({ columnBreakpoint: undefined })}
        onChange={(v) => set({ columnBreakpoint: clampTo(specBounds(spec("columnBreakpoint")), v) })}
        hint={`${spec("columnBreakpoint").hint} Narrower screens stack them.`}
      />

      <SectionTitle>Dark mode</SectionTitle>
      <Note>
        Optional overrides applied through <code>prefers-color-scheme</code>. Only some clients honour it; the others
        keep the light palette, and a few invert it themselves whatever you write here.
      </Note>
      <ChoiceInput<NonNullable<Theme["colorScheme"]>>
        label="Colour schemes"
        value={theme.colorScheme}
        def={spec("colorScheme").default as NonNullable<Theme["colorScheme"]>}
        options={spec("colorScheme").options as readonly NonNullable<Theme["colorScheme"]>[]}
        labels={{ "light only": "Light only", "light dark": "Light and dark", light: "Light (legacy)" }}
        onChange={(v) => set({ colorScheme: v })}
        hint={spec("colorScheme").hint}
      />
      <CheckboxInput
        label="Text-free bands"
        text="Keep the background of logo rows, image blocks and coloured rules as set"
        checked={theme.pinDarkRows !== false}
        onChange={(v) => set({ pinDarkRows: v ? undefined : false })}
        onReset={theme.pinDarkRows === undefined ? undefined : () => set({ pinDarkRows: undefined })}
        hint={spec("pinDarkRows").hint}
      />
      <CheckboxInput
        label="Pure white and black"
        text="Soften pure #ffffff and #000000 so dark mode does not invert them"
        checked={theme.neutralizePureColors !== false}
        onChange={(v) => set({ neutralizePureColors: v ? undefined : false })}
        onReset={theme.neutralizePureColors === undefined ? undefined : () => set({ neutralizePureColors: undefined })}
        hint={`${spec("neutralizePureColors").hint} This also applies inside HTML blocks.`}
      />
      <ColorInput
        label="Page background (dark)"
        value={theme.darkBodyBackground}
        onChange={(v) => set({ darkBodyBackground: v })}
      />
      <ColorInput
        label="Content background (dark)"
        value={theme.darkContentBackground}
        onChange={(v) => set({ darkContentBackground: v })}
      />
      <ColorInput label="Text (dark)" value={theme.darkTextColor} onChange={(v) => set({ darkTextColor: v })} />
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Mobile
 * ------------------------------------------------------------------ */

function MobilePanel({
  scope,
  style,
  onChange,
  parents,
  desktopPadding,
  breakpoint,
}: {
  scope: Exclude<Scope, "theme">;
  style: BoxStyle | undefined;
  onChange: (next: BoxStyle | undefined) => void;
  parents: Layer[];
  /** Padding desktop RÉSOLU de cet étage — c'est lui qui s'applique si rien n'est surchargé. */
  desktopPadding: Spacing;
  /** `theme.mobileBreakpoint` : le seuil de la media query que ces réglages habitent. Absent = 600. */
  breakpoint?: number;
}) {
  const s: BoxStyle = style ?? {};
  const set = (patch: Partial<BoxStyle>) => onChange(normalizeStyle({ ...s, ...patch }));
  const sizeMobile = inheritedOf(parents, "fontSizeMobile");

  return (
    <>
      <Note tone="warn">
        Everything below rides on a CSS media query in the email head. Outlook desktop ignores it by design, and a few
        clients strip the whole style block — a block hidden here can still be read there. Never use it to hide
        something that must not be seen.
      </Note>

      {/* Le titre suit `theme.mobileBreakpoint` (22/09/2026) : « Under 600px » sous un seuil réglé à
          480 annoncerait une largeur que la media query envoyée ne teste pas. */}
      <SectionTitle>Under {breakpoint ?? literalDefault(propSpec("theme", "mobileBreakpoint"))}px</SectionTitle>
      <CheckboxInput
        label="Visibility"
        text={`Hide this ${SCOPE_LABEL[scope].toLowerCase()} on small screens`}
        checked={s.hideOnMobile === true}
        onChange={(v) => set({ hideOnMobile: v ? true : undefined })}
        onReset={s.hideOnMobile === undefined ? undefined : () => set({ hideOnMobile: undefined })}
        hint="Mobile-only hiding, not a real condition: the content still travels in the email and stays in the source."
      />
      <NumberInput
        label="Font size on mobile"
        value={s.fontSizeMobile}
        min={8}
        max={72}
        suffix="px"
        inherited={sizeMobile === undefined ? undefined : String(sizeMobile.value)}
        inheritedFrom={sizeMobile?.from}
        onReset={s.fontSizeMobile === undefined ? undefined : () => set({ fontSizeMobile: undefined })}
        onChange={(v) => set({ fontSizeMobile: v === undefined ? undefined : clampNum(v, 16, 8, 72) })}
        hint="Empty = the desktop size applies on mobile too."
      />

      {scope === "block" ? (
        <SpacingInput
          label="Padding on mobile (px)"
          value={s.paddingMobile}
          defaults={desktopPadding}
          inheritedFrom="the desktop padding"
          onChange={(next) => set({ paddingMobile: next })}
          hint="Each side falls back to its desktop value when left empty."
        />
      ) : (
        <Note>
          Mobile padding is set on blocks. The renderer emits the mobile rule per block only, so an override written
          here would be silently dropped — it is not offered rather than pretending to work.
        </Note>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Contenu conditionnel
 * ------------------------------------------------------------------ */

/**
 * Tokens proposés : le REGISTRE des merge tags, moins le footer légal (conditionner le footer
 * système n'a aucun sens). Champ fermé et jamais libre — `hydrate` masque fail-closed un champ
 * inconnu, donc un token tapé à la main ferait disparaître le bloc pour TOUT LE MONDE, en silence.
 */
const CONDITION_OPTIONS: { value: MergeVarName; label: string }[] = CONDITION_FIELDS.filter(
  (name) => !name.startsWith("legal_footer"),
).map((name) => ({
  value: name,
  label: MERGE_VARS[name].kind === "flag" ? `${MERGE_VARS[name].label} (flag)` : MERGE_VARS[name].label,
}));

const CONDITION_MODES = [
  { value: "set", label: "is set / true" },
  { value: "empty", label: "is empty / false" },
  { value: "equals", label: "equals…" },
  { value: "notEquals", label: "does not equal…" },
] as const;
type ConditionMode = (typeof CONDITION_MODES)[number]["value"];

const modeOf = (v: VisibleIf): ConditionMode =>
  v.equals !== undefined ? (v.exists === false ? "notEquals" : "equals") : v.exists === false ? "empty" : "set";

function buildCondition(token: MergeVarName, mode: ConditionMode, value: string): VisibleIf {
  switch (mode) {
    case "set":
      return { token };
    case "empty":
      return { token, exists: false };
    case "equals":
      return { token, equals: value };
    case "notEquals":
      return { token, equals: value, exists: false };
  }
}

function VisibilityPanel({
  scope,
  value,
  onChange,
  locked,
  extraWarning,
}: {
  scope: Exclude<Scope, "theme">;
  value: VisibleIf | undefined;
  onChange: (next: VisibleIf | undefined) => void;
  /** Le footer légal n'accepte AUCUNE condition (D10) : le panneau ne fait que l'expliquer. */
  locked?: boolean;
  extraWarning?: string;
}) {
  const label = SCOPE_LABEL[scope].toLowerCase();

  if (locked) {
    return (
      <div className="rounded-[10px] border border-border bg-accent/40 p-3 text-[12px] leading-relaxed text-muted-foreground">
        <Lock className="mb-1.5 h-3.5 w-3.5" strokeWidth={2} />
        The legal footer reaches every recipient, always. A conditional footer means someone receives an email with no
        way to unsubscribe — the schema refuses it, and so does publishing.
      </div>
    );
  }

  const mode = value ? modeOf(value) : "set";
  const token: MergeVarName = value?.token ?? "is_premium";
  const equals = value?.equals ?? "";

  return (
    <>
      <Note>
        Conditions are resolved PER RECIPIENT at send time. The published HTML carries every variant and the worker
        strips what does not apply — so a condition changes nothing in the preview.
      </Note>

      {extraWarning && <Note tone="warn">{extraWarning}</Note>}

      <CheckboxInput
        label="Condition"
        text={`Show this ${label} only if…`}
        checked={value !== undefined}
        onChange={(on) => onChange(on ? { token } : undefined)}
      />

      {value !== undefined && (
        <>
          <SelectInput<MergeVarName>
            label="Recipient field"
            value={token}
            options={CONDITION_OPTIONS}
            onChange={(v) => onChange(buildCondition(v, mode, equals))}
            hint="Closed list: an unknown field would hide the content for everyone, silently."
          />
          <SelectInput
            label="Test"
            value={mode}
            options={CONDITION_MODES}
            onChange={(v) => onChange(buildCondition(token, v, equals))}
          />
          {(mode === "equals" || mode === "notEquals") && (
            <TextInput
              label="Value"
              value={equals}
              maxLength={120}
              // `" < >` casseraient le marqueur HTML `<!--nf:if …-->` : le schéma les refuse, on
              // les retire à la saisie plutôt que de laisser fabriquer un document insauvegardable.
              onChange={(v) => onChange(buildCondition(token, mode, v.replace(/["<>]/g, "")))}
              placeholder="BR"
              hint={'Case- and space-insensitive ("BR" matches "br"). Quotes and angle brackets are not allowed.'}
              warning={
                equals.trim() === ""
                  ? "Empty value: a recipient with no value for this field would match, since missing data compares as an empty string."
                  : undefined
              }
            />
          )}
          {scope === "column" && (
            <Note tone="warn">
              A dropped column does not give its width back: the surviving columns keep theirs, so a 1-1 row renders at
              half width for the recipients who lose one.
            </Note>
          )}
        </>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Barre de portée
 * ------------------------------------------------------------------ */

function ScopeBar({
  scopes,
  value,
  onChange,
}: {
  scopes: { id: Scope; enabled: boolean; reason?: string }[];
  value: Scope;
  onChange: (s: Scope) => void;
}) {
  return (
    <div className="mb-3 flex rounded-[9px] border border-border bg-accent/30 p-0.5" role="group" aria-label="Scope">
      {scopes.map((s) => (
        <button
          key={s.id}
          type="button"
          disabled={!s.enabled}
          aria-pressed={value === s.id}
          title={s.enabled ? `Edit the ${SCOPE_LABEL[s.id].toLowerCase()} level` : s.reason}
          onClick={() => onChange(s.id)}
          className={cn(
            "flex-1 rounded-[7px] px-1 py-1 text-[11px] font-semibold transition-colors",
            !s.enabled
              ? "cursor-not-allowed text-muted-foreground/40"
              : value === s.id
                ? "bg-card text-foreground shadow-[0_1px_2px_rgba(20,20,30,0.10)]"
                : "text-muted-foreground hover:text-foreground",
          )}
        >
          {SCOPE_LABEL[s.id]}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Inspecteur
 * ------------------------------------------------------------------ */

export function Inspector({
  doc,
  selection,
  dispatch,
}: {
  doc: EmailDoc;
  selection: Selection;
  dispatch: React.Dispatch<BuilderAction>;
}) {
  const [tab, setTab] = useState<Tab>("content");
  const [scopePref, setScopePref] = useState<Scope>("block");
  const [colPref, setColPref] = useState(0);

  const blockLoc = selection?.kind === "block" ? findBlock(doc, selection.id) : null;
  const block: Block | null = blockLoc?.block ?? null;
  const rowLoc =
    selection?.kind === "row"
      ? findRow(doc, selection.id)
      : blockLoc
        ? { index: blockLoc.rowIndex, row: doc.rows[blockLoc.rowIndex] }
        : null;
  const row: Row | null = rowLoc?.row ?? null;

  // La colonne suit le bloc sélectionné ; sans bloc, l'utilisateur choisit laquelle il édite.
  const colIndex = blockLoc ? blockLoc.colIndex : row ? Math.min(colPref, row.columns.length - 1) : 0;
  const column: Column | null = row?.columns[colIndex] ?? null;

  const title = block ? blockLabel(block.type) : row ? `Row ${row.layout}` : "Nothing selected · Email styles";

  /* ---- écriture ---- */

  const setTheme = (next: Theme) => dispatch({ type: "setDoc", doc: { ...doc, theme: next } });

  /** Pas d'action `updateColumn` dans le reducer : on remplace le document, l'historique suit. */
  const patchColumn = (patch: Partial<Omit<Column, "id" | "blocks">>) => {
    if (!row || !column) return;
    dispatch({
      type: "setDoc",
      doc: {
        ...doc,
        rows: doc.rows.map((r) =>
          r.id !== row.id ? r : { ...r, columns: r.columns.map((c, i) => (i === colIndex ? { ...c, ...patch } : c)) },
        ),
      },
    });
  };

  const patchRow = (patch: Partial<Omit<Row, "id" | "columns">>) => {
    if (!row) return;
    dispatch({ type: "updateRow", rowId: row.id, patch });
  };

  const patchBlock = (patch: Record<string, unknown>) => {
    if (!block) return;
    dispatch({ type: "updateBlock", blockId: block.id, patch: patch as never });
  };

  /* ---- portées disponibles ---- */

  const scopes: { id: Scope; enabled: boolean; reason?: string }[] = [
    { id: "theme", enabled: true },
    { id: "row", enabled: row !== null, reason: "Select a row or a block first" },
    { id: "column", enabled: column !== null, reason: "Select a row or a block first" },
    { id: "block", enabled: block !== null, reason: "Select a block first" },
  ];
  const enabled = new Set(scopes.filter((s) => s.enabled).map((s) => s.id));
  const scope: Scope = enabled.has(scopePref)
    ? scopePref
    : enabled.has("block")
      ? "block"
      : enabled.has("row")
        ? "row"
        : "theme";

  // Le style du footer légal n'est jamais lu par le compilateur : ne pas l'offrir à l'édition.
  const lockedBlock = block?.type === "footer_legal";
  const blockStyle = block && block.type !== "footer_legal" ? block.style : undefined;

  const rowParents: Layer[] = [];
  const columnParents: Layer[] = [{ label: "Row", style: row?.style }];
  const blockParents: Layer[] = [
    { label: "Row", style: row?.style },
    { label: "Column", style: column?.style },
  ];

  const parentsOf = (s: Exclude<Scope, "theme">): Layer[] =>
    s === "row" ? rowParents : s === "column" ? columnParents : blockParents;

  const styleOf = (s: Exclude<Scope, "theme">): BoxStyle | undefined =>
    s === "row" ? row?.style : s === "column" ? column?.style : blockStyle;

  const setStyleOf = (s: Exclude<Scope, "theme">, next: BoxStyle | undefined) => {
    if (s === "row") patchRow({ style: next });
    else if (s === "column") patchColumn({ style: next });
    else patchBlock({ style: next });
  };

  const defaultPaddingOf = (s: Exclude<Scope, "theme">): Spacing =>
    s === "row" ? doc.theme.rowPadding : s === "column" ? ZERO_PAD : doc.theme.blockPadding;

  /** Padding desktop réellement appliqué au bloc — référence des surcharges mobiles. */
  const blockDesktopPadding: Spacing = {
    top: blockStyle?.padding?.top ?? doc.theme.blockPadding.top ?? 0,
    right: blockStyle?.padding?.right ?? doc.theme.blockPadding.right ?? 0,
    bottom: blockStyle?.padding?.bottom ?? doc.theme.blockPadding.bottom ?? 0,
    left: blockStyle?.padding?.left ?? doc.theme.blockPadding.left ?? 0,
  };

  /**
   * Où une famille de police peut être nommée : les styles de chaque row, colonne et bloc (looks de
   * flux compris) et la pile du thème. `mj-font` ne charge une feuille QUE si sa famille apparaît
   * dans une `font-family` du document — c'est ce que `WebFontsEditor` vérifie pour prévenir.
   */
  // `headingFont` (24/09/2026) nomme une famille dans les titres compilés : elle compte comme un usage.
  const fontUsage = JSON.stringify(doc.rows) + doc.theme.fontFamily + (doc.theme.headingFont ?? "");

  /**
   * ⛔ LE STYLE DU BLOC N'ATTEINT PAS UNE CARTE QUI A LE SIEN. Au dépliage, `look.style ?? feed.style`
   * REMPLACE le style du flux au lieu de s'y fondre : régler ici un fond ou une police ne changeait
   * rien à la une dès que son look portait une boîte. On le dit à l'endroit où l'on règle.
   */
  const feedOwnStyles =
    block?.type === "article-feed"
      ? [
          ...((block.leadCount ?? 0) >= 1 && block.lead?.style !== undefined
            ? [(block.leadCount ?? 0) > 1 ? "the lead cards" : "the lead card"]
            : []),
          ...(block.card?.style !== undefined ? [(block.leadCount ?? 0) >= 1 ? "the other cards" : "the cards"] : []),
        ]
      : [];
  const feedStyleNote =
    feedOwnStyles.length > 0 ? (
      <Note tone="warn">
        This style does not reach {feedOwnStyles.join(" or ")}: {feedOwnStyles.length > 1 ? "they have" : "it has"} a
        box of {feedOwnStyles.length > 1 ? "their" : "its"} own, set under Content → Card looks.
      </Note>
    ) : null;

  /* ---- contenu conditionnel ---- */

  // Le thème n'a pas de condition : depuis la portée Brand, on retombe sur l'élément sélectionné.
  const visibleScope: Exclude<Scope, "theme"> =
    scope === "theme" ? (block ? "block" : "row") : (scope as Exclude<Scope, "theme">);

  const conditionOf = (s: Exclude<Scope, "theme">): VisibleIf | undefined =>
    s === "row"
      ? row?.visibleIf
      : s === "column"
        ? column?.visibleIf
        : block !== null && block.type !== "footer_legal"
          ? block.visibleIf
          : undefined;

  const setConditionOf = (s: Exclude<Scope, "theme">, next: VisibleIf | undefined) => {
    if (s === "row") patchRow({ visibleIf: next });
    else if (s === "column") patchColumn({ visibleIf: next });
    else patchBlock({ visibleIf: next });
  };

  const tabs: { id: Tab; label: string }[] = [
    { id: "content", label: "Content" },
    { id: "style", label: "Style" },
    { id: "mobile", label: "Mobile" },
    { id: "visibility", label: "Rules" },
    { id: "settings", label: "Settings" },
  ];

  /** Sélecteur de colonne — la sélection du canvas ne descend pas jusqu'à la colonne. */
  const columnPicker =
    row && row.columns.length > 1 ? (
      <Field label="Column">
        <div className="inline-flex rounded-lg border border-border bg-card p-0.5">
          {row.columns.map((c, i) => (
            <button
              key={c.id}
              type="button"
              aria-pressed={i === colIndex}
              disabled={blockLoc !== null}
              title={blockLoc ? "Select the row itself to reach another column" : `Column ${i + 1}`}
              onClick={() => setColPref(i)}
              className={cn(
                "rounded-[6px] px-2.5 py-1 text-[11.5px] font-medium transition-colors",
                blockLoc !== null && i !== colIndex
                  ? "cursor-not-allowed text-muted-foreground/40"
                  : i === colIndex
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:text-foreground",
              )}
            >
              {i + 1}
            </button>
          ))}
        </div>
      </Field>
    ) : null;

  return (
    <aside
      className="flex w-full flex-col rounded-[14px] border border-border bg-card lg:w-[302px] lg:shrink-0"
      aria-label="Inspector"
    >
      <div className="border-b border-border px-3 py-2.5">
        <div className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground/70">
          Selection
        </div>
        <div className="text-[13px] font-semibold">{title}</div>
      </div>

      <div role="tablist" aria-label="Inspector sections" className="flex border-b border-border">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "flex-1 border-b-2 px-1 py-2 text-[11.5px] font-medium transition-colors",
              tab === t.id
                ? "border-brand text-brand"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tab === "content" &&
          (block ? (
            <BlockContent
              block={block}
              locale={doc.meta.locale}
              theme={doc.theme}
              parents={blockParents}
              dispatch={dispatch}
              defaultCtaLabel={doc.meta.defaultCtaLabel}
            />
          ) : row ? (
            <Hint>
              Row selected. Use <strong>Style</strong> and <strong>Mobile</strong> for its look, <strong>Rules</strong>{" "}
              to show it to part of the list only, or pick a block inside it to edit content. Column count is fixed by
              the row layout ({row.layout}).
            </Hint>
          ) : (
            // Rien de sélectionné (clic dans le vide, bouton « Styles ») : les styles de l'e-mail entier.
            <EmailStylesPanel theme={doc.theme} usedIn={fontUsage} onChange={setTheme} />
          ))}

        {tab === "style" && (
          <>
            <ScopeBar scopes={scopes} value={scope} onChange={setScopePref} />
            {scope === "column" && columnPicker}
            {scope === "theme" ? (
              <EmailStylesPanel theme={doc.theme} usedIn={fontUsage} onChange={setTheme} />
            ) : lockedBlock && scope === "block" ? (
              <Hint>The legal footer is rendered by the compliance kit and takes no styling.</Hint>
            ) : (
              <>
                {scope === "block" && feedStyleNote}
                {scope === "block" ? (
                  <BlockCustomStyle
                    style={blockStyle}
                    theme={doc.theme}
                    parents={blockParents}
                    onChange={(next) => setStyleOf("block", next)}
                    titre={estBlocTitre(block)}
                    onUseForAllTitles={(color) => dispatch({ type: "useForAllTitles", color })}
                  />
                ) : (
                  <StylePanel
                    scope={scope}
                    theme={doc.theme}
                    style={styleOf(scope)}
                    parents={parentsOf(scope)}
                    defaultPadding={defaultPaddingOf(scope)}
                    onChange={(next) => setStyleOf(scope, next)}
                  />
                )}
              </>
            )}
          </>
        )}

        {tab === "mobile" && (
          <>
            <ScopeBar scopes={scopes} value={scope} onChange={setScopePref} />
            {scope === "column" && columnPicker}
            {scope === "theme" ? (
              <Note>
                The theme carries no mobile values: responsive overrides live on a row, a column or a block. Pick one of
                those scopes above.
              </Note>
            ) : lockedBlock && scope === "block" ? (
              <Hint>The legal footer follows the compliance kit and takes no mobile overrides.</Hint>
            ) : (
              <>
                {scope === "block" && feedStyleNote}
                <MobilePanel
                  scope={scope}
                  style={styleOf(scope)}
                  parents={parentsOf(scope)}
                  desktopPadding={blockDesktopPadding}
                  onChange={(next) => setStyleOf(scope, next)}
                  breakpoint={doc.theme.mobileBreakpoint}
                />
              </>
            )}
          </>
        )}

        {tab === "visibility" &&
          (row === null ? (
            <Hint>Select a row or a block to make it conditional.</Hint>
          ) : (
            <>
              <ScopeBar scopes={scopes.filter((s) => s.id !== "theme")} value={visibleScope} onChange={setScopePref} />
              {visibleScope === "column" && columnPicker}
              <VisibilityPanel
                scope={visibleScope}
                value={conditionOf(visibleScope)}
                locked={visibleScope === "block" && lockedBlock}
                extraWarning={
                  visibleScope !== "block" && rowHasLockedBlock(row)
                    ? "This row holds the legal footer. A condition here is refused at publish time — the footer must reach everyone."
                    : undefined
                }
                onChange={(next) => setConditionOf(visibleScope, next)}
              />
            </>
          ))}

        {tab === "settings" && <DocumentSettings doc={doc} dispatch={dispatch} />}
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ *
 * Réglages du document
 * ------------------------------------------------------------------ */

function DocumentSettings({ doc, dispatch }: { doc: EmailDoc; dispatch: React.Dispatch<BuilderAction> }) {
  const subjectRef = useRef<HTMLInputElement>(null);
  const preheaderRef = useRef<HTMLInputElement>(null);

  /** Insère un token à la position du curseur d'un des deux champs (ou à la fin s'il n'a pas le focus). */
  function insertInto(field: "subject" | "preheader", token: string) {
    const el = field === "subject" ? subjectRef.current : preheaderRef.current;
    const current = field === "subject" ? doc.meta.subject : doc.meta.preheader;
    const start = el && document.activeElement === el ? el.selectionStart ?? current.length : current.length;
    const end = el && document.activeElement === el ? el.selectionEnd ?? current.length : current.length;
    const next = (current.slice(0, start) + token + current.slice(end)).slice(0, 200);
    dispatch({ type: "updateMeta", patch: { [field]: next } });
    const pos = Math.min(start + token.length, next.length);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  }

  return (
    <>
      <SectionTitle>Email</SectionTitle>
      <TextInput
        label="Subject line"
        value={doc.meta.subject}
        maxLength={200}
        inputRef={subjectRef}
        onChange={(v) => dispatch({ type: "updateMeta", patch: { subject: v } })}
        right={<MergeTagMenu onInsert={(t) => insertInto("subject", t)} />}
        warning={doc.meta.subject.trim() === "" ? "A subject is required before this template can be published." : undefined}
        hint={`${doc.meta.subject.length}/200 characters. Merge tags are resolved per recipient at send time.`}
      />
      <TextInput
        label="Preheader"
        value={doc.meta.preheader}
        maxLength={200}
        inputRef={preheaderRef}
        onChange={(v) => dispatch({ type: "updateMeta", patch: { preheader: v } })}
        right={<MergeTagMenu onInsert={(t) => insertInto("preheader", t)} />}
        hint="The preview text shown next to the subject in the inbox. Left empty, clients show the first words of the email."
      />
      {/* L'onglet du navigateur et la version texte : l'abonné les reçoit, le canvas ne les montre pas. */}
      <DocumentOutputFields meta={doc.meta} onPatch={(p) => dispatch({ type: "updateMeta", patch: p })} />

      {/* ⛔ LA LANGUE ÉTAIT AFFICHÉE EN LECTURE SEULE alors qu'elle décide de ce que le lecteur
          reçoit : le libellé par défaut du lien de lecture, l'attribut `lang` et la langue de
          l'intro rédigée par l'IA. Un modèle créé dans la mauvaise langue devait être refait. */}
      <SectionTitle>Language</SectionTitle>
      <LocaleField
        value={doc.meta.locale}
        ctaOverride={doc.meta.defaultCtaLabel}
        onChange={(v) => dispatch({ type: "updateMeta", patch: { locale: v } })}
      />
      {/* Ce que la langue décide par défaut — sens d'écriture, libellé de lecture, repli du prénom —
          et qu'un modèle peut remplacer sans changer de langue. */}
      <LanguageDefaultsFields meta={doc.meta} onPatch={(p) => dispatch({ type: "updateMeta", patch: p })} />

      {/* ⛔ L'EN-TÊTE ET LE PIED DE MARQUE ÉTAIENT TIRÉS À LA COMPILATION SANS QUE RIEN NE LE MONTRE :
          `headerPartialId` / `footerPartialId` n'avaient aucun champ, donc aucun moyen de savoir d'où
          sortaient ces rangées, ni de les changer ou de les retirer. */}
      <SectionTitle>Brand header &amp; footer</SectionTitle>
      <BrandPartialsField
        headerId={doc.meta.headerPartialId}
        footerId={doc.meta.footerPartialId}
        onHeader={(id) => dispatch({ type: "updateMeta", patch: { headerPartialId: id } })}
        onFooter={(id) => dispatch({ type: "updateMeta", patch: { footerPartialId: id } })}
      />

      <SectionTitle>Scope</SectionTitle>
      <div className="space-y-1.5 rounded-[10px] border border-border p-2.5 text-[12px]">
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">Brand</span>
          <span className="font-medium">{doc.meta.assetSlug}</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">Content width</span>
          <span className="font-medium">{doc.theme.contentWidth}px</span>
        </div>
      </div>
      <p className="mt-2 text-[11px] leading-snug text-muted-foreground/70">
        The brand is set when the template is created and is not editable here. The theme is — under
        <strong> Style → Brand</strong> — but it belongs to this template only: it does not write back to the brand
        style kit.
      </p>
      <BrandSettingsLink assetSlug={doc.meta.assetSlug} />

      <SectionTitle>Document</SectionTitle>
      <div className="space-y-1.5 rounded-[10px] border border-border p-2.5 text-[12px]">
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">Rows</span>
          <span className="font-medium tabular-nums">{doc.rows.length}</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">Blocks</span>
          <span className="font-medium tabular-nums">
            {doc.rows.reduce((n, r) => n + r.columns.reduce((m, c) => m + c.blocks.length, 0), 0)}
          </span>
        </div>
      </div>
    </>
  );
}
