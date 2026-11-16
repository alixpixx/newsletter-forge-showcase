-- 0059 — Deux choses, et la première répare la seconde avant qu'elle ne serve.
--
--  1. `sunsetted_subscription` : rétablir le COMPLÉMENT EXACT de la barrière d'envoi, que 0057 a
--     cassé sans le voir.
--  2. `lifecycle_template` : rattacher un template publié à un `kind` du cycle de vie, avec repli
--     inconditionnel sur le HTML en dur — plus la jonction dans `outbox_context` qui le sert.
--
-- ============================================================================================
-- 1 — LE COMPLÉMENT REDEVIENT EXACT
-- ============================================================================================
--
-- 0057 a ajouté `sunset_at is null` à `sendable_subscription`. Sa vue jumelle
-- `excluded_demo_subscription` n'a PAS compensé — et elle ne le devait pas : son métier est « les
-- contacts de démonstration actifs », pas « tout ce que la barrière écarte ».
--
-- ⛔ Conséquence non vue à l'époque : un abonné RÉEL marqué `sunset_at` n'est dans NI l'une NI
-- l'autre. Or DEUX écrans comptent l'un puis l'autre et disent, en commentaire,
-- « le COMPLÉMENT EXACT de la barrière d'envoi » :
--   · apps/admin/src/app/api/segments/count/route.ts (le compteur d'un segment en cours d'écriture)
--   · apps/admin/src/lib/data/campaigns.ts            (l'estimation d'audience d'une campagne)
-- Ils affichent ce second chiffre précisément pour qu'un zéro soit LISIBLE. Depuis 0057, l'écran
-- peut dire « 0 destinataire, 0 écarté par démonstration » sans dire pourquoi — et un zéro qu'on
-- n'explique pas se lit comme une panne de la règle qu'on est en train d'écrire.
--
-- Le filtre ajouté en amont a affamé l'explication en aval. On ne le retire pas (il est juste) :
-- on rend visible ce qu'il écarte, dans une troisième vue qui NOMME sa raison.
--
-- ⚠️ Invisible aujourd'hui : 0 abonnement sur 1 203 porte un `sunset_at`. C'est exactement pour
-- cela qu'on répare maintenant — avant que quoi que ce soit en pose un.
--
-- Les trois vues partitionnent désormais les abonnements actifs non supprimés :
--   sendable_subscription      : réels, non marqués      → on écrit
--   excluded_demo_subscription : démonstration           → on n'écrit pas, ce sont de faux contacts
--   sunsetted_subscription     : réels, marqués          → on n'écrit plus, mais ils sont ABONNÉS
--
-- ⛔ `sunsetted_subscription` porte `not sub.is_demo` : sans lui, un contact de démonstration
-- marqué serait compté DEUX fois (ici et dans la vue démo), et la somme des trois dépasserait le
-- total. Un chiffre trop grand ne se remarque pas plus qu'un chiffre trop petit.
create or replace view newsletter.sunsetted_subscription as
  select s.id, s.subscriber_id, s.asset_id, s.edition_id, s.status, s.source, s.source_detail,
         s.language, s.consent_state, s.consent_version_id, s.consent_ip, s.consent_method,
         s.consent_at, s.open_count, s.click_count, s.last_open_at, s.last_click_at,
         s.last_engagement_at, s.engagement_score, s.engagement_level, s.welcome_completed,
         s.soft_bounce_count, s.tag_ids, s.created_at, s.country, s.tracking_consent,
         s.tracking_consent_at, s.granted_purposes, s.optin_id, s.sunset_at
    from newsletter.subscription s
    join newsletter.subscriber sub on sub.id = s.subscriber_id
   where s.status = 'active'
     and not newsletter.is_suppressed(sub.email::text, s.asset_id)
     and not sub.is_demo
     and s.sunset_at is not null;

comment on view newsletter.sunsetted_subscription is
  'Abonnés RÉELS, actifs et consentants, que le sunset a écartés des envois. Troisième part de la '
  'partition avec sendable_subscription et excluded_demo_subscription : leur somme fait les '
  'abonnements actifs non supprimés. Sert à expliquer un zéro, jamais à envoyer.';

grant select on newsletter.sunsetted_subscription to service_role;

-- ============================================================================================
-- 2 — `lifecycle_template` : les e-mails du cycle de vie deviennent éditables
-- ============================================================================================
--
-- Aujourd'hui `confirmation`, `welcome`, `unsubscribe_ack` et `reengagement` sont du HTML écrit en
-- dur dans le code (packages/email/src/templates.ts et apps/worker/src/render.ts). Changer un mot
-- exige un déploiement. Cette table permet de désigner, PAR MARQUE, un template publié du builder
-- qui prendra la place du code — sans jamais pouvoir empêcher l'envoi.
--
-- ⛔ POURQUOI `template_id` ET NON `template_version_id`, contrairement au plan du 08/09.
-- Le plan disait de rattacher une VERSION. Deux raisons de ne pas le faire, et elles sont fortes :
--   1. Publier une correction n'aurait AUCUN effet. Le rattachement continuerait de pointer la
--      version d'avant ; l'auteur corrige une faute, republie, voit « publié » — et l'e-mail ne
--      change pas. Un défaut silencieux, du genre qu'on met des semaines à voir.
--   2. Le contrôle à la publication ne pourrait jamais mordre. Au moment où l'on publie, la
--      version n+1 n'est encore rattachée à rien : on ne saurait pas qu'elle se destine à une
--      `confirmation`, donc on ne saurait pas exiger `{{confirm_url}}`. En pointant le TEMPLATE,
--      le rattachement est stable et le contrôle sait à quoi il a affaire, à chaque publication.
-- Le worker suit donc `template.current_version_id` : ce qui est publié est ce qui part.
--
-- ⛔ Le rattachement doit rester DANS la marque. Une FK simple sur `template(id)` laisserait
-- rattacher le template d'une autre marque — l'e-mail de confirmation de northwind-sports partirait sous
-- l'identité de quartz-tips. On passe donc par une clé composite `(id, asset_id)`, ce qui rend
-- l'erreur impossible plutôt que surveillée.
alter table newsletter.template
  drop constraint if exists uq_template_id_asset;
alter table newsletter.template
  add constraint uq_template_id_asset unique (id, asset_id);

create table if not exists newsletter.lifecycle_template (
  asset_id    uuid not null references newsletter.asset(id) on delete cascade,
  kind        text not null,
  template_id uuid not null,
  updated_by  text,
  updated_at  timestamptz not null default now(),
  primary key (asset_id, kind),
  constraint lifecycle_template_kind_check
    check (kind in ('confirmation', 'welcome', 'unsubscribe_ack', 'reengagement')),
  constraint lifecycle_template_same_asset
    foreign key (template_id, asset_id)
    references newsletter.template(id, asset_id) on delete cascade
);

comment on table newsletter.lifecycle_template is
  'Quel template du builder sert pour quel e-mail de cycle de vie, par marque. Absent, archivé ou '
  'jamais publié ⇒ le worker retombe sur le HTML en dur. Le repli n''est pas un confort : un '
  'e-mail de confirmation qui ne part pas, c''est une inscription perdue ET un consentement non '
  'prouvé.';
comment on column newsletter.lifecycle_template.kind is
  'Le kind d''email_outbox servi. Les quatre kinds NON éditoriaux : campaign et test gardent leur '
  'propre chemin (email_outbox.template_version_id), ils ne passent pas par ici.';
comment on column newsletter.lifecycle_template.template_id is
  'Le TEMPLATE, pas une version : republier une correction doit la mettre en service. Le worker '
  'lit template.current_version_id.';

alter table newsletter.lifecycle_template enable row level security;
grant select, insert, update, delete on newsletter.lifecycle_template to service_role;

-- ============================================================================================
-- 3 — `outbox_context` sert le shell du cycle de vie
-- ============================================================================================
--
-- ⛔ La résolution est faite ICI, pas côté worker. La vue joint déjà l'asset, l'abonnement,
-- l'édition, le template, la campagne et l'occurrence : ajouter une requête par e-mail dans le
-- worker rendrait la file N+1 et ferait diverger deux façons de trouver « le contenu à envoyer ».
--
-- ⛔ La résolution se fait au RENDU, pas à l'enfilement. Une ligne d'outbox de cycle de vie ne
-- fige pas `template_version_id` : si le rattachement disparaît entre l'enfilement et l'envoi, ou
-- si le template est archivé, la colonne rendue est NULL et le worker retombe sur le code en dur.
-- Figer une version à l'enfilement produirait l'inverse : une ligne pointant une version qu'on a
-- pu dépublier, donc un e-mail qu'on ne sait plus rendre.
--
-- ⚠️ `create or replace view` REFUSE d'ajouter une colonne ailleurs qu'à la fin, et refuse tout
-- changement d'ordre : les trois nouvelles sont donc en dernier, après `campaign_ai_preheader`.
-- Le corps est celui de 0055, recopié à l'identique — toute divergence ici serait invisible.
create or replace view newsletter.outbox_context as
select
  o.id, o.kind, o.subject, o.action_url, o.payload, o.to_email,
  o.status, o.attempts, o.max_attempts, o.next_attempt_at, o.created_at,
  o.asset_id, o.subscription_id,
  a.name  as asset_name,
  a.slug  as asset_slug,
  coalesce(e.sending_subdomain, a.sending_subdomain) as sending_subdomain,
  e.compliance_regime,
  e.legal_footer,
  e.language,
  s.status        as sub_status,
  s.subscriber_id as subscriber_id,
  s.tracking_consent,
  newsletter.is_suppressed(o.to_email::text, o.asset_id) as suppressed,
  o.purpose,
  e.market,
  e.consent_mode,
  s.granted_purposes,
  o.campaign_id,
  o.template_version_id,
  tv.html_shell as template_html_shell,
  tv.text_shell as template_text_shell,
  c.html_shell  as campaign_html_shell,
  c.text_shell  as campaign_text_shell,
  o.occurrence_id,
  occ.html_shell as occurrence_html_shell,
  occ.text_shell as occurrence_text_shell,
  occ.status     as occurrence_status,
  occ.seq        as occurrence_seq,
  occ.local_date as occurrence_local_date,
  -- Appendues par 0050.
  c.name as campaign_name,
  -- Le jour LOCAL voulu de la campagne, pour les envois sans occurrence. Le rendu s'en sert
  -- uniquement en repli : quand une occurrence existe, c'est SA date qui fait foi.
  (c.scheduled_at at time zone coalesce(c.timezone, 'UTC'))::date as campaign_local_date,
  occ.first_article_title as occurrence_first_article,
  occ.article_count       as occurrence_article_count,
  -- Appendues par 0055. Même ordre de priorité que le shell : l'occurrence d'abord, la campagne
  -- en repli — une ligne d'outbox porte l'une OU l'autre, jamais les deux valeurs à la fois.
  occ.ai_intro     as occurrence_ai_intro,
  occ.ai_preheader as occurrence_ai_preheader,
  c.ai_intro       as campaign_ai_intro,
  c.ai_preheader   as campaign_ai_preheader,
  -- Appendues par 0059. NULL ⇒ le worker rend le HTML en dur, et c'est un état NORMAL, pas une
  -- panne : c'est le cas de toutes les marques qui n'ont rien rattaché.
  ltv.html_shell as lifecycle_html_shell,
  ltv.text_shell as lifecycle_text_shell,
  ltv.subject    as lifecycle_subject
from newsletter.email_outbox o
left join newsletter.asset a         on a.id = o.asset_id
left join newsletter.subscription s  on s.id = o.subscription_id
left join newsletter.template_version tv on tv.id = o.template_version_id
left join newsletter.campaign c      on c.id = o.campaign_id
left join newsletter.campaign_occurrence occ on occ.id = o.occurrence_id
-- Le rattachement de cycle de vie. Trois conditions, chacune retire un cas où l'on servirait un
-- contenu qui n'est pas prêt : le template doit exister et ne pas être archivé, il doit avoir une
-- version courante, et cette version doit être PUBLIÉE (jamais le brouillon, qui est la version 0
-- et change à chaque frappe de l'auteur).
left join newsletter.lifecycle_template lt
       on lt.asset_id = o.asset_id and lt.kind = o.kind
left join newsletter.template lft
       on lft.id = lt.template_id and lft.archived_at is null
left join newsletter.template_version ltv
       on ltv.id = lft.current_version_id and ltv.status = 'published'
left join lateral (
  select ed.*
    from newsletter.asset_edition ed
   where ed.asset_id = o.asset_id
   order by (ed.id = s.edition_id) desc nulls last, ed.id
   limit 1
) e on true;

grant select on newsletter.outbox_context to service_role;

notify pgrst, 'reload schema';
