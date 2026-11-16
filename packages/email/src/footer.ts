/**
 * Footer légal auto-injecté dans chaque email (chantier C1 du plan compliance).
 * Les éléments obligatoires par régime sont rendus ici. Leur PRÉSENCE n'est pas éditable ; leur
 * FORMULATION, leur ordre et leur style le sont, par marque (`FooterWording`, `FooterStyle`) :
 * - CAN-SPAM (US) : adresse postale physique obligatoire
 * - GDPR (EU/UK)  : identité du responsable + lien privacy + retrait à tout moment
 * - LGPD (BR)     : DPO/encarregado + lien privacy
 * - betting       : jeu responsable + 18+
 * Toujours : identité expéditeur + désinscription 1 clic.
 * Localisé dans la langue de l'édition (kit de conformité Example Media : langue locale requise).
 */
import { strings, type Locale } from "./i18n";

export type Regime = "gdpr" | "lgpd" | "canspam";

export interface FooterConfig {
  physical_address?: string; // requis US/CA (adresse postale)
  privacy_url?: string;
  controller?: string;
  dpo_contact?: string;
  responsible_gambling?: boolean; // marques betting
  // Champs spécifiques par marché (kit conformité) :
  legal_form?: string;          // DE Impressum / ES (forme juridique)
  street_address?: string;      // DE Impressum (rue + numéro, PAS de boîte postale)
  commercial_register?: string; // DE Impressum (Handelsregister)
  vat_id?: string;              // DE Impressum (USt-IdNr.)
  nif_cif?: string;             // ES LSSI
  phone?: string;               // CA CASL
  unsub_min_days?: number;      // CA CASL (défaut 60)
  opt_out_days?: number;        // US CAN-SPAM (défaut 10)
  sender_name?: string;         // JP (nom expéditeur)
  sender_address?: string;      // JP (adresse expéditeur)

  /**
   * « Vous recevez cet e-mail car… », par marque.
   *
   * ⛔ POURQUOI ICI ET PAS SEULEMENT DANS `FooterInput.reason`. Le point d'entrée existait déjà côté
   * INPUT, mais personne ne le construisait — et surtout, `weighShell` (admin) pèse le pied légal à
   * partir de `asset_edition` SEUL, sans passer par le worker. Une phrase qui n'existerait que dans
   * l'input serait absente de la mesure de poids, donc sous-estimée : le garde qui refuse de publier
   * un e-mail trop lourd mesurerait un pied plus court que celui qui part.
   */
  reason?: string;

  /** Habillage du pied légal, par marque. Voir `FooterStyle`. */
  style?: FooterStyle;

  /** Libellés, phrases, séparateurs et ordre des lignes, par marque. Voir `FooterWording`. */
  wording?: FooterWording;
}

/**
 * LES LIGNES DU PIED, DANS L'ORDRE D'ORIGINE.
 *
 * ⛔ CET ORDRE EST CELUI QUI PART AUJOURD'HUI, À L'OCTET PRÈS. Un ordre personnalisé ne peut que
 * PERMUTER ces lignes : il ne peut pas en retirer une. `footerLineOrder` rajoute en fin de pied toute
 * ligne que l'ordre enregistré aurait omise — c'est ce qui empêche un réglage de mise en page de
 * faire disparaître le lien de désinscription.
 */
export const FOOTER_LINES = ["reason", "identity", "gambling", "dpo", "market", "links", "withdraw"] as const;
export type FooterLine = (typeof FOOTER_LINES)[number];

/**
 * LA FORMULATION DU PIED LÉGAL, PAR MARQUE (décision d'Alix, 22/09/2026).
 *
 * « je veux tout pouvoir modifier dans le builder ce que les users vont recevoir sans exception » —
 * avec une frontière posée par Alix : la FORMULATION et le style deviennent libres, la PRÉSENCE des
 * mentions obligatoires reste verrouillée. D'où la forme de ce type :
 *  - chaque champ ne REMPLACE qu'un texte ; il ne commande jamais l'affichage d'une ligne ;
 *  - un champ vide ou blanc rend le texte par défaut, traduit dans la langue de l'édition — jamais
 *    un lien sans texte (un lien de désinscription au libellé vide est un lien invisible) ;
 *  - `order` ne fait que permuter (voir `FOOTER_LINES`).
 *
 * `{days}` est remplacé au rendu dans `unsubValidity` et `optOut`.
 */
export interface FooterWording {
  unsubscribe?: string;
  preferences?: string;
  privacy?: string;
  withdraw?: string;
  gambling?: string;
  dpo?: string;
  impressum?: string;
  nif?: string;
  jpSender?: string;
  phone?: string;
  unsubValidity?: string;
  optOut?: string;
  /** Entre les liens Désinscription · Préférences · Confidentialité. */
  separator?: string;
  /** Entre l'identité de l'expéditeur et son adresse postale. */
  identitySeparator?: string;
  order?: FooterLine[];
}

export type FooterWordingText = Exclude<keyof FooterWording, "order">;

/** Les séparateurs gardent leurs espaces : « | » et « · » ne se lisent pas pareil collés au texte. */
const SEPARATEURS: readonly FooterWordingText[] = ["separator", "identitySeparator"];

/**
 * Les textes par défaut d'une langue — ceux qui partent quand la marque n'a rien écrit.
 * Exportés pour l'écran : ils y servent de texte d'exemple, dans la langue de l'édition.
 */
export function defaultWording(locale: Locale): Record<FooterWordingText, string> {
  const s = strings(locale);
  return {
    unsubscribe: s.footer_unsub,
    preferences: s.footer_prefs,
    privacy: s.footer_privacy,
    withdraw: s.footer_withdraw,
    gambling: s.responsible_gambling,
    dpo: s.footer_dpo,
    // Termes juridiques du pays, pas de la langue de l'e-mail : « Impressum » est le mot de la loi
    // allemande, « NIF/CIF » celui de la loi espagnole. Ils restent tels quels partout.
    impressum: "Impressum:",
    nif: "NIF/CIF:",
    jpSender: "送信者:",
    phone: s.footer_phone,
    unsubValidity: s.footer_unsub_validity,
    optOut: s.footer_optout,
    separator: " · ",
    identitySeparator: " — ",
  };
}

/**
 * L'ordre effectif des lignes : celui de la marque, filtré (inconnues et doublons écartés), puis
 * complété par chaque ligne qu'il omet. ⛔ C'est ce complément qui rend l'ordre incapable de retirer
 * une mention : `cfg` vient d'un jsonb, et une valeur écrite à la main en base ne passe par aucun
 * écran de validation.
 */
export function footerLineOrder(raw: unknown): FooterLine[] {
  const ordre: FooterLine[] = [];
  if (Array.isArray(raw)) {
    for (const l of raw) {
      if ((FOOTER_LINES as readonly unknown[]).includes(l) && !ordre.includes(l as FooterLine)) ordre.push(l as FooterLine);
    }
  }
  for (const l of FOOTER_LINES) if (!ordre.includes(l)) ordre.push(l);
  return ordre;
}

/** Ce que l'écran propose de reformuler, et quand chaque texte s'affiche. Source unique avec `buildFooter`. */
export interface FooterWordingField {
  key: FooterWordingText;
  label: string;
  help: string;
  /** Régimes ou marchés où ce texte apparaît. Vide = toujours. */
  appliesTo: string[];
  group: "links" | "sentences" | "market" | "layout";
}

export const FOOTER_WORDING_FIELDS: readonly FooterWordingField[] = [
  { key: "unsubscribe", label: "Unsubscribe link text", help: "Only the text changes: the link is always there, signed for each reader.", appliesTo: [], group: "links" },
  { key: "preferences", label: "Preferences link text", help: "The link to the reader's subscription preferences.", appliesTo: [], group: "links" },
  { key: "privacy", label: "Privacy link text", help: "Links to the privacy policy URL above.", appliesTo: [], group: "links" },
  { key: "withdraw", label: "Withdraw-consent sentence", help: "GDPR: tells readers they can withdraw their consent at any time. Can be reworded, not removed.", appliesTo: ["gdpr"], group: "sentences" },
  { key: "gambling", label: "Responsible gambling line", help: "Shown when the responsible gambling notice is on.", appliesTo: [], group: "sentences" },
  { key: "dpo", label: "DPO prefix", help: "Printed before the DPO contact.", appliesTo: ["lgpd"], group: "sentences" },
  { key: "optOut", label: "Opt-out delay sentence", help: "CAN-SPAM. {days} is replaced by the opt-out window. Can be reworded, not removed.", appliesTo: ["canspam"], group: "market" },
  { key: "phone", label: "Phone prefix", help: "CASL (Canada): printed before the phone number.", appliesTo: ["CA"], group: "market" },
  { key: "unsubValidity", label: "Unsubscribe validity sentence", help: "CASL (Canada). {days} is replaced by the unsubscribe validity. Can be reworded, not removed.", appliesTo: ["CA"], group: "market" },
  { key: "impressum", label: "Impressum prefix", help: "German Impressum: printed before the company details.", appliesTo: ["DE"], group: "market" },
  { key: "nif", label: "NIF/CIF prefix", help: "Spanish LSSI: printed before the NIF/CIF.", appliesTo: ["ES"], group: "market" },
  { key: "jpSender", label: "Sender prefix", help: "Japanese anti-spam law: printed before the sender's name and address.", appliesTo: ["JP"], group: "market" },
  { key: "separator", label: "Link separator", help: "Between the Unsubscribe, Preferences and Privacy links.", appliesTo: [], group: "layout" },
  { key: "identitySeparator", label: "Address separator", help: "Between the sender identity and the postal address.", appliesTo: [], group: "layout" },
];

/** Le nom d'écran de chaque ligne, pour l'éditeur d'ordre. */
export const FOOTER_LINE_LABELS: Record<FooterLine, string> = {
  reason: "“Why am I getting this?”",
  identity: "Sender identity and address",
  gambling: "Responsible gambling",
  dpo: "DPO contact",
  market: "Market-specific mentions",
  links: "Unsubscribe · Preferences · Privacy links",
  withdraw: "Withdraw consent",
};

/**
 * L'HABILLAGE DU PIED LÉGAL, PAR MARQUE.
 *
 * ⛔ POURQUOI IL N'EST PAS DANS `doc.theme`. Le pied légal est injecté APRÈS compilation, en
 * `mj-raw` : aucun jeton de thème ne l'atteint — c'est pour cela que toutes les marques ont
 * aujourd'hui le même pied, au pixel près. Le brancher sur le thème du document créerait en plus
 * autant de vérités que de modèles pour un objet qui doit être unique par marque, et ferait mesurer
 * à `weighShell` (qui ne lit que `asset_edition`) un pied qui n'est pas celui qui part.
 *
 * ⛔ CHAQUE CHAMP ABSENT REND LA VALEUR ACTUELLE, À L'OCTET PRÈS. Un pied légal est déjà parti des
 * millions de fois dans cette forme ; un défaut qui « ressemble » suffirait à changer le rendu de
 * toutes les marques d'un coup, sans que personne ne l'ait demandé.
 */
export interface FooterStyle {
  fontFamily?: string;
  fontSizePx?: number;
  color?: string;
  linkColor?: string;
  borderTopColor?: string;
  /** Absent = pas de fond du tout, comme aujourd'hui. */
  background?: string;
  align?: "left" | "center" | "right";
}

const STYLE_DEFAUT = {
  fontFamily: "Arial,sans-serif",
  fontSizePx: 11,
  color: "#999",
  linkColor: "#888",
  borderTopColor: "#eee",
  align: "center",
} as const;

/**
 * LES CHAMPS ÉDITABLES DU PIED LÉGAL — source unique pour l'écran d'administration.
 *
 * ⛔ POURQUOI CETTE LISTE VIT ICI, À CÔTÉ DE `FooterConfig`. Le jour où un 16ᵉ champ légal
 * apparaîtra, `buildFooter` le lira et l'écran ne le proposerait jamais : le champ resterait vide
 * pour toujours, sans qu'aucune ligne de code n'échoue. Les deux doivent bouger ensemble, donc ils
 * se touchent.
 *
 * `appliesTo` dit QUAND le champ compte : c'est ce qui permet à l'écran de montrer d'abord ce que
 * le régime de la marque impose, au lieu d'un mur de quinze champs indifférenciés.
 */
export interface FooterField {
  key: keyof Omit<FooterConfig, "style" | "wording">;
  label: string;
  kind: "text" | "url" | "number" | "boolean";
  /** Ce que le champ fait, en une phrase, du point de vue de la personne qui le remplit. */
  help: string;
  /** Régimes ou marchés qui rendent ce champ utile. Vide = toujours. */
  appliesTo: string[];
  /** Le pied ne part pas sans lui, sous ce régime ou ce marché. */
  requiredFor?: string[];
}

export const FOOTER_FIELDS: readonly FooterField[] = [
  { key: "controller", label: "Sender identity", kind: "text", help: "The company or person the email comes from. Falls back to the brand name.", appliesTo: [] },
  { key: "physical_address", label: "Postal address", kind: "text", help: "Shown next to the sender identity. Required in the US, good practice everywhere.", appliesTo: [], requiredFor: ["canspam"] },
  { key: "privacy_url", label: "Privacy policy URL", kind: "url", help: "Linked at the bottom of every email. Without it, the email does not go out.", appliesTo: [], requiredFor: ["gdpr", "lgpd", "canspam"] },
  { key: "reason", label: "“Why am I getting this?”", kind: "text", help: "Replaces the default “You are receiving this email because…” line.", appliesTo: [] },
  { key: "dpo_contact", label: "DPO contact", kind: "text", help: "Data protection officer (encarregado). Shown under LGPD.", appliesTo: ["lgpd"] },
  { key: "responsible_gambling", label: "Responsible gambling notice", kind: "boolean", help: "Adds the 18+ and responsible gambling line. For betting brands.", appliesTo: [] },
  { key: "opt_out_days", label: "Opt-out window (days)", kind: "number", help: "How fast opt-outs are honored. Defaults to 10.", appliesTo: ["canspam"] },
  { key: "phone", label: "Phone number", kind: "text", help: "Required by CASL for Canadian recipients.", appliesTo: ["CA"] },
  { key: "unsub_min_days", label: "Unsubscribe validity (days)", kind: "number", help: "How long an unsubscribe link stays valid. Defaults to 60.", appliesTo: ["CA"] },
  { key: "legal_form", label: "Legal form", kind: "text", help: "German Impressum: the company's legal form.", appliesTo: ["DE"], requiredFor: ["DE"] },
  { key: "street_address", label: "Street address", kind: "text", help: "German Impressum: street and number — a PO box is not accepted.", appliesTo: ["DE"], requiredFor: ["DE"] },
  { key: "commercial_register", label: "Commercial register", kind: "text", help: "German Impressum: Handelsregister entry.", appliesTo: ["DE"] },
  { key: "vat_id", label: "VAT ID", kind: "text", help: "German Impressum: USt-IdNr.", appliesTo: ["DE"] },
  { key: "nif_cif", label: "NIF / CIF", kind: "text", help: "Spanish LSSI: provider identification.", appliesTo: ["ES"] },
  { key: "sender_name", label: "Sender name (JP)", kind: "text", help: "Japanese anti-spam law: the sender's name.", appliesTo: ["JP"] },
  { key: "sender_address", label: "Sender address (JP)", kind: "text", help: "Japanese anti-spam law: the sender's address.", appliesTo: ["JP"] },
];

export interface FooterInput {
  assetName: string;
  regime: Regime;
  cfg: FooterConfig;
  unsubUrl: string;
  prefsUrl?: string;
  reason?: string; // override du « Vous recevez cet email car… »
  locale?: Locale; // langue du footer (défaut en)
  market?: string; // marché de l'édition (DE/US/CA/ES/JP…) → blocs légaux spécifiques
}

/** Échappe le texte destiné à du HTML. Exporté : tout texte non fiable (nom, marque) DOIT passer par là. */
export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Échappe une valeur destinée à un ATTRIBUT HTML. `esc` NE SUFFIT PAS ici.
 *
 * ⛔ `esc` NE TOUCHE PAS AUX GUILLEMETS — c'est correct entre deux balises, et faux dans un attribut,
 * où un guillemet le FERME. `privacy_url` vient de `asset_edition.legal_footer`, qu'un administrateur
 * de marque écrit désormais à l'écran, et la route ne validait que le préfixe `https?://` : une URL
 * comme `https://x/" onmouseover="…` ajoutait des attributs arbitraires au lien de CHAQUE e-mail de
 * l'édition. Les liens de désinscription et de préférences passent par là aussi — ils sont calculés,
 * donc sûrs aujourd'hui, mais un `&` de query string s'écrit `&amp;` en HTML, et c'est le seul lien
 * dont la casse n'est pas rattrapable.
 */
export const escAttr = (s: string) => esc(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Renvoie { html, text } du footer conforme. */
export function buildFooter(i: FooterInput): { html: string; text: string; missing: string[] } {
  const { assetName, regime, cfg } = i;
  const st = cfg.style ?? {};
  const s = strings(i.locale ?? "en");
  const missing: string[] = [];
  if (regime === "canspam" && !cfg.physical_address) missing.push("physical_address");
  if (!cfg.privacy_url) missing.push("privacy_url");
  /*
   * ⛔ LE LIEN DE DÉSINSCRIPTION EST LA SEULE MENTION SANS LAQUELLE L'ENVOI EST ILLÉGAL PARTOUT.
   * Il est calculé par l'appelant, jamais saisi : une URL vide ne peut venir que d'un appelant cassé,
   * et le lien partirait alors vers nulle part. On le signale comme n'importe quelle mention
   * manquante, pour que le worker mette la ligne en veto (`footer_incomplete`) au lieu d'envoyer.
   */
  if (!i.unsubUrl || i.unsubUrl.trim() === "") missing.push("unsubscribe_url");

  /*
   * La formulation de la marque, texte par texte. ⛔ UN TEXTE BLANC REND LE DÉFAUT, JAMAIS UN VIDE :
   * un libellé de lien réduit à des espaces donnerait un lien de désinscription INVISIBLE, présent
   * pour `missing` et absent pour le lecteur. Les séparateurs, eux, ont droit aux espaces seuls.
   */
  const w = (cfg.wording ?? {}) as Record<string, unknown>;
  const defaut = defaultWording(i.locale ?? "en");
  const mot = (k: FooterWordingText): string => {
    const v = w[k];
    if (typeof v !== "string" || v === "") return defaut[k];
    if (!SEPARATEURS.includes(k) && v.trim() === "") return defaut[k];
    return v;
  };
  const jours = (k: "unsubValidity" | "optOut", n: number) => mot(k).split("{days}").join(String(n));

  // Chaque ligne du pied, rangée sous son nom ; l'ordre d'affichage est décidé plus bas.
  type Ligne = { html: string; text: string };
  const parLigne = new Map<FooterLine, Ligne[]>();
  const poser = (l: FooterLine, html: string, text: string) => {
    const liste = parLigne.get(l) ?? [];
    liste.push({ html, text });
    parLigne.set(l, liste);
  };

  // Trois sources, dans cet ordre : l'appelant (cas particulier d'un envoi), la config de la marque
  // (ce que l'écran écrit), puis la phrase par défaut dans la langue de l'édition.
  const reason = i.reason ?? cfg.reason ?? s.footer_reason(assetName);
  poser("reason", esc(reason), reason);

  // Identité expéditeur + adresse physique (obligatoire US, best practice partout)
  const identity = cfg.controller ?? assetName;
  const addr = cfg.physical_address ? `${identity}${mot("identitySeparator")}${cfg.physical_address}` : identity;
  poser("identity", esc(addr), addr);

  // Jeu responsable + 18+ (betting)
  if (cfg.responsible_gambling) poser("gambling", esc(mot("gambling")), mot("gambling"));

  // DPO (LGPD) — contact du responsable de la protection des données
  if (regime === "lgpd" && cfg.dpo_contact) {
    poser("dpo", `${esc(mot("dpo"))} ${esc(cfg.dpo_contact)}`, `${mot("dpo")} ${cfg.dpo_contact}`);
  }

  // --- Blocs légaux SPÉCIFIQUES PAR MARCHÉ ---
  const marketLine = (html: string, text: string) => poser("market", html, text);
  const market = i.market;

  // 🇩🇪 Impressum (DDG §5) : forme juridique, adresse (sans BP), registre du commerce, USt-IdNr.
  if (market === "DE") {
    if (!cfg.street_address) missing.push("street_address");
    if (!cfg.legal_form) missing.push("legal_form");
    const imp = [cfg.legal_form, cfg.street_address, cfg.commercial_register, cfg.vat_id ? `USt-IdNr. ${cfg.vat_id}` : ""]
      .map((x) => (x ?? "").trim()).filter(Boolean);
    if (imp.length) marketLine(`${esc(mot("impressum"))} ${esc(imp.join(", "))}`, `${mot("impressum")} ${imp.join(", ")}`);
  }
  // 🇪🇸 LSSI : identification du prestataire (NIF/CIF).
  if (market === "ES" && cfg.nif_cif) marketLine(`${esc(mot("nif"))} ${esc(cfg.nif_cif)}`, `${mot("nif")} ${cfg.nif_cif}`);
  // 🇯🇵 Loi anti-spam : nom + adresse de l'expéditeur.
  if (market === "JP") {
    const jp = [cfg.sender_name, cfg.sender_address].map((x) => (x ?? "").trim()).filter(Boolean);
    if (jp.length) marketLine(`${esc(mot("jpSender"))} ${esc(jp.join(" · "))}`, `${mot("jpSender")} ${jp.join(" · ")}`);
  }
  // 🇨🇦 CASL : téléphone + désinscription valable ≥ 60 jours.
  if (market === "CA") {
    if (cfg.phone) marketLine(`${esc(mot("phone"))} ${esc(cfg.phone)}`, `${mot("phone")} ${cfg.phone}`);
    const phrase = jours("unsubValidity", cfg.unsub_min_days ?? 60);
    marketLine(esc(phrase), phrase);
  }
  // 🇺🇸 CAN-SPAM : opt-out honoré sous 10 jours (l'adresse postale est déjà dans l'identité).
  if (regime === "canspam") {
    const phrase = jours("optOut", cfg.opt_out_days ?? 10);
    marketLine(esc(phrase), phrase);
  }

  // Liens : désinscription (obligatoire) · préférences · privacy
  const lien = st.linkColor ?? STYLE_DEFAUT.linkColor;
  const sep = mot("separator");
  const links: string[] = [];
  const tlinks: string[] = [];
  links.push(`<a href="${escAttr(i.unsubUrl)}" style="color:${lien}">${esc(mot("unsubscribe"))}</a>`);
  tlinks.push(`${mot("unsubscribe")}: ${i.unsubUrl}`);
  if (i.prefsUrl) {
    links.push(`<a href="${escAttr(i.prefsUrl)}" style="color:${lien}">${esc(mot("preferences"))}</a>`);
    // ⛔ LE TEXTE BRUT L'OMETTAIT (inventaire, élément 128) : un lecteur en texte seul n'avait aucun
    // moyen de régler sa fréquence ou ses finalités, seulement de tout quitter.
    tlinks.push(`${mot("preferences")}: ${i.prefsUrl}`);
  }
  if (cfg.privacy_url) {
    links.push(`<a href="${escAttr(cfg.privacy_url)}" style="color:${lien}">${esc(mot("privacy"))}</a>`);
    tlinks.push(`${mot("privacy")}: ${cfg.privacy_url}`);
  }
  poser("links", links.join(esc(sep)), tlinks.join(sep));

  if (regime === "gdpr") poser("withdraw", esc(mot("withdraw")), mot("withdraw"));

  /*
   * L'ASSEMBLAGE, DANS L'ORDRE DE LA MARQUE.
   *
   * ⛔ LES MARGES SONT CELLES D'ORIGINE, ATTACHÉES À CHAQUE LIGNE, et la toute première ligne n'en a
   * pas — c'était la phrase « pourquoi je reçois ceci », rendue en `<div>` nu. Dans l'ordre par
   * défaut, la sortie est donc identique à l'octet près à celle d'avant ; `footer.golden.test.ts`
   * l'ancre sur neuf pieds réels.
   */
  const MARGE: Record<FooterLine, number> = { reason: 6, identity: 6, gambling: 6, dpo: 6, market: 6, links: 8, withdraw: 4 };
  const lines: string[] = [];
  const tlines: string[] = [];
  for (const nom of footerLineOrder(w.order)) {
    for (const l of parLigne.get(nom) ?? []) {
      lines.push(lines.length === 0 ? `<div>${l.html}</div>` : `<div style="margin-top:${MARGE[nom]}px">${l.html}</div>`);
      tlines.push(l.text);
    }
  }

  /* ⛔ L'ORDRE ET LA FORME DES PROPRIÉTÉS CSS SONT CEUX D'ORIGINE, ET C'EST VOLONTAIRE. Sans jeton,
     cette chaîne doit être identique À L'OCTET PRÈS à celle d'avant : le poids de l'e-mail se
     mesure en octets contre `GMAIL_CLIP_BYTES`, et un pied réécrit « proprement » changerait d'un
     coup la mesure de toutes les marques. `background` s'insère seulement s'il est demandé. */
  const fond = st.background ? `background:${st.background};` : "";
  /*
   * ⛔ `fontFamily` EST LE SEUL JETON DE STYLE LIBRE, DONC LE SEUL À ÉCHAPPER. Les couleurs sont
   * tenues par un hexadécimal, `align` est énuméré, `fontSizePx` est numérique : aucun ne peut porter
   * autre chose que sa forme. `fontFamily` est du texte, et il atterrit dans un attribut `style`.
   *
   * ⛔ ET UN FILTRE PAR LISTE DE CARACTÈRES NE PEUT PAS LE TENIR. La route refuse le `;` LITTÉRAL,
   * mais `Arial&#59display:none` n'en contient aucun : c'est une référence de caractère NUMÉRIQUE,
   * que tout analyseur HTML décode en `;` même sans point-virgule final (l'exception « esperluette
   * ambiguë » ne couvre que les références NOMMÉES). Le CSS réellement appliqué devenait donc
   * `font-family:Arial;display:none;…` — le conteneur entier du pied disparaissait, LIEN DE
   * DÉSINSCRIPTION COMPRIS, sans que `missing` bouge ni qu'aucune ligne échoue.
   *
   * `escAttr` remplace `&` par `&amp;` (via `esc`), ce qui neutralise la référence à la source.
   * ⚠️ Une pile de polices ordinaire ne contient ni `&` ni `<` ni guillemet : la sortie reste
   * IDENTIQUE À L'OCTET PRÈS pour toutes les marques, et le poids mesuré ne bouge pas.
   */
  const html =
    `<div style="font-family:${escAttr(st.fontFamily ?? STYLE_DEFAUT.fontFamily)};` +
    `font-size:${st.fontSizePx ?? STYLE_DEFAUT.fontSizePx}px;` +
    `color:${st.color ?? STYLE_DEFAUT.color};` +
    `line-height:1.55;padding:16px 20px;${fond}` +
    `border-top:1px solid ${st.borderTopColor ?? STYLE_DEFAUT.borderTopColor};` +
    `text-align:${st.align ?? STYLE_DEFAUT.align}">${lines.join("")}</div>`;
  return { html, text: tlines.join("\n"), missing };
}
