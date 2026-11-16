"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BookOpen,
  ChartColumn,
  LayoutDashboard,
  Users,
  Filter,
  Send,
  LayoutPanelLeft,
  LayoutTemplate,
  Image as ImageIcon,
  FileText,
  UserCog,
  ShieldCheck,
  ScrollText,
  Settings,
  Mail,
  Workflow,
  LogOut,
  Menu,
  X,
} from "lucide-react";
import { AssetSwitcher } from "./asset-switcher";
import { ChangePassword } from "./change-password";
import type { AssetOption, CurrentAsset } from "@/lib/asset-context";
import { cn } from "@/lib/utils";

type NavItem = {
  label: string;
  href: string;
  icon: React.ElementType;
  badge?: string;
  /** Rôle exigé pour que le lien soit proposé. Absent = visible par tout le monde. */
  requires?: "super_admin";
};

/** Identité affichée dans le pied de la barre latérale — vient de la session, plus du code. */
export type Viewer = { email: string; role: "super_admin" | "member" } | null;

/** Props communes à la sidebar desktop et au panneau mobile (marque courante + choix). */
export type NavProps = { current: CurrentAsset; options: AssetOption[]; viewer: Viewer };

// Pas de badges de compteur ici : ils étaient globaux/mock (« 128 450 ») alors que le contexte
// est la marque sélectionnée. Les vrais compteurs vivent, scopés, sur chaque écran.
//
// ⛔ « Experiments » et « Automations » ont été RETIRÉS le 31/08/2026, avec leurs pages et leurs
// composants (arbitrage d'Alix). C'étaient des maquettes sur données inventées : un A/B test avec
// des taux d'ouverture fabriqués et un tableau d'automatisations qui ne déclenchait rien. Une
// maquette accessible en production ne se lit pas comme une maquette — elle se lit comme un
// chiffre. Le code reste dans l'historique git ; le retirer du menu SANS retirer la route aurait
// seulement rendu ces pages plus difficiles à trouver, pas moins fausses.
//
// ⛔ LE GROUPE « Automations » EST REVENU LE 24/09/2026 (demande d'Alix), ET PAS L'ANCIENNE MAQUETTE.
// Il réunit ce qui existe déjà et envoie déjà : les e-mails de cycle de vie (sortis de /templates)
// et le ciblage (les segments, sortis de Monitoring). Les automations sur mesure vivent sous
// « Automations », lues dans leurs tables (0082) — jamais comme un tableau qui ne déclenche rien. Les anciennes
// adresses redirigent (`lib/adresses-demenagees.ts`). Aucun `requires` : ces écrans étaient ouverts
// à tous avant le déménagement, les gestes réservés restent gardés par leurs routes.
export const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: "Monitoring",
    items: [
      { label: "Overview", href: "/", icon: LayoutDashboard },
      { label: "Subscribers", href: "/subscribers", icon: Users },
    ],
  },
  {
    group: "Content",
    items: [
      { label: "Campaigns", href: "/campaigns", icon: Send },
      // Statistiques par campagne (0085, feature 7). Aucun `requires` : visible par tous ceux qui ont
      // accès à la marque (décision d'Alix du 24/09) ; les chiffres sont lus pour la marque de la session.
      { label: "Analytics", href: "/analytics", icon: ChartColumn },
      { label: "Templates", href: "/templates", icon: LayoutTemplate },
      { label: "Email builder", href: "/builder", icon: LayoutPanelLeft },
      { label: "Media", href: "/media", icon: ImageIcon },
      { label: "Forms", href: "/forms", icon: FileText },
    ],
  },
  {
    group: "Automations",
    items: [
      { label: "Automations", href: "/automations", icon: Workflow },
      { label: "Targeting", href: "/automations/targeting", icon: Filter },
    ],
  },
  {
    group: "System",
    items: [
      { label: "Compliance", href: "/compliance", icon: ScrollText },
      { label: "Deliverability", href: "/deliverability", icon: ShieldCheck, requires: "super_admin" },
      { label: "Users", href: "/users", icon: UserCog, requires: "super_admin" },
      { label: "Settings", href: "/settings", icon: Settings, requires: "super_admin" },
    ],
  },
  {
    group: "Help",
    items: [{ label: "Documentation", href: "/docs", icon: BookOpen }],
  },
];

/**
 * Le lien à marquer actif pour `pathname` : le PLUS LONG `href` qui le couvre, un seul.
 *
 * ⛔ UN SIMPLE `startsWith` ALLUME DEUX LIENS depuis que « Automations » (`/automations`) a des
 * une sous-entrée (`/automations/targeting`) : sur la page Targeting, les deux seraient surlignés et `aria-current="page"` serait porté deux fois. Le plus long préfixe
 * désigne l'entrée la plus précise ; la frontière `/` évite qu'un `/formsX` allume « Forms ».
 */
export function lienActif(pathname: string, hrefs: string[]): string | null {
  let meilleur: string | null = null;
  for (const href of hrefs) {
    const couvre = href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
    if (couvre && (meilleur === null || href.length > meilleur.length)) meilleur = href;
  }
  return meilleur;
}

const TOUS_LES_HREFS = NAV.flatMap((s) => s.items.map((i) => i.href));

/** Liste de navigation partagée entre la sidebar desktop et le panneau mobile. */
function NavLinks({ viewer, onNavigate }: { viewer: Viewer; onNavigate?: () => void }) {
  const pathname = usePathname();
  const actif = lienActif(pathname, TOUS_LES_HREFS);
  const autorise = (item: NavItem) => !item.requires || viewer?.role === item.requires;
  return (
    <>
      {NAV.map((section) => {
        const items = section.items.filter(autorise);
        // Un intitulé de groupe sans aucun lien dessous serait un titre qui ne titre rien.
        if (items.length === 0) return null;
        return (
        <div key={section.group}>
          <div className="px-2.5 pb-1.5 pt-3.5 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground/60">
            {section.group}
          </div>
          {items.map((item) => {
            const active = item.href === actif;
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "mb-0.5 flex items-center gap-3 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors",
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-semibold"
                    : "text-foreground/75 hover:bg-accent hover:text-foreground",
                )}
              >
                <Icon
                  className={cn("h-[17px] w-[17px] shrink-0", active ? "text-brand" : "text-muted-foreground")}
                  strokeWidth={1.8}
                />
                {item.label}
                {item.badge && (
                  <span
                    className={cn(
                      "ml-auto rounded-full border px-[7px] py-px text-[10.5px] font-semibold tabular-nums",
                      active
                        ? "border-brand-soft bg-white text-brand"
                        : "border-border bg-accent text-muted-foreground",
                    )}
                  >
                    {item.badge}
                  </span>
                )}
              </Link>
            );
          })}
        </div>
        );
      })}
    </>
  );
}

function BrandMark() {
  return (
    <div className="flex items-center gap-2.5 px-2 pb-3.5">
      <div className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-brand shadow-[0_2px_8px_rgba(255,54,141,0.35)]">
        <Mail className="h-4 w-4 text-white" strokeWidth={2} />
      </div>
      <div className="leading-tight">
        <div className="text-[14.5px] font-semibold tracking-tight">
          newsletter<span className="text-brand">·</span>forge
        </div>
        <div className="text-[10px] font-medium text-muted-foreground/70">Example Media</div>
      </div>
    </div>
  );
}

/**
 * Pied de sidebar : identité, changement de son mot de passe, déconnexion (POST réel vers
 * /api/auth/logout).
 * ⚠️ Le nom et le rôle viennent de la SESSION. Ils étaient écrits en dur (« Alix P. »,
 * « Full access ») : un membre y aurait lu qu'il a tous les droits.
 */
function UserFooter({ viewer }: { viewer: Viewer }) {
  const identifiant = viewer?.email ?? "";
  // Deux initiales tirées de la partie locale de l'adresse : « bruno.silva@ » donne « BS ».
  const initiales =
    identifiant
      .split("@")[0]
      .split(/[^a-zA-Z0-9]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? "")
      .join("") || "?";
  const role = viewer?.role === "super_admin" ? "Full access" : viewer ? "Member" : "Not signed in";

  return (
    <div className="mt-auto flex items-center gap-2.5 border-t border-border px-2 pt-3">
      <div className="flex h-[30px] w-[30px] items-center justify-center rounded-full bg-foreground text-[11.5px] font-semibold text-background">
        {initiales}
      </div>
      <div className="min-w-0 flex-1 leading-tight">
        <div className="truncate text-[12.5px] font-semibold" title={identifiant}>
          {identifiant || "—"}
        </div>
        <div className="text-[10.5px] text-muted-foreground">{role}</div>
      </div>
      {viewer && <ChangePassword email={viewer.email} />}
      <form method="post" action="/api/auth/logout">
        <button
          type="submit"
          title="Log out"
          aria-label="Log out"
          className="rounded-md p-1.5 text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
        >
          <LogOut className="h-[15px] w-[15px]" />
        </button>
      </form>
    </div>
  );
}

export function Sidebar({ current, options, viewer }: NavProps) {
  return (
    <aside className="hidden md:flex w-[248px] shrink-0 flex-col border-r border-border bg-sidebar sticky top-0 h-screen px-3 py-4">
      <BrandMark />
      <AssetSwitcher current={current} options={options} className="mx-1 mb-4" />
      <nav className="flex-1 overflow-y-auto">
        <NavLinks viewer={viewer} />
      </nav>
      <UserFooter viewer={viewer} />
    </aside>
  );
}

/**
 * Navigation mobile (<768 px) : la sidebar est `hidden md:flex`, rien ne la remplaçait —
 * ni navigation ni déconnexion possibles. Le panneau est monté via un portail sur <body>
 * car la Topbar utilise `backdrop-blur`, qui crée un bloc conteneur pour `position: fixed`.
 */
export function MobileNav({ current, options, viewer }: NavProps) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const pathname = usePathname();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Fermeture sur navigation (le lien cliqué change la route).
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    // Passage en desktop pendant l'ouverture : le panneau disparaît, on remet l'état à plat.
    const mq = window.matchMedia("(min-width: 768px)");
    const onChange = () => {
      if (mq.matches) setOpen(false);
    };

    document.addEventListener("keydown", onKeyDown);
    mq.addEventListener("change", onChange);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      mq.removeEventListener("change", onChange);
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open navigation"
        aria-expanded={open}
        className="md:hidden flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] border border-border bg-card transition-colors hover:bg-accent"
      >
        <Menu className="h-[17px] w-[17px] text-foreground/70" strokeWidth={1.9} />
      </button>

      {mounted &&
        open &&
        createPortal(
          <div className="fixed inset-0 z-50 md:hidden">
            <div
              className="absolute inset-0 bg-black/40 backdrop-blur-[1px]"
              onClick={() => setOpen(false)}
              aria-hidden="true"
            />
            <div
              ref={panelRef}
              tabIndex={-1}
              role="dialog"
              aria-modal="true"
              aria-label="Navigation"
              className="absolute inset-y-0 left-0 flex w-[280px] max-w-[85vw] flex-col border-r border-border bg-sidebar px-3 py-4 shadow-2xl outline-none"
            >
              <div className="flex items-start justify-between">
                <BrandMark />
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close navigation"
                  className="mt-1 rounded-md p-1.5 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
                >
                  <X className="h-[17px] w-[17px]" />
                </button>
              </div>

              <AssetSwitcher current={current} options={options} className="mx-1 mb-4" />

              <nav className="flex-1 overflow-y-auto">
                <NavLinks viewer={viewer} onNavigate={() => setOpen(false)} />
              </nav>

              <UserFooter viewer={viewer} />
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
