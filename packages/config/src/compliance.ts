/**
 * Règles de conformité par régime. La plateforme applique automatiquement
 * le bon régime à chaque abonné selon l'édition (marché) de l'asset.
 * Voir docs/SOURCE-SPEC.md (section « Conformité ») et docs/DATA-MODEL.md.
 */
import type { ComplianceRegime } from "./assets";

export interface RegimeRules {
  /** Double opt-in obligatoire (légalement requis seulement LGPD, mais uniforme partout). */
  doubleOptIn: boolean;
  /** Journal de consentement immuable (timestamp + IP + version). */
  consentLog: boolean;
  /** Adresse postale physique obligatoire dans chaque footer. */
  physicalAddressInFooter: boolean;
  /** Résidence des données requise. */
  dataResidency: "eu" | "br" | "us" | "none";
  /** SLA de suppression (droit à l'oubli), en jours. */
  deletionSlaDays: number;
  /** Délai max pour honorer un opt-out, en jours. */
  optOutSlaDays: number;
}

export const COMPLIANCE: Record<ComplianceRegime, RegimeRules> = {
  gdpr: {
    doubleOptIn: true,
    consentLog: true,
    physicalAddressInFooter: false,
    dataResidency: "eu",
    deletionSlaDays: 30,
    optOutSlaDays: 1,
  },
  lgpd: {
    doubleOptIn: true,
    consentLog: true,
    physicalAddressInFooter: false,
    dataResidency: "br",
    deletionSlaDays: 30,
    optOutSlaDays: 1,
  },
  canspam: {
    // Opt-in non requis par la loi, mais on fait du double opt-in partout (uniformité + preuve).
    doubleOptIn: true,
    consentLog: true,
    physicalAddressInFooter: true,
    dataResidency: "none",
    deletionSlaDays: 30,
    optOutSlaDays: 10,
  },
};

/**
 * Les drapeaux de régime exposés aux blocs conditionnels d'un template
 * (`<!--nf:if is_gdpr-->…<!--nf:endif-->`).
 *
 * ⛔ EXHAUSTIF PAR CONSTRUCTION, ET C'EST TOUT L'ENJEU. Le moteur de conditionnels n'a PAS de
 * `else` : « GDPR sinon CAN-SPAM » s'écrit forcément en deux blocs, et rien ne garantit leur
 * exclusivité — si les trois drapeaux étaient faux, l'e-mail partirait SANS AUCUNE mention légale,
 * sans qu'une seule ligne de code échoue. Un régime absent, vide ou inconnu retombe donc sur
 * `is_gdpr`, le plus strict : de trop, ce n'est qu'une mention en trop ; de moins, c'est une
 * infraction.
 *
 * ⛔ ET LE FAIL-CLOSED DU MOTEUR JOUE DANS LES DEUX SENS : un champ absent du registre rend faux
 * `<!--nf:if is_gdpr-->` ET `<!--nf:if !is_gdpr-->`. Publier un template qui utilise ces drapeaux
 * AVANT de déployer le worker qui les connaît ferait disparaître le bloc chez tout le monde, sans
 * erreur. C'est pourquoi les trois entrent au registre en même temps que ce calcul.
 *
 * ⚠️ Le FOOTER légal, lui, ne se conditionne pas : il varie déjà par régime et par marché dans
 * `@nf/email` `buildFooter()`, et le compilateur refuse tout `visibleIf` sur un bloc de footer. Ces
 * drapeaux servent au CORPS de l'e-mail — mentions, finalités listées, durée de validité — jamais à
 * réimplémenter le footer, sous peine de deux vérités dans le même message.
 */
export function regimeFlags(regime: string | null | undefined): {
  is_gdpr: boolean;
  is_lgpd: boolean;
  is_can_spam: boolean;
} {
  const r = String(regime ?? "").trim().toLowerCase();
  return {
    is_lgpd: r === "lgpd",
    is_can_spam: r === "canspam",
    // Le repli, et il est délibérément le plus strict : tout ce qui n'est pas nommé est traité en
    // GDPR. Écrit en dernier pour que la lecture montre que le cas par défaut est couvert.
    is_gdpr: r !== "lgpd" && r !== "canspam",
  };
}

/**
 * Régime le plus strict d'un ensemble — pilote le stockage physique.
 * EU (GDPR) est le plus strict et couvre LGPD + CAN-SPAM.
 */
export function strictestResidency(regimes: ComplianceRegime[]): "eu" | "br" | "us" | "none" {
  if (regimes.includes("gdpr")) return "eu";
  if (regimes.includes("lgpd")) return "br";
  return "none";
}
