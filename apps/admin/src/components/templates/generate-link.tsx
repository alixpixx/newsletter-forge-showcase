import Link from "next/link";
import { Sparkles } from "lucide-react";
import { Btn } from "@/components/ui";

/**
 * Point d'entrée du générateur IA. Volontairement un simple lien serveur : la page `/builder/new`
 * porte toute la logique, donc rien à hydrater ici.
 *
 * Désactivé quand la marque n'est pas résolue en base : on le DIT au lieu de laisser l'utilisateur
 * attendre trois minutes une génération qui ne pourra pas être enregistrée.
 */
export function GenerateWithAiButton({ disabled = false }: { disabled?: boolean }) {
  if (disabled) {
    return (
      <Btn
        variant="default"
        disabled
        title="Database unavailable — a generated template could not be saved"
        className="cursor-not-allowed opacity-50"
      >
        <Sparkles className="h-[15px] w-[15px]" strokeWidth={2} /> Generate with AI
      </Btn>
    );
  }

  return (
    <Link
      href="/builder/new"
      className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-[13px] font-medium transition-colors hover:bg-accent"
    >
      <Sparkles className="h-[15px] w-[15px] text-brand" strokeWidth={2} /> Generate with AI
    </Link>
  );
}
