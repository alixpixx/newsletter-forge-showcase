"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";

/**
 * L'interrupteur de mélange d'une campagne (`campaign.mix_latest`, migration 0049).
 *
 * ⭐ POURQUOI IL VIT ICI ET PAS DANS LE MODÈLE. Un `template_version` sert PLUSIEURS campagnes, et
 * c'est déjà le cas en production : « Friday NL TW » et « Resumo da rodada — domingo » pointent
 * toutes deux la version 509c87c3. Une case posée dans le builder les toucherait ensemble ; Alix
 * veut le mélange sur l'une et pas sur l'autre.
 *
 * ⛔ ELLE DIT CE QU'ELLE COMMANDE. Une case dont on ignore la portée est un piège : on la coche, la
 * lettre ne change pas, et on va chercher la panne dans l'entrepôt d'audience. Le compte de blocs
 * concernés est donc affiché SOUS elle, et il vaut zéro aujourd'hui — aucun modèle en base n'est
 * classé par vues (mesuré le 04/09/2026 : 0 sur les 17 versions portant un flux).
 */
export function MixLatestToggle({
  campaignId,
  initial,
  blocs,
  locked,
}: {
  campaignId: string;
  initial: boolean;
  /** `null` = la campagne n'a pas encore de modèle. Voir `compterBlocsClassables`. */
  blocs: { total: number; parVues: number } | null;
  locked: boolean;
}) {
  const router = useRouter();
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(next: boolean) {
    setBusy(true);
    setError(null);
    // ⚠️ On peint l'état voulu tout de suite, et on le REMET si le serveur refuse. Laisser la case
    // dans l'ancien état pendant l'aller-retour donne l'impression d'un clic perdu, et l'opérateur
    // re-clique — ce qui envoie la valeur inverse.
    setValue(next);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/content`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mixLatest: next }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
        throw new Error(typeof body?.error === "string" ? body.error : "the setting could not be saved");
      }
      router.refresh();
    } catch (e) {
      setValue(!next);
      setError(e instanceof Error ? e.message : "the setting could not be saved");
    } finally {
      setBusy(false);
    }
  }

  /**
   * ⛔ TROIS PHRASES POUR TROIS SITUATIONS QUI N'APPELLENT PAS LE MÊME GESTE : choisir un modèle,
   * régler un bloc sur « les plus vus », ou rien du tout. Une phrase unique les confondrait, et
   * c'est précisément quand la case ne fait rien qu'on a besoin de savoir pourquoi.
   */
  const portee =
    blocs === null
      ? "This campaign has no template yet, so there is nothing to mix."
      : blocs.parVues === 0
        ? `None of the ${blocs.total} article block${blocs.total === 1 ? "" : "s"} in this template ranks by views, so this setting changes nothing today. Set a block to “Most viewed” in the builder first.`
        : `Applies to ${blocs.parVues} of the ${blocs.total} article block${blocs.total === 1 ? "" : "s"} in this template — the one${blocs.parVues === 1 ? "" : "s"} ranked by views.`;

  const inerte = blocs === null || blocs.parVues === 0;

  return (
    <div className="mt-7">
      <h2 className="mb-2.5 text-[15px] font-bold tracking-tight">Article mix</h2>
      <div className="rounded-xl border border-border bg-card p-4">
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-primary disabled:cursor-not-allowed"
            checked={value}
            disabled={busy || locked}
            onChange={(e) => void toggle(e.target.checked)}
          />
          <span>
            <span className="block text-[13.5px] font-semibold">Mix in the latest articles</span>
            <span className="mt-0.5 block max-w-[74ch] text-[12.5px] text-muted-foreground">
              Half the cards keep the most viewed articles of the period, half take the freshest
              ones. Analytics stops two days short of today, so the newest articles have no view
              counts yet — this is what puts them back in the letter.
            </span>
          </span>
        </label>

        <p
          className={`mt-3 max-w-[74ch] border-t border-border pt-3 text-[12.5px] ${
            value && inerte ? "text-amber-700" : "text-muted-foreground"
          }`}
        >
          {value && inerte && <AlertTriangle className="mr-1.5 inline h-3.5 w-3.5 align-[-2px]" />}
          {portee}
        </p>

        {locked && (
          <p className="mt-2 text-[12.5px] text-muted-foreground">
            This campaign is locked — its articles are already frozen, so the setting no longer
            affects what goes out.
          </p>
        )}

        {error && <p className="mt-2 text-[12.5px] text-amber-700">{error}</p>}
      </div>
    </div>
  );
}
