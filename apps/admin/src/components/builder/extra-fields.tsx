"use client";

/**
 * Éditeurs d'appoint de l'inspecteur : ce que le compilateur lisait et qu'aucun champ n'écrivait.
 *
 * Inventaire du 22/09/2026 (`tasks/inventaire-builder-editable-2026-09-22.md`) : l'icône et le
 * libellé d'un lien social (TikTok, Telegram et WhatsApp partaient en globe), la barre multicolore
 * d'un séparateur, les polices web du thème, la langue du document, et l'en-tête / le pied de marque
 * qu'un modèle tire à la compilation sans que rien ne le montre.
 *
 * Lot du 22/09/2026 au soir : les réglages que le compilateur DÉCIDAIT SEUL (manifeste
 * `NEW_PROPS_2026_09_22` de `@nf/render`) — le bouton des cartes, l'apparence du bouton, du menu et
 * des liens sociaux, la langue et la version texte du document. Chaque champ tire son indication, ses
 * bornes et son défaut du manifeste (`propSpec`), jamais d'une copie tapée ici.
 *
 * ⛔ CHAQUE ÉCRITURE NOMME SA CLÉ EN CLAIR — le garde de couverture (`inspector-coverage.test.ts`)
 * lit ce fichier.
 *
 * ⚠️ AUCUN HOOK, sauf dans `BrandPartialsField` (il lit la bibliothèque de la marque) : les bancs
 * appellent les autres comme des fonctions pour déclencher le `onChange` réel de chaque contrôle.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { ExternalLink, Plus, Trash2 } from "lucide-react";
import {
  DividerBlock,
  Meta,
  SOCIAL_PLATFORMS,
  SocialBlock,
  Theme,
  type Block,
  type SocialItem,
  type SocialPlatform,
  type Spacing,
} from "@nf/render/schema";
import { defaultArticleCta } from "@nf/render/cta";
import { defaultFirstName } from "@nf/render/hydrate";
import {
  DATE_STYLES,
  DATE_STYLE_LABELS,
  DEFAULT_DATE_FORMATS,
  formatDateStyle,
  type DateStyle,
} from "@nf/email/dates";
import { normalizeLocale } from "@nf/email/i18n";
import { fetchPartials, type PartialEntry } from "@/components/templates/library-client";
import {
  CheckboxInput,
  ColorInput,
  NumberInput,
  SectionTitle,
  SelectInput,
  SpacingInput,
  TextInput,
  prune,
} from "./fields";
import { ChoiceInput, Group, MiniBtn, Note, WEIGHT_LABELS, openGroup, overrides } from "./inspector-ui";
import {
  boundsOf,
  clampTo,
  elementObjectAt,
  lengthOf,
  literalDefault,
  numberField,
  propSpec,
  specBounds,
} from "./schema-bounds";

/* ------------------------------------------------------------------ *
 * Liens sociaux
 * ------------------------------------------------------------------ */

const SOCIAL_ITEM = elementObjectAt(SocialBlock, "items");
const SOCIAL_ITEMS = lengthOf(SocialBlock, "items");
const SOCIAL_LABEL_MAX = lengthOf(SOCIAL_ITEM, "label").max;

/**
 * Le nom du réseau dans l'en-tête d'un lien replié. `Record` sur l'énumération du schéma : un réseau
 * ajouté à `SOCIAL_PLATFORMS` sans nom ici ne compile pas.
 */
const NETWORK_NAMES: Record<SocialPlatform, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  twitter: "Twitter / X",
  youtube: "YouTube",
  linkedin: "LinkedIn",
  tiktok: "TikTok",
  telegram: "Telegram",
  whatsapp: "WhatsApp",
  web: "Website",
};

/** Le lien que « Add link » pose : une adresse d'EXEMPLE, que l'en-tête signale tant qu'elle reste. */
const NEW_SOCIAL_LINK: SocialItem = { platform: "web", href: "https://example.com" };

/** Les réglages facultatifs d'un lien, comptés par le résumé de sa carte (« defaults » = icône du jeu, sans libellé). */
const SOCIAL_LINK_OPTIONS = ["iconSrc", "label"] as const;

/** L'`id` de mémoire de la carte du lien n° `i` (base 0) — le même pour la carte et pour « Add link ». */
const socialLinkId = (i: number): string => `social.link.${i}`;

export function SocialItemsEditor({
  items,
  onChange,
}: {
  items: SocialItem[];
  onChange: (items: SocialItem[]) => void;
}) {
  // ⚠️ La liste est réécrite EN ENTIER : `updateBlock` fusionne au premier niveau seulement.
  const setItem = (i: number, next: Partial<SocialItem>) =>
    onChange(items.map((it, j) => (j === i ? (prune({ ...it, ...next }) as SocialItem) : it)));

  return (
    <>
      <SectionTitle>Links</SectionTitle>
      {/* Un lien = une carte REPLIÉE (≈ 405 px dépliée) : l'en-tête dit le réseau et si la vraie
          adresse est posée ; le résumé compte l'icône et le libellé propres.
          ⛔ `id` PAR INDEX : un id littéral ouvrirait tous les liens ensemble, et un id par réseau
          ferait partager leur état à deux liens Facebook — puis refermerait une carte ouverte dès
          qu'on y change « Platform » (autre id, rien de mémorisé).
          ⛔ FERMÉE PAR DÉFAUT, SANS CONDITION : un `defaultOpen` tiré de l'adresse refermerait la carte
          au milieu de la frappe (`Group` le relit à chaque rendu tant que rien n'est mémorisé). */}
      {items.map((item, i) => {
        const urlSet = item.href.trim() !== "" && item.href !== NEW_SOCIAL_LINK.href;
        return (
          <Group
            key={i}
            id={socialLinkId(i)}
            title={`${NETWORK_NAMES[item.platform]} · ${urlSet ? "URL set" : "needs a URL"}`}
            summary={overrides(item, SOCIAL_LINK_OPTIONS)}
          >
            <SelectInput
              label="Platform"
              value={item.platform}
              options={SOCIAL_PLATFORMS}
              onChange={(v) => setItem(i, { platform: v })}
            />
            <TextInput label="URL" value={item.href} onChange={(v) => setItem(i, { href: v })} />
            <TextInput
              label="Icon image (optional)"
              value={item.iconSrc ?? ""}
              onChange={(v) => setItem(i, { iconSrc: v.trim() === "" ? undefined : v })}
              placeholder="https://cdn.example.com/icons/tiktok.png"
              hint="Replaces the built-in icon. TikTok, Telegram and WhatsApp have none: without an image here they are drawn as a globe."
              warning={item.iconSrc !== undefined && /^http:\/\//i.test(item.iconSrc) ? "Served over http:// — many clients block it." : undefined}
            />
            <TextInput
              label="Label (optional)"
              value={item.label ?? ""}
              maxLength={SOCIAL_LABEL_MAX}
              onChange={(v) => setItem(i, { label: v.trim() === "" ? undefined : v })}
              hint="Text next to the icon. Empty = the icon alone."
            />
            <div className="mb-2 flex justify-end">
              <MiniBtn
                label={`Remove social link ${i + 1}`}
                danger
                disabled={items.length <= SOCIAL_ITEMS.min}
                onClick={() => onChange(items.filter((_, j) => j !== i))}
              >
                <Trash2 className="h-3 w-3" strokeWidth={2.2} /> Remove
              </MiniBtn>
            </div>
          </Group>
        );
      })}
      <MiniBtn
        label="Add social link"
        disabled={items.length >= SOCIAL_ITEMS.max}
        // La carte ajoutée s'ouvre par le GESTE, sous l'id de l'index qu'elle va occuper ; les autres
        // gardent leur état.
        onClick={() => {
          openGroup(socialLinkId(items.length));
          onChange([...items, { ...NEW_SOCIAL_LINK }]);
        }}
      >
        <Plus className="h-3 w-3" strokeWidth={2.2} /> Add link
      </MiniBtn>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Séparateur multicolore
 * ------------------------------------------------------------------ */

const SEGMENT = elementObjectAt(DividerBlock, "segments");
const SEGMENTS = lengthOf(DividerBlock, "segments");
const SEGMENT_WIDTH = boundsOf(SEGMENT, "widthPct");

type Segment = NonNullable<DividerBlock["segments"]>[number];

export function DividerSegmentsEditor({
  segments,
  fallbackColor,
  accentColor,
  onChange,
}: {
  segments: Segment[] | undefined;
  /** Couleur du filet uni — la première tranche en part, pour que l'allumage ne change rien d'un coup. */
  fallbackColor: string;
  /** Couleur de marque, proposée pour les tranches suivantes. */
  accentColor: string;
  onChange: (next: Segment[] | undefined) => void;
}) {
  const list = segments ?? [];
  const setSegment = (i: number, next: Partial<Segment>) =>
    onChange(list.map((s, j) => (j === i ? { ...s, ...next } : s)));
  const total = list.reduce((n, s) => n + s.widthPct, 0);
  const even = (n: number) => Math.max(SEGMENT_WIDTH.min, Math.floor(100 / n));

  return (
    <>
      {/* Résumé `overrides(segments)` : sans liste de clés, il compte les éléments posés — « 3 set » =
          trois tranches ; absent = « defaults », le filet uni. */}
      <Group id="divider.segments" title="Multicolour bar" summary={overrides(segments)}>
        <CheckboxInput
          label="Segments"
          text="Split the line into coloured segments"
          checked={segments !== undefined}
          onChange={(on) =>
            onChange(
              on
                ? Array.from({ length: SEGMENTS.min }, (_, k) => ({
                    color: k === 0 ? fallbackColor : accentColor,
                    widthPct: even(SEGMENTS.min),
                  }))
                : undefined,
            )
          }
          hint={`A brand flag: ${SEGMENTS.min} to ${SEGMENTS.max} blocks of colour side by side, as thick as the line. The bar spans the whole block — the width and colour above are not used while it is on.`}
        />
        {segments !== undefined && (
          <>
            {list.map((seg, i) => (
              <div key={i} className="mb-3 rounded-[10px] border border-border p-2.5">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-[11px] font-semibold text-muted-foreground">Segment {i + 1}</span>
                  <MiniBtn
                    label={`Remove segment ${i + 1}`}
                    danger
                    disabled={list.length <= SEGMENTS.min}
                    onClick={() => onChange(list.filter((_, j) => j !== i))}
                  >
                    <Trash2 className="h-3 w-3" strokeWidth={2.2} />
                  </MiniBtn>
                </div>
                {/* Une tranche a TOUJOURS une couleur (le schéma l'exige) : vider le champ la ramène à la
                    couleur du filet uni plutôt que de fabriquer un document insauvegardable. */}
                <ColorInput
                  label={`Segment ${i + 1} colour`}
                  value={seg.color}
                  onChange={(v) => setSegment(i, { color: v ?? fallbackColor })}
                />
                <NumberInput
                  label={`Segment ${i + 1} width`}
                  value={seg.widthPct}
                  min={SEGMENT_WIDTH.min}
                  max={SEGMENT_WIDTH.max}
                  suffix="%"
                  onChange={(v) => setSegment(i, { widthPct: clampTo(SEGMENT_WIDTH, v) ?? seg.widthPct })}
                />
              </div>
            ))}
            <MiniBtn
              label="Add a segment"
              disabled={list.length >= SEGMENTS.max}
              onClick={() => onChange([...list, { color: accentColor, widthPct: even(list.length + 1) }])}
            >
              <Plus className="h-3 w-3" strokeWidth={2.2} /> Add a segment
            </MiniBtn>
          </>
        )}
      </Group>
      {/* ⛔ L'AVERTISSEMENT RESTE HORS DU GROUPE : replié, il cacherait une barre que l'abonné reçoit
          trop courte ou rognée. */}
      {segments !== undefined && total !== 100 && (
        <Note tone="warn">
          The segments add up to {total}% of the width — the bar is drawn{" "}
          {total < 100 ? "shorter than the block" : "wider than the block, and some clients crop it"}.
        </Note>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Polices web du thème
 * ------------------------------------------------------------------ */

const WEB_FONT = elementObjectAt(Theme, "webFonts");
const WEB_FONTS = lengthOf(Theme, "webFonts");
const FAMILY_MAX = lengthOf(WEB_FONT, "family").max;
const HREF_MAX = lengthOf(WEB_FONT, "href").max;

type WebFont = Theme["webFonts"][number];

/** Exemple posé à l'ajout : une vraie feuille, sans effet tant qu'aucune police ne la nomme. */
export const NEW_WEB_FONT: WebFont = {
  family: "Roboto",
  href: "https://fonts.googleapis.com/css2?family=Roboto:wght@400;700&display=swap",
};

export function WebFontsEditor({
  fonts,
  usedIn,
  onChange,
}: {
  fonts: WebFont[];
  /** Tout le texte où une police peut être nommée — sert à dire qu'une police ne sera pas chargée. */
  usedIn: string;
  onChange: (next: WebFont[]) => void;
}) {
  const setFont = (i: number, next: Partial<WebFont>) =>
    onChange(fonts.map((f, j) => (j === i ? { ...f, ...next } : f)));

  return (
    <>
      <SectionTitle>Web fonts</SectionTitle>
      <Note>
        Brand fonts loaded in the email head. Apple Mail, iOS Mail and some webmails use them; Gmail and Outlook desktop
        ignore them and use the rest of the font stack — which is why every font setting must end with a system font.
      </Note>
      {fonts.map((font, i) => (
        <div key={i} className="mb-3 rounded-[10px] border border-border p-2.5">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[11px] font-semibold text-muted-foreground">Font {i + 1}</span>
            <MiniBtn label={`Remove web font ${i + 1}`} danger onClick={() => onChange(fonts.filter((_, j) => j !== i))}>
              <Trash2 className="h-3 w-3" strokeWidth={2.2} />
            </MiniBtn>
          </div>
          <TextInput
            label={`Font ${i + 1} family`}
            value={font.family}
            maxLength={FAMILY_MAX}
            onChange={(v) => setFont(i, { family: v })}
            hint="The name exactly as the stylesheet declares it."
            warning={
              font.family.trim() === ""
                ? "Required — the template cannot be saved while this is empty."
                : !usedIn.includes(font.family)
                  // ⛔ PIÈGE MJML mesuré (cf. `Theme.webFonts`) : le `<link>` n'est émis que si le nom
                  // exact figure dans une `font-family` du document. Sans cet avertissement, la police
                  // semble déclarée et ne part jamais.
                  ? `No font setting in this template names “${font.family}”, so it is not loaded — unless a brand header or footer uses it. Pick it in a font setting (exact spelling, capitals included).`
                  : undefined
            }
          />
          <TextInput
            label={`Font ${i + 1} stylesheet URL`}
            value={font.href}
            maxLength={HREF_MAX}
            onChange={(v) => setFont(i, { href: v })}
            placeholder="https://fonts.googleapis.com/css2?family=…"
            warning={
              font.href.trim() === ""
                ? "Required — the template cannot be saved while this is empty."
                : !/^https:\/\//i.test(font.href)
                  ? "Use an https:// stylesheet URL — email clients will not load anything else."
                  : undefined
            }
          />
        </div>
      ))}
      <MiniBtn
        label="Add a web font"
        disabled={fonts.length >= WEB_FONTS.max}
        onClick={() => onChange([...fonts, NEW_WEB_FONT])}
      >
        <Plus className="h-3 w-3" strokeWidth={2.2} /> Add a web font
      </MiniBtn>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Langue du document
 * ------------------------------------------------------------------ */

/**
 * Langues proposées. Une LISTE et pas un champ libre : la locale part dans `Intl` (aperçu, dates)
 * et dans `<html lang>` ; une frappe intermédiaire (« e », « es-C ») écrite au fil des touches
 * donnerait un document insauvegardable, puis un `RangeError` à l'aperçu. La valeur courante reste
 * toujours proposée, même absente de la liste.
 */
const LOCALE_CHOICES: readonly { value: string; label: string }[] = [
  { value: "en", label: "en — English" },
  { value: "en-GB", label: "en-GB — English (UK)" },
  { value: "en-US", label: "en-US — English (US)" },
  { value: "es", label: "es — Spanish" },
  { value: "es-AR", label: "es-AR — Spanish (Argentina)" },
  { value: "es-CL", label: "es-CL — Spanish (Chile)" },
  { value: "es-ES", label: "es-ES — Spanish (Spain)" },
  { value: "es-MX", label: "es-MX — Spanish (Mexico)" },
  { value: "pt", label: "pt — Portuguese" },
  { value: "pt-BR", label: "pt-BR — Portuguese (Brazil)" },
  { value: "pt-PT", label: "pt-PT — Portuguese (Portugal)" },
  { value: "fr", label: "fr — French" },
  { value: "de", label: "de — German" },
  { value: "it", label: "it — Italian" },
  { value: "sv", label: "sv — Swedish" },
];

/** Bornes de `Meta.locale` — lues dans le schéma. */
const LOCALE_LENGTH = lengthOf(Meta, "locale");

export function LocaleField({
  value,
  onChange,
  ctaOverride,
}: {
  value: string;
  onChange: (v: string) => void;
  /** `meta.defaultCtaLabel` : posé, c'est LUI que les cartes reçoivent, pas le libellé de la langue. */
  ctaOverride?: string;
}) {
  const options = LOCALE_CHOICES.some((c) => c.value === value)
    ? LOCALE_CHOICES
    : [{ value, label: `${value} — current` }, ...LOCALE_CHOICES];
  const overridden = ctaOverride !== undefined && ctaOverride.trim() !== "";
  return (
    <SelectInput
      label="Language"
      value={value}
      options={options.filter((o) => o.value.length >= LOCALE_LENGTH.min && o.value.length <= LOCALE_LENGTH.max)}
      onChange={(v) => onChange(v)}
      hint={`The language this email is written in. It sets the default read-link label (here “${defaultArticleCta(value)}”${overridden ? ", replaced by the label set below" : ""}), the language email clients and screen readers announce, and the language the AI intro is written in. The legal footer follows the brand edition’s language, set on the brand — not this field.`}
    />
  );
}

/* ------------------------------------------------------------------ *
 * En-tête et pied de marque
 * ------------------------------------------------------------------ */

/**
 * L'en-tête et le pied de MARQUE que le modèle tire à la compilation (`meta.headerPartialId` /
 * `footerPartialId`). Leurs rows ne sont PAS dans le document : elles sont résolues à chaque
 * compilation (`applyBrandPartials`), donc invisibles sur le canvas — ce champ est le seul endroit
 * de l'éditeur qui dit qu'elles partent.
 *
 * ⛔ UN POINTEUR QUI N'EST PLUS DANS LA LISTE RESTE AFFICHÉ, marqué. La résolution ne filtre pas les
 * partials archivés (cf. `resolveBrandPartials`) : le faire disparaître du menu ferait croire que
 * l'e-mail part sans en-tête alors qu'il part avec.
 */
export function BrandPartialsField({
  headerId,
  footerId,
  onHeader,
  onFooter,
}: {
  headerId: string | undefined;
  footerId: string | undefined;
  onHeader: (id: string | undefined) => void;
  onFooter: (id: string | undefined) => void;
}) {
  const [partials, setPartials] = useState<PartialEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchPartials()
      .then((list) => {
        if (!cancelled) setPartials(list);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const optionsFor = (slot: "header" | "footer", current: string | undefined) => {
    const list = (partials ?? []).filter((p) => p.slot === slot);
    const listed = current === undefined || list.some((p) => p.id === current);
    return [
      { value: "", label: "None" },
      ...list.map((p) => ({
        value: p.id,
        label: `${p.name || "Untitled"} — ${p.rows.length} row${p.rows.length > 1 ? "s" : ""}`,
      })),
      ...(listed ? [] : [{ value: current as string, label: "Not in this brand’s list (archived?) — still applied" }]),
    ];
  };

  return (
    <>
      {error !== null ? (
        // ⛔ Une lecture ratée n'est pas « aucun en-tête » : le menu vide inviterait à retirer un
        // pointeur qui fonctionne.
        <Note tone="warn">The brand headers and footers could not be read: {error}</Note>
      ) : partials === null ? (
        <Note>Loading this brand’s headers and footers…</Note>
      ) : (
        <>
          <SelectInput
            label="Brand header"
            value={headerId ?? ""}
            options={optionsFor("header", headerId)}
            onChange={(v) => onHeader(v === "" ? undefined : v)}
            hint="Its rows are added at the very top of the email each time it is built — they are not on the canvas, and editing the header updates every template that uses it."
          />
          <SelectInput
            label="Brand footer"
            value={footerId ?? ""}
            options={optionsFor("footer", footerId)}
            onChange={(v) => onFooter(v === "" ? undefined : v)}
            hint="Its rows are added just above the legal footer each time the email is built — never below it, and not on the canvas."
          />
        </>
      )}
      <Link
        href="/templates?tab=brand"
        target="_blank"
        className="mb-3 inline-flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground"
      >
        Edit headers &amp; footers <ExternalLink className="h-3 w-3" strokeWidth={2} />
      </Link>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Bouton des cartes — pick, promo, encart, article (forme `button`)
 * ------------------------------------------------------------------ */

type PickBlock = Extract<Block, { type: "pick" }>;
type Weight = NonNullable<PickBlock["ctaWeight"]>;

/**
 * Le jeu `cardButtonLook` du schéma : les mêmes six clés sur les quatre blocs qui le portent.
 * Un ALIAS et pas une interface : l'éditeur reçoit le `patch` générique de l'inspecteur
 * (`Record<string, unknown>`), auquel seul un alias de type est assignable.
 */
export type CardButtonValue = {
  ctaBackground?: string;
  ctaTextColor?: string;
  ctaSize?: number;
  ctaWeight?: Weight;
  ctaPadding?: Spacing;
  ctaRadius?: number;
};

/** Marges du bouton quand rien n'est posé — la forme courte « 12px 22px » de `ctaTable`. */
const CARD_BUTTON_PADDING: Spacing = { top: 12, right: 22, bottom: 12, left: 22 };

/**
 * Le bouton que le compilateur dessine sous une carte (`ctaTable`). UN seul éditeur pour les quatre
 * blocs qui le portent : ce sont les mêmes clés et le même rendu, et quatre copies auraient fini par
 * ne pas annoncer les mêmes défauts.
 *
 * Les défauts affichés sont ceux que `ctaTable` applique : couleur de marque, texte de bouton du
 * thème, max(13, taille du bloc − 2), graisse 700, 12/22 px, rayon du bloc (sinon du thème).
 */
export function CardButtonFields({
  target,
  value,
  onPatch,
  theme,
  fontSize,
  radius,
  withColours = true,
  withTypography = true,
}: {
  /** Entrée du manifeste qui porte l'indication : `pick`, `promo`, `callout`, `article`… */
  target: string;
  value: CardButtonValue;
  onPatch: (patch: Partial<CardButtonValue>) => void;
  theme: Theme;
  /** Taille de texte RÉSOLUE du bloc (thème → row → colonne → bloc). */
  fontSize: number;
  /** Rayon RÉSOLU du bloc — son style, sinon le thème — et d'où il vient. */
  radius: { value: number; from: string };
  /** `false` quand le bloc règle déjà ses couleurs de bouton ailleurs (l'encart). */
  withColours?: boolean;
  /** `false` quand taille et graisse valent pour une autre forme aussi (le lien de lecture d'article). */
  withTypography?: boolean;
}) {
  const spec = (key: keyof CardButtonValue) => propSpec(target, key);
  return (
    <>
      {withColours && (
        <>
          <ColorInput
            label="Button background"
            value={value.ctaBackground}
            inherited={theme.brandColor}
            inheritedFrom="the brand colour"
            onReset={value.ctaBackground === undefined ? undefined : () => onPatch({ ctaBackground: undefined })}
            onChange={(v) => onPatch({ ctaBackground: v })}
            hint={spec("ctaBackground").hint}
          />
          <ColorInput
            label="Button text colour"
            value={value.ctaTextColor}
            inherited={theme.buttonTextColor}
            inheritedFrom="the brand button text colour"
            onReset={value.ctaTextColor === undefined ? undefined : () => onPatch({ ctaTextColor: undefined })}
            onChange={(v) => onPatch({ ctaTextColor: v })}
            hint={spec("ctaTextColor").hint}
          />
        </>
      )}
      {withTypography && (
        <>
          <NumberInput
            label="Button text size"
            value={value.ctaSize}
            {...numberField(spec("ctaSize"))}
            suffix="px"
            inherited={String(Math.max(13, fontSize - 2))}
            inheritedFrom="the block font size minus 2 (at least 13)"
            onReset={value.ctaSize === undefined ? undefined : () => onPatch({ ctaSize: undefined })}
            onChange={(v) => onPatch({ ctaSize: clampTo(specBounds(spec("ctaSize")), v) })}
          />
          <ChoiceInput<Weight>
            label="Button text weight"
            value={value.ctaWeight}
            def={spec("ctaWeight").default as Weight}
            options={spec("ctaWeight").options as readonly Weight[]}
            labels={WEIGHT_LABELS}
            onChange={(v) => onPatch({ ctaWeight: v })}
            hint={spec("ctaWeight").hint}
          />
        </>
      )}
      <SpacingInput
        label="Button padding (px)"
        value={value.ctaPadding}
        defaults={CARD_BUTTON_PADDING}
        min={specBounds(spec("ctaPadding")).min}
        max={specBounds(spec("ctaPadding")).max}
        inheritedFrom="the button default"
        onChange={(next) => onPatch({ ctaPadding: next })}
        hint={spec("ctaPadding").hint}
      />
      <NumberInput
        label="Button corner radius"
        value={value.ctaRadius}
        {...numberField(spec("ctaRadius"))}
        suffix="px"
        inherited={String(radius.value)}
        inheritedFrom={radius.from}
        onReset={value.ctaRadius === undefined ? undefined : () => onPatch({ ctaRadius: undefined })}
        onChange={(v) => onPatch({ ctaRadius: clampTo(specBounds(spec("ctaRadius")), v) })}
      />
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Apparence du bouton, du menu et des liens sociaux
 * ------------------------------------------------------------------ */

/** La typographie résolue du bloc, telle que le compilateur la lit (`resolveLookBase`). */
interface Base {
  fontSize: number;
}

type ButtonBlock = Extract<Block, { type: "button" }>;
type MenuBlock = Extract<Block, { type: "menu" }>;
type SocialBlockT = Extract<Block, { type: "social" }>;

/** Marges du bouton seul quand rien n'est posé — celles du rendu d'avant (14/26 px). */
const BUTTON_PADDING: Spacing = { top: 14, right: 26, bottom: 14, left: 26 };

/**
 * Le bouton d'un bloc `button`. Des clés PROPRES (`buttonBackground`, `labelSize`…) et pas le style
 * du bloc : `style.backgroundColor` peint déjà le conteneur, et son `textColor` n'a jamais atteint le
 * libellé (cf. le schéma).
 */
export function ButtonLookFields({
  block,
  theme,
  base,
  patch,
}: {
  block: ButtonBlock;
  theme: Theme;
  base: Base;
  patch: (p: Partial<ButtonBlock>) => void;
}) {
  const spec = (path: string) => propSpec("button", path);
  const keys = ["buttonBackground", "buttonTextColor", "labelSize", "labelWeight", "innerPadding"];
  return (
    <Group id="button.look" title="Button look" summary={overrides(block, keys)}>
      <ColorInput
        label="Button background"
        value={block.buttonBackground}
        inherited={theme.brandColor}
        inheritedFrom="the brand colour"
        onReset={block.buttonBackground === undefined ? undefined : () => patch({ buttonBackground: undefined })}
        onChange={(v) => patch({ buttonBackground: v })}
        hint={`${spec("buttonBackground").hint} The Style tab background paints the space around the button, not the button.`}
      />
      <ColorInput
        label="Button text colour"
        value={block.buttonTextColor}
        inherited={theme.buttonTextColor}
        inheritedFrom="the brand button text colour"
        onReset={block.buttonTextColor === undefined ? undefined : () => patch({ buttonTextColor: undefined })}
        onChange={(v) => patch({ buttonTextColor: v })}
        hint={spec("buttonTextColor").hint}
      />
      <NumberInput
        label="Label size"
        value={block.labelSize}
        {...numberField(spec("labelSize"))}
        suffix="px"
        inherited={String(Math.max(14, base.fontSize - 1))}
        inheritedFrom="the block font size minus 1 (at least 14)"
        onReset={block.labelSize === undefined ? undefined : () => patch({ labelSize: undefined })}
        onChange={(v) => patch({ labelSize: clampTo(specBounds(spec("labelSize")), v) })}
      />
      <ChoiceInput<Weight>
        label="Label weight"
        value={block.labelWeight}
        def={spec("labelWeight").default as Weight}
        options={spec("labelWeight").options as readonly Weight[]}
        labels={WEIGHT_LABELS}
        onChange={(v) => patch({ labelWeight: v })}
        hint={spec("labelWeight").hint}
      />
      <SpacingInput
        label="Button padding (px)"
        value={block.innerPadding}
        defaults={BUTTON_PADDING}
        min={specBounds(spec("innerPadding")).min}
        max={specBounds(spec("innerPadding")).max}
        inheritedFrom="the button default"
        onChange={(next) => patch({ innerPadding: next })}
        hint={spec("innerPadding").hint}
      />
    </Group>
  );
}

/** Les liens d'un menu : taille, graisse, soulignement, interligne, couleur du séparateur. */
export function MenuLookFields({
  block,
  theme,
  base,
  patch,
}: {
  block: MenuBlock;
  theme: Theme;
  base: Base;
  patch: (p: Partial<MenuBlock>) => void;
}) {
  const spec = (path: string) => propSpec("menu", path);
  const keys = ["itemSize", "itemWeight", "itemUnderline", "itemLineHeight", "separatorColor"];
  return (
    <Group id="menu.link-look" title="Link look" summary={overrides(block, keys)}>
      <Note>The link colour is the Link color of the Style tab.</Note>
      <NumberInput
        label="Link size"
        value={block.itemSize}
        {...numberField(spec("itemSize"))}
        suffix="px"
        inherited={String(Math.max(12, base.fontSize - 2))}
        inheritedFrom="the block font size minus 2 (at least 12)"
        onReset={block.itemSize === undefined ? undefined : () => patch({ itemSize: undefined })}
        onChange={(v) => patch({ itemSize: clampTo(specBounds(spec("itemSize")), v) })}
      />
      <ChoiceInput<Weight>
        label="Link weight"
        value={block.itemWeight}
        def={spec("itemWeight").default as Weight}
        options={spec("itemWeight").options as readonly Weight[]}
        labels={WEIGHT_LABELS}
        onChange={(v) => patch({ itemWeight: v })}
        hint={spec("itemWeight").hint}
      />
      <CheckboxInput
        label="Underline"
        text="Underline the menu links"
        checked={block.itemUnderline === true}
        // Le défaut (pas de soulignement) s'écrit ABSENT, comme toute case à défaut « non ».
        onChange={(v) => patch({ itemUnderline: v ? true : undefined })}
        hint={spec("itemUnderline").hint}
      />
      <NumberInput
        label="Line height"
        value={block.itemLineHeight}
        {...numberField(spec("itemLineHeight"))}
        inherited={literalDefault(spec("itemLineHeight"))}
        inheritedFrom="the menu default"
        onReset={block.itemLineHeight === undefined ? undefined : () => patch({ itemLineHeight: undefined })}
        onChange={(v) => patch({ itemLineHeight: clampTo(specBounds(spec("itemLineHeight")), v) })}
      />
      <ColorInput
        label="Separator colour"
        value={block.separatorColor}
        inherited={theme.mutedColor}
        inheritedFrom="the brand muted colour"
        onReset={block.separatorColor === undefined ? undefined : () => patch({ separatorColor: undefined })}
        onChange={(v) => patch({ separatorColor: v })}
        hint={spec("separatorColor").hint}
      />
    </Group>
  );
}

/** Les pastilles et les libellés d'un bloc de liens sociaux. */
export function SocialLookFields({
  block,
  theme,
  patch,
}: {
  block: SocialBlockT;
  theme: Theme;
  patch: (p: Partial<SocialBlockT>) => void;
}) {
  const spec = (path: string) => propSpec("social", path);
  const keys = ["labelColor", "labelSize", "iconBackground", "iconRadius"];
  return (
    <Group id="social.icons" title="Icons & labels" summary={overrides(block, keys)}>
      <ColorInput
        label="Icon background"
        value={block.iconBackground}
        // Pas de valeur unique à montrer : chaque réseau garde sa couleur (bleu Facebook…).
        inherited="each network’s own colour"
        inheritedFrom="the icon set"
        onReset={block.iconBackground === undefined ? undefined : () => patch({ iconBackground: undefined })}
        onChange={(v) => patch({ iconBackground: v })}
        hint={spec("iconBackground").hint}
      />
      <NumberInput
        label="Icon corner radius"
        value={block.iconRadius}
        {...numberField(spec("iconRadius"))}
        suffix="px"
        inherited={literalDefault(spec("iconRadius"))}
        inheritedFrom="the icon set"
        onReset={block.iconRadius === undefined ? undefined : () => patch({ iconRadius: undefined })}
        onChange={(v) => patch({ iconRadius: clampTo(specBounds(spec("iconRadius")), v) })}
      />
      <ColorInput
        label="Label colour"
        value={block.labelColor}
        inherited={theme.mutedColor}
        inheritedFrom="the brand muted colour"
        onReset={block.labelColor === undefined ? undefined : () => patch({ labelColor: undefined })}
        onChange={(v) => patch({ labelColor: v })}
        hint={spec("labelColor").hint}
      />
      <NumberInput
        label="Label size"
        value={block.labelSize}
        {...numberField(spec("labelSize"))}
        suffix="px"
        inherited={literalDefault(spec("labelSize"))}
        inheritedFrom="the icon set"
        onReset={block.labelSize === undefined ? undefined : () => patch({ labelSize: undefined })}
        onChange={(v) => patch({ labelSize: clampTo(specBounds(spec("labelSize")), v) })}
      />
    </Group>
  );
}

/* ------------------------------------------------------------------ *
 * Document : langue, onglet du navigateur, version texte
 * ------------------------------------------------------------------ */

type MetaPatch = (patch: Partial<Meta>) => void;
type Dir = NonNullable<Meta["dir"]>;
type PlainText = NonNullable<Meta["plainText"]>;

const DIR_LABELS: Record<string, string> = {
  auto: "Auto — follows the text",
  ltr: "Left to right",
  rtl: "Right to left",
};

/**
 * `{ } | < > "` : le schéma les refuse dans le repli du prénom, écrit DANS le jeton du shell
 * (`{{first_name|…}}`). Retirés à la frappe, comme les guillemets d'une condition, plutôt que de
 * laisser fabriquer un document insauvegardable.
 */
const FIRST_NAME_FORBIDDEN = /[{}|<>"]/g;

/** Ce que la langue décide par défaut, et qu'un modèle peut remplacer. */
export function LanguageDefaultsFields({ meta, onPatch }: { meta: Meta; onPatch: MetaPatch }) {
  const spec = (path: string) => propSpec("meta", path);
  const dates: DateFormats = meta.dateFormats ?? {};
  /** `dateFormats` est réécrit ENTIER (`updateMeta` fusionne sur un niveau) ; vide, il disparaît. */
  const nextDates = (p: Partial<DateFormats>): DateFormats | undefined => {
    const next = prune({ ...dates, ...p });
    return Object.keys(next).length === 0 ? undefined : next;
  };
  const locale = normalizeLocale(meta.locale);
  const dateLabels = Object.fromEntries(
    DATE_STYLES.map((s) => [s, `${DATE_STYLE_LABELS[s]} — ${formatDateStyle(DATE_EXEMPLE, locale, s)}`]),
  );
  return (
    <>
      <ChoiceInput<Dir>
        label="Text direction"
        value={meta.dir}
        def={spec("dir").default as Dir}
        options={spec("dir").options as readonly Dir[]}
        labels={DIR_LABELS}
        onChange={(v) => onPatch({ dir: v })}
        hint={spec("dir").hint}
      />
      <TextInput
        label="Default read-link label"
        value={meta.defaultCtaLabel ?? ""}
        maxLength={spec("defaultCtaLabel").max}
        // Vide = pas de choix : la langue décide. Stocké ABSENT, le défaut se montre en grisé.
        onChange={(v) => onPatch({ defaultCtaLabel: v.trim() === "" ? undefined : v })}
        inherited={defaultArticleCta(meta.locale)}
        inheritedFrom="this document’s language"
        onReset={meta.defaultCtaLabel === undefined ? undefined : () => onPatch({ defaultCtaLabel: undefined })}
        hint={`${spec("defaultCtaLabel").hint} A block or card look with its own label keeps it.`}
      />
      <TextInput
        label="First-name fallback"
        value={meta.firstNameFallback ?? ""}
        maxLength={spec("firstNameFallback").max}
        onChange={(v) => {
          const clean = v.replace(FIRST_NAME_FORBIDDEN, "");
          onPatch({ firstNameFallback: clean.trim() === "" ? undefined : clean });
        }}
        inherited={defaultFirstName(meta.locale)}
        inheritedFrom="this document’s language"
        onReset={meta.firstNameFallback === undefined ? undefined : () => onPatch({ firstNameFallback: undefined })}
        hint={`${spec("firstNameFallback").hint} A merge tag written with its own fallback, like {{first_name|Ana}}, keeps it. Braces, |, < > and " are not allowed.`}
      />

      {/* Le style des trois jetons de date. Chaque option montre son rendu DANS LA LANGUE du modèle,
          par la fonction même qui l'écrira à l'envoi (`formatDateStyle`) : l'auteur choisit ce qu'il
          lit, pas un nom de style. */}
      <Group title="Dates" summary={overrides(dates, ["edition_date", "edition_date_short", "weekday"])}>
        <ChoiceInput<DateStyle>
          label="{{edition_date}}"
          value={dates.edition_date}
          def={DEFAULT_DATE_FORMATS.edition_date}
          options={DATE_STYLES}
          labels={dateLabels}
          onChange={(v) => onPatch({ dateFormats: nextDates({ edition_date: v }) })}
          hint={spec("dateFormats.edition_date").hint}
        />
        <ChoiceInput<DateStyle>
          label="{{edition_date_short}}"
          value={dates.edition_date_short}
          def={DEFAULT_DATE_FORMATS.edition_date_short}
          options={DATE_STYLES}
          labels={dateLabels}
          onChange={(v) => onPatch({ dateFormats: nextDates({ edition_date_short: v }) })}
          hint={spec("dateFormats.edition_date_short").hint}
        />
        <ChoiceInput<DateStyle>
          label="{{weekday}}"
          value={dates.weekday}
          def={DEFAULT_DATE_FORMATS.weekday}
          options={DATE_STYLES}
          labels={dateLabels}
          onChange={(v) => onPatch({ dateFormats: nextDates({ weekday: v }) })}
          hint={spec("dateFormats.weekday").hint}
        />
      </Group>
    </>
  );
}

/**
 * Ce qui part chez l'abonné sans vivre dans le modèle : le NOM de la marque (From, pied légal), la
 * langue et le marché de chaque édition, l'expéditeur et le Reply-To. Réglés par marque dans
 * Settings (super_admin seulement — la page le vérifie) : le builder y mène au lieu de les taire.
 */
export function BrandSettingsLink({ assetSlug }: { assetSlug: string }) {
  return (
    <Link
      href={`/settings/brands/${encodeURIComponent(assetSlug)}`}
      target="_blank"
      className="mt-2 inline-flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground"
    >
      Brand name, language, market &amp; sender (super admins) <ExternalLink className="h-3 w-3" strokeWidth={2} />
    </Link>
  );
}

type DateFormats = NonNullable<Meta["dateFormats"]>;

/** Un jour fixe pour les exemples : un mardi, jour et mois à deux chiffres, rien d'ambigu. */
const DATE_EXEMPLE = "2026-09-22";

/** Le titre HTML du document : l'objet (défaut), un texte choisi, ou rien. */
type TitleMode = "subject" | "custom" | "none";

/**
 * L'onglet du navigateur (`<title>`) et la version TEXTE BRUT de l'e-mail — deux choses que
 * l'abonné reçoit sans que le canvas ne les montre.
 */
export function DocumentOutputFields({ meta, onPatch }: { meta: Meta; onPatch: MetaPatch }) {
  const spec = (path: string) => propSpec("meta", path);
  // ⛔ TROIS ÉTATS, PAS DEUX : absent = l'objet, vide = pas de <title>, sinon le texte. Un seul champ
  // texte les confondrait — vider le champ pour « revenir à l'objet » supprimerait le titre.
  const mode: TitleMode =
    meta.htmlTitle === undefined ? "subject" : meta.htmlTitle.trim() === "" ? "none" : "custom";
  const plain: PlainText = meta.plainText ?? {};
  /** `plainText` est réécrit ENTIER (`updateMeta` fusionne sur un niveau) ; vide, il disparaît. */
  const nextPlain = (p: Partial<PlainText>): PlainText | undefined => {
    const next = prune({ ...plain, ...p });
    return Object.keys(next).length === 0 ? undefined : next;
  };
  const plainKeys = ["header", "includePreheader", "rule"];

  return (
    <>
      <SelectInput<TitleMode>
        label="Browser tab title"
        value={mode}
        options={[
          { value: "subject", label: "Same as the subject line (default)" },
          { value: "custom", label: "Custom text" },
          { value: "none", label: "No title" },
        ]}
        onChange={(v) =>
          onPatch({
            // « Custom » part de l'objet, visible et modifiable, plutôt que d'un texte inventé.
            htmlTitle: v === "subject" ? undefined : v === "none" ? "" : meta.htmlTitle?.trim() ? meta.htmlTitle : meta.subject,
          })
        }
        hint={spec("htmlTitle").hint}
      />
      {mode !== "subject" && (
        <TextInput
          label="Browser tab title text"
          value={meta.htmlTitle ?? ""}
          maxLength={spec("htmlTitle").max}
          onChange={(v) => onPatch({ htmlTitle: v })}
          placeholder="Empty = no title"
          hint="Shown by webmail in the browser tab and by some clients in the window title — never in the inbox list."
        />
      )}

      <Group title="Plain-text version" summary={overrides(plain, plainKeys)}>
        <Note>
          Every email also carries a text-only version, built from the blocks. Some clients and many spam filters read
          that one.
        </Note>
        <TextInput
          label="Top line"
          value={plain.header ?? ""}
          maxLength={spec("plainText.header").max}
          onChange={(v) => onPatch({ plainText: nextPlain({ header: v.trim() === "" ? undefined : v }) })}
          hint={spec("plainText.header").hint}
        />
        <CheckboxInput
          label="Preheader"
          text="Repeat the preheader at the top"
          checked={plain.includePreheader !== false}
          onChange={(v) => onPatch({ plainText: nextPlain({ includePreheader: v ? undefined : false }) })}
          hint={spec("plainText.includePreheader").hint}
        />
        <TextInput
          label="Separator line"
          value={plain.rule ?? ""}
          maxLength={spec("plainText.rule").max}
          // Vide = le filet par défaut. Les espaces comptent (un filet « - - - »), on ne les retire pas.
          onChange={(v) => onPatch({ plainText: nextPlain({ rule: v === "" ? undefined : v }) })}
          inherited={String(spec("plainText.rule").default)}
          inheritedFrom="the default rule"
          onReset={plain.rule === undefined ? undefined : () => onPatch({ plainText: nextPlain({ rule: undefined }) })}
          hint={`${spec("plainText.rule").hint} Also stands in for every divider block.`}
        />
      </Group>
    </>
  );
}
