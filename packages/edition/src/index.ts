/**
 * ---------------------------------------------------------------------------
 * @nf/edition — LA fin du gel d'une édition, une seule fois pour tout le monde.
 * ---------------------------------------------------------------------------
 *
 * ⛔ POURQUOI CE PACKAGE EXISTE (relecture d'édition, 0079). Une édition de série est arrêtée par le
 * GEL du worker (`apps/worker/src/planner.ts`). Depuis le 22/09/2026, un humain peut la RELIRE avant
 * l'envoi — cacher ou corriger un article, réécrire l'introduction du modèle, changer le sujet — et
 * l'admin doit lui MONTRER l'e-mail qui partira. Trois appelants, donc : le gel, la recompilation
 * après relecture (worker), l'aperçu (admin). Si l'aperçu recopiait la fin du gel, les deux copies
 * finiraient par diverger — c'est exactement le défaut « l'e-mail ne ressemblait pas au builder » — et
 * la relecture validerait un e-mail que personne ne recevra. Il n'y a donc qu'UNE fonction,
 * `finaliserEdition`, que les trois importent ; un banc prouve qu'elle rend le même octet aux deux
 * bouts (worker et admin).
 *
 * ⛔ CE PACKAGE NE CONNAÎT PAS LA BASE. Il reçoit la base figée et l'écart, rend des colonnes ;
 * l'appelant les écrit (le worker) ou les montre (l'admin).
 *
 * ⚠️ SERVEUR SEULEMENT (`node:crypto`, `Buffer`, et MJML chargé à la demande). L'écran importe
 * `@nf/edition/regles`, qui est pur.
 */
import { createHash } from "node:crypto";
import { poserPreheader } from "@nf/render/hydrate";
import { UTM_DEFAULTS, applyUtm, utmSlug } from "@nf/render/links";
// ⚠️ Imports de TYPE : effacés à la compilation. Le compilateur n'est chargé qu'à la demande, plus bas.
import type { EmailDoc } from "@nf/render";
import type { BrandPartials } from "@nf/render/compile";
import {
  FIRST_ARTICLE_TOKEN,
  appliquerArticles,
  countArticles,
  firstArticleTitle,
  type EditionBase,
  type EditionOverrides,
} from "./regles";

export * from "./regles";

/**
 * Empreinte du contenu figé. Elle sert au lot S-5 (« cette occurrence est identique à la
 * précédente ⇒ ne pas l'envoyer deux fois »), mais se calcule ici, au moment où le contenu est
 * arrêté : la recalculer plus tard obligerait à relire un shell qui aurait pu bouger.
 *
 * ⚠️ Déplacée ici depuis `planner.ts` (0079) : une édition RELUE doit être empreinte exactement
 * comme au gel.
 */
export function contentFingerprint(input: {
  htmlShell: string;
  subject: string;
  preheader: string | null;
  segmentId: string | null;
}): string {
  const h = createHash("sha256");
  // Séparateur non imprimable : sans lui, un sujet finissant par le début du preheader donnerait
  // la même empreinte qu'un découpage différent des mêmes octets.
  h.update([input.htmlShell, input.subject, input.preheader ?? "", input.segmentId ?? ""].join("\x00"));
  return h.digest("hex");
}

/** Les colonnes d'occurrence qu'une édition finalisée écrit — celles qu'on envoie. */
export interface EditionFinale {
  html_shell: string;
  text_shell: string | null;
  size_bytes: number;
  subject: string;
  preheader: string | null;
  content_sha256: string;
  first_article_title: string | null;
  article_count: number;
}

export type ResultatFinal =
  | {
      ok: true;
      edition: EditionFinale;
      /** Le document qui part (relu). Sert au gel pour l'appel au modèle. */
      doc: unknown;
      /** `true` = les articles ont été relus, donc l'e-mail RECOMPILÉ. */
      recompilee: boolean;
      /** Avertissements de la recompilation (vides sans recompilation). */
      warnings: string[];
    }
  | { ok: false; raison: string };

/**
 * ⭐ LA FIN DU GEL — sujet, preheader, balisage UTM, taille, empreinte, article de tête — appliquée à
 * la base figée et à l'écart d'une relecture.
 *
 * Sans écart, elle refait EXACTEMENT ce que le gel faisait avant 0079 (banc de non-régression :
 * `apps/worker/src/planner-golden.test.ts`). Avec un écart sur les articles, le document relu est
 * RECOMPILÉ avec les rows de marque capturées au gel — par le compilateur de `@nf/render`, le seul.
 *
 * ⛔ L'ORDRE EST CELUI DU GEL, ET IL COMPTE. Le preheader est posé AVANT le balisage UTM, et la
 * taille et l'empreinte se mesurent APRÈS les deux : peser avant ferait mentir l'écran, empreindre
 * avant ferait déclarer doublon deux éditions différentes.
 *
 * ⛔ UN ÉCHEC EST UNE RAISON, JAMAIS UN REPLI. Le gel retient l'édition ; la recompilation après
 * relecture la laisse en attente, avec la raison, et le fan-out refuse de l'enfiler.
 */
export async function finaliserEdition(base: EditionBase, overrides: EditionOverrides | null): Promise<ResultatFinal> {
  const o = overrides ?? {};
  let doc = base.doc;
  let html = base.html_shell;
  let text = base.text_shell;
  let taille = base.size_bytes;
  let recompilee = false;
  let warnings: string[] = [];

  if (o.articles && Object.keys(o.articles).length > 0) {
    if (base.pointeAuxPartials && base.partials === null) {
      return {
        ok: false,
        raison: "the brand header or footer of this edition was not captured at freeze — it cannot be rebuilt without it",
      };
    }
    doc = appliquerArticles(base.doc, o.articles);
    if (countArticles(base.doc) > 0 && countArticles(doc) === 0) {
      return { ok: false, raison: "every article of this edition is hidden — an empty edition is never sent" };
    }
    try {
      // ⚠️ Import DYNAMIQUE, comme au gel : MJML n'est chargé que pour une édition dont on a relu les articles.
      const { compileDoc } = await import("@nf/render/compile");
      const built = await compileDoc(doc as EmailDoc, (base.partials ?? undefined) as BrandPartials | undefined);
      html = built.html;
      text = built.text;
      taille = built.sizeBytes;
      warnings = built.warnings;
      recompilee = true;
    } catch (e) {
      return { ok: false, raison: `this edition could not be rebuilt with the reviewed articles — ${(e as Error).message}` };
    }
  }

  const subject = o.subject ?? base.subject;
  /*
   * ⛔ LA GARDE DU GEL, INCHANGÉE. Un sujet qui promet un titre alors que l'édition n'a aucun article
   * partirait amputé de sa promesse, sans erreur : le jeton vide s'efface en silence.
   */
  const firstArticle = firstArticleTitle(doc);
  if (subject.includes(FIRST_ARTICLE_TOKEN) && firstArticle === null) {
    return {
      ok: false,
      raison: `the subject uses ${FIRST_ARTICLE_TOKEN} but this edition has no article block to take a title from`,
    };
  }
  const articleCount = countArticles(doc);

  // ⛔ Le `?? ""` ne descend PAS dans `preheader` : il reste nullable pour l'empreinte (voir le gel).
  const preheader = o.preheader ?? base.preheader;
  html = poserPreheader(html, preheader ?? "");
  html = applyUtm(html, { ...UTM_DEFAULTS, campaign: utmSlug(base.campaign_name) }).html;

  const sizeBytes = taille ?? Buffer.byteLength(html, "utf8");
  const content_sha256 = contentFingerprint({ htmlShell: html, subject, preheader, segmentId: base.segment_id });

  return {
    ok: true,
    edition: {
      html_shell: html,
      text_shell: text,
      size_bytes: sizeBytes,
      subject,
      preheader,
      content_sha256,
      first_article_title: firstArticle,
      article_count: articleCount,
    },
    doc,
    recompilee,
    warnings,
  };
}
