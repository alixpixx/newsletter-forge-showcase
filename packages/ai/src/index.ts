/**
 * ---------------------------------------------------------------------------
 * @nf/ai — l'accès au modèle, au même endroit pour l'admin et pour le worker.
 * ---------------------------------------------------------------------------
 *
 * ⛔ POURQUOI CE PACKAGE EXISTE. Le client Claude vivait dans `apps/admin/src/lib/ai/`, où il
 * servait le générateur de templates. Le worker en a besoin à son tour (l'introduction et
 * l'accroche d'une édition se génèrent au GEL, dans le planificateur). Or un `import` qui remonte
 * hors du dossier déployé fonctionne en développement et **casse en production** : les plateformes
 * d'hébergement ne téléversent que le dossier de l'app. Le partage passe donc par un package du
 * workspace, jamais par un chemin relatif qui sort.
 *
 * ⛔ CE PACKAGE NE CONNAÎT NI LA BASE NI LE MÉTIER. Il parle à l'API Messages et rend du texte.
 * Ce qu'on lui demande, quand, et ce qu'on fait d'un échec, appartient à l'appelant — c'est ce qui
 * permet au worker de continuer un gel malgré un refus du modèle, et à l'admin de rendre une 502.
 */
export * from "./claude";
export * from "./newsletter-intro";
