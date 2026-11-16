import {
  buildFooter,
  normalizeLocale,
  type FooterConfig,
  type Locale,
  type Regime,
} from "@nf/email";
import { getDb } from "@/lib/supabase";

type Db = NonNullable<ReturnType<typeof getDb>>;

/**
 * LES LANGUES QU'UNE MARQUE ENVOIE RÉELLEMENT (`newsletter.asset_edition.language`).
 *
 * ⛔ POURQUOI PAS `asset.languages`. Cette colonne est ce que la marque DÉCLARE au registre ; une
 * édition est ce qu'elle ENVOIE. Les deux ont déjà divergé en production (atlas-review déclarait
 * `pt-BR` en tête alors que le seed 0007 avait posé `it`, corrigé par la migration 0029). Un écran
 * qui annonce « cette marque écrit en 5 langues » sur la foi du registre promet une localisation
 * qu'aucune édition ne sert, et un modèle semé dans `languages[0]` peut être écrit dans une langue
 * que personne ne reçoit — sans qu'aucune ligne de code échoue.
 *
 * ⛔ NORMALISÉES ET DÉDOUBLONNÉES, PARCE QUE C'EST CE QUE LE LECTEUR REÇOIT. `normalizeLocale`
 * renvoie sur `en` toute langue hors dictionnaire — « sv », déclaré par Harbor Tech, n'existe pas
 * dans `Locale`. Compter les langues BRUTES ferait annoncer une adaptation que les e-mails
 * intégrés ne savent pas faire.
 */
export async function assetEditionLocales(
  assetId: string | null,
): Promise<{ known: boolean; value: Locale[] }> {
  const db = getDb();
  // Pas de base, pas de marque : on ne SAIT pas dans quelles langues cette marque écrit. Le dire
  // empêche l'appelant d'en déduire « une seule », donc de taire l'avertissement de langue.
  if (!db || !assetId) return { known: false, value: [] };
  return assetEditionLocalesWith(db, assetId);
}

/**
 * Même lecture, avec la base FOURNIE — c'est cette forme que le banc exerce.
 *
 * ⛔ CE QUI SE MESURE ICI EST L'ORDRE, ET IL DÉCIDE D'UNE LANGUE. `value[0]` est la langue dans
 * laquelle « Customise » écrit le modèle, et celle que le bandeau annonce avant le clic. Sans banc,
 * l'ordre ne se vérifierait qu'en production, sur une marque à deux éditions — c'est-à-dire au
 * moment où un abonné reçoit sa confirmation dans une langue qu'il ne lit pas.
 */
export async function assetEditionLocalesWith(
  db: NonNullable<ReturnType<typeof getDb>>,
  assetId: string,
): Promise<{ known: boolean; value: Locale[] }> {
  const { data, error } = await db
    .from("asset_edition")
    .select("language")
    .eq("asset_id", assetId)
    /*
     * ⛔ LA PRIMAIRE D'ABORD, PAS LA PLUS ANCIENNE. `is_primary` est, par définition de la colonne
     * (migration 0026), « l'édition retenue quand l'appelant n'en précise aucune » : c'est celle où
     * atterrit tout nouvel inscrit, et c'est exactement ce tri qu'emploie le formulaire public
     * (`apps/public/.../signup/route.ts`). Trier par `created_at` seul désignait la plus ANCIENNE
     * édition : le jour où l'équipe ouvre une deuxième édition et déplace la primaire dessus — ce
     * que 0026 annonce noir sur blanc — le modèle serait écrit dans la langue que plus personne ne
     * reçoit par défaut, sans qu'aucune ligne de code échoue.
     *
     * ⛔ `id` DÉPARTAGE, ET CE N'EST PAS DÉCORATIF. Le défaut de `created_at` est `now()`, qui est
     * l'horodatage de TRANSACTION : deux éditions insérées par le même `insert` portent la même
     * valeur, et l'ordre entre elles redevient arbitraire — deux lectures de suite pourraient rendre
     * deux langues. La migration 0026 le savait déjà (`order by asset_id, created_at, id`).
     */
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (error) return { known: false, value: [] };

  const vues = new Set<Locale>();
  const locales: Locale[] = [];
  for (const raw of ((data as unknown[]) ?? [])) {
    const l = normalizeLocale(String((raw as { language?: unknown }).language ?? ""));
    if (vues.has(l)) continue;
    vues.add(l);
    locales.push(l);
  }
  return { known: true, value: locales };
}

/* ------------------------------------------------------------------ *
 * Le pied légal, par édition — la SEULE partie éditable du « vrai footer »
 * ------------------------------------------------------------------ */

/**
 * CE QUI EST ÉDITABLE DANS LE PIED LÉGAL, ET CE QUI NE PEUT PAS L'ÊTRE.
 *
 * `buildFooter` ne reçoit que deux choses : ce qu'il LIT (`cfg`) et ce qu'il CALCULE. La frontière
 * est exactement là.
 *
 *  - ÉDITABLE — les champs de `FooterConfig` : identité de l'expéditeur, adresse postale, URL de
 *    politique de confidentialité, mentions par marché, la phrase « vous recevez cet e-mail car… »
 *    et l'habillage. Tout cela vit déjà en base, dans `asset_edition.legal_footer` ; jusqu'ici rien
 *    ne pouvait l'écrire qu'une MIGRATION.
 *
 *  - ⛔ JAMAIS ÉDITABLE — les liens de désinscription et de préférences. Ils sont SIGNÉS par
 *    destinataire (HMAC, côté worker) et calculés à l'envoi. Les rendre modifiables créerait une
 *    seconde source pour le seul lien qui ne doit en avoir qu'une, et la copie serait non signée.
 *    C'est la même raison qui interdit à un partial de marque de porter un bloc `footer_legal`.
 */
export interface EditionLegalFooter {
  id: string;
  market: string;
  language: string;
  regime: Regime;
  isPrimary: boolean;
  cfg: FooterConfig;
  /**
   * Ce que `buildFooter` déclare manquant pour CETTE édition.
   * ⛔ Non vide ⇒ le worker met l'envoi en veto (`footer_incomplete`). C'est un blocage, pas un
   * avertissement, et l'écran doit le dire dans ces termes.
   */
  missing: string[];
}

const REGIMES: readonly Regime[] = ["gdpr", "lgpd", "canspam"];
const estRegime = (v: unknown): v is Regime => REGIMES.includes(v as Regime);

/**
 * Les éditions d'une marque avec leur pied légal, prêtes pour l'écran.
 *
 * ⛔ `known: false` N'EST PAS « AUCUNE ÉDITION ». Un écran qui afficherait « cette marque n'a rien à
 * configurer » sur une panne laisserait croire qu'il n'y a rien à faire — alors qu'un `privacy_url`
 * absent empêche déjà les envois.
 */
export async function listEditionLegalFooters(
  db: Db,
  assetId: string,
  assetName: string,
): Promise<{ known: boolean; value: EditionLegalFooter[] }> {
  const { data, error } = await db
    .from("asset_edition")
    .select("id, market, language, compliance_regime, is_primary, legal_footer")
    .eq("asset_id", assetId)
    // Même tri que `assetEditionLocalesWith` : la primaire d'abord, puis un ordre stable.
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (error) return { known: false, value: [] };

  const editions: EditionLegalFooter[] = [];
  for (const raw of ((data as unknown[]) ?? [])) {
    const r = raw as Record<string, unknown>;
    // Un régime inconnu n'est pas un régime par défaut : il décide des mentions obligatoires, donc
    // en inventer un ferait afficher — et mesurer — les obligations d'un autre pays.
    if (!estRegime(r.compliance_regime)) return { known: false, value: [] };

    const cfg = (r.legal_footer ?? {}) as FooterConfig;
    const market = String(r.market ?? "");
    // On demande à `buildFooter` lui-même ce qui manque : une seconde liste écrite ici finirait par
    // ne plus dire la même chose que celle qui met l'envoi en veto.
    const { missing } = buildFooter({
      assetName,
      regime: r.compliance_regime,
      cfg,
      market,
      locale: normalizeLocale(String(r.language ?? "")),
      // Le lien réel est signé par destinataire ; ici on ne pèse que `missing`, et `buildFooter` ne
      // met jamais l'URL de désinscription dans `missing`.
      unsubUrl: "https://example.invalid/u",
    });

    editions.push({
      id: String(r.id ?? ""),
      market,
      language: String(r.language ?? ""),
      regime: r.compliance_regime,
      isPrimary: Boolean(r.is_primary),
      cfg,
      missing,
    });
  }
  return { known: true, value: editions };
}

/**
 * Écrit le pied légal d'UNE édition.
 *
 * ⛔ REMPLACEMENT COMPLET DE LA COLONNE, JAMAIS UNE FUSION JSONB. L'écran envoie l'état final du
 * formulaire : vider un champ doit le vider. Une fusion rendrait impossible d'EFFACER une mention —
 * et une mention légale qu'on ne peut plus retirer est un défaut, pas une sécurité.
 *
 * ⛔ LE `.select()` DIT SI ON A ÉCRIT. Un `update` qui ne touche aucune ligne ne lève pas : sans
 * lui, poster sur l'édition d'une autre marque répondrait « enregistré ».
 */
export async function updateEditionLegalFooter(
  db: Db,
  p: { editionId: string; assetId: string; cfg: FooterConfig },
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const { data, error } = await db
    .from("asset_edition")
    .update({ legal_footer: p.cfg })
    .eq("id", p.editionId)
    // ⛔ Le filtre de marque n'est pas décoratif : sans lui, l'id d'une édition d'une AUTRE marque
    // serait écrit. C'est le même invariant que partout ailleurs dans `lib/data`.
    .eq("asset_id", p.assetId)
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, status: 500, error: error.message };
  if (!data) return { ok: false, status: 404, error: "edition not found" };
  return { ok: true };
}
