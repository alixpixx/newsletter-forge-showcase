/**
 * Rendu HTML des emails de cycle de vie EN DUR (confirmation, bienvenue, accusé de désinscription,
 * réengagement). Le footer conforme est toujours injecté. Localisé dans la langue de l'édition (kit
 * de conformité Example Media : langue locale requise). Consommé par le worker d'envoi.
 *
 * ⛔ CE N'EST PLUS QU'UN FILET DE SÉCURITÉ (décision d'Alix, 22/09/2026). Chaque marque a son modèle
 * éditable dans le builder pour chacun de ces quatre e-mails ; ce code ne part que lorsqu'aucun modèle
 * n'est rattaché, ou lorsque le modèle rattaché est inutilisable — et dans ce second cas le worker
 * ALERTE (`process.ts`). Il doit donc rester correct et sobre, pas beau.
 *
 * ⛔ PLUS DE BANDEAU « newsletter·forge » ROSE. Le seul nom que l'abonné connaît est celui de la
 * marque à laquelle il s'est inscrit ; lui écrire sous le nom de l'outil qui envoie, en rose vif,
 * faisait passer une confirmation d'inscription pour un e-mail d'un tiers. Le bandeau porte
 * désormais le nom de la marque, et l'accent est un encre neutre : la couleur de la marque n'est pas
 * connue du worker sans une lecture de plus (aucune colonne ne la porte, `asset_edition.branding`
 * est vide pour toutes les marques au 22/09/2026).
 */
import { buildFooter, esc, escAttr, type FooterInput } from "./footer";
import { strings, type Locale } from "./i18n";

const INK = "#191920";

function shell(brand: string, bodyHtml: string, footerHtml: string): string {
  return `<!DOCTYPE html><html><body style="margin:0;background:#f7f7fb;padding:24px">
<div style="max-width:460px;margin:auto;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #eee">
  <div style="background:${INK};color:#fff;padding:18px 22px"><b style="font-size:16px;font-family:Arial,sans-serif">${esc(brand)}</b></div>
  <div style="padding:24px 22px;font-family:Arial,sans-serif;color:${INK}">${bodyHtml}</div>
  ${footerHtml}
</div></body></html>`;
}

/** ⛔ L'URL est échappée pour un ATTRIBUT : un `&` de query string s'écrit `&amp;` dans un `href`. */
function cta(url: string, label: string): string {
  return `<a href="${escAttr(url)}" style="display:inline-block;background:${INK};color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:9px;font-size:14px">${label}</a>`;
}

export interface ConfirmationInput {
  assetName: string;
  firstName?: string | null;
  confirmUrl: string;
  footer: FooterInput;
  locale?: Locale;
}

export function renderConfirmation(i: ConfirmationInput): { subject: string; html: string; text: string } {
  const locale = i.locale ?? "en";
  const s = strings(locale);
  const foot = buildFooter({ ...i.footer, locale });
  // firstName/assetName viennent de données non fiables (saisie abonné, nom de marque) → échapper dans le HTML.
  const hiHtml = esc(s.confirm_hi(i.firstName ?? null));
  const bodyText = s.confirm_body(i.assetName);
  const body = `<h2 style="margin:0 0 8px;font-size:18px">${esc(s.confirm_cta)}</h2>
<p style="color:#555;font-size:14px;line-height:1.5">${hiHtml} ${esc(bodyText)}</p>
<p style="margin:18px 0">${cta(i.confirmUrl, esc(s.confirm_cta))}</p>
<p style="color:#999;font-size:12px">${esc(s.confirm_ignore)}</p>`;
  return {
    subject: s.confirm_subject(i.assetName),
    html: shell(i.assetName, body, foot.html),
    text: `${s.confirm_hi(i.firstName ?? null)}\n\n${bodyText}\n${i.confirmUrl}\n\n${foot.text}`,
  };
}

export interface WelcomeInput {
  assetName: string;
  firstName?: string | null;
  footer: FooterInput;
  locale?: Locale;
}

export function renderWelcome(i: WelcomeInput): { subject: string; html: string; text: string } {
  const locale = i.locale ?? "en";
  const s = strings(locale);
  const foot = buildFooter({ ...i.footer, locale });
  const hiHtml = esc(s.welcome_hi(i.firstName ?? null));
  const body = `<h2 style="margin:0 0 8px;font-size:18px">${hiHtml} 👋</h2>
<p style="color:#555;font-size:14px;line-height:1.5">${esc(s.welcome_body(i.assetName))}</p>`;
  return {
    subject: s.welcome_subject(i.assetName),
    html: shell(i.assetName, body, foot.html),
    text: `${s.welcome_hi(i.firstName ?? null)}\n\n${s.welcome_body(i.assetName)}\n\n${foot.text}`,
  };
}

export interface ReengagementInput {
  assetName: string;
  /** Le lien de préférences signé. ⛔ Obligatoire : sans lui l'e-mail demande un geste impossible. */
  prefsUrl: string;
  footer: FooterInput;
  locale?: Locale;
}

/**
 * Le réengagement en dur. Déplacé ici depuis `apps/worker/src/render.ts` (22/09/2026) pour partager
 * la coquille des trois autres : quatre e-mails de la même marque ne doivent pas porter quatre
 * habillages différents.
 *
 * ⛔ LA MENTION DE SUNSET N'EST PAS DÉCORATIVE : c'est elle qui rend la politique loyale (voir
 * `reengage_sunset` dans `i18n.ts`).
 */
export function renderReengagement(i: ReengagementInput): { subject: string; html: string; text: string } {
  const locale = i.locale ?? "en";
  const s = strings(locale);
  const foot = buildFooter({ ...i.footer, locale });
  const body = `<h2 style="margin:0 0 8px;font-size:18px">${esc(s.reengage_title(i.assetName))}</h2>
<p style="color:#555;font-size:14px;line-height:1.5">${esc(s.reengage_body(i.assetName))}</p>
<p style="margin:22px 0 14px">${cta(i.prefsUrl, esc(s.reengage_cta))}</p>
<p style="color:#8a8a94;font-size:12px;line-height:1.5">${esc(s.reengage_sunset)}</p>`;
  return {
    subject: s.reengage_subject(i.assetName),
    html: shell(i.assetName, body, foot.html),
    text: `${s.reengage_title(i.assetName)}\n\n${s.reengage_body(i.assetName)}\n\n${s.reengage_cta} : ${i.prefsUrl}\n\n${s.reengage_sunset}\n\n${foot.text}`,
  };
}

export interface UnsubscribeAckInput {
  assetName: string;
  footer: FooterInput;
  locale?: Locale;
}

/** L'accusé de désinscription en dur. Même déplacement, même raison que `renderReengagement`. */
export function renderUnsubscribeAck(i: UnsubscribeAckInput): { subject: string; html: string; text: string } {
  const locale = i.locale ?? "en";
  const s = strings(locale);
  const foot = buildFooter({ ...i.footer, locale });
  const body = `<h2 style="margin:0 0 8px;font-size:18px">${esc(s.unsub_ack_title)}</h2>
<p style="color:#555;font-size:14px;line-height:1.5">${esc(s.unsub_ack_body(i.assetName))}</p>`;
  return {
    subject: `${s.unsub_ack_title} — ${i.assetName}`,
    html: shell(i.assetName, body, foot.html),
    text: `${s.unsub_ack_title}.\n${s.unsub_ack_body(i.assetName)}\n\n${foot.text}`,
  };
}
