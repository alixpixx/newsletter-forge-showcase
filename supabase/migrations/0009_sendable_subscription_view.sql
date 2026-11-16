-- C4 : vue "envoyable" = statut actif ET non supprimé (source unique via is_suppressed).
-- Réutilisée par le comptage de segment (admin) et le worker d'envoi.
create or replace view newsletter.sendable_subscription as
select s.*
from newsletter.subscription s
join newsletter.subscriber sub on sub.id = s.subscriber_id
where s.status = 'active'
  and not newsletter.is_suppressed(sub.email::text, s.asset_id);

comment on view newsletter.sendable_subscription is
  'Souscriptions réellement envoyables : status=active + non suppression (global/asset). C4 compliance.';

-- Recharge le cache de schéma PostgREST pour exposer la vue.
notify pgrst, 'reload schema';
