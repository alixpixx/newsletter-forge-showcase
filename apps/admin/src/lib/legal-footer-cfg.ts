import {
  FOOTER_FIELDS,
  FOOTER_LINES,
  FOOTER_WORDING_FIELDS,
  type FooterConfig,
  type FooterLine,
  type FooterStyle,
  type FooterWording,
  type FooterWordingText,
} from "@nf/email";

/**
 * VALIDATION DE CE QU'UN ADMINISTRATEUR DE MARQUE ÉCRIT DANS LE PIED LÉGAL.
 *
 * ⛔ POURQUOI CE FICHIER EXISTE, SÉPARÉ DE SA ROUTE. Ces fonctions vivaient dans
 * `api/builder/legal-footer/[editionId]/route.ts`, où rien ne pouvait les exercer : un fichier de
 * route Next.js n'accepte qu'un jeu d'exports fermé (les verbes HTTP, `runtime`, `dynamic`…), donc
 * les exporter pour un banc ferait échouer la compilation. Elles gardent pourtant la seule chose que
 * `buildFooter` ne peut pas rattraper — ce qui entre dans `cfg` — et elles gardaient sans preuve.
 *
 * ⛔ CE QUE CES GARDES PROTÈGENT N'EST PAS LA BASE, C'EST L'E-MAIL. Tant que `legal_footer` ne
 * changeait que par MIGRATION, son contenu était du code relu. Depuis H5 il vient d'un formulaire, et
 * il est interpolé dans du HTML brut — dans un attribut `style` pour l'habillage, dans un `href` pour
 * les URL. Chaque valeur acceptée ici part telle quelle chez chaque destinataire de l'édition.
 */

/** Un champ trop long ne remplit pas une obligation, il alourdit le pied de chaque e-mail. */
export const MAX_TEXTE = 400;
export const MAX_REASON = 600;

/**
 * ⛔ CES BORNES SE COMPTENT EN OCTETS, PAS EN CARACTÈRES. Ce qu'elles protègent est le poids du pied,
 * mesuré en OCTETS contre `GMAIL_CLIP_BYTES` (`lib/weight.ts`) — et `String.length` compte des unités
 * UTF-16 : 400 caractères japonais ou emoji pèsent 1 200 octets et passaient la borne les doigts dans
 * le nez. La grandeur bornée doit être celle du seuil, sinon le garde ne garde rien.
 */
export const octets = (s: string) => new TextEncoder().encode(s).length;

/** Couleur CSS acceptée : hexadécimal uniquement — le pied est injecté en HTML brut. */
const COULEUR = /^#[0-9a-fA-F]{3,8}$/;

export function validerStyle(
  raw: unknown,
): { ok: true; style?: FooterStyle } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "style must be an object" };
  }
  const r = raw as Record<string, unknown>;
  const style: FooterStyle = {};

  for (const cle of ["color", "linkColor", "borderTopColor", "background"] as const) {
    const v = r[cle];
    if (v === undefined || v === "") continue;
    if (typeof v !== "string" || !COULEUR.test(v)) {
      return { ok: false, error: `${cle} must be a hex colour like #1b1b1b` };
    }
    style[cle] = v;
  }

  if (r.fontFamily !== undefined && r.fontFamily !== "") {
    if (typeof r.fontFamily !== "string" || r.fontFamily.length > 120) {
      return { ok: false, error: "fontFamily must be a font stack of 120 characters or less" };
    }
    /*
     * Le pied est injecté en HTML brut, et cette valeur atterrit DANS un attribut `style`.
     * ⛔ LE POINT-VIRGULE MANQUAIT, ET C'EST LUI QUI COMPTE. Les guillemets fermeraient l'attribut,
     * mais un `;` n'en a pas besoin : il ouvre une DÉCLARATION CSS DE PLUS sur le conteneur du pied.
     * « Arial;display:none » masquait le pied entier — donc le lien de désinscription — dans tous les
     * e-mails de l'édition, sans qu'aucune ligne de code n'échoue et sans que `missing` s'en émeuve.
     * Les parenthèses et accolades partent avec, pour la même raison (`url(…)`, blocs).
     */
    /*
     * ⛔ L'ESPERLUETTE EST DANS LA LISTE, ET C'EST ELLE QUI MANQUAIT. Un filtre par CARACTÈRES ne
     * peut pas tenir une valeur qui traversera un DÉCODEUR D'ENTITÉS : `Arial&#59display:none` ne
     * contient aucun `;` littéral, et tout analyseur HTML le décode en `Arial;display:none`. Le
     * vrai correctif est l'échappement au rendu (`escAttr`, packages/email/src/footer.ts) ; ce
     * refus-ci est la seconde barrière, pour ne pas garder en base une valeur qui n'est inoffensive
     * que grâce à celui qui l'affiche.
     */
    if (/["'<>;(){}\\&]/.test(r.fontFamily)) {
      return {
        ok: false,
        error: "fontFamily cannot contain quotes, angle brackets, semicolons, brackets or ampersands",
      };
    }
    style.fontFamily = r.fontFamily;
  }

  if (r.fontSizePx !== undefined && r.fontSizePx !== "") {
    const n = Number(r.fontSizePx);
    // Bornes lisibles : en dessous de 9px le pied n'est plus lisible, au-dessus de 18px il n'est
    // plus un pied. Les deux extrêmes sont des erreurs de saisie, pas des intentions.
    if (!Number.isFinite(n) || n < 9 || n > 18) {
      return { ok: false, error: "fontSizePx must be between 9 and 18" };
    }
    style.fontSizePx = Math.round(n);
  }

  if (r.align !== undefined && r.align !== "") {
    if (r.align !== "left" && r.align !== "center" && r.align !== "right") {
      return { ok: false, error: "align must be left, center or right" };
    }
    style.align = r.align;
  }

  return { ok: true, style: Object.keys(style).length > 0 ? style : undefined };
}

/** Un libellé de lien ou un préfixe : quelques mots, pas un paragraphe. */
export const MAX_LIBELLE = 120;
/** Un séparateur : « · », « | », « — » et leurs espaces. */
export const MAX_SEPARATEUR = 10;

const LIBELLES: readonly FooterWordingText[] = ["unsubscribe", "preferences", "privacy", "dpo", "impressum", "nif", "jpSender", "phone"];
const SEPARATEURS: readonly FooterWordingText[] = ["separator", "identitySeparator"];
/** Les phrases qui portent un DÉLAI légal : le chiffre doit rester celui réglé, jamais un chiffre recopié. */
const AVEC_JOURS: readonly FooterWordingText[] = ["unsubValidity", "optOut"];

/**
 * LA FORMULATION DU PIED LÉGAL (décision d'Alix du 22/09/2026 : la formulation est libre, la PRÉSENCE
 * des mentions obligatoires ne l'est pas).
 *
 * ⛔ CE QUE CE GARDE TIENT, ET POURQUOI `buildFooter` NE SUFFIT PAS. `buildFooter` rend le défaut pour
 * un texte BLANC — mais « ​ », « . » ou « - » ne sont pas blancs, et donneraient un lien de
 * désinscription réduit à un point, une phrase de retrait du consentement qui ne dit plus rien. On
 * exige donc au moins une lettre ou un chiffre dans chaque texte. Ce n'est pas une garantie de sens,
 * c'est la garantie qu'on ne peut pas EFFACER une mention en ayant l'air de la reformuler.
 *
 * ⛔ `{days}` EST OBLIGATOIRE DANS LES DEUX PHRASES À DÉLAI. Le délai légal vient d'un champ réglé
 * (« Opt-out window », « Unsubscribe validity ») ; une phrase qui l'écrirait en toutes lettres
 * continuerait d'annoncer 10 jours le jour où le réglage passe à 5 — un engagement légal faux, publié
 * dans chaque e-mail, sans qu'aucune ligne n'échoue.
 *
 * ⛔ `{{` EST REFUSÉ. Le pied est injecté dans un shell que l'hydratation parcourt : un jeton glissé
 * dans un libellé serait remplacé — ou effacé en silence s'il est inconnu.
 *
 * ⛔ L'ORDRE NE PEUT QUE PERMUTER. Une ligne inconnue ou en double est une erreur de l'écran, pas une
 * intention : on la refuse. Une ligne omise est rajoutée en fin de pied par `footerLineOrder` au rendu
 * — on la rajoute ici aussi, pour que la base dise ce qui part.
 */
export function validerWording(
  raw: unknown,
): { ok: true; wording?: FooterWording } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "wording must be an object" };
  const r = raw as Record<string, unknown>;
  const wording: FooterWording = {};

  for (const champ of FOOTER_WORDING_FIELDS) {
    const v = r[champ.key];
    if (v === undefined || v === null || v === "") continue;
    if (typeof v !== "string") return { ok: false, error: `${champ.label} must be text` };
    if (/[\u0000-\u001f\u007f]/.test(v)) return { ok: false, error: `${champ.label} cannot contain line breaks or control characters` };
    if (v.includes("{{") || v.includes("}}")) return { ok: false, error: `${champ.label} cannot contain {{ or }}` };

    if (SEPARATEURS.includes(champ.key)) {
      // Les espaces d'un séparateur SONT le séparateur : on ne les retire pas.
      if (octets(v) > MAX_SEPARATEUR) return { ok: false, error: `${champ.label} must be ${MAX_SEPARATEUR} bytes or less` };
      wording[champ.key] = v;
      continue;
    }

    const texte = v.trim();
    // Blanc = texte par défaut, dans la langue de l'édition : rien à stocker.
    if (!texte) continue;
    const max = LIBELLES.includes(champ.key) ? MAX_LIBELLE : MAX_TEXTE;
    if (octets(texte) > max) return { ok: false, error: `${champ.label} must be ${max} bytes or less` };
    if (!/[\p{L}\p{N}]/u.test(texte)) {
      return { ok: false, error: `${champ.label} must contain words: a mandatory mention can be reworded, not emptied` };
    }
    if (AVEC_JOURS.includes(champ.key) && !texte.includes("{days}")) {
      return { ok: false, error: `${champ.label} must keep {days}, which is replaced by the delay you set` };
    }
    wording[champ.key] = texte;
  }

  if (r.order !== undefined && r.order !== null) {
    if (!Array.isArray(r.order)) return { ok: false, error: "order must be a list of footer lines" };
    const ordre: FooterLine[] = [];
    for (const l of r.order) {
      if (!(FOOTER_LINES as readonly unknown[]).includes(l)) return { ok: false, error: `unknown footer line: ${String(l)}` };
      if (ordre.includes(l as FooterLine)) return { ok: false, error: `footer line listed twice: ${String(l)}` };
      ordre.push(l as FooterLine);
    }
    for (const l of FOOTER_LINES) if (!ordre.includes(l)) ordre.push(l);
    // L'ordre d'origine n'est pas stocké : il est ce qui part quand rien n'est réglé.
    if (ordre.some((l, i) => l !== FOOTER_LINES[i])) wording.order = ordre;
  }

  return { ok: true, wording: Object.keys(wording).length > 0 ? wording : undefined };
}

/**
 * ⛔ LISTE FERMÉE, PAS UN JSONB LIBRE. La colonne est un jsonb : sans filtre, n'importe quelle clé
 * s'y écrirait — invisible, jamais lue par `buildFooter`, et grossissant le pied que `weighShell`
 * mesure pour refuser une publication. On ne garde donc QUE les clés déclarées dans `FOOTER_FIELDS`,
 * qui est la même source que celle dont l'écran tire ses champs.
 */
export function validerConfig(
  raw: unknown,
): { ok: true; cfg: FooterConfig } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "cfg must be an object" };
  }
  const r = raw as Record<string, unknown>;
  const cfg: FooterConfig = {};

  for (const champ of FOOTER_FIELDS) {
    const v = r[champ.key];
    // ⛔ Un champ vidé est un champ RETIRÉ, pas une chaîne vide stockée : `buildFooter` teste la
    // présence (`cfg.privacy_url ? …`), et une chaîne vide s'y comporterait comme une absence tout
    // en laissant croire, en base, que la mention est renseignée.
    if (v === undefined || v === null || v === "") continue;

    if (champ.kind === "boolean") {
      (cfg as Record<string, unknown>)[champ.key] = Boolean(v);
      continue;
    }
    if (champ.kind === "number") {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 3650) {
        return { ok: false, error: `${champ.key} must be a number of days between 0 and 3650` };
      }
      (cfg as Record<string, unknown>)[champ.key] = Math.round(n);
      continue;
    }
    if (typeof v !== "string") return { ok: false, error: `${champ.key} must be text` };
    const texte = v.trim();
    /*
     * ⛔ UNE SAISIE BLANCHE EST UN CHAMP VIDÉ, PAS UNE MENTION RENSEIGNÉE. Le test de présence plus
     * haut voit `"   "` comme une valeur ; `trim()` la réduit ensuite à `""`, et sans ce second
     * passage c'est une CHAÎNE VIDE qui partait en base — exactement ce que le commentaire ci-dessus
     * déclare impossible. Ce n'est pas cosmétique : `buildFooter` écrit `cfg.controller ?? assetName`,
     * et `??` ne rattrape PAS une chaîne vide. L'identité de l'expéditeur DISPARAISSAIT du pied au
     * lieu de retomber sur le nom de la marque, en laissant croire en base qu'elle était remplie.
     */
    if (!texte) continue;
    const max = champ.key === "reason" ? MAX_REASON : MAX_TEXTE;
    if (octets(texte) > max) return { ok: false, error: `${champ.key} must be ${max} bytes or less` };
    if (champ.kind === "url") {
      if (!/^https?:\/\//i.test(texte)) {
        return { ok: false, error: `${champ.key} must start with http:// or https://` };
      }
      // ⛔ Le préfixe ne suffit pas : cette URL est interpolée dans un attribut `href`. `buildFooter`
      // l'échappe désormais, mais une valeur qui n'est sûre que grâce à son rendu est une valeur qui
      // redeviendra dangereuse au prochain consommateur — on la refuse À L'ÉCRITURE aussi.
      if (/["'<>\s]/.test(texte)) {
        return { ok: false, error: `${champ.key} cannot contain spaces, quotes or angle brackets` };
      }
    }
    (cfg as Record<string, unknown>)[champ.key] = texte;
  }

  const style = validerStyle(r.style);
  if (!style.ok) return { ok: false, error: style.error };
  if (style.style) cfg.style = style.style;

  const wording = validerWording(r.wording);
  if (!wording.ok) return { ok: false, error: wording.error };
  if (wording.wording) cfg.wording = wording.wording;

  return { ok: true, cfg };
}
