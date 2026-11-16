import Link from "next/link";
import { AlertTriangle, ArrowRight, Filter } from "lucide-react";
import { PageHead, Pill } from "@/components/ui";
import { SystemCard, type CustomRow, type ListeLue } from "@/components/automations/views";
import { SemerToutesLesMarques } from "@/components/templates/lifecycle-panel";
import { getCurrentAsset } from "@/lib/asset-context";
import { getSessionUser } from "@/lib/session";
import { getDb } from "@/lib/supabase";
import { listAutomations } from "@/lib/data/automations";
import { listLifecycleSettings } from "@/lib/data/lifecycle-settings";
import { listSegmentsRead } from "@/lib/data/segments";

// Tout est lu en base à chaque requête : l'écran décrit la marque courante, maintenant.
export const dynamic = "force-dynamic";

/**
 * Automations — l'accueil de la section.
 *
 * ⭐ 24/09/2026, feature 3 (Alix : « tout dans système, même les lifecycles, et que tout soit éditable
 * directement depuis la page automations ») : UNE carte « System » porte les 15 lignes du tableau
 * d'Alix — e-mails de cycle de vie, déclencheurs du moteur avec leurs automations, règles. L'ancienne
 * page « Lifecycle emails » redirige ici ; chaque e-mail a sa page (`/automations/system/[kind]`).
 *
 * ⛔ AUCUNE AUTOMATION FACTICE. Une section « Automations » a déjà été servie en production puis
 * RETIRÉE le 31/08 (`93fe012`) : c'était un tableau d'automatisations qui ne déclenchait rien, avec
 * des chiffres fabriqués — « une maquette accessible en production ne se lit pas comme une
 * maquette, elle se lit comme un chiffre ». Cet écran ne montre donc que ce qui EXISTE et ce qu'on
 * a LU.
 *
 * ⛔ UN COMPTE NON LU N'EST PAS ZÉRO. Chaque lecture dit si elle a abouti ; sinon l'écran écrit qu'il
 * ne sait pas, jamais « 0 » ni « Off ». Si 0082 n'est pas appliquée, la carte le DIT et n'offre aucun
 * bouton.
 */
export default async function AutomationsPage() {
  const asset = await getCurrentAsset();
  const [lectureSegments, custom, interrupteurs, user] = await Promise.all([
    listSegmentsRead(asset.id),
    lireSurMesure(asset.id),
    listLifecycleSettings(asset.id),
    getSessionUser(),
  ]);
  const segments = lectureSegments.value.length;

  return (
    <div className="animate-fade-up">
      <PageHead
        title="Automations"
        desc="Emails that go out on their own, and the rules that decide who receives your newsletters."
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Pill tone="pink" dot>
          {asset.name}
        </Pill>
      </div>

      {!asset.id && (
        <div className="mb-4 flex items-start gap-2.5 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>Database unavailable — the brand could not be resolved, so nothing below could be read.</span>
        </div>
      )}

      <div className="flex flex-col gap-4">
        <SystemCard automations={custom} lifecycle={interrupteurs} brand={asset.name} />
        {/* Déplacée de l'ancienne page « Lifecycle emails » : écrit chez TOUTES les marques, donc super_admin
            seulement — comme sa route, qui refuse d'elle-même un autre rôle. */}
        {user?.isSuperAdmin && <SemerToutesLesMarques />}
        <Link
          href="/automations/targeting"
          className="group flex flex-wrap items-center gap-x-4 gap-y-1 rounded-[14px] border border-border bg-card px-[18px] py-3.5 transition-colors hover:bg-accent/40"
        >
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-brand-soft">
              <Filter className="h-4 w-4 text-brand" strokeWidth={1.9} />
            </div>
            <h2 className="text-[14px] font-semibold">Targeting</h2>
          </div>
          <p className="text-[12.5px] text-muted-foreground">
            Segments: saved rules, evaluated when a campaign is queued — never a stored list.
          </p>
          {/* Faux = lecture non aboutie : l'aveu, en ambre, jamais « 0 ». */}
          <span
            className={
              lectureSegments.known
                ? "ml-auto text-[12.5px] font-medium tabular-nums"
                : "ml-auto text-[12.5px] font-medium text-amber-700"
            }
          >
            {lectureSegments.known ? `${segments} saved segment${segments === 1 ? "" : "s"}` : "Could not be read right now"}
          </span>
          <ArrowRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
        </Link>
      </div>
    </div>
  );
}

/** La liste des automations, lue en base — ou l'aveu de ce qui manque (base, marque, migration). */
async function lireSurMesure(assetId: string | null): Promise<ListeLue<CustomRow[]>> {
  const db = getDb();
  if (!db || !assetId) return { state: "no-db" };
  const lue = await listAutomations(db, assetId, new Date());
  if (lue.state !== "ok") return lue;
  return {
    state: "ok",
    value: lue.value.map((a) => ({
      id: a.id,
      name: a.name,
      trigger: a.trigger,
      status: a.status,
      lastRunAt: a.lastRunAt,
      sent7d: a.sent7d,
      simulated7d: a.simulated7d,
    })),
  };
}
