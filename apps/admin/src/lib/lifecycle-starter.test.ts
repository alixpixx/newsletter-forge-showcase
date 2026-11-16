import { describe, expect, test } from "bun:test";
import { compileDoc } from "@nf/render/compile";
import { EmailDocPublishable, MAX_BUTTON_LABEL } from "@nf/render/schema";
import { checkShellWeight } from "@nf/render/shell-checks";
import { LIFECYCLE_KINDS, checkLifecycleShell } from "@nf/render/lifecycle-checks";
import { LOCALES, strings, normalizeLocale } from "@nf/email";
import {
  libelleBouton,
  lifecycleStarter,
  lifecycleStarterDisplayName,
  lifecycleStarterDoc,
  lifecycleStarterLocale,
} from "./lifecycle-starter";

/**
 * ⛔ CE QUE CE BANC EXISTE POUR EMPÊCHER — et ce qu'il refuse de faire pour y arriver.
 *
 * Le geste « Customise » crée un modèle, le rattache à un e-mail de cycle de vie, puis ouvre le
 * builder. Si le document semé ne passe pas les contrôles, l'échec ne se voit qu'AU BOUT : le
 * rattachement rend 422, ou pire, la publication rend 422 après que la personne a passé dix minutes
 * à écrire. Un point de départ qui ne peut pas être publié est un piège, pas un point de départ.
 *
 * ⛔ ON APPELLE LES VRAIES FONCTIONS DE CONTRÔLE, JAMAIS LEUR RÈGLE RÉÉCRITE ICI. `checkLifecycleShell`,
 * `EmailDocPublishable`, `checkShellWeight` sont exactement celles qu'exécutent la route de
 * publication et la route de rattachement. Un banc qui rejouerait la règle à sa façon (« le HTML
 * contient-il `{{confirm_url}}` ? ») passerait au vert le jour où la vraie règle change — et
 * n'accuserait plus que lui-même.
 *
 * ⛔ ON JUGE LE COMPILÉ, PAS LE DOCUMENT. Un jeton présent dans le document peut disparaître à la
 * compilation (CTA sans lien, bloc que le compilateur n'émet pas). C'est le HTML compilé qui est
 * envoyé, donc c'est lui qu'on interroge — via `extractTokens`, dans `checkLifecycleShell`.
 */

const ENTREE = { assetSlug: "quartz-tips", locale: "en" };

/** Footer légal de gabarit, pour que la mesure de poids ne sous-estime pas (`footerProvided`). */
const FOOTER_GABARIT = `<div>${"conformité ".repeat(200)}</div>`;

describe("lifecycleStarterDoc — les quatre kinds franchissent les barrières de publication", () => {
  for (const kind of LIFECYCLE_KINDS) {
    test(`${kind} : publiable, compilable, footer légal émis, jeton exigé présent`, async () => {
      const doc = lifecycleStarterDoc(kind, ENTREE);

      // Barrière 1 — `EmailDocPublishable` (publish/route.ts). Elle attrape le sujet vide, l'alt
      // manquant, le lien de désabonnement écrit à la main, le footer sous condition.
      const publiable = EmailDocPublishable.safeParse(doc);
      expect(publiable.success).toBe(true);
      if (!publiable.success) return;

      // Barrière 2 — la compilation ne doit pas lever.
      const compiled = await compileDoc(publiable.data);

      // Barrière 3 — sans ce jeton, la publication rend 422 et le worker met l'envoi en veto.
      expect(compiled.html).toContain("{{legal_footer_html}}");

      // Barrière 4 — le contrôle de cycle de vie, sur le COMPILÉ, avec la vraie fonction.
      const rapport = checkLifecycleShell({
        kind,
        html: compiled.html,
        text: compiled.text,
        subject: publiable.data.meta.subject,
      });
      expect(rapport.missing).toEqual([]);
      expect(rapport.ok).toBe(true);

      // Barrière 5 — poids hydraté sous le seuil de coupe de Gmail.
      const poids = checkShellWeight({
        htmlShell: compiled.html,
        legalFooterHtml: FOOTER_GABARIT,
        publicBaseUrl: "https://news.example.com",
      });
      expect(poids.footerProvided).toBe(true);
      expect(poids.overLimit).toBe(false);

      // ⚠️ Le pré-vol du builder refuse de publier tant qu'un avertissement bloquant du compilateur
      // subsiste. Un point de départ qui naît déjà avec un avertissement fait croire à une faute
      // que la personne n'a pas commise.
      expect(compiled.warnings ?? []).toEqual([]);
    });
  }
});

describe("le jeton exigé survit à la compilation, dans les six langues", () => {
  // ⛔ POURQUOI LES SIX. Le libellé d'un bouton est borné à 28 caractères par le SCHÉMA : quatre
  // traductions de `reengage_cta` dépassent. Une fabrique qui ne serait exercée qu'en anglais
  // casserait la création elle-même sur une marque brésilienne — au clic, jamais avant.
  for (const locale of LOCALES) {
    for (const kind of LIFECYCLE_KINDS) {
      test(`${kind} / ${locale}`, async () => {
        const doc = lifecycleStarterDoc(kind, { assetSlug: "harbor-tech", locale });
        const publiable = EmailDocPublishable.safeParse(doc);
        expect(publiable.success).toBe(true);
        if (!publiable.success) return;

        const compiled = await compileDoc(publiable.data);
        expect(compiled.html).toContain("{{legal_footer_html}}");
        expect(
          checkLifecycleShell({
            kind,
            html: compiled.html,
            text: compiled.text,
            subject: publiable.data.meta.subject,
          }).ok,
        ).toBe(true);
        expect(doc.meta.locale).toBe(locale);
      });
    }
  }
});

describe("fidélité au contenu de l'e-mail intégré", () => {
  test("confirmation : titre, corps, note et lien reprennent les textes du worker", () => {
    const doc = lifecycleStarterDoc("confirmation", ENTREE);
    const s = strings("en");
    const plat = JSON.stringify(doc);
    expect(plat).toContain(s.confirm_cta);
    expect(plat).toContain(s.confirm_ignore);
    expect(plat).toContain("{{confirm_url}}");
    // Le sujet porte la marque par le JETON : coller le nom en dur figerait le modèle au premier
    // renommage de marque, sans erreur nulle part.
    expect(doc.meta.subject).toBe(s.confirm_subject("{{asset_name}}"));
  });

  test("réengagement : la mention de sunset est semée, elle rend la politique loyale", () => {
    const doc = lifecycleStarterDoc("reengagement", ENTREE);
    expect(JSON.stringify(doc)).toContain(strings("en").reengage_sunset);
    expect(JSON.stringify(doc)).toContain("{{preferences_url}}");
  });

  test("welcome et unsubscribe_ack n'ont aucun bouton, comme les intégrés", () => {
    for (const kind of ["welcome", "unsubscribe_ack"] as const) {
      const blocs = lifecycleStarterDoc(kind, ENTREE).rows[0]!.columns[0]!.blocks;
      expect(blocs.some((b) => b.type === "button")).toBe(false);
    }
  });

  test("le footer légal est le DERNIER bloc de chaque document", () => {
    for (const kind of LIFECYCLE_KINDS) {
      const blocs = lifecycleStarterDoc(kind, ENTREE).rows[0]!.columns[0]!.blocks;
      expect(blocs[blocs.length - 1]!.type).toBe("footer_legal");
      // Un seul : deux footers légaux enverraient deux fois la mention et le lien de désinscription.
      expect(blocs.filter((b) => b.type === "footer_legal")).toHaveLength(1);
    }
  });
});

describe("libelleBouton — la borne du schéma, pas un confort d'affichage", () => {
  test("les six traductions du CTA de réengagement tiennent dans la borne", () => {
    for (const locale of LOCALES) {
      const brut = strings(locale).reengage_cta;
      const coupe = libelleBouton(brut);
      expect(coupe.length).toBeLessThanOrEqual(MAX_BUTTON_LABEL);
      expect(coupe.length).toBeGreaterThan(0);
      // On coupe au MOT : le libellé retenu est un préfixe de mots entiers de l'original.
      expect(brut.startsWith(coupe)).toBe(true);
    }
  });

  test("un libellé qui tient déjà n'est pas touché", () => {
    expect(libelleBouton("Confirm subscription")).toBe("Confirm subscription");
  });

  test("aucune préposition orpheline en fin de libellé", () => {
    expect(libelleBouton("Oui, je veux continuer à recevoir")).toBe("Oui, je veux continuer");
  });

  test("un mot unique plus long que la borne est tranché plutôt que rendu vide", () => {
    const coupe = libelleBouton("A".repeat(60));
    expect(coupe).toHaveLength(MAX_BUTTON_LABEL);
  });
});

describe("lifecycleStarter — nom et catégorie acceptables par la route de création", () => {
  test("chaque kind reçoit une catégorie de TEMPLATE_CATEGORIES et un nom non vide", () => {
    const legales = ["newsletter", "daily_pick", "preview", "roundup", "win_back", "welcome", "transactional"];
    for (const kind of LIFECYCLE_KINDS) {
      const starter = lifecycleStarter(kind, ENTREE);
      expect(legales).toContain(starter.category);
      expect(starter.name.length).toBeGreaterThan(0);
      expect(starter.name.length).toBeLessThanOrEqual(120);
    }
  });

  test("les quatre noms sont distincts — deux fentes ne doivent pas se disputer le même slug", () => {
    const noms = LIFECYCLE_KINDS.map((k) => lifecycleStarter(k, ENTREE).name);
    expect(new Set(noms).size).toBe(noms.length);
  });
});

describe("lifecycleStarterLocale — ce que la marque ENVOIE, pas ce qu'elle déclare", () => {
  test("l'édition prime sur le registre", () => {
    expect(lifecycleStarterLocale(["pt-BR"], ["it", "en"])).toBe("pt-BR");
  });

  test("sans édition lisible, le registre sert de repli, puis l'anglais", () => {
    expect(lifecycleStarterLocale([], ["es"])).toBe("es");
    expect(lifecycleStarterLocale([], [])).toBe("en");
  });

  test("une langue hors dictionnaire retombe sur l'anglais, comme le worker", () => {
    // « sv » (Harbor Tech) n'existe pas dans `Locale` : `normalizeLocale` le renvoie sur `en` sans un
    // mot. Le document semé doit donc dire la même chose que l'intégré, pas mieux.
    expect(normalizeLocale("sv")).toBe("en");
    const doc = lifecycleStarterDoc("welcome", { assetSlug: "harbor-tech", locale: "sv" });
    expect(JSON.stringify(doc)).toContain(strings("en").welcome_body("{{asset_name}}"));
    /**
     * ⛔ LE DOCUMENT DÉCLARE LA LANGUE DE SON TEXTE. MUTATION QUI DOIT TUER CE TEST : remettre
     * `locale: input.locale` (non normalisée) dans `meta`.
     * Symptôme en production : `meta.locale` devient l'attribut `lang` du `<html>` de l'e-mail
     * compilé. Le jour où `sv` passe en tête des langues de Harbor Tech, l'e-mail partirait en
     * `lang="sv"` sur un texte ANGLAIS — là où l'intégré, lui, émet `en`.
     */
    expect(doc.meta.locale).toBe("en");
  });

  test("une variante de langue est ramenée à la locale du dictionnaire", () => {
    // `pt` et `pt-PT` sont servis par le dictionnaire `pt-BR` : le document doit le DIRE.
    expect(lifecycleStarterDoc("welcome", { assetSlug: "northwind-sports", locale: "pt" }).meta.locale).toBe(
      "pt-BR",
    );
  });
});

describe("lifecycleStarterDisplayName — deux modèles semés ne portent pas le même libellé", () => {
  /**
   * ⛔ LE TEST CENTRAL. MUTATION QUI DOIT LE TUER : rendre `lifecycleStarterName(kind)` sans regarder
   * le slug.
   * Symptôme en production : on détache la confirmation pour repartir de zéro, on reclique
   * « Customise », et le sélecteur liste deux fois « Confirmation email (draft only) ». On choisit à
   * l'aveugle, on rattache le mauvais, et la ligne annonce « Your template » pour un modèle qui ne
   * contient pas son travail.
   */
  test("le suffixe posé par le slug se retrouve dans le nom affiché", () => {
    expect(
      lifecycleStarterDisplayName("confirmation", "confirmation-email", "confirmation-email-2"),
    ).toBe("Confirmation email (2)");
  });

  test("le premier modèle garde son nom nu — rien à distinguer", () => {
    expect(
      lifecycleStarterDisplayName("confirmation", "confirmation-email", "confirmation-email"),
    ).toBe("Confirmation email");
  });

  test("un slug qui n'est pas dérivé du nom ne fabrique aucun suffixe", () => {
    expect(lifecycleStarterDisplayName("welcome", "welcome-email", "autre-chose")).toBe(
      "Welcome email",
    );
  });

  test("le nom reste dans la borne de la colonne (120)", () => {
    const long = lifecycleStarterDisplayName("welcome", "welcome-email", `welcome-email-${"9".repeat(200)}`);
    expect(long.length).toBeLessThanOrEqual(120);
  });
});
