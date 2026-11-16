-- ---------------------------------------------------------------------------
-- 0035 — De quoi EXPLIQUER le zéro que 0034 vient de produire.
-- ---------------------------------------------------------------------------
--
-- LE DÉFAUT QU'ON ÉVITE. 0034 fait tomber `sendable_subscription` de 1 058 à 0. Le chiffre est
-- juste, mais un « 0 destinataires » sans explication se lit comme une PANNE : l'opérateur va
-- soupçonner la règle de segment, la marque courante, la base. Un zéro qui ne dit pas pourquoi il
-- vaut zéro coûte une demi-journée de recherche à quelqu'un — et finit par être contourné.
--
-- CETTE VUE EST LE COMPLÉMENT EXACT DE L'AUTRE : mêmes conditions, drapeau inversé. Elle répond à
-- « qui vient d'être écarté, et combien ». L'admin peut alors écrire « 0 envoyables — 1 058
-- contacts de démonstration exclus », qui se lit, au lieu de « 0 », qui alarme.
--
-- ⛔ POURQUOI UNE VUE ET PAS UN COMPTAGE RECONSTITUÉ DANS L'ADMIN. `is_suppressed(...)` est une
-- fonction SQL : PostgREST ne sait pas l'appeler dans un filtre. Un comptage reconstitué côté
-- application oublierait donc la non-suppression et rendrait un nombre légèrement FAUX — et un
-- compteur qui ne compte pas exactement ce que son libellé annonce est pire que pas de compteur.
-- Les deux vues partagent mot pour mot le même WHERE : elles ne peuvent pas diverger sans qu'on
-- le voie dans le même fichier de migration.
--
-- ⚠️ CETTE VUE N'EST PAS UNE PORTE DÉROBÉE. Elle ne sert qu'à COMPTER : aucun chemin d'envoi ne
-- doit la lire. La barrière d'envoi reste `sendable_subscription`, et elle seule.
create or replace view newsletter.excluded_demo_subscription as
select s.*
from newsletter.subscription s
join newsletter.subscriber sub on sub.id = s.subscriber_id
where s.status = 'active'
  and not newsletter.is_suppressed(sub.email::text, s.asset_id)
  and sub.is_demo;

comment on view newsletter.excluded_demo_subscription is
  'Complément exact de sendable_subscription : les abonnements que la barrière d''envoi vient d''écarter parce que le contact est fictif (domaine réservé RFC 2606). Sert UNIQUEMENT à expliquer un compteur à zéro. ⛔ Aucun chemin d''envoi ne doit lire cette vue.';

notify pgrst, 'reload schema';
