import { notFound } from "next/navigation";
import { AlertTriangle, Lock } from "lucide-react";
import { Card, CardHead, PageHead, Pill } from "@/components/ui";
import { BackLink } from "@/components/automations/views";
import { LifecycleSwitch } from "@/components/automations/lifecycle-switch";
import { LifecyclePanel } from "@/components/templates/lifecycle-panel";
import { fmtInt } from "@/components/campaigns/shared";
import { getCurrentAsset } from "@/lib/asset-context";
import { listTemplatesRead } from "@/lib/data/templates";
import { listLifecycleBindings } from "@/lib/data/lifecycle-templates";
import { assetEditionLocales } from "@/lib/data/asset-editions";
import { countLifecycleSent30d, listLifecycleSettings } from "@/lib/data/lifecycle-settings";
import { lifecycleSlots } from "@/lib/lifecycle-slots";
import {
  CONFIRMATION_LOCKED_WHY,
  SYSTEM_ROWS,
  canTurnOff,
  isLifecycleEditable,
  systemRowDoes,
  systemRowName,
  type LifecycleEditable,
} from "@/lib/automations";

export const dynamic = "force-dynamic";

/** Le déclencheur, dit en clair (il est fixe : c'est l'inscription, la confirmation, le désabonnement). */
const DECLENCHEUR: Record<LifecycleEditable, string> = {
  confirmation:
    "Someone signs up — on a form of this brand, or through a capture tool such as OptinForge. Sent immediately; the link stays valid 48 hours.",
  welcome: "Someone clicks the link in the confirmation email, and the subscription becomes active. Sent immediately, once.",
  unsubscribe_ack:
    "Someone unsubscribes on the unsubscribe page or in the preference center. Sent immediately. Never after the one-click unsubscribe of a mail client.",
};

/** Ce que « Off » change, dit AVANT le geste. */
const EFFET_OFF: Record<"welcome" | "unsubscribe_ack", string> = {
  welcome: "people who confirm are subscribed as usual; they just receive no welcome email.",
  unsubscribe_ack: "unsubscribes still take effect immediately; no receipt email is sent.",
};

/**
 * Automations › System › un e-mail de cycle de vie (24/09/2026, feature 3 — Alix : « que tout soit
 * éditable directement depuis la page automations »).
 *
 * Quatre blocs : le déclencheur (verrouillé, expliqué), on/off (sauf la confirmation), le modèle
 * (`LifecyclePanel` réduit à SA fente : mêmes routes d'écriture qu'avant, donc mêmes contrôles —
 * 422 sur une confirmation sans `{{confirm_url}}`), et les envois des 30 derniers jours.
 *
 * ⛔ Lecture ratée ⇒ l'aveu : jamais « On » par défaut, jamais « 0 ».
 */
export default async function SystemEmailPage({ params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  if (!isLifecycleEditable(kind)) notFound();
  const ligne = SYSTEM_ROWS.find((r) => r.type === "lifecycle" && r.kind === kind)!;

  const asset = await getCurrentAsset();
  const [lectureModeles, lecture, lectureLangues, interrupteurs, envoyes] = await Promise.all([
    listTemplatesRead(asset.id),
    listLifecycleBindings(asset.id),
    assetEditionLocales(asset.id),
    listLifecycleSettings(asset.id),
    countLifecycleSent30d(asset.id, kind, new Date()),
  ]);
  const etatConnu = lectureModeles.known && lecture.known;
  const fente = lifecycleSlots(lecture.value, lectureModeles.value).filter((f) => f.kind === kind);

  return (
    <div className="animate-fade-up">
      <BackLink />
      <div className="mt-2">
        <PageHead title={systemRowName(ligne)} desc={systemRowDoes(ligne)}>
          <Pill tone="pink" dot>
            {asset.name}
          </Pill>
        </PageHead>
      </div>

      {!asset.id && (
        <div className="mb-4 flex items-start gap-2.5 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>Database unavailable — the brand could not be resolved, so this email cannot be read or changed right now.</span>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <div className="flex flex-col gap-4">
          <Card>
            <CardHead title="Trigger" sub="Fixed: it is part of the subscription itself" />
            <div className="flex items-start gap-2.5">
              <Lock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <p className="text-[13px] leading-relaxed text-foreground/85">{DECLENCHEUR[kind]}</p>
            </div>
            {ligne.note && <p className="mt-2 text-[12px] leading-snug text-muted-foreground">{ligne.note}</p>}
          </Card>

          <LifecyclePanel
            slots={fente}
            templates={lectureModeles.value.map((t) => ({ id: t.id, name: t.name, publishedVersion: t.publishedVersion }))}
            known={Boolean(asset.id) && etatConnu}
            brandKnown={Boolean(asset.id)}
            assetId={asset.id}
            languages={lectureLangues.known ? lectureLangues.value : []}
            canSeedAllBrands={false}
            head={{
              title: "Email",
              sub: "The built-in email goes out unless you point it at one of your templates. “Customise” creates an editable copy of the built-in email, ready to edit in the builder.",
            }}
          />
        </div>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHead title="On / off" />
            {canTurnOff(kind) ? (
              <LifecycleSwitch
                kind={kind}
                enabled={interrupteurs.value[kind]}
                known={interrupteurs.known && Boolean(asset.id)}
                effectOff={EFFET_OFF[kind]}
              />
            ) : (
              <div className="flex flex-col gap-2">
                <Pill tone="grey">
                  <Lock className="h-3 w-3" /> Always on
                </Pill>
                <p className="text-[12px] leading-snug text-muted-foreground">{CONFIRMATION_LOCKED_WHY}</p>
              </div>
            )}
          </Card>

          <Card>
            <CardHead title="Sent · 30 days" sub="Accepted by Mailgun for this brand" />
            {envoyes === null ? (
              <p className="text-[12.5px] text-amber-700">Could not be read right now.</p>
            ) : (
              <p className="text-[22px] font-semibold tabular-nums">{fmtInt(envoyes)}</p>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
