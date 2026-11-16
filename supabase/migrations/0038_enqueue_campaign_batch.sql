-- ---------------------------------------------------------------------------
-- 0038 — La mise en file, écrite EN SQL et non dans l'appelant.
-- ---------------------------------------------------------------------------
--
-- POURQUOI UNE FONCTION SQL PLUTÔT QU'UN `insert` DEPUIS LE WORKER. Trois raisons, dans l'ordre
-- d'importance :
--
--  1. L'IDEMPOTENCE EXIGE `on conflict do nothing` SANS CIBLE. Les deux index qui rendent le
--     fan-out rejouable (0032 pour les séries, 0037 pour les campagnes simples) sont PARTIELS.
--     PostgREST ne sait pas exprimer le prédicat d'un index partiel dans son `on_conflict`, donc
--     un upsert passé par l'API viserait un index qui n'existe pas — ou pire, réussirait à côté.
--     `on conflict do nothing` sans cible couvre TOUS les index uniques de la table, c'est
--     exactement ce qu'on veut, et ça ne s'écrit qu'en SQL.
--
--  2. AUCUNE ADRESSE NE REMONTE DANS LE WORKER. L'appelant envoie des identifiants d'abonnement ;
--     la fonction lit l'e-mail en base et l'écrit dans la file. Le worker n'a jamais en mémoire la
--     liste des adresses d'une campagne — c'est une propriété qu'on garde tant qu'elle est
--     gratuite.
--
--  3. LA BARRIÈRE EST RÉAPPLIQUÉE AU GOULOT. La jointure sur `sendable_subscription` est DANS la
--     fonction : un appelant qui se tromperait de liste ne peut pas faire entrer dans la file un
--     abonnement inactif, supprimé ou fictif. Une garde qui ne vit que dans l'appelant est une
--     garde qu'un futur appelant oubliera.
--
-- ⚠️ CETTE FONCTION N'ENVOIE RIEN et n'arme rien. Elle écrit des lignes `pending` que le worker
-- d'envoi ne traitera que s'il tourne en `WORKER_MODE=live` — inchangé, toujours `dry-run`. Et sur
-- cette base, `sendable_subscription` rend 0 ligne : tout appel rend 0 tant qu'un destinataire
-- réel n'existe pas.

create or replace function newsletter.enqueue_campaign_batch(
  p_campaign_id uuid,
  p_occurrence_id uuid,
  p_subscription_ids uuid[]
) returns integer
language plpgsql
as $fn$
declare
  v_inserted integer;
  v_asset    uuid;
  v_purpose  text;
  v_subject  text;
  v_template uuid;
begin
  if p_subscription_ids is null or array_length(p_subscription_ids, 1) is null then
    return 0;
  end if;

  select c.asset_id, c.purpose into v_asset, v_purpose
    from newsletter.campaign c
   where c.id = p_campaign_id;

  if v_asset is null then
    raise exception 'enqueue: campaign % not found', p_campaign_id;
  end if;

  -- ⛔ Sans finalité, le gate d'envoi n'a plus de critère et laisse passer : refuser ICI est le
  -- seul moment où le refus ne coûte rien. Doublé par la contrainte email_outbox_campaign_purpose_required.
  if v_purpose is null then
    raise exception 'enqueue: campaign % has no purpose — the send gate would have nothing to compare', p_campaign_id;
  end if;

  -- Le porteur de contenu : l'occurrence quand il y en a une, la campagne sinon. C'est ici que se
  -- joue la fraîcheur d'une série — le sujet d'une occurrence a été résolu à SON gel, avec ses
  -- propres articles.
  if p_occurrence_id is not null then
    select o.subject, o.template_version_id into v_subject, v_template
      from newsletter.campaign_occurrence o
     where o.id = p_occurrence_id
       and o.campaign_id = p_campaign_id;
    if v_subject is null then
      raise exception 'enqueue: occurrence % does not belong to campaign %', p_occurrence_id, p_campaign_id;
    end if;
  else
    select c.subject, c.template_version_id into v_subject, v_template
      from newsletter.campaign c
     where c.id = p_campaign_id;
  end if;

  -- ⛔ LA BARRIÈRE EST APPLIQUÉE ICI, PAS SEULEMENT DANS L'APPELANT. La liste d'identifiants vient
  -- du worker ; si elle contenait un abonnement inactif, supprimé ou fictif, la jointure sur
  -- `sendable_subscription` l'écarte. Une garde qui ne vit que dans l'appelant est une garde qu'un
  -- futur appelant oubliera.
  insert into newsletter.email_outbox
    (asset_id, subscription_id, to_email, kind, subject, payload, purpose,
     campaign_id, template_version_id, occurrence_id)
  select v_asset,
         ss.id,
         sub.email,
         'campaign',
         v_subject,
         case when coalesce(sub.first_name, '') = '' then '{}'::jsonb
              else jsonb_build_object('first_name', sub.first_name) end,
         v_purpose,
         p_campaign_id,
         v_template,
         p_occurrence_id
    from newsletter.sendable_subscription ss
    join newsletter.subscriber sub on sub.id = ss.subscriber_id
   where ss.id = any(p_subscription_ids)
     and ss.asset_id = v_asset
  on conflict do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$fn$;

comment on function newsletter.enqueue_campaign_batch(uuid, uuid, uuid[]) is
  'Matérialise un LOT d''audience en lignes email_outbox pending. Idempotente par ON CONFLICT DO NOTHING, adossée aux index uniques partiels 0032/0037 : rejouer un lot après un crash n''expédie rien deux fois. Réapplique la barrière sendable_subscription sur les identifiants reçus et refuse une campagne sans finalité. Ne décide RIEN de l''envoi : le gate de conformité s''applique ligne par ligne au moment de l''envoi.';

revoke all on function newsletter.enqueue_campaign_batch(uuid, uuid, uuid[]) from public;
grant execute on function newsletter.enqueue_campaign_batch(uuid, uuid, uuid[]) to service_role;

notify pgrst, 'reload schema';
