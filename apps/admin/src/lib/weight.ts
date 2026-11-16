import { buildFooter, normalizeLocale, type FooterInput } from "@nf/email";
import { checkShellWeight, shellWeightMessage, type ShellWeightReport } from "@nf/render/shell-checks";
import { getDb } from "@/lib/supabase";

/**
 * POIDS D'UN EMAIL, MESURÉ COMME IL PARTIRA.
 *
 * `publish` et `lock` comparaient au seuil de Gmail le poids du SHELL — le HTML compilé, avant que
 * le worker n'y injecte le footer légal et les liens signés. Le seuil, lui, s'applique à ce qui
 * arrive dans la boîte. Un email approuvé à 101 Ko de shell part à 106 Ko : Gmail coupe la fin,
 * donc le footer, donc le lien de désabonnement. C'est une infraction, pas un défaut de poids —
 * et une série récurrente la répète à chaque occurrence.
 *
 * CE FICHIER EST LE PONT : il obtient le footer le plus lourd de la marque (que `@nf/render` ne
 * peut pas connaître sans dépendre de `@nf/email` et de la base) et le passe à `checkShellWeight`.
 *
 * ⚠️ LE PLUS LOURD, PAS LE PREMIER. Une marque multi-éditions n'a pas un footer mais N : un
 * Impressum allemand pèse plusieurs centaines d'octets de plus qu'une mention brésilienne. Mesurer
 * l'édition primaire laisserait passer un email qui se fait tronquer... uniquement en Allemagne,
 * c'est-à-dire là où la sanction est la plus lourde.
 */

/** Base publique la plus longue plausible — sert à mesurer les URL, jamais à en fabriquer une vraie. */
const BASE_URL_FALLBACK = "https://news.goalpost-weekly.example";

export interface EditionRow {
  market: string | null;
  language: string | null;
  compliance_regime: string | null;
  legal_footer: Record<string, unknown> | null;
}

/**
 * Le pied le plus lourd parmi ces éditions — la partie PURE de `heaviestFooterHtml`, séparée pour
 * qu'un banc puisse vérifier que le pied choisi remplace bien celui de l'édition.
 */
export function heaviestFooterOf(
  rows: EditionRow[],
  assetName: string,
  cfgChoisie: FooterInput["cfg"] | null = null,
): string {
  let plusLong = "";
  for (const e of rows) {
    const input: FooterInput = {
      assetName,
      regime: (e.compliance_regime ?? "gdpr") as FooterInput["regime"],
      cfg: cfgChoisie ?? ((e.legal_footer ?? {}) as FooterInput["cfg"]),
      // Longueurs réalistes : les jetons signés font 80 caractères (uuid + HMAC base64url).
      unsubUrl: `${BASE_URL_FALLBACK}/unsubscribe?token=${"x".repeat(80)}&lang=pt-BR`,
      prefsUrl: `${BASE_URL_FALLBACK}/preferences?token=${"x".repeat(80)}&lang=pt-BR`,
      locale: normalizeLocale(e.language ?? undefined),
      market: e.market ?? undefined,
    };
    const html = buildFooter(input).html;
    if (Buffer.byteLength(html, "utf8") > Buffer.byteLength(plusLong, "utf8")) plusLong = html;
  }
  return plusLong;
}

/**
 * Footer légal le plus long parmi les éditions de la marque, rendu en HTML.
 *
 * Renvoie `""` si la marque n'a aucune édition lisible — et l'appelant le voit dans
 * `report.footerProvided`, plutôt que de croire à une mesure complète.
 */
export async function heaviestFooterHtml(
  assetId: string | null,
  assetName: string,
  /**
   * La config du pied légal CHOISI par l'e-mail (`legal_footer_template`), qui remplace celle de
   * chaque édition. Le régime, la langue et le marché restent ceux de l'édition : ce sont eux qui
   * décident des mentions ajoutées, donc du poids.
   */
  cfgChoisie: FooterInput["cfg"] | null = null,
): Promise<string> {
  const db = getDb();
  if (!db || !assetId) return "";

  const { data } = await db
    .from("asset_edition")
    .select("market, language, compliance_regime, legal_footer")
    .eq("asset_id", assetId);

  const rows = ((data as unknown[]) ?? []) as EditionRow[];
  return heaviestFooterOf(rows, assetName, cfgChoisie);
}

export interface WeightVerdict extends ShellWeightReport {
  /** Phrase prête à rendre à l'opérateur, ou `null` quand le poids passe. */
  message: string | null;
}

/**
 * Verdict de poids sur un shell, pour la marque donnée.
 *
 * Une seule fonction pour `publish`, `lock` et, plus tard, le matérialiseur de séries : trois
 * mesures différentes du même seuil produiraient trois verdicts contradictoires sur le même email.
 */
export async function weighShell(
  htmlShell: string,
  assetId: string | null,
  assetName: string,
  /** Voir `heaviestFooterHtml` : sans elle, on pèserait un autre pied que celui qui partira. */
  cfgChoisie: FooterInput["cfg"] | null = null,
): Promise<WeightVerdict> {
  const legalFooterHtml = await heaviestFooterHtml(assetId, assetName, cfgChoisie);
  const report = checkShellWeight({
    htmlShell,
    legalFooterHtml,
    publicBaseUrl: process.env.NEXT_PUBLIC_PUBLIC_BASE_URL ?? BASE_URL_FALLBACK,
  });
  return { ...report, message: shellWeightMessage(report) };
}
