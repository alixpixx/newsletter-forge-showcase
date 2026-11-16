/**
 * LES FORMATS DE DATE DES JETONS `{{edition_date}}`, `{{edition_date_short}}` ET `{{weekday}}`
 * (inventaire du 22/09/2026, élément 100).
 *
 * Jusqu'ici le worker écrivait ces trois dates dans UN format fixe chacune (`dateStyle: "long"`,
 * `"medium"`, `weekday: "long"`) : une marque qui voulait « dimanche 6 septembre » ou « 06/09/2026 »
 * n'avait aucun moyen de l'obtenir. Chaque MODÈLE choisit désormais son style, parmi une courte liste
 * de styles NOMMÉS — c'est `Intl` qui les rend dans la langue de l'édition, donc chaque style existe
 * dans toutes les langues servies sans une ligne de traduction.
 *
 * ⛔ LE TRANSPORT : UN MARQUEUR DANS LE SHELL COMPILÉ. Le worker ne voit JAMAIS le document d'un
 * modèle — seulement son HTML figé (`html_shell`), hydraté à l'envoi. Le choix voyage donc dans ce
 * HTML, sous la forme d'un commentaire que le compilateur émet et que le worker lit puis RETIRE avant
 * l'envoi :
 *
 *     <!--nf:dates edition_date=full weekday=weekday_short-->
 *
 * ⛔ ABSENT = LE FORMAT D'AVANT. Un shell publié avant ce lot n'a pas de marqueur : il doit continuer
 * à écrire exactement la même date. Une clé inconnue ou un style inconnu sont ignorés, jamais une
 * erreur : un envoi ne doit pas échouer pour un réglage de présentation.
 */
import type { Locale } from "./i18n";

export const DATE_TOKENS = ["edition_date", "edition_date_short", "weekday"] as const;
export type DateToken = (typeof DATE_TOKENS)[number];

export const DATE_STYLES = ["full", "long", "medium", "short", "day_month", "weekday", "weekday_short"] as const;
export type DateStyle = (typeof DATE_STYLES)[number];

export type DateFormats = Partial<Record<DateToken, DateStyle>>;

/** Les formats d'avant ce lot — ceux qui partent tant qu'un modèle n'a rien choisi. */
export const DEFAULT_DATE_FORMATS: Record<DateToken, DateStyle> = {
  edition_date: "long",
  edition_date_short: "medium",
  weekday: "weekday",
};

const OPTIONS: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  full: { dateStyle: "full" },
  long: { dateStyle: "long" },
  medium: { dateStyle: "medium" },
  short: { dateStyle: "short" },
  day_month: { day: "numeric", month: "long" },
  weekday: { weekday: "long" },
  weekday_short: { weekday: "short" },
};

/** Noms d'écran des styles (l'interface est en anglais). L'exemple, lui, se calcule dans la langue. */
export const DATE_STYLE_LABELS: Record<DateStyle, string> = {
  full: "Full (weekday, day, month, year)",
  long: "Long (day, month, year)",
  medium: "Medium (abbreviated month)",
  short: "Numeric",
  day_month: "Day and month",
  weekday: "Weekday",
  weekday_short: "Weekday (short)",
};

export const isDateStyle = (v: unknown): v is DateStyle => (DATE_STYLES as readonly unknown[]).includes(v);
const isDateToken = (v: unknown): v is DateToken => (DATE_TOKENS as readonly unknown[]).includes(v);

/**
 * Une date SEULE (`2026-09-06`) écrite dans un style et une langue.
 *
 * ⛔ `timeZone: "UTC"` N'EST PAS UN DÉTAIL. `new Date()` lit une date seule à minuit UTC ; la formater
 * dans le fuseau du serveur la ferait reculer d'un jour partout à l'ouest de Greenwich. Une édition
 * datée du 6 partirait en annonçant le 5 — sans erreur, sans trace, et seulement pour certains fuseaux.
 *
 * Repli VIDE si la date manque ou est illisible : mieux vaut « Edição de  » qu'un « Invalid Date »
 * expédié à toute une liste.
 */
export function formatDateStyle(jour: string | null | undefined, locale: Locale, style: DateStyle): string {
  if (!jour) return "";
  const t = Date.parse(`${jour}T00:00:00Z`);
  if (!Number.isFinite(t)) return "";
  try {
    return new Intl.DateTimeFormat(locale, { ...OPTIONS[style], timeZone: "UTC" }).format(new Date(t));
  } catch {
    // Une locale inconnue d'Intl ne doit pas faire échouer un envoi entier.
    return "";
  }
}

const MARQUEUR = /<!--\s*nf:dates\b([^>]*?)-->/g;

/**
 * Le marqueur à émettre pour un choix de formats — `""` quand rien ne diffère du défaut.
 *
 * ⚠️ Rien émis pour un choix par défaut : un modèle qui n'a rien réglé garde un shell identique à
 * l'octet près à celui d'avant, donc un poids mesuré inchangé.
 */
export function dateFormatsMarker(formats: DateFormats | null | undefined): string {
  if (!formats) return "";
  const paires: string[] = [];
  for (const t of DATE_TOKENS) {
    const s = formats[t];
    if (isDateStyle(s) && s !== DEFAULT_DATE_FORMATS[t]) paires.push(`${t}=${s}`);
  }
  return paires.length ? `<!--nf:dates ${paires.join(" ")}-->` : "";
}

/** Les formats choisis par un shell, lus défensivement : absent, inconnu ou mal formé = défaut. */
export function readDateFormats(shell: string | null | undefined): Record<DateToken, DateStyle> {
  const formats: Record<DateToken, DateStyle> = { ...DEFAULT_DATE_FORMATS };
  if (!shell) return formats;
  for (const m of shell.matchAll(MARQUEUR)) {
    for (const paire of (m[1] ?? "").trim().split(/\s+/)) {
      const [cle, valeur] = paire.split("=");
      if (isDateToken(cle) && isDateStyle(valeur)) formats[cle] = valeur;
    }
  }
  return formats;
}

/** Retire le marqueur avant l'envoi : il n'a rien à faire dans la boîte de réception. */
export function stripDateFormatsMarker(s: string): string {
  return s.replace(MARQUEUR, "");
}
