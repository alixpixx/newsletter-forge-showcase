-- 0067 — Le numéro de la première édition d'une série.
--
-- LA DEMANDE (Alix, 16/09) : le numéro d'édition repart à 1 à chaque campagne → « on ajoute
-- un numero de depart ». Une newsletter qui en est à sa 140ᵉ édition et qu'on recrée ici ne
-- doit pas afficher « Edición 1 ».
--
-- LE MODÈLE : `campaign_occurrence.seq` reste le seul porteur du numéro (la vue `outbox_context`
-- l'expose en `occurrence_seq`, le worker le sert en `{{edition_number}}`). Le départ n'est lu
-- que par le matérialiseur, au moment de numéroter une occurrence NEUVE :
--     seq = max(max(seq existants), edition_start - 1) + 1
-- ⇒ aucune vue à redéfinir, et l'écran de la campagne (« #seq ») dit le même numéro que l'e-mail.
--
-- ⚠️ Changer le départ après coup ne renumérote RIEN : les occurrences déjà créées gardent leur
-- numéro (elles peuvent être figées, voire parties). Seules les suivantes en tiennent compte, et
-- seulement si le départ dépasse ce qui existe — un numéro ne recule jamais.

alter table newsletter.campaign
  add column if not exists edition_start integer not null default 1;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'newsletter.campaign'::regclass
       and conname = 'campaign_edition_start_positive'
  ) then
    alter table newsletter.campaign
      add constraint campaign_edition_start_positive check (edition_start between 1 and 1000000);
  end if;
end
$$;

comment on column newsletter.campaign.edition_start is
  'Numéro de la première occurrence de la série (0067). Lu par le matérialiseur uniquement ; ne renumérote jamais une occurrence existante.';

insert into newsletter.applied_migration (version, filename, applied_at, backfilled)
values ('0067', '0067_campaign_edition_start.sql', now(), false)
on conflict (version) do update
   set applied_at = excluded.applied_at,
       backfilled = false;
