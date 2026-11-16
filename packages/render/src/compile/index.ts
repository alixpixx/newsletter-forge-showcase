/**
 * @nf/render/compile — point d'entrée LOURD (MJML), exécuté par l'ADMIN uniquement.
 *
 * ⛔ Ne jamais importer depuis le worker : `apps/worker` ne doit charger que `@nf/render/hydrate`.
 *
 * Le rendu a lieu À LA PUBLICATION, pas à l'envoi : on fige `html` + `text` avec les tokens
 * `{{…}}` NON résolus, on les stocke dans `newsletter.template_version`, et le worker n'exécute
 * plus qu'un `hydrate()` par destinataire. Envois déterministes, worker léger, snapshot testable.
 */
import {
  EmailDoc,
  GMAIL_CLIP_BYTES,
  MAX_BUTTON_LABEL,
  eachBlock,
  isPlaceholderSrc,
  type Block,
  type EmailDocInput,
} from "../schema";
import { dateFormatsMarker } from "@nf/email/dates";
import { expandFeedBlocks } from "../feed";
// Le prédicat du lien de remplissage vit dans `../links`, pas dans la boucle ci-dessous : c'est de
// là que `feed.ts` l'avait recopié faute de point d'import. Niveau ÉTROIT ici — un avertissement
// plus large ferait rougir des documents déjà en base que personne n'a touchés.
import { isPlaceholderHref } from "../links";
import { applyBrandPartials, type BrandPartials } from "./brand-partials";
import { renderMjml } from "./mjml";
import { renderText } from "./text";

export { buildAst, columnPercents, renderMjml, type MjmlNode } from "./mjml";
export { renderText } from "./text";
export {
  applyBrandPartials,
  empreinteSansIds,
  MAX_PARTIAL_ROWS,
  PARTIAL_FOOTER_LEGAL_MESSAGE,
  type BrandPartials,
} from "./brand-partials";

/**
 * Identité du compilateur, écrite dans `template_version.compiler_version`.
 * ⚠️ À incrémenter dès qu'un changement modifie le HTML produit : c'est ce qui permet de savoir
 * quelles versions publiées ont besoin d'être recompilées.
 *
 * 1.1.0 : un `\n` dans le texte d'un span sort désormais en `<br />` (avant : newline brut, que le
 * HTML réduit à une espace). L'ancien éditeur écrivait la valeur d'un `<textarea>` telle quelle dans
 * `spans[0].text` — les documents publiés dont un paragraphe contient un retour à la ligne ne se
 * recompilent donc PAS à l'identique. Sans cet incrément, rien ne distinguerait leurs shells figés
 * de ceux produits par la règle actuelle.
 *
 * 1.2.0 : deux changements de HTML.
 *  - `paddingMobile` / `fontSizeMobile` posés au niveau ROW ou COLUMN produisent enfin une media
 *    query. Avant, ils étaient silencieusement jetés — les versions publiées d'un document qui en
 *    porte n'ont donc PAS le rendu mobile voulu, et méritent une recompilation.
 *  - un span `strike` sort en `<s>`.
 * Un document sans réglage mobile de row/colonne ni barré recompile à l'identique.
 *
 * 1.3.0 : le lien de lecture d'une carte de flux. Depuis le 28/08/2026, `withDefaultCta` pose le
 * libellé de la langue sur tout article déplié qui n'en porte pas — avant, ces cartes partaient
 * SANS lien de lecture. C'est la correction voulue, mais elle change le HTML de documents qui
 * n'ont pas bougé d'une virgule : mesuré sur un template Copper Kettle publié le 27/08, 15 053 o
 * → 16 007 o, trois liens `text-decoration:underline` apparaissent. L'incrément était dû ce
 * jour-là et ne l'a pas été — le champ affirmait donc une reproductibilité qu'il n'avait plus.
 * Y sont joints les changements du 30/08, qui ne touchent aucun document publié mais modifient
 * bien le HTML produit : largeur de cellule d'article bornée à 80 px (elle pouvait sortir
 * négative dans une colonne étroite), vignette d'encart non enveloppée dans une ancre sans nom
 * accessible, et `ctaUnderline` enfin prise en compte quand elle est posée seule.
 *
 * ⚠️ PAS D'INCRÉMENT POUR L'EN-TÊTE ET LE PIED DE MARQUE (13/09/2026), et c'est mesurable : un
 * document auquel aucun partial n'est appliqué traverse `applyBrandPartials` sans qu'une seule row
 * change, et la régénération des ids n'a aucun effet sur le HTML (les ids ne sont émis nulle part).
 * Le rendu de toutes les versions déjà publiées est donc inchangé, octet pour octet — incrémenter
 * aurait fait croire qu'elles méritent une recompilation.
 *
 * 1.4.0 (22/09/2026) : deux changements de HTML, tous deux pour que l'email ressemble à l'éditeur.
 *  - le lien de lecture d'un article SANS `ctaStyle` (ou `button`) sort en bouton tableau
 *    (`ctaTable`), plus en lien souligné. `ctaStyle:"link"` et `"none"` sont inchangés ;
 *  - une carte en vignette (`layout:"side"` avec image) s'empile sur mobile, vignette pleine
 *    largeur au-dessus du texte, sans dépendre du `<style>` du head (`sideBySide`).
 * Touche toute version dont un article (écrit à la main ou déplié d'un flux) a une vignette
 * latérale ou un lien de lecture sans style explicite. ⚠️ Un shell DÉJÀ figé (occurrence gelée,
 * `template_version.html_shell` d'un modèle sans flux) ne change pas tant qu'on ne le recompile pas.
 *
 * 1.5.0 (22/09/2026) : « tout ce que l'abonné reçoit se règle dans le builder ». Les décisions que
 * le compilateur prenait seul deviennent des clés du schéma (manifeste `NEW_PROPS_2026_09_22`) ;
 * ABSENTES, elles rendent l'octet d'avant — prouvé par `golden.test.ts` et par la recompilation des
 * 108 `template_version` réelles (lecture seule) : 106 identiques à l'octet. Mineur et non de
 * correctif, parce que quatre changements VOLONTAIRES modifient le HTML sans qu'aucune clé soit posée :
 *  - `{{first_name}}` reçoit le repli de la langue du modèle (« amigo », « cher lecteur »…) au lieu
 *    de l'anglais « there » : les 2 écarts mesurés, deux brouillons pt-BR, et rien d'autre ;
 *  - un menu dont l'alignement à gauche est POSÉ est enfin aligné à gauche (0 modèle en base) ;
 *  - un modèle allemand reçoit « Weiterlesen » au lieu de « Read more » (0 modèle en base) ;
 *  - le bouton de lecture d'un article lit `ctaSize`, `ctaLetterSpacing` et `ctaTransform`, qui ne
 *    valaient que pour la forme `link` (0 article ni look en base ne les porte sans `link`).
 *
 * 1.6.0 (23/09/2026) : « que ce soit en dark ou white mode ça doit être identique à notre template ».
 * Le `<head>` de TOUS les e-mails change, le rendu clair ne change pas (prouvé au pixel sur les 18
 * e-mails réels, WebKit et Chromium, 375 et 700 px) :
 *  - `color-scheme` absent = « light only » (avant « light dark ») : Gmail iOS/Android, Apple Mail et
 *    l'assombrissement forcé de Chromium/WebView ne recolorent plus l'e-mail ;
 *  - l'épingle anti-recoloration couvre les BLOCS sans texte (le bandeau Copper Kettle des e-mails de
 *    cycle de vie est fait de blocs) et les fonds clairs ; une image sans fond propre reçoit en
 *    inline celui qu'elle a sous elle ; la règle Gmail vise aussi la table d'une rangée.
 * Écarts exacts : `ECARTS_VOLONTAIRES` de `golden.test.ts`.
 *
 * 1.6.1 (23/09/2026) : la barre à `segments` (filet tricolore Northwind Sports) sort en table HYBRIDE —
 * attributs `width` en px inchangés, style `width:100%;max-width:<W>px` et cellules en %. Avant, son
 * `width:600px` en style forçait tout l'e-mail à 600 px sur mobile (débord de 225 px à 375, texte
 * coupé). Touche les seules versions qui portent une barre à segments (14 sur 118 et 1 pied de marque
 * sur 7 au 23/09/2026) ; rendu bureau inchangé au pixel. Écart exact : `ECARTS_VOLONTAIRES`.
 * ⚠️ CE N'EST PAS TOUT LE DÉBORD MOBILE : pick, classement, article, section_title, callout et
 * scoreboard écrivent encore `width:<W>px` en style. Les 6 versions « Giro do Tricolor » débordent
 * donc toujours à 375 px (scrollWidth 600, mesuré le 23/09/2026) par leurs tables d'article.
 *
 * 1.6.2 (23/09/2026) : le même correctif pour toutes les autres TABLES de blocs — article, titre de
 * section, encart, bandeau de résultat, pick, promo, cotes, classement : attribut `width` en px
 * inchangé, style `width:100%;max-width:<W>px` (`largeurTable`). Les CELLULES gardent leur px (un %
 * décalait le bureau). Touche 71 des 118 versions réelles et aucun des 7 en-têtes et pieds de marque
 * au 23/09/2026 — exactement les 71 documents qui débordaient à 375 px ; rendu bureau inchangé au
 * pixel (Chromium et WebKit, 600 et 700 px). Écarts exacts : `ECARTS_VOLONTAIRES`.
 * ⚠️ PAS FLUIDE, À DESSEIN : la table INTÉRIEURE d'un cadre BORDÉ (pick et bandeau par défaut, encart
 * à filet d'accent et vignette des Boletín Copper Kettle) — elle pousse déjà le cadre à `W + bordures`
 * au bureau, la rendre fluide changerait ce rendu (`tableInterieureExacte`, DÉCISION D'ALIX). Ces
 * documents-là débordent donc encore sur mobile.
 *
 * 1.6.3 (24/09/2026) : DÉCISION D'ALIX (« oui corrige ») — la table intérieure d'un cadre BORDÉ (pick,
 * bandeau à bordure, encart à filet d'accent et vignette des Boletín Copper Kettle) tient dans son
 * cadre, bordure comprise : `W − marges − bordures`, en attribut comme en plafond, style fluide
 * (`tableInterieure`, qui remplace `tableInterieureExacte`). Avant, calculée sans la bordure, elle
 * poussait le cadre à `W + bordures` au bureau (540 px dans une colonne de 536, section de 604 px) et
 * faisait déborder à 375 px les 45 documents réels restants. Touche exactement ces 45 documents (39
 * Boletín, 3 picks, 3 bandeaux) sur 125 au 24/09/2026. Rendu bureau (Chromium et WebKit, 600 et
 * 700 px) : cadres de 540 → 536, 538 → 536 et 554 → 552 px, section revenue à 600 px (son contenu
 * centré se recale de 2 px), vignette 134 → 133 px ; les 80 autres documents identiques au pixel.
 * Écarts exacts : `ECARTS_VOLONTAIRES`.
 *
 * 1.6.4 (24/09/2026) : « sur le responsive c'est top sauf le logo qui reste géant » (Alix). Toute
 * image portait `fluid-on-mobile`, qui la passe à 100 % de sa colonne sous le seuil d'empilement
 * (479 px par défaut) : le logo Copper Kettle réglé à 198 px en faisait 375 à 375 px. Une image réglée
 * SOUS 100 % garde désormais sa largeur en px (elle rétrécit seule si la colonne est plus étroite) ;
 * à 100 % elle reste fluide. Colonnes empilées, une image réglée alignée à gauche ou à droite se
 * centre, marges latérales égalisées (`centrerImageEmpilee`, sous le seuil d'empilement seulement).
 * Au 24/09/2026, 164 des 167 images des 120 versions réelles sont des logos réglés sous 100 %.
 * Rendu bureau (600 et 700 px) inchangé au pixel. Écarts exacts : `ECARTS_VOLONTAIRES`.
 */
export const COMPILER_VERSION = "nf-render@1.6.4+mjml@5.4.0";

export interface CompileResult {
  /** `html_shell` : tokens `{{…}}` et marqueurs `<!--nf:if-->` NON résolus. */
  html: string;
  /** `text_shell`, même règle. */
  text: string;
  /** Problèmes non bloquants, affichés dans le builder avant publication. */
  warnings: string[];
  /** Poids du HTML en octets (UTF-8). Seuil de troncature Gmail : 102 400. */
  sizeBytes: number;
  compilerVersion: string;
}

/**
 * Compile un EmailDoc. Accepte la forme d'ENTRÉE (defaults non appliqués) — c'est ce que
 * produisent le builder et l'IA — et lève une `ZodError` si le document est invalide.
 *
 * `partials` porte les rows de l'en-tête et du pied DE MARQUE, déjà résolues par l'appelant (cette
 * fonction n'a aucun accès à la base — voir `applyBrandPartials`). Omis, le document compile
 * exactement comme avant ; s'il POINTE pourtant sur un partial, un avertissement le dit.
 *
 * ⚠️ ASYNC : MJML 5 renvoie une Promise (la v4 était synchrone). Les appelants — route de
 * publication, aperçu, générateur IA — doivent `await`.
 */
export async function compileDoc(doc: EmailDocInput, partials?: BrandPartials): Promise<CompileResult> {
  // ⛔ L'EN-TÊTE ET LE PIED DE MARQUE SONT POSÉS AVANT LE DÉPLIAGE DES FLUX, et l'ordre compte : le
  // dépliage indexe ses résolutions par id de bloc, il doit donc voir le document complet, avec les
  // ids définitifs des rows ajoutées.
  const { doc: complet, warnings: warningsPartials } = applyBrandPartials(EmailDoc.parse(doc), partials);
  // ⛔ LES FLUX SONT DÉPLIÉS AVANT TOUT LE RESTE. Le compilateur ne sait pas rendre un flux et ne
  // doit jamais l'apprendre : il n'existe qu'UN rendu d'article, et un second finirait par ne plus
  // ressembler au premier. Ici le dépliage se fait sur l'APERÇU du bloc — l'envoi réel, lui, passe
  // par `expandFeedBlocks(doc, résolution)` avant d'appeler cette fonction.
  const { doc: expanded } = expandFeedBlocks(complet);
  const parsed = expanded;
  const { html: rendu, errors } = await renderMjml(parsed);
  const html = poserMarqueurDates(rendu, dateFormatsMarker(parsed.meta.dateFormats));
  const text = renderText(parsed);
  const sizeBytes = byteLength(html);

  return {
    html,
    text,
    warnings: [...errors, ...warningsPartials, ...collectWarnings(parsed, sizeBytes)],
    sizeBytes,
    compilerVersion: COMPILER_VERSION,
  };
}

/**
 * Pose le marqueur des formats de date (`<!--nf:dates …-->`) dans le shell, juste avant `</body>`.
 *
 * ⛔ C'EST LE SEUL TRANSPORT DU CHOIX JUSQU'À L'ENVOI : le worker ne voit que le shell figé, jamais le
 * document. Il lit le marqueur (`readDateFormats`) puis le RETIRE (`stripDateFormatsMarker`) avant de
 * remettre l'e-mail à Mailgun. Marqueur vide (aucun style choisi, ou seulement les défauts) = shell
 * inchangé à l'octet près : les modèles déjà publiés ne bougent pas.
 *
 * Avant `</body>` plutôt qu'en tête : un commentaire placé avant le `<!doctype>` fait basculer
 * certains clients en mode de compatibilité, le temps d'un aperçu qui l'afficherait tel quel.
 */
function poserMarqueurDates(html: string, marqueur: string): string {
  if (marqueur === "") return html;
  const fin = html.toLowerCase().lastIndexOf("</body>");
  return fin === -1 ? html + marqueur : html.slice(0, fin) + marqueur + html.slice(fin);
}

/** Variante non levante : pour l'IA et l'import, où un document invalide est un cas normal. */
export async function safeCompileDoc(
  doc: unknown,
  partials?: BrandPartials,
): Promise<{ ok: true; result: CompileResult } | { ok: false; issues: string[] }> {
  const parsed = EmailDoc.safeParse(doc);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }
  return { ok: true, result: await compileDoc(parsed.data, partials) };
}

/* ------------------------------------------------------------------ *
 * Contrôles qualité
 * ------------------------------------------------------------------ */

const byteLength = (s: string): number => new TextEncoder().encode(s).length;

/** Tous les liens d'un bloc, avec un libellé pour situer le problème dans le builder. */
function hrefsOf(block: Block): { href: string; where: string }[] {
  switch (block.type) {
    case "button":
      return [{ href: block.href, where: `button "${block.label}"` }];
    case "image":
      return block.href ? [{ href: block.href, where: `image "${block.alt || block.src}"` }] : [];
    case "text":
      return block.paragraphs.flatMap((p) =>
        p.spans.filter((s) => s.href).map((s) => ({ href: s.href as string, where: `link "${s.text}"` })),
      );
    case "menu":
      return block.items.map((i) => ({ href: i.href, where: `menu item "${i.label}"` }));
    case "social":
      return block.items.map((i) => ({ href: i.href, where: `social link "${i.platform}"` }));
    case "pick":
      return block.href ? [{ href: block.href, where: `pick "${block.matchLabel || block.id}"` }] : [];
    case "article":
      return [{ href: block.href, where: `article "${block.title || block.id}"` }];
    case "callout":
      return block.href ? [{ href: block.href, where: `callout "${block.title || block.id}"` }] : [];
    case "scoreboard":
      // Le pied du bandeau porte un vrai lien. C'est ici — et nulle part ailleurs — que se fait le
      // contrôle `http://` ; l'omettre le laissait partir en clair, sans un mot.
      return block.footerHref
        ? [{ href: block.footerHref, where: `scoreboard footer "${block.footerLabel || block.id}"` }]
        : [];
    case "promo":
      return [{ href: block.href, where: `promo "${block.headline || block.id}"` }];
    default:
      return [];
  }
}

const isBlank = (s: string | undefined): boolean => s === undefined || s.trim() === "";

/**
 * Contrôles propres aux blocs métier. Ils sont TOUS des avertissements et jamais des erreurs :
 * un brouillon à moitié rempli doit rester sauvegardable et prévisualisable — c'est la publication
 * qui exige le reste (voir `EmailDocPublishable`).
 */
function businessWarnings(block: Block, warnings: string[]): void {
  switch (block.type) {
    case "pick": {
      const where = block.matchLabel.trim() || block.id;
      if (isBlank(block.matchLabel)) warnings.push(`Pick block "${block.id}" has no match label.`);
      if (isBlank(block.selectionLabel)) warnings.push(`Pick "${where}" has no selection — the reader cannot tell what is being tipped.`);
      // On ne fabrique JAMAIS de cote : si le champ est vide, le badge disparaît et on le signale.
      if (isBlank(block.oddsLabel)) warnings.push(`Pick "${where}" has no odds label — the odds badge is not rendered.`);
      if (isBlank(block.href) !== isBlank(block.ctaLabel)) {
        warnings.push(`Pick "${where}" needs both a link and a button label to show its call to action — one of them is missing.`);
      }
      break;
    }

    case "odds_table": {
      const filled = block.rows.filter((r) => !isBlank(r.label) || !isBlank(r.value));
      if (filled.length === 0) warnings.push(`Odds table "${block.id}" is empty — every row is blank.`);
      else if (block.rows.some((r) => isBlank(r.label) || isBlank(r.value))) {
        warnings.push(`Odds table "${block.id}" has rows with a missing label or value — they render as empty cells.`);
      }
      break;
    }

    case "standings": {
      if (block.rows.length === 0) warnings.push(`Standings block "${block.id}" has no row — only the header is rendered.`);
      const ragged = block.rows.some((cells) => cells.length !== block.columns.length);
      if (ragged) {
        warnings.push(
          `Standings block "${block.id}" has rows that do not match its ${block.columns.length} columns — missing cells render empty, extra ones are dropped.`,
        );
      }
      break;
    }

    case "article": {
      const where = block.title.trim() || block.id;
      if (isBlank(block.title)) warnings.push(`Article block "${block.id}" has no title.`);
      if (block.imageSrc !== undefined) {
        // Vignette d'article : un alt vide n'est un défaut QUE si aucun titre ne nomme l'image.
        // Avec un titre, la vignette est décorative et `alt=""` est ce que WCAG demande — le crier
        // à chaque article importé noyait les vrais blocages sous cinq lignes de bruit.
        // Même condition que `EmailDocPublishable` : deux seuils différents feraient afficher un
        // blocage que la publication accepte, ou l'inverse.
        if (isBlank(block.imageAlt) && isBlank(block.title)) {
          warnings.push(`Article image on "${where}" has no alt text — required before publishing.`);
        }
        if (/^http:\/\//i.test(block.imageSrc)) {
          warnings.push(`Article image on "${where}" is served over http:// — it will be blocked or flagged.`);
        }
        if (isPlaceholderSrc(block.imageSrc)) {
          warnings.push(
            `Article image on "${where}" is still an AI placeholder — generate or upload the picture, otherwise recipients get a broken image.`,
          );
        }
      }
      // ⛔ AUCUN CONTRÔLE SUR L'ABSENCE DE `ctaLabel` ICI, ET IL NE FAUT PAS EN REMETTRE : ce qui
      // arrive jusqu'à cette fonction est TOUJOURS passé par `withDefaultCta` (feed.ts), qui pose
      // le libellé de `meta.locale` sur tout article qui n'en porte pas. Une règle qui ne peut plus
      // tirer immobilise des tests et fait croire à une couverture qui n'existe pas.
      break;
    }

    case "section_title": {
      if (isBlank(block.label)) {
        warnings.push(`Section title "${block.id}" has no label — only the rule is rendered.`);
      }
      break;
    }

    case "callout": {
      const where = block.title.trim() || block.id;
      // Une tuile de mise en page qui ne porte QUE son bouton n'est pas vide (même règle que
      // `EmailDocPublishable`) : les deux tuiles du « Duo ».
      const boutonSeul = block.layout !== undefined && block.href !== undefined && !isBlank(block.ctaLabel);
      if (isBlank(block.title) && isBlank(block.body) && !boutonSeul) {
        warnings.push(`Callout "${block.id}" has neither a title nor a body — it renders as an empty panel.`);
      }
      // ⛔ MISES EN PAGE (23/09/2026). La photo de fond ne s'affiche pas partout (Outlook par défaut,
      // clients sans images, Gmail IMAP) : ce que le lecteur voit alors, c'est l'aplat de repli.
      // Sans lui, un texte clair posé sur la photo tombe sur le fond du contenu — illisible.
      // Pochette exceptée : son texte est sur la carte, la photo n'y est qu'une case (`stubBackground`).
      if (block.layout !== undefined && block.layout !== "cover" && block.backgroundImage !== undefined && block.style?.backgroundColor === undefined) {
        warnings.push(
          `Callout "${where}" has a background picture but no fallback colour — set the block background: it is what readers see when images are off.`,
        );
      }
      const fonds = [
        ...(block.backgroundImage === undefined ? [] : [{ src: block.backgroundImage, quoi: "background picture" }]),
        ...(block.gallery ?? []).map((t, i) => ({ src: t.src, quoi: `gallery picture ${i + 1}` })),
      ];
      for (const { src, quoi } of fonds) {
        if (/^http:\/\//i.test(src)) warnings.push(`Callout ${quoi} on "${where}" is served over http:// — it will be blocked or flagged.`);
        if (isPlaceholderSrc(src)) {
          warnings.push(
            `Callout ${quoi} on "${where}" is still an AI placeholder — generate or upload the picture, otherwise recipients get a broken image.`,
          );
        }
      }
      // Une case sans alt est une case VIDE quand l'image est bloquée, et le compilateur ne l'enveloppe
      // pas dans le lien (un lien sans nom n'annonce que « lien » au lecteur d'écran).
      (block.gallery ?? []).forEach((t, i) => {
        if (isBlank(t.alt)) {
          warnings.push(`Callout gallery picture ${i + 1} on "${where}" has no alt text — readers with images off see an empty square, and it is not linked.`);
        }
      });
      // La vignette d'encart passe par EXACTEMENT les mêmes contrôles que celle d'un article :
      // sans eux, une image en http:// ou une sentinelle de placeholder partait sans un mot, et la
      // réparation https proposée par le pré-vol pour `callout → imageSrc` n'était jamais atteinte
      // faute d'avertissement pour la déclencher.
      if (block.imageSrc !== undefined) {
        if (isBlank(block.imageAlt) && isBlank(block.title)) {
          warnings.push(`Callout image on "${where}" has no alt text — required before publishing.`);
        }
        if (/^http:\/\//i.test(block.imageSrc)) {
          warnings.push(`Callout image on "${where}" is served over http:// — it will be blocked or flagged.`);
        }
        if (isPlaceholderSrc(block.imageSrc)) {
          warnings.push(
            `Callout image on "${where}" is still an AI placeholder — generate or upload the picture, otherwise recipients get a broken image.`,
          );
        }
      }
      // Les deux sens : un libellé sans lien ne rend aucun bouton, un lien sans libellé non plus.
      // Le dire dans les deux cas, sinon la moitié du défaut reste muette.
      if (!isBlank(block.ctaLabel) && block.href === undefined) {
        warnings.push(`Callout "${where}" has a button label but no link — its button is not rendered.`);
      }
      if (block.href !== undefined && isBlank(block.ctaLabel)) {
        warnings.push(`Callout "${where}" has a link but no button label — its button is not rendered.`);
      }
      break;
    }

    case "scoreboard": {
      const filled = block.rows.filter((r) => !isBlank(r.label) || !isBlank(r.value));
      if (filled.length === 0) warnings.push(`Scoreboard "${block.id}" is empty — every row is blank.`);
      else if (block.rows.some((r) => isBlank(r.label) || isBlank(r.value))) {
        warnings.push(`Scoreboard "${block.id}" has rows with a missing label or value — they render as empty cells.`);
      }
      break;
    }

    case "promo": {
      const where = block.headline.trim() || block.id;
      if (isBlank(block.headline)) warnings.push(`Promo block "${block.id}" has no headline.`);
      if (isBlank(block.ctaLabel)) warnings.push(`Promo "${where}" has no button label — its call to action is not rendered.`);
      if (isBlank(block.terms)) {
        warnings.push(`Promo "${where}" carries no terms — an offer without its conditions is a regulatory risk in most markets.`);
      }
      break;
    }

    default:
      break;
  }
}

function collectWarnings(doc: EmailDoc, sizeBytes: number): string[] {
  const warnings: string[] = [];

  if (doc.meta.subject.trim() === "") warnings.push("Subject line is empty.");
  if (doc.meta.preheader.trim() === "") {
    warnings.push("Preheader is empty — inboxes will show the first words of the email instead.");
  }

  if (sizeBytes > GMAIL_CLIP_BYTES) {
    const kb = Math.round(sizeBytes / 1024);
    warnings.push(
      `Email weighs ${kb} KB — over the ${Math.round(GMAIL_CLIP_BYTES / 1024)} KB Gmail clipping threshold. Everything past the cut, including the unsubscribe footer, is hidden behind "View entire message".`,
    );
  }

  let hasFooter = false;

  eachBlock(doc, (block, _path, row, column) => {
    if (block.type === "footer_legal") {
      hasFooter = true;
      // Le bloc lui-même ne peut pas porter de condition (schéma), mais sa row ou sa colonne, si.
      // Ce serait un envoi sans lien de désabonnement pour une partie de la liste : refusé à la
      // publication (`EmailDocPublishable`), signalé ici dès l'aperçu.
      if (row.visibleIf !== undefined || column.visibleIf !== undefined) {
        warnings.push(
          "The legal footer sits inside a conditional row or column — recipients who fail the condition would receive an email with no unsubscribe link. Remove the condition.",
        );
      }
    }

    businessWarnings(block, warnings);

    if (block.type === "image") {
      if (block.alt.trim() === "") {
        warnings.push(`Image "${block.src}" has no alt text — required before publishing.`);
      }
      if (/^http:\/\//i.test(block.src)) {
        warnings.push(`Image "${block.src}" is served over http:// — it will be blocked or flagged.`);
      }
      if (isPlaceholderSrc(block.src)) {
        warnings.push(
          `Image "${block.alt || block.id}" is still an AI placeholder — generate or upload the picture, otherwise recipients get a broken image.`,
        );
      }
    }

    if (block.type === "button" && block.label.length > MAX_BUTTON_LABEL) {
      warnings.push(
        `Button label "${block.label}" is ${block.label.length} characters — over ${MAX_BUTTON_LABEL}, it wraps in Outlook.`,
      );
    }

    if (block.type === "html") {
      warnings.push(
        "Raw HTML block: its markup is passed through untouched and is not checked for email client compatibility.",
      );
    }

    for (const { href, where } of hrefsOf(block)) {
      const trimmed = href.trim();
      if (isPlaceholderHref(trimmed)) {
        warnings.push(`Placeholder link on ${where} — "#" goes nowhere.`);
      } else if (/^http:\/\//i.test(trimmed)) {
        warnings.push(`Insecure http:// link on ${where} — use https://.`);
      }
    }
  });

  if (!hasFooter) {
    warnings.push(
      "No legal footer block — the compliance footer (unsubscribe, sender identity) will not be injected and the send will be vetoed.",
    );
  }
  return warnings;
}
