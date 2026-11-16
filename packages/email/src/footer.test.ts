/**
 * Banc du footer légal.
 *
 * ⛔ POURQUOI IL N'EXISTAIT PAS, ET POURQUOI C'ÉTAIT LE PLUS GRAVE DES MANQUES. Au 09/09/2026,
 * aucun `*.test.ts` du dépôt ne contenait `buildFooter(`, `Impressum`, `street_address` ni
 * `nif_cif` : le seul endroit du produit qui porte les mentions obligatoires — désinscription,
 * identité de l'expéditeur, Impressum allemand, NIF espagnol, CASL canadien, CAN-SPAM américain —
 * n'était couvert par rien. Une régression y est invisible jusqu'à la boîte de réception, et son
 * coût n'est pas esthétique : c'est une infraction, répétée à chaque destinataire.
 *
 * ⚠️ Ces mentions sont pour la plupart NON OBSERVABLES en production aujourd'hui : les 6 éditions
 * sont gdpr (GB, CL) ou lgpd (BR), aucune n'est canspam, aucun marché n'est DE, ES, CA ou JP. Le
 * banc est donc la SEULE chose qui les tient — raison de plus pour qu'il existe.
 */
import { describe, expect, test } from "bun:test";
import { buildFooter } from "./footer";

const base = {
  assetName: "Quartz Tips",
  unsubUrl: "https://x.invalid/u?t=1",
  prefsUrl: "https://x.invalid/p?t=1",
};

describe("le lien de désinscription est toujours là", () => {
  test("dans le HTML ET dans le texte, quel que soit le régime", () => {
    // ⛔ Le seul contenu vraiment non négociable : sans lui l'envoi est illégal partout, et le
    // worker met d'ailleurs la ligne en veto (`footer_incomplete`).
    for (const regime of ["gdpr", "lgpd", "canspam"] as const) {
      const f = buildFooter({ ...base, regime, cfg: {} });
      expect(f.html).toContain("https://x.invalid/u?t=1");
      expect(f.text).toContain("https://x.invalid/u?t=1");
    }
  });
});

describe("ce que `missing` signale — et ce qui arrive quand il n'est pas vide", () => {
  test("l'URL de politique de confidentialité manque toujours quand elle n'est pas configurée", () => {
    expect(buildFooter({ ...base, regime: "gdpr", cfg: {} }).missing).toContain("privacy_url");
  });

  test("⛔ CAN-SPAM sans adresse postale ⇒ manquant — et l'envoi sera SAUTÉ", () => {
    // Conséquence concrète, mesurée sur le code : `missing` remonte dans `footerMissing`, que
    // `process.ts` traduit en `skipped:footer_incomplete`. Basculer une marque en canspam sans
    // remplir l'adresse ARRÊTE ses envois — sans erreur, juste un compteur de sautés.
    expect(buildFooter({ ...base, regime: "canspam", cfg: {} }).missing).toContain("physical_address");
    expect(
      buildFooter({ ...base, regime: "canspam", cfg: { physical_address: "1 Main St" } }).missing,
    ).not.toContain("physical_address");
  });

  test("le marché DE exige la rue et la forme juridique", () => {
    const m = buildFooter({ ...base, regime: "gdpr", market: "DE", cfg: {} }).missing;
    expect(m).toContain("street_address");
    expect(m).toContain("legal_form");
  });
});

describe("les mentions varient par marché — chacune, et seulement chez elle", () => {
  test("Impressum sur DE", () => {
    const f = buildFooter({
      ...base,
      regime: "gdpr",
      market: "DE",
      cfg: { street_address: "Hauptstr. 1", legal_form: "GmbH", commercial_register: "HRB 1", vat_id: "DE1" },
    });
    expect(f.html).toContain("Impressum");
    expect(f.html).toContain("Hauptstr. 1");
    // Et pas ailleurs : une mention allemande sur un e-mail brésilien n'est pas « prudente », elle
    // est fausse.
    expect(buildFooter({ ...base, regime: "lgpd", market: "BR", cfg: {} }).html).not.toContain("Impressum");
  });

  test("NIF/CIF sur ES", () => {
    const f = buildFooter({ ...base, regime: "gdpr", market: "ES", cfg: { nif_cif: "B12345678" } });
    expect(f.html).toContain("NIF/CIF");
    expect(f.html).toContain("B12345678");
  });

  test("téléphone et délai de 60 jours sur CA", () => {
    const f = buildFooter({ ...base, regime: "canspam", market: "CA", cfg: { physical_address: "1 Main St", phone: "+1 555" } });
    expect(f.html).toContain("+1 555");
    expect(f.html).toContain("60 days");
  });

  test("expéditeur nommé sur JP", () => {
    const f = buildFooter({ ...base, regime: "gdpr", market: "JP", cfg: { sender_name: "K.K.", sender_address: "Tokyo" } });
    expect(f.html).toContain("K.K.");
  });

  test("délai d'opt-out CAN-SPAM, et le réglage est respecté", () => {
    const d = buildFooter({ ...base, regime: "canspam", cfg: { physical_address: "1 Main St" } });
    expect(d.html).toContain("10 days");
    const perso = buildFooter({ ...base, regime: "canspam", cfg: { physical_address: "1 Main St", opt_out_days: 3 } });
    expect(perso.html).toContain("3 days");
  });

  test("contact DPO sur LGPD seulement", () => {
    const lgpd = buildFooter({ ...base, regime: "lgpd", cfg: { dpo_contact: "dpo@x.invalid" } });
    expect(lgpd.html).toContain("dpo@x.invalid");
    const gdpr = buildFooter({ ...base, regime: "gdpr", cfg: { dpo_contact: "dpo@x.invalid" } });
    expect(gdpr.html).not.toContain("dpo@x.invalid");
  });
});

describe("l'échappement", () => {
  test("⛔ un nom de marque ne peut pas injecter de balise", () => {
    // Le nom vient de la base, donc d'une saisie. Non échappé, il ouvrirait une injection dans un
    // e-mail envoyé à toute une liste.
    const f = buildFooter({ ...base, assetName: '<script>alert(1)</script>', regime: "gdpr", cfg: {} });
    expect(f.html).not.toContain("<script>");
    expect(f.html).toContain("&lt;script&gt;");
  });
});

/* ------------------------------------------------------------------ *
 * Habillage et phrase par marque — ajoutés le 15/09/2026
 * ------------------------------------------------------------------ */

describe("le pied légal devient éditable par marque, sans changer ce qui part aujourd'hui", () => {
  /**
   * ⛔ LE TEST LE PLUS IMPORTANT DE CE BLOC, ET IL NE PARLE PAS DE LA NOUVELLE FONCTION.
   *
   * Ce pied est déjà parti des millions de fois dans cette forme exacte. Le poids de l'e-mail se
   * mesure EN OCTETS contre `GMAIL_CLIP_BYTES`, et c'est ce poids qui refuse une publication : un
   * conteneur réécrit « proprement » — même ordre de propriétés, même rendu visuel — changerait
   * d'un coup la mesure de toutes les marques, et ferait basculer des modèles qui passaient de
   * justesse. La chaîne est donc ANCRÉE ici, littéralement.
   *
   * MUTATION QUI DOIT LE TUER : réordonner les propriétés CSS, ou poser un défaut « équivalent ».
   */
  test("sans aucun jeton de style, le conteneur est IDENTIQUE à l'octet près", () => {
    const f = buildFooter({ ...base, regime: "gdpr", cfg: {} });
    expect(f.html).toStartWith(
      '<div style="font-family:Arial,sans-serif;font-size:11px;color:#999;line-height:1.55;' +
        'padding:16px 20px;border-top:1px solid #eee;text-align:center">',
    );
    // Aucun fond n'est posé tant que personne n'en demande un.
    expect(f.html).not.toContain("background:");
    // Et la couleur des liens ne bouge pas non plus.
    expect(f.html).toContain('style="color:#888"');
  });

  test("deux marques aux jetons différents produisent deux pieds différents", () => {
    const northwindSports = buildFooter({
      ...base,
      regime: "lgpd",
      cfg: { style: { color: "#1b1b1b", linkColor: "#e10600", background: "#fafafa", align: "left" } },
    });
    const harborTech = buildFooter({
      ...base,
      regime: "gdpr",
      cfg: { style: { color: "#274488", linkColor: "#274488", fontSizePx: 12 } },
    });

    expect(northwindSports.html).toContain("color:#1b1b1b");
    expect(northwindSports.html).toContain("background:#fafafa");
    expect(northwindSports.html).toContain("text-align:left");
    expect(northwindSports.html).toContain('style="color:#e10600"');

    expect(harborTech.html).toContain("font-size:12px");
    expect(harborTech.html).not.toContain("background:");
    expect(northwindSports.html).not.toBe(harborTech.html);
  });

  test("un jeton absent garde EXACTEMENT la valeur d'origine, jamais un vide", () => {
    // Ne poser que la couleur ne doit pas emporter la police ni la bordure avec elle.
    const f = buildFooter({ ...base, regime: "gdpr", cfg: { style: { color: "#000" } } });
    expect(f.html).toContain("font-family:Arial,sans-serif");
    expect(f.html).toContain("border-top:1px solid #eee");
    expect(f.html).toContain("text-align:center");
  });

  /**
   * ⛔ MUTATION QUI DOIT LE TUER : rendre `i.reason ?? s.footer_reason(assetName)` (l'état d'avant).
   * Symptôme : l'écran propose d'écrire la phrase, l'enregistre, et l'e-mail part avec la phrase
   * par défaut — un réglage qui ne fait rien est pire qu'un réglage absent.
   */
  test("la phrase « pourquoi je reçois ceci » vient de la config de la marque", () => {
    const f = buildFooter({
      ...base,
      regime: "lgpd",
      cfg: { reason: "Você recebe este e-mail porque se inscreveu no Quartz Tips." },
    });
    expect(f.html).toContain("Você recebe este e-mail porque se inscreveu no Quartz Tips.");
    expect(f.text).toStartWith("Você recebe este e-mail porque se inscreveu no Quartz Tips.");
  });

  test("l'appelant garde le dernier mot sur la phrase — la config ne l'écrase pas", () => {
    const f = buildFooter({
      ...base,
      regime: "gdpr",
      cfg: { reason: "phrase de la marque" },
      reason: "phrase de cet envoi",
    });
    expect(f.html).toContain("phrase de cet envoi");
    expect(f.html).not.toContain("phrase de la marque");
  });

  test("la phrase est échappée — c'est du texte saisi par un humain", () => {
    const f = buildFooter({ ...base, regime: "gdpr", cfg: { reason: '<script>x</script>' } });
    expect(f.html).toContain("&lt;script&gt;");
    expect(f.html).not.toContain("<script>");
  });

  /**
   * ⛔ Le style ne doit RIEN changer aux mentions obligatoires. Un jeton de couleur qui ferait
   * disparaître un `missing` transformerait un réglage cosmétique en contournement de conformité.
   */
  test("les jetons de style ne touchent jamais `missing`", () => {
    const nu = buildFooter({ ...base, regime: "canspam", cfg: {} });
    const style = buildFooter({
      ...base,
      regime: "canspam",
      cfg: { style: { color: "#fff", background: "#000" } },
    });
    expect(style.missing).toEqual(nu.missing);
    expect(style.missing).toContain("physical_address");
    expect(style.missing).toContain("privacy_url");
  });
});

/**
 * ⛔ CE QUI ENTRE PAR `cfg` EST ÉCRIT PAR UN HUMAIN, DEPUIS UN ÉCRAN.
 *
 * Tant que `legal_footer` ne changeait que par MIGRATION, son contenu était du code relu. Depuis
 * H5, un administrateur de marque l'écrit dans un formulaire — et `privacy_url` atterrit dans un
 * attribut `href`. Le banc doit donc tenir ce que la relecture tenait avant lui.
 */
describe("le pied n'est pas injectable par ce qu'on lui confie", () => {
  test("⛔ un `privacy_url` porteur d'un guillemet NE SORT PAS de l'attribut `href`", () => {
    // `esc` n'échappe pas les guillemets — c'est correct entre deux balises, et faux dans un
    // attribut, où le guillemet le FERME. Sans `escAttr`, cette valeur ajoutait un attribut
    // `onmouseover` au lien de chaque e-mail de l'édition.
    /*
     * ⛔ LE CHEMIN EST VOLONTAIREMENT DISTINCT DE `base.prefsUrl` (`https://x.invalid/p?t=1`).
     * La première version de ce test assertait `toContain("https://x.invalid/p")` : le lien de
     * PRÉFÉRENCES le satisfaisait à lui seul, donc l'assertion serait restée verte même si le lien
     * de confidentialité avait disparu du pied. Un document assemblé a plusieurs producteurs.
     */
    const f = buildFooter({
      ...base,
      regime: "gdpr",
      cfg: { privacy_url: `https://x.invalid/POLITIQUE" onmouseover="alert(1)` },
    });
    // L'attribut n'est jamais refermé : la séquence dangereuse n'existe nulle part dans le document.
    expect(f.html).not.toContain('onmouseover="alert(1)"');
    // Et le `href` du lien de confidentialité porte la valeur ÉCHAPPÉE, en entier.
    expect(f.html).toContain('href="https://x.invalid/POLITIQUE&quot; onmouseover=&quot;alert(1)"');
  });

  test("⛔ `fontFamily` ne peut pas ouvrir une déclaration CSS par une ENTITÉ HTML", () => {
    /*
     * ⛔ LE DÉFAUT QUE LE FILTRE DE LA ROUTE NE POUVAIT PAS TENIR. `Arial&#59display:none` ne
     * contient AUCUN point-virgule littéral : il traversait le refus du `;`, et le décodeur
     * d'entités du client de messagerie le rendait en `font-family:Arial;display:none;…`. Le
     * conteneur entier du pied disparaissait — lien de désinscription compris — pendant que
     * `missing` restait vide et qu'aucune ligne n'échouait.
     */
    const f = buildFooter({
      ...base,
      regime: "gdpr",
      cfg: { style: { fontFamily: "Arial&#59display:none" } },
    });
    expect(f.html).toContain("font-family:Arial&amp;#59display:none;");
    expect(f.html).not.toContain("font-family:Arial&#59display:none;");
  });

  test("une pile de polices ordinaire traverse l'échappement SANS changer d'un octet", () => {
    // ⛔ La contre-épreuve de l'échappement : le poids du pied se mesure en OCTETS contre
    // `GMAIL_CLIP_BYTES`. Si `escAttr` modifiait une pile de polices normale, il changerait d'un
    // coup la mesure de toutes les marques — et donc ce que la plateforme accepte de publier.
    const f = buildFooter({
      ...base,
      regime: "gdpr",
      cfg: { style: { fontFamily: "Helvetica Neue, Arial, sans-serif" } },
    });
    expect(f.html).toContain('<div style="font-family:Helvetica Neue, Arial, sans-serif;font-size:');
  });

  test("⛔ une esperluette d'URL s'écrit `&amp;` dans le HTML, et reste nue dans le texte", () => {
    const f = buildFooter({
      ...base,
      unsubUrl: "https://x.invalid/u?t=1&lang=fr",
      regime: "gdpr",
      cfg: {},
    });
    expect(f.html).toContain("https://x.invalid/u?t=1&amp;lang=fr");
    expect(f.text).toContain("https://x.invalid/u?t=1&lang=fr");
  });

  /**
   * ⛔ CE TEST ANCRE LA RAISON D'ÊTRE D'UN GARDE QUI VIT AILLEURS — dans la route
   * `api/builder/legal-footer/[editionId]`, qui refuse d'écrire une saisie blanche. Il ne teste pas
   * la route (aucun banc de route n'existe dans ce dépôt) : il démontre le DÉGÂT qu'elle évite, pour
   * que retirer ce garde cesse d'être indolore.
   */
  test("⛔ un `controller` VIDE fait DISPARAÎTRE l'identité de l'expéditeur — `??` ne rattrape pas `\"\"`", () => {
    const absent = buildFooter({ ...base, regime: "gdpr", cfg: { physical_address: "1 rue X" } });
    // Champ absent : on retombe bien sur le nom de la marque.
    expect(absent.text).toContain("Quartz Tips — 1 rue X");

    const vide = buildFooter({
      ...base,
      regime: "gdpr",
      cfg: { controller: "", physical_address: "1 rue X" },
    });
    // Chaîne vide : `cfg.controller ?? assetName` rend `""`, et l'identité s'évapore. Le pied reste
    // conforme aux yeux de `missing`, ce qui est précisément ce qui rend le défaut silencieux.
    expect(vide.text).not.toContain("Quartz Tips — 1 rue X");
    expect(vide.missing).toEqual(absent.missing);
  });
});
