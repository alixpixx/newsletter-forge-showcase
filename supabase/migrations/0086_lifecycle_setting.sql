-- ============================================================================
-- 0086 — Couper un e-mail de cycle de vie, par marque (Welcome, accusé de désabonnement).
-- ============================================================================
--
-- ⭐ DEMANDE D'ALIX (24/09/2026, feature 3) : « tout dans System, même les lifecycles, et que tout soit
-- éditable directement depuis la page Automations ». Le modèle se règle déjà (`lifecycle_template`,
-- 0059) ; ce qui manquait, c'est l'interrupteur.
--
-- ⛔ ABSENCE = ACTIVÉ. Aucune ligne n'est écrite ici : rien ne change en prod tant que personne ne coupe
-- un e-mail depuis l'écran. L'app publique lit la ligne ; ligne absente ou lecture en échec ⇒ l'e-mail
-- part, exactement comme avant ce lot.
--
-- ⛔ LA CONFIRMATION NE SE COUPE PAS, ET C'EST LA CONTRAINTE QUI LE DIT. Sans elle personne ne confirme,
-- donc personne ne s'inscrit, et le double opt-in n'est plus prouvé. `kind` n'accepte que les deux
-- e-mails qu'on peut taire ; l'app publique ne lit même pas ce réglage pour la confirmation (testé).
-- `reengagement` n'y est pas non plus : la relance devient une automation du moteur (0082), qui a
-- déjà ses propres statuts.

set local role postgres;

create table if not exists newsletter.lifecycle_setting (
  asset_id   uuid not null references newsletter.asset(id) on delete cascade,
  kind       text not null,
  enabled    boolean not null,
  updated_by text,
  updated_at timestamptz not null default now(),
  primary key (asset_id, kind),
  constraint lifecycle_setting_kind_check check (kind in ('welcome', 'unsubscribe_ack'))
);

comment on table newsletter.lifecycle_setting is
  'Interrupteur des e-mails de cycle de vie qu''on peut taire, par marque. Ligne absente = activé. '
  'La confirmation n''y figure pas : elle ne se coupe jamais (contrainte de kind).';
comment on column newsletter.lifecycle_setting.enabled is
  'Faux = l''app publique ne met plus cet e-mail en file. L''action qui le déclenchait (confirmation, '
  'désabonnement) a lieu quand même.';

alter table newsletter.lifecycle_setting enable row level security;
grant select, insert, update, delete on newsletter.lifecycle_setting to service_role;

-- ============================================================================================
-- CONTRE-ÉPREUVES
-- ============================================================================================
do $$
declare
  v_asset uuid;
begin
  -- 1. Table fermée : service_role seul, RLS active, aucune ligne (rien ne change sans geste).
  if not (select relrowsecurity from pg_class where oid = 'newsletter.lifecycle_setting'::regclass) then
    raise exception '[0086] RLS inactive sur lifecycle_setting';
  end if;
  -- ⚠️ Un privilège à la fois : `has_table_privilege(…, 'select, insert')` rend vrai si UN SEUL est tenu.
  if not (has_table_privilege('service_role', 'newsletter.lifecycle_setting', 'select')
          and has_table_privilege('service_role', 'newsletter.lifecycle_setting', 'insert')
          and has_table_privilege('service_role', 'newsletter.lifecycle_setting', 'update')
          and has_table_privilege('service_role', 'newsletter.lifecycle_setting', 'delete')) then
    raise exception '[0086] service_role ne peut pas lire et ecrire lifecycle_setting';
  end if;
  if has_table_privilege('anon', 'newsletter.lifecycle_setting', 'select')
     or has_table_privilege('authenticated', 'newsletter.lifecycle_setting', 'select') then
    raise exception '[0086] lifecycle_setting ouverte a anon ou authenticated';
  end if;
  if exists (select 1 from newsletter.lifecycle_setting) then
    raise exception '[0086] lifecycle_setting n''est pas vide : un e-mail serait coupe sans geste';
  end if;
  raise notice '[0086] contre-epreuve 1 OK : table fermee, vide';

  -- 2. La confirmation (et la relance) sont REFUSÉES ; les deux autres passent. Tout est annulé.
  select id into v_asset from newsletter.asset order by slug limit 1;
  if v_asset is null then
    raise exception '[0086] aucune marque pour la contre-epreuve';
  end if;
  begin
    insert into newsletter.lifecycle_setting (asset_id, kind, enabled) values (v_asset, 'confirmation', false);
    raise exception '[0086] confirmation acceptee : elle pourrait etre coupee';
  exception when check_violation then null;
  end;
  begin
    insert into newsletter.lifecycle_setting (asset_id, kind, enabled) values (v_asset, 'reengagement', false);
    raise exception '[0086] reengagement accepte : la relance vit dans le moteur';
  exception when check_violation then null;
  end;
  begin
    insert into newsletter.lifecycle_setting (asset_id, kind, enabled)
    values (v_asset, 'welcome', false), (v_asset, 'unsubscribe_ack', false);
    raise exception 'annuler';
  exception when raise_exception then
    if sqlerrm <> 'annuler' then raise; end if;
  end;
  if exists (select 1 from newsletter.lifecycle_setting) then
    raise exception '[0086] une ligne d''essai est restee';
  end if;
  raise notice '[0086] contre-epreuve 2 OK : confirmation et relance refusees, welcome et accuse acceptes';
end
$$;

notify pgrst, 'reload schema';

-- ⛔ EN DERNIÈRE INSTRUCTION, ET APRÈS LA CONTRE-ÉPREUVE (voir 0072).
insert into newsletter.applied_migration (version, filename, applied_at, backfilled)
values ('0086', '0086_lifecycle_setting.sql', now(), false)
on conflict (version) do update
   set applied_at = excluded.applied_at,
       backfilled = false;
