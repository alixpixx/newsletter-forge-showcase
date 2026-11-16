-- ---------------------------------------------------------------------------
-- 0033 — `is_demo` tient enfin sa propre définition : le domaine réservé EST le critère.
-- ---------------------------------------------------------------------------
--
-- POURQUOI UNE MIGRATION NEUVE ET PAS UNE CORRECTION DE 0032. Le SQL de 0032 est APPLIQUÉ
-- (`nf_0032_fanout_guards`) : le rééditer ne changerait rien en base et ferait diverger le fichier
-- de ce qui tourne. Tout changement de comportement passe donc par ici. 0032 n'est retouchée que
-- dans ses COMMENTAIRES, pour ne plus décrire un critère qu'elle n'a plus.
--
-- LE DÉFAUT QU'ON FERME. 0032 a défini `is_demo` comme « contact fabriqué : adresse @example.com
-- non délivrable, aucune preuve de consentement, à exclure de tout envoi », puis a marqué non pas
-- les adresses @example.com mais celles du seed 0004 (`^demo[0-9]+@example\.com$`). La colonne ne
-- tenait donc pas sa définition, et l'écart n'était pas théorique — mesuré sur la base :
--   1 202 abonnés @example.com, dont 2 NON marqués : bridge-selftest-a@example.com et
--   bridge-selftest-b@example.com, chacun porteur d'une souscription `active` et chacun présent
--   dans `newsletter.sendable_subscription` (sendable = 1 par ligne, mesuré).
-- Le jour où le gate filtrera `not is_demo`, ces deux-là passeraient : deux rebonds durs sur un
-- domaine expéditeur en warm-up, produits par la garde même qui prétendait les arrêter.
--
-- ⛔ POURQUOI LE DOMAINE, ET PAS LA PROVENANCE. C'est `example.com` qui garantit la
-- non-délivrabilité — la RFC 2606 §3 réserve example.com / .net / .org pour la documentation, et
-- aucun MX n'y répondra jamais. La provenance, elle, ne se prouve pas : `bridge-selftest` n'existe
-- NULLE PART dans le dépôt (grep sur *.ts / *.tsx / *.sql : le seul résultat est le commentaire de
-- 0032 qui les invoque). 0032 les a exclues au nom d'une origine supposée ; on ne bâtit pas une
-- garde d'envoi sur une supposition. Le critère devient donc la garantie technique, pas l'histoire.
--
-- ⛔ CE QU'ON NE MARQUE PAS, ET POURQUOI. `erased***@deleted.invalid` reste `is_demo = false` :
-- c'est une VRAIE personne dont l'adresse a été effacée par une demande RGPD, pas un contact
-- fabriqué. Effacé n'est pas inventé, et la confusion ferait mentir la colonne dans l'autre sens.
-- Elle n'est de toute façon envoyable par personne : 0 souscription active, 0 ligne dans
-- `sendable_subscription` (mesuré).


-- ===========================================================================
-- 1 — RATTRAPAGE : la colonne rejoint sa définition.
-- ===========================================================================
--
-- ⚠️ INSENSIBLE À LA CASSE, ET CE N'EST PAS COSMÉTIQUE. `subscriber.email` est de type `citext`,
-- mais 0032 a écrit `email::text ~ ...` : le cast en `text` REND L'OPÉRATEUR SENSIBLE À LA CASSE.
-- Mesuré, pas déduit :
--   ('DEMO1@EXAMPLE.COM'::citext)::text ~ '^demo[0-9]+@example\.com$'  -->  false
--   ('DEMO1@EXAMPLE.COM'::citext)        ~ '^demo[0-9]+@example\.com$'  -->  true
-- Le cast neutralise donc la seule protection que le type apportait, et l'erreur pointe du mauvais
-- côté : `DEMO7@EXAMPLE.COM` serait resté `is_demo = false`, donc envoyable. Aucun abonné ne porte
-- de majuscule aujourd'hui (mesuré : 0), c'est précisément pour cela qu'on le ferme maintenant.
-- `lower(...)` est écrit explicitement : il dit ce qu'il fait quel que soit le type de la colonne,
-- là où l'insensibilité de citext se perd au premier cast que quelqu'un ajoutera.
update newsletter.subscriber
   set is_demo = true
 where lower(email::text) ~ '@([a-z0-9-]+\.)*example\.(com|net|org)$'
   and is_demo is distinct from true;

comment on column newsletter.subscriber.is_demo is
  'Contact non délivrable : adresse sur un domaine réservé RFC 2606 (example.com/.net/.org), donc aucun MX ne l''acceptera jamais — seed de démonstration, self-test ou fixture de recette. À exclure de tout envoi. Faux par défaut : un contact qui arrive par le formulaire public est réel jusqu''à preuve du contraire. Le critère est le DOMAINE, pas la provenance : voir la contrainte subscriber_reserved_domain_is_demo, qui empêche la colonne de re-diverger.';


-- ===========================================================================
-- 2 — LA RÈGLE, POUR QUE LE PROCHAIN SEED NE ROUVRE PAS LE TROU.
-- ===========================================================================
--
-- LE DÉFAUT. Le point 3 du « reste à câbler » de 0032 (« tout futur seed de démo doit poser
-- is_demo = true à l'insertion ») n'était protégé par RIEN : une insertion de `demo9999@example.com`
-- sans drapeau donne `is_demo = false` (témoin rejoué). C'est une discipline écrite, pas une garde,
-- et une discipline ne survit pas au premier agent pressé. La contrainte transforme la phrase en
-- règle : sur un domaine réservé, `is_demo = false` devient IMPOSSIBLE, à l'insertion comme à la
-- mise à jour.
--
-- ⚠️ CE QU'ELLE VA CASSER, ET C'EST VOULU. Une écriture de test sur @example.com qui omet le
-- drapeau sera REFUSÉE (23514) au lieu de créer un destinataire silencieusement envoyable. Le geste
-- est dans le commentaire de la contrainte : ajouter `is_demo => true`. Une garde qu'on peut
-- oublier ne garde rien.
--
-- Ordre non négociable : le rattrapage ci-dessus DOIT précéder — sans lui, `add constraint`
-- échouerait sur les 2 lignes bridge-selftest-*, ce qui est exactement la démonstration du défaut.
-- `drop ... if exists` puis `add` pour que le fichier se rejoue ; la contrainte est posée VALIDE,
-- un NOT VALID ne masquerait ici aucune dette (0 ligne en infraction après le rattrapage).
alter table newsletter.subscriber drop constraint if exists subscriber_reserved_domain_is_demo;
alter table newsletter.subscriber
  add constraint subscriber_reserved_domain_is_demo check (
    is_demo or lower(email::text) !~ '@([a-z0-9-]+\.)*example\.(com|net|org)$'
  );

comment on constraint subscriber_reserved_domain_is_demo on newsletter.subscriber is
  'Une adresse sur un domaine réservé RFC 2606 (example.com/.net/.org) ne peut pas être un contact réel : elle doit porter is_demo = true. Si cette contrainte vous refuse une écriture, le geste est d''ajouter is_demo = true à la ligne insérée — pas de retirer la contrainte.';


-- ---------------------------------------------------------------------------
-- CE QUI RESTE À CÂBLER — corrigé : 0032 envoyait au mauvais fichier et décrivait un geste plus
-- gros qu'il n'est.
-- ---------------------------------------------------------------------------
-- `is_demo` reste une ÉTIQUETTE : elle est maintenant JUSTE (1 202 lignes marquées, 0 échappée) et
-- INVIOLABLE (contrainte ci-dessus), mais elle n'exclut toujours personne. Rien dans `apps/` ni
-- `packages/` ne lit cette colonne (grep : zéro occurrence).
--
--   1. LE POINT DE PASSAGE, avec la BONNE référence. La définition VIVANTE de
--      `newsletter.sendable_subscription` ne vient PAS de 0009 (comme l'écrivait 0032) mais de
--      `0015_consent_views.sql`, qui l'a recréée pour exposer les colonnes de 0013-0014 — vérifié
--      par `pg_get_viewdef` : la vue rend `granted_purposes` et `tracking_consent`, absentes du
--      catalogue au moment de 0009. Un dev qui suit l'ancienne référence édite un fichier supplanté.
--      ⛔ Et de toute façon on n'édite NI 0009 NI 0015 : ils sont appliqués. On lit 0015 comme
--      source de vérité, et on écrit un `create or replace view` dans une migration NEUVE.
--   2. LE GESTE EST PLUS PETIT QU'ANNONCÉ : la vue JOINT DÉJÀ `newsletter.subscriber sub` — elle en
--      a besoin pour `is_suppressed(sub.email, s.asset_id)`. Il n'y a AUCUNE jointure à ajouter,
--      seulement un prédicat de plus dans le WHERE existant : `and not sub.is_demo`.
--   3. CE QUE CE PRÉDICAT FERA, CHIFFRÉ AVANT DE L'ÉCRIRE : `sendable_subscription` rend
--      aujourd'hui 1 058 lignes, et les 1 058 sont désormais marquées `is_demo` (1 056 du seed 0004
--      + 2 bridge-selftest). Le filtre la fera donc tomber à ZÉRO. Ce n'est pas une régression :
--      cette base ne contient AUCUN destinataire réel envoyable. Un écran qui affichera « 0 » dira
--      la vérité pour la première fois.
--   4. Les compteurs d'audience de l'admin doivent distinguer démos et réels, sinon un opérateur
--      lira « 1 056 destinataires » et croira à une audience.

notify pgrst, 'reload schema';
