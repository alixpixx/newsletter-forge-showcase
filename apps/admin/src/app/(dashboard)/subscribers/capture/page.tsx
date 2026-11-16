import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { PageHead, Pill, Th, Td } from "@/components/ui";
import { listOptins } from "@/lib/data/optins";
import {
  etatVideNiveau,
  loadCaptureCampaigns,
  loadCaptureEventCount,
  loadCaptureInterests,
  type CapturesDeLaMarque,
} from "@/lib/data/capture";
import { getCurrentAsset } from "@/lib/asset-context";
import { OptinsTable } from "@/components/subscribers/optins-table";
import { cn } from "@/lib/utils";

// Les compteurs bougent à chaque inscription : rien à figer au build.
export const dynamic = "force-dynamic";

/**
 * LA GOUVERNANCE DE LA PROVENANCE — les trois niveaux, un onglet chacun.
 *
 * Alix, 09/09/2026 : « niveau 1 : de quelle campagne ils proviennent, niveau 2 de quelles créatives
 * ils proviennent et dernier niveau si préférence dans la créative de quelle préférence. »
 *
 * ⛔ CET ÉCRAN AFFICHERA ZÉRO EN AYANT RAISON. Au 10/09/2026 la base porte 0 campagne d'acquisition,
 * 0 intérêt et 1 202 contacts de démonstration sur 1 203 : le pont n'a jamais transporté un lead.
 * Un tableau à zéro ligne se lirait comme une panne ; l'état vide doit donc NOMMER les trois
 * interrupteurs qui, tous les trois, doivent être fermés pour qu'une ligne apparaisse ici.
 *
 * ⚠️ Onglets en `<Link href="?tab=…">` et non en état client : cette page lit la base, et un onglet
 * client aurait imposé de charger les trois jeux de données pour n'en montrer qu'un.
 */

type Onglet = "campaigns" | "creatives" | "interests";
const ONGLETS: { key: Onglet; label: string }[] = [
  { key: "campaigns", label: "Campaigns" },
  { key: "creatives", label: "Creatives" },
  { key: "interests", label: "Interests" },
];

/**
 * L'état vide qui explique, plutôt que le tableau à zéro ligne qui accuse.
 *
 * ⛔ TROIS ÉTATS, PAS UN. « No lead has reached {marque} yet » parle du PONT, et l'écran le disait
 * dès qu'un tableau était vide — y compris sur une marque qui venait de recevoir. Le 13/09/2026,
 * copper-kettle avait 4 inscriptions et 0 intérêt : l'onglet Interests envoyait donc réparer trois
 * interrupteurs déjà fermés. Ce que chaque niveau peut dire dépend de ce que la MARQUE a reçu.
 */
function NiveauVide({
  quoi, marque, captures, explication,
}: {
  quoi: string;
  marque: string;
  captures: CapturesDeLaMarque;
  /** Pourquoi ce niveau précis peut rester vide alors que des inscriptions sont arrivées. */
  explication: string;
}) {
  const etat = etatVideNiveau(captures);
  const fmt = (n: number) => n.toLocaleString("en-US");

  if (etat === "indetermine") {
    return (
      <div className="rounded-[14px] border border-border bg-card p-8 text-center">
        <p className="text-[13.5px] font-semibold">No {quoi.toLowerCase()} to show</p>
        {/* ⛔ Ne rien affirmer sur le pont : on n'a pas pu compter les inscriptions de la marque.
            Dire « aucun lead n'est arrivé » ici serait inventer la réponse qu'on n'a pas lue. */}
        <p className="mx-auto mt-1.5 max-w-[52ch] text-[12.5px] leading-relaxed text-muted-foreground">
          Signups could not be counted for {marque}, so this empty table does not say whether
          anything has arrived. Reload, and check the database if it persists.
        </p>
      </div>
    );
  }

  if (etat === "recu-sans-ce-niveau") {
    return (
      <div className="rounded-[14px] border border-border bg-card p-8 text-center">
        <p className="text-[13.5px] font-semibold">
          {fmt(captures.value)} signup{captures.value === 1 ? "" : "s"} recorded on {marque}, none
          carrying {quoi.toLowerCase()}
        </p>
        <p className="mx-auto mt-1.5 max-w-[52ch] text-[12.5px] leading-relaxed text-muted-foreground">
          The bridge is delivering. {explication}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-[14px] border border-border bg-card p-8 text-center">
      <p className="text-[13.5px] font-semibold">No signup has reached {marque} yet</p>
      <p className="mx-auto mt-1.5 max-w-[52ch] text-[12.5px] leading-relaxed text-muted-foreground">
        {quoi} appear here the first time optinforge sends a signup. Nothing to create. Three
        switches must all be closed for that to happen:
      </p>
      <ul className="mx-auto mt-3 max-w-[52ch] space-y-1.5 text-left text-[12.5px] leading-relaxed text-muted-foreground">
        <li>
          1 — <code>NF_INGEST_SECRET</code> is set on the <code>newsletter-public</code> app, with the
          same value as in optinforge. Without it every call is answered <code>401</code>, silently.
        </li>
        <li>2 — the source site is bridged to newsletter-forge in optinforge.</li>
        <li>3 — the newsletter box is ticked on the creative itself.</li>
      </ul>
      <p className="mx-auto mt-3 max-w-[52ch] text-[12px] leading-relaxed text-muted-foreground/80">
        See <code>docs/INGEST-API.md</code> for the payload.
      </p>
    </div>
  );
}

function Incident({ reason }: { reason: string }) {
  return (
    <div className="mb-4 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
      {reason === "no-asset"
        ? "No brand in context — this screen writes tags, so it stays empty rather than guessing which brand you mean."
        : reason === "no-db"
          ? "The database could not be reached — these numbers are missing, not zero."
          : `Sources could not be read (${reason}).`}
    </div>
  );
}

export default async function CapturePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const sp = await searchParams;
  const tab: Onglet = (["creatives", "interests"] as const).includes(sp.tab as never)
    ? (sp.tab as Onglet)
    : "campaigns";

  const asset = await getCurrentAsset();
  const fmt = (n: number) => n.toLocaleString("en-US");

  // Un seul jeu de données lu, celui de l'onglet ouvert.
  const campagnes = tab === "campaigns" ? await loadCaptureCampaigns(asset.id) : null;
  const creatives = tab === "creatives" ? await listOptins(asset.id) : null;
  const interets = tab === "interests" ? await loadCaptureInterests(asset.id) : null;

  // ⚠️ Compté SEULEMENT quand le tableau est vide : c'est le seul moment où l'écran doit choisir
  // entre « le pont n'a rien livré » et « il a livré, mais rien à CE niveau ». Une page qui montre
  // des lignes n'a pas à payer ce comptage.
  const tableauVide =
    (campagnes !== null && !campagnes.reason && campagnes.rows.length === 0) ||
    (creatives !== null && !creatives.reason && creatives.rows.length === 0) ||
    (interets !== null && !interets.reason && interets.rows.length === 0);
  const captures: CapturesDeLaMarque = tableauVide
    ? await loadCaptureEventCount(asset.id)
    : { known: false, value: 0 };

  return (
    <div className="animate-fade-up">
      <PageHead
        title="Acquisition sources"
        desc="Where your subscribers come from, in three levels: the acquisition campaign, the creative they filled in, and the interests they ticked on it."
      >
        <Pill tone="pink" dot>{asset.name}</Pill>
        <Link
          href="/subscribers"
          className="inline-flex items-center gap-1.5 rounded-[9px] border border-border bg-card px-3 py-[7px] text-[12.5px] font-medium text-foreground/75 transition-colors hover:bg-accent"
        >
          <ChevronLeft className="h-[14px] w-[14px]" /> Subscribers
        </Link>
      </PageHead>

      <div role="tablist" aria-label="Acquisition levels" className="mb-4 flex max-w-[420px] border-b border-border">
        {ONGLETS.map((o) => (
          <Link
            key={o.key}
            role="tab"
            aria-selected={tab === o.key}
            aria-current={tab === o.key ? "page" : undefined}
            href={`/subscribers/capture?tab=${o.key}`}
            className={cn(
              "flex-1 border-b-2 px-1 py-2 text-center text-[11.5px] font-medium transition-colors",
              tab === o.key ? "border-brand text-brand" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {o.label}
          </Link>
        ))}
      </div>

      {/* ───────────────────────── Niveau 1 — Campagnes ───────────────────────── */}
      {campagnes && (
        <>
          {campagnes.reason && <Incident reason={campagnes.reason} />}
          {!campagnes.reason && campagnes.rows.length === 0 && (
            <NiveauVide
              quoi="Acquisition campaigns"
              marque={asset.name}
              captures={captures}
              explication="Each signup carries the campaign its creative belongs to. These ones carry none — in optinforge, the form they were filled on is not attached to any campaign."
            />
          )}
          {campagnes.rows.length > 0 && (
            <div className="overflow-hidden rounded-[14px] border border-border bg-card">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] border-collapse text-[13px]">
                  <thead>
                    <tr className="bg-[#fcfcfe]">
                      <Th>Campaign</Th>
                      <Th className="text-right">Creatives</Th>
                      <Th className="text-right">Contacts</Th>
                      <Th className="text-right">Sendable</Th>
                      <Th>Last signup</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {campagnes.rows.map((c) => (
                      <tr key={c.id}>
                        <Td>
                          <div className="flex items-center gap-2">
                            <b className="font-semibold">{c.name}</b>
                            {c.archivedAt && (
                              <span className="rounded-full bg-muted px-2 py-px text-[10.5px] font-semibold text-muted-foreground">
                                archived
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5 font-mono text-[11px] text-muted-foreground/70">{c.externalId}</div>
                        </Td>
                        <Td className="text-right tabular-nums text-muted-foreground">{fmt(c.creatives)}</Td>
                        <Td className="text-right tabular-nums">{fmt(c.contacts)}</Td>
                        <Td className="text-right tabular-nums text-muted-foreground">{fmt(c.sendable)}</Td>
                        {/* ⛔ `lastSignupAt` (l'inscription), jamais `lastSeenAt` (l'ingestion) :
                            un lot rejoué faisait afficher ici la date du rejeu, pendant que
                            l'onglet Creatives montrait la vraie — deux dates contradictoires sur
                            le même écran, pour le même couple.
                            ⛔ TROIS causes, TROIS rendus. La date vient des créatives rattachées
                            AUJOURD'HUI à la campagne, alors que Contacts compte le rattachement
                            FIGÉ à l'inscription : une créative déplacée chez l'émetteur laisse une
                            campagne sans date mais avec des contacts. Écrire « Never » sur cette
                            ligne serait nier des inscriptions qui ont bien eu lieu. */}
                        <Td className="text-[12px] text-muted-foreground">
                          {!campagnes.lastSignupKnown ? (
                            <span className="text-muted-foreground/60" title="Signup dates could not be read">
                              —
                            </span>
                          ) : c.lastSignupAt ? (
                            new Date(c.lastSignupAt).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" })
                          ) : c.contacts > 0 ? (
                            <span
                              className="text-muted-foreground/60"
                              title="No signup on the creatives currently attached to this campaign — its past signups came in through a creative that has since moved"
                            >
                              Not on current creatives
                            </span>
                          ) : (
                            "Never"
                          )}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {/* ⛔ Ce n'est pas une somme des créatives : quelqu'un entré par deux créatives d'une
                  même campagne serait compté deux fois, et le total dépasserait le nombre de
                  personnes réellement entrées. */}
              <div className="border-t border-border bg-[#fcfcfe] px-4 py-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
                One person counts once per campaign, never twice for two creatives of the same campaign —
                but someone who came through two campaigns counts in both.
              </div>
            </div>
          )}
        </>
      )}

      {/* ───────────────────────── Niveau 2 — Créatives ───────────────────────── */}
      {creatives && (
        <>
          {creatives.reason && <Incident reason={creatives.reason} />}
          {!creatives.reason && creatives.rows.length === 0 && (
            <NiveauVide
              quoi="Creatives"
              marque={asset.name}
              captures={captures}
              explication="That is unusual: every signup names the form it was filled on, so those forms should be listed here. The creative could not be resolved when the signup was received."
            />
          )}
          {creatives.rows.length > 0 && <OptinsTable rows={creatives.rows} tags={creatives.tags} />}
        </>
      )}

      {/* ───────────────────────── Niveau 3 — Intérêts ───────────────────────── */}
      {interets && (
        <>
          {interets.reason && <Incident reason={interets.reason} />}
          {!interets.reason && interets.rows.length === 0 && (
            <NiveauVide
              quoi="Interests"
              marque={asset.name}
              captures={captures}
              explication="Interests only exist when a creative asks the question. The forms that converted here do not offer any, so there is nothing to list — and nothing to fix."
            />
          )}
          {interets.rows.length > 0 && (
            <div className="overflow-hidden rounded-[14px] border border-border bg-card">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[880px] border-collapse text-[13px]">
                  <thead>
                    <tr className="bg-[#fcfcfe]">
                      <Th>Interest</Th>
                      <Th className="text-right">Contacts</Th>
                      <Th className="text-right">Sendable</Th>
                      <Th className="text-right">Of those asked</Th>
                      <Th className="text-right">Offered by</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {interets.rows.map((i) => (
                      <tr key={i.id}>
                        <Td>
                          <div className="flex flex-wrap items-center gap-2">
                            {/* ⛔ Le LIBELLÉ, jamais le slug : « Colo-Colo », pas
                                « interest:tag:colo-colo ». */}
                            <b className="font-semibold">{i.label}</b>
                            {i.taxonomy && <Pill tone="violet">{i.taxonomy}</Pill>}
                          </div>
                          <div className="mt-0.5 font-mono text-[11px] text-muted-foreground/70">{i.slug}</div>
                        </Td>
                        <Td className="text-right tabular-nums">{fmt(i.contacts)}</Td>
                        <Td className="text-right tabular-nums text-muted-foreground">{fmt(i.sendable)}</Td>
                        <Td className="text-right tabular-nums">
                          {/* ⛔ 0/0 n'est pas « 0 % ». Sans dénominateur, l'écran se tait. */}
                          {i.asked === 0 ? (
                            <span className="text-muted-foreground/60">no one asked</span>
                          ) : (
                            <>
                              {fmt(i.chosenAmongAsked)} of {fmt(i.asked)}
                              <span className="ml-1 text-[11.5px] text-muted-foreground">
                                {Math.round((i.chosenAmongAsked / i.asked) * 100)}%
                              </span>
                            </>
                          )}
                        </Td>
                        <Td className="text-right tabular-nums text-muted-foreground">{fmt(i.offeredBy)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {/* ⚠️ Le dénominateur est nommé, parce qu'il y en avait deux défendables et qu'un
                  taux dont on ignore le dénominateur ne se relit pas. */}
              <div className="space-y-1 border-t border-border bg-[#fcfcfe] px-4 py-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
                <p>
                  <strong>Of those asked</strong> compares two counts drawn from the same population:
                  contacts who came through a creative that<em> currently </em> offers this interest.
                  Not the whole audience, and not the offer as it stood on the day they signed up —
                  which is why <strong>Contacts</strong> can be larger than the number on its left.
                </p>
                {interets.offerUnknown > 0 && (
                  <p>
                    {fmt(interets.offerUnknown)} of {fmt(interets.totalEvents)} recorded signups did not
                    say which interests were offered, so they cannot feed any of these rates.
                  </p>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
