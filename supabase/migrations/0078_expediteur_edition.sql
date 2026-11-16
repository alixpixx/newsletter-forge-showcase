-- ============================================================================
-- 0078 — Le NOM de l'expéditeur et l'adresse de RÉPONSE se règlent par édition.
-- ============================================================================
--
-- Règle d'Alix du 22/09/2026 : « je veux tout pouvoir modifier dans le builder ce que les users vont
-- recevoir sans exception !! ». Pour l'expéditeur, sa décision (prise sur recommandation) :
--
--   - le NOM affiché dans le From et le Reply-To deviennent réglables, par édition ;
--   - l'ADRESSE d'envoi reste sur le sous-domaine vérifié de l'édition — elle n'est PAS réglable.
--
-- ⛔ POURQUOI L'ADRESSE D'ENVOI RESTE VERROUILLÉE. Un From sur un domaine que Mailgun ne signe pas
-- casse l'alignement DMARC : les e-mails de la marque partent en spam, ou sont rejetés, pour TOUTE la
-- liste d'un coup. On veut pouvoir répondre à `redaction@marque.com` : c'est le rôle du `Reply-To`,
-- un en-tête séparé qui ne touche jamais au domaine d'envoi.
--
-- Deux objets, tous deux ADDITIFS :
--
--  1. `asset_edition.from_name` / `asset_edition.reply_to` — nullables, NULL = le comportement d'avant
--     (nom de la marque, pas de Reply-To). Aucune ligne existante ne change.
--  2. `outbox_context.from_name` / `outbox_context.reply_to` — la même valeur, lue par le worker à
--     l'envoi. Le worker déployé AVANT cette migration ne lit pas ces colonnes ; celui d'après retombe
--     sur l'ancien comportement tant qu'elles sont absentes ou NULL.

-- ===========================================================================
-- 1 — les deux colonnes, et leurs gardes
-- ===========================================================================
--
-- ⛔ LE NOM FINIT ENTRE GUILLEMETS DANS UN EN-TÊTE. Un `"` fermerait la chaîne et ferait lire la suite
-- comme une adresse ; un retour à la ligne ouvrirait un en-tête de plus (`Bcc:` par exemple). La route
-- d'écriture de l'admin refuse ces caractères, le worker les nettoie : cette contrainte est la barrière
-- du milieu, celle qui tient même contre une écriture qui ne passe pas par l'admin.
--
-- ⛔ LE REPLY-TO EST UNE ADRESSE, UNE SEULE. Une liste (`a@x, b@y`) ou un nom (`X <a@x>`) passerait
-- dans l'en-tête tel quel : le motif est le même que celui du worker (`mailgun.ts`, `EMAIL`), qui ignore
-- de toute façon une valeur qu'il ne reconnaît pas.
alter table newsletter.asset_edition
  add column if not exists from_name text,
  add column if not exists reply_to text;

comment on column newsletter.asset_edition.from_name is
  'Nom affiché dans le From des e-mails de cette édition. NULL = le nom de la marque. L''ADRESSE d''envoi n''est pas réglable (DMARC) : elle reste <localpart>@sending_subdomain.';
comment on column newsletter.asset_edition.reply_to is
  'Adresse de réponse (en-tête Reply-To) des e-mails de cette édition. NULL = pas de Reply-To. Ne change JAMAIS l''adresse d''envoi.';

alter table newsletter.asset_edition drop constraint if exists asset_edition_from_name_check;
alter table newsletter.asset_edition
  add constraint asset_edition_from_name_check check (
    from_name is null
    or (
      char_length(btrim(from_name)) between 1 and 64
      and from_name !~ '[[:cntrl:]"<>\\]'
    )
  );

alter table newsletter.asset_edition drop constraint if exists asset_edition_reply_to_check;
alter table newsletter.asset_edition
  add constraint asset_edition_reply_to_check check (
    reply_to is null
    or (
      char_length(reply_to) <= 254
      and reply_to ~* '^[^[:space:]@",;<>()\\]+@[^[:space:]@",;<>()\\]+\.[a-z]{2,}$'
    )
  );

-- ===========================================================================
-- 2 — `outbox_context.from_name` / `outbox_context.reply_to`
-- ===========================================================================
--
-- ⛔ LE CORPS EST CELUI DE LA PROD. Relu le 22/09/2026 par `pg_get_viewdef('newsletter.outbox_context')`
-- et comparé ligne à ligne au corps de 0073 : seules différent les parenthèses que Postgres ajoute à
-- l'affichage, la définition est la même. `create or replace view` exige les mêmes colonnes dans le
-- même ordre ; les deux nouvelles viennent en DERNIER, après `hard_suppressed`. Une divergence avec la
-- vue en place fait ÉCHOUER la migration — elle ne peut pas la déformer.
--
-- ⚠️ SI UNE MIGRATION ENTRE 0074 ET 0078 RECRÉE AUSSI CETTE VUE, CE CORPS EST À REBASER sur le sien :
-- appliquée après elle telle quelle, 0078 échouerait (colonne manquante) plutôt que d'en effacer une.
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
            WHEN o.kind = ANY (ARRAY['test'::text, 'campaign'::text]) THEN COALESCE(lft_tv.config, e.legal_footer)
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
    ltv.subject AS lifecycle_subject,
    newsletter.is_hard_suppressed(o.to_email::text, o.asset_id) AS hard_suppressed,
    e.from_name AS from_name,
    e.reply_to AS reply_to
   FROM newsletter.email_outbox o
     LEFT JOIN newsletter.asset a ON a.id = o.asset_id
     LEFT JOIN newsletter.subscription s ON s.id = o.subscription_id
     LEFT JOIN newsletter.template_version tv ON tv.id = o.template_version_id
     LEFT JOIN newsletter.campaign c ON c.id = o.campaign_id
     LEFT JOIN newsletter.campaign_occurrence occ ON occ.id = o.occurrence_id
     LEFT JOIN newsletter.lifecycle_template lt ON lt.asset_id = o.asset_id AND lt.kind = o.kind
     LEFT JOIN newsletter.template lft ON lft.id = lt.template_id AND lft.archived_at IS NULL
     LEFT JOIN newsletter.template_version ltv ON ltv.id = lft.current_version_id AND ltv.status = 'published'::text
     LEFT JOIN newsletter.legal_footer_template lft_tv ON lft_tv.id = tv.legal_footer_template_id AND lft_tv.asset_id = o.asset_id
     LEFT JOIN newsletter.legal_footer_template lft_lc ON lft_lc.id = ltv.legal_footer_template_id AND lft_lc.asset_id = o.asset_id
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
            ed.is_primary,
            ed.from_name,
            ed.reply_to
           FROM newsletter.asset_edition ed
          WHERE ed.asset_id = o.asset_id
          ORDER BY (ed.id = s.edition_id) DESC NULLS LAST, ed.id
         LIMIT 1) e ON true;

-- ---------------------------------------------------------------------------
-- CONTRE-ÉPREUVE — DANS la migration. Relire le catalogue et ÉCHOUER si une colonne manque, si une
-- garde n'est pas posée, ou si la vue n'expose pas les deux colonnes EN DERNIER.
-- ---------------------------------------------------------------------------
do $$
declare
  manquants text;
  dernieres text;
begin
  select string_agg(attendu, ', ')
    into manquants
    from (values ('from_name'), ('reply_to')) as v(attendu)
   where not exists (
     select 1 from information_schema.columns
      where table_schema = 'newsletter' and table_name = 'asset_edition' and column_name = v.attendu
   );
  if manquants is not null then
    raise exception '[0078] asset_edition : colonnes absentes apres execution : %', manquants;
  end if;

  select string_agg(attendu, ', ')
    into manquants
    from (values ('asset_edition_from_name_check'), ('asset_edition_reply_to_check')) as v(attendu)
   where not exists (
     select 1 from pg_constraint
      where conrelid = 'newsletter.asset_edition'::regclass and conname = v.attendu and convalidated
   );
  if manquants is not null then
    raise exception '[0078] asset_edition : gardes absentes ou non validees : %', manquants;
  end if;

  -- Les deux gardes MORDENT : chaque valeur interdite doit être refusée par l'expression même de la
  -- contrainte (évaluée ici sans écrire une ligne).
  if 'A"B' !~ '[[:cntrl:]"<>\\]' or (E'A\nB') !~ '[[:cntrl:]"<>\\]' then
    raise exception '[0078] la garde du nom laisse passer un guillemet ou un retour a la ligne';
  end if;
  if 'a@b.co, c@d.co' ~* '^[^[:space:]@",;<>()\\]+@[^[:space:]@",;<>()\\]+\.[a-z]{2,}$'
     or 'X <a@b.co>' ~* '^[^[:space:]@",;<>()\\]+@[^[:space:]@",;<>()\\]+\.[a-z]{2,}$'
     or not ('redacao@quartz-tips.example' ~* '^[^[:space:]@",;<>()\\]+@[^[:space:]@",;<>()\\]+\.[a-z]{2,}$') then
    raise exception '[0078] la garde du Reply-To ne distingue pas une adresse d''une liste ou d''un nom';
  end if;

  select string_agg(column_name::text, ',' order by ordinal_position)
    into dernieres
    from (
      select column_name, ordinal_position from information_schema.columns
       where table_schema = 'newsletter' and table_name = 'outbox_context'
       order by ordinal_position desc
       limit 3
    ) t;
  if dernieres is distinct from 'hard_suppressed,from_name,reply_to' then
    raise exception '[0078] outbox_context : dernieres colonnes attendues hard_suppressed,from_name,reply_to, lues : %', dernieres;
  end if;

  raise notice '[0078] contre-epreuve OK : 2 colonnes, 2 gardes qui mordent, vue a jour';
end
$$;

-- ⛔ EN DERNIÈRE INSTRUCTION, ET APRÈS LA CONTRE-ÉPREUVE (voir 0072).
insert into newsletter.applied_migration (version, filename, applied_at, backfilled)
values ('0078', '0078_expediteur_edition.sql', now(), false)
on conflict (version) do update
   set applied_at = excluded.applied_at,
       backfilled = false;

notify pgrst, 'reload schema';
