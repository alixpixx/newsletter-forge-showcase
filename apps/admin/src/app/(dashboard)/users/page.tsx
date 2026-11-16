import { notFound } from "next/navigation";
import { UsersClient, type BrandRow, type TemplateRow, type UserRow } from "@/components/users/users-client";
import { listUsers } from "@/lib/data/app-user";
import { getSessionUser } from "@/lib/session";
import { getDb } from "@/lib/supabase";

// Comptes et octrois relus à chaque affichage : cette page sert précisément à voir l'état courant.
export const dynamic = "force-dynamic";

/**
 * Administration des comptes.
 *
 * ⚠️ Trois gardes indépendants couvrent ce chemin, et aucun ne remplace les autres : la barre
 * latérale ne propose plus le lien à un membre, le proxy le renvoie à l'accueil s'il tape l'URL,
 * et cette page refuse en dernier ressort — c'est le seul des trois qui relise le compte en base.
 *
 * `notFound()` plutôt qu'un 403 : la page ne confirme pas son existence à qui n'y a pas droit.
 */
export default async function UsersPage() {
  const user = await getSessionUser();
  if (!user?.isSuperAdmin) notFound();

  const db = getDb();
  if (!db) {
    return (
      <UsersClient
        selfId={user.id}
        users={[]}
        brands={[]}
        templates={[]}
        indisponible="Database unavailable — accounts cannot be listed or changed right now."
      />
    );
  }

  // Toutes les marques et tous les templates NON archivés : c'est le catalogue que l'administrateur
  // distribue. Il est volontairement non filtré par la marque courante — octroyer se fait pour les
  // neuf marques depuis un seul écran, sinon il faudrait basculer neuf fois.
  const [comptes, marques, templates] = await Promise.all([
    listUsers(db),
    db.from("asset").select("id, name").order("created_at"),
    db.from("template").select("id, name, asset_id").is("archived_at", null).order("name"),
  ]);

  const brands: BrandRow[] = ((marques.data ?? []) as { id: string; name: string }[]).map((a) => ({
    id: a.id,
    name: a.name,
  }));

  const rows: TemplateRow[] = ((templates.data ?? []) as { id: string; name: string; asset_id: string }[])
    .map((t) => ({ id: t.id, name: t.name, assetId: t.asset_id }));

  const users: UserRow[] = comptes.map((c) => ({
    id: c.id,
    email: c.email,
    role: c.role,
    status: c.status,
    allAssets: c.all_assets === true,
    allTemplates: c.all_templates === true,
    lastLoginAt: c.last_login_at,
    inviteExpiresAt: c.invite_expires_at,
    createdAt: c.created_at,
    assetIds: c.assetIds,
    templateIds: c.templateIds,
  }));

  return <UsersClient selfId={user.id} users={users} brands={brands} templates={rows} />;
}
