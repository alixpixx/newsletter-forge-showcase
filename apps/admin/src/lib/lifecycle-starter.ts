import {
  EmailDoc,
  MAX_BUTTON_LABEL,
  newId,
  textBlock,
  type EmailDoc as EmailDocType,
} from "@nf/render/schema";
import { normalizeLocale, strings } from "@nf/email";
import type { LifecycleKind } from "@nf/render/lifecycle-checks";
// Type SEUL : `lib/data/templates` importe la session et la base. Un import de valeur ferait entrer
// `next/headers` dans un module qui se veut pur — et le banc ne pourrait plus l'appeler.
import type { TemplateCategory } from "@/lib/data/templates";
import { LIFECYCLE_LABELS } from "@/components/templates/lifecycle-labels";

/*
 * POINT DE DÉPART ÉDITABLE POUR LES QUATRE E-MAILS DE CYCLE DE VIE.
 *
 * ⛔ POURQUOI CE MODULE EXISTE. Le contenu des quatre e-mails intégrés est du HTML en dur
 * (`apps/worker/src/render.ts`) : il part toujours, et il n'est pas éditable. Le SEUL moyen de
 * l'écrire soi-même est de rattacher un modèle du builder — mais personne n'avait de point de
 * départ. On partait donc d'un modèle de campagne, sans `{{confirm_url}}`, et le rattachement
 * comme la publication le refusaient en 422 sans que rien ne l'ait annoncé. Ce module rend le
 * document que l'utilisateur AURAIT dû écrire : la copie de l'e-mail intégré, jetons exigés déjà
 * posés, footer légal en dernier — donc un document qui franchit les barrières du premier coup.
 *
 * ⛔ FONCTION PURE, SANS BASE NI RÉSEAU. C'est ce qui permet au banc d'exécuter les VRAIS contrôles
 * (`checkLifecycleShell` sur le HTML compilé, `EmailDocPublishable`, le poids) sur les quatre kinds
 * et les six langues. Une fabrique qui aurait besoin d'un client Supabase ne serait vérifiable
 * qu'en production, c'est-à-dire au moment où un e-mail de confirmation part sans lien.
 *
 * ⛔ CE MODULE NE REMPLACE PAS LE REPLI. Le HTML en dur du worker reste la source de secours et
 * n'est pas touché : tant qu'aucune version n'est publiée, c'est lui qui part (`renderLifecycle`
 * rend `null`). Le document produit ici est un BROUILLON.
 */

/* ------------------------------------------------------------------ *
 * Choix éditoriaux, assumés
 * ------------------------------------------------------------------ */

/*
 * ⚠️ PAS DE SALUTATION NOMINATIVE, ET C'EST UN CHOIX. L'intégré écrit « Hi {prénom}, » quand il
 * connaît le prénom et « Hi, » sinon. Reproduire cette bascule dans un document builder demande
 * DEUX paragraphes conditionnels (`visibleIf: has_first_name` et son inverse) que l'utilisateur
 * verrait en double dans l'éditeur et casserait au premier remaniement. Écrire `{{first_name}}`
 * tout court serait pire : le repli du registre est le mot « there », donc « Olá there, » sur une
 * marque brésilienne. On sème donc la branche SANS prénom — exacte dans les six langues — et le
 * menu des jetons du builder reste là pour qui veut personnaliser.
 *
 * ⚠️ LA MARQUE EST UN JETON, PAS UNE CHAÎNE FIGÉE. `{{asset_name}}` est alimenté par la vue
 * `outbox_context` pour tous les kinds (`render.ts` : `asset_name: ctx.asset_name ?? ""`). Coller le
 * nom en dur figerait le modèle le jour d'un renommage de marque, sans que rien ne le signale.
 */
const MARQUE = "{{asset_name}}";

/** Catégorie du modèle créé — doit appartenir à `TEMPLATE_CATEGORIES` (CHECK SQL, migration 0017). */
const CATEGORIE: Record<LifecycleKind, TemplateCategory> = {
  confirmation: "transactional",
  welcome: "welcome",
  unsubscribe_ack: "transactional",
  reengagement: "win_back",
};

/**
 * Libellé de bouton borné à `MAX_BUTTON_LABEL`.
 *
 * ⛔ CE N'EST PAS UN CONFORT D'AFFICHAGE, C'EST UN REFUS DE SCHÉMA. `ButtonBlock.label` est
 * `.max(MAX_BUTTON_LABEL)` : un libellé de 29 caractères ne produit pas un avertissement, il fait
 * échouer `EmailDoc.parse` — donc la création elle-même. Or quatre des six traductions de
 * `reengage_cta` dépassent (« Sim, quero continuar recebendo » = 30, « Oui, je veux continuer à
 * recevoir » = 33). On coupe donc au MOT, jamais au caractère, et on retire une préposition
 * orpheline en fin de libellé (« … continuer à ») qui se lirait comme une phrase tronquée.
 */
export function libelleBouton(texte: string): string {
  const brut = texte.trim();
  if (brut.length <= MAX_BUTTON_LABEL) return brut;

  const gardes: string[] = [];
  for (const mot of brut.split(/\s+/)) {
    const essai = gardes.length === 0 ? mot : `${gardes.join(" ")} ${mot}`;
    if (essai.length > MAX_BUTTON_LABEL) break;
    gardes.push(mot);
  }
  while (gardes.length > 1 && (gardes[gardes.length - 1] as string).length <= 2) gardes.pop();

  const abrege = gardes.join(" ").replace(/[\s,;:.]+$/, "");
  // Un seul mot plus long que la borne : il n'y a plus de coupe propre, on tranche au caractère
  // plutôt que de rendre une chaîne vide, que le schéma refuserait aussi (`min(1)`).
  return abrege.length > 0 ? abrege : brut.slice(0, MAX_BUTTON_LABEL);
}

/* ------------------------------------------------------------------ *
 * Fabrique
 * ------------------------------------------------------------------ */

export interface LifecycleStarterInput {
  /** `meta.assetSlug`, obligatoire au schéma (1..64). */
  assetSlug: string;
  /** Langue dans laquelle le document est ÉCRIT. Voir `lifecycleStarterLocale`. */
  locale: string;
  /**
   * Le thème du document — celui d'un modèle publié de la marque, pour que l'e-mail de confirmation
   * porte ses couleurs (décision d'Alix du 22/09/2026). Absent ou refusé par le schéma : le thème par
   * défaut du builder, comme avant. Voir `lifecycleStarterDoc`.
   */
  theme?: unknown;
}

export interface LifecycleStarter {
  kind: LifecycleKind;
  /** Nom proposé du modèle. L'appelant en tire un slug unique dans la marque. */
  name: string;
  category: TemplateCategory;
  doc: EmailDocType;
}

/**
 * Les blocs du corps, sans le footer légal — ajouté en dernier par `lifecycleStarterDoc`.
 * Type `unknown[]` à dessein : ces littéraux ne sont PAS des blocs tant que `EmailDoc.parse` ne les
 * a pas validés, et les typer d'avance ferait croire à une garantie que seul le parse donne.
 */
function corps(kind: LifecycleKind, locale: string): unknown[] {
  const s = strings(normalizeLocale(locale));

  if (kind === "confirmation") {
    return [
      // ⚠️ FIDÉLITÉ ASSUMÉE : l'intégré utilise `confirm_cta` comme titre ET comme libellé de
      // bouton (`packages/email/src/templates.ts`). La redondance part réellement aujourd'hui ;
      // la corriger ici ferait diverger le point de départ de ce que les abonnés reçoivent.
      textBlock(s.confirm_cta, "h2"),
      textBlock(`${s.confirm_hi(null)} ${s.confirm_body(MARQUE)}`, "body"),
      {
        id: newId("btn"),
        type: "button",
        label: libelleBouton(s.confirm_cta),
        // ⛔ LE JETON VIT DANS UN `href` DE BOUTON, ET NULLE PART AILLEURS PAR HASARD. Le contrôle
        // juge le HTML COMPILÉ : un jeton posé sur un CTA que le compilateur n'émet pas (callout
        // sans libellé, bloc conditionnel) disparaît en silence et la publication refuse. Le bloc
        // `button` est le seul dont le `href` est rendu inconditionnellement.
        href: "{{confirm_url}}",
      },
      textBlock(s.confirm_ignore, "small"),
    ];
  }

  if (kind === "welcome") {
    // Aucun bouton : l'intégré n'en a pas, et `welcome` n'exige aucun jeton.
    return [textBlock(`${s.welcome_hi(null)} 👋`, "h2"), textBlock(s.welcome_body(MARQUE), "body")];
  }

  if (kind === "unsubscribe_ack") {
    return [textBlock(s.unsub_ack_title, "h2"), textBlock(s.unsub_ack_body(MARQUE), "body")];
  }

  return [
    textBlock(s.reengage_title(MARQUE), "h2"),
    // ⚠️ `reengage_body` a la signature `(b) => …` mais n'interpole PAS la marque, dans les six
    // langues. On passe quand même le jeton : le texte rendu est alors EXACTEMENT celui de
    // l'intégré, et le jour où la traduction se met à interpoler, le modèle suivra.
    textBlock(s.reengage_body(MARQUE), "body"),
    {
      id: newId("btn"),
      type: "button",
      label: libelleBouton(s.reengage_cta),
      href: "{{preferences_url}}",
    },
    // ⛔ LA MENTION DE SUNSET N'EST PAS DÉCORATIVE. C'est elle qui rend la politique loyale : sans
    // elle, quelqu'un disparaît de la liste sans avoir jamais su qu'il pouvait rester d'un clic
    // (`packages/email/src/i18n.ts`, en tête de `reengage_*`). Elle est donc semée d'office.
    textBlock(s.reengage_sunset, "small"),
  ];
}

/** Sujet et préheader du kind, déjà porteurs du jeton de marque. */
function entete(kind: LifecycleKind, locale: string): { subject: string; preheader: string } {
  const s = strings(normalizeLocale(locale));
  switch (kind) {
    case "confirmation":
      return { subject: s.confirm_subject(MARQUE), preheader: s.confirm_cta };
    case "welcome":
      return { subject: s.welcome_subject(MARQUE), preheader: s.welcome_body(MARQUE) };
    case "unsubscribe_ack":
      return { subject: `${s.unsub_ack_title} — ${MARQUE}`, preheader: s.unsub_ack_body(MARQUE) };
    case "reengagement":
      return { subject: s.reengage_subject(MARQUE), preheader: s.reengage_cta };
  }
}

/** Nom proposé du modèle — le même vocabulaire que le panneau, pour qu'on le reconnaisse dans la liste. */
export function lifecycleStarterName(kind: LifecycleKind): string {
  return `${LIFECYCLE_LABELS[kind].titre} email`.slice(0, 120);
}

/**
 * Le nom RÉELLEMENT posé, désambiguïsé par le suffixe que `uniqueSlug` a dû ajouter.
 *
 * ⛔ POURQUOI LE NOM SUIT LE SLUG. Le slug est dédoublonné en base (`unique (asset_id, slug)`), mais
 * c'est le NOM que l'écran affiche partout : options du sélecteur et lignes du tableau. Deux modèles
 * semés pour le même kind — détacher puis recommencer suffit — portaient donc deux fois « Confirmation
 * email », strictement indistinguables. On choisit alors à l'aveugle, on rattache le mauvais, et la
 * ligne annonce « Your template » pour un modèle qui ne contient pas son travail.
 */
export function lifecycleStarterDisplayName(kind: LifecycleKind, baseSlug: string, slug: string): string {
  const nom = lifecycleStarterName(kind);
  // Le slug retenu est le slug de base : rien à distinguer, on garde le nom nu.
  if (!baseSlug || !slug.startsWith(`${baseSlug}-`)) return nom;
  const suffixe = slug.slice(baseSlug.length + 1);
  return suffixe ? `${nom} (${suffixe})`.slice(0, 120) : nom;
}

/**
 * Le document de départ d'un e-mail de cycle de vie, prêt à être rattaché ET publié.
 *
 * ⛔ ON REND LE RÉSULTAT DE `EmailDoc.parse`, PAS LE LITTÉRAL. Le parse applique les défauts du
 * schéma (`preset`, `align`, `widthPct`, `rowPadding`…) ; stocker le littéral brut donnerait un
 * document que le builder relirait différemment de celui qu'il vient d'écrire.
 *
 * ⛔ UNE SEULE ROW, LAYOUT "1". `Row.columns.length` doit valoir EXACTEMENT le nombre de colonnes du
 * layout : "1" est la seule forme qui ne peut pas se tromper.
 *
 * ⚠️ AUCUNE COULEUR PROPRE, AUCUNE IMAGE. Les couleurs de l'intégré (`#fff`, `#191920`) sont refusées
 * par `HexColor`, et une image exigerait un `alt` non vide à la publication. Les couleurs viennent du
 * THÈME DE LA MARQUE quand l'appelant le fournit (`input.theme`), sinon du thème par défaut du builder.
 *
 * ⛔ UN THÈME REFUSÉ NE FAIT PAS ÉCHOUER LA CRÉATION. Il vient d'un autre document, écrit sous une
 * version antérieure du schéma peut-être : s'il ne passe plus `Theme`, on retombe sur le thème par
 * défaut plutôt que de priver la marque de son e-mail de confirmation pour une question de couleur.
 */
export function lifecycleStarterDoc(kind: LifecycleKind, input: LifecycleStarterInput): EmailDocType {
  if (input.theme !== undefined && input.theme !== null && typeof input.theme === "object" && !Array.isArray(input.theme)) {
    try {
      return docDeDepart(kind, input, input.theme);
    } catch {
      /* thème refusé par le schéma : repli sur le thème par défaut, juste en dessous */
    }
  }
  return docDeDepart(kind, input, {});
}

function docDeDepart(kind: LifecycleKind, input: LifecycleStarterInput, theme: object): EmailDocType {
  /*
   * ⛔ LE DOCUMENT DÉCLARE LA LANGUE DE SON TEXTE, PAS CELLE QU'ON A DEMANDÉE. Tout le contenu est
   * écrit avec `strings(normalizeLocale(...))`, qui renvoie sur `en` toute langue hors dictionnaire
   * (« sv », déclaré par Harbor Tech). Recopier la langue BRUTE dans `meta.locale` produisait un
   * document au corps anglais annonçant `sv` — et `meta.locale` n'est pas décoratif : le
   * compilateur en fait l'attribut `lang` du `<html>` de l'e-mail envoyé. L'intégré, lui, émet `en`.
   * Normalisée, la valeur est toujours l'une des six et tient dans la borne du schéma (2..12).
   */
  const locale = normalizeLocale(input.locale);
  const { subject, preheader } = entete(kind, locale);

  return EmailDoc.parse({
    schema: 2,
    meta: {
      subject: subject.slice(0, 200),
      // ⚠️ Un préheader vide ne bloque rien mais lève un constat consultatif au pré-vol : le
      // remplir laisse le panneau totalement vert, donc lisible le jour où un VRAI constat sort.
      preheader: preheader.slice(0, 200),
      assetSlug: input.assetSlug,
      locale,
    },
    theme,
    rows: [
      {
        id: newId("row"),
        layout: "1",
        columns: [
          {
            id: newId("col"),
            blocks: [
              ...corps(kind, locale),
              // ⛔ DERNIER BLOC, TOUJOURS, ET SANS `visibleIf` NI `style` (le schéma du bloc ne
              // déclare que `id` et `type`). C'est lui qui émet `{{legal_footer_html}}`, sans quoi
              // la publication refuse en 422 et le worker met l'envoi en veto de conformité.
              { id: newId("blk"), type: "footer_legal" },
            ],
          },
        ],
      },
    ],
  });
}

/** Tout ce dont une route a besoin pour créer le modèle : nom, catégorie, document. */
export function lifecycleStarter(kind: LifecycleKind, input: LifecycleStarterInput): LifecycleStarter {
  return {
    kind,
    name: lifecycleStarterName(kind),
    category: CATEGORIE[kind],
    doc: lifecycleStarterDoc(kind, input),
  };
}

/**
 * La langue dans laquelle écrire le modèle.
 *
 * ⛔ LES ÉDITIONS D'ABORD, LE REGISTRE ENSUITE. `asset.languages` est ce que la marque DÉCLARE ;
 * `asset_edition.language` est ce qu'elle ENVOIE. Les deux ont déjà divergé (atlas-review déclarait
 * `pt-BR` en tête alors que le seed avait posé `it`, corrigé par la migration 0029). Écrire le
 * modèle dans une langue que personne ne reçoit ne produit aucune erreur : juste un e-mail dans la
 * mauvaise langue, découvert par l'abonné.
 */
export function lifecycleStarterLocale(editionLanguages: string[], declaredLanguages: string[]): string {
  return editionLanguages[0] ?? declaredLanguages[0] ?? "en";
}
