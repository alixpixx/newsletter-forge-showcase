-- newsletter-forge · fuseaux réels des éditions (correctif du seed 0007).
--
-- POURQUOI. 0007 dérivait le fuseau du seul marché et rangeait tout ce qui n'était ni BR ni CL
-- sous 'UTC'. Or UTC n'est l'heure locale de personne : une édition programmée « samedi 9h »
-- part à 10h à Londres l'été et à 8h à Rome l'hiver. Tant que rien n'est envoyé, le défaut passe
-- inaperçu ; l'aperçu de calendrier de la récurrence, lui, mentirait dès sa première ligne. Il
-- faut un identifiant IANA porteur du changement d'heure, pas un décalage fixe de convenance.
--
-- RÈGLE DE RÉSOLUTION, dans cet ordre :
--   1. le marché quand il désigne un pays — c'est l'intention la plus explicite de l'édition ;
--   2. sinon la langue : sur le marché 'INT', qui ne désigne aucun pays, elle reste le seul
--      indice de l'endroit où les lecteurs ouvrent leur boîte.
-- Marchés et langues sont ceux du registre réel (packages/config/src/assets.ts) ; les
-- combinaisons pas encore présentes en base sont des no-op, même parti pris qu'en 0014.
--
-- CAS 'INT'. Une seule édition réelle le porte : Atlas Review. Son édition primaire est en 'it'
-- (0007 prend `languages[1]`) et le registre place IT en tête de ses marchés servis — son
-- audience primaire est italienne. Europe/Rome, donc, et non un UTC qui ne serait l'heure
-- d'aucun de ses lecteurs. Le jour où Atlas Review ouvrira ses éditions fr/es/pt-BR, chacune
-- portera son propre marché et retombera sur la branche 1.
--
-- IDEMPOTENCE. Seules les lignes encore à 'UTC' sont touchées : un second passage ne trouve plus
-- rien, et aucune valeur déjà posée (America/Sao_Paulo, America/Santiago, ou un fuseau choisi
-- dans l'admin) n'est écrasée. Limite assumée : la colonne a 'UTC' pour défaut, donc une édition
-- qui voudrait VRAIMENT UTC est indiscernable d'une édition jamais réglée — elle sera déplacée.

with fuseau as (
  select
    e.id,
    coalesce(
      -- 1. Le marché nomme un pays.
      case e.market
        when 'GB' then 'Europe/London'
        when 'IT' then 'Europe/Rome'
        when 'FR' then 'Europe/Paris'
        when 'ES' then 'Europe/Madrid'
        when 'SE' then 'Europe/Stockholm'
        when 'NG' then 'Africa/Lagos'
        when 'CL' then 'America/Santiago'
        when 'BR' then 'America/Sao_Paulo'
        when 'MX' then 'America/Mexico_City'
        when 'AR' then 'America/Argentina/Buenos_Aires'
        when 'PE' then 'America/Lima'
        -- US et CA couvrent plusieurs fuseaux : on prend la côte est, où vit l'essentiel de
        -- l'audience visée, à réviser si une édition y naît vraiment.
        when 'US' then 'America/New_York'
        when 'CA' then 'America/Toronto'
      end,
      -- 2. Marché 'INT' : la langue sert de proxy d'audience.
      case e.language
        when 'it'    then 'Europe/Rome'
        when 'fr'    then 'Europe/Paris'
        when 'sv'    then 'Europe/Stockholm'
        when 'pt-BR' then 'America/Sao_Paulo'
        -- L'espagnol des marchés latino-américains est déjà capté en 1 ; ce qui arrive ici est
        -- l'espagnol sans pays, qu'on rattache à l'Espagne.
        when 'es'    then 'Europe/Madrid'
        -- Anglais sans pays : les deux marques anglophones du parc sont britanniques.
        when 'en'    then 'Europe/London'
      end
    ) as tz
  from newsletter.asset_edition e
  where e.timezone = 'UTC'
)
update newsletter.asset_edition e
   set timezone = f.tz
  from fuseau f
 where f.id = e.id
   and f.tz is not null;

-- Contrôle à l'application : plus aucune ligne ne doit rester sur 'UTC'.
select a.slug, e.market, e.language, e.timezone
  from newsletter.asset_edition e
  join newsletter.asset a on a.id = e.asset_id
 order by e.timezone, a.slug;
