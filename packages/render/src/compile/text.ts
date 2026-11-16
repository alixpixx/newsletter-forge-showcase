/**
 * Version TEXTE de l'email — générée depuis le DOCUMENT, jamais depuis le HTML compilé.
 *
 * Pourquoi : dégrader du HTML donne toujours une soupe (ghost tables Outlook, VML, styles
 * inline). Depuis le doc on connaît l'intention — un titre reste un titre, un bouton reste
 * « LABEL: url », un lien inline garde son URL entre parenthèses.
 *
 * Le résultat contient les MÊMES tokens `{{…}}` que le HTML : le worker hydrate les deux shells
 * avec le même jeu de variables (`hydrateText` pour celui-ci, pas d'échappement HTML).
 */
import { CONDITION_END, conditionMarker, type Block, type EmailDoc, type Paragraph, type VisibleIf } from "../schema";
import { defaultFirstName, poserRepliPrenom } from "../hydrate";

/** Filet par défaut (40 tirets). `meta.plainText.rule` le remplace, sous le preheader ET pour chaque séparateur. */
const RULE = "----------------------------------------";

/**
 * Assemble des libellés en une ligne sans jamais inventer de mot : la version texte part chez des
 * abonnés dans six langues, y glisser un « Odds: » anglais traduirait mal partout. Seule la
 * ponctuation structure — c'est aussi ce que font déjà `[alt] url` et `LABEL: url`.
 */
const line = (parts: (string | undefined)[]): string =>
  parts.map((p) => (p ?? "").trim()).filter((p) => p !== "").join(" : ");

const stack = (parts: (string | undefined)[]): string =>
  parts.map((p) => (p ?? "").trim()).filter((p) => p !== "").join("\n");

/**
 * Recolle un texte et son accent en UNE ligne — « Noticias » + « · 13:50 ».
 *
 * En HTML les deux moitiés sont séparées pour porter deux couleurs ; en texte brut la couleur
 * n'existe pas, il ne reste que la phrase. Les recoller ici plutôt qu'en deux entrées de `stack`
 * évite qu'elles tombent sur deux lignes, ce qui ferait lire « Noticias » puis « · 13:50 ».
 */
const glue = (text: string | undefined, accent: string | undefined): string =>
  `${text ?? ""}${accent ?? ""}`.replace(/\u00a0/g, " ").trim();

/** `LABEL: url`, à l'identique du bloc bouton — un seul idiome de CTA dans tout le texte. */
const cta = (label: string | undefined, href: string): string =>
  label === undefined || label.trim() === "" ? href : `${label.toUpperCase()}: ${href}`;

/** Aplati les spans d'un paragraphe ; un lien devient `texte (url)`. */
function paragraphToText(p: Paragraph): string {
  return p.spans
    .map((span) => {
      const text = span.text;
      if (span.href && text.trim() !== "") return `${text} (${span.href})`;
      if (span.href) return span.href;
      return text;
    })
    .join("")
    .trim();
}

/**
 * Réduction très conservatrice d'un bloc `html` : on retire les balises et on décode les
 * entités les plus courantes. C'est une échappatoire, pas un parseur — on ne prétend pas mieux.
 */
function htmlToText(raw: string): string {
  return raw
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function blockToText(block: Block, rule: string): string {
  switch (block.type) {
    case "text": {
      const body = block.paragraphs.map(paragraphToText).filter((l) => l !== "").join("\n");
      if (block.preset === "h1" || block.preset === "h2" || block.preset === "h3") {
        return body === "" ? "" : `${body.toUpperCase()}\n${"=".repeat(Math.min(body.length, 40))}`;
      }
      return body;
    }
    case "image": {
      const label = block.alt.trim() === "" ? "image" : block.alt.trim();
      return block.href ? `[${label}] ${block.href}` : `[${label}]`;
    }
    case "button":
      return `${block.label.toUpperCase()}: ${block.href}`;
    case "divider":
      return rule;
    case "spacer":
      return "";
    case "html":
      return htmlToText(block.raw);
    case "social":
      return block.items.map((i) => `${i.label ?? i.platform}: ${i.href}`).join("\n");
    case "menu":
      return block.items.map((i) => `${i.label}: ${i.href}`).join("\n");
    case "pick":
      return stack([
        block.matchLabel,
        block.kickoffLabel,
        line([block.marketLabel, block.selectionLabel, block.oddsLabel]),
        block.confidenceLabel,
        block.href === undefined ? "" : cta(block.ctaLabel, block.href),
      ]);
    case "odds_table":
      // Un tableau devient des lignes « libellé : valeur » — lisible dans n'importe quel client texte.
      return stack([...block.rows.map((r) => line([r.label, r.value])), block.caption]);
    case "standings":
      // Colonnes séparées par des barres : la seule mise en forme qui survive à une police
      // proportionnelle, l'alignement par espaces se disloquant dès que le client change de police.
      return stack([
        block.columns.join(" | "),
        ...block.rows.map((cells) => block.columns.map((_, i) => (cells[i] ?? "").trim()).join(" | ")),
        block.caption,
      ]);
    case "section_title": {
      // Même idiome que les presets h1/h2/h3 du bloc texte : le libellé, souligné. Le filet du
      // rendu HTML n'a pas d'équivalent utile en texte brut.
      const label = block.label.trim();
      return label === "" ? "" : `${label.toUpperCase()}\n${"-".repeat(Math.min(label.length, 40))}`;
    }
    case "callout":
      return stack([
        block.kicker,
        block.title,
        block.body,
        block.href === undefined ? "" : cta(block.ctaLabel, block.href),
      ]);
    case "scoreboard":
      // Comme `odds_table` : des lignes « libellé : valeur », lisibles dans tout client texte.
      return stack([
        block.kicker,
        ...block.rows.map((r) => line([r.label, r.value])),
        // Le pied porte un vrai lien : le perdre en texte brut ferait disparaître « What we
        // learned » pour les lecteurs qui n'ont que cette version.
        // ⛔ MÊME CONDITION QUE `scoreboardHtml` : sans libellé, le HTML n'émet AUCUNE ancre. Rendre
        // ici `cta(undefined, href)` imprimait une URL nue que personne ne voit dans l'autre
        // version — un lien qui n'existe que dans la moitié texte est un lien que rien ne relit.
        block.footerLabel === undefined || block.footerLabel.trim() === ""
          ? ""
          : block.footerHref === undefined
            ? block.footerLabel
            : cta(block.footerLabel, block.footerHref),
        block.footerNote,
      ]);
    case "article": {
      // ⛔ `ctaStyle:"none"` retire le lien de LECTURE (« Leer la nota »), PAS l'accès à l'article.
      // En HTML l'URL reste atteignable : le titre et la vignette sont des ancres. En texte brut
      // rien n'est cliquable — sans la ligne ci-dessous, la carte partirait sans aucun moyen de
      // lire l'article, et c'est ce que faisait la première version de ce chantier : les cartes de
      // trois marques sur trois perdaient leur URL dans la partie text/plain.
      // Elle est posée SOUS LE TITRE, à l'endroit exact où le HTML porte l'ancre du titre.
      const sansLienDeLecture = block.ctaStyle === "none";
      return stack([
        glue(block.kicker, block.kickerAccent),
        block.title,
        sansLienDeLecture ? block.href : "",
        block.excerpt,
        glue(block.meta, block.metaAccent),
        sansLienDeLecture ? "" : cta(block.ctaLabel, block.href),
      ]);
    }
    case "promo":
      return stack([block.headline, block.body, block.code, cta(block.ctaLabel, block.href), block.terms]);
    // Inatteignable : les flux sont dépliés en blocs article avant le rendu (voir `feed.ts`).
    case "article-feed":
      return "";
    case "footer_legal":
      // Pendant textuel de `{{legal_footer_html}}` — hydraté par le worker sans échappement.
      return "{{legal_footer_text}}";
  }
}

interface Chunk {
  text: string;
  cond?: VisibleIf;
}

/**
 * Assemble des fragments séparés par une ligne vide, en plaçant le séparateur À L'INTÉRIEUR du
 * marqueur conditionnel : un fragment retiré à l'envoi emporte sa ligne vide avec lui, au lieu de
 * laisser un trou de quatre lignes au milieu de la version texte. Sans aucune condition, le
 * résultat est exactement celui d'un `join("\n\n")`.
 *
 * Limite assumée : quand c'est le PREMIER fragment d'un groupe qui disparaît, une ligne vide de
 * trop subsiste. La supprimer demanderait d'imbriquer le séparateur dans les deux conditions
 * voisines — beaucoup de mécanique pour un blanc dans la partie texte, que presque personne ne lit.
 */
function joinChunks(chunks: Chunk[]): string {
  return chunks
    .map((chunk, i) => {
      const body = (i === 0 ? "" : "\n\n") + chunk.text;
      return chunk.cond === undefined ? body : `${conditionMarker(chunk.cond)}${body}${CONDITION_END}`;
    })
    .join("");
}

/** Rend le `text_shell` : tokens et marqueurs `nf:if` NON résolus, comme le `html_shell`. */
export function renderText(doc: EmailDoc): string {
  const parts: Chunk[] = [];
  // Réglages de la version texte (22/09/2026). Absents : pas d'en-tête, preheader recopié, 40 tirets.
  const reglage = doc.meta.plainText;
  const rule = reglage?.rule ?? RULE;

  if (reglage?.header !== undefined && reglage.header.trim() !== "") {
    parts.push({ text: reglage.header.trim() });
  }
  if (reglage?.includePreheader !== false && doc.meta.preheader.trim() !== "") {
    parts.push({ text: doc.meta.preheader.trim() });
    parts.push({ text: rule });
  }

  // Regroupé par row puis par colonne pour pouvoir encadrer chaque niveau de ses marqueurs.
  for (const row of doc.rows) {
    const rowParts: Chunk[] = [];
    for (const column of row.columns) {
      const colParts: Chunk[] = [];
      for (const block of column.blocks) {
        // Un bloc masqué sur mobile reste lu par les lecteurs texte : on le garde, c'est du contenu.
        const chunk = blockToText(block, rule).trim();
        // Le footer légal ne porte jamais de condition (voir `FooterLegalBlock`).
        if (chunk !== "") {
          colParts.push({ text: chunk, cond: block.type === "footer_legal" ? undefined : block.visibleIf });
        }
      }
      if (colParts.length > 0) rowParts.push({ text: joinChunks(colParts), cond: column.visibleIf });
    }
    if (rowParts.length > 0) parts.push({ text: joinChunks(rowParts), cond: row.visibleIf });
  }

  const text = joinChunks(parts)
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .concat("\n");
  // Même repli du prénom que le HTML (`patchHtml`) : les deux parties d'un envoi disent le même mot.
  return poserRepliPrenom(text, defaultFirstName(doc.meta.locale, doc.meta.firstNameFallback));
}
