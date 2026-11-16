-- Builder v2 — persistance des templates.
-- Modèle : 1 brouillon vivant (version 0, réécrit par l'autosave) + N versions publiées FIGÉES.
-- Le rendu HTML est figé À LA PUBLICATION (tokens {{…}} non résolus) : le worker n'exécute
-- qu'un hydrate() sans dépendance, il ne charge jamais MJML.

create table if not exists newsletter.template (
  id                 uuid primary key default gen_random_uuid(),
  asset_id           uuid not null references newsletter.asset(id) on delete cascade,
  slug               extensions.citext not null,
  name               text not null,
  category           text not null default 'newsletter'
                       check (category in ('newsletter','daily_pick','preview','roundup',
                                           'win_back','welcome','transactional')),
  current_version_id uuid,                    -- FK ajoutée plus bas (dépendance circulaire)
  archived_at        timestamptz,
  created_by         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (asset_id, slug)
);

create table if not exists newsletter.template_version (
  id                    uuid primary key default gen_random_uuid(),
  template_id           uuid not null references newsletter.template(id) on delete cascade,
  version               int  not null,        -- 0 = brouillon courant, 1..n = publiées
  status                text not null default 'draft' check (status in ('draft','published')),
  subject               text not null default '',
  preheader             text,
  -- SOURCE DE VÉRITÉ du builder (schéma EmailDoc de @nf/render)
  doc                   jsonb not null default '{"schema":2,"meta":{},"theme":{},"rows":[]}',
  doc_schema            int  not null default 2,
  -- RENDU FIGÉ À LA PUBLICATION (tokens et marqueurs nf:if NON résolus)
  html_shell            text,
  text_shell            text,
  compiler_version      text,                 -- ex. 'nf-render@1.0.0+mjml@5.4.0'
  compiled_at           timestamptz,
  size_bytes            int,                  -- seuil d'alerte 102400 (troncature Gmail)
  warnings              jsonb not null default '[]',
  note                  text,
  author_email          text,
  restored_from_version int,
  -- garde anti-conflit multi-onglets (pas de merge automatique)
  editing_by            text,
  editing_at            timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (template_id, version)
);

-- Un SEUL brouillon vivant par template (l'autosave écrit toujours dedans).
create unique index if not exists uq_template_single_draft
  on newsletter.template_version (template_id) where status = 'draft';

alter table newsletter.template
  drop constraint if exists template_current_version_fk;
alter table newsletter.template
  add constraint template_current_version_fk
  foreign key (current_version_id) references newsletter.template_version(id) on delete set null;

create index if not exists idx_template_asset
  on newsletter.template (asset_id) where archived_at is null;
create index if not exists idx_tv_template
  on newsletter.template_version (template_id, version desc);
-- retrouver l'usage d'un média / d'un type de bloc avant suppression
create index if not exists idx_tv_doc on newsletter.template_version using gin (doc jsonb_path_ops);

alter table newsletter.template         enable row level security;
alter table newsletter.template_version enable row level security;
grant all on newsletter.template, newsletter.template_version to service_role;

-- Publication atomique : fige le brouillon en version n+1, puis recrée un brouillon identique.
create or replace function newsletter.template_publish(
  p_template_id uuid, p_html text, p_text text, p_size int,
  p_compiler text, p_warnings jsonb, p_author text, p_note text
) returns newsletter.template_version
language plpgsql security definer set search_path = newsletter as $$
declare v_next int; v_pub newsletter.template_version;
begin
  select coalesce(max(version),0)+1 into v_next
    from newsletter.template_version where template_id = p_template_id and status='published';

  update newsletter.template_version
     set status='published', version=v_next, html_shell=p_html, text_shell=p_text,
         size_bytes=p_size, compiler_version=p_compiler, compiled_at=now(),
         warnings=p_warnings, author_email=p_author, note=p_note, updated_at=now()
   where template_id = p_template_id and status='draft'
  returning * into v_pub;
  if v_pub.id is null then raise exception 'no draft to publish for %', p_template_id; end if;

  insert into newsletter.template_version (template_id, version, status, subject, preheader, doc, doc_schema)
  values (p_template_id, 0, 'draft', v_pub.subject, v_pub.preheader, v_pub.doc, v_pub.doc_schema);

  update newsletter.template set current_version_id = v_pub.id, updated_at = now()
   where id = p_template_id;
  return v_pub;
end; $$;
grant execute on function newsletter.template_publish(uuid,text,text,int,text,jsonb,text,text) to service_role;

-- Restauration : ne réécrit JAMAIS l'historique, écrase seulement le brouillon.
create or replace function newsletter.template_restore(p_template_id uuid, p_version int)
returns void language sql security definer set search_path = newsletter as $$
  update newsletter.template_version d
     set doc = s.doc, subject = s.subject, preheader = s.preheader,
         restored_from_version = s.version, updated_at = now()
    from newsletter.template_version s
   where d.template_id = p_template_id and d.status='draft'
     and s.template_id = p_template_id and s.version = p_version and s.status='published';
$$;
grant execute on function newsletter.template_restore(uuid,int) to service_role;

notify pgrst, 'reload schema';
