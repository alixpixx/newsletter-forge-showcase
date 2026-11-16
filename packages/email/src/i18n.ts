/**
 * i18n des emails transactionnels + footer légal. Motivé par le kit de conformité Example Media
 * (docs/compliance/) : les communications doivent être dans la LANGUE LOCALE du marché.
 * Langues servies par les marques actuelles : pt-BR (BR), en (GB/INT), es (CL). fr en réserve.
 * Fallback = en (base UE/internationale du kit).
 */
export type Locale = "en" | "pt-BR" | "es" | "fr" | "de" | "it";

const LOCALES: Locale[] = ["en", "pt-BR", "es", "fr", "de", "it"];

/** Normalise une locale d'édition (ex. "pt", "PT-BR", "es-CL", "de-DE", "it") vers une locale supportée. */
export function normalizeLocale(input: string | null | undefined): Locale {
  if (!input) return "en";
  const v = input.toLowerCase();
  if (v.startsWith("pt")) return "pt-BR";
  if (v.startsWith("es")) return "es";
  if (v.startsWith("fr")) return "fr";
  if (v.startsWith("de")) return "de";
  if (v.startsWith("it")) return "it";
  return "en";
}

export interface Strings {
  // Footer légal
  footer_reason: (brand: string) => string;
  footer_unsub: string;
  footer_prefs: string;
  footer_privacy: string;
  footer_withdraw: string; // GDPR : retrait du consentement
  responsible_gambling: string;
  /**
   * Mentions de marché traduites (22/09/2026).
   *
   * ⛔ ELLES ÉTAIENT ÉCRITES EN DUR DANS `footer.ts`, EN ANGLAIS OU EN PORTUGAIS, POUR TOUTES LES
   * LANGUES. Un e-mail allemand sous LGPD annonçait « Encarregado (DPO) : », un e-mail québécois
   * « Unsubscribe requests are honored… » — la mention existait, mais pas dans la langue que le kit
   * de conformité exige. `{days}` est remplacé au rendu par le délai configuré de la marque.
   *
   * ⚠️ LES VALEURS ANGLAISES (et le préfixe DPO portugais) SONT CELLES D'AVANT, À L'OCTET PRÈS : le
   * pied des marques existantes ne bouge pas, son poids mesuré contre `GMAIL_CLIP_BYTES` non plus.
   */
  footer_dpo: string; // LGPD : préfixe du contact DPO / encarregado
  footer_phone: string; // CA CASL : préfixe du téléphone
  footer_unsub_validity: string; // CA CASL : validité de la désinscription, `{days}`
  footer_optout: string; // US CAN-SPAM : délai de traitement, `{days}`
  // Confirmation (double opt-in) — textes du kit conformité
  confirm_subject: (brand: string) => string;
  confirm_hi: (name: string | null) => string;
  confirm_body: (brand: string) => string;
  confirm_cta: string;
  confirm_ignore: string;
  // Bienvenue
  welcome_subject: (brand: string) => string;
  welcome_hi: (name: string | null) => string;
  welcome_body: (brand: string) => string;
  // Accusé de désinscription
  unsub_ack_title: string;
  unsub_ack_body: (brand: string) => string;
  // Réengagement (lot 5). ⛔ `reengage_sunset` ANNONCE qu'on va cesser d'écrire : c'est ce qui rend
  // la politique de sunset loyale, et c'est aussi ce qui fait réagir. Le retirer ferait disparaître
  // quelqu'un de la liste sans qu'il ait jamais su qu'il pouvait rester d'un clic.
  reengage_subject: (brand: string) => string;
  reengage_title: (brand: string) => string;
  reengage_body: (brand: string) => string;
  reengage_cta: string;
  reengage_sunset: string;
}

const EN: Strings = {
  footer_reason: (b) => `You are receiving this email because you subscribed to the ${b} newsletter.`,
  footer_unsub: "Unsubscribe",
  footer_prefs: "Preferences",
  footer_privacy: "Privacy Policy",
  footer_withdraw: "You can withdraw your consent at any time.",
  responsible_gambling: "Gamble responsibly · 18+",
  footer_dpo: "Data Protection Officer (DPO):",
  footer_phone: "Tel:",
  footer_unsub_validity: "Unsubscribe requests are honored for at least {days} days.",
  footer_optout: "We honor opt-out requests within {days} days.",
  confirm_subject: (b) => `Please confirm your subscription to the ${b} newsletter`,
  confirm_hi: (n) => (n ? `Hi ${n},` : "Hi,"),
  confirm_body: (b) =>
    `We received a request to subscribe your email to the ${b} newsletter. To confirm and start receiving it, click the button below.`,
  confirm_cta: "Confirm subscription",
  confirm_ignore: "If this wasn't you, ignore this email — we won't send anything without your confirmation.",
  welcome_subject: (b) => `Welcome to ${b} 👋`,
  welcome_hi: (n) => (n ? `Welcome, ${n}!` : "Welcome!"),
  welcome_body: (b) => `Your subscription to ${b} is confirmed. You'll receive our next content by email.`,
  unsub_ack_title: "Unsubscribe confirmed",
  unsub_ack_body: (b) => `You will no longer receive emails from ${b}. You can re-subscribe at any time.`,
  reengage_subject: (b) => `Still want to hear from ${b}?`,
  reengage_title: (b) => `Do you still want ${b}?`,
  reengage_body: (b) =>
    `You haven't opened our last few emails, and we'd rather write to people who want to read us. One click and nothing changes.`,
  reengage_cta: "Yes, keep me subscribed",
  reengage_sunset: "Without a click, we'll stop sending — your subscription stays, and you can come back whenever you like.",
};

const PT: Strings = {
  footer_reason: (b) => `Você recebe este e-mail porque se inscreveu na newsletter da ${b}.`,
  footer_unsub: "Cancelar inscrição",
  footer_prefs: "Preferências",
  footer_privacy: "Política de Privacidade",
  footer_withdraw: "Você pode revogar seu consentimento a qualquer momento.",
  responsible_gambling: "Jogue com responsabilidade · +18",
  // ⚠️ L'espace avant les deux-points est celui du pied d'origine : le pied des marques brésiliennes
  // (les seules sous LGPD) reste identique à l'octet près.
  footer_dpo: "Encarregado (DPO) :",
  footer_phone: "Tel.:",
  footer_unsub_validity: "Os pedidos de cancelamento de inscrição são aceitos por pelo menos {days} dias.",
  footer_optout: "Atendemos os pedidos de cancelamento em até {days} dias.",
  confirm_subject: (b) => `Confirme sua inscrição na newsletter da ${b}`,
  confirm_hi: (n) => (n ? `Olá ${n},` : "Olá,"),
  confirm_body: (b) =>
    `Recebemos um pedido de inscrição do seu e-mail na newsletter da ${b}. Para confirmar e começar a receber, clique no botão abaixo.`,
  confirm_cta: "Confirmar inscrição",
  confirm_ignore: "Se não foi você, ignore este e-mail — nada será enviado sem a confirmação.",
  welcome_subject: (b) => `Bem-vindo(a) à ${b} 👋`,
  welcome_hi: (n) => (n ? `Bem-vindo(a), ${n}!` : "Bem-vindo(a)!"),
  welcome_body: (b) => `Sua inscrição na ${b} está confirmada. Você receberá nossos próximos conteúdos por e-mail.`,
  unsub_ack_title: "Cancelamento confirmado",
  unsub_ack_body: (b) => `Você não receberá mais e-mails da ${b}. Você pode se inscrever novamente quando quiser.`,
  reengage_subject: (b) => `Ainda quer receber a ${b}?`,
  reengage_title: (b) => `Você ainda quer a ${b}?`,
  reengage_body: (b) =>
    `Você não abriu nossos últimos e-mails, e preferimos escrever para quem quer nos ler. Um clique e nada muda.`,
  reengage_cta: "Sim, quero continuar recebendo",
  reengage_sunset: "Sem um clique, vamos parar de enviar — sua inscrição continua, e você pode voltar quando quiser.",
};

const ES: Strings = {
  footer_reason: (b) => `Usted recibe este correo porque se suscribió al boletín de ${b}.`,
  footer_unsub: "Darse de baja",
  footer_prefs: "Preferencias",
  footer_privacy: "Política de Privacidad",
  footer_withdraw: "Puede revocar su consentimiento en cualquier momento.",
  responsible_gambling: "Juega con responsabilidad · +18",
  footer_dpo: "Delegado de protección de datos (DPO):",
  footer_phone: "Tel.:",
  footer_unsub_validity: "Las solicitudes de baja se aceptan durante al menos {days} días.",
  footer_optout: "Atendemos las solicitudes de baja en un plazo de {days} días.",
  confirm_subject: (b) => `Confirma tu suscripción al boletín de ${b}`,
  confirm_hi: (n) => (n ? `Hola ${n},` : "Hola,"),
  confirm_body: (b) =>
    `Hemos recibido una solicitud de suscripción de tu correo al boletín de ${b}. Para confirmar y empezar a recibirlo, haz clic en el botón.`,
  confirm_cta: "Confirmar suscripción",
  confirm_ignore: "Si no fuiste tú, ignora este correo: no enviaremos nada sin tu confirmación.",
  welcome_subject: (b) => `Bienvenido(a) a ${b} 👋`,
  welcome_hi: (n) => (n ? `¡Bienvenido(a), ${n}!` : "¡Bienvenido(a)!"),
  welcome_body: (b) => `Tu suscripción a ${b} está confirmada. Recibirás nuestros próximos contenidos por correo.`,
  unsub_ack_title: "Baja confirmada",
  unsub_ack_body: (b) => `Ya no recibirás correos de ${b}. Puedes volver a suscribirte cuando quieras.`,
  reengage_subject: (b) => `¿Sigues queriendo recibir ${b}?`,
  reengage_title: (b) => `¿Todavía quieres ${b}?`,
  reengage_body: (b) =>
    `No has abierto nuestros últimos correos, y preferimos escribir a quien quiere leernos. Un clic y nada cambia.`,
  reengage_cta: "Sí, quiero seguir recibiéndolo",
  reengage_sunset: "Sin un clic, dejaremos de enviarte — tu suscripción se mantiene y puedes volver cuando quieras.",
};

const FR: Strings = {
  footer_reason: (b) => `Vous recevez cet e-mail car vous êtes inscrit(e) à la newsletter de ${b}.`,
  footer_unsub: "Se désinscrire",
  footer_prefs: "Préférences",
  footer_privacy: "Politique de confidentialité",
  footer_withdraw: "Vous pouvez retirer votre consentement à tout moment.",
  responsible_gambling: "Jouez de manière responsable · +18",
  footer_dpo: "Délégué à la protection des données (DPO) :",
  footer_phone: "Tél. :",
  footer_unsub_validity: "Les demandes de désinscription sont acceptées pendant au moins {days} jours.",
  footer_optout: "Nous traitons les demandes de désinscription sous {days} jours.",
  confirm_subject: (b) => `Confirmez votre inscription à la newsletter de ${b}`,
  confirm_hi: (n) => (n ? `Bonjour ${n},` : "Bonjour,"),
  confirm_body: (b) =>
    `Nous avons reçu une demande d'inscription de votre e-mail à la newsletter de ${b}. Pour confirmer et commencer à la recevoir, cliquez sur le bouton.`,
  confirm_cta: "Confirmer l'inscription",
  confirm_ignore: "Si vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail — rien ne sera envoyé sans confirmation.",
  welcome_subject: (b) => `Bienvenue chez ${b} 👋`,
  welcome_hi: (n) => (n ? `Bienvenue ${n} !` : "Bienvenue !"),
  welcome_body: (b) => `Votre inscription à ${b} est confirmée. Vous recevrez nos prochains contenus par e-mail.`,
  unsub_ack_title: "Désinscription confirmée",
  unsub_ack_body: (b) => `Vous ne recevrez plus les e-mails de ${b}. Vous pouvez vous réinscrire à tout moment.`,
  reengage_subject: (b) => `Vous voulez toujours recevoir ${b} ?`,
  reengage_title: (b) => `Vous voulez toujours ${b} ?`,
  reengage_body: (b) =>
    `Vous n'avez pas ouvert nos derniers e-mails, et nous préférons écrire à ceux qui ont envie de nous lire. Un clic et rien ne change.`,
  reengage_cta: "Oui, je veux continuer à recevoir",
  reengage_sunset: "Sans un clic, nous cesserons de vous écrire — votre inscription reste valable et vous pourrez revenir quand vous voudrez.",
};

const DE: Strings = {
  footer_reason: (b) => `Sie erhalten diese E-Mail, weil Sie den ${b}-Newsletter abonniert haben.`,
  footer_unsub: "Abmelden",
  footer_prefs: "Einstellungen",
  footer_privacy: "Datenschutzerklärung",
  footer_withdraw: "Sie können Ihre Einwilligung jederzeit widerrufen.",
  responsible_gambling: "Spielen Sie verantwortungsbewusst · 18+",
  footer_dpo: "Datenschutzbeauftragter (DPO):",
  footer_phone: "Tel.:",
  footer_unsub_validity: "Abmeldeanfragen werden mindestens {days} Tage lang angenommen.",
  footer_optout: "Abmeldeanfragen bearbeiten wir innerhalb von {days} Tagen.",
  confirm_subject: (b) => `Bitte bestätigen Sie Ihre Anmeldung zum ${b}-Newsletter`,
  confirm_hi: (n) => (n ? `Hallo ${n},` : "Hallo,"),
  confirm_body: (b) =>
    `Wir haben eine Anmeldung Ihrer E-Mail-Adresse für den ${b}-Newsletter erhalten. Zum Bestätigen klicken Sie auf die Schaltfläche.`,
  confirm_cta: "Anmeldung bestätigen",
  confirm_ignore: "Wenn Sie das nicht waren, ignorieren Sie diese E-Mail — ohne Bestätigung senden wir Ihnen nichts.",
  welcome_subject: (b) => `Willkommen bei ${b} 👋`,
  welcome_hi: (n) => (n ? `Willkommen, ${n}!` : "Willkommen!"),
  welcome_body: (b) => `Ihre Anmeldung bei ${b} ist bestätigt. Sie erhalten unsere nächsten Inhalte per E-Mail.`,
  unsub_ack_title: "Abmeldung bestätigt",
  unsub_ack_body: (b) => `Sie erhalten keine E-Mails mehr von ${b}. Sie können sich jederzeit erneut anmelden.`,
  reengage_subject: (b) => `Möchten Sie ${b} weiterhin erhalten?`,
  reengage_title: (b) => `Möchten Sie ${b} noch?`,
  reengage_body: (b) =>
    `Sie haben unsere letzten E-Mails nicht geöffnet, und wir schreiben lieber denen, die uns lesen möchten. Ein Klick, und es ändert sich nichts.`,
  reengage_cta: "Ja, weiter abonniert bleiben",
  reengage_sunset: "Ohne Klick stellen wir den Versand ein — Ihr Abonnement bleibt bestehen, und Sie können jederzeit zurückkommen.",
};

const IT: Strings = {
  footer_reason: (b) => `Ricevi questa e-mail perché ti sei iscritto alla newsletter ${b}.`,
  footer_unsub: "Annulla iscrizione",
  footer_prefs: "Preferenze",
  footer_privacy: "Informativa sulla privacy",
  footer_withdraw: "Puoi revocare il consenso in qualsiasi momento.",
  responsible_gambling: "Gioca responsabilmente · 18+",
  footer_dpo: "Responsabile della protezione dei dati (DPO):",
  footer_phone: "Tel.:",
  footer_unsub_validity: "Le richieste di disiscrizione sono accettate per almeno {days} giorni.",
  footer_optout: "Gestiamo le richieste di disiscrizione entro {days} giorni.",
  confirm_subject: (b) => `Conferma la tua iscrizione alla newsletter ${b}`,
  confirm_hi: (n) => (n ? `Ciao ${n},` : "Ciao,"),
  confirm_body: (b) =>
    `Abbiamo ricevuto una richiesta di iscrizione del tuo indirizzo alla newsletter ${b}. Per confermare, clicca sul pulsante.`,
  confirm_cta: "Conferma iscrizione",
  confirm_ignore: "Se non sei stato tu, ignora questa e-mail — senza conferma non invieremo nulla.",
  welcome_subject: (b) => `Benvenuto in ${b} 👋`,
  welcome_hi: (n) => (n ? `Benvenuto, ${n}!` : "Benvenuto!"),
  welcome_body: (b) => `La tua iscrizione a ${b} è confermata. Riceverai i nostri prossimi contenuti via e-mail.`,
  unsub_ack_title: "Disiscrizione confermata",
  unsub_ack_body: (b) => `Non riceverai più e-mail da ${b}. Puoi iscriverti di nuovo quando vuoi.`,
  reengage_subject: (b) => `Vuoi ancora ricevere ${b}?`,
  reengage_title: (b) => `Vuoi ancora ${b}?`,
  reengage_body: (b) =>
    `Non hai aperto le nostre ultime e-mail, e preferiamo scrivere a chi ha voglia di leggerci. Un clic e non cambia nulla.`,
  reengage_cta: "Sì, voglio continuare a riceverla",
  reengage_sunset: "Senza un clic smetteremo di scriverti — la tua iscrizione resta valida e puoi tornare quando vuoi.",
};

const DICT: Record<Locale, Strings> = { en: EN, "pt-BR": PT, es: ES, fr: FR, de: DE, it: IT };

export function strings(locale: Locale): Strings {
  return DICT[locale] ?? EN;
}

export { LOCALES };
