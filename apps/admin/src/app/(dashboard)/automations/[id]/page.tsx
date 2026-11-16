import { notFound } from "next/navigation";
import { TRIGGERS, validateAutomation, type TriggerSpec } from "@nf/automations";
import { PageHead, Pill } from "@/components/ui";
import { AutomationForm } from "@/components/automations/automation-form";
import { defaultsFor, type FormValue } from "@/components/automations/form-values";
import { EditButton } from "@/components/automations/edit-button";
import { AutomationActions } from "@/components/automations/row-actions";
import { StatusControls } from "@/components/automations/status-controls";
import {
  AudienceCard,
  BackLink,
  Bandeau,
  FiltersCard,
  GuardrailsCard,
  SendLogCard,
  StatusSummary,
  StepsCard,
  TriggerCard,
  type StepView,
} from "@/components/automations/views";
import { getCurrentAsset } from "@/lib/asset-context";
import { getSessionUser } from "@/lib/session";
import { getDb } from "@/lib/supabase";
import { raisonDeclencheurFige, simulationRan, triggerLabel } from "@/lib/automations";
import { actionsFor } from "@/lib/automation-edit";
import {
  countAllSends,
  countSends,
  describeVersions,
  findAutomation,
  listFilterOptions,
  listStepTemplates,
  listTimezonesInUse,
  probeAudience,
  readSendLog,
  stepsOf,
  toRecord,
  type AutomationRow,
} from "@/lib/data/automations";

export const dynamic = "force-dynamic";

/**
 * La page d'une automation sur mesure (plan, étapes 10 et 13 ; plan AUTO-EDIT du 25/09/2026).
 *
 * ⭐ UN BROUILLON S'OUVRE EN FORMULAIRE (Alix, 25/09 : « un outil très simple pour créer / éditer /
 * modifier nos automations ») : même `AutomationForm` que la création, avec en tête le statut et les
 * contrôles d'état (Simulate…), puis l'aperçu d'audience et les journaux. Hors brouillon, la fiche en
 * lecture seule reste — modifier une automation qui tourne passe par « Stop and edit », qui l'ARRÊTE.
 * La décision est `actionsFor` (pure, testée). `/automations/[id]/edit` redirige ici.
 *
 * ⛔ TOUT CE QUI EST AFFICHÉ EST LU : l'aperçu vient de la sonde du moteur (`automation_due`,
 * `p_probe`), les journaux de `automation_send`. Une lecture ratée s'affiche comme telle.
 */
export default async function AutomationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string | string[] }>;
}) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const [asset, user] = await Promise.all([getCurrentAsset(), getSessionUser()]);
  const db = getDb();

  if (!db || !asset.id) {
    return (
      <div className="animate-fade-up">
        <BackLink />
        <div className="mt-3">
          <Bandeau tone="amber">Database unavailable: this automation could not be read.</Bandeau>
        </div>
      </div>
    );
  }

  const lue = await findAutomation(db, id, asset.id);
  if (lue.state !== "ok") {
    return (
      <div className="animate-fade-up">
        <BackLink />
        <div className="mt-3">
          {lue.state === "not-installed" ? (
            <Bandeau tone="grey">Custom automations are not installed on this database yet (migration 0082).</Bandeau>
          ) : (
            <Bandeau tone="red">This automation could not be read: {lue.message}</Bandeau>
          )}
        </div>
      </div>
    );
  }
  const a = lue.value;
  if (!a) notFound();

  const gestes = actionsFor(a.status, a.trigger);
  const formulaire = gestes.page === "form";
  const spec: TriggerSpec | undefined = (TRIGGERS as Record<string, TriggerSpec | undefined>)[a.trigger];
  const etapes = stepsOf(a);
  const versionIds = etapes.map((s) => s.templateVersionId).filter((v): v is string => !!v);

  const [versions, filtres, sonde, simules, reels, simulesDepuis, modeles, selections, fuseaux] = await Promise.all([
    describeVersions(asset.id, versionIds),
    listFilterOptions(asset.id),
    spec?.engine ? probeAudience(db, a.id, etapes.length) : Promise.resolve(null),
    readSendLog(db, a.id, asset.id, true),
    readSendLog(db, a.id, asset.id, false),
    a.status === "simulation" && a.statusChangedAt
      ? countSends(db, a.id, asset.id, true, a.statusChangedAt)
      : Promise.resolve(0),
    // Ce que seul le formulaire lit.
    formulaire ? listStepTemplates(asset.id) : Promise.resolve({ known: false, value: [] }),
    formulaire ? countAllSends(db, a.id, asset.id) : Promise.resolve(null),
    formulaire ? listTimezonesInUse() : Promise.resolve([] as string[]),
  ]);

  const steps: StepView[] = etapes.map((s, i) => {
    const d = s.templateVersionId ? versions.get(s.templateVersionId) : undefined;
    return {
      n: i + 1,
      delayHours: s.delayHours,
      template: d?.templateName ? `${d.templateName} · v${d.version}` : null,
      templateNote: s.templateVersionId && d && !d.published ? "This version is no longer published: the step cannot send." : null,
      // ⛔ Sujet et lien seulement pour un modèle que la personne peut ouvrir.
      subject: d?.templateName ? d.subject : null,
      templateId: d?.templateId ?? null,
    };
  });

  const window = `${String(a.windowStartHour).padStart(2, "0")}:00–${String(a.windowEndHour).padStart(2, "0")}:00 ${a.timezone}`;
  const vSim = validateAutomation(toRecord(a, "simulation"));
  const vLive = validateAutomation(toRecord(a, "live"));
  const ran = simulationRan(a, simulesDepuis ?? 0);

  const journaux = (
    <div className="mt-4 flex flex-col gap-4">
      <SendLogCard
        title="Simulation log"
        sub="Who would have received what, and why — nothing was sent"
        lecture={simules}
        steps={steps}
        real={false}
        empty={
          a.status === "simulation"
            ? "Nothing yet: the worker writes here at its next planning pass."
            : "No simulated send. Start a simulation to see who would receive this automation."
        }
      />
      <SendLogCard
        title="Real sends"
        sub="Queued for real, with the state of their delivery"
        lecture={reels}
        steps={steps}
        real
        empty="No real send yet."
      />
    </div>
  );

  return (
    <div className="animate-fade-up">
      <BackLink />
      <div className="mt-2">
        <PageHead title={a.name} desc={`${triggerLabel(a.trigger)} · ${asset.name}`}>
          {!formulaire && gestes.edit && <EditButton id={a.id} status={a.status} />}
          <StatusControls
            id={a.id}
            name={a.name}
            status={a.status}
            isSuperAdmin={user?.isSuperAdmin === true}
            simulationRan={ran}
            simulateErrors={vSim.ok ? [] : vSim.errors}
            liveErrors={vLive.ok ? [] : vLive.errors}
            dailyCap={a.dailyCap}
            window={window}
          />
        </PageHead>
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <StatusSummary status={a.status} lastRunAt={a.lastRunAt} armedBy={a.armedBy} armedAt={a.armedAt} />
        <div className="flex flex-wrap items-center gap-3">
          <AutomationActions id={a.id} name={a.name} status={a.status} trigger={a.trigger} edit={false} afterDelete="list" />
          <Pill tone="pink" dot>
            {asset.name}
          </Pill>
        </div>
      </div>

      {formulaire ? (
        <>
          <AutomationForm
            mode="edit"
            id={a.id}
            assetId={asset.id}
            initial={valeurDe(a)}
            triggerLockedReason={raisonDeclencheurFige(selections)}
            justSaved={sp.saved === "1"}
            options={{
              templates: modeles.value,
              templatesKnown: modeles.known,
              optins: filtres.optins,
              interests: filtres.interests,
              labels: filtres.labels,
              filtersKnown: filtres.known,
              languages: asset.languages,
              timezones: fuseaux,
              pinned: Object.fromEntries(versions),
            }}
          />
          <div className="mt-4">
            <AudienceCard lecture={sonde} />
          </div>
          {journaux}
        </>
      ) : (
        <>
          <VueLecture a={a} spec={spec} steps={steps} filtres={filtres} sonde={sonde} window={window} />
          {journaux}
        </>
      )}
    </div>
  );
}

/** La fiche en lecture seule d'une automation qui n'est pas (ou ne peut pas être) un brouillon modifiable. */
function VueLecture({
  a,
  spec,
  steps,
  filtres,
  sonde,
  window,
}: {
  a: AutomationRow;
  spec: TriggerSpec | undefined;
  steps: StepView[];
  filtres: Awaited<ReturnType<typeof listFilterOptions>>;
  sonde: Parameters<typeof AudienceCard>[0]["lecture"];
  window: string;
}) {
  const f = (a.filters ?? {}) as { optin_ids?: unknown; languages?: unknown; interest_ids?: unknown; labels?: unknown };
  const liste = (x: unknown) => (Array.isArray(x) ? x.map(String) : []);
  const nomOptin = new Map(filtres.optins.map((o) => [o.id, o.name]));
  const nomInteret = new Map(filtres.interests.map((t) => [String(t.id), t.label]));
  const nomLabel = new Map(filtres.labels.map((l) => [l.slug, l.name]));
  const settingsVus = spec
    ? Object.entries(spec.settings)
        .filter(([, s]) => !s.readOnly)
        .map(([k, s]) => {
          const val = (a.settings as Record<string, unknown> | null)?.[k] ?? s.default;
          return { label: s.label, value: typeof val === "boolean" ? (val ? "Yes" : "No") : String(val) };
        })
    : [];
  return (
    <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
      <div className="flex flex-col gap-4">
        <TriggerCard trigger={a.trigger} purpose={a.purpose} />
        <StepsCard steps={steps} sends={spec ? spec.kind !== null : true} />
        <FiltersCard
          optins={liste(f.optin_ids).map((x) => nomOptin.get(x) ?? `${x.slice(0, 8)}…`)}
          languages={liste(f.languages)}
          interests={liste(f.interest_ids).map((x) => nomInteret.get(x) ?? `#${x}`)}
          labels={liste(f.labels).map((x) => nomLabel.get(x) ?? x)}
          settings={settingsVus}
        />
      </div>
      <div className="flex flex-col gap-4">
        <AudienceCard lecture={sonde} />
        <GuardrailsCard trigger={a.trigger} dailyCap={a.dailyCap} window={window} />
      </div>
    </div>
  );
}

/** La ligne telle que le formulaire l'édite. Ce qui est illisible reprend le défaut du déclencheur. */
function valeurDe(a: AutomationRow): FormValue {
  const trigger = a.trigger as FormValue["trigger"];
  const d = defaultsFor(trigger, { name: a.name, timezone: a.timezone });
  const f = (a.filters ?? {}) as Record<string, unknown>;
  const s = (a.settings ?? {}) as Record<string, unknown>;
  const settings = { ...d.settings };
  for (const k of Object.keys(settings)) {
    const v = s[k];
    if (typeof v === "boolean" || typeof v === "number") settings[k] = v;
  }
  return {
    ...d,
    purpose: a.purpose,
    filters: {
      optin_ids: Array.isArray(f.optin_ids) ? f.optin_ids.map(String) : [],
      languages: Array.isArray(f.languages) ? f.languages.map((l) => String(l).toLowerCase()) : [],
      interest_ids: Array.isArray(f.interest_ids) ? f.interest_ids.map(Number) : [],
      labels: Array.isArray(f.labels) ? f.labels.map((l) => String(l).trim().toLowerCase()) : [],
    },
    settings,
    steps: stepsOf(a).map((x) => ({ delay_hours: x.delayHours ?? 0, template_version_id: x.templateVersionId })),
    daily_cap: a.dailyCap,
    window_start_hour: a.windowStartHour,
    window_end_hour: a.windowEndHour,
  };
}
