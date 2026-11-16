import Link from "next/link";
import { SlidersHorizontal, ArrowUpDown, ChevronLeft, ChevronRight } from "lucide-react";
import { PageHead, Btn, Pill } from "@/components/ui";
import { getSubscribers, getSubscriberDetail, getPaysAbonnes, type LevelFilter } from "@/lib/data/subscribers";
import { libelleDuTri, TRIS_ABONNES, TRI_PAR_DEFAUT, triDemande, type TriAbonnes } from "@/lib/data/tri-abonnes";
import { FILTRES_STATUT, libelleDuStatut, statutDemande, type FiltreStatut } from "@/lib/data/statut-abonnes";
import { libelleDuPays, paysDemande } from "@/lib/data/pays-abonnes";
import { listOptins } from "@/lib/data/optins";
import { loadCaptureFilterOptions } from "@/lib/data/capture";
import { SubscriberDrawer } from "@/components/subscribers/subscriber-drawer";
import { SubscribersTable } from "@/components/subscribers/bulk-actions";
import { AddImport } from "@/components/subscribers/add-import";
import { getCurrentAsset } from "@/lib/asset-context";
import { lireActiviteDAbonne } from "@/lib/data/engagement";
import type { ActiviteAbonne, Lecture } from "@/lib/engagement";
import { getDb } from "@/lib/supabase";
import { cn } from "@/lib/utils";

// Lit la base à chaque requête (données abonnés = jamais figées au build).
export const dynamic = "force-dynamic";

/**
 * L'activité e-mail de la personne ouverte dans le tiroir, sur la MARQUE COURANTE (0094).
 *
 * ⚠️ `SubscriberDetail` ne porte pas l'identifiant de l'abonné : on le relit par l'adresse, exactement
 * comme `getSubscriberDetail` l'a trouvé. ⛔ Une relecture ratée rend `known: false` avec sa raison —
 * jamais une activité vide, qui se lirait « on ne lui a rien envoyé ».
 * (Fonction locale, non exportée : un `page.tsx` n'exporte que `default` et sa config.)
 */
async function lireActiviteDuTiroir(email: string, assetId: string | null): Promise<Lecture<ActiviteAbonne>> {
  const db = getDb();
  if (!db) return { known: false, reason: "the database is not configured" };
  if (!assetId) return { known: false, reason: "no brand selected" };
  const { data, error } = await db.from("subscriber").select("id").eq("email", email).maybeSingle();
  if (error || !data) return { known: false, reason: "the subscriber could not be read" };
  return lireActiviteDAbonne(db, assetId, String((data as { id: string }).id));
}

const LEVELS: { key: LevelFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "dormant", label: "Dormant" },
  { key: "churned", label: "Lapsed" },
];

const propre = (v: string | undefined): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

export default async function SubscribersPage({
  searchParams,
}: {
  searchParams: Promise<{
    level?: string; view?: string; page?: string;
    optin?: string; creative?: string; campaign?: string; interest?: string;
    sort?: string; status?: string; pays?: string;
  }>;
}) {
  const sp = await searchParams;
  const level: LevelFilter = (["active", "dormant", "churned"] as const).includes(sp.level as never)
    ? (sp.level as LevelFilter)
    : "all";
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);
  // ⚠️ `?optin=` reste accepté comme alias de `?creative=` : c'est la même chose sous son ancien
  // nom, et des liens (favoris, e-mails internes) le portent déjà. Le casser rendrait une liste
  // entière au lieu d'une sous-liste — l'erreur la plus silencieuse possible.
  const creative = propre(sp.creative) ?? propre(sp.optin);
  const campaign = propre(sp.campaign);
  const interest = propre(sp.interest);
  // ⛔ Une valeur inconnue retombe sur le défaut ICI, avant d'atteindre la requête : elle ne devient
  // jamais un nom de colonne dans un `.order()`.
  const tri = triDemande(sp.sort);
  // ⚠️ `null` = pas de filtre, y compris pour une valeur inconnue : contrairement aux provenances,
  // un `?status=` mal orthographié ne désigne aucune population — rendre zéro ligne ferait croire
  // que la marque est vide. Voir `statutDemande`.
  const statut = statutDemande(sp.status);
  // ⛔ LA RÈGLE DIFFÈRE DE CELLE DU STATUT, ET C’EST VOULU. Une valeur MAL FORMÉE n’atteint
  // jamais le `.eq()` ; un code BIEN FORMÉ mais inconnu, si — il désigne une population
  // parfaitement définie, qui se trouve être vide, et la rendre vide est la vérité.
  const pays = paysDemande(sp.pays);

  const asset = await getCurrentAsset();
  const [
    { rows, counts, tags, optinNames, campaignNames, variantNames, sendable, demo, notFound, pageSize, scoped, source },
    optins,
    options,
    paysDisponibles,
  ] = await Promise.all([
    getSubscribers(asset.id, level, page, 25, { campaign, creative, interest }, tri, statut, pays),
    listOptins(asset.id),
    loadCaptureFilterOptions(asset.id),
    getPaysAbonnes(asset.id),
  ]);
  /*
   * ⛔ LE PAYS FILTRÉ FIGURE TOUJOURS DANS SON PROPRE MENU. Le menu vient d’un ÉCHANTILLON borné
   * (PostgREST n’a pas de `SELECT DISTINCT`) : un pays rare peut en manquer alors qu’un lien ou
   * un favori le filtre déjà. Sans cette ligne, le menu n’allumerait aucune entrée et l’écran
   * se lirait comme non filtré — le défaut exact qu’on a déjà corrigé sur les provenances.
   */
  const paysDuMenu = pays && !paysDisponibles.includes(pays) ? [pays, ...paysDisponibles] : paysDisponibles;
  const fmt = (n: number) => n.toLocaleString("en-US");

  /*
   * ⛔ UNE PASTILLE QUI NE S'ALLUME PAS N'ANNULE PAS LE FILTRE — ELLE LE CACHE.
   *
   * Les options proposées ne sont pas l'ensemble des valeurs FILTRABLES : les campagnes archivées
   * sont écartées (`is archived_at null`), campagnes et intérêts sont bornés à 50, et la liste des
   * créatives peut être en panne. `getSubscribers`, lui, résout l'identifiant sans aucune de ces
   * restrictions : la liste EST filtrée pendant que l'écran se présente comme non filtré, sans
   * mention dans l'en-tête et sans « × » pour revenir en arrière — 12 lignes sur 1 203 qui se
   * lisent comme « il n'y a que ça ».
   *
   * On fabrique donc la pastille depuis le filtre demandé dès qu'il n'est pas introuvable. Un
   * filtre INTROUVABLE, lui, garde son bandeau ambre et aucune pastille : les deux se
   * contrediraient.
   */
  const creativeCourante = !creative || notFound.creative
    ? null
    : (optins.rows.find((o) => o.slug === creative) ?? { name: creative });
  const campagneCourante = !campaign || notFound.campaign
    ? null
    : (options.campaigns.find((c) => c.id === campaign) ?? { name: campaignNames[campaign] ?? "Selected campaign" });
  const interetCourant = !interest || notFound.interest
    ? null
    : (options.interests.find((i) => i.slug === interest) ?? { label: interest });

  const total = level === "all" ? counts.all : counts[level];
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, (page - 1) * pageSize + rows.length);

  // Query préservée (level + les 3 niveaux de provenance + page) pour le drawer et la pagination.
  // ⚠️ Tout filtre absent d'ici est un filtre PERDU au clic sur « Next » : la page 2 afficherait
  // toute la marque en laissant les chips allumées à l'écran.
  const parts: string[] = [];
  if (level !== "all") parts.push(`level=${level}`);
  if (campaign) parts.push(`campaign=${encodeURIComponent(campaign)}`);
  if (creative) parts.push(`creative=${encodeURIComponent(creative)}`);
  if (interest) parts.push(`interest=${encodeURIComponent(interest)}`);
  // ⚠️ LE TRI EST DANS `parts` POUR LA MÊME RAISON QUE LES FILTRES : absent d'ici, il serait perdu
  // au clic sur « Next », et la page 2 repartirait dans l'ordre par défaut en laissant le bouton
  // afficher l'ordre choisi. Omis quand il vaut le défaut, pour ne pas alourdir l'URL.
  if (tri !== TRI_PAR_DEFAUT) parts.push(`sort=${tri}`);
  if (statut) parts.push(`status=${statut}`);
  if (pays) parts.push(`pays=${pays}`);
  const pageHref = (p: number) => {
    const qp = [...parts, ...(p > 1 ? [`page=${p}`] : [])];
    return `/subscribers${qp.length ? "?" + qp.join("&") : ""}`;
  };
  /** Changer UN filtre garde les trois autres — retirer le sien ne doit pas retirer ceux d'à côté. */
  const filtreHref = (o: {
    level?: LevelFilter; campaign?: string | null; creative?: string | null; interest?: string | null;
    sort?: TriAbonnes; status?: FiltreStatut | null; pays?: string | null;
  }) => {
    const lvl = o.level ?? level;
    const cmp = o.campaign === undefined ? campaign : o.campaign;
    const crv = o.creative === undefined ? creative : o.creative;
    const itr = o.interest === undefined ? interest : o.interest;
    // ⚠️ Le tri suit le même parti que les filtres : on garde celui en cours sauf demande explicite.
    // Changer de filtre ne doit pas réordonner la liste sous les yeux de celui qui filtre.
    const srt = o.sort ?? tri;
    const sts = o.status === undefined ? statut : o.status;
    const pys = o.pays === undefined ? pays : o.pays;
    const qp: string[] = [];
    if (lvl !== "all") qp.push(`level=${lvl}`);
    if (cmp) qp.push(`campaign=${encodeURIComponent(cmp)}`);
    if (crv) qp.push(`creative=${encodeURIComponent(crv)}`);
    if (itr) qp.push(`interest=${encodeURIComponent(itr)}`);
    if (srt !== TRI_PAR_DEFAUT) qp.push(`sort=${srt}`);
    if (sts) qp.push(`status=${sts}`);
    if (pys) qp.push(`pays=${pys}`);
    return `/subscribers${qp.length ? "?" + qp.join("&") : ""}`;
  };
  const baseQuery = [...parts, ...(page > 1 ? [`page=${page}`] : [])].join("&");
  const closeHref = pageHref(page);
  const detail = sp.view ? await getSubscriberDetail(sp.view) : null;
  // ⛔ La marque vient de la session (`getCurrentAsset`), jamais de l'URL : c'est elle qui borne la lecture.
  const activite = detail ? await lireActiviteDuTiroir(detail.email, asset.id) : null;

  const filtresActifs: string[] = [];
  if (campagneCourante) filtresActifs.push(`campaign “${campagneCourante.name}”`);
  if (creativeCourante) filtresActifs.push(`form “${creativeCourante.name}”`);
  if (interetCourant) filtresActifs.push(`interest “${interetCourant.label}”`);
  // ⚠️ Le statut entre dans la phrase d'en-tête comme les autres : elle annonce « N in the list
  // from … », et taire un filtre actif ferait décrire par ce N une population plus large que celle
  // que le tableau montre.
  if (statut) filtresActifs.push(`status “${libelleDuStatut(statut)}”`);
  // ⚠️ Même raison que le statut : taire un filtre actif ferait décrire par ce N une population
  // plus large que celle que le tableau montre.
  if (pays) filtresActifs.push(`country “${libelleDuPays(pays)}”`);
  /*
   * Ce que le bouton « Filters » doit DIRE. Il ne portait qu’un filtre ; il en porte deux, et un
   * bouton qui n’annonce que le premier se lit comme « l’autre n’est pas actif ».
   */
  const filtresDuPanneau = [
    statut ? libelleDuStatut(statut) : null,
    pays ? libelleDuPays(pays) : null,
  ].filter((v): v is string => v !== null);

  const chipActif = "inline-flex items-center gap-1.5 rounded-[9px] border border-brand-soft bg-brand-soft px-3 py-[7px] text-[12.5px] font-medium text-brand-soft-foreground";
  const chipRepos = "inline-flex items-center gap-2 rounded-[9px] border border-border bg-card px-3 py-[7px] text-[12.5px] font-medium text-foreground/75 transition-colors hover:bg-accent";

  return (
    <div className="animate-fade-up">
      <PageHead
        title="Subscribers"
        desc={
          // ⛔ « 1,202 demo contacts hidden » serait un MENSONGE : cette liste ne filtre pas
          // `is_demo`, elle les montre. Le verbe doit décrire ce que la liste fait, sinon la phrase
          // censée rendre le zéro honnête devient elle-même le mensonge.
          // ⚠️ `total`, pas `counts.all` : les trois nombres de cette phrase doivent décrire la
          // population RÉELLEMENT affichée. Avec un filtre de niveau actif, `counts.all` annonçait
          // « 1,203 in the list » au-dessus d'un pied de page qui disait « Showing 1–25 of 412 ».
          !scoped
            ? `${fmt(counts.all)} subscribers across all brands — no brand filter could be applied.`
            : `${fmt(total)} in the list ${filtresActifs.length ? `from ${filtresActifs.join(" + ")}` : `on ${asset.name}`} — ${fmt(sendable)} sendable.${demo > 0 ? ` ${fmt(demo)} of them are demo contacts: shown here, never emailed.` : ""}`
        }
      >
        {scoped ? <Pill tone="pink" dot>{asset.name}</Pill> : <Pill tone="amber" dot>All brands</Pill>}
        <AddImport />
      </PageHead>

      {!scoped && source === "db" && (
        <div className="mb-4 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
          Brand context unavailable — this list and its counters cover all 9 brands.
        </div>
      )}

      {/* ⛔ Un identifiant de provenance inconnu rend une liste VIDE, pas la marque entière. Sans ces
          messages, cette liste vide se lirait comme « personne n'est venu par là ». */}
      {notFound.creative && (
        <div className="mb-4 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
          No opt-in form named <code>{creative}</code> on {asset.name}. Showing nothing rather than
          everyone — <Link href={filtreHref({ creative: null })} className="font-medium underline">clear the filter</Link>.
        </div>
      )}
      {notFound.campaign && (
        <div className="mb-4 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
          No acquisition campaign <code>{campaign}</code> on {asset.name}. Showing nothing rather than
          everyone — <Link href={filtreHref({ campaign: null })} className="font-medium underline">clear the filter</Link>.
        </div>
      )}
      {notFound.interest && (
        <div className="mb-4 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
          No interest named <code>{interest}</code> on {asset.name}. Showing nothing rather than
          everyone — <Link href={filtreHref({ interest: null })} className="font-medium underline">clear the filter</Link>.
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {LEVELS.map((f) => (
          <Link
            key={f.key}
            href={filtreHref({ level: f.key })}
            className={cn(
              "inline-flex items-center gap-2 rounded-[9px] border px-3 py-[7px] text-[12.5px] font-medium transition-colors",
              level === f.key
                ? "border-brand-soft bg-brand-soft text-brand-soft-foreground"
                : "border-border bg-card text-foreground/75 hover:bg-accent",
            )}
          >
            {f.label} <span className="tabular-nums opacity-70">{fmt(counts[f.key])}</span>
          </Link>
        ))}
        <Link href="/subscribers/capture" className={chipRepos}>Manage sources</Link>
      </div>

      {/* Les trois niveaux de provenance. Chaque groupe n'apparaît que s'il a au moins une option :
          un contrôle qui ne propose rien n'enseigne que son inutilité. */}
      {(options.campaigns.length > 0 || optins.rows.length > 0 || options.interests.length > 0
        || campagneCourante || creativeCourante || interetCourant) && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {(options.campaigns.length > 0 || campagneCourante) && (
            <>
              <span className="text-[12px] text-muted-foreground/70">Campaign</span>
              {campagneCourante ? (
                <Link href={filtreHref({ campaign: null })} className={chipActif}>
                  {campagneCourante.name} <span className="opacity-60">×</span>
                </Link>
              ) : (
                options.campaigns.slice(0, 3).map((c) => (
                  <Link key={c.id} href={filtreHref({ campaign: c.id })} className={chipRepos}>{c.name}</Link>
                ))
              )}
            </>
          )}

          {(optins.rows.length > 0 || creativeCourante) && (
            <>
              <span className="ml-1 text-[12px] text-muted-foreground/70">Creative</span>
              {creativeCourante ? (
                <Link href={filtreHref({ creative: null })} className={chipActif}>
                  {creativeCourante.name} <span className="opacity-60">×</span>
                </Link>
              ) : (
                optins.rows.slice(0, 3).map((o) => (
                  <Link key={o.id} href={filtreHref({ creative: o.slug })} className={chipRepos}>
                    {/* Le compte affiché est celui de TOUTES les touches — la même définition que
                        ce que le clic va filtrer. Afficher la première touche ici donnerait un
                        nombre que la liste filtrée contredirait. */}
                    {o.name} <span className="tabular-nums opacity-70">{fmt(o.contacts)}</span>
                  </Link>
                ))
              )}
            </>
          )}

          {(options.interests.length > 0 || interetCourant) && (
            <>
              <span className="ml-1 text-[12px] text-muted-foreground/70">Interest</span>
              {interetCourant ? (
                <Link href={filtreHref({ interest: null })} className={chipActif}>
                  {interetCourant.label} <span className="opacity-60">×</span>
                </Link>
              ) : (
                options.interests.slice(0, 4).map((i) => (
                  <Link key={i.id} href={filtreHref({ interest: i.slug })} className={chipRepos}>{i.label}</Link>
                ))
              )}
            </>
          )}
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex-1" />
        {source === "db" ? <Pill tone="green" dot>Database</Pill> : <Pill tone="amber" dot>Database unavailable</Pill>}
        {/*
          Le filtre qui manquait vraiment : l'ÉTAT DE CONSENTEMENT. La provenance (campagne,
          créative, intérêt) et le niveau d'engagement avaient déjà leurs chips au-dessus ; rien ne
          permettait en revanche de répondre à « qui s'est désabonné ? » ni de retrouver une
          personne effacée pour vérifier que l'effacement a bien eu lieu.
        */}
        <details className="relative">
          <summary
            className={cn(
              "inline-flex cursor-pointer list-none items-center gap-2 rounded-[9px] border px-3 py-[7px] text-[12.5px] font-medium transition-colors [&::-webkit-details-marker]:hidden",
              filtresDuPanneau.length > 0
                ? "border-brand-soft bg-brand-soft text-brand-soft-foreground"
                : "border-border bg-card text-foreground/75 hover:bg-accent",
            )}
          >
            <SlidersHorizontal className="h-[14px] w-[14px] opacity-70" />
            {filtresDuPanneau.length === 0
              ? "Filters"
              : filtresDuPanneau.length === 1
                ? filtresDuPanneau[0]
                : `${filtresDuPanneau.length} filters`}
          </summary>
          <div className="absolute right-0 z-20 mt-1 w-[200px] rounded-[10px] border border-border bg-card p-1 shadow-md">
            <div className="px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Consent
            </div>
            {/* « Any » d'abord : le moyen de REVENIR doit être aussi visible que celui de filtrer. */}
            <Link
              href={filtreHref({ status: null })}
              className={cn(
                "block rounded-[7px] px-2.5 py-[7px] text-[12.5px] transition-colors",
                statut === null
                  ? "bg-brand-soft font-medium text-brand-soft-foreground"
                  : "text-foreground/75 hover:bg-accent",
              )}
            >
              Any status
            </Link>
            {FILTRES_STATUT.map((f) => (
              <Link
                key={f.cle}
                href={filtreHref({ status: f.cle })}
                className={cn(
                  "block rounded-[7px] px-2.5 py-[7px] text-[12.5px] transition-colors",
                  f.cle === statut
                    ? "bg-brand-soft font-medium text-brand-soft-foreground"
                    : "text-foreground/75 hover:bg-accent",
                )}
              >
                {f.label}
              </Link>
            ))}
            {paysDuMenu.length > 0 && (
              <>
                {/* ⛔ Le groupe n’apparaît QUE s’il a des options : la colonne `country` est creuse
                    (l’inscription publique ne la transporte pas), et une marque entière peut n’en
                    avoir aucune. Un contrôle qui ne propose rien n’enseigne que son inutilité. */}
                <div className="mt-1 border-t border-border px-2.5 pb-1.5 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Country
                </div>
                <Link
                  href={filtreHref({ pays: null })}
                  className={cn(
                    "block rounded-[7px] px-2.5 py-[7px] text-[12.5px] transition-colors",
                    pays === null
                      ? "bg-brand-soft font-medium text-brand-soft-foreground"
                      : "text-foreground/75 hover:bg-accent",
                  )}
                >
                  Any country
                </Link>
                {/* ⚠️ Borné en hauteur, pas en nombre : tronquer la liste cacherait des pays qui
                    existent, alors que dérouler les montre tous. */}
                <div className="max-h-[220px] overflow-y-auto">
                  {paysDuMenu.map((c) => (
                    <Link
                      key={c}
                      href={filtreHref({ pays: c })}
                      className={cn(
                        "block rounded-[7px] px-2.5 py-[7px] text-[12.5px] transition-colors",
                        c === pays
                          ? "bg-brand-soft font-medium text-brand-soft-foreground"
                          : "text-foreground/75 hover:bg-accent",
                      )}
                    >
                      {libelleDuPays(c)} <span className="opacity-50">{c}</span>
                    </Link>
                  ))}
                </div>
              </>
            )}
          </div>
        </details>
        {/*
          ⛔ UN `<details>` PLUTÔT QU'UN MENU EN JAVASCRIPT. Cette page est un composant serveur et
          tout s'y navigue par liens : un menu d'état aurait demandé un composant client monté pour
          trois liens. Le repli sans JS est gratuit, et le clavier fonctionne tout seul.

          ⛔ LE PANNEAU PORTE SA PROPRE LARGEUR, SON FOND OPAQUE ET SON `z`. Un panneau qui s'ouvre
          hérite sinon de la largeur de son conteneur — c'est exactement ce qui a écrasé le
          calendrier des campagnes le 18/09/2026. Et pas de `max-w-full` : posé ici, il rendrait la
          main au conteneur et annulerait la largeur qu'on vient de fixer.
        */}
        <details className="relative">
          <summary className="inline-flex cursor-pointer list-none items-center gap-2 rounded-[9px] border border-border bg-card px-3 py-[7px] text-[12.5px] font-medium text-foreground/75 transition-colors hover:bg-accent [&::-webkit-details-marker]:hidden">
            <ArrowUpDown className="h-[14px] w-[14px] text-muted-foreground" /> {libelleDuTri(tri)}
          </summary>
          <div className="absolute right-0 z-20 mt-1 w-[180px] rounded-[10px] border border-border bg-card p-1 shadow-md">
            {TRIS_ABONNES.map((t) => (
              <Link
                key={t.cle}
                href={filtreHref({ sort: t.cle })}
                className={cn(
                  "block rounded-[7px] px-2.5 py-[7px] text-[12.5px] transition-colors",
                  t.cle === tri
                    ? "bg-brand-soft font-medium text-brand-soft-foreground"
                    : "text-foreground/75 hover:bg-accent",
                )}
              >
                {t.label}
              </Link>
            ))}
          </div>
        </details>
      </div>

      <SubscribersTable
        rows={rows}
        tags={tags}
        optinNames={optinNames}
        campaignNames={campaignNames}
        variantNames={variantNames}
        baseQuery={baseQuery}
        assetId={asset.id}
        total={total}
        /* ⚠️ Les filtres AFFICHÉS, pas ceux demandés : `creative` retient déjà l'alias `?optin=`, et
           `statut` a déjà écarté une valeur inconnue. « Tout sélectionner » doit demander la
           population que le tableau montre, pas celle que l'URL réclamait. */
        filtre={{ level, campaign, creative, interest, status: statut, pays }}
      />

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <span className="text-[12px] text-muted-foreground/70">
          {total === 0 ? "No subscribers" : `Showing ${fmt(from)}–${fmt(to)} of ${fmt(total)}`}
        </span>
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-muted-foreground">Page {page} of {pageCount}</span>
          {page > 1 ? (
            <Link href={pageHref(page - 1)} className="inline-flex items-center gap-1 rounded-[9px] border border-border bg-card px-3 py-[7px] text-[12.5px] font-medium text-foreground/75 transition-colors hover:bg-accent">
              <ChevronLeft className="h-[14px] w-[14px]" /> Prev
            </Link>
          ) : (
            <span className="inline-flex cursor-not-allowed items-center gap-1 rounded-[9px] border border-border bg-card px-3 py-[7px] text-[12.5px] font-medium text-muted-foreground/40">
              <ChevronLeft className="h-[14px] w-[14px]" /> Prev
            </span>
          )}
          {page < pageCount ? (
            <Link href={pageHref(page + 1)} className="inline-flex items-center gap-1 rounded-[9px] border border-border bg-card px-3 py-[7px] text-[12.5px] font-medium text-foreground/75 transition-colors hover:bg-accent">
              Next <ChevronRight className="h-[14px] w-[14px]" />
            </Link>
          ) : (
            <span className="inline-flex cursor-not-allowed items-center gap-1 rounded-[9px] border border-border bg-card px-3 py-[7px] text-[12.5px] font-medium text-muted-foreground/40">
              Next <ChevronRight className="h-[14px] w-[14px]" />
            </span>
          )}
        </div>
      </div>

      {detail && (
        <SubscriberDrawer
          detail={detail}
          closeHref={closeHref}
          activite={activite ? { brandName: asset.name, lecture: activite } : null}
        />
      )}
    </div>
  );
}
