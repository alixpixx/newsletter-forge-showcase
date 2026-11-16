/**
 * Banc de la formulation éditable du pied légal (lot 4, décision d'Alix du 22/09/2026).
 *
 * ⛔ DEUX PROMESSES, TENUES ICI ENSEMBLE PARCE QU'ELLES TIRENT EN SENS CONTRAIRE.
 *  1. Sans réglage, RIEN ne bouge : le HTML du pied est celui d'avant, à l'octet près. Son poids se
 *     mesure en octets contre `GMAIL_CLIP_BYTES` et un pied « presque pareil » ferait basculer d'un
 *     coup des modèles publiés de justesse. `footer.golden.json` a été capturé sur `master` @ 5311631
 *     AVANT la moindre modification de `footer.ts`, sur neuf pieds couvrant les trois régimes et les
 *     cinq marchés spécifiques.
 *  2. Avec un réglage, la FORMULATION change — et la PRÉSENCE des mentions obligatoires, jamais.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LOCALES, strings } from "./i18n";
import { buildFooter, defaultWording, footerLineOrder, FOOTER_LINES, type FooterInput } from "./footer";

const golden = JSON.parse(readFileSync(join(import.meta.dir, "footer.golden.json"), "utf8")) as Record<string, string>;

const base = { assetName: "Quartz Tips", unsubUrl: "https://x.invalid/u?t=1&l=pt", prefsUrl: "https://x.invalid/p?t=1" };
// ⚠️ Les MÊMES entrées que celles de la capture (script du 22/09, gardé dans le message de commit).
const cas: Record<string, FooterInput> = {
  gdpr_en: { ...base, regime: "gdpr", locale: "en", cfg: { controller: "Example Media Ltd", physical_address: "1 rue X", privacy_url: "https://x.invalid/privacy", responsible_gambling: true } },
  lgpd_pt: { ...base, regime: "lgpd", locale: "pt-BR", market: "BR", cfg: { controller: "Northwind Sports", privacy_url: "https://x.invalid/pp", dpo_contact: "dpo@x.invalid", responsible_gambling: true, reason: "Porque sim." } },
  canspam_us_en: { ...base, regime: "canspam", locale: "en", market: "US", cfg: { physical_address: "1 Main St", privacy_url: "https://x.invalid/pp", opt_out_days: 7 } },
  canspam_ca_en: { ...base, regime: "canspam", locale: "en", market: "CA", cfg: { physical_address: "1 Main St", privacy_url: "https://x.invalid/pp", phone: "+1 555", unsub_min_days: 90 } },
  gdpr_de: { ...base, regime: "gdpr", locale: "de", market: "DE", cfg: { street_address: "Hauptstr. 1", legal_form: "GmbH", commercial_register: "HRB 1", vat_id: "DE1", privacy_url: "https://x.invalid/pp" } },
  gdpr_es: { ...base, regime: "gdpr", locale: "es", market: "ES", cfg: { nif_cif: "B123", privacy_url: "https://x.invalid/pp" } },
  gdpr_jp: { ...base, regime: "gdpr", locale: "en", market: "JP", cfg: { sender_name: "K.K.", sender_address: "Tokyo", privacy_url: "https://x.invalid/pp" } },
  style: { ...base, regime: "gdpr", locale: "fr", cfg: { privacy_url: "https://x.invalid/pp", style: { color: "#111", linkColor: "#222", background: "#fafafa", align: "left", fontSizePx: 12, fontFamily: "Georgia, serif", borderTopColor: "#333" } } },
  sans_prefs: { assetName: "T", unsubUrl: "https://x.invalid/u", regime: "gdpr", cfg: {} },
};

describe("sans réglage de formulation, le HTML du pied est celui d'avant À L'OCTET PRÈS", () => {
  for (const [nom, entree] of Object.entries(cas)) {
    test(nom, () => {
      expect(golden[nom]).toBeDefined();
      expect(buildFooter(entree).html).toBe(golden[nom]!);
    });
  }

  test("un `wording` VIDE ne change rien non plus", () => {
    const e = cas.gdpr_en!;
    expect(buildFooter({ ...e, cfg: { ...e.cfg, wording: {} } }).html).toBe(golden.gdpr_en!);
  });
});

const complet = { ...base, regime: "gdpr" as const, locale: "en" as const, cfg: { controller: "X", physical_address: "1 rue X", privacy_url: "https://x.invalid/POLITIQUE" } };

describe("la formulation de la marque part dans l'e-mail", () => {
  test("un libellé de lien remplacé est rendu, dans le HTML ET dans le texte", () => {
    const f = buildFooter({ ...complet, cfg: { ...complet.cfg, wording: { unsubscribe: "Stop emails", privacy: "Our privacy", preferences: "My settings" } } });
    expect(f.html).toContain(">Stop emails</a>");
    expect(f.html).toContain(">Our privacy</a>");
    expect(f.html).toContain(">My settings</a>");
    expect(f.html).not.toContain(">Unsubscribe</a>");
    expect(f.text).toContain("Stop emails: https://x.invalid/u?t=1&l=pt");
  });

  test("la phrase RGPD, le séparateur et le préfixe DPO se reformulent", () => {
    const g = buildFooter({ ...complet, cfg: { ...complet.cfg, wording: { withdraw: "Withdraw whenever you like.", separator: " | " } } });
    expect(g.html).toContain("Withdraw whenever you like.");
    expect(g.html).toContain("</a> | <a ");
    const l = buildFooter({ ...base, regime: "lgpd", locale: "pt-BR", cfg: { privacy_url: "https://x.invalid/pp", dpo_contact: "d@x.invalid", wording: { dpo: "DPO :" } } });
    expect(l.html).toContain("DPO : d@x.invalid");
    expect(l.html).not.toContain("Encarregado");
  });

  test("`{days}` est remplacé par le délai de la marque dans les phrases CA et US", () => {
    const f = buildFooter({
      ...base,
      regime: "canspam",
      market: "CA",
      cfg: { physical_address: "1 Main St", privacy_url: "https://x.invalid/pp", unsub_min_days: 75, opt_out_days: 5, wording: { unsubValidity: "Valid {days} days.", optOut: "Done within {days} days." } },
    });
    expect(f.html).toContain("Valid 75 days.");
    expect(f.html).toContain("Done within 5 days.");
  });

  test("le texte saisi est échappé — c'est du texte écrit par un humain", () => {
    const f = buildFooter({ ...complet, cfg: { ...complet.cfg, wording: { unsubscribe: "<img src=x onerror=alert(1)>", separator: "<b>" } } });
    expect(f.html).not.toContain("<img");
    expect(f.html).not.toContain("<b>");
    expect(f.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  test("l'ordre des lignes se choisit", () => {
    const f = buildFooter({ ...complet, cfg: { ...complet.cfg, wording: { order: ["links", "identity", "reason"] } } });
    const iLiens = f.html.indexOf("Unsubscribe</a>");
    const iIdentite = f.html.indexOf("X — 1 rue X");
    const iRaison = f.html.indexOf("You are receiving");
    expect(iLiens).toBeGreaterThan(-1);
    expect(iLiens).toBeLessThan(iIdentite);
    expect(iIdentite).toBeLessThan(iRaison);
    // La première ligne n'a pas de marge, comme la phrase d'ouverture d'origine.
    expect(f.html).toContain('text-align:center"><div><a href=');
  });
});

/**
 * ⛔ LA PRÉSENCE RESTE VERROUILLÉE. Chaque test casse la formulation d'une façon différente et
 * vérifie que la mention obligatoire est toujours là — ou que l'envoi est refusé.
 */
describe("la formulation ne peut pas RETIRER une mention obligatoire", () => {
  test("⛔ un libellé de désinscription blanc rend le libellé par défaut, jamais un lien invisible", () => {
    for (const blanc of ["", "   ", "\t\n"]) {
      const f = buildFooter({ ...complet, cfg: { ...complet.cfg, wording: { unsubscribe: blanc, privacy: blanc } } });
      expect(f.html).toContain('style="color:#888">Unsubscribe</a>');
      expect(f.html).toContain('style="color:#888">Privacy Policy</a>');
    }
  });

  test("⛔ un ordre qui OMET les liens les rend quand même — en fin de pied", () => {
    const f = buildFooter({ ...complet, cfg: { ...complet.cfg, wording: { order: ["reason"] } } });
    expect(f.html).toContain('href="https://x.invalid/u?t=1&amp;l=pt"');
    expect(f.html).toContain('href="https://x.invalid/POLITIQUE"');
    expect(f.text).toContain("https://x.invalid/u?t=1&l=pt");
  });

  test("un ordre écrit à la main en base (inconnues, doublons) est nettoyé puis complété", () => {
    expect(footerLineOrder(["links", "links", "nimporte", 3])).toEqual(["links", ...FOOTER_LINES.filter((l) => l !== "links")]);
    expect(footerLineOrder(undefined)).toEqual([...FOOTER_LINES]);
  });

  test("⛔ sans URL de désinscription, le pied est déclaré INCOMPLET — le worker refuse l'envoi", () => {
    for (const vide of ["", "   "]) {
      const f = buildFooter({ ...complet, unsubUrl: vide });
      expect(f.missing).toContain("unsubscribe_url");
    }
    expect(buildFooter(complet).missing).toEqual([]);
  });

  test("⛔ sans URL de confidentialité ⇒ incomplet, quelle que soit la formulation", () => {
    const f = buildFooter({ ...complet, cfg: { controller: "X", wording: { privacy: "Privacy" } } });
    expect(f.missing).toContain("privacy_url");
  });

  test("⛔ CAN-SPAM sans adresse postale ⇒ incomplet, quelle que soit la formulation", () => {
    const f = buildFooter({ ...base, regime: "canspam", cfg: { privacy_url: "https://x.invalid/pp", wording: { identitySeparator: " / ", optOut: "x {days}" } } });
    expect(f.missing).toContain("physical_address");
  });
});

describe("le texte brut porte le lien de préférences (élément 128)", () => {
  test("dans l'ordre Désinscription · Préférences · Confidentialité", () => {
    const f = buildFooter(complet);
    expect(f.text).toContain(
      "Unsubscribe: https://x.invalid/u?t=1&l=pt · Preferences: https://x.invalid/p?t=1 · Privacy Policy: https://x.invalid/POLITIQUE",
    );
  });

  test("et il n'invente pas de lien quand l'appelant n'en a pas", () => {
    const { prefsUrl: _sans, ...sansPrefs } = complet;
    expect(buildFooter(sansPrefs).text).not.toContain("Preferences");
  });
});

describe("les mentions de marché existent dans CHAQUE langue servie", () => {
  test("CA et US : une phrase par langue, avec le délai, sans reste d'anglais hors `en`", () => {
    for (const locale of LOCALES) {
      const s = strings(locale);
      for (const cle of ["footer_unsub_validity", "footer_optout", "footer_dpo", "footer_phone"] as const) {
        expect(s[cle].trim().length).toBeGreaterThan(0);
      }
      expect(s.footer_unsub_validity).toContain("{days}");
      expect(s.footer_optout).toContain("{days}");
      if (locale !== "en") {
        expect(s.footer_unsub_validity).not.toBe(strings("en").footer_unsub_validity);
        expect(s.footer_optout).not.toBe(strings("en").footer_optout);
      }

      const f = buildFooter({
        ...base,
        locale,
        regime: "canspam",
        market: "CA",
        cfg: { physical_address: "1 Main St", privacy_url: "https://x.invalid/pp", phone: "+1 555", unsub_min_days: 60, opt_out_days: 10 },
      });
      expect(f.text).toContain(s.footer_unsub_validity.split("{days}").join("60"));
      expect(f.text).toContain(s.footer_optout.split("{days}").join("10"));
      expect(f.text).toContain(`${s.footer_phone} +1 555`);
    }
  });

  test("le préfixe DPO suit la langue de l'édition — plus de portugais sur un e-mail allemand", () => {
    const de = buildFooter({ ...base, locale: "de", regime: "lgpd", cfg: { privacy_url: "https://x.invalid/pp", dpo_contact: "d@x.invalid" } });
    expect(de.html).toContain("Datenschutzbeauftragter (DPO): d@x.invalid");
    expect(de.html).not.toContain("Encarregado");
  });

  test("`defaultWording` rend un texte non vide pour chaque champ, dans chaque langue", () => {
    for (const locale of LOCALES) {
      for (const [k, v] of Object.entries(defaultWording(locale))) {
        expect(`${k}:${v.length > 0}`).toBe(`${k}:true`);
      }
    }
  });
});
