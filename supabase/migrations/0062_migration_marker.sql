-- 0062 — Registre d'application des migrations
--
-- POURQUOI cette table existe :
-- `scripts/apply-migration.mjs` POSTe le SQL sur l'API Management de Supabase et
-- n'écrit JAMAIS le registre `supabase_migrations.schema_migrations`. Résultat au
-- 09/09/2026 : 8 fichiers bel et bien appliqués en sont absents (0017-0021,
-- 0044-0046) et une entrée y figure sans fichier correspondant. Autrement dit,
-- RIEN en base ne prouve aujourd'hui qu'une migration donnée est passée — et une
-- migration qu'on croit appliquée à tort est le pire point de départ possible pour
-- le lot suivant, qui dépend de l'ordre exact de ses étapes.
--
-- Ce registre-ci est écrit par les migrations elles-mêmes, en DERNIÈRE instruction :
-- une migration qui échoue à mi-chemin n'y laisse pas sa ligne. Il est cumulatif
-- (une ligne par version, jamais un scalaire écrasé) pour qu'on lise l'historique
-- réel et pas seulement le dernier état.

create table if not exists newsletter.applied_migration (
  version    text primary key,
  filename   text        not null,
  -- NULL assumé : pour les 61 migrations antérieures à ce registre, la date
  -- d'application n'existe nulle part. Inventer une date les rendrait
  -- indiscernables des migrations réellement horodatées. NULL dit « inconnu ».
  applied_at timestamptz,
  -- true = ligne reconstituée depuis le dossier, pas observée à l'application.
  backfilled boolean     not null default false
);

comment on table newsletter.applied_migration is
  'Registre d''application des migrations, écrit par chaque migration en dernière instruction. `applied_at` NULL + `backfilled` true = version reconstituée, jamais observée.';

-- RLS activée sans aucune policy, comme les autres tables du schéma : le schéma
-- `newsletter` est exposé via PostgREST, donc toute table y est joignable par anon.
-- Seul le service role (qui contourne la RLS) doit lire ce registre.
alter table newsletter.applied_migration enable row level security;

-- Backfill des 61 migrations antérieures. `do nothing` : rejouer ce fichier ne doit
-- jamais réécrire une ligne, surtout pas pour remplacer une vraie date par NULL.
-- `applied_at` reste NULL (colonne non nommée) : c'est le fait qu'on veut consigner.
insert into newsletter.applied_migration (version, filename)
values
  ('0001', '0001_newsletter_init.sql'),
  ('0002', '0002_seed_assets.sql'),
  ('0003', '0003_add_country.sql'),
  ('0004', '0004_seed_demo_subscribers.sql'),
  ('0005', '0005_email_outbox.sql'),
  ('0006', '0006_compliance_dsar_tracking.sql'),
  ('0007', '0007_seed_editions_footer.sql'),
  ('0008', '0008_suppression_functions.sql'),
  ('0009', '0009_sendable_subscription_view.sql'),
  ('0010', '0010_email_outbox_worker.sql'),
  ('0011', '0011_outbox_release.sql'),
  ('0012', '0012_seed_consent_texts.sql'),
  ('0013', '0013_granular_consent.sql'),
  ('0014', '0014_granular_consent_backfill.sql'),
  ('0015', '0015_consent_views.sql'),
  ('0016', '0016_retention_purge.sql'),
  ('0017', '0017_builder_templates.sql'),
  ('0018', '0018_builder_media_campaigns_ai.sql'),
  ('0019', '0019_outbox_context_campaign.sql'),
  ('0020', '0020_saved_rows.sql'),
  ('0021', '0021_media_archive.sql'),
  ('0022', '0022_seed_timezone_fix.sql'),
  ('0023', '0023_outbox_priority.sql'),
  ('0024', '0024_wp_source.sql'),
  ('0025', '0025_campaign_occurrences.sql'),
  ('0026', '0026_multi_edition.sql'),
  ('0027', '0027_campaign_occurrence.sql'),
  ('0028', '0028_occurrence_duplicate_guard.sql'),
  ('0029', '0029_atlas_review_primary_edition_br.sql'),
  ('0030', '0030_legal_footer_privacy_urls.sql'),
  ('0031', '0031_atlas_review_real_domain.sql'),
  ('0032', '0032_fanout_guards.sql'),
  ('0033', '0033_is_demo_reserved_domain.sql'),
  ('0034', '0034_sendable_excludes_demo.sql'),
  ('0035', '0035_excluded_demo_subscription.sql'),
  ('0036', '0036_outbox_context_occurrence.sql'),
  ('0037', '0037_fanout_state.sql'),
  ('0038', '0038_enqueue_campaign_batch.sql'),
  ('0039', '0039_real_domains_ff_quartz_tips.sql'),
  ('0040', '0040_reconcile_counters.sql'),
  ('0041', '0041_email_event.sql'),
  ('0042', '0042_feed_article_sent.sql'),
  ('0043', '0043_record_feed_articles.sql'),
  ('0044', '0044_app_user.sql'),
  ('0045', '0045_retirer_marques_bluefin_news_pixel_daily_lumen_living.sql'),
  ('0046', '0046_asset_analytics.sql'),
  ('0047', '0047_article_views_null_non_mesure.sql'),
  ('0048', '0048_outbox_context_edition.sql'),
  ('0049', '0049_campaign_mix_latest.sql'),
  ('0050', '0050_subject_shortcodes.sql'),
  ('0051', '0051_optin.sql'),
  ('0052', '0052_optin_in_sendable_views.sql'),
  ('0053', '0053_apply_optin_default_tag.sql'),
  ('0054', '0054_optin_stats.sql'),
  ('0055', '0055_ai_intro.sql'),
  ('0056', '0056_recompute_engagement.sql'),
  ('0057', '0057_lifecycle_sunset.sql'),
  ('0058', '0058_reengagement_engine.sql'),
  ('0059', '0059_lifecycle_template.sql'),
  ('0060', '0060_reengagement_result.sql'),
  ('0061', '0061_first_party_engagement.sql')
on conflict (version) do nothing;

-- Le backfill n'a pas de date : forcer explicitement le drapeau plutôt que de le
-- déduire d'un DEFAULT, pour que la colonne reste vraie même si le DEFAULT change.
update newsletter.applied_migration
   set backfilled = true
 where applied_at is null
   and backfilled is false;

-- Assertion : le registre doit refléter EXACTEMENT ce que le dossier contenait
-- avant ce fichier. 61 versions reconstituées, la plus haute étant 0061.
do $$
declare
  n_backfilled int;
  v_max        text;
begin
  select count(*), max(version)
    into n_backfilled, v_max
    from newsletter.applied_migration
   where backfilled;

  if n_backfilled <> 61 then
    raise exception 'registre : % versions reconstituees, 61 attendues', n_backfilled;
  end if;
  if v_max <> '0061' then
    raise exception 'registre : plus haute version reconstituee = %, 0061 attendue', v_max;
  end if;
end
$$;

-- Cette migration s'inscrit elle-même, en DERNIER : si quoi que ce soit au-dessus
-- a échoué, la ligne 0062 n'existe pas et le registre ne ment pas.
insert into newsletter.applied_migration (version, filename, applied_at, backfilled)
values ('0062', '0062_migration_marker.sql', now(), false)
on conflict (version) do update
   set applied_at = excluded.applied_at,
       backfilled = false;

notify pgrst, 'reload schema';
