/**
 * Mise en forme de l'activité d'un abonné — la section « Email activity on <marque> » du tiroir.
 *
 * ⛔ MODULE NEUTRE (comme `lib/engagement.ts`) : ni base, ni session, ni "use client". Le composant
 * serveur du tiroir l'importe, et `subscriber-activity-view.test.ts` le mesure sans rien monter.
 *
 * ⛔ UN INCONNU NE S'AFFICHE JAMAIS COMME UN ZÉRO. « 0 opens » sur une personne à qui aucun envoi suivi
 * n'est parti se lirait « elle n'ouvre rien », alors que personne ne pouvait le savoir.
 *
 * ⛔ AUCUNE ADRESSE E-MAIL NEUVE À L'ÉCRAN. Un lien cliqué peut porter l'adresse en paramètre, une
 * raison de rebond la cite presque toujours (« 550 <x@y.com>: Recipient address rejected ») : les deux
 * passent par `masquerAdresses` avant d'atteindre le HTML — `title` compris.
 */
import type { AbonnementActivite, EvenementActivite, MessageActivite } from "@/lib/engagement";

/** Les tons de `Pill`, recopiés ici pour ne rien importer d'un composant. */
export type TonActivite = "green" | "blue" | "amber" | "red" | "grey" | "violet";

// ---------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------
/** Même rendu que le reste du tiroir ; `—` pour une date absente ou illisible, jamais « Invalid Date ». */
export function formaterInstant(ts: string | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

// ---------------------------------------------------------------------------------------------
// Adresses
// ---------------------------------------------------------------------------------------------
/** Une adresse, en clair ou encodée dans une URL (`%40`). */
const ADRESSE = /[A-Za-z0-9._%+-]+(?:@|%40)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gi;

/** Remplace toute adresse e-mail par `[email]`. */
export function masquerAdresses(texte: string): string {
  return texte.replace(ADRESSE, "[email]");
}

// ---------------------------------------------------------------------------------------------
// Résumé de l'abonnement
// ---------------------------------------------------------------------------------------------
export type Mesure = { known: true; value: number } | { known: false; reason: string };

/**
 * Un compteur d'ouvertures ou de clics, ou « non mesuré ».
 *
 * ⛔ Un 0 n'est un vrai zéro que si au moins un des envois montrés a été SUIVI : sans pixel ni lien
 * réécrit, une ouverture ne peut pas être vue. Un compteur > 0, lui, est toujours une mesure.
 */
export function compteurMesure(n: number, messages: Pick<MessageActivite, "tracked">[]): Mesure {
  if (n > 0) return { known: true, value: n };
  if (messages.some((m) => m.tracked === true)) return { known: true, value: 0 };
  return {
    known: false,
    reason: messages.length === 0 ? "no email sent yet" : "none of these emails was tracked",
  };
}

/** La dernière ouverture / le dernier clic : une date, « Never » si mesuré sans rien, `—` si non mesuré. */
export function dernierMesure(ts: string | null, mesure: Mesure): string {
  if (ts) return formaterInstant(ts);
  return mesure.known ? "Never" : "—";
}

const NIVEAUX: Record<string, string> = { active: "Active", dormant: "Dormant", churned: "Lapsed" };

/** Niveau et score d'engagement — « Not scored yet » quand la base n'a encore rien calculé. */
export function libelleEngagement(s: Pick<AbonnementActivite, "engagementLevel" | "engagementScore">): string {
  const niveau = s.engagementLevel === null ? null : (NIVEAUX[s.engagementLevel] ?? s.engagementLevel);
  if (niveau === null && s.engagementScore === null) return "Not scored yet";
  if (niveau === null) return `Score ${s.engagementScore}`;
  if (s.engagementScore === null) return niveau;
  return `${niveau} · score ${s.engagementScore}`;
}

/** « N emails », ou « Showing N of T emails » quand la lecture a été bornée. */
export function libelleNombreMessages(affiches: number, total: number): string {
  if (total === 0) return "No email sent to this person from this brand yet";
  if (affiches >= total) return `${total} email${total === 1 ? "" : "s"} — most recent first`;
  return `Showing ${affiches} of ${total} emails — most recent first`;
}

// ---------------------------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------------------------
const TYPES: Record<string, string> = {
  campaign: "Campaign",
  automation: "Automation",
  automation_tx: "Automation (transactional)",
  confirmation: "Confirmation request",
  welcome: "Welcome",
  unsubscribe_ack: "Unsubscribe confirmation",
  reengagement: "Re-engagement",
  test: "Test send",
};

/** Le type d'envoi en clair ; un type inconnu reste affiché tel quel, jamais réécrit. */
export function libelleType(kind: string): string {
  return TYPES[kind] ?? kind;
}

const STATUTS: Record<string, { label: string; tone: TonActivite }> = {
  sent: { label: "Sent", tone: "green" },
  pending: { label: "Queued", tone: "amber" },
  sending: { label: "Sending", tone: "blue" },
  failed: { label: "Failed", tone: "red" },
  skipped: { label: "Skipped", tone: "grey" },
};

export function statutMessage(status: string): { label: string; tone: TonActivite } {
  return STATUTS[status] ?? { label: status, tone: "grey" };
}

/**
 * Ce que le suivi de CET envoi permet de dire. `true` = rien à signaler ; `false` = envoyé sans suivi
 * (aucune ouverture ne pouvait remonter) ; `null` = parti avant que le suivi soit mémorisé (0085).
 */
export function mentionSuivi(tracked: boolean | null): string | null {
  if (tracked === true) return null;
  return tracked === false ? "tracking off" : "tracking unknown";
}

/** Le nom de la campagne, sinon l'objet ; l'objet en second quand les deux existent. */
export function titreMessage(m: Pick<MessageActivite, "campaignName" | "subject">): { titre: string; sousTitre: string | null } {
  const titre = m.campaignName ?? m.subject ?? "No subject recorded";
  return { titre, sousTitre: m.campaignName !== null && m.subject !== null ? m.subject : null };
}

/** La date qui situe un envoi : son départ, sinon sa création (encore en file, ou jamais parti). */
export function dateMessage(m: Pick<MessageActivite, "sentAt" | "createdAt">): string {
  return m.sentAt ? formaterInstant(m.sentAt) : `${formaterInstant(m.createdAt)} (created)`;
}

// ---------------------------------------------------------------------------------------------
// Événements
// ---------------------------------------------------------------------------------------------
export type CleEvenement =
  | "delivered" | "opened" | "machine" | "clicked" | "bounced" | "complained" | "unsubscribed" | "failed" | "other";

/**
 * Une ouverture déclenchée par une machine (Mailgun `client-info.bot`), pas par une personne.
 * ⛔ Même règle que `campaign_engagement` (0094) : `bot` non nul = machine. Une autre règle ici ferait
 * dire au tiroir « humain » là où la page de campagne compte un robot.
 */
export function estOuvertureMachine(e: Pick<EvenementActivite, "type" | "bot">): boolean {
  return e.type === "opened" && e.bot !== null;
}

const EVENEMENTS: Record<string, { label: string; tone: TonActivite }> = {
  delivered: { label: "Delivered", tone: "grey" },
  opened: { label: "Opened", tone: "green" },
  clicked: { label: "Clicked", tone: "violet" },
  bounced: { label: "Bounced", tone: "red" },
  complained: { label: "Marked as spam", tone: "red" },
  unsubscribed: { label: "Unsubscribed", tone: "amber" },
  failed: { label: "Delivery failed", tone: "red" },
};

export function libelleEvenement(
  e: Pick<EvenementActivite, "type" | "bot" | "severity">,
): { cle: CleEvenement; label: string; tone: TonActivite } {
  if (estOuvertureMachine(e)) return { cle: "machine", label: "Machine open (e.g. Apple Mail privacy)", tone: "grey" };
  const connu = EVENEMENTS[e.type];
  if (!connu) return { cle: "other", label: e.type, tone: "grey" };
  // La gravité d'un rebond ou d'un échec dit s'il sera retenté : « temporary » n'est pas « permanent ».
  const grave = (e.type === "bounced" || e.type === "failed") && e.severity ? ` (${e.severity})` : "";
  return { cle: e.type as CleEvenement, label: connu.label + grave, tone: connu.tone };
}

/** Appareil · client · système · « ville, pays » — pour une ouverture ou un clic, et seulement ce qui est su. */
export function detailEvenement(
  e: Pick<EvenementActivite, "type" | "deviceType" | "clientName" | "clientOs" | "city" | "country">,
): string | null {
  if (e.type !== "opened" && e.type !== "clicked") return null;
  const lieu = [e.city, e.country].filter((x): x is string => !!x).join(", ");
  const morceaux = [e.deviceType, e.clientName, e.clientOs, lieu].filter((x): x is string => !!x);
  return morceaux.length > 0 ? morceaux.join(" · ") : null;
}

/** Le lien cliqué, adresses masquées ; `null` hors clic ou sans lien. */
export function lienClique(e: Pick<EvenementActivite, "type" | "url">): string | null {
  return e.type === "clicked" && e.url ? masquerAdresses(e.url) : null;
}

/** La raison d'un rebond, d'un échec ou d'une plainte, adresses masquées. */
export function raisonEvenement(e: Pick<EvenementActivite, "type" | "reason">): string | null {
  if (!e.reason || !["bounced", "failed", "complained"].includes(e.type)) return null;
  return masquerAdresses(e.reason);
}
