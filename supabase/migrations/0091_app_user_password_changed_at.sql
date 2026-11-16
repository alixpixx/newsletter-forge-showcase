-- ============================================================================
-- 0091 — app_user.password_changed_at : changer un mot de passe ferme les
--        autres sessions
--
-- Demande d'Alix, 01/10/2026 : « gestion de mdp pass pour les comptes users ...
-- qu'on puisse definir un mdp et le changer ». Jusqu'ici un mot de passe ne se
-- choisissait qu'une fois, depuis le lien d'invitation (0044), et ne se
-- changeait plus jamais sans SQL.
--
-- POURQUOI UNE COLONNE. Le cookie de session est signé et vit sept jours ; la
-- base ne garde aucune liste de sessions. Sans date de changement, un nouveau
-- mot de passe laisserait ouvertes toutes les sessions émises avec l'ancien —
-- y compris celle de la personne dont on a voulu couper l'accès. Les cookies
-- portent désormais leur instant d'émission (`iat`), et `getSessionUser`
-- (lib/session.ts) refuse toute session émise AVANT cette date.
--
-- ⚠️ NULL partout à l'application, et c'est voulu : NULL = « jamais changé
--    depuis 0091 », aucune session existante n'est fermée par cette migration.
--    Seul un changement de mot de passe fait par l'admin la remplit.
--
-- ⛔ CETTE MIGRATION PASSE AVANT LE CODE : `CHAMPS` (lib/data/app-user.ts) lit
--    la colonne à chaque requête. Sans elle, toute l'admin tombe, écran de
--    connexion compris — même règle que 0075.
-- ============================================================================

alter table newsletter.app_user
  add column if not exists password_changed_at timestamptz;

comment on column newsletter.app_user.password_changed_at is
  'Dernier changement de mot de passe (0091). Toute session émise avant est refusée. NULL = jamais changé depuis 0091.';

do $$
declare
  v_type     text;
  v_nullable text;
  n          bigint;
begin
  select data_type, is_nullable into v_type, v_nullable
    from information_schema.columns
   where table_schema = 'newsletter' and table_name = 'app_user' and column_name = 'password_changed_at';
  if v_type is distinct from 'timestamp with time zone' then
    raise exception '[0091] password_changed_at absente ou mal typée : %', v_type;
  end if;
  if v_nullable <> 'YES' then
    raise exception '[0091] password_changed_at doit accepter NULL';
  end if;

  -- Une date posée ici fermerait des sessions sans qu'aucun mot de passe n'ait changé.
  select count(*) into n from newsletter.app_user where password_changed_at is not null;
  if n <> 0 then
    raise exception '[0091] % compte(s) portent déjà une date de changement', n;
  end if;

  raise notice '[0091] contre-epreuve OK : app_user.password_changed_at (timestamptz, NULL partout : aucune session existante n''est fermée)';
end
$$;

notify pgrst, 'reload schema';

-- ⛔ EN DERNIÈRE INSTRUCTION, ET APRÈS LA CONTRE-ÉPREUVE (voir 0072).
insert into newsletter.applied_migration (version, filename, applied_at, backfilled)
values ('0091', '0091_app_user_password_changed_at.sql', now(), false)
on conflict (version) do update
   set applied_at = excluded.applied_at,
       backfilled = false;
