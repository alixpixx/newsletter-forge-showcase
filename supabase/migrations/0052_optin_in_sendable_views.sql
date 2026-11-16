-- ---------------------------------------------------------------------------
-- 0052 — `optin_id` entre dans les DEUX vues d'audience.
-- ---------------------------------------------------------------------------
--
-- ⛔ POURQUOI CETTE MIGRATION EXISTE. La 0051 a posé `subscription.optin_id`, et le compilateur de
-- segments allait s'en servir. Mais ni l'admin ni le worker ne lisent `subscription` : ils comptent
-- et énumèrent sur les VUES `sendable_subscription` (la barrière d'envoi) et
-- `excluded_demo_subscription` (son complément exact, qui rend un zéro lisible). Or un `select *`
-- dans une vue est expansé À LA CRÉATION : les deux vues portaient encore la liste de colonnes
-- d'avant la 0051, sans `optin_id`.
--
-- Ce qui serait arrivé sans cette migration — vérifié colonne par colonne avant d'écrire une seule
-- ligne de compilateur : un segment ciblant un optin produit `optin_id.eq.<uuid>`, PostgREST répond
-- « column does not exist », et alors
--   • l'écran de segment affiche un compte NUL avec un message de base de données brut ;
--   • `estimateAudience` rend `reason: <message Postgres>` — l'audience d'une campagne devient
--     illisible ;
--   • `pageAudience` LÈVE dans le worker : l'occurrence n'est pas enfilée, et l'édition ne part pas.
-- Un ciblage qui n'existe pas dans la table de mesure ne se voit pas à l'écriture, il se voit le
-- jour de l'envoi.
--
-- ⚠️ `create or replace view` AJOUTE la colonne À LA FIN — c'est exactement ce qu'on veut ici, et
-- la seule chose qu'il sache faire sans détruire les dépendances. La liste ci-dessous est donc la
-- liste actuelle, relue en base, PLUS `optin_id` en dernier. Aucun retrait, aucun réordonnancement.
-- ⚠️ Les deux vues ne diffèrent que par `sub.is_demo` / `not sub.is_demo` : elles doivent rester
-- une partition exacte, sinon le « combien de contacts de démonstration ont été écartés » ment.
-- ⛔ `not sub.is_demo` NE SE RETIRE PAS de `sendable_subscription` (1 058 rebonds durs sur un
-- domaine en warm-up).

create or replace view newsletter.sendable_subscription as
  select s.id, s.subscriber_id, s.asset_id, s.edition_id, s.status, s.source, s.source_detail,
         s.language, s.consent_state, s.consent_version_id, s.consent_ip, s.consent_method,
         s.consent_at, s.open_count, s.click_count, s.last_open_at, s.last_click_at,
         s.last_engagement_at, s.engagement_score, s.engagement_level, s.welcome_completed,
         s.soft_bounce_count, s.tag_ids, s.created_at, s.country, s.tracking_consent,
         s.tracking_consent_at, s.granted_purposes,
         s.optin_id
    from newsletter.subscription s
    join newsletter.subscriber sub on sub.id = s.subscriber_id
   where s.status = 'active'
     and not newsletter.is_suppressed(sub.email::text, s.asset_id)
     and not sub.is_demo;

create or replace view newsletter.excluded_demo_subscription as
  select s.id, s.subscriber_id, s.asset_id, s.edition_id, s.status, s.source, s.source_detail,
         s.language, s.consent_state, s.consent_version_id, s.consent_ip, s.consent_method,
         s.consent_at, s.open_count, s.click_count, s.last_open_at, s.last_click_at,
         s.last_engagement_at, s.engagement_score, s.engagement_level, s.welcome_completed,
         s.soft_bounce_count, s.tag_ids, s.created_at, s.country, s.tracking_consent,
         s.tracking_consent_at, s.granted_purposes,
         s.optin_id
    from newsletter.subscription s
    join newsletter.subscriber sub on sub.id = s.subscriber_id
   where s.status = 'active'
     and not newsletter.is_suppressed(sub.email::text, s.asset_id)
     and sub.is_demo;

notify pgrst, 'reload schema';
