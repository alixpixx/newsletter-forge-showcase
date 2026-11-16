/**
 * En-tête et pied de marque — APPLICATION AU DOCUMENT, juste avant la compilation.
 *
 * ⭐ POURQUOI ICI ET PAS À L'ENVOI. Le HTML est figé À LA PUBLICATION : `compileDoc()` remplit
 * `template_version.html_shell`, et le worker n'exécute plus qu'un `hydrate()` sur ce HTML déjà
 * bâti. Résoudre le pointeur ici fait donc voyager l'en-tête dans le shell figé — il traverse les
 * campagnes ET les e-mails de cycle de vie (confirmation, bienvenue, relance) sans une seule ligne à
 * changer dans le worker. Une résolution à l'envoi aurait exigé le contraire : que le worker sache
 * lire la base, recompiler, et décider par destinataire.
 *
 * ⚠️ CETTE FONCTION NE VA RIEN CHERCHER. `@nf/render` est un paquet : il n'a ni base ni session. Les
 * rows du partial lui sont PASSÉES par l'appelant, qui seul sait résoudre un id en lignes. Le
 * pointeur `doc.meta.*PartialId` ne sert ici qu'à une chose : constater qu'un document RÉCLAME un
 * partial que l'appelant n'a pas fourni, et le DIRE — au lieu de compiler un e-mail sans en-tête
 * comme si de rien n'était.
 */
import { z } from "zod";
import {
  MAX_DOC_ROWS,
  Row,
  rowCarriesFooterLegal,
  withFreshRowIds,
  type EmailDoc,
} from "../schema";

/**
 * Les rows à préfixer / suffixer, telles que l'appelant les a résolues.
 *
 * Absent ≠ vide : `undefined` veut dire « l'appelant n'en a pas fourni », un tableau vide veut dire
 * « il a résolu, et il n'y a rien à poser ». Les deux ne déclenchent pas le même avertissement.
 */
export interface BrandPartials {
  header?: readonly Row[];
  footer?: readonly Row[];
}

/** Un partial est un petit objet de châssis. 20 rows est déjà très large pour un en-tête. */
export const MAX_PARTIAL_ROWS = 20;

const PartialRows = z.array(Row).max(MAX_PARTIAL_ROWS);

export const PARTIAL_FOOTER_LEGAL_MESSAGE =
  "a brand header or footer cannot contain the legal footer block — the platform injects it once per " +
  "email, with the recipient's signed unsubscribe links. A partial carrying one would create a second " +
  "source for the unsubscribe notice.";

/**
 * L'empreinte d'une row, IDS EXCLUS et clés triées.
 *
 * ⚠️ Les ids ne peuvent pas entrer dans la comparaison : `withFreshRowIds` les régénère sur les rows
 * du partial, donc une row et sa copie dans le document ne partagent JAMAIS le même id — les
 * comparer par identité ne trouverait jamais le doublon qu'on cherche.
 *
 * ⚠️ Les clés sont triées parce que les deux rows n'arrivent pas par le même chemin (l'une du
 * document, l'autre de la base) : se fier à l'ordre d'insertion ferait dépendre le verdict de la
 * façon dont le JSON a été écrit, pas de ce qu'il contient.
 *
 * ⛔ EXPORTÉE, ET C'EST VOLONTAIRE. L'admin en a besoin pour RETIRER du document la row que ce
 * fichier se contente de SIGNALER en double (voir l'avertissement plus bas). Les deux gestes
 * doivent apparier à l'identique : une seconde normalisation écrite ailleurs finirait par diverger
 * de celle-ci, et l'on retirerait alors une row que le compilateur ne considère pas comme la même —
 * ou l'inverse, un avertissement qui ne s'éteint jamais.
 */
export function empreinteSansIds(valeur: unknown): string {
  const normalise = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(normalise);
    if (v !== null && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const cle of Object.keys(o).sort()) {
        if (cle === "id") continue;
        out[cle] = normalise(o[cle]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(normalise(valeur));
}

export interface AppliedBrandPartials {
  doc: EmailDoc;
  /** Avertissements remontés tels quels dans `CompileResult.warnings`. */
  warnings: string[];
}

/**
 * Préfixe l'en-tête et insère le pied éditorial, puis rend le document à compiler.
 *
 * ⛔ LE PIED ÉDITORIAL SE POSE AVANT LA ROW DU PIED LÉGAL, JAMAIS À SA PLACE NI APRÈS. Le pied légal
 * compile vers le jeton `{{legal_footer_html}}` que le worker remplit avec les liens de
 * désabonnement signés du destinataire, et `renderLifecycle()` REFUSE de servir un shell qui ne
 * contient pas littéralement ce jeton (il rend `null` en silence et retombe sur le HTML en dur).
 * Déplacer ou doubler ce bloc casserait donc l'envoi, pas seulement la mise en page.
 *
 * ⛔ TOUS LES IDS SONT RÉGÉNÉRÉS. Voir `withFreshRowIds` : les ids de rows sont humains et déjà
 * dupliqués entre modèles en production. Sans régénération, un document extrait de son propre
 * en-tête porterait deux fois le même id de bloc, et `expandFeedBlocks` — qui indexe ses résolutions
 * PAR id de bloc — servirait les articles d'un bloc à un autre. Les ids ne sortent jamais dans le
 * HTML : cette régénération ne change donc pas d'un octet ce que le compilateur produit.
 *
 * Lève une `Error` si un partial embarque un pied légal, ou si le document résultant dépasse le
 * plafond du schéma : les deux cas produiraient un e-mail que la plateforme ne sait pas servir.
 */
export function applyBrandPartials(doc: EmailDoc, partials?: BrandPartials): AppliedBrandPartials {
  const warnings: string[] = [];

  // Un pointeur sans rows fournies : on ne sait pas ce que l'auteur voulait, mais on sait qu'il
  // manque quelque chose. Le taire ferait partir un e-mail sans son en-tête de marque, et personne
  // ne verrait la différence avant de l'avoir reçu.
  if (doc.meta.headerPartialId !== undefined && partials?.header === undefined) {
    warnings.push(
      "This email points at a brand header, but none was supplied to the compiler — it is being built without it.",
    );
  }
  if (doc.meta.footerPartialId !== undefined && partials?.footer === undefined) {
    warnings.push(
      "This email points at a brand footer, but none was supplied to the compiler — it is being built without it.",
    );
  }

  const header = PartialRows.parse(partials?.header ?? []);
  const footer = PartialRows.parse(partials?.footer ?? []);
  if (header.length === 0 && footer.length === 0) return { doc, warnings };

  for (const row of [...header, ...footer]) {
    if (rowCarriesFooterLegal(row)) throw new Error(PARTIAL_FOOTER_LEGAL_MESSAGE);
  }

  /*
   * ⛔ ON PRÉFIXE, ON NE REMPLACE PAS — et c'est le piège du jour où l'on pose un pointeur sur un
   * modèle EXISTANT. Ces modèles portent déjà leur en-tête sous forme de row : les quatre boletines
   * Copper Kettle ouvrent tous sur `pf_head`, qui est précisément la row dont l'en-tête de marque a
   * été extrait. Poser le pointeur sans RETIRER cette row du document afficherait le logo, le
   * kicker et la date DEUX FOIS, et rien dans la chaîne n'aurait de raison de s'en plaindre : le
   * document est valide, la compilation réussit, le test d'envoi passe.
   *
   * Un avertissement, pas un refus : c'est le document qui doit être corrigé, et le compilateur
   * n'est pas le bon endroit pour retirer du contenu que l'auteur n'a pas demandé à retirer.
   */
  const dejaDansLeDocument = new Set(doc.rows.map(empreinteSansIds));
  for (const [fente, rows] of [
    ["header", header],
    ["footer", footer],
  ] as const) {
    if (rows.some((r) => dejaDansLeDocument.has(empreinteSansIds(r)))) {
      warnings.push(
        `This email already contains the row it uses as its brand ${fente} — applying the pointer would show it twice. ` +
          "Remove the copy from the document.",
      );
    }
  }

  // Index de la row qui porte le pied légal, ou la fin du document quand il n'y en a pas. Un
  // document sans pied légal est de toute façon refusé à l'envoi (`collectWarnings` le dit, le
  // worker le veto) : on pose alors le pied éditorial en dernier, là où il se serait trouvé.
  const legalIndex = doc.rows.findIndex(rowCarriesFooterLegal);
  const coupure = legalIndex === -1 ? doc.rows.length : legalIndex;

  const rows = [
    // ⚠️ Lambdas, pas `.map(withFreshRowIds)` : `map` passerait l'INDEX comme préfixe d'id.
    ...header.map((r) => withFreshRowIds(r)),
    ...doc.rows.slice(0, coupure),
    ...footer.map((r) => withFreshRowIds(r)),
    ...doc.rows.slice(coupure),
  ];

  if (rows.length > MAX_DOC_ROWS) {
    throw new Error(
      `applying the brand header and footer would bring this email to ${rows.length} rows, over the ${MAX_DOC_ROWS} the document schema accepts`,
    );
  }

  return { doc: { ...doc, rows }, warnings };
}
