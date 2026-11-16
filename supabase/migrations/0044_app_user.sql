-- ============================================================================
-- 0044 — Comptes, rôles et octrois : le socle de la section utilisateur
--
-- Jusqu'ici l'admin n'avait AUCUNE notion d'utilisateur : une seule paire
-- AUTH_EMAIL / AUTH_PASSWORD en variable d'environnement, une session portant
-- {email, exp} et rien d'autre. La page /users était une maquette de quatre
-- personnes codées en dur. Il n'existait donc aucun moyen de dire « cette
-- personne travaille sur Northwind Sports et sur ces trois templates-là ».
--
-- Trois tables suffisent, parce que le cloisonnement par MARQUE existe déjà et
-- qu'il est bien fait (57 filtres .eq("asset_id"), invariant « un objet d'une
-- autre marque doit être indiscernable d'un objet inexistant → 404 »). On ne
-- refait pas ce cloisonnement : on lui donne enfin un sujet.
--
--   app_user           qui peut se connecter, avec quel rôle
--   app_user_asset     quelles MARQUES cette personne voit
--   app_user_template  quels TEMPLATES elle peut ouvrir et modifier
--
-- ⛔ Arbitrage d'Alix, 30/08 : « donner accès à un template » signifie accéder
--    au template LUI-MÊME, éditable — pas à une copie. C'est donc un objet
--    partagé, d'où app_user_template en table de liaison plutôt qu'un
--    propriétaire unique posé sur newsletter.template.
--
-- ⚠️ Le cloisonnement reste APPLICATIF. Comme les 43 migrations précédentes,
--    ce fichier active RLS et n'écrit AUCUNE policy : les trois apps parlent à
--    Supabase avec la clé service_role, qui contourne RLS par construction. Ces
--    tables sont exactement ce que des policies liraient le jour où l'on
--    passerait à Supabase Auth — rien n'est à jeter, mais rien ne filtre ici.
--
-- ⚠️ Aucune colonne d'auteur existante n'est touchée (template.created_by,
--    template_version.author_email et 5 autres sont du texte libre sans FK).
--    Les convertir demanderait un backfill par correspondance d'e-mail qui
--    échouerait sur l'historique, et template_publish écrit author_email en
--    dur. Elles gardent leur rôle de traçabilité ; l'autorité, c'est ici.
-- ============================================================================

create table if not exists newsletter.app_user (
  id                uuid primary key default gen_random_uuid(),
  -- citext comme partout ailleurs dans ce schéma : l'unicité devient insensible
  -- à la casse sans index fonctionnel, et « Demo-admin@… » ne peut pas doubler « demo-admin@… ».
  email             extensions.citext not null unique,
  -- PBKDF2-SHA256, format pbkdf2$<itérations>$<sel_b64>$<empreinte_b64>.
  -- Nul tant que l'invitation n'a pas été acceptée.
  password_hash     text,
  role              text not null default 'member'
                      check (role in ('super_admin','member')),
  status            text not null default 'invited'
                      check (status in ('invited','active','disabled')),
  invited_by        uuid,                 -- FK ajoutée plus bas (auto-référence)
  -- On stocke l'EMPREINTE du jeton d'invitation, jamais le jeton : une fuite de
  -- la table ne doit pas permettre d'activer les comptes en attente.
  invite_token_hash text,
  invite_expires_at timestamptz,
  last_login_at     timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- Un compte actif sans empreinte de mot de passe serait un compte que le code
  -- croit ouvrable et que personne ne peut ouvrir. La base refuse cet état.
  constraint app_user_actif_a_une_empreinte
    check (status <> 'active' or password_hash is not null),
  -- Une invitation sans jeton ni échéance ne peut jamais aboutir : c'est
  -- exactement l'état terminal inatteignable qu'on veut rendre impossible.
  constraint app_user_invitation_complete
    check (status <> 'invited'
           or (invite_token_hash is not null and invite_expires_at is not null))
);

-- Auto-référence : posée après coup, comme template_current_version_fk en 0017.
alter table newsletter.app_user
  drop constraint if exists app_user_invited_by_fk;
alter table newsletter.app_user
  add constraint app_user_invited_by_fk
  foreign key (invited_by) references newsletter.app_user(id) on delete set null;

-- Quelles marques cette personne voit. C'est le périmètre choisi par Alix :
-- une personne, une ou plusieurs marques.
create table if not exists newsletter.app_user_asset (
  user_id    uuid not null references newsletter.app_user(id) on delete cascade,
  asset_id   uuid not null references newsletter.asset(id)    on delete cascade,
  granted_by uuid references newsletter.app_user(id) on delete set null,
  granted_at timestamptz not null default now(),
  primary key (user_id, asset_id)
);

-- Quels templates elle peut ouvrir et modifier. Une ligne y est posée
-- automatiquement à la création d'un template par son auteur : « sa propre
-- newsletter » et « un template qu'on lui a octroyé » sont le même mécanisme,
-- donc une seule table décide de tout l'accès.
create table if not exists newsletter.app_user_template (
  user_id     uuid not null references newsletter.app_user(id) on delete cascade,
  template_id uuid not null references newsletter.template(id) on delete cascade,
  granted_by  uuid references newsletter.app_user(id) on delete set null,
  granted_at  timestamptz not null default now(),
  primary key (user_id, template_id)
);

-- Les clés primaires composites couvrent le sens user → objet. Ces deux index
-- couvrent le sens inverse, celui de l'écran d'administration : « qui a accès
-- à cette marque / à ce template ».
create index if not exists idx_app_user_asset_asset
  on newsletter.app_user_asset (asset_id);
create index if not exists idx_app_user_template_template
  on newsletter.app_user_template (template_id);

-- Retrouver un compte depuis le lien d'invitation, sans balayer la table.
create index if not exists idx_app_user_invite_token
  on newsletter.app_user (invite_token_hash) where invite_token_hash is not null;

-- ----------------------------------------------------------------------------
-- Garde-fou : il doit toujours rester quelqu'un pour administrer.
--
-- Sans lui, se rétrograder ou se désactiver soi-même par mégarde produit un
-- état IRRÉCUPÉRABLE par l'interface : plus aucun compte ne peut octroyer un
-- rôle, et la seule sortie est du SQL à la main. Une contrainte CHECK ne peut
-- pas voir les autres lignes ; il faut donc un trigger d'instruction.
--
-- Vider entièrement la table reste permis : c'est un geste de remise à zéro
-- délibéré, pas l'accident qu'on cherche à empêcher.
-- ----------------------------------------------------------------------------
create or replace function newsletter.app_user_garder_un_administrateur()
returns trigger
language plpgsql security definer set search_path = newsletter as $$
begin
  if exists (select 1 from newsletter.app_user)
     and not exists (
       select 1 from newsletter.app_user
        where role = 'super_admin' and status = 'active'
     ) then
    raise exception
      'refus : au moins un compte super_admin actif doit subsister (app_user)';
  end if;
  return null;
end; $$;

comment on function newsletter.app_user_garder_un_administrateur() is
  'Empêche de laisser app_user sans super_admin actif — sinon plus personne ne peut administrer.';
revoke all on function newsletter.app_user_garder_un_administrateur() from public;

drop trigger if exists trg_app_user_garder_un_administrateur on newsletter.app_user;
create trigger trg_app_user_garder_un_administrateur
  after update or delete on newsletter.app_user
  for each statement execute function newsletter.app_user_garder_un_administrateur();

-- ----------------------------------------------------------------------------
comment on table newsletter.app_user is
  'Comptes de l''admin. Identité, rôle et état ; l''autorité sur les droits, relue à chaque requête.';
comment on column newsletter.app_user.password_hash is
  'PBKDF2-SHA256 : pbkdf2$<itérations>$<sel_b64url>$<empreinte_b64url>. Web Crypto, donc valable en Edge comme en Node.';
comment on column newsletter.app_user.invite_token_hash is
  'Empreinte SHA-256 du jeton d''invitation. Le jeton lui-même n''est jamais stocké.';
comment on column newsletter.app_user.status is
  'invited = compte créé, lien non consommé · active = peut se connecter · disabled = refusé à la requête suivante.';
comment on table newsletter.app_user_asset is
  'Quelles marques un compte voit. Le sélecteur de marque et les 57 filtres asset_id s''y adossent.';
comment on table newsletter.app_user_template is
  'Quels templates un compte peut ouvrir et modifier. Une ligne est posée automatiquement au créateur.';

alter table newsletter.app_user          enable row level security;
alter table newsletter.app_user_asset    enable row level security;
alter table newsletter.app_user_template enable row level security;

grant all on newsletter.app_user, newsletter.app_user_asset, newsletter.app_user_template
  to service_role;

notify pgrst, 'reload schema';
