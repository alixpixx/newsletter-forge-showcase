/**
 * Construit l'email final à partir du contexte outbox : FooterInput conforme (régime + config
 * légale de l'édition), liens unsub/prefs signés (via @nf/tokens, IDENTIQUES à ce que le site
 * public vérifie), puis rend le template @nf/email dans la LANGUE de l'édition (kit conformité).
 * Renvoie aussi `footerMissing` pour le veto de conformité (footer incomplet = jamais envoyé).
 *
 * Kinds 'test' / 'campaign' (builder v2) : le HTML est DÉJÀ COMPILÉ et figé par l'admin
 * (`template_version.html_shell` / `campaign.html_shell`). Le worker ne compile RIEN — il
 * n'exécute que `hydrate()` de @nf/render (zéro dépendance : ni MJML ni Zod ne remontent ici),
 * substituant les tokens du destinataire et les conditionnels. Le footer légal reste injecté par
 * @nf/email `buildFooter()` via les tokens système `{{legal_footer_html/text}}`, et le veto
 * `footerMissing` s'applique exactement comme pour les transactionnels.
 */
import {
  buildFooter,
  formatDateStyle,
  normalizeLocale,
  readDateFormats,
  renderConfirmation,
  renderReengagement,
  renderUnsubscribeAck,
  renderWelcome,
  stripDateFormatsMarker,
  type DateStyle,
  type DateToken,
  type FooterInput,
  type Locale,
} from "@nf/email";
import { regimeFlags } from "@nf/config";
import { hydrate, hydrateReport, hydrateText, type MergeVars } from "@nf/render/hydrate";
import { signUnsub, signPrefs } from "@nf/tokens";
import type { OutboxContext } from "./db";
import { log } from "./log";

export interface Rendered {
  subject: string;
  html: string;
  text: string;
  footerMissing: string[];
  /** Tokens/conditions hors registre rencontrés dans le shell (retirés du rendu) — diagnostic. */
  unknownTokens?: string[];
  /**
   * Posé quand un template de cycle de vie RATTACHÉ n'a pas pu servir et que le HTML en dur part à
   * sa place : la raison du repli. `processRow` en fait une alerte (voir `process.ts`).
   */
  lifecycleFallback?: string;
}

/**
 * Résultat explicite : un email rendu, ou une RAISON de skip. Une campagne qui ne part pas doit
 * dire pourquoi (shell absent, sujet vide…) plutôt que de retomber sur un « no_renderer » opaque.
 */
export type RenderOutcome = { ok: true; email: Rendered } | { ok: false; reason: string };

function footerInput(ctx: OutboxContext, publicBaseUrl: string, locale: Locale): FooterInput | null {
  const cfg = (ctx.legal_footer ?? {}) as {
    physical_address?: string;
    privacy_url?: string;
    controller?: string;
    dpo_contact?: string;
    responsible_gambling?: boolean;
  };
  const lang = `&lang=${locale}`;
  const unsubUrl = ctx.subscription_id
    ? `${publicBaseUrl}/unsubscribe?token=${signUnsub(ctx.subscription_id)}${lang}`
    : `${publicBaseUrl}/unsubscribe`;
  /**
   * ⛔ `&ls=` N'EST PAS UN MOUCHARD, C'EST LE SEUL RATTACHEMENT POSSIBLE. Le jeton de préférences
   * identifie l'ABONNÉ, jamais l'envoi : deux personnes qui ouvrent leurs préférences — l'une
   * depuis une relance, l'autre depuis le footer d'une campagne ordinaire — arrivent avec des
   * liens indiscernables. Sans ce paramètre, `responded_at` compterait la seconde comme une
   * réaction à une relance qu'elle n'a jamais lue, et le taux de réengagement monterait tout seul.
   *
   * Il ne porte que l'id de file (`email_outbox.id`), déjà transmis à Mailgun en `v:outbox_id` :
   * rien de secret. Il n'autorise d'ailleurs rien par lui-même — `apps/public` refuse de l'utiliser
   * si la relance désignée n'appartient pas à l'abonné que le jeton prouve.
   *
   * Posé UNIQUEMENT sur les relances : sur une campagne il n'aurait rien à rattacher.
   */
  const marqueRelance = ctx.kind === "reengagement" ? `&ls=${ctx.id}` : "";
  const prefsUrl = ctx.subscriber_id
    ? `${publicBaseUrl}/preferences?token=${signPrefs(ctx.subscriber_id)}${lang}${marqueRelance}`
    : undefined;

  return {
    assetName: ctx.asset_name ?? "la newsletter",
    regime: (ctx.compliance_regime ?? "gdpr") as FooterInput["regime"],
    cfg,
    unsubUrl,
    prefsUrl,
    locale,
    market: ctx.market ?? undefined,
  };
}

/** Lit une valeur scalaire du payload outbox (jsonb libre) sans jamais faire confiance au type. */
function payloadValue(ctx: OutboxContext, key: string): string | undefined {
  const v = ctx.payload?.[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

/**
 * Le jour d'envoi d'une édition, écrit en toutes lettres dans la langue de la marque — le style par
 * défaut de `{{edition_date}}`.
 *
 * ⛔ Le formatage vit dans `@nf/email` (`formatDateStyle`) : c'est lui qui porte les gardes (date
 * SEULE lue à minuit **UTC**, repli VIDE si elle manque ou est illisible) et la liste des styles que
 * chaque modèle peut choisir. Deux jetons qui prétendent décrire le même jour ne doivent jamais
 * pouvoir se contredire — d'où une seule fonction pour les trois.
 */
export function formatEditionDate(jour: string | null | undefined, locale: Locale): string {
  return formatDateStyle(jour, locale, "long");
}

/**
 * Variables de fusion d'UN destinataire (registre `MERGE_VARS` de @nf/render/hydrate).
 * Tout est échappé par `hydrate()` sauf `legal_footer_html`, déclaré `raw` — HTML système.
 *
 * `dates` : le style de chaque jeton de date, lu dans le shell du modèle (`readDateFormats`).
 * Absent = les formats d'avant, pour tout shell publié avant que le choix existe.
 */
function mergeVars(
  ctx: OutboxContext,
  footer: FooterInput,
  locale: Locale,
  dates: Record<DateToken, DateStyle> = readDateFormats(null),
): MergeVars {
  const foot = buildFooter(footer);
  const firstName = payloadValue(ctx, "first_name") ?? "";
  const privacyUrl = (ctx.legal_footer as { privacy_url?: string } | null)?.privacy_url;
  // Le jour de l'édition : celui de l'occurrence quand il y en a une, sinon celui de la campagne.
  const jourEdition = ctx.occurrence_local_date || ctx.campaign_local_date;

  return {
    first_name: firstName,
    last_name: payloadValue(ctx, "last_name") ?? "",
    email: ctx.to_email,
    asset_name: ctx.asset_name ?? "",
    edition_title: payloadValue(ctx, "edition_title") ?? "",
    /**
     * ⛔ L'OCCURRENCE D'ABORD, LE PAYLOAD ENSUITE. Ces deux variables étaient offertes dans le menu
     * du builder et lues UNIQUEMENT dans le payload — que `enqueue_campaign_batch` ne remplit
     * qu'avec le prénom. Elles retombaient donc toujours sur leur repli vide : un auteur écrivait
     * « Edição de {{edition_date}} » et « Edição de  » partait chez l'abonné, sans erreur nulle
     * part. Le payload reste consulté en second, pour ne pas casser un appelant qui l'alimenterait.
     */
    /**
     * ⛔ ET LA CAMPAGNE EN TROISIÈME. Une campagne PONCTUELLE n'a pas d'occurrence : les deux
     * premières sources rendaient vide, et « Édition du {{edition_date}} » partait en « Édition du ».
     * `campaign_local_date` (0050) est déjà convertie dans le fuseau de la campagne côté SQL — un
     * envoi programmé à 02:00 à São Paulo est daté du bon jour, pas de la veille en UTC.
     */
    edition_date:
      formatDateStyle(jourEdition, locale, dates.edition_date) || (payloadValue(ctx, "edition_date") ?? ""),
    edition_date_short: formatDateStyle(jourEdition, locale, dates.edition_date_short),
    weekday: formatDateStyle(jourEdition, locale, dates.weekday),
    campaign_name: ctx.campaign_name ?? "",
    // Lus, jamais recalculés : le document déplié n'existe qu'au gel (voir le registre).
    first_article: ctx.occurrence_first_article ?? "",
    article_count: ctx.occurrence_article_count != null ? String(ctx.occurrence_article_count) : "",
    /**
     * L'introduction écrite au gel, à partir des titres de CETTE édition. Même ordre que le shell :
     * l'occurrence d'abord, la campagne ponctuelle en repli.
     *
     * ⛔ REPLI VIDE, JAMAIS UNE PHRASE DE SECOURS. Quand la génération a échoué, l'édition part sans
     * son introduction plutôt qu'avec un texte que personne n'a écrit — et `ai_status` dit pourquoi.
     */
    ai_intro: ctx.occurrence_ai_intro ?? ctx.campaign_ai_intro ?? "",
    ai_preheader: ctx.occurrence_ai_preheader ?? ctx.campaign_ai_preheader ?? "",
    // `!= null` et non `??` sur une valeur déjà convertie : un `seq` de 0 doit rester un numéro,
    // pas devenir une absence. Hors série (`occurrence_id` nul), il n'y a AUCUN numéro à imprimer.
    edition_number: ctx.occurrence_seq != null ? String(ctx.occurrence_seq) : "",
    locale,
    market: ctx.market ?? "",
    unsubscribe_url: footer.unsubUrl,
    preferences_url: footer.prefsUrl ?? "",
    privacy_url: privacyUrl ?? "",
    // Pas de page « voir dans le navigateur » servie à ce jour : la valeur ne vient QUE du payload,
    // sinon le token retombe sur son fallback plutôt que sur une URL inventée.
    web_version_url: payloadValue(ctx, "web_version_url") ?? "",
    // Le lien de confirmation du double opt-in. Il ne vaut quelque chose que sur une ligne
    // `confirmation` — ailleurs `action_url` est nul et le jeton retombe sur son repli.
    confirm_url: ctx.action_url ?? "",
    is_premium: payloadValue(ctx, "is_premium") ?? "",
    has_first_name: firstName.trim() !== "",
    /**
     * Régime de conformité de l'édition qui envoie, pour les blocs conditionnels du CORPS.
     * ⛔ Exactement UN des trois est vrai, toujours — un régime absent ou inconnu retombe sur
     * `is_gdpr`. Le moteur n'ayant pas de `else`, trois drapeaux faux feraient partir l'e-mail sans
     * aucune mention légale, sans qu'une ligne de code échoue. Le calcul vit dans `@nf/config`.
     */
    ...regimeFlags(ctx.compliance_regime),
    legal_footer_html: foot.html,
    legal_footer_text: foot.text,
  };
}

/**
 * Kinds builder ('test' / 'campaign') : hydratation du shell figé. Aucune compilation.
 * Priorité au snapshot de campagne (immuable au lock) ; le kind 'test' tire de la version de
 * template. Chacun retombe sur l'autre si un seul des deux est renseigné.
 *
 * ⛔ ET L'OCCURRENCE PASSE AVANT TOUT LE RESTE quand la ligne en porte une. Une campagne
 * récurrente fige un contenu NEUF à chaque échéance, dans `campaign_occurrence.html_shell`, avec
 * les articles du jour ; `campaign.html_shell` est le snapshot du MODÈLE, figé au premier verrou
 * et jamais re-résolu. Servir le second pour une série, c'est envoyer huit fois les articles de la
 * semaine 1 — un e-mail parfaitement valide et complètement périmé, dont le défaut ne se voit qu'à
 * la réception. L'ordre de préférence est donc : occurrence → campagne → version de template.
 *
 * ⚠️ Troisième source, indispensable au kind 'test' : le payload de la ligne. Un envoi de test
 * porte le snapshot d'un BROUILLON non publié — `template_version.html_shell` est alors NULL par
 * construction (seules les versions publiées le portent). L'admin compile donc à la volée et joint
 * le HTML au payload ; sans ce repli, tout envoi de test serait skippé `no_compiled_shell`.
 */
function renderBuilder(ctx: OutboxContext, footer: FooterInput, locale: Locale, missing: string[]): RenderOutcome {
  const preferCampaign = ctx.kind === "campaign";
  // Le shell de l'occurrence n'est consulté QUE si la ligne porte une occurrence : hors série, ces
  // colonnes sont nulles et l'ordre historique s'applique inchangé.
  const occurrenceHtml = ctx.occurrence_id ? ctx.occurrence_html_shell : null;
  const occurrenceText = ctx.occurrence_id ? ctx.occurrence_text_shell : null;
  const shellBrut = preferCampaign
    ? (occurrenceHtml ?? ctx.campaign_html_shell ?? ctx.template_html_shell ?? payloadValue(ctx, "html"))
    : (ctx.template_html_shell ?? occurrenceHtml ?? ctx.campaign_html_shell ?? payloadValue(ctx, "html"));
  const texteBrut = preferCampaign
    ? (occurrenceText ?? ctx.campaign_text_shell ?? ctx.template_text_shell ?? payloadValue(ctx, "text"))
    : (ctx.template_text_shell ?? occurrenceText ?? ctx.campaign_text_shell ?? payloadValue(ctx, "text"));

  if (!shellBrut || shellBrut.trim() === "") return { ok: false, reason: "no_compiled_shell" };
  // Le choix de format des dates voyage dans le shell ; il est lu, puis retiré avant l'envoi.
  const dates = readDateFormats(shellBrut);
  const htmlShell = stripDateFormatsMarker(shellBrut);
  const textShell = texteBrut ? stripDateFormatsMarker(texteBrut) : texteBrut;

  // Veto conformité renforcé : un shell publié SANS bloc footer légal n'a pas de point d'injection
  // → l'email partirait sans désinscription. On le traite comme un footer incomplet.
  const footerMissing = htmlShell.includes("{{legal_footer_html}}")
    ? missing
    : [...missing, "legal_footer_block"];

  const vars = mergeVars(ctx, footer, locale, dates);
  const subject = hydrateText(ctx.subject ?? "", vars).trim();
  if (subject === "") return { ok: false, reason: "missing_subject" };

  const report = hydrateReport(htmlShell, vars);
  const text = textShell ? hydrateText(textShell, vars) : "";

  return {
    ok: true,
    email: {
      subject,
      html: report.html,
      text,
      footerMissing,
      unknownTokens: [...report.unknownTokens, ...report.unknownConditions],
    },
  };
}

/**
 * Le template RATTACHÉ à ce kind pour cette marque (`lifecycle_template`, 0059), hydraté (`email`) —
 * ou rien, et l'appelant rend alors le HTML en dur ; `repli` dit pourquoi un template rattaché a été
 * écarté (absent = aucun rattachement, le cas normal).
 *
 * ⛔ CETTE FONCTION NE REFUSE JAMAIS UN ENVOI. C'est sa règle unique, et elle explique toutes les
 * autres. Un e-mail de confirmation qui ne part pas, c'est une inscription perdue ET un
 * consentement non prouvé ; un accusé de désabonnement qui ne part pas, c'est une obligation légale
 * non tenue. Un template mal formé, archivé entre-temps, vidé, ou dont l'hydratation lève, doit
 * donc ramener au code en dur — jamais produire un `skipped`. Toute condition ci-dessous rend un
 * `repli` (« sers le dur ») et pas une raison de refus.
 *
 * ⛔ LE VETO DE FOOTER SE TRADUIT ICI EN REPLI, PAS EN SKIP. `renderBuilder` saute une campagne dont
 * le shell n'a pas de point d'injection de footer — c'est juste pour une campagne, qu'on peut ne
 * pas envoyer. Pour un e-mail de cycle de vie, le refus coûte plus cher que le repli : on sert le
 * HTML en dur, dont le footer est conforme par construction.
 *
 * ⚠️ La version servie est `template.current_version_id` (résolue par la vue), donc republier une
 * correction la met en service. C'est le sens du rattachement par template et non par version.
 */
function renderLifecycle(
  ctx: OutboxContext,
  footer: FooterInput,
  locale: Locale,
  missing: string[],
): { email?: Rendered; repli?: string } {
  const brut = ctx.lifecycle_html_shell;
  // Aucun template rattaché (ou aucune version publiée) : le cas normal, rien à signaler.
  if (brut === null || brut === undefined) return {};

  /*
   * ⛔ UN TEMPLATE RATTACHÉ QU'ON N'UTILISE PAS SE DIT. Le repli reste silencieux pour le
   * destinataire, pas pour l'équipe : la marque croit envoyer SON e-mail et c'est le HTML en dur de
   * secours qui part. La ligne de journal ne suffisait pas — personne ne lit ces journaux : la
   * raison remonte donc jusqu'à `processRow`, qui ALERTE (une fois par template et par fenêtre).
   */
  const repli = (raison: string): { repli: string } => {
    log("lifecycle_fallback", { outbox_id: ctx.id, kind: ctx.kind, asset: ctx.asset_slug ?? null, reason: raison });
    return { repli: raison };
  };

  if (brut.trim() === "") return repli("empty_shell");
  // Sans point d'injection de footer, le template partirait sans mention légale ni désinscription.
  if (!brut.includes("{{legal_footer_html}}")) return repli("no_legal_footer_slot");

  try {
    const vars = mergeVars(ctx, footer, locale, readDateFormats(brut));
    const shell = stripDateFormatsMarker(brut);
    // Le sujet du template d'abord ; celui de la ligne d'outbox en repli (il est renseigné pour les
    // kinds qui passent par `queueEmail`, vide pour ceux qu'une fonction SQL enfile).
    const subject = hydrateText(ctx.lifecycle_subject || ctx.subject || "", vars).trim();
    if (subject === "") return repli("empty_subject");

    const report = hydrateReport(shell, vars);
    if (report.html.trim() === "") return repli("empty_html");

    return {
      email: {
        subject,
        html: report.html,
        text: ctx.lifecycle_text_shell ? hydrateText(stripDateFormatsMarker(ctx.lifecycle_text_shell), vars) : "",
        footerMissing: missing,
        unknownTokens: [...report.unknownTokens, ...report.unknownConditions],
      },
    };
  } catch (e) {
    // ⛔ Pas de refus : la seule suite possible est le HTML en dur, et elle est meilleure que
    // l'absence d'e-mail. Mais le repli est journalisé et alerté, comme les autres.
    return repli(`hydrate_error:${(e as Error).message.slice(0, 120)}`);
  }
}

/**
 * Un e-mail de cycle de vie : le template rattaché s'il sert, sinon le HTML en dur de secours —
 * accompagné, quand un template rattaché a ÉTÉ écarté, de la raison du repli.
 */
function cycleDeVie(
  ctx: OutboxContext,
  footer: FooterInput,
  locale: Locale,
  missing: string[],
  enDur: () => { subject: string; html: string; text: string },
): RenderOutcome {
  const lc = renderLifecycle(ctx, footer, locale, missing);
  if (lc.email) return { ok: true, email: lc.email };
  return {
    ok: true,
    email: { ...enDur(), footerMissing: missing, ...(lc.repli ? { lifecycleFallback: lc.repli } : {}) },
  };
}

/** Renvoie l'email rendu, ou la raison pour laquelle la ligne n'est pas envoyable. */
export function render(ctx: OutboxContext, publicBaseUrl: string): RenderOutcome {
  const locale = normalizeLocale(ctx.language);
  const footer = footerInput(ctx, publicBaseUrl, locale);
  if (!footer) return { ok: false, reason: "no_footer_context" };

  const missing = buildFooter(footer).missing;
  const firstName = (ctx.payload?.first_name as string | undefined) ?? null;
  const assetName = ctx.asset_name ?? "la newsletter";

  if (ctx.kind === "confirmation") {
    if (!ctx.action_url) return { ok: false, reason: "missing_action_url" }; // lien de confirmation absent → inenvoyable
    // ⛔ La garde d'inenvoyabilité passe AVANT le template : un shell qui porte `{{confirm_url}}`
    // sans `action_url` derrière imprimerait le repli `#` du registre, et l'inscription serait
    // perdue sur un lien mort plutôt que refusée bruyamment.
    const confirmUrl = ctx.action_url;
    return cycleDeVie(ctx, footer, locale, missing, () =>
      renderConfirmation({ assetName, firstName, confirmUrl, footer, locale }),
    );
  }

  if (ctx.kind === "welcome") {
    return cycleDeVie(ctx, footer, locale, missing, () => renderWelcome({ assetName, firstName, footer, locale }));
  }

  if (ctx.kind === "test" || ctx.kind === "campaign") {
    return renderBuilder(ctx, footer, locale, missing);
  }

  if (ctx.kind === "reengagement") {
    /*
     * ⛔ LE TEMPLATE RATTACHÉ D'ABORD, LE DUR EN SECOURS — comme les trois autres e-mails de cycle de
     * vie. Le HTML en dur vit désormais dans `@nf/email` (`renderReengagement`), avec la même coquille
     * que les autres. Livrer le moteur sans contenu aurait produit des lignes en file que rien ne sait
     * rendre : `no_renderer`, donc des `skipped` en masse — une panne muette qui ressemble à un moteur
     * cassé.
     *
     * ⛔ LE LIEN EST OBLIGATOIRE, ET SON ABSENCE REND LA LIGNE INENVOYABLE. Un e-mail qui dit
     * « cliquez pour rester » sans lien cliquable demande un geste impossible, puis constate qu'il
     * n'a pas été fait et cesse d'écrire. C'est le pire enchaînement possible : on perdrait
     * l'abonné en lui reprochant de n'avoir pas répondu à une question qu'on ne lui a pas posée.
     * `prefsUrl` est nul quand `subscriber_id` l'est — on refuse alors d'envoyer.
     *
     * ⚠️ POURQUOI LE LIEN DE PRÉFÉRENCES ET PAS UN « JE RESTE » DÉDIÉ. Les préférences laissent le
     * choix réel — réduire la fréquence, ne garder qu'une finalité — plutôt que le tout ou rien, et
     * une page qui remercie sans donner la main n'apporterait rien.
     *
     * ⛔ CORRECTION DU 09/09 : la version précédente de ce commentaire disait « le clic est déjà le
     * signal, il produit un `email_event` de type `clicked` ». C'est FAUX. Mailgun ne réécrit les
     * liens que si `msg.track`, qui exige `tracking_consent = true` — mesuré : 1 202 abonnements à
     * `false`, 1 à `true`. Aucun `clicked` n'arrivera. C'est la PAGE de préférences qui enregistre
     * la réaction, en première partie, sans pixel (voir 5C.6).
     */
    const prefsUrl = footer.prefsUrl;
    if (!prefsUrl) return { ok: false, reason: "missing_prefs_url" };
    // Le template rattaché, s'il y en a un — la garde ci-dessus vaut pour lui aussi : le contrôle à
    // la publication exige `{{preferences_url}}` dans un shell de réengagement, et sans destination
    // le lien serait imprimé sur le repli `#`.
    return cycleDeVie(ctx, footer, locale, missing, () => renderReengagement({ assetName, prefsUrl, footer, locale }));
  }

  if (ctx.kind === "unsubscribe_ack") {
    return cycleDeVie(ctx, footer, locale, missing, () => renderUnsubscribeAck({ assetName, footer, locale }));
  }

  if (ctx.kind === "automation" || ctx.kind === "automation_tx") {
    /*
     * Automations (0082) : la version de modèle figée dans l'étape, hydratée comme un envoi du
     * builder — même veto de footer, même sujet obligatoire. AUCUN repli en dur : une automation
     * dont le modèle ne sert pas ne part pas (`no_compiled_shell`), elle n'est pas un e-mail dû.
     *
     * ⛔ LA RELANCE DE CONFIRMATION SANS LIEN EST INENVOYABLE, comme `confirmation` : un « confirmez
     * votre inscription » sans rien à cliquer demande un geste impossible. Deux trous possibles —
     * la ligne sans `action_url`, ou un modèle qui n'imprime pas `{{confirm_url}}` (l'éditeur ne sait
     * pas, à la publication, qu'un modèle servira de relance).
     */
    if (ctx.payload?.automation_trigger === "confirmation_reminder") {
      if (!ctx.action_url) return { ok: false, reason: "missing_action_url" };
      if (!(ctx.template_html_shell ?? "").includes("confirm_url")) return { ok: false, reason: "missing_confirm_link" };
    }
    return renderBuilder(ctx, footer, locale, missing);
  }

  return { ok: false, reason: "no_renderer" };
}
