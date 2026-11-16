/**
 * SOURCE UNIQUE des strings UI localisées de l'app publique — widget, pages transactionnelles
 * (confirm/unsubscribe/preferences), centre de préférences, cookie banner, et labels de finalités.
 *
 * Motivé par le kit de conformité Example Media : les surfaces doivent être dans la LANGUE LOCALE du marché.
 * Le TEXTE LÉGAL de consentement vient de la DB (`consent_version`) ; ici = uniquement le chrome UI.
 * 6 locales : en (base), pt-BR, es, fr, de, it (de+it requis pour les marchés granulaires DE/IT).
 */
import type { ConsentPurpose } from "@nf/config";

export type Locale = "en" | "pt-BR" | "es" | "fr" | "de" | "it";

export const LOCALES: Locale[] = ["en", "pt-BR", "es", "fr", "de", "it"];

/** Normalise une langue d'édition (pt, PT-BR, es-CL, de-DE, it…) vers une locale servie. */
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

export interface Dict {
  // Labels de finalités (kit) — partagés widget + centre de préférences
  purpose: Record<ConsentPurpose, string>;
  // Widget
  w: {
    heading: (b: string) => string;
    sub: string;
    firstName: string;
    optional: string;
    required: string;
    email: string;
    emailPlaceholder: string;
    purposesLabel: string; // "Que veux-tu recevoir ?"
    tracking: string;
    submit: string;
    note: string;
    doneTitle: string;
    doneBody: (b: string) => string;
    alreadyTitle: string;
    alreadyBody: (b: string) => string;
    errors: Record<string, string>;
    errorGeneric: string;
    errorNetwork: string;
  };
  // Centre de préférences + pages
  p: {
    title: string;
    invalidTitle: string;
    invalidBody: string;
    noSubs: string;
    active: string;
    paused: string;
    myRights: string;
    export: string;
    exportHint: string;
    unsubAll: string;
    erase: string;
    eraseHint: string;
    eraseWarn: string;
    eraseConfirm: string;
    cancel: string;
    erasedTitle: string;
    erasedBody: string;
    noticeReactivated: string;
    noticePaused: string;
    noticeUnsubAll: string;
    noticeExported: string;
    noticeError: string;
  };
  // Page de confirmation (double opt-in)
  c: {
    invalidTitle: string;
    invalidBody: string;
    incompleteBody: string;
    expiredTitle: string;
    expiredBody: string;
    alreadyTitle: string;
    alreadyBody: (b: string) => string;
    doneTitle: string;
    doneBody: (b: string) => string;
    notFound: string;
    /**
     * ⛔ LA PAGE NE CONFIRME PLUS AU RENDU (24/09/2026). Elle DEMANDE. Ces quatre chaînes sont l'écran
     * qui attend le clic : un antivirus ou un aperçu qui pré-charge le lien voit une question, pas
     * un double opt-in accompli en son nom.
     */
    confirmTitle: string;
    confirmBody: (b: string) => string;
    confirmCta: string;
    failed: string;
  };
  // Page de désinscription
  u: {
    invalidTitle: string;
    invalidBody: string;
    notFound: string;
    doneTitle: string;
    doneBody: (b: string) => string;
    managePrefs: string;
    /**
     * ⛔ LA PAGE NE DÉSABONNE PLUS AU RENDU. Elle DEMANDE. Ces quatre chaînes sont l'écran de
     * confirmation qui remplace l'écriture sur GET : un préchargeur ou un antivirus de messagerie
     * qui suit le lien voit désormais une question, pas un désabonnement accompli.
     */
    confirmTitle: string;
    confirmBody: (b: string) => string;
    confirmCta: string;
    failed: string;
  };
  /**
   * OBJETS D'E-MAIL. Ils vivaient EN DUR EN FRANÇAIS dans les deux chemins qui mettent en file
   * (`signup/route.ts`, `confirm/page.tsx`) alors que cette table couvrait déjà six locales :
   * les PAGES étaient traduites, les OBJETS non. Mesuré le 15/09/2026 — les quatre souscriptions
   * Copper Kettle en attente portent `language = 'es'` et un objet « Confirme ton inscription ».
   *
   * ⛔ UN OBJET EST FIGÉ À LA MISE EN FILE, pas au rendu. `email_outbox.subject` est écrit une fois
   * et le worker le sert tel quel : corriger ces chaînes ne répare donc AUCUNE ligne déjà en
   * attente. Toute correction de copie ici doit s'accompagner d'une décision sur les lignes
   * `pending` existantes.
   *
   * ⚠️ La forme « Texte — Marque » est délibérée pour le bienvenue, au lieu de « Bienvenue chez X ».
   * Les marques sont des noms propres de genre et de nombre imprévisibles (Copper Kettle, Northwind Sports,
   * Atlas Review) : « Boas-vindas à Northwind Sports » impose un article féminin qui sera faux une fois sur
   * deux. Le tiret ne suppose rien. Même raison pour n'employer aucune forme qui genre le LECTEUR.
   */
  m: {
    confirmSubject: (b: string) => string;
    welcomeSubject: (b: string) => string;
    /**
     * L'accusé de désinscription (22/09/2026). ⛔ MOT POUR MOT l'objet que le worker se donne quand
     * aucun modèle n'est rattaché (`${unsub_ack_title} — ${marque}`, `packages/email/src/i18n.ts`) :
     * cet objet-ci ne sert que quand un modèle rattaché n'a pas le sien, et la même personne ne doit
     * pas lire deux formules selon que la marque a personnalisé l'e-mail ou non. Un banc les compare.
     */
    unsubAckSubject: (b: string) => string;
  };
  // Cookie banner (dormant tant que nos surfaces sont cookie-free)
  cookie: {
    text: string;
    policy: string;
    acceptAll: string;
    reject: string;
    preferences: string;
    essential: string;
    essentialNote: string;
    save: string;
  };
}

const en: Dict = {
  purpose: { content: "Newsletter & content", offers: "Offers & promotions", events: "Events & invitations", partners: "Offers from selected partners" },
  w: {
    heading: (b) => `Get the ${b} newsletter`, sub: "Our best content, straight to your inbox.",
    firstName: "First name", optional: "(optional)", required: "(required)", email: "Email", emailPlaceholder: "you@example.com",
    purposesLabel: "What would you like to receive?", tracking: "I agree to open and click tracking to improve content",
    submit: "Subscribe", note: "Double email confirmation · unsubscribe in 1 click anytime.",
    doneTitle: "Almost there!", doneBody: (b) => `We've sent you a confirmation email. Click the link to confirm your subscription to ${b}.`,
    alreadyTitle: "You're already subscribed ✅", alreadyBody: (b) => `You already receive the ${b} newsletter.`,
    errors: { "email-invalide": "This email doesn't look valid.", "consentement-requis": "Tick “Newsletter & content” to subscribe.", "marque-inconnue": "Invalid configuration.", "form-expire": "The form expired. Reload the page and try again.", "trop-de-tentatives": "Too many attempts. Please wait a while and try again." },
    errorGeneric: "Something went wrong. Please try again.", errorNetwork: "Couldn't reach the server.",
  },
  p: {
    title: "My preferences", invalidTitle: "Invalid link", invalidBody: "This preferences link isn't valid or has expired.",
    noSubs: "No active subscriptions.", active: "Active", paused: "Paused", myRights: "My rights",
    export: "Export my data", exportHint: "(right of access)", unsubAll: "Unsubscribe from all brands",
    erase: "Delete my data", eraseHint: "(right to be forgotten)", eraseWarn: "This action is permanent. All your data will be erased.",
    eraseConfirm: "Confirm deletion", cancel: "Cancel", erasedTitle: "Data deleted",
    erasedBody: "Your personal data has been erased from our newsletters. You will no longer receive any email. Proof of consent is kept anonymized, as required by law.",
    noticeReactivated: "Preference updated.", noticePaused: "Preference updated.", noticeUnsubAll: "You are unsubscribed from all brands.",
    noticeExported: "Export downloaded.", noticeError: "Something went wrong.",
  },
  c: {
    invalidTitle: "Invalid link", invalidBody: "This confirmation link is incomplete.", incompleteBody: "This link isn't recognized.",
    expiredTitle: "Link expired", expiredBody: "This link has expired. Sign up again to get a new one.",
    alreadyTitle: "Already confirmed ✅", alreadyBody: (b) => `Your subscription to ${b} is already active.`,
    doneTitle: "Subscription confirmed 🎉", doneBody: (b) => `Thanks! You're now subscribed to ${b}. You'll receive our next content by email.`,
    notFound: "Subscription not found.",
    confirmTitle: "One last step", confirmBody: (b) => `Click the button below to confirm your subscription to ${b}.`,
    confirmCta: "Confirm my subscription", failed: "That didn't go through. Please try again.",
  },
  u: {
    invalidTitle: "Invalid link", invalidBody: "This unsubscribe link isn't valid.", notFound: "Subscription not found.",
    doneTitle: "Unsubscribe confirmed", doneBody: (b) => `You will no longer receive emails from ${b}. You can re-subscribe at any time.`,
    managePrefs: "Manage all my preferences or delete my data",
    confirmTitle: "Unsubscribe?", confirmBody: (b) => `You are about to stop receiving emails from ${b}.`,
    confirmCta: "Yes, unsubscribe", failed: "That didn't go through. Please try again.",
  },
  m: {
    confirmSubject: (b) => `Confirm your subscription — ${b}`,
    welcomeSubject: (b) => `Welcome — ${b} 👋`,
    unsubAckSubject: (b) => `Unsubscribe confirmed — ${b}`,
  },
  cookie: {
    text: "We use cookies to improve your experience and measure the performance of our newsletter and website. You can accept all, reject non-essential, or manage preferences.",
    policy: "Cookie Policy", acceptAll: "Accept all", reject: "Reject", preferences: "Preferences",
    essential: "Essential (always on)", essentialNote: "Required for the site to work.", save: "Save choices",
  },
};

const ptBR: Dict = {
  purpose: { content: "Newsletter e conteúdos", offers: "Ofertas e promoções", events: "Eventos e convites", partners: "Ofertas de parceiros selecionados" },
  w: {
    heading: (b) => `Receba a newsletter ${b}`, sub: "Nossos melhores conteúdos, direto no seu e-mail.",
    firstName: "Nome", optional: "(opcional)", required: "(obrigatório)", email: "E-mail", emailPlaceholder: "voce@exemplo.com",
    purposesLabel: "O que você quer receber?", tracking: "Aceito o rastreamento de aberturas e cliques para melhorar o conteúdo",
    submit: "Inscrever-se", note: "Dupla confirmação por e-mail · cancele em 1 clique quando quiser.",
    doneTitle: "Quase lá!", doneBody: (b) => `Enviamos um e-mail de confirmação. Clique no link para confirmar sua inscrição na ${b}.`,
    alreadyTitle: "Você já está inscrito ✅", alreadyBody: (b) => `Você já recebe a newsletter ${b}.`,
    errors: { "email-invalide": "Este e-mail não parece válido.", "consentement-requis": "Marque “Newsletter e conteúdos” para se inscrever.", "marque-inconnue": "Configuração inválida.", "form-expire": "O formulário expirou. Recarregue a página e tente de novo.", "trop-de-tentatives": "Muitas tentativas. Aguarde um pouco e tente de novo." },
    errorGeneric: "Ocorreu um erro. Tente novamente.", errorNetwork: "Não foi possível contatar o servidor.",
  },
  p: {
    title: "Minhas preferências", invalidTitle: "Link inválido", invalidBody: "Este link de preferências não é válido ou expirou.",
    noSubs: "Nenhuma inscrição ativa.", active: "Ativo", paused: "Pausado", myRights: "Meus direitos",
    export: "Exportar meus dados", exportHint: "(direito de acesso)", unsubAll: "Cancelar todas as marcas",
    erase: "Excluir meus dados", eraseHint: "(direito ao esquecimento)", eraseWarn: "Esta ação é definitiva. Todos os seus dados serão apagados.",
    eraseConfirm: "Confirmar exclusão", cancel: "Cancelar", erasedTitle: "Dados excluídos",
    erasedBody: "Seus dados pessoais foram apagados das nossas newsletters. Você não receberá mais nenhum e-mail. A prova de consentimento é mantida de forma anonimizada, como exige a lei.",
    noticeReactivated: "Preferência atualizada.", noticePaused: "Preferência atualizada.", noticeUnsubAll: "Você foi cancelado de todas as marcas.",
    noticeExported: "Exportação baixada.", noticeError: "Ocorreu um erro.",
  },
  c: {
    invalidTitle: "Link inválido", invalidBody: "Este link de confirmação está incompleto.", incompleteBody: "Este link não é reconhecido.",
    expiredTitle: "Link expirado", expiredBody: "Este link expirou. Inscreva-se novamente para receber outro.",
    alreadyTitle: "Já confirmado ✅", alreadyBody: (b) => `Sua inscrição na ${b} já está ativa.`,
    doneTitle: "Inscrição confirmada 🎉", doneBody: (b) => `Obrigado! Você agora está inscrito na ${b}. Você receberá nossos próximos conteúdos por e-mail.`,
    notFound: "Inscrição não encontrada.",
    confirmTitle: "Falta só um passo", confirmBody: (b) => `Clique no botão abaixo para confirmar sua inscrição na ${b}.`,
    confirmCta: "Confirmar minha inscrição", failed: "Não foi possível concluir. Tente novamente.",
  },
  u: {
    invalidTitle: "Link inválido", invalidBody: "Este link de cancelamento não é válido.", notFound: "Inscrição não encontrada.",
    doneTitle: "Cancelamento confirmado", doneBody: (b) => `Você não receberá mais e-mails da ${b}. Você pode se inscrever novamente quando quiser.`,
    managePrefs: "Gerenciar todas as minhas preferências ou excluir meus dados",
    confirmTitle: "Cancelar inscrição?", confirmBody: (b) => `Você está prestes a parar de receber e-mails da ${b}.`,
    confirmCta: "Sim, cancelar inscrição", failed: "Não foi possível concluir. Tente novamente.",
  },
  m: {
    confirmSubject: (b) => `Confirme sua inscrição — ${b}`,
    welcomeSubject: (b) => `Boas-vindas — ${b} 👋`,
    unsubAckSubject: (b) => `Cancelamento confirmado — ${b}`,
  },
  cookie: {
    text: "Usamos cookies para melhorar sua experiência e medir o desempenho da nossa newsletter e do site. Você pode aceitar todos, rejeitar os não essenciais ou gerenciar preferências.",
    policy: "Política de Cookies", acceptAll: "Aceitar todos", reject: "Rejeitar", preferences: "Preferências",
    essential: "Essenciais (sempre ativos)", essentialNote: "Necessários para o site funcionar.", save: "Salvar escolhas",
  },
};

const es: Dict = {
  purpose: { content: "Boletín y contenidos", offers: "Ofertas y promociones", events: "Eventos e invitaciones", partners: "Ofertas de socios seleccionados" },
  w: {
    heading: (b) => `Recibe el boletín de ${b}`, sub: "Nuestros mejores contenidos, directo en tu correo.",
    firstName: "Nombre", optional: "(opcional)", required: "(obligatorio)", email: "Correo", emailPlaceholder: "tu@ejemplo.com",
    purposesLabel: "¿Qué quieres recibir?", tracking: "Acepto el seguimiento de aperturas y clics para mejorar el contenido",
    submit: "Suscribirse", note: "Doble confirmación por correo · date de baja en 1 clic cuando quieras.",
    doneTitle: "¡Casi listo!", doneBody: (b) => `Te enviamos un correo de confirmación. Haz clic en el enlace para confirmar tu suscripción a ${b}.`,
    alreadyTitle: "Ya estás suscrito ✅", alreadyBody: (b) => `Ya recibes el boletín de ${b}.`,
    errors: { "email-invalide": "Este correo no parece válido.", "consentement-requis": "Marca “Boletín y contenidos” para suscribirte.", "marque-inconnue": "Configuración inválida.", "form-expire": "El formulario caducó. Recarga la página e inténtalo de nuevo.", "trop-de-tentatives": "Demasiados intentos. Espera un momento e inténtalo de nuevo." },
    errorGeneric: "Ocurrió un error. Inténtalo de nuevo.", errorNetwork: "No se pudo contactar con el servidor.",
  },
  p: {
    title: "Mis preferencias", invalidTitle: "Enlace inválido", invalidBody: "Este enlace de preferencias no es válido o ha caducado.",
    noSubs: "Sin suscripciones activas.", active: "Activo", paused: "Pausado", myRights: "Mis derechos",
    export: "Exportar mis datos", exportHint: "(derecho de acceso)", unsubAll: "Darme de baja de todas las marcas",
    erase: "Eliminar mis datos", eraseHint: "(derecho al olvido)", eraseWarn: "Esta acción es definitiva. Se eliminarán todos tus datos.",
    eraseConfirm: "Confirmar eliminación", cancel: "Cancelar", erasedTitle: "Datos eliminados",
    erasedBody: "Tus datos personales se han eliminado de nuestros boletines. Ya no recibirás ningún correo. La prueba de consentimiento se conserva de forma anonimizada, como exige la ley.",
    noticeReactivated: "Preferencia actualizada.", noticePaused: "Preferencia actualizada.", noticeUnsubAll: "Te has dado de baja de todas las marcas.",
    noticeExported: "Exportación descargada.", noticeError: "Ocurrió un error.",
  },
  c: {
    invalidTitle: "Enlace inválido", invalidBody: "Este enlace de confirmación está incompleto.", incompleteBody: "Este enlace no se reconoce.",
    expiredTitle: "Enlace caducado", expiredBody: "Este enlace ha caducado. Vuelve a suscribirte para recibir otro.",
    alreadyTitle: "Ya confirmado ✅", alreadyBody: (b) => `Tu suscripción a ${b} ya está activa.`,
    doneTitle: "Suscripción confirmada 🎉", doneBody: (b) => `¡Gracias! Ahora estás suscrito a ${b}. Recibirás nuestros próximos contenidos por correo.`,
    notFound: "Suscripción no encontrada.",
    confirmTitle: "Un último paso", confirmBody: (b) => `Haz clic en el botón para confirmar tu suscripción a ${b}.`,
    confirmCta: "Confirmar mi suscripción", failed: "No se pudo completar. Inténtalo de nuevo.",
  },
  u: {
    invalidTitle: "Enlace inválido", invalidBody: "Este enlace de baja no es válido.", notFound: "Suscripción no encontrada.",
    doneTitle: "Baja confirmada", doneBody: (b) => `Ya no recibirás correos de ${b}. Puedes volver a suscribirte cuando quieras.`,
    managePrefs: "Gestionar todas mis preferencias o eliminar mis datos",
    confirmTitle: "¿Cancelar la suscripción?", confirmBody: (b) => `Estás a punto de dejar de recibir correos de ${b}.`,
    confirmCta: "Sí, cancelar la suscripción", failed: "No se pudo completar. Inténtalo de nuevo.",
  },
  m: {
    confirmSubject: (b) => `Confirma tu suscripción — ${b}`,
    welcomeSubject: (b) => `Te damos la bienvenida — ${b} 👋`,
    unsubAckSubject: (b) => `Baja confirmada — ${b}`,
  },
  cookie: {
    text: "Usamos cookies para mejorar tu experiencia y medir el rendimiento de nuestro boletín y sitio. Puedes aceptar todas, rechazar las no esenciales o gestionar preferencias.",
    policy: "Política de Cookies", acceptAll: "Aceptar todas", reject: "Rechazar", preferences: "Preferencias",
    essential: "Esenciales (siempre activas)", essentialNote: "Necesarias para que el sitio funcione.", save: "Guardar opciones",
  },
};

const fr: Dict = {
  purpose: { content: "Newsletter et contenus", offers: "Offres et promotions", events: "Événements et invitations", partners: "Offres de partenaires sélectionnés" },
  w: {
    heading: (b) => `Reçois la newsletter ${b}`, sub: "Nos meilleurs contenus, directement dans ta boîte mail.",
    firstName: "Prénom", optional: "(optionnel)", required: "(requis)", email: "E-mail", emailPlaceholder: "toi@exemple.com",
    purposesLabel: "Que veux-tu recevoir ?", tracking: "J'accepte le suivi des ouvertures et des clics pour améliorer le contenu",
    submit: "S'inscrire", note: "Double confirmation par e-mail · désinscription en 1 clic à tout moment.",
    doneTitle: "Presque terminé !", doneBody: (b) => `On t'a envoyé un e-mail de confirmation. Clique sur le lien pour valider ton inscription à ${b}.`,
    alreadyTitle: "Tu es déjà inscrit·e ✅", alreadyBody: (b) => `Tu reçois déjà la newsletter ${b}.`,
    errors: { "email-invalide": "Cet e-mail ne semble pas valide.", "consentement-requis": "Coche « Newsletter et contenus » pour t'inscrire.", "marque-inconnue": "Configuration invalide.", "form-expire": "Le formulaire a expiré. Recharge la page et réessaie.", "trop-de-tentatives": "Trop de tentatives. Patiente un moment et réessaie." },
    errorGeneric: "Une erreur est survenue. Réessaie.", errorNetwork: "Impossible de contacter le serveur.",
  },
  p: {
    title: "Mes préférences", invalidTitle: "Lien invalide", invalidBody: "Ce lien de gestion des préférences n'est pas valide ou a expiré.",
    noSubs: "Aucun abonnement actif.", active: "Actif", paused: "En pause", myRights: "Mes droits",
    export: "Exporter mes données", exportHint: "(droit d'accès)", unsubAll: "Me désinscrire de toutes les marques",
    erase: "Supprimer mes données", eraseHint: "(droit à l'oubli)", eraseWarn: "Cette action est définitive. Toutes tes données seront effacées.",
    eraseConfirm: "Confirmer la suppression", cancel: "Annuler", erasedTitle: "Données supprimées",
    erasedBody: "Tes données personnelles ont été effacées de nos newsletters. Tu ne recevras plus aucun email. La preuve de consentement est conservée de façon anonymisée, comme l'exige la loi.",
    noticeReactivated: "Préférence mise à jour.", noticePaused: "Préférence mise à jour.", noticeUnsubAll: "Tu es désinscrit·e de toutes les marques.",
    noticeExported: "Export téléchargé.", noticeError: "Une erreur est survenue.",
  },
  c: {
    invalidTitle: "Lien invalide", invalidBody: "Ce lien de confirmation est incomplet.", incompleteBody: "Ce lien n'est pas reconnu.",
    expiredTitle: "Lien expiré", expiredBody: "Ce lien a expiré. Réinscris-toi pour en recevoir un nouveau.",
    alreadyTitle: "Déjà confirmé ✅", alreadyBody: (b) => `Ton inscription à ${b} est déjà active.`,
    doneTitle: "Inscription confirmée 🎉", doneBody: (b) => `Merci ! Tu es maintenant abonné·e à ${b}. Tu recevras nos prochains contenus par e-mail.`,
    notFound: "Inscription introuvable.",
    confirmTitle: "Une dernière étape", confirmBody: (b) => `Clique sur le bouton ci-dessous pour confirmer ton inscription à ${b}.`,
    confirmCta: "Confirmer mon inscription", failed: "L'opération n'a pas abouti. Réessaie.",
  },
  u: {
    invalidTitle: "Lien invalide", invalidBody: "Ce lien de désinscription n'est pas valide.", notFound: "Inscription introuvable.",
    doneTitle: "Désinscription confirmée", doneBody: (b) => `Tu ne recevras plus les e-mails de ${b}. Tu peux te réinscrire à tout moment.`,
    managePrefs: "Gérer toutes mes préférences ou supprimer mes données",
    confirmTitle: "Se désabonner ?", confirmBody: (b) => `Vous êtes sur le point de ne plus recevoir les e-mails de ${b}.`,
    confirmCta: "Oui, me désabonner", failed: "L'opération n'a pas abouti. Réessayez.",
  },
  m: {
    confirmSubject: (b) => `Confirme ton inscription — ${b}`,
    welcomeSubject: (b) => `Bienvenue — ${b} 👋`,
    unsubAckSubject: (b) => `Désinscription confirmée — ${b}`,
  },
  cookie: {
    text: "Nous utilisons des cookies pour améliorer votre expérience et mesurer la performance de notre newsletter et de notre site. Vous pouvez tout accepter, refuser les cookies non essentiels ou gérer vos préférences.",
    policy: "Politique cookies", acceptAll: "Tout accepter", reject: "Refuser", preferences: "Préférences",
    essential: "Essentiels (toujours actifs)", essentialNote: "Nécessaires au fonctionnement du site.", save: "Enregistrer",
  },
};

const de: Dict = {
  purpose: { content: "Newsletter und Inhalte", offers: "Angebote und Aktionen", events: "Veranstaltungen und Einladungen", partners: "Angebote ausgewählter Partner" },
  w: {
    heading: (b) => `${b}-Newsletter erhalten`, sub: "Unsere besten Inhalte, direkt in Ihr Postfach.",
    firstName: "Vorname", optional: "(optional)", required: "(erforderlich)", email: "E-Mail", emailPlaceholder: "sie@beispiel.de",
    purposesLabel: "Was möchten Sie erhalten?", tracking: "Ich stimme dem Öffnungs- und Klick-Tracking zur Verbesserung der Inhalte zu",
    submit: "Anmelden", note: "Double-Opt-in per E-Mail · Abmeldung jederzeit mit 1 Klick.",
    doneTitle: "Fast geschafft!", doneBody: (b) => `Wir haben Ihnen eine Bestätigungs-E-Mail gesendet. Klicken Sie auf den Link, um Ihre Anmeldung bei ${b} zu bestätigen.`,
    alreadyTitle: "Sie sind bereits angemeldet ✅", alreadyBody: (b) => `Sie erhalten den ${b}-Newsletter bereits.`,
    errors: { "email-invalide": "Diese E-Mail scheint ungültig zu sein.", "consentement-requis": "Wählen Sie „Newsletter und Inhalte“, um sich anzumelden.", "marque-inconnue": "Ungültige Konfiguration.", "form-expire": "Das Formular ist abgelaufen. Laden Sie die Seite neu und versuchen Sie es erneut.", "trop-de-tentatives": "Zu viele Versuche. Bitte warten Sie einen Moment und versuchen Sie es erneut." },
    errorGeneric: "Etwas ist schiefgelaufen. Bitte versuchen Sie es erneut.", errorNetwork: "Server nicht erreichbar.",
  },
  p: {
    title: "Meine Einstellungen", invalidTitle: "Ungültiger Link", invalidBody: "Dieser Einstellungslink ist ungültig oder abgelaufen.",
    noSubs: "Keine aktiven Abonnements.", active: "Aktiv", paused: "Pausiert", myRights: "Meine Rechte",
    export: "Meine Daten exportieren", exportHint: "(Auskunftsrecht)", unsubAll: "Von allen Marken abmelden",
    erase: "Meine Daten löschen", eraseHint: "(Recht auf Vergessenwerden)", eraseWarn: "Diese Aktion ist endgültig. Alle Ihre Daten werden gelöscht.",
    eraseConfirm: "Löschung bestätigen", cancel: "Abbrechen", erasedTitle: "Daten gelöscht",
    erasedBody: "Ihre personenbezogenen Daten wurden aus unseren Newslettern gelöscht. Sie erhalten keine E-Mails mehr. Der Einwilligungsnachweis wird anonymisiert aufbewahrt, wie es das Gesetz verlangt.",
    noticeReactivated: "Einstellung aktualisiert.", noticePaused: "Einstellung aktualisiert.", noticeUnsubAll: "Sie sind von allen Marken abgemeldet.",
    noticeExported: "Export heruntergeladen.", noticeError: "Etwas ist schiefgelaufen.",
  },
  c: {
    invalidTitle: "Ungültiger Link", invalidBody: "Dieser Bestätigungslink ist unvollständig.", incompleteBody: "Dieser Link wird nicht erkannt.",
    expiredTitle: "Link abgelaufen", expiredBody: "Dieser Link ist abgelaufen. Melden Sie sich erneut an, um einen neuen zu erhalten.",
    alreadyTitle: "Bereits bestätigt ✅", alreadyBody: (b) => `Ihre Anmeldung bei ${b} ist bereits aktiv.`,
    doneTitle: "Anmeldung bestätigt 🎉", doneBody: (b) => `Danke! Sie sind jetzt bei ${b} angemeldet. Sie erhalten unsere nächsten Inhalte per E-Mail.`,
    notFound: "Anmeldung nicht gefunden.",
    confirmTitle: "Nur noch ein Schritt", confirmBody: (b) => `Klicken Sie auf die Schaltfläche, um Ihre Anmeldung bei ${b} zu bestätigen.`,
    confirmCta: "Meine Anmeldung bestätigen", failed: "Das hat nicht geklappt. Bitte erneut versuchen.",
  },
  u: {
    invalidTitle: "Ungültiger Link", invalidBody: "Dieser Abmeldelink ist ungültig.", notFound: "Anmeldung nicht gefunden.",
    doneTitle: "Abmeldung bestätigt", doneBody: (b) => `Sie erhalten keine E-Mails mehr von ${b}. Sie können sich jederzeit erneut anmelden.`,
    managePrefs: "Alle meine Einstellungen verwalten oder meine Daten löschen",
    confirmTitle: "Abmelden?", confirmBody: (b) => `Sie erhalten künftig keine E-Mails mehr von ${b}.`,
    confirmCta: "Ja, abmelden", failed: "Das hat nicht geklappt. Bitte erneut versuchen.",
  },
  m: {
    confirmSubject: (b) => `Bestätigen Sie Ihre Anmeldung — ${b}`,
    welcomeSubject: (b) => `Willkommen — ${b} 👋`,
    unsubAckSubject: (b) => `Abmeldung bestätigt — ${b}`,
  },
  cookie: {
    text: "Wir verwenden Cookies, um Ihre Erfahrung zu verbessern und die Leistung unseres Newsletters und unserer Website zu messen. Sie können alle akzeptieren, nicht notwendige ablehnen oder Einstellungen verwalten.",
    policy: "Cookie-Richtlinie", acceptAll: "Alle akzeptieren", reject: "Ablehnen", preferences: "Einstellungen",
    essential: "Notwendig (immer aktiv)", essentialNote: "Erforderlich für den Betrieb der Website.", save: "Auswahl speichern",
  },
};

const it: Dict = {
  purpose: { content: "Newsletter e contenuti", offers: "Offerte e promozioni", events: "Eventi e inviti", partners: "Offerte di partner selezionati" },
  w: {
    heading: (b) => `Ricevi la newsletter ${b}`, sub: "I nostri migliori contenuti, direttamente nella tua casella.",
    firstName: "Nome", optional: "(facoltativo)", required: "(obbligatorio)", email: "E-mail", emailPlaceholder: "tu@esempio.it",
    purposesLabel: "Cosa vuoi ricevere?", tracking: "Accetto il tracciamento di aperture e clic per migliorare i contenuti",
    submit: "Iscriviti", note: "Doppia conferma via e-mail · disiscrizione in 1 clic quando vuoi.",
    doneTitle: "Ci siamo quasi!", doneBody: (b) => `Ti abbiamo inviato un'e-mail di conferma. Clicca sul link per confermare la tua iscrizione a ${b}.`,
    alreadyTitle: "Sei già iscritto ✅", alreadyBody: (b) => `Ricevi già la newsletter ${b}.`,
    errors: { "email-invalide": "Questa e-mail non sembra valida.", "consentement-requis": "Seleziona “Newsletter e contenuti” per iscriverti.", "marque-inconnue": "Configurazione non valida.", "form-expire": "Il modulo è scaduto. Ricarica la pagina e riprova.", "trop-de-tentatives": "Troppi tentativi. Attendi un momento e riprova." },
    errorGeneric: "Si è verificato un errore. Riprova.", errorNetwork: "Impossibile contattare il server.",
  },
  p: {
    title: "Le mie preferenze", invalidTitle: "Link non valido", invalidBody: "Questo link delle preferenze non è valido o è scaduto.",
    noSubs: "Nessuna iscrizione attiva.", active: "Attivo", paused: "In pausa", myRights: "I miei diritti",
    export: "Esporta i miei dati", exportHint: "(diritto di accesso)", unsubAll: "Disiscrivimi da tutti i marchi",
    erase: "Elimina i miei dati", eraseHint: "(diritto all'oblio)", eraseWarn: "Questa azione è definitiva. Tutti i tuoi dati saranno cancellati.",
    eraseConfirm: "Conferma eliminazione", cancel: "Annulla", erasedTitle: "Dati eliminati",
    erasedBody: "I tuoi dati personali sono stati cancellati dalle nostre newsletter. Non riceverai più alcuna e-mail. La prova del consenso è conservata in forma anonimizzata, come richiede la legge.",
    noticeReactivated: "Preferenza aggiornata.", noticePaused: "Preferenza aggiornata.", noticeUnsubAll: "Sei disiscritto da tutti i marchi.",
    noticeExported: "Esportazione scaricata.", noticeError: "Si è verificato un errore.",
  },
  c: {
    invalidTitle: "Link non valido", invalidBody: "Questo link di conferma è incompleto.", incompleteBody: "Questo link non è riconosciuto.",
    expiredTitle: "Link scaduto", expiredBody: "Questo link è scaduto. Iscriviti di nuovo per riceverne uno nuovo.",
    alreadyTitle: "Già confermato ✅", alreadyBody: (b) => `La tua iscrizione a ${b} è già attiva.`,
    doneTitle: "Iscrizione confermata 🎉", doneBody: (b) => `Grazie! Ora sei iscritto a ${b}. Riceverai i nostri prossimi contenuti via e-mail.`,
    notFound: "Iscrizione non trovata.",
    confirmTitle: "Ultimo passaggio", confirmBody: (b) => `Clicca sul pulsante qui sotto per confermare la tua iscrizione a ${b}.`,
    confirmCta: "Conferma la mia iscrizione", failed: "Operazione non riuscita. Riprova.",
  },
  u: {
    invalidTitle: "Link non valido", invalidBody: "Questo link di disiscrizione non è valido.", notFound: "Iscrizione non trovata.",
    doneTitle: "Disiscrizione confermata", doneBody: (b) => `Non riceverai più e-mail da ${b}. Puoi iscriverti di nuovo quando vuoi.`,
    managePrefs: "Gestisci tutte le mie preferenze o elimina i miei dati",
    confirmTitle: "Disiscriversi?", confirmBody: (b) => `Stai per smettere di ricevere le email di ${b}.`,
    confirmCta: "Sì, disiscrivimi", failed: "Operazione non riuscita. Riprova.",
  },
  m: {
    confirmSubject: (b) => `Conferma la tua iscrizione — ${b}`,
    welcomeSubject: (b) => `Ti diamo il benvenuto — ${b} 👋`,
    unsubAckSubject: (b) => `Disiscrizione confermata — ${b}`,
  },
  cookie: {
    text: "Utilizziamo i cookie per migliorare la tua esperienza e misurare le prestazioni della newsletter e del sito. Puoi accettare tutti, rifiutare quelli non essenziali o gestire le preferenze.",
    policy: "Cookie Policy", acceptAll: "Accetta tutti", reject: "Rifiuta", preferences: "Preferenze",
    essential: "Essenziali (sempre attivi)", essentialNote: "Necessari al funzionamento del sito.", save: "Salva scelte",
  },
};

const DICT: Record<Locale, Dict> = { en, "pt-BR": ptBR, es, fr, de, it };

export function dict(locale: Locale): Dict {
  return DICT[locale] ?? en;
}
