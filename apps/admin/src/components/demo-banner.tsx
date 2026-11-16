import { Info } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Bandeau d'honnêteté (vague « faux-semblants »).
 *
 * Tout écran encore alimenté par des données inventées doit l'afficher en haut de page.
 * Ton sobre (ambre), jamais criard : c'est une note de contexte, pas une alerte.
 */
export function DemoBanner({ text, className }: { text?: string; className?: string }) {
  return (
    <div
      role="note"
      className={cn(
        "mb-5 flex items-start gap-2.5 rounded-[12px] border border-[#f0dfbe] bg-[#fdf0dd]/55 px-3.5 py-2.5",
        className,
      )}
    >
      <Info className="mt-[1px] h-[15px] w-[15px] shrink-0 text-[#b9790a]" strokeWidth={2} />
      <p className="text-[12.5px] leading-snug text-[#8a5c0c]">
        {text ?? "Demo data — not connected to the database yet."}
      </p>
    </div>
  );
}
