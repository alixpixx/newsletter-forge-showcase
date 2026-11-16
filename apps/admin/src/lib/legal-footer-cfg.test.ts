/**
 * Banc de la validation du pied légal.
 *
 * ⛔ POURQUOI IL ARRIVE APRÈS LE CODE, ET CE QUE ÇA A COÛTÉ. Les quatre gardes exercés ici ont été
 * écrits, relus, typés et DÉPLOYÉS sans qu'aucun d'eux ne soit exercé une seule fois : ils vivaient
 * dans un `route.ts`, où Next.js interdit tout export hors des verbes HTTP, donc rien ne pouvait les
 * appeler. Trois des quatre étaient faux. Un garde que rien n'exerce n'est pas un garde tant qu'il
 * n'a pas de banc — il est une intention.
 *
 * ⛔ CE QUI EST EN JEU ICI N'EST PAS LA FORME D'UNE COLONNE. Ce que `validerConfig` accepte est
 * interpolé en HTML BRUT dans le pied de chaque e-mail de l'édition : dans un attribut `style` pour
 * l'habillage, dans un `href` pour les URL. Ces tests décrivent donc des e-mails, pas des lignes.
 */
import { describe, expect, test } from "bun:test";
import { buildFooter } from "@nf/email";
import { validerConfig, validerStyle } from "./legal-footer-cfg";

const cfgDe = (r: Record<string, unknown>) => {
  const v = validerConfig(r);
  if (!v.ok) throw new Error(`attendu : accepté. Refusé pour : ${v.error}`);
  return v.cfg as Record<string, unknown>;
};

describe("une saisie blanche est un champ VIDÉ, jamais une mention renseignée", () => {
  test("⛔ des espaces ne deviennent PAS une chaîne vide en base", () => {
    // Le test de présence voit `"   "` comme une valeur ; `trim()` la réduit ensuite à `""`. Sans le
    // second passage, c'est cette chaîne vide qui partait dans le jsonb.
    expect(cfgDe({ controller: "   " })).not.toHaveProperty("controller");
    expect(cfgDe({ physical_address: "\t\n " })).not.toHaveProperty("physical_address");
  });

  test("⛔ le DÉGÂT que ce garde évite, mesuré DE BOUT EN BOUT jusqu'au pied rendu", () => {
    /*
     * ⛔ CE TEST DOIT PASSER PAR LE PRODUIT, PAS PAR LA SÉMANTIQUE DU LANGAGE. Sa première version
     * assertait `expect("" ?? "Quartz Tips").toBe("")` : du JavaScript pur, vert même si `validerConfig`
     * disparaissait du dépôt. Elle ne pouvait pas tomber, donc elle ne gardait rien — exactement le
     * défaut que ce lot vient de corriger ailleurs. On enchaîne donc les DEUX vrais maillons, la
     * validation puis le rendu, pour que retirer le garde fasse rougir cette ligne.
     */
    const v = validerConfig({ controller: "   ", physical_address: "1 rue X" });
    if (!v.ok) throw new Error(`attendu : accepté. Refusé pour : ${v.error}`);
    const pied = buildFooter({
      assetName: "Quartz Tips",
      regime: "gdpr",
      cfg: v.cfg,
      unsubUrl: "https://x.invalid/u",
    });
    // Le garde a RETIRÉ le champ blanc, donc `cfg.controller ?? assetName` retombe sur la marque.
    // Sans lui, `cfg.controller` vaudrait `""`, `??` ne le rattraperait pas, et la ligne d'identité
    // s'afficherait « — 1 rue X » : l'expéditeur aurait disparu de ses propres mentions légales.
    expect(pied.text).toContain("Quartz Tips — 1 rue X");
  });

  test("une valeur réelle est conservée, rognée de ses espaces de bord", () => {
    expect(cfgDe({ controller: "  Example Media  " }).controller).toBe("Example Media");
  });
});

describe("l'habillage ne peut pas ouvrir une déclaration CSS de plus", () => {
  test("⛔ un POINT-VIRGULE dans `fontFamily` est refusé — c'est lui qui masquait le pied", () => {
    // « Arial;display:none » n'a besoin d'aucun guillemet pour agir : il ouvre une déclaration de
    // plus sur le conteneur, donc masque le pied ENTIER — le lien de désinscription compris — dans
    // tous les e-mails de l'édition, sans qu'aucune ligne n'échoue et sans toucher à `missing`.
    const v = validerStyle({ fontFamily: "Arial;display:none" });
    expect(v.ok).toBe(false);
  });

  test("⛔ une ESPERLUETTE est refusée : un filtre de CARACTÈRES ne tient pas un DÉCODEUR d'entités", () => {
    /*
     * ⛔ LE CONTOURNEMENT QUI A SURVÉCU À LA PREMIÈRE CORRECTION. `Arial&#59display:none` ne contient
     * AUCUN point-virgule littéral : il traversait le refus du `;`. Mais un analyseur HTML décode la
     * référence NUMÉRIQUE même sans point-virgule final, et le CSS appliqué devenait
     * `font-family:Arial;display:none;…` — le pied entier masqué, lien de désinscription compris.
     * La vraie barrière est l'échappement au rendu (`escAttr`, packages/email/src/footer.ts) ; ce
     * refus-ci évite seulement de garder en base une valeur qui n'est sûre que grâce à son afficheur.
     */
    expect(validerStyle({ fontFamily: "Arial&#59display:none" }).ok).toBe(false);
    expect(validerConfig({ style: { fontFamily: "Arial&#59display:none" } }).ok).toBe(false);
  });

  test("⛔ parenthèses et accolades aussi (`url(…)`, blocs)", () => {
    expect(validerStyle({ fontFamily: "Arial,url(javascript:0)" }).ok).toBe(false);
    expect(validerStyle({ fontFamily: "Arial}{color:red" }).ok).toBe(false);
  });

  test("une vraie pile de polices passe", () => {
    const v = validerStyle({ fontFamily: "Helvetica Neue, Arial, sans-serif" });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.style?.fontFamily).toBe("Helvetica Neue, Arial, sans-serif");
  });

  test("une couleur non hexadécimale est refusée", () => {
    expect(validerStyle({ color: "red" }).ok).toBe(false);
    expect(validerStyle({ color: "#1b1b1b" }).ok).toBe(true);
  });
});

describe("une URL de pied ne peut pas sortir de son attribut `href`", () => {
  test("⛔ guillemets, chevrons et espaces sont refusés À L'ÉCRITURE", () => {
    // `buildFooter` échappe désormais, mais une valeur qui n'est sûre que grâce à son rendu
    // redeviendra dangereuse au prochain consommateur (le texte, un export, un aperçu).
    for (const mauvaise of [
      `https://x.invalid/p" onmouseover="alert(1)`,
      "https://x.invalid/p<script>",
      "https://x.invalid/a b",
    ]) {
      const v = validerConfig({ privacy_url: mauvaise });
      expect(v.ok).toBe(false);
    }
  });

  test("le schéma reste exigé, et une URL normale passe", () => {
    expect(validerConfig({ privacy_url: "javascript:alert(1)" }).ok).toBe(false);
    expect(cfgDe({ privacy_url: "https://x.invalid/privacy?a=1&b=2" }).privacy_url).toBe(
      "https://x.invalid/privacy?a=1&b=2",
    );
  });
});

describe("les bornes de longueur comptent des OCTETS", () => {
  test("⛔ la grandeur bornée doit être celle du seuil qu'elle protège", () => {
    // Le seuil protégé (`GMAIL_CLIP_BYTES`) est en octets ; `String.length` compte des unités UTF-16.
    // 200 caractères japonais font 200 en `.length` et 600 en octets : la borne de 400 les laissait
    // passer, alors qu'ils pèsent une fois et demie ce qu'elle prétend autoriser.
    const jp = "あ".repeat(200);
    expect(jp.length).toBe(200);
    expect(new TextEncoder().encode(jp).length).toBe(600);
    expect(validerConfig({ controller: jp }).ok).toBe(false);
  });

  test("un texte latin de 400 caractères passe encore", () => {
    expect(validerConfig({ controller: "a".repeat(400) }).ok).toBe(true);
    expect(validerConfig({ controller: "a".repeat(401) }).ok).toBe(false);
  });
});

describe("la liste des clés est FERMÉE", () => {
  test("⛔ une clé inconnue n'entre pas dans le jsonb", () => {
    // La colonne est un jsonb : sans filtre, la clé s'écrirait — invisible, jamais lue par
    // `buildFooter`, mais grossissant le pied que `weighShell` mesure pour refuser une publication.
    expect(cfgDe({ controller: "X", n_importe_quoi: "oui" })).not.toHaveProperty("n_importe_quoi");
  });

  test("⛔ les liens de désinscription ne sont PAS une clé acceptable", () => {
    // Ils sont signés par destinataire et calculés à l'envoi : une seconde source produirait une
    // copie NON signée, c'est-à-dire un lien qui ne désinscrit personne.
    expect(cfgDe({ unsubUrl: "https://x.invalid/u" })).not.toHaveProperty("unsubUrl");
  });
});

/**
 * La FORMULATION du pied (décision d'Alix du 22/09/2026) : libre dans les mots, jamais dans la
 * présence des mentions. Ces tests passent par `validerConfig` PUIS `buildFooter`, pour décrire
 * l'e-mail qui part et pas seulement l'objet stocké.
 */
describe("la formulation du pied : reformuler oui, effacer non", () => {
  const pied = (cfg: Record<string, unknown>, regime: "gdpr" | "lgpd" | "canspam" = "gdpr") =>
    buildFooter({ assetName: "Quartz Tips", regime, cfg, unsubUrl: "https://nf.invalid/u?t=1", prefsUrl: "https://nf.invalid/p?t=1", locale: "fr" });

  test("un libellé remplacé est STOCKÉ puis RENDU dans le HTML et le texte", () => {
    const cfg = cfgDe({ privacy_url: "https://x.invalid/p", wording: { unsubscribe: "  Ne plus recevoir  ", separator: " | " } });
    expect(cfg.wording).toEqual({ unsubscribe: "Ne plus recevoir", separator: " | " });
    const f = pied(cfg);
    expect(f.html).toContain(">Ne plus recevoir</a>");
    expect(f.html).toContain("</a> | <a");
    expect(f.text).toContain("Ne plus recevoir: https://nf.invalid/u?t=1");
    expect(f.missing).toEqual([]);
  });

  test("⛔ un libellé qui n'a aucun mot est refusé (lien réduit à un point, phrase vidée)", () => {
    for (const vide of [".", "-", "​", "· ·", "!!"]) {
      for (const cle of ["unsubscribe", "privacy", "withdraw", "optOut"]) {
        const v = validerConfig({ wording: { [cle]: vide } });
        expect(v.ok).toBe(false);
      }
    }
  });

  test("un libellé blanc n'est PAS stocké : le texte par défaut, traduit, repart", () => {
    const cfg = cfgDe({ privacy_url: "https://x.invalid/p", wording: { unsubscribe: "   " } });
    expect(cfg).not.toHaveProperty("wording");
    expect(pied(cfg).html).toContain(">Se désinscrire</a>");
  });

  test("⛔ les phrases à délai gardent {days} : le chiffre reste celui réglé", () => {
    expect(validerConfig({ wording: { optOut: "Opt-outs honored within 10 days." } }).ok).toBe(false);
    expect(validerConfig({ wording: { unsubValidity: "Valid for 60 days." } }).ok).toBe(false);
    const cfg = cfgDe({ physical_address: "1 Main St", privacy_url: "https://x.invalid/p", opt_out_days: 5, wording: { optOut: "Sous {days} jours, promis." } });
    expect(pied(cfg, "canspam").html).toContain("Sous 5 jours, promis.");
  });

  test("⛔ un jeton, un retour à la ligne ou un libellé trop long sont refusés", () => {
    expect(validerConfig({ wording: { unsubscribe: "Bye {{first_name}}" } }).ok).toBe(false);
    expect(validerConfig({ wording: { privacy: "Privacy\r\nBcc" } }).ok).toBe(false);
    expect(validerConfig({ wording: { unsubscribe: "a".repeat(121) } }).ok).toBe(false);
    expect(validerConfig({ wording: { separator: " ·········· " } }).ok).toBe(false);
    expect(validerConfig({ wording: { unsubscribe: 42 } }).ok).toBe(false);
  });

  test("⛔ le HTML d'un libellé est échappé au rendu", () => {
    const f = pied(cfgDe({ privacy_url: "https://x.invalid/p", wording: { privacy: "<b>Vie privée</b>" } }));
    expect(f.html).not.toContain("<b>Vie privée</b>");
    expect(f.html).toContain("&lt;b&gt;Vie privée&lt;/b&gt;");
  });

  test("l'ordre ne fait que PERMUTER : inconnue et doublon refusés, omises rajoutées, défaut non stocké", () => {
    expect(validerConfig({ wording: { order: ["links", "nimporte"] } }).ok).toBe(false);
    expect(validerConfig({ wording: { order: ["links", "links"] } }).ok).toBe(false);
    expect(validerConfig({ wording: { order: "links" } }).ok).toBe(false);
    const cfg = cfgDe({ wording: { order: ["links", "reason"] } });
    expect((cfg.wording as { order: string[] }).order).toEqual(["links", "reason", "identity", "gambling", "dpo", "market", "withdraw"]);
    expect(cfgDe({ wording: { order: ["reason", "identity"] } })).not.toHaveProperty("wording");
  });

  test("⛔ aucune formulation ne retire le lien de désinscription ni la confidentialité", () => {
    // L'ordre omet `links` : la ligne est rajoutée ; les libellés sont remplacés, pas supprimés.
    const cfg = cfgDe({ privacy_url: "https://x.invalid/p", wording: { order: ["withdraw"], unsubscribe: "Partir", privacy: "Données" } });
    const f = pied(cfg);
    expect(f.html).toContain('href="https://nf.invalid/u?t=1"');
    expect(f.html).toContain('href="https://x.invalid/p"');
    expect(f.missing).toEqual([]);
    // Sans URL de confidentialité, la formulation n'y change rien : le veto tient.
    expect(pied(cfgDe({ wording: { privacy: "Données" } })).missing).toContain("privacy_url");
  });
});
