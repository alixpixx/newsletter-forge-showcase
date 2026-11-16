-- ---------------------------------------------------------------------------
-- 0034 — `sendable_subscription` cesse de considérer les contacts de démonstration
--        comme des destinataires.
-- ---------------------------------------------------------------------------
--
-- CE QUE 0032/0033 ONT FAIT, ET CE QU'ILS N'ONT PAS FAIT. `is_demo` est désormais JUSTE
-- (1 202 abonnés marqués, 0 échappé) et INVIOLABLE (`subscriber_reserved_domain_is_demo` refuse
-- toute adresse en domaine réservé RFC 2606 sans le drapeau). Mais c'est resté une ÉTIQUETTE :
-- aucun code ne la lisait, aucune vue ne la filtrait. Un drapeau que rien ne lit protège de ce
-- qu'on veut bien croire, pas de ce qui part. Cette migration le câble à l'endroit unique où la
-- question « qui peut recevoir ? » se pose.
--
-- POURQUOI LA VUE, ET PAS LE FAN-OUT QUI ARRIVE. Le fan-out (S-6) va bientôt lire une audience et
-- écrire dans `email_outbox`. Poser le filtre DANS le fan-out le rendrait vrai pour ce chemin-là
-- et faux pour tous les autres : compteur d'audience de l'admin, `/api/segments/count`, export,
-- et tout chemin qu'on écrira ensuite. La barrière d'envoi de ce produit a un nom et un seul —
-- `sendable_subscription` — et c'est le seul endroit où la règle ne peut pas être contournée par
-- oubli. Voir le point de passage obligé : une garde ne vaut que posée au goulot.
--
-- ⛔ CE QUE CE PRÉDICAT FAIT AUX CHIFFRES, MESURÉ AVANT DE L'ÉCRIRE (25/08) :
--     sendable_subscription                       = 1 058 lignes
--     mêmes lignes, filtrées `not sub.is_demo`    =     0 ligne
--     abonnés is_demo = 1 202 · abonnés réels = 1 (erased***@deleted.invalid, RGPD, 0 active)
-- La vue tombe donc à ZÉRO. Ce n'est PAS une régression : cette base ne contient aucun
-- destinataire réel envoyable, et c'est la première fois que le produit le dit. Un écran qui
-- affichait « 1 056 destinataires » affichait une audience qui n'existe pas.
--
-- ⚠️ UN ZÉRO NON EXPLIQUÉ EST UN BUG AUX YEUX DE CELUI QUI LE LIT. Le même lot ajoute donc aux
-- compteurs de l'admin le nombre de contacts de démonstration ÉCARTÉS : « 0 envoyables,
-- 1 058 contacts de démonstration exclus » se lit, « 0 » se signale comme une panne.
--
-- POURQUOI PAS UNE PURGE. Supprimer les 1 202 démos est un arbitrage qu'Alix n'a pas rendu, et
-- elles font vivre les écrans de segmentation (pays, langue, engagement). On les rend
-- inenvoyables, on ne les efface pas.
--
-- ⛔ AUCUNE COLONNE NE CHANGE : `create or replace view` l'interdirait de toute façon (mêmes noms,
-- mêmes types, même ordre). La vue rend toujours `s.*` de `newsletter.subscription`, la jointure
-- sur `subscriber` existait déjà — elle est nécessaire à `is_suppressed(sub.email, ...)`. Il n'y a
-- donc RIEN de nouveau dans le plan d'exécution : un prédicat de plus sur une table déjà jointe.
create or replace view newsletter.sendable_subscription as
select s.*
from newsletter.subscription s
join newsletter.subscriber sub on sub.id = s.subscriber_id
where s.status = 'active'
  and not newsletter.is_suppressed(sub.email::text, s.asset_id)
  -- Contact non délivrable (domaine réservé RFC 2606) : jamais un destinataire. Le drapeau est
  -- porté par la PERSONNE, pas par l'abonnement — voir 0033.
  and not sub.is_demo;

comment on view newsletter.sendable_subscription is
  'Barrière d''envoi unique du produit : abonnement actif, adresse non supprimée (plainte/bounce/désinscription), contact non fictif (is_demo). Tout chemin qui envoie ou qui COMPTE une audience passe par ici — un filtre équivalent écrit ailleurs serait vrai pour un chemin et faux pour les autres.';

notify pgrst, 'reload schema';
