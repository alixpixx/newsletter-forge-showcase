-- Une édition primaire par marque (si absente) : régime dérivé du marché.
insert into newsletter.asset_edition (asset_id, market, language, compliance_regime, data_residency, timezone)
select a.id, coalesce(a.market, 'INT'), coalesce(a.languages[1], 'en'),
  case when a.market = 'BR' then 'lgpd' when a.market = 'US' then 'canspam' else 'gdpr' end,
  case when a.market = 'BR' then 'br' when a.market = 'US' then 'us' else 'eu' end,
  case when a.market = 'BR' then 'America/Sao_Paulo' when a.market = 'CL' then 'America/Santiago' else 'UTC' end
from newsletter.asset a
where not exists (select 1 from newsletter.asset_edition e where e.asset_id = a.id);

-- Config footer conforme par édition (adresse physique = à compléter par le legal).
update newsletter.asset_edition e
set legal_footer = jsonb_build_object(
  'controller', 'Example Media Ltd',
  'dpo_contact', 'privacy@example.com',
  'privacy_url', 'https://' || replace(coalesce(e.sending_subdomain, a.sending_subdomain, 'news.' || a.slug || '.com'), 'news.', '') || '/privacy',
  'responsible_gambling', true,
  'physical_address', null
)
from newsletter.asset a
where a.id = e.asset_id
  and (e.legal_footer = '{}'::jsonb or e.legal_footer is null);

select (select count(*) from newsletter.asset_edition) as editions,
       (select count(*) from newsletter.asset_edition where legal_footer ? 'controller') as avec_footer;
