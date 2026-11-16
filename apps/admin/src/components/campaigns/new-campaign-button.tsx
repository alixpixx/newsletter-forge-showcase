"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { CampaignWizard } from "@/components/campaigns/campaign-wizard";
import type { PublishedVersion, SegmentOption } from "@/components/campaigns/shared";

/**
 * Ouvre l'assistant de campagne.
 *
 * Les listes (versions publiées, segments, finalités) sont chargées par la PAGE serveur et
 * traversées en props : un composant client ne doit jamais importer `campaign-data.ts`, qui tire
 * `getDb()` et la clé service_role.
 */
export function NewCampaignButton({
  versions,
  segments,
  purposes,
  editionTimezone = null,
  variant = "primary",
  disabled = false,
  disabledReason,
}: {
  versions: PublishedVersion[];
  segments: SegmentOption[];
  purposes: string[];
  /** Fuseau de l'édition, pour pré-remplir la cadence — jamais celui du navigateur. */
  editionTimezone?: string | null;
  variant?: "primary" | "topbar";
  /** `true` quand aucune marque n'est résolue en base : créer échouerait côté API (503). */
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [open, setOpen] = useState(false);

  const cls =
    variant === "topbar"
      ? "flex items-center gap-2 rounded-[9px] bg-brand px-3.5 py-2 text-[13px] font-medium text-brand-foreground shadow-[0_1px_3px_rgba(255,54,141,0.35)] transition-colors hover:bg-[#ec2079]"
      : "inline-flex items-center gap-2 rounded-[9px] bg-brand px-3.5 py-2 text-[13px] font-medium text-brand-foreground shadow-[0_1px_3px_rgba(255,54,141,0.35)] transition-colors hover:bg-[#ec2079]";

  if (disabled) {
    return (
      <button disabled title={disabledReason ?? "Unavailable"} className={`${cls} cursor-not-allowed opacity-50`}>
        <Plus className="h-[15px] w-[15px]" strokeWidth={2} /> New campaign
      </button>
    );
  }

  return (
    <>
      <button onClick={() => setOpen(true)} className={cls}>
        <Plus className="h-[15px] w-[15px]" strokeWidth={2} /> New campaign
      </button>
      <CampaignWizard
        open={open}
        onClose={() => setOpen(false)}
        versions={versions}
        segments={segments}
        purposes={purposes}
        editionTimezone={editionTimezone}
      />
    </>
  );
}
