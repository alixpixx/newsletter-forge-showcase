import Link from "next/link";
import { EyeOff, X } from "lucide-react";
import { Pill, type Tone } from "@/components/ui";
import type { SubscriberDetail } from "@/lib/data/subscribers";
import { etatInterets, type CaptureEventRow } from "@/lib/data/capture";
import type { ActiviteAbonne, Lecture } from "@/lib/engagement";
import { SubscriberActivity } from "@/components/subscribers/subscriber-activity";

/**
 * Drawer profil abonné (server-only, ouvert via ?view=email) : profil + consentement par marque +
 * provenance + audit.
 *
 * ⛔ P9 — le consentement est montré pour TOUTES les marques (obligation RGPD) ; l'origine, non.
 * Les événements des marques non autorisées ne sont pas rendus discrets : ils ne sont pas là. Le
 * masquage est fait à la lecture (`lib/data/capture.ts`), pas ici — un `hidden` CSS laisserait les
 * noms de créatives d'une marque interdite dans le HTML servi.
 */

const PURPOSE_LABEL: Record<string, string> = { content: "Newsletter", offers: "Offers", events: "Events", partners: "Partners" };
const CONSENT_TONE: Record<string, Tone> = { active: "green", pending: "amber", contact: "blue" };
const EVENT_TONE: Record<string, Tone> = { granted: "green", optin_confirm: "green", resubscribe: "green", withdrawn: "amber", unsubscribe: "amber", deletion_request: "amber", optin_request: "grey", preference_change: "blue" };

/**
 * L'ancienne colonne « Source » de la liste, reléguée ici sous son vrai nom.
 * ⚠️ L'ingestion écrit `content_upgrade` pour TOUT LE MONDE et l'énumération est fermée à cinq
 * valeurs : ce champ ne dit rien de la provenance réelle, c'est pourquoi il a quitté la liste.
 */
const SOURCE_LABEL: Record<string, string> = {
  organic: "Organic",
  social: "Social media",
  crm_sync: "CRM sync",
  import: "Import",
  content_upgrade: "Content upgrade",
};

function fmt(ts: string) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("en-US", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * Le nom courant, et le nom du jour J quand ils diffèrent.
 *
 * ⛔ Sans cette pastille, l'écran réécrit le passé en silence : une créative renommée ferait croire
 * que la personne s'est inscrite sur un formulaire qui n'existait pas encore sous ce nom.
 * ⚠️ Un `*_at_capture` à NULL n'est pas un ancien nom vide — c'est un émetteur muet. Il ne doit
 * jamais déclencher la pastille.
 */
function NomHistorique({ courant, auMoment }: { courant: string | null; auMoment: string | null }) {
  if (!courant || !auMoment || courant === auMoment) return null;
  return <Pill tone="amber" className="shrink-0">was “{auMoment}”</Pill>;
}

/** Les cinq états d'un intérêt, dont QUATRE absences qui ne disent pas la même chose. */
function Interets({ e }: { e: CaptureEventRow }) {
  const etat = etatInterets({
    optinConnu: e.optinKnown,
    asksInterests: e.asksInterests,
    interestIds: e.interestIds,
    interestsOffered: e.interestsOffered,
  });
  if (etat === "chosen") {
    return (
      <div className="mt-1.5 flex flex-wrap gap-1">
        {e.interests.map((i) => <Pill key={i.id} tone="violet">{i.label}</Pill>)}
      </div>
    );
  }
  if (etat === "asked-empty") {
    return <p className="mt-1.5 text-[11.5px] font-medium text-[#b9790a]">Asked, nothing selected</p>;
  }
  if (etat === "form-unknown") {
    return <p className="mt-1.5 text-[11.5px] text-muted-foreground">Signup form unknown — interests cannot be read</p>;
  }
  return <p className="mt-1.5 text-[11.5px] text-muted-foreground">This form did not ask for interests</p>;
}

/**
 * `activite` : l'activité e-mail de la personne sur la MARQUE COURANTE (0094), absente = section non
 * rendue. ⚠️ Seule section scopée du tiroir — son titre nomme la marque, voir `subscriber-activity.tsx`.
 */
export function SubscriberDrawer({
  detail,
  closeHref,
  activite,
}: {
  detail: SubscriberDetail;
  closeHref: string;
  activite?: { brandName: string; lecture: Lecture<ActiviteAbonne> } | null;
}) {
  return (
    <div className="fixed inset-0 z-50">
      <Link href={closeHref} aria-label="Close" className="absolute inset-0 bg-black/30" />
      <div className="absolute right-0 top-0 flex h-full w-full max-w-[440px] flex-col border-l border-border bg-card shadow-2xl">
        <div className="flex items-start justify-between border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-bold">{detail.email}</h2>
            <p className="text-[12.5px] text-muted-foreground">
              {detail.first_name ?? "—"}{detail.created_at ? ` · joined ${fmt(detail.created_at)}` : ""}
            </p>
          </div>
          <Link href={closeHref} aria-label="Close" className="rounded-md p-1 text-muted-foreground hover:bg-accent"><X className="h-4 w-4" /></Link>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {/* Consentement par marque */}
          <h3 className="mb-2 text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground/70">Consent by brand</h3>
          <div className="space-y-2">
            {detail.subscriptions.map((s, i) => (
              <div key={i} className="rounded-xl border border-border p-3">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-[13px] font-semibold">{s.asset}</span>
                  <Pill tone={CONSENT_TONE[s.status] ?? "grey"} dot>{s.status}</Pill>
                </div>
                {s.status === "contact" && (
                  <p className="mb-1.5 text-[11.5px] text-muted-foreground">
                    Not subscribed to the newsletter — reached only by a segment with “Newsletter: No”.
                  </p>
                )}
                <div className="flex flex-wrap gap-1.5">
                  {(["content", "offers", "events", "partners"] as const).map((p) => (
                    <span key={p} className={`rounded-full border px-2 py-px text-[10.5px] font-medium ${s.purposes[p] ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-border bg-accent text-muted-foreground/60 line-through"}`}>
                      {PURPOSE_LABEL[p]}
                    </span>
                  ))}
                  <span className={`rounded-full border px-2 py-px text-[10.5px] font-medium ${s.tracking ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-border bg-accent text-muted-foreground/60 line-through"}`}>Tracking</span>
                </div>
                {s.canAccess ? (
                  <p className="mt-1.5 text-[11px] text-muted-foreground">
                    Acquisition channel: {SOURCE_LABEL[s.source ?? ""] ?? "unknown"}
                  </p>
                ) : (
                  <p className="mt-1.5 inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <EyeOff className="h-[13px] w-[13px]" /> Origin hidden — you do not have access to this brand
                  </p>
                )}
              </div>
            ))}
            {detail.subscriptions.length === 0 && <p className="text-[12.5px] text-muted-foreground">No subscriptions.</p>}
          </div>

          {/* Où ils se sont inscrits — une entrée par inscription observée, la plus récente d'abord. */}
          <h3 className="mb-2 mt-5 text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground/70">Where they signed up</h3>
          {detail.captures.length === 0 ? (
            /* ⛔ Ni tableau vide ni tiret : le troisième état vide, celui qui dit qu'aucun
               formulaire n'a jamais été enregistré pour cette personne. */
            <div className="rounded-xl border border-border bg-accent/40 p-3">
              <p className="text-[12.5px] font-semibold">No signup form recorded</p>
              {/* ⛔ « Cette personne n'est jamais passée par un formulaire » est une AFFIRMATION,
                  et elle est fausse dès qu'une seule marque est masquée : les événements des
                  marques interdites ne sont pas absents, ils ont été RETIRÉS de la lecture (P9).
                  Le test « toutes les marques sont masquées » ne suffit pas — il rate le cas
                  courant : une marque visible sans formulaire + une marque masquée avec. */}
              <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">
                {detail.hiddenOrigins === 0
                  ? "This contact never came through a capture form — demo data, a manual import, or a signup made before the bridge was connected."
                  : detail.hiddenOrigins === detail.subscriptions.length
                    ? "Origin is hidden for every brand this person belongs to — nothing can be shown here."
                    : `Nothing recorded on the brands you can see. Origin is hidden for ${detail.hiddenOrigins} other brand${detail.hiddenOrigins === 1 ? "" : "s"} you cannot access.`}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {detail.captures.map((c) => (
                <div key={c.id} className="rounded-xl border border-border p-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[13px] font-semibold">{c.optinName ?? c.optinNameAtCapture ?? "Signup form unknown"}</span>
                    <NomHistorique courant={c.optinName} auMoment={c.optinNameAtCapture} />
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                    <span className="text-[11.5px] text-muted-foreground">
                      {c.campaignName ?? c.campaignNameAtCapture ?? "No campaign"}
                      {c.placement ? ` · ${c.placement}` : ""}
                    </span>
                    <NomHistorique courant={c.campaignName} auMoment={c.campaignNameAtCapture} />
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">{fmt(c.occurredAt)}</div>
                  {/* LE BRAS A/B — une information, jamais un critère de ciblage (arbitrage d'Alix,
                      13/09/2026). Il était jusqu'ici concaténé derrière la date, sans être nommé :
                      la seule donnée du pont qu'aucun libellé n'annonçait.
                      ⛔ Quand il manque, ne PAS écrire « ce formulaire n'a pas d'A/B ». Cette base
                      ne connaît que la créative PARENTE, jamais ses bras — elle ne peut donc pas
                      distinguer un formulaire sans test d'un bras qui n'a pas été transmis. Dire
                      lequel des deux serait inventer. */}
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px]">
                    <span className="uppercase tracking-[0.03em] text-muted-foreground/60">A/B variant</span>
                    {c.variantExternalId ? (
                      <span className="font-medium text-foreground/80">{c.variantExternalId}</span>
                    ) : (
                      <span className="text-muted-foreground/60">not recorded on this signup</span>
                    )}
                  </div>
                  {/* La page d'où l'inscription est partie — lue, transportée, et jusqu'ici jamais
                      rendue : la seule chose qui dise QUEL article a converti.
                      ⛔ Jamais un `<a>` : cette adresse vient de l'émetteur, pas de nous. En faire
                      un lien cliquable ferait de l'écran d'admin un tremplin vers n'importe quoi. */}
                  {c.sourceUrl && (
                    <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground/70" title={c.sourceUrl}>
                      {c.sourceUrl}
                    </div>
                  )}
                  <Interets e={c} />
                </div>
              ))}
              {detail.hiddenOrigins > 0 && (
                <p className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <EyeOff className="h-[13px] w-[13px]" /> Origin hidden for {detail.hiddenOrigins} other brand
                  {detail.hiddenOrigins === 1 ? "" : "s"} you cannot access.
                </p>
              )}
            </div>
          )}

          {/* Timeline d'audit du consentement */}
          <h3 className="mb-2 mt-5 text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground/70">Consent history</h3>
          <div className="space-y-2.5">
            {detail.events.map((e, i) => (
              <div key={i} className="flex gap-2.5">
                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <Pill tone={EVENT_TONE[e.event_type] ?? "grey"}>{e.purpose ? `${e.event_type} · ${e.purpose}` : e.event_type}</Pill>
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    {fmt(e.occurred_at)}{e.method ? ` · ${e.method}` : ""}{e.legal_basis ? ` · ${e.legal_basis}` : ""}
                  </div>
                </div>
              </div>
            ))}
            {detail.events.length === 0 && <p className="text-[12.5px] text-muted-foreground">No consent events recorded.</p>}
          </div>

          {/* En DERNIER : la frise peut compter cent envois, elle ne doit pas repousser les
              consentements et la provenance hors de vue. */}
          {activite && <SubscriberActivity brandName={activite.brandName} activite={activite.lecture} />}
        </div>
      </div>
    </div>
  );
}
