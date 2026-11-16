-- ---------------------------------------------------------------------------
-- 0032 — Les trois gardes qui doivent exister AVANT la première ligne de fan-out.
-- ---------------------------------------------------------------------------
--
-- POURQUOI MAINTENANT, ET PAS QUAND LE FAN-OUT SERA ÉCRIT.
--
-- Les trois défauts ci-dessous sont aujourd'hui INOFFENSIFS : la file `email_outbox` contient
-- 4 lignes transactionnelles (2 confirmations, 2 welcome), aucune ligne de campagne, et le worker
-- tourne en `dry-run`/`sandbox`. Chacun devient irréparable à la première campagne réelle :
--   — une contrainte d'unicité posée APRÈS le fan-out échoue sur les doublons déjà créés ;
--   — une ligne de campagne sans finalité a déjà été envoyée quand on s'en aperçoit ;
--   — une vraie adresse mêlée aux 1 200 démos ne se distingue plus des faux.
-- Une garde ne se pose que dans la fenêtre où elle ne coûte rien. C'est cette fenêtre.
--
-- ⚠️ Cette migration ne modifie AUCUN comportement d'envoi : elle n'arme rien, ne débloque rien,
-- et laisse `WORKER_MODE` intact. Elle rend seulement impossibles trois écritures fautives.


-- ===========================================================================
-- GARDE 1 — Le fan-out devient rejouable : une occurrence, un abonnement, un e-mail.
-- ===========================================================================
--
-- LE DÉFAUT. Un fan-out qui insère 1 200 lignes n'est pas atomique en pratique : il est découpé
-- en lots, il peut mourir au lot 7 sur 12 (timeout de la plateforme, coupure réseau, OOM). La reprise
-- rejoue alors depuis le début — et sans unicité en base, les 6 premiers lots partent une
-- SECONDE fois. Le défaut ne se voit dans aucun journal : les deux insertions sont valides, le
-- worker les envoie toutes les deux, et c'est le lecteur qui découvre le doublon.
--
-- ⛔ INVARIANT DE CALENDRIER : cet index doit exister AVANT la première ligne de fan-out.
-- Posé après, `create unique index` échoue sur les doublons déjà présents, et on se retrouve à
-- devoir arbitrer à la main quelles lignes supprimer d'une file dont une partie est déjà partie.
--
-- POURQUOI UN INDEX PARTIEL PLUTÔT QU'UN UNIQUE CLASSIQUE. `occurrence_id` est nul pour tout ce
-- qui n'est pas une campagne de série : confirmations, welcome, unsubscribe_ack, tests. On veut
-- que ces lignes-là restent libres de se répéter (un abonné peut légitimement recevoir deux
-- confirmations). Un `unique (occurrence_id, subscription_id)` classique le permettrait déjà —
-- PostgreSQL 17.6 traite chaque NULL comme distinct, vérifié sur cette base et non supposé — mais
-- il le permettrait par EFFET DE BORD d'une règle SQL subtile, pas par intention écrite. Le
-- prédicat dit ce que l'index protège, et il ne charge pas l'index des lignes transactionnelles.
--
-- ⚠️ TROU RÉSIDUEL, ASSUMÉ ET NOMMÉ : une ligne de campagne dont `subscription_id` serait nul
-- n'est couverte par AUCUNE unicité (même règle des NULL distincts). Le fan-out DOIT donc
-- toujours renseigner `subscription_id` — c'est lui qui porte l'abonnement, la finalité accordée
-- et le lien de désinscription ; une ligne de campagne sans abonnement est déjà une anomalie.
create unique index if not exists uq_outbox_occurrence_subscription
  on newsletter.email_outbox (occurrence_id, subscription_id)
  where occurrence_id is not null and subscription_id is not null;

comment on index newsletter.uq_outbox_occurrence_subscription is
  'Rend le fan-out rejouable après un crash : une occurrence ne peut produire qu''une ligne par abonnement. Partiel car occurrence_id est nul hors campagne de série (confirmations, welcome, tests), lignes qui doivent rester répétables.';


-- ===========================================================================
-- GARDE 2 — Une ligne de campagne porte toujours sa finalité.
-- ===========================================================================
--
-- LE DÉFAUT. Le gate de consentement compare la finalité de l'e-mail (`purpose`) aux finalités
-- accordées par l'abonné (`subscription.granted_purposes`). Si `purpose` est nul sur une ligne
-- `kind = 'campaign'`, il n'y a rien à comparer : le gate ne REFUSE pas, il n'a simplement plus de
-- critère. L'e-mail part vers des gens qui n'ont jamais accordé cette finalité, sans erreur, sans
-- ligne de journal, sans trace. C'est le pire genre de défaut : celui qui se manifeste par un
-- succès. Inoffensif à 0 ligne de campagne en file, mortel à 1 200.
--
-- POURQUOI LA CONTRAINTE NE DIT RIEN DES AUTRES GENRES. Les transactionnels (confirmation,
-- welcome, unsubscribe_ack) ne relèvent d'aucune finalité marketing : leur `purpose` doit rester
-- nul, et le forcer reviendrait à leur inventer un consentement qu'ils n'exigent pas. La
-- contrainte est donc une implication, pas une équivalence : elle n'a d'avis que sur 'campaign'.
-- Les valeurs admises de `purpose` restent gouvernées par `email_outbox_purpose_check` (0013).
--
-- État constaté avant pose : 4 lignes en file (confirmation ×2, welcome ×2), 0 ligne
-- `kind = 'campaign'`, donc 0 ligne en infraction. La contrainte est posée VALIDE — un `NOT VALID`
-- n'aurait servi qu'à masquer une dette qui n'existe pas.
alter table newsletter.email_outbox drop constraint if exists email_outbox_campaign_purpose_required;
alter table newsletter.email_outbox
  add constraint email_outbox_campaign_purpose_required check (
    kind <> 'campaign' or purpose is not null
  );


-- ===========================================================================
-- GARDE 3 — Séparer les 1 200 abonnés de démonstration des vrais, tant qu'il est encore facile.
-- ===========================================================================
--
-- LE DÉFAUT. `0004_seed_demo_subscribers.sql` a fabriqué 1 200 abonnés `demoN@example.com`, dont
-- 1 056 souscriptions `active` que le gate considère aujourd'hui comme ENVOYABLES : aucune n'a de
-- preuve de consentement, et leur colonne `source` les maquille en organic/social/import/crm_sync
-- pour faire vivre les écrans de segmentation. Tant que la base ne contient QUE de la démo, la
-- confusion est sans conséquence. Le jour où la première vraie adresse arrive, les deux
-- populations deviennent indiscernables par requête, et un fan-out expédie 1 056 messages vers
-- `@example.com` : 1 056 rebonds durs en une passe, sur un domaine expéditeur en warm-up. C'est
-- la réputation d'envoi qui paie, et elle ne se répare pas en une semaine.
--
-- ⛔ ON NE SUPPRIME RIEN. Les jeux de démonstration font vivre l'admin (segments, engagement,
-- répartition pays), et la purge est un arbitrage qu'Alix n'a pas rendu. On ne fait ici que rendre
-- les deux populations DISTINGUABLES ; qui part et qui reste se décidera ailleurs.
--
-- POURQUOI SUR `subscriber` ET PAS SUR `subscription`. Être fictif est une propriété de la
-- PERSONNE, pas de son abonnement : ce qui est faux ici, c'est l'adresse `@example.com`, et elle
-- vit sur `subscriber`. Poser le drapeau sur `subscription` obligerait à le répéter — et à le
-- maintenir cohérent — sur chaque abonnement d'un même faux contact, avec la certitude qu'un jour
-- l'un d'eux serait oublié. Le gate, qui joint déjà `subscription → subscriber` pour lire
-- l'adresse d'envoi, atteint la colonne sans jointure supplémentaire.
alter table newsletter.subscriber
  add column if not exists is_demo boolean not null default false;

-- ⛔ CE COMMENTAIRE DE COLONNE EST REMPLACÉ EN BASE PAR 0033 : il définissait `is_demo` par
-- l'adresse @example.com alors que l'UPDATE ci-dessous ne marquait que le seed 0004. La définition
-- vivante est celle de `0033_is_demo_reserved_domain.sql` (critère = domaine réservé RFC 2606).
comment on column newsletter.subscriber.is_demo is
  'Contact fabriqué par un seed de démonstration : adresse @example.com non délivrable, aucune preuve de consentement. À exclure de tout envoi. Faux par défaut : un contact qui arrive par le formulaire public est réel jusqu''à preuve du contraire.';

-- LE CRITÈRE — ⛔ CORRIGÉ ET REMPLACÉ PAR `0033_is_demo_reserved_domain.sql`. NE PAS LE RECOPIER.
-- Le motif ci-dessous vise le seed 0004 (`format('demo%s@example.com', i)`, i de 1 à 1200) et il
-- est bien bijectif avec cette série. Mais il ne tient PAS la définition écrite juste au-dessus
-- (« adresse @example.com non délivrable ») : mesuré, 1 202 abonnés sont @example.com et 2
-- échappaient au marquage — `bridge-selftest-a/b@example.com`, chacun avec une souscription
-- `active` et chacun présent dans `sendable_subscription`. Le jour du câblage `not is_demo`, ces
-- deux-là seraient partis. On les a exclus au nom d'une provenance qui n'existe nulle part dans le
-- dépôt ; 0033 reprend le critère qui, lui, se prouve : le domaine réservé RFC 2606.
--
-- ⚠️ ET LE `::text` REND CE `~` SENSIBLE À LA CASSE — l'inverse de ce qu'annonçait le handoff.
-- `email` est de type `citext`, mais le cast en `text` annule l'insensibilité du type :
--   ('DEMO1@EXAMPLE.COM'::citext)::text ~ '^demo[0-9]+@example\.com$'  -->  false   (le code ci-dessous)
--   ('DEMO1@EXAMPLE.COM'::citext)        ~ '^demo[0-9]+@example\.com$'  -->  true    (sans le cast)
-- L'erreur pointait du mauvais côté : une adresse de démo en majuscules serait restée
-- `is_demo = false`, donc envoyable. 0033 écrit `lower(email::text)` et pose une contrainte qui
-- refuse la ligne (témoin rejoué : `PROBE-GUARD-2@EXAMPLE.COM` sans drapeau -> REFUSE 23514).
update newsletter.subscriber
   set is_demo = true
 where email::text ~ '^demo[0-9]+@example\.com$'
   and is_demo is distinct from true;

-- ---------------------------------------------------------------------------
-- CE QUI RESTE À CÂBLER — hors de cette migration, et hors de ce lot.
-- ---------------------------------------------------------------------------
-- `is_demo` n'est pour l'instant qu'une ÉTIQUETTE : elle n'exclut personne toute seule. Un drapeau
-- que rien ne lit protège de ce qu'on veut bien croire, pas de ce qui part. Restent à faire :
--   1. LE POINT DE PASSAGE EST UNIQUE ET IL A UN NOM : la vue `newsletter.sendable_subscription`.
--      ⛔ SA DÉFINITION VIVANTE VIENT DE `0015_consent_views.sql`, PAS DE 0009 — 0015 l'a recréée
--      pour exposer les colonnes de 0013-0014, vérifié par `pg_get_viewdef` (la vue rend
--      `granted_purposes` et `tracking_consent`, qui n'existaient pas au moment de 0009). Suivre
--      l'ancienne référence, c'est lire un fichier supplanté. Et on n'édite ni 0009 ni 0015 : ils
--      sont appliqués — le câblage est un `create or replace view` dans une migration NEUVE.
--      LE GESTE EST PLUS PETIT QU'ANNONCÉ ICI : la vue JOINT DÉJÀ `newsletter.subscriber sub`
--      (elle en a besoin pour `is_suppressed(sub.email, s.asset_id)`). Aucune jointure à ajouter,
--      seulement `and not sub.is_demo` dans le WHERE existant. ⛔ Modifier cette vue change ce que
--      TOUT le produit considère comme envoyable : lot dédié, pas effet de bord. Chiffre à
--      connaître avant d'écrire le prédicat : la vue rend 1 058 lignes, et les 1 058 sont
--      maintenant `is_demo` — le filtre la fera tomber à ZÉRO. Cette base n'a aucun destinataire réel.
--   2. Les compteurs d'audience de l'admin doivent dire lesquels sont des démos, sinon un
--      opérateur lira « 1 056 destinataires » et croira à une audience.
--   3. Tout futur seed de démonstration doit poser `is_demo = true` À L'INSERTION. ✅ CE POINT N'EST
--      PLUS UNE DISCIPLINE : 0033 pose `subscriber_reserved_domain_is_demo`, un CHECK qui refuse
--      (23514) toute adresse en domaine réservé RFC 2606 sans le drapeau, à l'insert comme à
--      l'update. Un seed qui oublie le drapeau échoue au lieu de fabriquer un envoyable silencieux.

notify pgrst, 'reload schema';
