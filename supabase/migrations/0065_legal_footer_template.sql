-- 0065 — Pieds légaux réutilisables (« legal footer template »).
--
-- LE BESOIN (Alix, 16/09) : créer autant de pieds légaux qu'on veut par marque, puis
-- en choisir un dans le builder, au même titre qu'un header ou un footer.
--
-- CE QU'UN TEMPLATE LÉGAL PORTE : la `FooterConfig` entière (identité, adresse,
-- confidentialité, DPO, jeu responsable, habillage) — exactement ce que porte déjà
-- `asset_edition.legal_footer`. CE QU'IL NE PORTE JAMAIS : les liens de désinscription
-- et de préférences. Ils sont signés par destinataire et calculés par le worker ; une
-- seconde source pour ces liens serait une copie non signée.
--
-- ⛔ POURQUOI UN POINTEUR VIVANT ET PAS UNE COPIE FIGÉE À LA PUBLICATION. Le pied
-- d'édition est déjà lu EN DIRECT par la vue d'envoi : corriger une adresse suffit, sans
-- republier. Figer la config du template dans la version publiée aurait fait d'un
-- template légal le seul pied qu'on corrige sans que la correction parte — une adresse
-- fausse continuerait d'être expédiée, sans rien pour le signaler.
--
-- ⛔ POURQUOI LE WORKER NE CHANGE PAS. Il lit `outbox_context.legal_footer`. Cette
-- migration change ce que la COLONNE contient (le template choisi, sinon l'édition), pas
-- son nom, son type ni sa place : les deux chemins de rendu (`renderBuilder`,
-- `renderLifecycle`) et la barrière `gate.ts` en profitent sans une ligne de code.

create table if not exists newsletter.legal_footer_template (
  id          uuid primary key default gen_random_uuid(),
  -- Même invariant de marque que `brand_partial` : un pied légal nomme une entité
  -- juridique, il ne se partage pas entre marques.
  asset_id    uuid not null references newsletter.asset(id) on delete cascade,
  name        text not null,
  -- Validée par `validerConfig` (liste fermée `FOOTER_FIELDS`, longueurs bornées) à
  -- l'écriture. Le `check` ne fait qu'interdire ce que `buildFooter` ne sait pas lire.
  config      jsonb not null check (jsonb_typeof(config) = 'object'),
  -- On n'efface pas, on archive : des versions publiées pointent peut-être dessus.
  archived_at timestamptz,
  updated_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Filtrée sur `archived_at`, comme `uq_brand_partial_nom` : archiver libère le nom.
create unique index if not exists uq_legal_footer_template_nom
  on newsletter.legal_footer_template (asset_id, name)
  where archived_at is null;

alter table newsletter.legal_footer_template enable row level security;
grant all on newsletter.legal_footer_template to service_role;

comment on table newsletter.legal_footer_template is
  'Pied légal réutilisable d''une marque (FooterConfig). Choisi dans le builder ; la publication pose template_version.legal_footer_template_id et la vue outbox_context le lit EN DIRECT. Jamais les liens de désinscription.';

-- Posée par la PUBLICATION (et par l'envoi de test, sur le brouillon). Nulle = le pied
-- de l'édition, c'est-à-dire le comportement d'avant cette migration.
--
-- ⚠️ `no action` (le défaut) et non `restrict` : supprimer une marque supprime en
-- cascade ses modèles ET ses pieds légaux dans la même instruction. `restrict` vérifie
-- tout de suite, avant que les versions soient parties, et ferait échouer la cascade ;
-- `no action` vérifie en fin d'instruction. Un DELETE isolé d'un template encore
-- référencé reste refusé.
alter table newsletter.template_version
  add column if not exists legal_footer_template_id uuid
    references newsletter.legal_footer_template(id);

comment on column newsletter.template_version.legal_footer_template_id is
  'Pied légal choisi pour cette version (bloc footer_legal, legalTemplateId). Nul = pied de l''édition.';

-- La vue d'envoi. IDENTIQUE à la définition en production le 16/09 (relue par
-- pg_get_viewdef), à UNE colonne près : `legal_footer`.
--
-- ⛔ LE KIND DÉCIDE DE QUELLE VERSION ON LIT LE CHOIX, et ce ne sont pas les mêmes :
--  - `test` et `campaign` sont rendus depuis `tv` (la version pointée par la ligne) ;
--  - les kinds du cycle de vie sont rendus depuis `ltv` (la version publiée du modèle
--    rattaché), leur `template_version_id` n'étant pas celui qui sert au rendu.
-- Prendre le choix d'une version et le shell d'une autre enverrait un pied que
-- l'auteur n'a jamais vu à l'aperçu.
--
-- ⛔ PAS DE FILTRE `archived_at` sur le template : archiver le retire de la bibliothèque,
-- ça ne doit pas changer le pied des e-mails qui l'utilisent déjà.
--
-- ⛔ LA JOINTURE EST GARDÉE PAR `asset_id`. Un id d'une autre marque posé sur une version
-- (la route le refuse, mais la base ne le sait pas) retombe sur le pied de l'édition au
-- lieu d'expédier l'entité juridique d'une autre marque.
create or replace view newsletter.outbox_context as
 SELECT o.id,
    o.kind,
    o.subject,
    o.action_url,
    o.payload,
    o.to_email,
    o.status,
    o.attempts,
    o.max_attempts,
    o.next_attempt_at,
    o.created_at,
    o.asset_id,
    o.subscription_id,
    a.name AS asset_name,
    a.slug AS asset_slug,
    COALESCE(e.sending_subdomain, a.sending_subdomain) AS sending_subdomain,
    e.compliance_regime,
    CASE
      WHEN o.kind IN ('test', 'campaign') THEN COALESCE(lft_tv.config, e.legal_footer)
      ELSE COALESCE(lft_lc.config, e.legal_footer)
    END AS legal_footer,
    e.language,
    s.status AS sub_status,
    s.subscriber_id,
    s.tracking_consent,
    newsletter.is_suppressed(o.to_email::text, o.asset_id) AS suppressed,
    o.purpose,
    e.market,
    e.consent_mode,
    s.granted_purposes,
    o.campaign_id,
    o.template_version_id,
    tv.html_shell AS template_html_shell,
    tv.text_shell AS template_text_shell,
    c.html_shell AS campaign_html_shell,
    c.text_shell AS campaign_text_shell,
    o.occurrence_id,
    occ.html_shell AS occurrence_html_shell,
    occ.text_shell AS occurrence_text_shell,
    occ.status AS occurrence_status,
    occ.seq AS occurrence_seq,
    occ.local_date AS occurrence_local_date,
    c.name AS campaign_name,
    (c.scheduled_at AT TIME ZONE COALESCE(c.timezone, 'UTC'::text))::date AS campaign_local_date,
    occ.first_article_title AS occurrence_first_article,
    occ.article_count AS occurrence_article_count,
    occ.ai_intro AS occurrence_ai_intro,
    occ.ai_preheader AS occurrence_ai_preheader,
    c.ai_intro AS campaign_ai_intro,
    c.ai_preheader AS campaign_ai_preheader,
    ltv.html_shell AS lifecycle_html_shell,
    ltv.text_shell AS lifecycle_text_shell,
    ltv.subject AS lifecycle_subject
   FROM newsletter.email_outbox o
     LEFT JOIN newsletter.asset a ON a.id = o.asset_id
     LEFT JOIN newsletter.subscription s ON s.id = o.subscription_id
     LEFT JOIN newsletter.template_version tv ON tv.id = o.template_version_id
     LEFT JOIN newsletter.campaign c ON c.id = o.campaign_id
     LEFT JOIN newsletter.campaign_occurrence occ ON occ.id = o.occurrence_id
     LEFT JOIN newsletter.lifecycle_template lt ON lt.asset_id = o.asset_id AND lt.kind = o.kind
     LEFT JOIN newsletter.template lft ON lft.id = lt.template_id AND lft.archived_at IS NULL
     LEFT JOIN newsletter.template_version ltv ON ltv.id = lft.current_version_id AND ltv.status = 'published'::text
     LEFT JOIN newsletter.legal_footer_template lft_tv
       ON lft_tv.id = tv.legal_footer_template_id AND lft_tv.asset_id = o.asset_id
     LEFT JOIN newsletter.legal_footer_template lft_lc
       ON lft_lc.id = ltv.legal_footer_template_id AND lft_lc.asset_id = o.asset_id
     LEFT JOIN LATERAL ( SELECT ed.id,
            ed.asset_id,
            ed.market,
            ed.language,
            ed.compliance_regime,
            ed.data_residency,
            ed.timezone,
            ed.branding,
            ed.legal_footer,
            ed.sending_subdomain,
            ed.wp_connection_id,
            ed.created_at,
            ed.consent_mode,
            ed.proof_retention_years,
            ed.slug,
            ed.is_primary
           FROM newsletter.asset_edition ed
          WHERE ed.asset_id = o.asset_id
          ORDER BY (ed.id = s.edition_id) DESC NULLS LAST, ed.id
         LIMIT 1) e ON true;

-- Assertion sur le CATALOGUE : la vue doit exposer exactement les mêmes colonnes, dans
-- le même ordre, qu'avant. Le worker lit par nom ; un décalage passerait inaperçu
-- jusqu'au premier envoi.
do $$
declare
  v_cols text;
  v_type text;
begin
  select string_agg(attname, ',' order by attnum)
    into v_cols
    from pg_attribute
   where attrelid = 'newsletter.outbox_context'::regclass and attnum > 0 and not attisdropped;

  if v_cols is distinct from 'id,kind,subject,action_url,payload,to_email,status,attempts,max_attempts,next_attempt_at,created_at,asset_id,subscription_id,asset_name,asset_slug,sending_subdomain,compliance_regime,legal_footer,language,sub_status,subscriber_id,tracking_consent,suppressed,purpose,market,consent_mode,granted_purposes,campaign_id,template_version_id,template_html_shell,template_text_shell,campaign_html_shell,campaign_text_shell,occurrence_id,occurrence_html_shell,occurrence_text_shell,occurrence_status,occurrence_seq,occurrence_local_date,campaign_name,campaign_local_date,occurrence_first_article,occurrence_article_count,occurrence_ai_intro,occurrence_ai_preheader,campaign_ai_intro,campaign_ai_preheader,lifecycle_html_shell,lifecycle_text_shell,lifecycle_subject' then
    raise exception 'outbox_context : colonnes modifiees : %', v_cols;
  end if;

  select format_type(atttypid, atttypmod)
    into v_type
    from pg_attribute
   where attrelid = 'newsletter.outbox_context'::regclass and attname = 'legal_footer';
  if v_type <> 'jsonb' then
    raise exception 'outbox_context.legal_footer : type % au lieu de jsonb', v_type;
  end if;

  -- `coalesce` : un index absent rend NULL, et `NULL not like …` ne lève rien.
  if coalesce((select pg_get_expr(i.indpred, i.indrelid)
                 from pg_index i join pg_class c on c.oid = i.indexrelid
                where c.relname = 'uq_legal_footer_template_nom'), '') not like '%archived_at%' then
    raise exception 'uq_legal_footer_template_nom : index absent ou non filtre sur archived_at';
  end if;
end
$$;

notify pgrst, 'reload schema';

insert into newsletter.applied_migration (version, filename, applied_at, backfilled)
values ('0065', '0065_legal_footer_template.sql', now(), false)
on conflict (version) do update
   set applied_at = excluded.applied_at,
       backfilled = false;
