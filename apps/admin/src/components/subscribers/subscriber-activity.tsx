import { AlertTriangle, Bot, Eye, Flag, Mail, MailCheck, MailX, MousePointerClick, UserMinus, type LucideIcon } from "lucide-react";
import { Pill } from "@/components/ui";
import type { AbonnementActivite, ActiviteAbonne, EvenementActivite, Lecture, MessageActivite } from "@/lib/engagement";
import {
  compteurMesure,
  dateMessage,
  dernierMesure,
  detailEvenement,
  formaterInstant,
  libelleEngagement,
  libelleEvenement,
  libelleNombreMessages,
  libelleType,
  lienClique,
  mentionSuivi,
  raisonEvenement,
  statutMessage,
  titreMessage,
  type CleEvenement,
  type Mesure,
} from "@/lib/subscriber-activity-view";

/**
 * « Email activity on <marque> » — ce que les envois de LA MARQUE COURANTE sont devenus pour cette
 * personne : chaque message, chacun avec ses événements (remis, ouvert, cliqué, rebond…).
 *
 * ⛔ SCOPÉE À LA MARQUE, CONTRAIREMENT AU RESTE DU TIROIR. Les consentements sont montrés pour toutes
 * les marques (obligation RGPD) ; l'activité, non — d'où le nom de la marque dans le titre, pour que
 * personne ne lise « aucun envoi » comme « aucun envoi nulle part ».
 *
 * ⛔ Composant serveur (pas de "use client") : toute la mise en forme vit dans le module neutre
 * `lib/subscriber-activity-view.ts`, mesuré par son banc.
 */

const ICONES: Record<CleEvenement, LucideIcon> = {
  delivered: MailCheck,
  opened: Eye,
  machine: Bot,
  clicked: MousePointerClick,
  bounced: MailX,
  complained: Flag,
  unsubscribed: UserMinus,
  failed: AlertTriangle,
  other: Mail,
};

const TITRE = "mb-2 mt-5 text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground/70";

function Chiffre({ label, mesure }: { label: string; mesure: Mesure }) {
  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-[0.03em] text-muted-foreground/60">{label}</div>
      {mesure.known ? (
        <div className="text-[14px] font-semibold tabular-nums">{mesure.value.toLocaleString("en-US")}</div>
      ) : (
        // ⛔ Jamais « 0 » : la raison, en clair, à la place du chiffre.
        <div className="text-[11.5px] text-muted-foreground" title={mesure.reason}>Not measured — {mesure.reason}</div>
      )}
    </div>
  );
}

function Resume({ s, messages }: { s: AbonnementActivite; messages: MessageActivite[] }) {
  const ouvertures = compteurMesure(s.openCount, messages);
  const clics = compteurMesure(s.clickCount, messages);
  return (
    <div className="rounded-xl border border-border p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[11.5px] text-muted-foreground">Subscribed {formaterInstant(s.createdAt)}</span>
        <Pill tone={s.status === "active" ? "green" : s.status === "pending" ? "amber" : "grey"} dot>{s.status}</Pill>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-2">
        <Chiffre label="Opens" mesure={ouvertures} />
        <Chiffre label="Clicks" mesure={clics} />
        <div>
          <div className="text-[10.5px] uppercase tracking-[0.03em] text-muted-foreground/60">Last open</div>
          <div className="text-[12px]">{dernierMesure(s.lastOpenAt, ouvertures)}</div>
        </div>
        <div>
          <div className="text-[10.5px] uppercase tracking-[0.03em] text-muted-foreground/60">Last click</div>
          <div className="text-[12px]">{dernierMesure(s.lastClickAt, clics)}</div>
        </div>
        <div className="col-span-2">
          <div className="text-[10.5px] uppercase tracking-[0.03em] text-muted-foreground/60">Engagement</div>
          <div className="text-[12px]">{libelleEngagement(s)}</div>
        </div>
      </div>
    </div>
  );
}

function Evenement({ e }: { e: EvenementActivite }) {
  const { cle, label, tone } = libelleEvenement(e);
  const Icone = ICONES[cle];
  const detail = detailEvenement(e);
  const lien = lienClique(e);
  const raison = raisonEvenement(e);
  return (
    <li className="flex gap-2">
      <Icone className={`mt-[2px] h-[13px] w-[13px] shrink-0 ${tone === "red" ? "text-[#c0334a]" : "text-muted-foreground"}`} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-1.5 text-[11.5px]">
          <span className={tone === "grey" ? "text-muted-foreground" : "font-medium"}>{label}</span>
          <span className="text-muted-foreground/70">{formaterInstant(e.occurredAt)}</span>
        </div>
        {detail && <div className="text-[11px] text-muted-foreground">{detail}</div>}
        {/* ⛔ Jamais un `<a>` : l'adresse vient du message, pas de nous (même règle que la page
            d'inscription plus haut). Masquée d'éventuelles adresses AVANT d'atteindre `title`. */}
        {lien && (
          <div className="truncate font-mono text-[11px] text-muted-foreground/70" title={lien}>
            {lien}
          </div>
        )}
        {raison && <div className="text-[11px] text-muted-foreground/70">{raison}</div>}
      </div>
    </li>
  );
}

function Message({ m }: { m: MessageActivite }) {
  const statut = statutMessage(m.status);
  const suivi = mentionSuivi(m.tracked);
  const { titre, sousTitre } = titreMessage(m);
  return (
    <div className="rounded-xl border border-border p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-muted-foreground">{dateMessage(m)} · {libelleType(m.kind)}</span>
        <Pill tone={statut.tone}>{statut.label}</Pill>
        {suivi && <Pill tone="grey">{suivi}</Pill>}
      </div>
      <div className="mt-1 text-[13px] font-semibold">{titre}</div>
      {sousTitre && <div className="text-[11.5px] text-muted-foreground">{sousTitre}</div>}
      {m.events.length === 0 ? (
        <p className="mt-1.5 text-[11px] text-muted-foreground/70">No delivery event recorded.</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {m.events.map((e, i) => <Evenement key={i} e={e} />)}
        </ul>
      )}
    </div>
  );
}

export function SubscriberActivity({ brandName, activite }: { brandName: string; activite: Lecture<ActiviteAbonne> }) {
  const a = activite.known ? activite.value : null;
  return (
    <>
      <h3 className={TITRE}>Email activity on {brandName}</h3>
      {!activite.known ? (
        // ⛔ Une lecture ratée n'est pas « aucune activité » : la raison, jamais une liste vide.
        <p className="text-[12.5px] text-muted-foreground">Email activity not available — {activite.reason}</p>
      ) : !a || a.subscriptions.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground">
          Not subscribed to {brandName} — this brand has no email to show for this person.
        </p>
      ) : (
        <div className="space-y-2">
          {a.subscriptions.map((s) => (
            <Resume key={s.id} s={s} messages={a.messages} />
          ))}
          <p className="pt-1 text-[11.5px] text-muted-foreground">
            {libelleNombreMessages(a.messages.length, a.totalMessages)}
          </p>
          {a.messages.map((m) => <Message key={m.id} m={m} />)}
        </div>
      )}
    </>
  );
}
