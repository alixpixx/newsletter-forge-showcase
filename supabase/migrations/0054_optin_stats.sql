-- ---------------------------------------------------------------------------
-- 0054 — « combien de contacts par formulaire », en une lecture.
-- ---------------------------------------------------------------------------
--
-- C'est LA question de l'écran des optins, et PostgREST ne sait pas agréger : sans cette vue,
-- l'admin ferait une requête de comptage PAR optin. Une marque qui multiplie les formulaires
-- d'acquisition — précisément le cas d'usage — paierait la fonctionnalité par une lenteur qui
-- grandit avec son succès.
--
-- ⚠️ `left join` volontaire : un optin tout neuf, créé au vol par la première inscription qui
-- échoue ensuite, doit apparaître avec 0 contact plutôt que de disparaître de l'écran. Ici le zéro
-- est un vrai zéro (personne), pas un zéro fabriqué par une jointure ratée.
--
-- ⚠️ `tagged` compte les contacts qui portent DÉJÀ le tag par défaut. C'est ce qui permet à l'écran
-- de dire « 340 contacts, 120 taggés » et donc de proposer l'application rétroactive avec un effet
-- réel annoncé. Quand `default_tag_id` est NULL, `array[NULL]` rend un `@>` NULL, donc faux : la
-- colonne vaut 0, ce qui est la lecture juste (aucun tag par défaut ⇒ personne ne le porte).

create or replace view newsletter.optin_stats as
  select o.id            as optin_id,
         o.asset_id,
         o.slug,
         o.name,
         o.default_tag_id,
         o.first_seen_at,
         o.last_seen_at,
         o.archived_at,
         count(s.id)                                                        as subscriptions,
         count(s.id) filter (where s.status = 'active')                     as active_subscriptions,
         count(s.id) filter (where s.tag_ids @> array[o.default_tag_id])    as tagged_subscriptions
    from newsletter.optin o
    left join newsletter.subscription s on s.optin_id = o.id
   group by o.id;

comment on view newsletter.optin_stats is
  'Un optin et ses compteurs de contacts. Sert l''ecran des sous-listes.';

grant select on newsletter.optin_stats to service_role;

notify pgrst, 'reload schema';
