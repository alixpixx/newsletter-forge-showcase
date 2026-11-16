import { NextResponse } from "next/server";
import type { Db } from "@/lib/supabase";
import { queueEmail } from "@/lib/mailer";
import { emailCoupe } from "@/lib/cycle-de-vie-coupe";
import { lireConfirmation } from "@/lib/confirmation";
import { ipInet } from "@/lib/capture";
import { dict, normalizeLocale } from "@/lib/i18n";
import { legalBasisForRegime, ALL_PURPOSES, type ConsentPurpose } from "@nf/config";

/**
 * Le POST de `api/v1/confirm` — le GESTE qui confirme un double opt-in, depuis le bouton de la page
 * `/confirm`. Le pourquoi de la route est dans `route.ts`.
 *
 * Module séparé : la base, la signature du lien de désinscription et le report « après la réponse »
 * y sont injectés, pour qu'un banc mesure la route sans secret ni réseau (même partage que
 * `unsubscribe/confirm`). `@/lib/tokens` n'est pas importé ici : il vérifie le secret dès son
 * chargement.
 *
 * ⚠️ CE QUI SUIT LA CONFIRMATION EST CELUI QUE LA PAGE FAISAIT AU GET, DANS LE MÊME ORDRE :
 * souscription `active` + instantané de consentement, jeton consommé, levée des suppressions
 * volontaires (0073), `consent_event optin_confirm` + un `granted` par finalité, bienvenue en file,
 * retour vers le système de capture. Seul le déclencheur change : un clic, plus un chargement.
 */
export interface ConfirmationDeps {
  getDb: () => Db | null;
  signUnsub: (subscriptionId: string) => string;
  /** `after` de Next en production : le retour vers la capture part APRÈS la réponse. */
  apres: (tache: () => Promise<void>) => void;
  env: { OPTINFORGE_VERIFY_URL?: string; OPTINFORGE_VERIFY_SECRET?: string };
}

type Etat = "fait" | "deja" | "expire" | "inconnu" | "introuvable" | "invalide" | "echec";

function repondre(etat: Etat, status: number) {
  return NextResponse.json(status < 300 ? { ok: true, etat } : { error: etat, etat }, { status });
}

export async function handleConfirmation(req: Request, deps: ConfirmationDeps): Promise<Response> {
  const db = deps.getDb();
  if (!db) return NextResponse.json({ error: "service-indisponible" }, { status: 503 });

  const url = new URL(req.url);
  let corps: { token?: unknown; lang?: unknown } = {};
  try {
    corps = (await req.json()) as typeof corps;
  } catch {
    corps = {};
  }
  // Le jeton vient du corps (la page l'y met), la query reste acceptée en repli.
  const token = (typeof corps.token === "string" && corps.token) || url.searchParams.get("token") || "";
  const lang = (typeof corps.lang === "string" && corps.lang) || url.searchParams.get("lang") || undefined;
  if (!token) return repondre("invalide", 400);

  // ⛔ RE-VÉRIFIÉ AU MOMENT DU GESTE, jamais repris de l'affichage : le lien a pu expirer, ou la
  // souscription être effacée, entre le chargement de la page et le clic.
  const lu = await lireConfirmation(db, token);
  if (lu.etat === "inconnu") return repondre("inconnu", 404);
  if (lu.etat === "expire") return repondre("expire", 410);
  if (lu.etat === "introuvable" || lu.etat === "efface") return repondre("introuvable", 404);
  if (lu.etat === "deja") return repondre("deja", 200);

  const { sub } = lu;
  const ip = ipInet(req.headers.get("x-forwarded-for")) ?? ipInet(req.headers.get("x-real-ip"));
  const ua = req.headers.get("user-agent") || null;
  const now = new Date().toISOString();

  /*
   * Activation : la souscription devient active + instantané de consentement.
   *
   * ⛔ ÉCRITURE CONDITIONNELLE, ET SON RETOUR EST LU. Un bouton se clique deux fois, et deux onglets
   * ouverts sur le même lien postent en même temps : sans condition, chacun écrirait sa preuve et
   * mettrait SON bienvenue en file — deux e-mails pour un seul consentement. Seul le POST qui fait
   * réellement passer la ligne à `active` continue ; le perdant répond « déjà confirmé ».
   *
   * ⛔ ET SON ÉCHEC SE DIT (503). Au GET, l'erreur était ignorée : la page affichait « inscription
   * confirmée » au-dessus d'une souscription restée `pending`, qui ne recevait donc jamais rien.
   *
   * ⚠️ `ipInet` valide l'IP comme à l'inscription : `consent_ip` est une colonne `inet`, et une valeur
   * mal formée posée par un proxy ferait échouer l'écriture — donc, désormais, la confirmation.
   */
  const { data: activees, error: erreurActivation } = await db
    .from("subscription")
    .update({ status: "active", consent_state: true, consent_method: "widget_doi", consent_ip: ip, consent_at: now })
    .eq("id", sub.id)
    .neq("status", "active")
    .neq("status", "deleted")
    .select("id");
  if (erreurActivation) {
    console.error(
      JSON.stringify({ event: "confirm-activation-failed", subscription_id: sub.id, reason: erreurActivation.message }),
    );
    return repondre("echec", 503);
  }
  if (!activees || (activees as unknown[]).length === 0) return repondre("deja", 200);

  const jeton = await db.from("doi_token").update({ confirmed_at: now }).eq("id", lu.jetonId);
  if (jeton.error) {
    console.error(JSON.stringify({ event: "confirm-token-mark-failed", subscription_id: sub.id, reason: jeton.error.message }));
  }

  /*
   * ⭐ LA RÉINSCRIPTION VOLONTAIRE (0073, 22/09/2026 — Alix : « si la personne se reinscrit on l'a
   * reme dans le systeme »). Ce clic prouve que la personne ELLE-MÊME veut revenir : on lève son
   * effacement ou sa désinscription de toutes les marques — et, pour CETTE marque, une suppression
   * pour rebonds mous (0081 : le lien n'a pu arriver que parce que la boîte reçoit de nouveau).
   * Rebond dur et plainte restent. Rien à
   * lever dans le cas courant : la fonction rend 0 et n'écrit aucune trace.
   *
   * ⚠️ AVANT LE BIENVENUE, qui est gardé par `is_suppressed` au moment de partir.
   *
   * ⛔ UN ÉCHEC NE REFUSE PAS LA CONFIRMATION (même doctrine que le bienvenue plus bas) : elle a eu
   * lieu. Mais il ne passe pas en silence — sans la levée, cette personne reste bloquée à l'envoi.
   */
  if (sub.email) {
    const levee = await db.rpc("lift_voluntary_suppression", {
      p_email: sub.email, p_asset_id: sub.asset_id, p_subscription_id: sub.id,
    });
    if (levee.error) {
      console.error(
        JSON.stringify({ event: "confirm-suppression-lift-failed", subscription_id: sub.id, reason: levee.error.message }),
      );
    }
  }

  // Édition (base légale / pays / langue pour la preuve enrichie).
  const { data: ed } = await db
    .from("asset_edition").select("market, compliance_regime, language").eq("asset_id", sub.asset_id).limit(1).maybeSingle();
  const basis = legalBasisForRegime(ed?.compliance_regime as string | undefined);
  const proof = { ip_address: ip, user_agent: ua, method: "widget_doi", country: ed?.market ?? null, language: ed?.language ?? null, legal_basis: basis };

  // Confirmation d'opt-in (parapluie), puis une preuve `granted` PAR FINALITÉ accordée (kit
  // « Registro de consentimento »). ⛔ Un échec ne défait pas la confirmation, mais il se dit : une
  // preuve qui manque ne se voit que le jour d'un contrôle.
  const parapluie = await db.from("consent_event").insert({
    subscription_id: sub.id, consent_version_id: sub.consent_version_id, event_type: "optin_confirm", ...proof,
  });
  const granted = sub.granted_purposes ?? {};
  const purposeRows = ALL_PURPOSES.filter((p: ConsentPurpose) => granted[p] === true).map((p: ConsentPurpose) => ({
    subscription_id: sub.id, consent_version_id: sub.consent_version_id, event_type: "granted", purpose: p, ...proof,
  }));
  const parFinalite = purposeRows.length ? await db.from("consent_event").insert(purposeRows) : null;
  const erreurPreuve = parapluie.error ?? parFinalite?.error ?? null;
  if (erreurPreuve) {
    console.error(JSON.stringify({ event: "confirm-consent-event-failed", subscription_id: sub.id, reason: erreurPreuve.message }));
  }

  // Bienvenue (→ outbox) + on prépare déjà le lien de désinscription signé.
  // ⚠️ Sauf s'il est COUPÉ pour cette marque (Automations › Welcome, 0086) : la confirmation a lieu quand même.
  if (sub.email && (await emailCoupe(db, sub.asset_id, "welcome"))) {
    console.info(JSON.stringify({ event: "confirm-welcome-off", subscription_id: sub.id }));
  } else if (sub.email) {
    /*
     * ⛔ L'OBJET EST FIGÉ ICI, PAS AU RENDU — même règle qu'à l'inscription : `email_outbox.subject`
     * est écrit une fois et le worker le sert tel quel.
     *
     * ⚠️ LA LANGUE EST CELLE DE LA SOUSCRIPTION, pas celle de la page : un E-MAIL ne doit pas changer
     * de langue parce qu'on a bricolé une query string. `lang` ne sert que de repli quand la
     * souscription n'en déclare aucune.
     */
    const localeMail = normalizeLocale(sub.language ?? lang);
    const motifBienvenue = await queueEmail(db, {
      assetId: sub.asset_id, subscriptionId: sub.id, toEmail: sub.email, kind: "welcome",
      subject: dict(localeMail).m.welcomeSubject(sub.assetName),
      payload: { unsub_token: deps.signUnsub(sub.id) },
    });
    // ⛔ ICI, UN ÉCHEC NE REFUSE RIEN — contrairement à l'inscription. La souscription vient de
    // passer `active` et sa preuve est écrite : la confirmation a EU LIEU. Mais il ne part pas en
    // silence : un bienvenue qui cesse d'être enfilé est invisible autrement.
    if (motifBienvenue) {
      console.error(
        JSON.stringify({ event: "confirm-welcome-queue-failed", subscription_id: sub.id, reason: motifBienvenue }),
      );
    }
  }

  /**
   * Retour vers le système de capture : sans lui, le lead reste `verified = false` là-bas pour
   * toujours, et l'écran des contacts ne sait plus distinguer une adresse confirmée d'une adresse
   * qui ne l'a jamais été — ce qui est tout l'intérêt d'un double opt-in.
   *
   * Après la réponse, et jamais bloquant : la personne vient de confirmer, son écran ne doit
   * dépendre ni de la latence ni de la disponibilité de l'autre système.
   */
  const detail = (sub.source_detail ?? {}) as { origin?: string; lead_id?: string | null };
  if (detail.origin === "optinforge" && detail.lead_id) {
    const cible = deps.env.OPTINFORGE_VERIFY_URL;
    const secret = deps.env.OPTINFORGE_VERIFY_SECRET;
    if (cible && secret) {
      const leadId = detail.lead_id;
      deps.apres(async () => {
        try {
          const res = await fetch(cible, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-opf-verify-secret": secret },
            body: JSON.stringify({ lead_id: leadId }),
            signal: AbortSignal.timeout(8000),
          });
          if (!res.ok) {
            console.error(`[confirm] retour capture refusé (${res.status}) pour le lead ${leadId}`);
          }
        } catch (err) {
          console.error("[confirm] retour capture impossible :", err instanceof Error ? err.message : err);
        }
      });
    } else {
      // Configuration incomplète : on le dit, plutôt que de laisser un silence qui ressemblerait
      // à « rien à faire ».
      console.warn("[confirm] lead optinforge confirmé mais le retour n'est pas configuré");
    }
  }

  return repondre("fait", 200);
}
