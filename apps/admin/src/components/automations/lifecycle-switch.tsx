"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Btn, Pill } from "@/components/ui";
import { readError } from "@/components/campaigns/shared";

/**
 * L'interrupteur d'un e-mail de cycle de vie (Welcome, accusé de désinscription) — 0086.
 *
 * ⛔ AUCUN FAUX SUCCÈS : l'état affiché est celui que le serveur a rendu ; il ne bascule qu'après un
 * 2xx ET le rafraîchissement de la page. Une erreur s'affiche telle que la route l'a écrite.
 * ⛔ Verrou synchrone (`ref`) : un double clic n'envoie pas deux requêtes contraires.
 */
export function LifecycleSwitch({
  kind,
  enabled,
  known,
  effectOff,
}: {
  kind: "welcome" | "unsubscribe_ack";
  enabled: boolean;
  /** Faux = état non lu : on ne propose pas de le changer à l'aveugle. */
  known: boolean;
  /** Ce qui se passe quand il est coupé, en une phrase (dit AVANT le geste). */
  effectOff: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, startTransition] = useTransition();
  const enEcriture = useRef(false);

  if (!known) {
    return <p className="text-[12.5px] text-amber-700">On/off could not be read right now, so it cannot be changed. Try again in a moment.</p>;
  }

  async function basculer() {
    if (enEcriture.current) return;
    enEcriture.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/automations/system/${kind}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !enabled }),
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setError("Network error: nothing was changed.");
    } finally {
      setBusy(false);
      enEcriture.current = false;
    }
  }

  const attente = busy || refreshing;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        {enabled ? (
          <Pill tone="green" dot>
            On
          </Pill>
        ) : (
          <Pill tone="grey" dot>
            Off
          </Pill>
        )}
        <Btn variant={enabled ? "ghost" : "primary"} disabled={attente} onClick={basculer}>
          {attente && <Loader2 className="h-4 w-4 animate-spin" />}
          {enabled ? "Switch off" : "Switch on"}
        </Btn>
      </div>
      <p className="text-[12px] leading-snug text-muted-foreground">
        {enabled ? `Switching it off: ${effectOff}` : `Off: ${effectOff}`}
      </p>
      {error && <p className="text-[12px] text-red-700">{error}</p>}
    </div>
  );
}
