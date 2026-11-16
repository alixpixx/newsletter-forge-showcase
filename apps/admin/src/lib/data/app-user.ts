import type { AppRole } from "@/lib/auth";
import { getDb } from "@/lib/supabase";

/**
 * Accès aux comptes de l'admin (`newsletter.app_user` et ses deux tables d'octroi).
 *
 * ⚠️ C'est la SEULE couche qui lit ces trois tables. Les décisions d'autorisation se prennent
 * dans lib/session.ts, à partir de ce qui est lu ici — jamais à partir du cookie de session,
 * qui n'est qu'une identité signée et peut être plus vieux que la base de sept jours.
 */

export type AppUserStatus = "invited" | "active" | "disabled";

export type AppUserRow = {
  id: string;
  email: string;
  role: AppRole;
  status: AppUserStatus;
  /** Toutes les MARQUES, présentes et futures (0075). Décidé dans lib/session.ts. */
  all_assets: boolean;
  /** Tous les TEMPLATES des marques que ce compte voit, présents et futurs (0075). Indépendant du
   *  drapeau ci-dessus : il n'ouvre aucune marque. Décidé dans lib/session.ts. */
  all_templates: boolean;
  password_hash: string | null;
  /** Dernier changement de mot de passe (0091). Toute session émise avant est refusée
   *  (lib/session.ts). `null` = jamais changé depuis 0091. */
  password_changed_at: string | null;
  invite_expires_at: string | null;
  last_login_at: string | null;
  created_at: string;
};

export type Db = NonNullable<ReturnType<typeof getDb>>;

// ⛔ `all_assets` et `all_templates` sont lus ICI, donc par findById à chaque requête et par
// findByEmail à la connexion : sans les colonnes en base (migration 0075), toute l'admin tombe,
// écran de connexion compris. LA MIGRATION 0075 PASSE AVANT CE CODE.
// ⛔ `all_access` (0074) n'est plus nommé nulle part dans ce fichier ni ailleurs dans l'admin : ce
// silence est ce qui permet à 0076 de le retirer sans casser quoi que ce soit, une fois ce code en
// ligne. Ne pas le réintroduire « pour compatibilité ».
// ⛔ Même règle pour `password_changed_at` : LA MIGRATION 0091 PASSE AVANT CE CODE.
export const CHAMPS =
  "id, email, role, status, all_assets, all_templates, password_hash, password_changed_at, invite_expires_at, last_login_at, created_at";

/** Combien de comptes existent. Sert à savoir si l'amorçage du premier super_admin est encore ouvert. */
export async function countUsers(db: Db): Promise<number> {
  const { count, error } = await db.from("app_user").select("id", { count: "exact", head: true });
  if (error) throw new Error(`app_user: ${error.message}`);
  return count ?? 0;
}

/** `email` est de type citext en base : la casse n'a pas d'importance côté requête. */
export async function findByEmail(db: Db, email: string): Promise<AppUserRow | null> {
  const { data, error } = await db.from("app_user").select(CHAMPS).eq("email", email.trim()).maybeSingle();
  if (error) throw new Error(`app_user: ${error.message}`);
  return (data as AppUserRow | null) ?? null;
}

export type AppUserListRow = AppUserRow & {
  assetIds: string[];
  templateIds: string[];
};

/**
 * Tous les comptes, avec leurs octrois. Écran d'administration uniquement.
 *
 * Trois requêtes plutôt qu'une jointure imbriquée : la table fait quelques dizaines de lignes, et
 * une jointure PostgREST sur deux tables de liaison rendrait un objet dont la forme dépend de
 * l'ordre des lignes. Trois lectures simples se relisent.
 */
export async function listUsers(db: Db): Promise<AppUserListRow[]> {
  const { data, error } = await db.from("app_user").select(CHAMPS).order("created_at");
  if (error) throw new Error(`app_user: ${error.message}`);
  const comptes = (data ?? []) as AppUserRow[];
  if (comptes.length === 0) return [];

  const [{ data: aRows }, { data: tRows }] = await Promise.all([
    db.from("app_user_asset").select("user_id, asset_id"),
    db.from("app_user_template").select("user_id, template_id"),
  ]);

  const parUtilisateur = <T,>(rows: T[] | null, cle: keyof T): Map<string, string[]> => {
    const m = new Map<string, string[]>();
    for (const r of rows ?? []) {
      const uid = String((r as Record<string, unknown>).user_id ?? "");
      const v = String((r as Record<string, unknown>)[cle as string] ?? "");
      if (!uid || !v) continue;
      const liste = m.get(uid);
      if (liste) liste.push(v);
      else m.set(uid, [v]);
    }
    return m;
  };

  const marques = parUtilisateur(aRows as { user_id: string; asset_id: string }[] | null, "asset_id");
  const templates = parUtilisateur(
    tRows as { user_id: string; template_id: string }[] | null,
    "template_id",
  );

  return comptes.map((c) => ({
    ...c,
    assetIds: marques.get(c.id) ?? [],
    templateIds: templates.get(c.id) ?? [],
  }));
}

export async function findById(db: Db, id: string): Promise<AppUserRow | null> {
  const { data, error } = await db.from("app_user").select(CHAMPS).eq("id", id).maybeSingle();
  if (error) throw new Error(`app_user: ${error.message}`);
  return (data as AppUserRow | null) ?? null;
}

/** Retrouve un compte depuis l'empreinte du jeton d'invitation (le jeton n'est jamais stocké). */
export async function findByInviteHash(db: Db, tokenHash: string): Promise<AppUserRow | null> {
  const { data, error } = await db
    .from("app_user")
    .select(CHAMPS)
    .eq("invite_token_hash", tokenHash)
    .maybeSingle();
  if (error) throw new Error(`app_user: ${error.message}`);
  return (data as AppUserRow | null) ?? null;
}

/** Les marques explicitement octroyées à ce compte. ⚠️ Ne tient compte ni du rôle ni de
 *  `all_assets` : c'est lib/session.ts qui décide qu'un compte les voit toutes. */
export async function grantedAssetIds(db: Db, userId: string): Promise<string[]> {
  const { data, error } = await db.from("app_user_asset").select("asset_id").eq("user_id", userId);
  if (error) throw new Error(`app_user_asset: ${error.message}`);
  return (data ?? []).map((r: { asset_id: string }) => r.asset_id);
}

/** Tous les identifiants de marque, pour qui les voit toutes (super_admin ou `all_assets`). Lue à chaque
 *  requête, jamais figée : une marque créée plus tard y apparaît d'office. La table fait quelques
 *  lignes (6 mesurées le 22/09/2026). */
export async function allAssetIds(db: Db): Promise<string[]> {
  const { data, error } = await db.from("asset").select("id");
  if (error) throw new Error(`asset: ${error.message}`);
  return (data ?? []).map((r: { id: string }) => r.id);
}

/** Les templates explicitement octroyés. ⚠️ Même réserve que `grantedAssetIds` : c'est
 *  lib/session.ts (`templatesVisibles`) qui décide, sur `all_templates`, qu'un compte les voit tous. */
export async function grantedTemplateIds(db: Db, userId: string): Promise<string[]> {
  const { data, error } = await db.from("app_user_template").select("template_id").eq("user_id", userId);
  if (error) throw new Error(`app_user_template: ${error.message}`);
  return (data ?? []).map((r: { template_id: string }) => r.template_id);
}

/**
 * Un compte a-t-il accès à CE template ? Question posée une ligne à la fois, sans charger toute
 * la liste : c'est la forme qu'appellent les routes, sur un identifiant déjà connu.
 */
export async function hasTemplateGrant(db: Db, userId: string, templateId: string): Promise<boolean> {
  const { count, error } = await db
    .from("app_user_template")
    .select("template_id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("template_id", templateId);
  if (error) throw new Error(`app_user_template: ${error.message}`);
  return (count ?? 0) > 0;
}

export async function createUser(
  db: Db,
  u: {
    email: string;
    role: AppRole;
    status: AppUserStatus;
    allAssets?: boolean;
    allTemplates?: boolean;
    passwordHash?: string | null;
    inviteTokenHash?: string | null;
    inviteExpiresAt?: string | null;
    invitedBy?: string | null;
  },
): Promise<AppUserRow> {
  const { data, error } = await db
    .from("app_user")
    .insert({
      email: u.email.trim(),
      role: u.role,
      status: u.status,
      // ⛔ Les deux drapeaux sont écrits EXPLICITEMENT, jamais laissés au défaut de la colonne :
      // une invitation dit ce qu'elle donne, et `=== true` empêche qu'un `undefined` venu d'un
      // corps JSON ouvre quoi que ce soit.
      all_assets: u.allAssets === true,
      all_templates: u.allTemplates === true,
      password_hash: u.passwordHash ?? null,
      invite_token_hash: u.inviteTokenHash ?? null,
      invite_expires_at: u.inviteExpiresAt ?? null,
      invited_by: u.invitedBy ?? null,
    })
    .select(CHAMPS)
    .single();
  if (error) throw new Error(`app_user insert: ${error.message}`);
  return data as AppUserRow;
}

/**
 * Renouvelle le lien d'invitation d'un compte encore `invited`.
 * Le jeton précédent devient caduc : un lien qui traîne dans une boîte mail ne doit pas rester
 * valable indéfiniment parce qu'on en a envoyé un second.
 */
export async function replaceInvite(
  db: Db,
  id: string,
  inviteTokenHash: string,
  inviteExpiresAt: string,
): Promise<void> {
  const { error } = await db
    .from("app_user")
    .update({
      invite_token_hash: inviteTokenHash,
      invite_expires_at: inviteExpiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("status", "invited");
  if (error) throw new Error(`app_user invite: ${error.message}`);
}

/**
 * Consomme l'invitation : pose l'empreinte du mot de passe et passe le compte en `active`.
 *
 * ⚠️ Le filtre `.eq("status", "invited")` fait partie de la sécurité, pas du confort : c'est lui
 * qui rend l'opération non rejouable. Sans lui, un lien réutilisé réécrirait le mot de passe d'un
 * compte déjà actif. On relit la ligne écrite (`select().maybeSingle()`) pour distinguer « rien ne
 * correspondait » d'un succès — un update qui ne touche aucune ligne réussit silencieusement.
 */
export async function acceptInvite(db: Db, id: string, passwordHash: string): Promise<AppUserRow | null> {
  const { data, error } = await db
    .from("app_user")
    .update({
      password_hash: passwordHash,
      status: "active",
      invite_token_hash: null,
      invite_expires_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("status", "invited")
    .select(CHAMPS)
    .maybeSingle();
  if (error) throw new Error(`app_user accept: ${error.message}`);
  return (data as AppUserRow | null) ?? null;
}

/**
 * Pose une nouvelle empreinte de mot de passe et DATE le changement (0091) — ce qui ferme toutes
 * les sessions émises avant (lib/session.ts). Sert au changement par la personne elle-même comme
 * à celui fait par un administrateur.
 *
 * `statutAttendu` est le statut que l'appelant a LU. Filtrer dessus rend l'écriture
 * conditionnelle : si le compte a changé d'état entre la lecture et l'écriture (invitation
 * acceptée, compte désactivé ou supprimé), aucune ligne n'est touchée et l'appelant reçoit `null`
 * au lieu d'un faux succès.
 *
 * ⛔ Un compte `invited` est ACTIVÉ par la même écriture (décision d'Alix, 01/10/2026) et son jeton
 * est effacé. Le laisser `invited` avec un mot de passe laisserait le lien d'invitation, toujours
 * valable, réécrire ce mot de passe derrière l'administrateur.
 */
export async function setPassword(
  db: Db,
  id: string,
  passwordHash: string,
  statutAttendu: AppUserStatus,
): Promise<AppUserRow | null> {
  const maintenant = new Date().toISOString();
  const champs: Record<string, unknown> = {
    password_hash: passwordHash,
    password_changed_at: maintenant,
    updated_at: maintenant,
  };
  if (statutAttendu === "invited") {
    champs.status = "active";
    champs.invite_token_hash = null;
    champs.invite_expires_at = null;
  }
  const { data, error } = await db
    .from("app_user")
    .update(champs)
    .eq("id", id)
    .eq("status", statutAttendu)
    .select(CHAMPS)
    .maybeSingle();
  if (error) throw new Error(`app_user password: ${error.message}`);
  return (data as AppUserRow | null) ?? null;
}

/** Rôle, statut et/ou les deux drapeaux « All » (0075). Les octrois explicites passent par
 *  setAssets / setTemplates. */
export async function updateUser(
  db: Db,
  id: string,
  patch: { role?: AppRole; status?: AppUserStatus; allAssets?: boolean; allTemplates?: boolean },
): Promise<void> {
  const champs: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.role) champs.role = patch.role;
  if (patch.status) champs.status = patch.status;
  // ⚠️ `!== undefined` et non « truthy », sur CHACUN des deux : `false` est une valeur à ÉCRIRE —
  // c'est retirer l'accès. Les sauter laisserait la case décochée à l'écran et le drapeau posé en
  // base, et personne ne verrait la différence avant l'incident.
  if (patch.allAssets !== undefined) champs.all_assets = patch.allAssets;
  if (patch.allTemplates !== undefined) champs.all_templates = patch.allTemplates;
  const { error } = await db.from("app_user").update(champs).eq("id", id);
  // ⚠️ Le trigger app_user_garder_un_administrateur lève ici quand la modification laisserait la
  // table sans super_admin actif. On laisse remonter le message tel quel : l'appelant le traduit.
  if (error) throw new Error(`app_user update: ${error.message}`);
}

export async function deleteUser(db: Db, id: string): Promise<void> {
  const { error } = await db.from("app_user").delete().eq("id", id);
  if (error) throw new Error(`app_user delete: ${error.message}`);
}

/**
 * Réconcilie un ensemble d'octrois : ajoute ce qui manque, retire ce qui n'est plus voulu, et ne
 * touche pas au reste. Un « tout effacer puis tout réécrire » serait plus court mais perdrait
 * `granted_at` et `granted_by` de chaque ligne conservée — la trace de qui a donné quoi, et quand.
 */
async function reconcilier(
  db: Db,
  table: "app_user_asset" | "app_user_template",
  colonne: "asset_id" | "template_id",
  userId: string,
  voulus: string[],
  by: string | null,
): Promise<void> {
  const { data, error } = await db.from(table).select(colonne).eq("user_id", userId);
  if (error) throw new Error(`${table}: ${error.message}`);
  const actuels = new Set(
    ((data ?? []) as Record<string, unknown>[]).map((r) => String(r[colonne] ?? "")).filter(Boolean),
  );
  const cibles = new Set(voulus);

  const aRetirer = [...actuels].filter((v) => !cibles.has(v));
  const aPoser = [...cibles].filter((v) => !actuels.has(v));

  if (aRetirer.length > 0) {
    const { error: e } = await db.from(table).delete().eq("user_id", userId).in(colonne, aRetirer);
    if (e) throw new Error(`${table} delete: ${e.message}`);
  }
  if (aPoser.length > 0) {
    const lignes = aPoser.map((v) => ({ user_id: userId, [colonne]: v, granted_by: by }));
    const { error: e } = await db.from(table).insert(lignes);
    if (e) throw new Error(`${table} insert: ${e.message}`);
  }
}

export const setAssets = (db: Db, userId: string, ids: string[], by: string | null) =>
  reconcilier(db, "app_user_asset", "asset_id", userId, ids, by);

export const setTemplates = (db: Db, userId: string, ids: string[], by: string | null) =>
  reconcilier(db, "app_user_template", "template_id", userId, ids, by);

/** Trace de la dernière connexion. Volontairement silencieuse : une écriture de traçabilité qui
 *  échoue ne doit pas empêcher quelqu'un de se connecter. */
export async function touchLastLogin(db: Db, id: string): Promise<void> {
  await db.from("app_user").update({ last_login_at: new Date().toISOString() }).eq("id", id);
}

export async function grantAsset(db: Db, userId: string, assetId: string, by: string | null): Promise<void> {
  const { error } = await db
    .from("app_user_asset")
    .upsert({ user_id: userId, asset_id: assetId, granted_by: by }, { onConflict: "user_id,asset_id" });
  if (error) throw new Error(`app_user_asset upsert: ${error.message}`);
}

export async function revokeAsset(db: Db, userId: string, assetId: string): Promise<void> {
  const { error } = await db.from("app_user_asset").delete().eq("user_id", userId).eq("asset_id", assetId);
  if (error) throw new Error(`app_user_asset delete: ${error.message}`);
}

export async function grantTemplate(
  db: Db,
  userId: string,
  templateId: string,
  by: string | null,
): Promise<void> {
  const { error } = await db
    .from("app_user_template")
    .upsert(
      { user_id: userId, template_id: templateId, granted_by: by },
      { onConflict: "user_id,template_id" },
    );
  if (error) throw new Error(`app_user_template upsert: ${error.message}`);
}

export async function revokeTemplate(db: Db, userId: string, templateId: string): Promise<void> {
  const { error } = await db
    .from("app_user_template")
    .delete()
    .eq("user_id", userId)
    .eq("template_id", templateId);
  if (error) throw new Error(`app_user_template delete: ${error.message}`);
}
