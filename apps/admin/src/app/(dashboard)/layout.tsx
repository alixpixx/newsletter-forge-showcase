import { Sidebar } from "@/components/nav/sidebar";
import { Topbar } from "@/components/nav/topbar";
import { getCurrentAsset, listAssetOptions } from "@/lib/asset-context";
import { getSessionUser } from "@/lib/session";

export default async function DashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Contexte de marque résolu une seule fois par rendu du layout, partagé sidebar + topbar.
  // `getSessionUser()` est mémoïsé par requête : cet appel ne coûte pas un aller-retour de plus.
  const [current, options, user] = await Promise.all([
    getCurrentAsset(),
    listAssetOptions(),
    getSessionUser(),
  ]);
  const viewer = user ? { email: user.email, role: user.role } : null;

  return (
    <div className="flex min-h-screen">
      <Sidebar current={current} options={options} viewer={viewer} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar current={current} options={options} viewer={viewer} />
        <main className="w-full max-w-[1240px] px-6 py-7 md:px-8">{children}</main>
      </div>
    </div>
  );
}
