-- ============================================================================
-- 0097 — Créer la marque Fabrikam (envoi depuis commercial.fabrikam-partners.example)
--
-- Décision d'Alix, 02/11/2026 : « le nouveau mail c'est commercial.fabrikam-partners.example »,
-- puis, question par question : anglais + RGPD, responsable Example Media Ltd,
-- confidentialité https://fabrikam-partners.example/privacy-policy. Une marque n'a pas d'écran
-- de création : elle naît par migration, comme Pixel Daily (0089).
--
-- CE QUI EST CRÉÉ, ET SUR QUEL MODÈLE. Les trois lignes de configuration qu'une
-- marque anglaise RGPD porte aujourd'hui, relevées le 02/11 sur Goalpost
-- Weekly (même langue, même régime) :
--   asset            fabrikam · Fabrikam · GB · {en} · commercial.fabrikam-partners.example ;
--                    tracking_mode au défaut `all`, comme Goalpost Weekly
--   asset_edition    `en`, GB, en, RGPD, consentement `single`, primaire,
--                    Europe/London, résidence `eu` — le pied légal de Goalpost
--                    Weekly, seule l'URL de confidentialité change
--   consent_version  le texte RGPD Example Media `example-2026-07`, COPIÉ de Goalpost
--                    Weekly : mesuré le 02/11, le texte est commun (1 empreinte
--                    pour Goalpost Weekly, Harbor Tech, Atlas Review) et ne nomme
--                    aucune marque
--
-- CE QUI N'EST PAS CRÉÉ, À DESSEIN (comme 0089) : aucun accès
-- (`app_user_asset`), aucune source WordPress, aucun template, aucun pied de
-- marque — l'écran les pose, et rien de tout cela n'est nécessaire pour
-- recevoir des inscrits.
--
-- BRANCHEMENT OPTINFORGE. Un site optinforge sur fabrikam-partners.example se branche seul sur
-- cette marque au premier lead (GET /api/v1/assets, domaine d'envoi = sous-domaine
-- du site). Il faut pour cela UNE SEULE marque sous fabrikam-partners.example : contre-épreuve 6.
--
-- ⚠️ LE DOMAINE D'ENVOI EST EN RÉGION EU CHEZ MAILGUN LE 02/11 (MX
--    mxa/mxb.eu.mailgun.org, CNAME eu.mailgun.org) alors que le worker envoie en
--    US. Alix le recrée en US. Aucun envoi de cette marque avant ce contrôle.
-- ============================================================================

insert into newsletter.asset (slug, name, market, languages, sending_subdomain)
values ('fabrikam', 'Fabrikam', 'GB', '{en}', 'commercial.fabrikam-partners.example');

insert into newsletter.asset_edition
  (asset_id, slug, market, language, compliance_regime, consent_mode, is_primary,
   timezone, data_residency, legal_footer)
select a.id, 'en', 'GB', 'en', 'gdpr', 'single', true,
       'Europe/London', 'eu',
       modele.legal_footer || jsonb_build_object('privacy_url', 'https://fabrikam-partners.example/privacy-policy')
  from newsletter.asset a,
       (select e.legal_footer
          from newsletter.asset_edition e
          join newsletter.asset m on m.id = e.asset_id
         where m.slug = 'goalpost-weekly' and e.is_primary) as modele
 where a.slug = 'fabrikam';

insert into newsletter.consent_version (regime, asset_id, version_label, legal_text, text_hash, effective_from)
select c.regime, a.id, c.version_label, c.legal_text, c.text_hash, now()
  from newsletter.asset a,
       newsletter.consent_version c
       join newsletter.asset m on m.id = c.asset_id
 where a.slug = 'fabrikam'
   and m.slug = 'goalpost-weekly' and c.version_label = 'example-2026-07' and c.regime = 'gdpr';

-- Contre-épreuves
do $$
declare
  n int;
  v_asset uuid;
  v_hash_a text;
  v_hash_f text;
  v_pied jsonb;
  v_pied_f jsonb;
begin
  -- 1. Une marque, et une seule, aux valeurs décidées.
  select count(*) into n from newsletter.asset
   where slug = 'fabrikam' and name = 'Fabrikam' and market = 'GB' and languages = '{en}'
     and sending_subdomain = 'commercial.fabrikam-partners.example' and tracking_mode = 'all';
  if n <> 1 then raise exception '[0097] marque fabrikam : % lignes conformes, 1 attendue', n; end if;
  select id into v_asset from newsletter.asset where slug = 'fabrikam';

  -- 2. Une édition, primaire, anglaise, RGPD.
  select count(*) into n from newsletter.asset_edition
   where asset_id = v_asset and is_primary and slug = 'en' and market = 'GB' and language = 'en'
     and compliance_regime = 'gdpr' and consent_mode = 'single' and data_residency = 'eu'
     and timezone = 'Europe/London' and sending_subdomain is null;
  if n <> 1 then raise exception '[0097] edition fabrikam : % lignes conformes, 1 attendue', n; end if;
  select count(*) into n from newsletter.asset_edition where asset_id = v_asset;
  if n <> 1 then raise exception '[0097] fabrikam porte % editions, 1 attendue', n; end if;

  -- 3. Le pied légal : celui de Goalpost Weekly, seule l'URL de confidentialité change.
  select legal_footer into v_pied from newsletter.asset_edition where asset_id = v_asset;
  select e.legal_footer into v_pied_f from newsletter.asset_edition e join newsletter.asset m on m.id = e.asset_id
   where m.slug = 'goalpost-weekly' and e.is_primary;
  if v_pied ->> 'privacy_url' is distinct from 'https://fabrikam-partners.example/privacy-policy'
     or (v_pied - 'privacy_url') is distinct from (v_pied_f - 'privacy_url')
     or v_pied ->> 'controller' is distinct from 'Example Media Ltd' then
    raise exception '[0097] pied legal inattendu : %', v_pied - 'dpo_contact';
  end if;

  -- 4. Le consentement : une version, le MÊME texte que Goalpost Weekly (même empreinte).
  select count(*) into n from newsletter.consent_version where asset_id = v_asset;
  if n <> 1 then raise exception '[0097] fabrikam porte % versions de consentement, 1 attendue', n; end if;
  select text_hash into v_hash_a from newsletter.consent_version where asset_id = v_asset;
  select c.text_hash into v_hash_f from newsletter.consent_version c join newsletter.asset m on m.id = c.asset_id
   where m.slug = 'goalpost-weekly' and c.version_label = 'example-2026-07' and c.regime = 'gdpr';
  if v_hash_a is null or v_hash_a is distinct from v_hash_f then
    raise exception '[0097] texte de consentement different de celui de Goalpost Weekly';
  end if;

  -- 5. Une marque NEUVE : rien ne lui est encore rattaché.
  select count(*) into n from newsletter.subscription where asset_id = v_asset;
  if n <> 0 then raise exception '[0097] % souscriptions deja sur fabrikam', n; end if;

  -- 6. Une seule marque sous fabrikam-partners.example, sinon le branchement optinforge refuse de choisir.
  select count(*) into n from newsletter.asset
   where sending_subdomain = 'fabrikam-partners.example' or sending_subdomain like '%.fabrikam-partners.example';
  if n <> 1 then raise exception '[0097] % marques sous fabrikam-partners.example, 1 attendue', n; end if;

  raise notice '[0097] contre-epreuve OK : fabrikam creee (commercial.fabrikam-partners.example, 1 edition en RGPD, pied de Goalpost Weekly + URL Fabrikam, texte de consentement commun)';
end
$$;

notify pgrst, 'reload schema';

-- ⛔ EN DERNIÈRE INSTRUCTION, ET APRÈS LA CONTRE-ÉPREUVE (voir 0072).
insert into newsletter.applied_migration (version, filename, applied_at, backfilled)
values ('0097', '0097_creer_marque_fabrikam.sql', now(), false)
on conflict (version) do update
   set applied_at = excluded.applied_at,
       backfilled = false;
