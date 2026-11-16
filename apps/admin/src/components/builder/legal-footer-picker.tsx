"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ExternalLink, Loader2, Lock } from "lucide-react";
import type { Block } from "@nf/render/schema";
import { fetchLegalLibrary, type LegalLibrary } from "@/components/templates/library-client";

/**
 * Le seul réglage du bloc légal : QUEL pied légal part. Son contenu se compose dans Templates ›
 * Legal footers ; les liens de désinscription et de préférences restent générés par destinataire.
 *
 * ⛔ UN CHOIX QUI N'EST PLUS DANS LA LISTE RESTE AFFICHÉ. Un template archivé après avoir été choisi
 * continue de partir avec cet e-mail : le faire disparaître du menu ferait croire que l'e-mail est
 * revenu au pied par défaut.
 */
export function LegalFooterPicker({
  block,
  patch,
}: {
  block: Extract<Block, { type: "footer_legal" }>;
  patch: (p: Record<string, unknown>) => void;
}) {
  const [library, setLibrary] = useState<LegalLibrary | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  useEffect(() => {
    let annule = false;
    fetchLegalLibrary()
      .then((l) => {
        if (!annule) setLibrary(l);
      })
      .catch((e: Error) => {
        if (!annule) setErreur(e.message);
      });
    return () => {
      annule = true;
    };
  }, []);

  const choisi = block.legalTemplateId ?? "";
  const horsListe = choisi !== "" && library !== null && !library.legalFooters.some((t) => t.id === choisi);

  return (
    <div className="space-y-2.5">
      <label className="block text-[12px]">
        <span className="mb-1 block font-medium">Legal footer</span>
        {erreur ? (
          <span className="flex items-start gap-1.5 text-[11.5px] leading-snug text-[#a33]">
            <AlertTriangle className="mt-[2px] h-3 w-3 shrink-0" strokeWidth={2} />
            {erreur}
          </span>
        ) : library === null ? (
          <span className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} /> Loading…
          </span>
        ) : (
          <select
            className="w-full rounded-[8px] border border-border bg-background px-2.5 py-1.5 text-[12.5px]"
            value={choisi}
            onChange={(e) => patch({ legalTemplateId: e.target.value || undefined })}
          >
            <option value="">Brand default</option>
            {library.legalFooters.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
            {horsListe && <option value={choisi}>Archived legal footer (still in use)</option>}
          </select>
        )}
      </label>

      <Link
        href="/templates?tab=legal"
        target="_blank"
        className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground"
      >
        Edit legal footers <ExternalLink className="h-3 w-3" strokeWidth={2} />
      </Link>

      <div className="rounded-[10px] border border-border bg-accent/40 p-3 text-[12px] leading-relaxed text-muted-foreground">
        <Lock className="mb-1.5 h-3.5 w-3.5" strokeWidth={2} />
        The unsubscribe and preference links are generated per recipient at send time, whatever footer you pick. This
        block cannot be moved out, duplicated or deleted.
      </div>
    </div>
  );
}
