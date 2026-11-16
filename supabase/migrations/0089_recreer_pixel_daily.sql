-- ============================================================================
-- 0089 — Recréer la marque Pixel Daily (retirée par 0045)
--
-- Décision d'Alix, 25/09/2026 (Q-E2) : « Oui, recrée-la ». Le site OptinForge
-- `pixel-daily-apostas` collecte des contacts (9 leads Contoso mesurés le
-- 25/09, 0 consentement newsletter) : ils entrent comme CONTACTS hors newsletter
-- (0088, lot E), et il leur faut une marque. Bluefin News et Lumen Living restent retirés.
--
-- CE QUI EST RECRÉÉ, ET SUR QUEL MODÈLE. Les trois lignes de configuration qu'une
-- marque brésilienne porte aujourd'hui, relevées le 25/09 sur Northwind Sports (même marché,
-- même langue, même régime) :
--   asset            les valeurs d'avant 0045 (0002_seed_assets.sql)
--   asset_edition    `pt-br`, BR, pt-BR, LGPD, consentement `single`, primaire,
--                    America/Sao_Paulo, résidence `br` — le pied légal de Northwind Sports,
--                    avec l'URL de confidentialité mesurée pour Pixel Daily par 0030
--   consent_version  le texte LGPD Example Media `example-2026-07`, COPIÉ de Northwind Sports :
--                    mesuré le 25/09, le texte est commun (1 empreinte pour les 2
--                    marques LGPD) et ne nomme aucune marque
--
-- CE QUI N'EST PAS RECRÉÉ, À DESSEIN :
--   · aucun accès (`app_user_asset`) : un super_admin voit toutes les marques,
--     présentes et futures (`lib/acces.ts`) ; donner la marque à quelqu'un
--     d'autre est un geste d'Alix, depuis l'écran des utilisateurs ;
--   · aucune source WordPress, aucun template, aucun pied de marque : rien de
--     tout cela n'est nécessaire pour recevoir des contacts, et l'écran les pose.
--
-- ⚠️ LE SOUS-DOMAINE D'ENVOI (`news.pixel-daily.example`) N'A PAS ÉTÉ VÉRIFIÉ chez
--    Mailgun. Le worker l'emploie tel quel : aucune campagne de cette marque ne
--    doit partir avant ce contrôle.
--
-- ⛔ 0045 N'EST PAS RÉÉCRIT : une migration appliquée est un fait historique.
-- ============================================================================

insert into newsletter.asset (slug, name, market, languages, sending_subdomain)
values ('pixel-daily', 'Pixel Daily', 'BR', '{pt-BR}', 'news.pixel-daily.example');

insert into newsletter.asset_edition
  (asset_id, slug, market, language, compliance_regime, consent_mode, is_primary,
   timezone, data_residency, legal_footer)
select a.id, 'pt-br', 'BR', 'pt-BR', 'lgpd', 'single', true,
       'America/Sao_Paulo', 'br',
       modele.legal_footer || jsonb_build_object('privacy_url', 'https://pixel-daily.example/privacidade')
  from newsletter.asset a,
       (select e.legal_footer
          from newsletter.asset_edition e
          join newsletter.asset m on m.id = e.asset_id
         where m.slug = 'northwind-sports' and e.is_primary) as modele
 where a.slug = 'pixel-daily';

insert into newsletter.consent_version (regime, asset_id, version_label, legal_text, text_hash, effective_from)
select c.regime, a.id, c.version_label, c.legal_text, c.text_hash, now()
  from newsletter.asset a,
       newsletter.consent_version c
       join newsletter.asset m on m.id = c.asset_id
 where a.slug = 'pixel-daily'
   and m.slug = 'northwind-sports' and c.version_label = 'example-2026-07' and c.regime = 'lgpd';

-- Contre-épreuves
do $$
declare
  n int;
  v_asset uuid;
  v_hash_o text;
  v_hash_n text;
  v_pied jsonb;
  v_pied_n jsonb;
begin
  -- 1. Une marque, et une seule, aux valeurs d'avant 0045.
  select count(*) into n from newsletter.asset
   where slug = 'pixel-daily' and name = 'Pixel Daily' and market = 'BR'
     and languages = '{pt-BR}' and sending_subdomain = 'news.pixel-daily.example';
  if n <> 1 then raise exception '[0089] marque pixel-daily : % lignes conformes, 1 attendue', n; end if;
  select id into v_asset from newsletter.asset where slug = 'pixel-daily';

  -- 2. Une édition, primaire, brésilienne, LGPD.
  select count(*) into n from newsletter.asset_edition
   where asset_id = v_asset and is_primary and slug = 'pt-br' and market = 'BR' and language = 'pt-BR'
     and compliance_regime = 'lgpd' and consent_mode = 'single' and data_residency = 'br'
     and timezone = 'America/Sao_Paulo';
  if n <> 1 then raise exception '[0089] edition pixel-daily : % lignes conformes, 1 attendue', n; end if;
  select count(*) into n from newsletter.asset_edition where asset_id = v_asset;
  if n <> 1 then raise exception '[0089] pixel-daily porte % editions, 1 attendue', n; end if;

  -- 3. Le pied légal : celui de Northwind Sports, seule l'URL de confidentialité change.
  select legal_footer into v_pied from newsletter.asset_edition where asset_id = v_asset;
  select e.legal_footer into v_pied_n from newsletter.asset_edition e join newsletter.asset m on m.id = e.asset_id
   where m.slug = 'northwind-sports' and e.is_primary;
  if v_pied ->> 'privacy_url' is distinct from 'https://pixel-daily.example/privacidade'
     or (v_pied - 'privacy_url') is distinct from (v_pied_n - 'privacy_url')
     or v_pied ->> 'controller' is null then
    raise exception '[0089] pied legal inattendu : %', v_pied;
  end if;

  -- 4. Le consentement : une version, le MÊME texte que Northwind Sports (même empreinte).
  select count(*) into n from newsletter.consent_version where asset_id = v_asset;
  if n <> 1 then raise exception '[0089] pixel-daily porte % versions de consentement, 1 attendue', n; end if;
  select text_hash into v_hash_o from newsletter.consent_version where asset_id = v_asset;
  select c.text_hash into v_hash_n from newsletter.consent_version c join newsletter.asset m on m.id = c.asset_id
   where m.slug = 'northwind-sports' and c.version_label = 'example-2026-07' and c.regime = 'lgpd';
  if v_hash_o is null or v_hash_o is distinct from v_hash_n then
    raise exception '[0089] texte de consentement different de celui de Northwind Sports';
  end if;

  -- 5. Une marque NEUVE : rien ne lui est encore rattaché.
  select count(*) into n from newsletter.subscription where asset_id = v_asset;
  if n <> 0 then raise exception '[0089] % souscriptions deja sur pixel-daily', n; end if;

  -- 6. Les deux autres marques de 0045 restent retirées.
  select count(*) into n from newsletter.asset where slug in ('bluefin-news', 'lumen-living');
  if n <> 0 then raise exception '[0089] bluefin-news ou lumen-living reapparu (% lignes)', n; end if;

  raise notice '[0089] contre-epreuve OK : pixel-daily recreee (1 edition pt-br LGPD, pied de Northwind Sports + URL Pixel Daily, texte de consentement commun), bluefin-news et lumen-living toujours retires';
end
$$;

notify pgrst, 'reload schema';

-- ⛔ EN DERNIÈRE INSTRUCTION, ET APRÈS LA CONTRE-ÉPREUVE (voir 0072).
insert into newsletter.applied_migration (version, filename, applied_at, backfilled)
values ('0089', '0089_recreer_pixel_daily.sql', now(), false)
on conflict (version) do update
   set applied_at = excluded.applied_at,
       backfilled = false;
