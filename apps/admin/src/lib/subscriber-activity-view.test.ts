/**
 * La mise en forme de l'activité d'un abonné (tiroir « Email activity on <marque> »).
 *
 * ⛔ CE QUE CE BANC GARDE D'ABORD : un compteur à 0 sans aucun envoi suivi n'est PAS un zéro, et aucune
 * adresse e-mail n'atteint l'écran par un lien cliqué ou une raison de rebond.
 */
import { describe, expect, test } from "bun:test";
import {
  compteurMesure,
  dateMessage,
  dernierMesure,
  detailEvenement,
  estOuvertureMachine,
  formaterInstant,
  libelleEngagement,
  libelleEvenement,
  libelleNombreMessages,
  libelleType,
  lienClique,
  masquerAdresses,
  mentionSuivi,
  raisonEvenement,
  statutMessage,
  titreMessage,
} from "./subscriber-activity-view";
import type { EvenementActivite } from "./engagement";

const ev = (o: Partial<EvenementActivite>): EvenementActivite => ({
  type: "opened",
  occurredAt: "2026-10-07T09:00:00Z",
  severity: null,
  reason: null,
  url: null,
  deviceType: null,
  clientName: null,
  clientOs: null,
  bot: null,
  country: null,
  city: null,
  ...o,
});

describe("⛔ un inconnu n'est jamais un zéro", () => {
  test("0 sans aucun envoi suivi ⇒ non mesuré, avec sa raison", () => {
    expect(compteurMesure(0, [{ tracked: false }, { tracked: null }])).toEqual({
      known: false,
      reason: "none of these emails was tracked",
    });
    expect(compteurMesure(0, [])).toEqual({ known: false, reason: "no email sent yet" });
  });

  test("0 avec au moins un envoi suivi ⇒ un vrai zéro", () => {
    expect(compteurMesure(0, [{ tracked: false }, { tracked: true }])).toEqual({ known: true, value: 0 });
  });

  test("un compteur positif est toujours une mesure, même sans envoi suivi montré", () => {
    expect(compteurMesure(3, [{ tracked: null }])).toEqual({ known: true, value: 3 });
  });

  test("dernière ouverture : date, « Never » si mesuré, « — » si non mesuré", () => {
    expect(dernierMesure(null, { known: true, value: 0 })).toBe("Never");
    expect(dernierMesure(null, { known: false, reason: "x" })).toBe("—");
    expect(dernierMesure("2026-10-07T09:00:00Z", { known: false, reason: "x" })).toContain("2026");
  });

  test("engagement sans calcul ⇒ « Not scored yet », jamais « 0 »", () => {
    expect(libelleEngagement({ engagementLevel: null, engagementScore: null })).toBe("Not scored yet");
    expect(libelleEngagement({ engagementLevel: "churned", engagementScore: 12 })).toBe("Lapsed · score 12");
    expect(libelleEngagement({ engagementLevel: "active", engagementScore: null })).toBe("Active");
    expect(libelleEngagement({ engagementLevel: null, engagementScore: 0 })).toBe("Score 0");
  });

  test("une date absente ou illisible s'affiche « — »", () => {
    expect(formaterInstant(null)).toBe("—");
    expect(formaterInstant("pas une date")).toBe("—");
  });
});

describe("⛔ aucune adresse e-mail à l'écran", () => {
  test("une adresse en clair ou encodée dans un lien est masquée", () => {
    expect(masquerAdresses("https://x.invalid/p?email=jane.doe%40example.com&u=1")).toBe("https://x.invalid/p?email=[email]&u=1");
    expect(masquerAdresses("mailto:jane@example.co.uk")).toBe("mailto:[email]");
  });

  test("le lien cliqué et la raison d'un rebond passent par le masque", () => {
    expect(lienClique(ev({ type: "clicked", url: "https://x.invalid/?e=a@b.io" }))).toBe("https://x.invalid/?e=[email]");
    expect(raisonEvenement(ev({ type: "bounced", reason: "550 5.1.1 <a.b@c.org>: Recipient address rejected" })))
      .toBe("550 5.1.1 <[email]>: Recipient address rejected");
  });

  test("pas de lien hors clic, pas de raison hors rebond/échec/plainte", () => {
    expect(lienClique(ev({ type: "opened", url: "https://x.invalid" }))).toBeNull();
    expect(raisonEvenement(ev({ type: "delivered", reason: "250 OK" }))).toBeNull();
  });
});

describe("messages", () => {
  test("suivi : rien quand suivi, « tracking off » / « tracking unknown » sinon", () => {
    expect(mentionSuivi(true)).toBeNull();
    expect(mentionSuivi(false)).toBe("tracking off");
    expect(mentionSuivi(null)).toBe("tracking unknown");
  });

  test("titre : la campagne d'abord, l'objet en second ; l'objet seul sinon", () => {
    expect(titreMessage({ campaignName: "Weekly", subject: "Hello" })).toEqual({ titre: "Weekly", sousTitre: "Hello" });
    expect(titreMessage({ campaignName: null, subject: "Confirm" })).toEqual({ titre: "Confirm", sousTitre: null });
    expect(titreMessage({ campaignName: null, subject: null })).toEqual({ titre: "No subject recorded", sousTitre: null });
  });

  test("un envoi jamais parti est daté de sa création, et le dit", () => {
    expect(dateMessage({ sentAt: null, createdAt: "2026-10-07T09:00:00Z" })).toContain("(created)");
    expect(dateMessage({ sentAt: "2026-10-07T09:00:00Z", createdAt: "2026-10-07T08:00:00Z" })).not.toContain("(created)");
  });

  test("types et statuts connus en clair ; un inconnu reste tel quel", () => {
    expect(libelleType("automation_tx")).toBe("Automation (transactional)");
    expect(libelleType("nouveau_type")).toBe("nouveau_type");
    expect(statutMessage("failed")).toEqual({ label: "Failed", tone: "red" });
    expect(statutMessage("bizarre")).toEqual({ label: "bizarre", tone: "grey" });
  });

  test("nombre : « Showing N of T » seulement quand la lecture est bornée", () => {
    expect(libelleNombreMessages(100, 245)).toBe("Showing 100 of 245 emails — most recent first");
    expect(libelleNombreMessages(1, 1)).toBe("1 email — most recent first");
    expect(libelleNombreMessages(0, 0)).toBe("No email sent to this person from this brand yet");
  });
});

describe("événements", () => {
  test("⛔ une ouverture de robot est une « machine open », pas une ouverture", () => {
    const robot = ev({ type: "opened", bot: "apple" });
    expect(estOuvertureMachine(robot)).toBe(true);
    expect(libelleEvenement(robot)).toEqual({ cle: "machine", label: "Machine open (e.g. Apple Mail privacy)", tone: "grey" });
    expect(libelleEvenement(ev({ type: "opened" })).label).toBe("Opened");
    // Un clic n'est jamais une ouverture machine, même marqué robot.
    expect(estOuvertureMachine(ev({ type: "clicked", bot: "x" }))).toBe(false);
  });

  test("la gravité d'un rebond est dite ; un type inconnu reste tel quel", () => {
    expect(libelleEvenement(ev({ type: "bounced", severity: "permanent" })).label).toBe("Bounced (permanent)");
    expect(libelleEvenement(ev({ type: "complained" })).label).toBe("Marked as spam");
    expect(libelleEvenement(ev({ type: "stored" }))).toEqual({ cle: "other", label: "stored", tone: "grey" });
  });

  test("détail : appareil · client · système · ville, pays — seulement ce qui est su", () => {
    expect(
      detailEvenement(ev({ type: "clicked", deviceType: "mobile", clientName: "Gmail", clientOs: "Android", city: "Lyon", country: "FR" })),
    ).toBe("mobile · Gmail · Android · Lyon, FR");
    expect(detailEvenement(ev({ type: "opened", country: "BR" }))).toBe("BR");
    expect(detailEvenement(ev({ type: "opened" }))).toBeNull();
    expect(detailEvenement(ev({ type: "delivered", deviceType: "desktop" }))).toBeNull();
  });
});
