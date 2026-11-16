import { cn } from "@/lib/utils";

/* Primitives partagées — présentational, server-safe (pas de handlers). */

const TONES: Record<string, string> = {
  green: "bg-[#e2f5e9] text-[#1f9d57]",
  blue: "bg-[#e6effe] text-[#3d7fef]",
  amber: "bg-[#fdf0dd] text-[#b9790a]",
  pink: "bg-brand-soft text-brand-soft-foreground",
  violet: "bg-[#efeafe] text-[#7c5cf0]",
  red: "bg-[#fdeaec] text-[#c0334a]",
  grey: "bg-accent text-muted-foreground",
};

export type Tone = keyof typeof TONES;

export function Pill({
  tone = "grey", dot = false, className, children,
}: { tone?: Tone; dot?: boolean; className?: string; children: React.ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-[3px] text-[11.5px] font-semibold", TONES[tone], className)}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

export function PageHead({
  title, desc, children,
}: { title: string; desc?: string; children?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-[22px] font-bold tracking-tight">{title}</h1>
        {desc && <p className="mt-1 max-w-[64ch] text-[13px] text-muted-foreground">{desc}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2.5">{children}</div>}
    </div>
  );
}

export function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("rounded-[14px] border border-border bg-card p-[18px]", className)}>{children}</div>;
}

export function CardHead({ title, sub, right }: { title: string; sub?: string; right?: React.ReactNode }) {
  return (
    <div className="mb-3.5 flex items-center justify-between">
      <div>
        <h3 className="text-[13.5px] font-semibold">{title}</h3>
        {sub && <span className="text-[12px] text-muted-foreground">{sub}</span>}
      </div>
      {right}
    </div>
  );
}

type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "primary" | "dark" | "ghost" };

export function Btn({ variant = "default", className, children, ...props }: BtnProps) {
  const v = {
    default: "border border-border bg-card hover:bg-accent",
    primary: "bg-brand text-brand-foreground shadow-[0_1px_3px_rgba(255,54,141,0.35)] hover:bg-[#ec2079]",
    dark: "bg-foreground text-background hover:bg-black",
    ghost: "text-muted-foreground hover:bg-accent hover:text-foreground",
  }[variant];
  return (
    // `disabled` DOIT se voir. Sans ces classes, un bouton désarmé garde l'aspect d'un bouton
    // armé : on clique, rien ne se passe, et l'utilisateur conclut que le produit est cassé plutôt
    // qu'il manque une étape. C'était le cas de TOUS les `Btn` de l'admin, pas d'un écran.
    // ⚠️ Pas de `pointer-events-none` : plusieurs boutons désarmés portent la RAISON dans leur
    // `title`, et couper les événements de pointeur emporterait l'infobulle avec le clic.
    <button
      className={cn(
        "inline-flex items-center gap-2 rounded-[9px] px-3.5 py-2 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none",
        v,
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

/** En-tête de table réutilisable. */
export function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  // a11y : 12px + gris plus foncé (foreground/65) + tracking réduit → en-têtes plus lisibles.
  return <th className={cn("border-b border-border px-4 py-3 text-left text-[12px] font-semibold uppercase tracking-[0.02em] text-foreground/60", className)}>{children}</th>;
}
export function Td({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <td className={cn("border-b border-border px-4 py-3", className)}>{children}</td>;
}
