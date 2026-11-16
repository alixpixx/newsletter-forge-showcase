"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, ChevronRight, Tag, Download, Trash2, X } from "lucide-react";
import { Pill, Td, type Tone } from "@/components/ui";
import type { SubscriberRow, TagInfo } from "@/lib/data/subscribers";
import { cleDeSelection, ecrireSelection, lireSelection } from "@/components/subscribers/selection";
import { cn } from "@/lib/utils";

/* Table abonnés interactive : sélection par ligne + barre d'actions groupées (Tag / Export / Delete). */

/**
 * Ce qu'un refus VEUT DIRE, en clair. Un code HTTP nu envoie chercher une panne là où il y a une
 * règle : `no-asset` n'est pas une erreur, c'est une marque non résolue ; `tag-hors-marque` n'est
 * pas un bug, c'est un garde qui a fait son travail.
 */
function messageDeRefus(status: number, body: Record<string, unknown>): string {
  const raison = typeof body.reason === "string" ? body.reason : "";
  if (raison === "no-asset") return "No brand resolved — reload the page and pick a brand first.";
  if (raison === "no-db") return "The database is unreachable right now. Nothing was changed.";
  if (raison === "no-selection") return "Nothing selected.";
  if (raison === "no-match") return "None of the selected rows belong to this brand any more — reload the list.";
  if (raison === "tag-hors-marque") return "That tag belongs to another brand.";
  if (raison === "too-many") return `Too many rows at once (max ${String(body.max ?? "")}). Narrow the selection.`;
  if (status === 500) return "The server could not complete that. Nothing was changed.";
  return `The action was refused (${status}).`;
}

/**
 * Le nom du fichier, tel que le serveur l'a nommé.
 *
 * ⚠️ Repli explicite : un en-tête absent (proxy qui le retire, réponse rejouée) donnerait un
 * fichier nommé d'après l'URL — `export` — que personne ne retrouve dans son dossier de
 * téléchargements.
 */
function nomDuFichier(disposition: string | null): string {
  const m = disposition ? /filename="([^"]+)"/.exec(disposition) : null;
  return m?.[1] ?? "subscribers.csv";
}

const LEVEL_PILL: Record<string, { tone: Tone; label: string }> = {
  active: { tone: "green", label: "Active" },
  dormant: { tone: "amber", label: "Dormant" },
  churned: { tone: "grey", label: "Lapsed" },
};

const CONSENT_PILL: Record<string, { tone: Tone; label: string }> = {
  active: { tone: "green", label: "Subscribed" },
  pending: { tone: "amber", label: "Pending" },
  unsubscribed: { tone: "grey", label: "Unsubscribed" },
  suppressed_soft: { tone: "grey", label: "Suppressed" },
  suppressed_hard: { tone: "grey", label: "Suppressed" },
  complained: { tone: "grey", label: "Complained" },
  deleted: { tone: "grey", label: "Erased" },
  // Contact hors newsletter (0088) : atteint seulement par un segment « Newsletter: No ».
  contact: { tone: "blue", label: "Contact" },
};
const CONSENTING = new Set(["active", "pending"]);

/**
 * « SUBSCRIPTION OPTIONS » — ce que la personne a coché elle-même, à côté des tags.
 *
 * ⛔ Le MÊME vocabulaire que le drawer (`subscriber-drawer.tsx:17`), pas celui de la base : la
 * capture dit `newsletter`, le stockage dit `content`. L'écran nomme ce que la personne a coché,
 * jamais la clé brute.
 *
 * ⛔ Une clé ABSENTE n'est pas `false`. On n'affiche QUE les finalités accordées : rendre les
 * refusées barrées comme le drawer ferait passer « jamais demandé » pour « a refusé » sur les
 * 1 105 abonnements antérieurs au recueil du choix. Le drawer, lui, montre UNE souscription et a
 * la place de nuancer ; une ligne de tableau n'a que la place de dire ce qui est vrai.
 *
 * L'ordre est celui du formulaire, pas celui de l'objet : deux lignes voisines doivent présenter
 * leurs pastilles dans le même ordre, sinon la colonne devient illisible à la verticale.
 */
const PURPOSE_ORDER = ["content", "offers", "events", "partners"] as const;
const PURPOSE_LABEL: Record<string, string> = {
  content: "Newsletter",
  offers: "Offers",
  events: "Events",
  partners: "Partners",
};

function initials(name: string | null, email: string) {
  return (name?.trim() || email).slice(0, 2).toUpperCase();
}
function barColor(score: number) {
  return score >= 60 ? "bg-brand" : score >= 30 ? "bg-[#e8973a]" : "bg-[#a3a3ad]";
}
function fmtDate(iso: string) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { day: "numeric", month: "short" });
}

function HeadCell({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <th className={cn("border-b border-border px-4 py-3 text-left text-[12px] font-semibold uppercase tracking-[0.02em] text-foreground/60", className)}>{children}</th>;
}

/**
 * « CAME FROM » — la provenance en deux lignes, jamais en deux colonnes.
 *
 * ⛔ Un tiret nu se lit comme une panne. Personne n'a d'origine aujourd'hui (0 événement de capture
 * en base, 1 202 contacts de démonstration sur 1 203) : l'écran doit DIRE qu'aucun formulaire n'a
 * été enregistré, pas laisser croire que la lecture a échoué.
 *
 * ⚠️ La créative affichée est la PREMIÈRE TOUCHE. Le nombre d'inscriptions vit dans la pastille
 * `+N` : une seule ligne ne peut pas porter honnêtement deux provenances côte à côte.
 */
function CameFrom({
  row, optinNames, campaignNames, variantNames,
}: {
  row: SubscriberRow;
  optinNames: Record<string, string>;
  campaignNames: Record<string, string>;
  /** Bras A/B de l'inscription la PLUS ANCIENNE de la personne. */
  variantNames: Record<string, string>;
}) {
  if (row.capture_event_count === 0) {
    return <span className="text-[12.5px] text-muted-foreground/70">No signup form recorded</span>;
  }
  const optinId = row.optin_id ?? row.capture_optin_ids[0] ?? null;
  const campaignId = row.capture_campaign_id ?? row.capture_campaign_ids[0] ?? null;
  const creative = optinId ? optinNames[optinId] : null;
  const campagne = campaignId ? campaignNames[campaignId] : null;
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5">
        <b className="truncate text-[13px] font-semibold">{creative ?? "Signup form unknown"}</b>
        {/* ⚠️ « +2 » se lit « 2 inscriptions EN PLUS de celle affichée », donc 3 au total — la
            convention inverse est tout aussi défendable, et une pastille nue ne dit ni l'une ni
            l'autre. `Pill` n'accepte pas de `title`, d'où l'enveloppe. */}
        {row.capture_event_count > 1 && (
          <span
            className="shrink-0"
            title={`${row.capture_event_count} signups recorded — ${row.capture_event_count - 1} more than the one shown here`}
          >
            <Pill tone="violet">+{row.capture_event_count - 1}</Pill>
          </span>
        )}
      </div>
      <div className="truncate text-[11.5px] text-muted-foreground">{campagne ?? "No campaign"}</div>
      {/* Le bras A/B, quand l'inscription la PLUS ANCIENNE en portait un.
          ⚠️ Ce n'est pas forcément l'inscription du formulaire en gras au-dessus : `optin_id` est
          figée à l'ordre d'ARRIVÉE des requêtes du pont et n'est jamais réalignée, alors que le
          bras est pris au plus petit `occurred_at`. Les deux coïncident tant qu'une personne n'a
          qu'une inscription — le cas de toutes celles reçues jusqu'ici — et peuvent désigner deux
          formulaires différents dès qu'elle en a deux arrivées dans le désordre.
          ⛔ Rien n'est rendu en l'absence de bras : cette base ne connaît pas les bras d'une
          créative, donc « pas d'A/B » serait une affirmation qu'on ne peut pas tenir. Une ligne
          muette vaut mieux qu'une ligne fausse. */}
      {variantNames[row.id] && (
        <div className="truncate text-[11px] text-muted-foreground/70" title={`A/B variant: ${variantNames[row.id]}`}>
          A/B · {variantNames[row.id]}
        </div>
      )}
    </div>
  );
}

export function SubscribersTable({
  rows,
  tags,
  optinNames,
  campaignNames,
  variantNames,
  baseQuery,
  assetId,
  total,
  filtre,
}: {
  rows: SubscriberRow[];
  tags: Record<number, TagInfo>;
  /** Noms COURANTS des créatives et des campagnes, résolus une fois pour toute la page. */
  optinNames: Record<string, string>;
  campaignNames: Record<string, string>;
  /** Bras A/B par souscription — vide tant qu'aucune inscription n'en portait. */
  variantNames: Record<string, string>;
  /** Query string (level + page) préservé pour les liens du drawer ?view. */
  baseQuery: string;
  /**
   * La marque courante — elle CLOISONNE la sélection persistée.
   *
   * ⛔ Sans elle, une sélection faite sur une marque resterait cochée après bascule vers une autre,
   * et les routes la rejetteraient en bloc alors que l'écran annonce « 20 selected ».
   */
  assetId: string | null;
  /** Le nombre de lignes que les filtres courants ramènent EN TOUT — pas seulement sur cette page. */
  total: number;
  /**
   * Les filtres affichés, tels quels, pour que « tout sélectionner » demande au serveur EXACTEMENT
   * la population que l'écran montre. ⛔ Aucune marque ici : elle vient de la session, côté serveur.
   */
  filtre: {
    level: string; campaign: string | null; creative: string | null; interest: string | null;
    status: string | null; pays: string | null;
  };
}) {
  const router = useRouter();
  /*
   * ⛔ INDEXÉE PAR `id`, PAS PAR ADRESSE. La sélection portait l'e-mail : c'était sans conséquence
   * tant que rien n'était câblé, mais une adresse peut porter PLUSIEURS souscriptions, et aucune
   * des trois routes ne saurait laquelle viser. `id` est l'identifiant de la souscription — la
   * ligne qu'on voit, celle qu'on a cochée.
   */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /*
   * ⛔⛔ CE DRAPEAU N'EST PAS UN DÉTAIL : SANS LUI, LA PERSISTANCE S'EFFACE ELLE-MÊME.
   *
   * L'effet d'écriture ci-dessous tourne aussi au PREMIER rendu, à un moment où `selected` est
   * encore le `new Set()` initial — il écraserait donc le stockage avec une sélection vide, juste
   * avant que l'effet de lecture ait pu la relire. Le résultat serait une persistance qui
   * fonctionne « presque » : rien à l'écran, rien en erreur, et la sélection perdue exactement
   * comme avant le correctif.
   */
  const [relu, setRelu] = useState(false);
  const cle = cleDeSelection(assetId);

  /*
   * LECTURE — au montage seulement, jamais pendant le rendu.
   *
   * ⛔ PAS DANS UN INITIALISEUR DE `useState`. Le rendu serveur n'a pas `sessionStorage` : une
   * sélection non vide au premier rendu client produirait un HTML différent de celui envoyé par le
   * serveur, et React remplacerait l'arbre en signalant une erreur d'hydratation. On rend donc
   * d'abord l'écran vide — celui que le serveur a produit — puis on restaure.
   */
  useEffect(() => {
    try {
      setSelected(new Set(lireSelection(window.sessionStorage.getItem(cle))));
    } catch {
      // Navigation privée, stockage refusé par le navigateur, quota plein : on repart d'une
      // sélection vide. La page doit marcher sans mémoire, simplement sans la garder.
    }
    setRelu(true);
  }, [cle]);

  /** ÉCRITURE — après la relecture uniquement, pour ne pas écraser ce qu'on vient de lire. */
  useEffect(() => {
    if (!relu) return;
    try {
      window.sessionStorage.setItem(cle, ecrireSelection(selected));
    } catch {
      // Le stockage peut refuser (mode privé, quota). La sélection reste vivante en mémoire pour
      // cette page : on perd la survie à la navigation, pas la sélection en cours.
    }
  }, [selected, cle, relu]);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [menuTag, setMenuTag] = useState(false);
  /** Ce que l'effacement touchera, compté par le serveur AVANT d'écrire quoi que ce soit. */
  const [aEffacer, setAEffacer] = useState<{ people: number; subscriptions: number } | null>(null);

  const viewHref = (email: string) => `/subscribers?${baseQuery ? baseQuery + "&" : ""}view=${encodeURIComponent(email)}`;

  const ids = useMemo(() => rows.map((r) => r.id), [rows]);
  const allSelected = ids.length > 0 && ids.every((i) => selected.has(i));
  const someSelected = selected.size > 0 && !allSelected;

  /*
   * ⛔ LA CASE D'EN-TÊTE NE PORTE QUE SUR CETTE PAGE — ET NE DOIT DONC PLUS ÉCRASER LE RESTE.
   *
   * Elle faisait `new Set(ids)` : acceptable tant que la sélection mourait à chaque navigation,
   * destructeur depuis qu'elle survit. Cocher « tout » sur la page 2 aurait effacé les vingt-cinq
   * lignes cochées sur la page 1 — sans un mot, et en laissant l'écran annoncer « 25 selected »
   * comme si de rien n'était. On ajoute et on retire les ids de la page, on ne remplace pas.
   */
  const toggleAll = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) for (const i of ids) next.delete(i);
      else for (const i of ids) next.add(i);
      return next;
    });
  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const clear = () => {
    setSelected(new Set());
    setMenuTag(false);
    setAEffacer(null);
    setError(null);
    setNote(null);
  };

  /** Les tags POSABLES à la main, triés par libellé. */
  const tagsManuels = useMemo(
    () =>
      Object.entries(tags)
        // ⛔ Les intérêts sont exclus : ils sont projetés par le trigger de capture et disent ce que
        // la personne a CHOISI. En poser un à la main effacerait la seule différence entre « elle a
        // coché ça » et « nous l'avons classée comme ça ».
        .filter(([, t]) => t.kind !== "interest")
        .map(([id, t]) => ({ id: Number(id), label: t.label }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [tags],
  );

  async function appeler(cle: string, url: string, corps: unknown): Promise<Record<string, unknown> | null> {
    if (busy) return null;
    setBusy(cle);
    setError(null);
    setNote(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(corps),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        setError(messageDeRefus(res.status, body));
        return null;
      }
      return body;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function poserLeTag(tagId: number, label: string) {
    const body = await appeler("tag", "/api/subscribers/tag", { ids: [...selected], tagId });
    if (!body) return;
    const pose = Number(body.tagged ?? 0);
    const deja = Number(body.already ?? 0);
    setMenuTag(false);
    setNote(
      pose === 0 && deja > 0
        ? `Every selected subscriber already had “${label}”.`
        : `“${label}” added to ${pose} subscriber${pose === 1 ? "" : "s"}${deja > 0 ? ` — ${deja} already had it` : ""}.`,
    );
    router.refresh();
  }

  async function exporter() {
    if (busy) return;
    setBusy("export");
    setError(null);
    setNote(null);
    try {
      const res = await fetch("/api/subscribers/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [...selected] }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        setError(messageDeRefus(res.status, body));
        return;
      }
      /*
       * ⛔ Le fichier n'est PAS une URL qu'on ouvrirait : la requête est un POST (les identifiants
       * ne doivent pas voyager dans une adresse, qui finit dans les journaux du proxy et
       * l'historique). On fabrique donc le téléchargement à partir de la réponse.
       */
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = nomDuFichier(res.headers.get("Content-Disposition"));
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setNote(`${selected.size} subscriber${selected.size === 1 ? "" : "s"} exported.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(null);
    }
  }

  /**
   * TOUT sélectionner — les lignes des autres pages comprises.
   *
   * ⛔ LES IDENTIFIANTS VIENNENT DU SERVEUR, ils ne peuvent pas venir d'ailleurs : le navigateur ne
   * connaît que les 25 lignes qu'il a reçues. On renvoie donc les filtres affichés et on reçoit la
   * population correspondante, calculée par la fonction qui sert la liste elle-même.
   */
  async function toutSelectionner() {
    const body = await appeler("select-all", "/api/subscribers/ids", filtre);
    if (!body) return;
    const ids = Array.isArray(body.ids) ? body.ids.filter((i): i is string => typeof i === "string") : [];
    setSelected(new Set(ids));
    /*
     * ⛔ UNE SÉLECTION TRONQUÉE SE DIT. Au-delà du plafond, ce qui est coché ne couvre pas ce que
     * l'écran annonce : taire l'écart ferait tagger — ou effacer — une part de la population en
     * silence, et le compte rendu final donnerait un nombre plus petit sans que personne ne sache
     * lequel des deux est le bon.
     */
    setNote(
      body.tronque === true
        ? `Selected the first ${ids.length} of ${Number(body.total ?? 0)} — that is the most one action can cover at once.`
        : `All ${ids.length} matching subscriber${ids.length === 1 ? "" : "s"} selected.`,
    );
  }

  /** Premier temps : on COMPTE, on n'écrit rien. Le nombre affiché est celui qui changera. */
  async function demanderEffacement() {
    const body = await appeler("erase-count", "/api/subscribers/erase", { ids: [...selected] });
    if (!body) return;
    setAEffacer({
      people: Number(body.people ?? 0),
      subscriptions: Number(body.subscriptions ?? 0),
    });
  }

  async function effacerPourDeVrai() {
    const body = await appeler("erase", "/api/subscribers/erase", { ids: [...selected], confirm: true });
    if (!body) return;
    const efface = Number(body.erased ?? 0);
    setAEffacer(null);
    setSelected(new Set());
    setNote(`${efface} ${efface === 1 ? "person" : "people"} erased. Their data is gone; proof of consent is kept anonymized.`);
    router.refresh();
  }

  return (
    <>
      <div className="overflow-x-auto rounded-[14px] border border-border bg-card">
        <table className="w-full min-w-[820px] border-collapse text-[13px]">
          <thead>
            <tr className="bg-[#fcfcfe]">
              <HeadCell className="w-[42px] pr-0">
                <input
                  type="checkbox"
                  aria-label="Select all subscribers on this page"
                  checked={allSelected}
                  ref={(el) => { if (el) el.indeterminate = someSelected; }}
                  onChange={toggleAll}
                  className="h-[15px] w-[15px] cursor-pointer accent-brand"
                />
              </HeadCell>
              <HeadCell>Subscriber</HeadCell>
              <HeadCell>Consent</HeadCell>
              <HeadCell>Engagement</HeadCell>
              <HeadCell>Came from</HeadCell>
              <HeadCell>Country</HeadCell>
              <HeadCell>Tags &amp; interests</HeadCell>
              <HeadCell>Subscription options</HeadCell>
              <HeadCell>Joined</HeadCell>
              <HeadCell />
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const lvl = LEVEL_PILL[s.engagement_level] ?? LEVEL_PILL.churned;
              const consent = CONSENT_PILL[s.status] ?? { tone: "grey" as Tone, label: s.status };
              const muted = !CONSENTING.has(s.status);
              const isSel = selected.has(s.id);
              /* Un intérêt est aussi un tag : l'union évite qu'un intérêt projeté par le trigger
                 mais non encore attaché comme tag disparaisse de l'écran. Le `kind` tranche la
                 couleur — c'est la seule chose qui distingue « il a choisi ça » de « on lui a
                 posé ça ». */
              const rowTags = [...new Set([...s.tag_ids, ...s.interest_ids])]
                .map((id) => tags[id])
                .filter((t): t is TagInfo => Boolean(t));
              const interests = rowTags.filter((t) => t.kind === "interest");
              const manuels = rowTags.filter((t) => t.kind !== "interest");
              const visibles = [...interests, ...manuels].slice(0, 2);
              const reste = rowTags.length - visibles.length;
              /* Les finalités ACCORDÉES, dans l'ordre du formulaire ; une finalité inconnue de la
                 table de libellés s'affiche telle quelle plutôt que de disparaître (même doctrine
                 que `purposeLabel` côté campagnes). ⛔ Pas de `slice` ici : `partners` est la plus
                 rare (5 abonnements sur 1 208) et la plus sensible — la masquer derrière un « +1 »
                 cacherait justement celle qu'on regarde. */
              const accordees = Object.keys(s.purposes)
                .filter((p) => s.purposes[p] === true)
                .sort((a, b) => {
                  const ia = PURPOSE_ORDER.indexOf(a as (typeof PURPOSE_ORDER)[number]);
                  const ib = PURPOSE_ORDER.indexOf(b as (typeof PURPOSE_ORDER)[number]);
                  return (ia < 0 ? PURPOSE_ORDER.length : ia) - (ib < 0 ? PURPOSE_ORDER.length : ib);
                });
              return (
                <tr
                  key={s.id}
                  className={cn(
                    "transition-colors hover:bg-brand-soft/40",
                    isSel && "bg-brand-soft/30",
                    muted && !isSel && "opacity-55",
                  )}
                >
                  <Td className="pr-0">
                    <input
                      type="checkbox"
                      aria-label={`Select ${s.email}`}
                      checked={isSel}
                      onChange={() => toggleOne(s.id)}
                      className="h-[15px] w-[15px] cursor-pointer accent-brand"
                    />
                  </Td>
                  <Td>
                    <div className="flex items-center gap-2.5">
                      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-[11px] font-semibold text-foreground/70">
                        {initials(s.first_name, s.email)}
                      </span>
                      <div>
                        <b className="font-semibold">{s.email}</b>
                        <div className="text-[12px] text-muted-foreground">{s.first_name ?? "—"}</div>
                      </div>
                    </div>
                  </Td>
                  <Td><Pill tone={consent.tone} dot>{consent.label}</Pill></Td>
                  <Td>
                    {/* Score fusionné dans Engagement : pill + barre + valeur ensemble. */}
                    <div className="flex flex-col gap-1.5">
                      <Pill tone={lvl.tone} dot>{lvl.label}</Pill>
                      <div className="flex items-center gap-2">
                        <span className="h-1.5 w-[70px] overflow-hidden rounded-full bg-accent">
                          <span className={cn("block h-full rounded-full", barColor(s.engagement_score))} style={{ width: `${s.engagement_score}%` }} />
                        </span>
                        <span className="tabular-nums text-[12px] text-muted-foreground">{s.engagement_score}</span>
                      </div>
                    </div>
                  </Td>
                  <Td className="max-w-[210px]">
                    <CameFrom row={s} optinNames={optinNames} campaignNames={campaignNames} variantNames={variantNames} />
                  </Td>
                  <Td className="text-muted-foreground">{s.country ?? "—"}</Td>
                  <Td>
                    {rowTags.length ? (
                      <div className="flex flex-wrap items-center gap-1">
                        {visibles.map((t) => (
                          <Pill key={t.slug} tone={t.kind === "interest" ? "violet" : "grey"}>{t.label}</Pill>
                        ))}
                        {reste > 0 && <span className="text-[11.5px] font-medium text-muted-foreground">+{reste}</span>}
                      </div>
                    ) : (
                      <span className="text-muted-foreground/50">—</span>
                    )}
                  </Td>
                  <Td className="max-w-[190px]">
                    {accordees.length ? (
                      <div className="flex flex-wrap items-center gap-1">
                        {accordees.map((p) => (
                          <Pill key={p} tone="green">{PURPOSE_LABEL[p] ?? p}</Pill>
                        ))}
                      </div>
                    ) : (
                      /* ⛔ Deux silences différents, deux mots différents : un objet VIDE veut dire
                         que le choix n'a jamais été recueilli (les abonnements antérieurs au
                         formulaire), des clés toutes à `false` veulent dire que la personne a tout
                         refusé. Écrire « — » dans les deux cas ferait passer l'un pour l'autre. */
                      <span
                        className="text-muted-foreground/50"
                        title={Object.keys(s.purposes).length ? "Every option declined" : "No subscription options recorded"}
                      >
                        {Object.keys(s.purposes).length ? "None" : "—"}
                      </span>
                    )}
                  </Td>
                  <Td className="text-muted-foreground">{fmtDate(s.created_at)}</Td>
                  <Td>
                    <Link href={viewHref(s.email)} aria-label={`View ${s.email}`} className="inline-flex text-muted-foreground/50 hover:text-brand">
                      <ChevronRight className="h-4 w-4" />
                    </Link>
                  </Td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr><Td className="py-10 text-center text-muted-foreground">No subscribers for this filter.</Td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/*
        Barre d'actions groupées — flottante, visible dès qu'une ligne est sélectionnée.

        ⛔ ELLE A LONGTEMPS MENTI. Les trois boutons n'avaient aucun `onClick` (« MOCK UI » en
        commentaire) : au clic, rien — pas d'erreur, pas de requête, juste le survol qui s'allume.
        Et ils étaient les SEULS de cette page à ne pas suivre sa règle, qui veut qu'un contrôle non
        câblé soit grisé et annoncé « Coming soon » (« Import CSV », « Add », « Filters », « Sort »).
        Un bouton d'apparence vivante qui n'émet aucun signal est le plus coûteux des états : il n'y
        a rien à diagnostiquer.
      */}
      {selected.size > 0 && (
        <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center px-4">
          <div className="pointer-events-auto w-full max-w-[600px] space-y-2">
            {error && (
              <div className="flex items-start gap-2 rounded-[12px] border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[12.5px] text-amber-900 shadow-lg">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}
            {note && !error && (
              <div className="rounded-[12px] border border-border bg-card px-3.5 py-2.5 text-[12.5px] text-muted-foreground shadow-lg">
                {note}
              </div>
            )}

            {/*
              ⛔ LA CONFIRMATION PORTE SUR DES PERSONNES, PAS SUR DES LIGNES COCHÉES. Une personne
              peut porter plusieurs souscriptions : annoncer le nombre de cases cochées promettrait
              des effacements qui n'auront pas lieu. Et la portée est GLOBALE — c'est le sens du
              droit à l'oubli — donc l'écran le dit, au lieu de laisser croire que le geste s'arrête
              à la marque qu'on regarde.
            */}
            {aEffacer && (
              <div className="rounded-[12px] border border-[#d6336c]/30 bg-card px-3.5 py-3 shadow-xl">
                <p className="text-[13px] font-semibold">
                  Erase {aEffacer.people} {aEffacer.people === 1 ? "person" : "people"}?
                </p>
                <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
                  Their email and name are removed for good, and {aEffacer.subscriptions}{" "}
                  {aEffacer.subscriptions === 1 ? "subscription is" : "subscriptions are"} closed —{" "}
                  <b>across every brand</b>, not just this one. Proof of consent is kept anonymized,
                  as the law requires, and the address can never be re-added by an import.
                </p>
                <div className="mt-2.5 flex items-center gap-2">
                  <button
                    onClick={effacerPourDeVrai}
                    disabled={busy !== null}
                    className="rounded-[9px] bg-[#d6336c] px-3 py-1.5 text-[12.5px] font-semibold text-white transition-colors hover:bg-[#bf2d5f] disabled:opacity-50"
                  >
                    {busy === "erase" ? "Erasing…" : "Yes, erase"}
                  </button>
                  <button
                    onClick={() => setAEffacer(null)}
                    className="rounded-[9px] border border-border px-3 py-1.5 text-[12.5px] font-medium hover:bg-accent"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {menuTag && (
              <div className="rounded-[12px] border border-border bg-card p-2 shadow-xl">
                {tagsManuels.length === 0 ? (
                  <p className="px-2 py-1.5 text-[12.5px] text-muted-foreground">
                    This brand has no tag to apply yet — interests come from the signup form and are
                    not set by hand.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {tagsManuels.map((t) => (
                      <button
                        key={t.id}
                        onClick={() => poserLeTag(t.id, t.label)}
                        disabled={busy !== null}
                        className="rounded-[9px] border border-border px-2.5 py-1.5 text-[12.5px] font-medium transition-colors hover:border-brand/40 hover:bg-accent disabled:opacity-50"
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/*
              ⛔ LE PONT ENTRE « CETTE PAGE » ET « TOUTE LA LISTE ».
              La case d'en-tête ne coche que les lignes reçues — c'est le seul sens honnête pour une
              case posée dans un en-tête de tableau. Mais sans ce relais, agir sur 400 personnes
              demandait de parcourir seize pages, et « tout sélectionner » devenait un geste que
              l'outil promettait sans le rendre.
              Il n'apparaît QUE s'il y a réellement quelque chose de plus à prendre.
            */}
            {allSelected && total > rows.length && selected.size < total && (
              <div className="flex flex-wrap items-center justify-center gap-2 rounded-[12px] border border-border bg-accent/70 px-3 py-2 text-[12.5px]">
                <span className="text-muted-foreground">
                  All {rows.length} on this page are selected.
                </span>
                <button
                  onClick={toutSelectionner}
                  disabled={busy !== null}
                  className="font-semibold text-brand underline underline-offset-2 transition-opacity hover:opacity-80 disabled:opacity-50"
                >
                  {busy === "select-all"
                    ? "Selecting…"
                    : `Select all ${total.toLocaleString("en-US")} matching these filters`}
                </button>
              </div>
            )}

            <div className="flex items-center gap-2 rounded-[14px] border border-border bg-card px-3 py-2.5 shadow-2xl">
              <span className="px-1.5 text-[13px] font-semibold tabular-nums">{selected.size} selected</span>
              <span className="mx-0.5 h-5 w-px bg-border" />
              <button
                onClick={() => { setMenuTag((o) => !o); setAEffacer(null); }}
                disabled={busy !== null}
                aria-expanded={menuTag}
                className="inline-flex items-center gap-1.5 rounded-[9px] px-2.5 py-1.5 text-[12.5px] font-medium text-foreground/75 transition-colors hover:bg-accent disabled:opacity-50"
              >
                <Tag className="h-[14px] w-[14px]" /> {busy === "tag" ? "Tagging…" : "Tag"}
              </button>
              <button
                onClick={exporter}
                disabled={busy !== null}
                className="inline-flex items-center gap-1.5 rounded-[9px] px-2.5 py-1.5 text-[12.5px] font-medium text-foreground/75 transition-colors hover:bg-accent disabled:opacity-50"
              >
                <Download className="h-[14px] w-[14px]" /> {busy === "export" ? "Preparing…" : "Export"}
              </button>
              <button
                onClick={() => { setMenuTag(false); demanderEffacement(); }}
                disabled={busy !== null}
                className="inline-flex items-center gap-1.5 rounded-[9px] px-2.5 py-1.5 text-[12.5px] font-medium text-[#d6336c] transition-colors hover:bg-brand-soft/50 disabled:opacity-50"
              >
                <Trash2 className="h-[14px] w-[14px]" /> {busy === "erase-count" ? "Checking…" : "Delete"}
              </button>
              <span className="mx-0.5 h-5 w-px bg-border" />
              <button onClick={clear} aria-label="Clear selection" className="inline-flex rounded-md p-1.5 text-muted-foreground hover:bg-accent">
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
