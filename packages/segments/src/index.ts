/**
 * ---------------------------------------------------------------------------
 * @nf/segments — une règle de ciblage, une seule implémentation.
 * ---------------------------------------------------------------------------
 *
 * POURQUOI CE PACKAGE EXISTE. Le compilateur de règles vivait dans `apps/admin`, où il servait à
 * COMPTER une audience. Le fan-out, lui, tourne dans `apps/worker` et doit ÉNUMÉRER exactement la
 * même audience. Deux implémentations de la même règle, c'est la garantie qu'un jour l'écran
 * annonce 4 210 destinataires et que 4 190 messages partent — sans que rien ne signale l'écart,
 * puisque chaque moitié est cohérente avec elle-même. Ce qu'on compte et ce qu'on envoie doivent
 * venir du MÊME code, ou le compte n'est qu'une opinion.
 *
 * ⛔ CE PACKAGE NE CONNAÎT NI LA BASE NI LE CONSENTEMENT. Il produit une expression de filtre
 * PostgREST, rien d'autre. La barrière d'envoi (abonnement actif, hors suppression, contact non
 * fictif) est la vue `newsletter.sendable_subscription`, et le gate par finalité est appliqué
 * par-dessus : le ciblage est une commodité, le consentement est une barrière. Un package qui
 * saurait « qui a le droit de recevoir » finirait par se faire contourner par un chemin pressé.
 *
 * ⚠️ IL NE DÉPEND DE RIEN — ni React, ni Next, ni supabase-js. C'est ce qui lui permet d'être
 * importé par un worker Bun aussi bien que par un composant client.
 */
export * from "./fields";
export * from "./compile";
