import type { Db } from "@/lib/supabase";
import { sha256 } from "@nf/tokens";

/**
 * Où en est un lien de confirmation (double opt-in) — LECTURE SEULE.
 *
 * ⛔⛔ CETTE FONCTION N'ÉCRIT RIEN, ET C'EST TOUT SON SENS (24/09/2026). Jusqu'à ce jour, la page
 * `/confirm` CONFIRMAIT au rendu du GET : souscription `active`, `consent_event optin_confirm`,
 * bienvenue en file — dès que l'URL était ouverte, par qui que ce soit. Or tout ce qui PRÉ-CHARGE
 * un lien l'ouvre : antivirus de messagerie, proxy d'entreprise, aperçu de client mail. Chacun
 * confirmait à la place de la personne, et le journal légal écrivait qu'ELLE avait confirmé. C'est
 * le défaut que `/unsubscribe` a corrigé le 18/09 pour la désinscription ; le double opt-in, qui est
 * la PREUVE du consentement, le portait encore.
 *
 * Elle sert aux DEUX côtés : la page (`app/confirm/vue.tsx`) pour choisir quoi afficher, et la
 * route POST (`api/v1/confirm/handler.ts`) pour re-vérifier au moment du geste — un lien peut
 * expirer, ou la souscription être effacée, entre l'affichage et le clic.
 *
 * ⚠️ `sha256` vient de `@nf/tokens`, pas de `@/lib/tokens` : ce dernier vérifie le secret dès son
 * chargement, et un banc doit pouvoir lire ce module sans secret.
 */

export interface SouscriptionLue {
  id: string;
  status: string;
  asset_id: string;
  consent_version_id: string | null;
  granted_purposes: Record<string, boolean> | null;
  language: string | null;
  source_detail: Record<string, unknown> | null;
  email: string;
  assetName: string;
}

export type EtatConfirmation =
  /** Aucun jeton ne correspond : lien tronqué ou inventé. */
  | { etat: "inconnu" }
  /** Le jeton existe mais a passé son échéance (48 h). */
  | { etat: "expire" }
  /** Jeton valide, souscription disparue. */
  | { etat: "introuvable" }
  /** Déjà confirmée (souscription active ou jeton déjà utilisé). */
  | { etat: "deja"; sub: SouscriptionLue }
  /** Effacée (droit à l'oubli) : un vieux lien ne la rallume pas. */
  | { etat: "efface"; sub: SouscriptionLue }
  /** Tout est en ordre : la confirmation attend le GESTE de la personne. */
  | { etat: "pret"; jetonId: string; sub: SouscriptionLue };

export async function lireConfirmation(db: Db, token: string, now: Date = new Date()): Promise<EtatConfirmation> {
  const { data: tok } = await db
    .from("doi_token")
    .select("id, subscription_id, expires_at, confirmed_at")
    .eq("token_hash", sha256(token))
    .maybeSingle();

  if (!tok) return { etat: "inconnu" };
  if (new Date(tok.expires_at as string) < now) return { etat: "expire" };

  const { data: brut } = await db
    .from("subscription")
    .select("id, status, asset_id, consent_version_id, granted_purposes, language, source_detail, subscriber:subscriber_id(email), asset:asset_id(name)")
    .eq("id", tok.subscription_id)
    .maybeSingle();

  if (!brut) return { etat: "introuvable" };

  const sub: SouscriptionLue = {
    id: brut.id as string,
    status: brut.status as string,
    asset_id: brut.asset_id as string,
    consent_version_id: (brut.consent_version_id as string | null) ?? null,
    granted_purposes: (brut.granted_purposes as Record<string, boolean> | null) ?? null,
    language: (brut.language as string | null) ?? null,
    source_detail: (brut.source_detail as Record<string, unknown> | null) ?? null,
    email: (brut.subscriber as { email?: string } | null)?.email ?? "",
    assetName: (brut.asset as { name?: string } | null)?.name ?? "—",
  };

  if (sub.status === "active" || tok.confirmed_at) return { etat: "deja", sub };
  // ⛔ Une souscription EFFACÉE (droit à l'oubli) ne se rallume pas par un vieux lien resté valide :
  // son adresse a été remplacée par `erased+…@deleted.invalid`. Revenir, c'est se réinscrire.
  if (sub.status === "deleted") return { etat: "efface", sub };
  // ⛔ Un CONTACT hors newsletter (0088) n'a jamais reçu de lien : un jeton qui le désigne n'a pas
  //    été émis pour lui, et l'activer l'inscrirait à la newsletter sans sa demande. Seul un
  //    `pending` (ou un désinscrit qui s'est réinscrit, donc repassé `pending`) se confirme.
  if (sub.status === "contact") return { etat: "introuvable" };

  return { etat: "pret", jetonId: tok.id as string, sub };
}
