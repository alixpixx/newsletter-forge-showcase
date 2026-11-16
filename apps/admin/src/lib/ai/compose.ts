/**
 * Étape 2 — COMPOSITION du document.
 *
 * 🔒 Claude ne produit JAMAIS de HTML : il produit un `EmailDoc` JSON validé par le MÊME schéma Zod
 * que le builder. Conséquence directe, et c'est tout l'intérêt : ce que l'IA génère s'ouvre et
 * s'édite dans l'éditeur comme un document fait à la main.
 *
 * Quatre verrous, du plus fort au plus faible :
 *   1. `EmailDoc.safeParse` — un doc non conforme est REJETÉ (une seule reprise, puis échec propre).
 *   2. Catalogue de blocs DÉRIVÉ du schéma et injecté dans le prompt : aucun type inconnu possible.
 *   3. Garde-fous post-parse : taille, `footer_legal` final obligatoire, href plausibles.
 *   4. Interdiction explicite des chiffres sportifs inventés (règle projet : jamais de cote fabriquée).
 */
import { BLOCK_TYPES, EmailDoc, type EmailDoc as EmailDocT } from "@nf/render/schema";
import { callClaude, parseJsonLoose, ClaudeError, type ClaudeUsage } from "./claude";
import { directionToTheme, type ArtDirectionT } from "./direction";

/**
 * SYSTEM PROMPT — STATIQUE et byte-stable (condition du prompt caching : la moindre variation
 * d'octet invalide le préfixe mis en cache, donc rien de dynamique ici).
 *
 * Le catalogue de blocs est écrit À LA MAIN parce que chaque type a besoin d'une documentation de
 * champs qu'aucune génération automatique ne produirait correctement. Le prix de ce choix, c'est la
 * DÉRIVE : quand un type est ajouté au schéma, ce prompt l'ignore en silence et l'IA ne s'en sert
 * jamais. `catalogueDrift()` plus bas rend cette dérive visible au lieu de la laisser passer.
 */
const SYSTEM = `You compose marketing emails for Example Media as a STRUCTURED DOCUMENT, never as HTML.

Answer with ONE JSON object and nothing else — no prose, no code fence:
{ "subject": "...", "preheader": "...", "rows": [ ... ] }

## Document structure
rows[] → each row: { "id": "r1", "layout": "1", "columns": [ { "id": "c1", "blocks": [ ... ] } ] }
- "layout" is one of exactly: "1", "1-1", "1-1-1", "1-1-1-1", "2-1", "1-2", "3-1", "1-3".
  The number of columns MUST match the layout ("1-1" → 2 columns, "2-1" → 2 columns, etc.).
- ids are short and unique across the whole document ("r1", "c1", "b1"…).

## The ONLY block types that exist. Any other type is invalid.
1. text     { "id","type":"text","preset":"h1"|"h2"|"h3"|"body"|"small",
              "paragraphs":[ { "spans":[ { "text":"…","bold":true?,"italic":true?,"href":"…"?,"color":"#rrggbb"? } ] } ] }
2. image    { "id","type":"image","src":"ai://short visual brief","alt":"required, describes the picture","widthPct":100,"align":"center" }
            → You cannot know any image URL. ALWAYS write "src" as "ai://" followed by a short visual
              brief for the illustrator (e.g. "ai://stadium floodlights at dusk, wide shot").
              A real picture replaces it in the next step. Never write http(s) in an image src.
3. button   { "id","type":"button","label":"max 28 chars","href":"…","align":"center" }
4. divider  { "id","type":"divider","thickness":1,"widthPct":100 }
5. spacer   { "id","type":"spacer","height":24 }
6. social   { "id","type":"social","items":[ { "platform":"…","href":"…" } ],"iconSize":24,"mode":"horizontal" }
7. menu     { "id","type":"menu","items":[ { "label":"…","href":"…" } ],"separator":"·" }
8. pick     { "id","type":"pick","matchLabel":"","marketLabel":"","selectionLabel":"","oddsLabel":"",
              "kickoffLabel":""?,"confidenceLabel":""?,"href":"…"?,"ctaLabel":"max 28 chars"? }
9. odds_table { "id","type":"odds_table","rows":[ { "label":"","value":"" } ],"caption":"…"? }  (2 to 12 rows)
10. standings  { "id","type":"standings","columns":["",""],"rows":[["",""]],"caption":"…"? }  (2 to 5 columns)
11. article  { "id","type":"article","title":"…","excerpt":"…","href":"…","imageSrc":"ai://brief"?,
              "imageAlt":"required when imageSrc is set","ctaLabel":"max 28 chars"?,"layout":"stacked"|"side" }
            → Leave "ctaLabel" out. The renderer adds the read-more label in the document's own
              language, and knows to skip it when the link goes nowhere.
12. promo    { "id","type":"promo","headline":"…","body":"…"?,"code":"…"?,"terms":"…"?,
              "href":"…","ctaLabel":"max 28 chars" }
13. footer_legal { "id","type":"footer_legal" }
14. section_title { "id","type":"section_title","label":"max 120 chars",
              "rule":"after"|"under"|"none","ruleColor":"#rrggbb"?,"ruleThickness":2 }
            → A section heading with a rule that fills the remaining width. Use it to open a
              section ("Today's stories"), not as a substitute for a text block.
15. callout  { "id","type":"callout","kicker":"short line above the title, may be \"\"",
              "title":"…","body":"…","href":"…"?,"ctaLabel":"max 28 chars"?,
              "accentWidth":0,"accentColor":"#rrggbb"?,"kickerColor":"#rrggbb"? }
            → A coloured panel: kicker, title, body, optional button. Set the panel colour with
              "style":{"backgroundColor":"#rrggbb"}. Write "href" AND "ctaLabel" together or
              neither — a label without a link renders no button at all.
16. scoreboard { "id","type":"scoreboard","kicker":"","rows":[ { "label":"","value":"","highlight":false } ] }
              (2 to 4 rows)
Do NOT emit an "html" block. Do NOT invent fields — unknown keys make the document invalid.

## ⛔ THE FOUR SPORTS BLOCKS ARE SCAFFOLDING, NOT DATA
The blocks pick, odds_table, standings and scoreboard exist so you can LAY OUT a page the editor
then fills in.
Emit them with EVERY data field as an EMPTY STRING "" — no match name, no market, no selection,
no odds, no team, no position, no number, no score. You may fill "caption", and the column HEADERS of a
standings table when the brief names them (e.g. "Team", "P", "Pts"), because those are labels, not
results. Anything that looks like a real fixture, a real odd or a real ranking is a fabrication, and
fabricating a betting odd is the single most serious mistake you can make here.
Use them only when the brief actually calls for that shape. A newsletter with nothing to tip needs
none of them.
The blocks article and promo carry no sports data: write them fully, as real copy.

## Email constraints (this is email, not a web page)
- Content is 600 px wide. No flexbox, no grid, no absolute positioning — you only choose rows and columns.
- Exactly ONE primary call to action (one prominent button). Extra links go in text spans.
- Every image needs a non-empty, descriptive "alt": images are blocked by default in Outlook and Gmail.
- Never put the call to action inside an image.
- The LAST block of the LAST row is ALWAYS { "type":"footer_legal" }. Never write your own footer,
  never write an unsubscribe link, never write a postal address: the platform injects the compliant
  footer itself, with signed unsubscribe links. Writing your own would be a GDPR/LGPD violation.
- Do not add a "view in browser" link: no such page is served.

## Copy
- Write in the language you are told to use, in the brand's voice. Concrete and specific, never filler.
- Personalisation tokens are allowed inside text and subject: {{first_name}}, {{asset_name}}.
  Write them literally; they are substituted per recipient at send time.
- ⛔ NEVER invent sports data: no odds, no scores, no standings, no player statistics, no dates of
  matches. If the brief implies them, write a placeholder sentence the editor will fill in, and say so.
  Fabricating a betting odd is the single most serious mistake you can make here.
- Links: only use URLs given in the brief, or relative paths like "/picks", or a token. Never invent a
  domain — an invented link is worse than no link.

## Length
Between 3 and 8 rows. Never more than 40 blocks in total. Aim for something a human would actually read.`;

/**
 * Types que le prompt ci-dessus documente réellement. À tenir à jour EN MÊME TEMPS que le prompt.
 * `html` est absent volontairement : l'IA n'a pas le droit d'en émettre.
 */
const DOCUMENTED_BLOCKS = [
  "text",
  "image",
  "button",
  "divider",
  "spacer",
  "social",
  "menu",
  "pick",
  "odds_table",
  "standings",
  "article",
  "promo",
  "footer_legal",
  "section_title",
  "callout",
  "scoreboard",
] as const;

/** Types que l'IA ne doit jamais produire, même s'ils existent au schéma. */
const DELIBERATELY_OMITTED = new Set<string>(["html"]);

/**
 * Écart entre le schéma et ce que le prompt documente.
 *
 * Motif concret : un type ajouté au schéma sans être ajouté ici n'est pas une erreur de compilation,
 * juste une capacité que l'IA n'utilisera jamais — le genre de manque qu'on ne remarque qu'au bout
 * de plusieurs semaines. On le remonte donc dans les avertissements de la génération.
 */
export function catalogueDrift(): string[] {
  const documented = new Set<string>(DOCUMENTED_BLOCKS);
  const out: string[] = [];

  for (const t of BLOCK_TYPES) {
    if (!documented.has(t) && !DELIBERATELY_OMITTED.has(t)) {
      out.push(`Block type "${t}" exists in the schema but is not described in the AI prompt — the generator will never use it.`);
    }
  }
  for (const t of documented) {
    if (!(BLOCK_TYPES as readonly string[]).includes(t)) {
      out.push(`The AI prompt describes block type "${t}", which no longer exists in the schema.`);
    }
    // Un type documenté mais absent du texte du prompt = documentation fantôme.
    if (!SYSTEM.includes(`"${t}"`)) {
      out.push(`Block type "${t}" is listed as documented but does not appear in the prompt text.`);
    }
  }
  return out;
}

function userMessage(a: {
  direction: ArtDirectionT;
  brief: string;
  assetName: string;
  locale: string;
  category: string;
  name: string;
  repairIssues?: string[];
  previousAttempt?: string;
}): string {
  const base = `Brand: ${a.assetName}
Language for all copy: ${a.locale}
Template kind: ${a.category}
Template name (label only, not content): ${a.name}

Design direction to respect:
- mood: ${a.direction.mood}
- brand colour: ${a.direction.palette.brandColor} · text: ${a.direction.palette.textColor} · background: ${a.direction.palette.contentBackground}
- density: ${a.direction.density} · corner radius: ${a.direction.radius}px · content width: ${a.direction.contentWidth}px
${a.direction.notes ? `- notes: ${a.direction.notes}` : ""}

Brief from the marketer:
${a.brief || "(no brief — build a solid default newsletter for this brand and kind)"}`;

  if (!a.repairIssues?.length) return base;

  return `${base}

## YOUR PREVIOUS ANSWER WAS REJECTED
The document did not validate. Fix exactly these problems and answer again with the full JSON object:
${a.repairIssues.map((i) => `- ${i}`).join("\n")}

Your previous answer, for reference:
${(a.previousAttempt ?? "").slice(0, 4000)}`;
}

interface ModelAnswer {
  subject?: unknown;
  preheader?: unknown;
  rows?: unknown;
}

export interface ComposeResult {
  doc: EmailDocT;
  subject: string;
  preheader: string;
  warnings: string[];
  usage: ClaudeUsage;
  model: string;
  repaired: boolean;
}

export async function composeDoc(a: {
  direction: ArtDirectionT;
  brief: string;
  assetName: string;
  assetSlug: string;
  locale: string;
  category: string;
  name: string;
}): Promise<ComposeResult> {
  const usageTotal: ClaudeUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const addUsage = (u: ClaudeUsage) => {
    usageTotal.inputTokens += u.inputTokens;
    usageTotal.outputTokens += u.outputTokens;
    usageTotal.cacheReadTokens += u.cacheReadTokens;
    usageTotal.cacheWriteTokens += u.cacheWriteTokens;
  };

  let repairIssues: string[] | undefined;
  let previousAttempt: string | undefined;
  let model = "";

  // Une seule reprise : au-delà, on boucle sur du crédit sans converger.
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await callClaude({
      system: SYSTEM,
      userContent: userMessage({ ...a, repairIssues, previousAttempt }),
      // Marge large : `max_tokens` plafonne raisonnement + texte, et un JSON tronqué au milieu est
      // le mode d'échec le plus frustrant à diagnostiquer.
      maxTokens: 32_000,
      timeoutMs: 240_000,
      // La composition est la seule etape ou la qualite justifie la profondeur.
      effort: "high",
    });
    addUsage(res.usage);
    model = res.model;

    const answer = parseJsonLoose<ModelAnswer>(res.text);
    const subject = typeof answer.subject === "string" ? answer.subject.trim() : "";
    const preheader = typeof answer.preheader === "string" ? answer.preheader.trim() : "";

    const candidate = {
      schema: 2,
      meta: { subject, preheader, assetSlug: a.assetSlug, locale: a.locale },
      theme: directionToTheme(a.direction),
      rows: answer.rows,
    };

    const parsed = EmailDoc.safeParse(candidate);
    if (parsed.success) {
      const { doc, warnings } = applyGuardrails(parsed.data);
      return {
        doc,
        subject: doc.meta.subject,
        preheader: doc.meta.preheader ?? "",
        // La dérive de catalogue est un défaut de NOTRE code, pas du document produit : elle sort
        // avec les avertissements pour être vue, sans faire échouer une génération par ailleurs bonne.
        warnings: [...warnings, ...catalogueDrift()],
        usage: usageTotal,
        model,
        repaired: attempt > 0,
      };
    }

    repairIssues = parsed.error.issues.slice(0, 25).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    previousAttempt = res.text;
  }

  throw new ClaudeError(
    "Claude could not produce a document matching our block schema, even after one repair attempt.",
    "bad_response",
    repairIssues ?? [],
  );
}

/* ------------------------------------------------------------------ garde-fous */

/** Hôtes acceptés dans un `href` absolu : ceux de la marque + le site public de la plateforme. */
function allowedHost(href: string, assetSlug: string): boolean {
  try {
    const u = new URL(href);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    const h = u.hostname.toLowerCase();
    const slugCore = assetSlug.replace(/-/g, "");
    return h.includes(assetSlug) || h.replace(/[.-]/g, "").includes(slugCore) || h.endsWith("example.com");
  } catch {
    return false;
  }
}

/**
 * Applique les garde-fous non exprimables en Zod. On NEUTRALISE plutôt que de rejeter : un lien
 * inventé est vidé et signalé, ce qui laisse un document utilisable au lieu d'un échec total.
 */
export function applyGuardrails(input: EmailDocT): { doc: EmailDocT; warnings: string[] } {
  const warnings: string[] = [];
  const doc: EmailDocT = structuredClone(input);
  const assetSlug = doc.meta.assetSlug ?? "";

  const keepHref = (href: string | undefined, label: string): string | undefined => {
    if (!href) return undefined;
    // Tokens de fusion et chemins relatifs : toujours acceptés (résolus plus tard).
    if (href.startsWith("{{") || href.startsWith("/") || href.startsWith("mailto:")) return href;
    if (allowedHost(href, assetSlug)) return href;
    warnings.push(`Removed an invented link on ${label}: ${href}`);
    return undefined;
  };

  let blockCount = 0;
  for (const row of doc.rows) {
    for (const col of row.columns) {
      for (const block of col.blocks) {
        blockCount++;
        if (block.type === "button") {
          const kept = keepHref(block.href, `button "${block.label}"`);
          // Un bouton sans href ne veut rien dire : on retombe sur un placeholder explicite.
          block.href = kept ?? "#";
          if (!kept) warnings.push(`Button "${block.label}" now points to "#" — set a real link before publishing.`);
        } else if (block.type === "image") {
          block.href = keepHref(block.href, "an image");
          if (!block.alt.trim()) warnings.push("An image has an empty alt text — required before publishing.");
        } else if (block.type === "menu") {
          block.items = block.items.map((it) => ({ ...it, href: keepHref(it.href, `menu item "${it.label}"`) ?? "#" }));
        } else if (block.type === "social") {
          block.items = block.items.filter((it) => {
            const ok = keepHref(it.href, `social link "${it.platform}"`);
            return ok !== undefined;
          });
          if (block.items.length === 0) warnings.push("A social block had only invented links and was left empty.");
        } else if (block.type === "article") {
          // Le href passe par `keepHref` comme toutes les branches sœurs : c'est le SEUL endroit du
          // dépôt où le lien d'un article est contrôlé, et un lien refusé retombe sur « # ».
          //
          // ⛔ AUCUN `ctaLabel` N'EST ÉCRIT ICI, ET AUCUN N'EST EFFACÉ. Le défaut se pose au RENDU
          // et nulle part ailleurs (`withDefaultCta`, packages/render/src/feed.ts). C'est ce qui
          // rend vraie l'équivalence « un libellé présent dans un document ⇒ un humain l'a tapé »,
          // dont la garde du rendu se sert pour distinguer une saisie d'une absence.
          //   · L'ÉCRIRE la rompait : le modèle rendait un href de marque valide, on posait le
          //     libellé en base, l'auteur constatait ensuite un 404 et remplaçait le lien par « # »
          //     dans l'inspecteur. Au rendu, la garde voyait un libellé rempli, le prenait pour une
          //     saisie, sortait AVANT de regarder le href, et l'email expédiait une ancre morte.
          //   · L'EFFACER était pire : la route qui applique les suggestions repasse ces garde-fous
          //     sur le document renvoyé par le client. Un article pointant hors des hôtes autorisés
          //     — lien d'affiliation, site partenaire, redirecteur — y perdait un `ctaLabel` que
          //     l'auteur avait pu taper à la main, sans que rien ne le dise. On n'efface jamais une
          //     saisie humaine.
          // L'avertissement ci-dessous est le bon traitement de ce cas : il parle à l'auteur DANS
          // l'éditeur, là où le lien se corrige. Et sur un « # », la garde du rendu ne fabriquera
          // de toute façon aucun bouton.
          const kept = keepHref(block.href, `article "${block.title.trim() || block.id}"`);
          block.href = kept ?? "#";
          if (!kept) warnings.push(`Article "${block.title.trim() || block.id}" now points to "#" — set a real link before publishing.`);
        } else if (block.type === "text") {
          for (const p of block.paragraphs) {
            for (const s of p.spans) {
              if (s.href) s.href = keepHref(s.href, "a text link");
            }
          }
        }
      }
    }
  }

  if (doc.rows.length > 14) {
    doc.rows = doc.rows.slice(0, 14);
    warnings.push("The document had more than 14 rows and was truncated.");
  }
  if (blockCount > 60) warnings.push(`The document has ${blockCount} blocks — that is a lot for one email.`);

  // `footer_legal` DOIT terminer le document : c'est le point d'injection du footer conforme, et le
  // worker refuse d'envoyer un shell qui n'en a pas (veto `footer_incomplete`).
  const hasFooter = doc.rows.some((r) => r.columns.some((c) => c.blocks.some((b) => b.type === "footer_legal")));
  if (!hasFooter) {
    doc.rows.push({
      id: `r-footer-${doc.rows.length + 1}`,
      layout: "1",
      columns: [{ id: `c-footer-${doc.rows.length + 1}`, blocks: [{ id: `b-footer-${doc.rows.length + 1}`, type: "footer_legal" }] }],
    } as EmailDocT["rows"][number]);
    warnings.push("The legal footer block was missing and has been appended.");
  } else {
    const lastRow = doc.rows[doc.rows.length - 1]!;
    const lastCol = lastRow.columns[lastRow.columns.length - 1]!;
    const lastBlock = lastCol.blocks[lastCol.blocks.length - 1];
    if (lastBlock?.type !== "footer_legal") {
      warnings.push("The legal footer is not the last block — it will still render, but check the order.");
    }
  }

  if (!doc.meta.subject.trim()) warnings.push("The subject line is empty.");

  return { doc, warnings };
}

/*
 * ⚠️ Pas de fonction « quelles images restent à générer ? » ici.
 *
 * Elle a existé, et elle mentait : elle ne reconnaissait que `src === ""` alors que la composition
 * pose désormais la sentinelle `ai://<brief>`. Résultat, elle renvoyait zéro illustration à générer
 * pour un document qui en attendait une — donc une image que l'utilisateur ne pouvait jamais remplir,
 * et un document définitivement impubliable.
 *
 * La règle vit à UN SEUL endroit : `isPlaceholderSrc()` dans `@nf/render/schema`, utilisée par le
 * garde-fou de publication, par les avertissements du compilateur et par `pendingImages()` côté
 * client. Une seconde définition finit toujours par diverger de la première.
 */
