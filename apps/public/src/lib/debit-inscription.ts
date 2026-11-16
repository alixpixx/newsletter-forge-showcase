import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import type { Db } from "@/lib/supabase";

/**
 * LIMITE DE DÉBIT DE L'INSCRIPTION (24/09/2026) — par IP ET par adresse.
 *
 * ⛔ CE QUE ÇA EMPÊCHE. L'inscription met en file un VRAI e-mail de confirmation en quelques
 * secondes (drain résident, envoi armé). Sans limite, n'importe qui peut faire recevoir des
 * dizaines de confirmations à l'adresse d'un tiers (bombardement), ou remplir la base de
 * souscriptions `pending` depuis une seule machine. Le jeton de formulaire signé ne suffit pas : il
 * reste valable deux heures et se rejoue autant de fois qu'on veut. Et demain les relances
 * automatiques de confirmation multiplieraient chaque abus.
 *
 * ⛔ POURQUOI EN BASE, ET PAS EN MÉMOIRE. Le site public tourne en plusieurs instances, qui
 * redémarrent : un compteur en mémoire se remet à zéro à chaque déploiement et ne voit que sa propre
 * instance. Aucun mécanisme de débit n'existe déjà côté public (le seul, `apps/worker/src/debit.ts`,
 * borne l'ENVOI, pas l'inscription), et aucune dépendance n'est ajoutée : une table et une fonction
 * (`signup_attempt`, `signup_rate_take`, migration 0081), qui compte et réserve dans la même
 * transaction, sous un verrou par clé — deux requêtes simultanées ne passent pas toutes les deux
 * sur la dernière place.
 *
 * ⛔ AUCUNE ADRESSE NI IP EN CLAIR. Seules des empreintes sha256 partent en base, préfixées par leur
 * genre (même convention que `suppression.email_hash`). C'est un pseudonyme, pas un anonymat : la
 * table ne garde rien au-delà de 48 h (purge dans la fonction) et n'est lisible par aucun rôle
 * public.
 *
 * ⚠️ UN ÉCHEC OUVRE, ET SE DIT. Si le compteur est indisponible (migration 0081 pas encore appliquée,
 * base lente), l'inscription PASSE et l'échec est journalisé. Une limite de débit protège contre un
 * abus ; la faire tomber en même temps que la base refuserait TOUTES les inscriptions — de vraies
 * personnes perdues pour un risque qui, lui, reste borné. C'est l'inverse exact de la vérification
 * de suppression, qui ferme : là, « je ne sais pas » peut réabonner quelqu'un qui a demandé l'oubli.
 */

/**
 * ⚠️ LES DEUX SEUILS. Mesuré le 24/09/2026 : une vraie personne a reçu au plus 3 confirmations pour
 * une même souscription (réinscriptions répétées), et le site entier reçoit quelques inscriptions
 * par jour. 5 par adresse sur 24 h laisse passer toute réinscription humaine et borne un
 * bombardement à 5 e-mails par jour ; 20 par IP sur une heure laisse passer un NAT d'opérateur
 * mobile (plusieurs personnes derrière une même IP) et arrête une machine qui enchaîne.
 * Fenêtres ≤ 48 h : la fonction refuse au-delà, parce qu'elle purge tout ce qui est plus vieux.
 */
export const LIMITE_PAR_ADRESSE = { max: 5, fenetreSecondes: 24 * 3600 } as const;
export const LIMITE_PAR_IP = { max: 20, fenetreSecondes: 3600 } as const;

/**
 * L'adresse telle qu'une BOÎTE la reçoit : casse et espaces ignorés, et le suffixe `+…` retiré.
 *
 * ⛔ LE SUFFIXE, SURTOUT. `victime+1@…`, `victime+2@…` arrivent tous dans la même boîte chez la
 * plupart des fournisseurs : sans ce retrait, un bombardement contournerait la limite par adresse
 * en variant un chiffre. Ce n'est QUE la clé de débit — l'adresse inscrite reste celle saisie.
 */
export function adresseDeDebit(email: string): string {
  const a = email.trim().toLowerCase();
  const at = a.lastIndexOf("@");
  if (at <= 0) return a;
  const local = a.slice(0, at);
  const plus = local.indexOf("+");
  return `${plus > 0 ? local.slice(0, plus) : local}${a.slice(at)}`;
}

/** Empreinte sha256 hexadécimale d'une clé préfixée par son genre (`ip:` / `address:`). */
export function empreinteDebit(genre: "ip" | "address", valeur: string): string {
  return createHash("sha256").update(`${genre}:${valeur}`).digest("hex");
}

export type VerdictDebit = { ok: true } | { ok: false; limitePar: "ip" | "address"; reessayerDans: number };

/**
 * Compte cette tentative et dit si elle passe. Une tentative REFUSÉE n'est pas comptée : les N
 * premières d'une fenêtre passent, les suivantes attendent qu'une place se libère — un appelant
 * qui insiste ne rallonge pas sa propre attente, et le pont qui rejoue un lead refusé passera dès
 * que la fenêtre le permet.
 */
export async function limiterInscription(db: Db, args: { ip: string | null; email: string }): Promise<VerdictDebit> {
  let rendu: unknown;
  try {
    const { data, error } = await db.rpc("signup_rate_take", {
      p_ip_key: args.ip ? empreinteDebit("ip", args.ip) : null,
      p_address_key: empreinteDebit("address", adresseDeDebit(args.email)),
      p_ip_max: LIMITE_PAR_IP.max,
      p_ip_window_seconds: LIMITE_PAR_IP.fenetreSecondes,
      p_address_max: LIMITE_PAR_ADRESSE.max,
      p_address_window_seconds: LIMITE_PAR_ADRESSE.fenetreSecondes,
    });
    if (error) return ouvert(error.message);
    rendu = data;
  } catch (e) {
    return ouvert(e instanceof Error ? e.message : String(e));
  }

  const r = (rendu ?? {}) as { allowed?: unknown; limited_by?: unknown; retry_after_seconds?: unknown };
  if (r.allowed === true) return { ok: true };
  if (r.allowed === false && (r.limited_by === "ip" || r.limited_by === "address")) {
    const n = Number(r.retry_after_seconds);
    return { ok: false, limitePar: r.limited_by, reessayerDans: Number.isFinite(n) && n > 0 ? Math.ceil(n) : 60 };
  }
  // Une réponse qu'on ne sait pas lire n'est pas un refus : même doctrine que la panne.
  return ouvert(`reponse-illisible:${JSON.stringify(rendu).slice(0, 120)}`);
}

function ouvert(raison: string): VerdictDebit {
  console.error(JSON.stringify({ event: "signup-rate-limit-unavailable", passed: true, reason: raison }));
  return { ok: true };
}

/**
 * Le 429. ⚠️ Il ne dit PAS quelle limite a mordu : répondre « cette adresse a déjà été soumise »
 * apprendrait à un anonyme qu'une adresse vient d'être inscrite ailleurs. Le détail va au journal.
 */
export function reponseTropDeTentatives(v: Extract<VerdictDebit, { ok: false }>): NextResponse {
  console.error(JSON.stringify({ event: "signup-rate-limited", limited_by: v.limitePar, retry_after_seconds: v.reessayerDans }));
  return NextResponse.json(
    {
      error: "trop-de-tentatives",
      message: "Too many sign-up attempts. Please wait a while before trying again.",
      retry_after_seconds: v.reessayerDans,
    },
    { status: 429, headers: { "Retry-After": String(v.reessayerDans) } },
  );
}
