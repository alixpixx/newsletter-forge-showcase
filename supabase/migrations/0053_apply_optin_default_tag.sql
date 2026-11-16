-- ---------------------------------------------------------------------------
-- 0053 — appliquer RÉTROACTIVEMENT le tag par défaut d'un optin.
-- ---------------------------------------------------------------------------
--
-- Décision d'Alix (08/09/2026) : le tag d'un optin, ce sont DEUX GESTES SÉPARÉS. Le tag par défaut
-- vaut pour les PROCHAINS contacts ; l'appliquer à ceux déjà arrivés est une action explicite, avec
-- le nombre affiché AVANT et une confirmation. Cette fonction sert les deux moments — d'où
-- `p_dry_run`, qui compte sans rien écrire.
--
-- ⛔ POURQUOI EN SQL ET PAS DANS L'ADMIN. Deux raisons :
--  1. la double écriture (`subscription_tag` ET `subscription.tag_ids`) existe déjà côté
--     `apps/public` (`attachTags`), et l'admin ne peut pas l'importer — un import hors du dossier
--     déployé casse en production. La recopier donnerait deux implémentations de la règle « les
--     deux écritures sont obligatoires », qui ne resteraient d'accord que jusqu'à la première
--     correction de l'une des deux. Or c'est `tag_ids` que le compilateur de segments interroge :
--     n'écrire que la liaison donne un abonné tagué qu'aucun segment ne trouve ;
--  2. une boucle applicative sur plusieurs milliers de souscriptions n'est ni atomique ni bornée en
--     temps de réponse. Ici, une transaction, un aller-retour.
--
-- ⛔ LE TAG DOIT APPARTENIR À LA MARQUE DE L'OPTIN. La clé étrangère `default_tag_id → tag(id)` ne
-- dit rien de `asset_id` : rien n'empêcherait, au niveau du schéma, de poser le tag d'une autre
-- marque sur des milliers de contacts. La route qui écrit `default_tag_id` le vérifie déjà, mais
-- une garde côté écran ne protège pas d'un appel direct — c'est ici que l'écriture a lieu, c'est
-- ici que la vérification doit mordre.

create or replace function newsletter.apply_optin_default_tag(
  p_optin_id uuid,
  p_dry_run  boolean default true
)
returns integer
language plpgsql
security definer
set search_path = newsletter, public
as $$
declare
  v_tag        integer;
  v_asset      uuid;
  v_tag_asset  uuid;
  v_manquants  integer;
begin
  select o.default_tag_id, o.asset_id into v_tag, v_asset
    from newsletter.optin o where o.id = p_optin_id;

  if not found then
    raise exception 'optin % introuvable', p_optin_id using errcode = 'no_data_found';
  end if;

  -- Pas de tag par défaut : il n'y a rien à appliquer, et ce n'est pas une erreur.
  if v_tag is null then
    return 0;
  end if;

  select t.asset_id into v_tag_asset from newsletter.tag t where t.id = v_tag;
  if v_tag_asset is distinct from v_asset then
    raise exception 'le tag % appartient a une autre marque que l''optin %', v_tag, p_optin_id
      using errcode = 'check_violation';
  end if;

  -- Ce que le geste changerait VRAIMENT : les souscriptions qui n'ont pas déjà ce tag. Compter
  -- toutes les souscriptions de l'optin annoncerait un effet plus large que le réel, et un second
  -- clic afficherait encore le même nombre alors qu'il n'y a plus rien à faire.
  select count(*) into v_manquants
    from newsletter.subscription s
   where s.optin_id = p_optin_id
     and not (coalesce(s.tag_ids, '{}'::integer[]) @> array[v_tag]);

  if p_dry_run then
    return v_manquants;
  end if;

  insert into newsletter.subscription_tag (subscription_id, tag_id, source)
  select s.id, v_tag, 'optin_default'
    from newsletter.subscription s
   where s.optin_id = p_optin_id
  on conflict (subscription_id, tag_id) do nothing;

  -- UNION avec l'existant, jamais un écrasement : les tags qu'une personne a choisis à
  -- l'inscription ne se remplacent pas par un tag automatique.
  update newsletter.subscription s
     set tag_ids = (
           select array(select distinct unnest(coalesce(s.tag_ids, '{}'::integer[]) || v_tag))
         )
   where s.optin_id = p_optin_id
     and not (coalesce(s.tag_ids, '{}'::integer[]) @> array[v_tag]);

  return v_manquants;
end
$$;

comment on function newsletter.apply_optin_default_tag(uuid, boolean) is
  'Applique le tag par defaut d''un optin aux contacts DEJA arrives. p_dry_run=true compte sans ecrire.';

revoke all on function newsletter.apply_optin_default_tag(uuid, boolean) from public;
grant execute on function newsletter.apply_optin_default_tag(uuid, boolean) to service_role;

notify pgrst, 'reload schema';
