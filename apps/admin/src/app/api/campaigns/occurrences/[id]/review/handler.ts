import { NextResponse } from "next/server";
import {
  articlesDeLEdition,
  contexteGele,
  finaliserEdition,
  lireBase,
  lireOverrides,
  revisionEnAttente,
  textesIa,
  validerOverrides,
  type ContexteRelecture,
  type EditionBase,
  type EditionFinale,
  type EditionOverrides,
} from "@nf/edition";
import { hydrate, hydrateText, type MergeVars } from "@nf/render/hydrate";
import { isUuid } from "@/lib/data/templates";
import { jsonError, readJson, type Context, type requireContext } from "@/app/api/builder/_shared";

/**
 * RELIRE UNE ÉDITION AVANT SON ENVOI (0079) — `GET|POST /review`, `POST /review/preview`.
 *
 * ⭐ LA DEMANDE (Alix, 22/09/2026) : « je veux tout pouvoir modifier dans le builder ce que les users
 * vont recevoir sans exception !! ». Pour une édition de série : l'introduction et l'accroche écrites
 * par le modèle, les articles du jour (cacher, corriger titre / extrait / image / lien), le sujet et le
 * preheader — lisibles ET modifiables avant l'envoi, sans validation obligatoire, avec « Reset to AI
 * version ». Ce que personne ne touche part tel que généré.
 *
 * ⛔ CETTE ROUTE N'ÉCRIT QUE L'ÉCART, JAMAIS L'E-MAIL. Elle pose `review_overrides` et incrémente
 * `review_rev` ; c'est le worker (passe `plan`) qui reconstruit l'édition par `finaliserEdition` — la
 * fonction du gel lui-même — et pose `review_applied_rev`. L'aperçu appelle LA MÊME fonction, sur la
 * même base : ce qu'on relit à l'écran est, octet pour octet, le shell que le worker écrira
 * (`handler.test.ts` le prouve en faisant tourner les deux).
 *
 * ⛔ JAMAIS D'ENVOI PÉRIMÉ : tant que la révision n'est pas appliquée, le fan-out saute l'édition, et
 * sa prise `frozen → sending` est gardée par la révision lue. Dans l'autre sens, une édition déjà prise
 * (`sending`) ou partie (`sent`) refuse toute relecture (409), comme une campagne archivée.
 *
 * Module séparé des `route.ts` (qui ne peuvent exporter que leurs méthodes HTTP) : la session et
 * l'horloge sont injectées, pour qu'un banc mesure la route sans cookie, sans base et sans heure qui tourne.
 */

export interface ReviewDeps {
  requireContext: () => ReturnType<typeof requireContext>;
  maintenant: () => Date;
}

type Db = Context["db"];

const COLONNES =
  "id, campaign_id, seq, local_date, scheduled_at, status, subject, preheader, ai_status, ai_reason, " +
  "review_base, review_overrides, review_rev, review_applied_rev, review_error, review_updated_at, review_updated_by, " +
  "campaign:campaign_id(id, name, status, archived_at)";

export interface LigneRelecture {
  id: string;
  campaign_id: string;
  seq: number;
  local_date: string | null;
  scheduled_at: string | null;
  status: string;
  subject: string | null;
  preheader: string | null;
  ai_status: string | null;
  ai_reason: string | null;
  review_base: unknown;
  review_overrides: unknown;
  review_rev: number | null;
  review_applied_rev: number | null;
  review_error: string | null;
  review_updated_at: string | null;
  review_updated_by: string | null;
  campaign: { id: string; name: string | null; status: string | null; archived_at: string | null } | null;
}

/** Message dédié quand 0079 n'est pas encore appliquée — pas un 500 opaque. */
export function migrationRelecture(raw: string): string | null {
  return /review_(base|overrides|rev|applied_rev|error|updated)|schema cache/i.test(raw)
    ? "edition review is not installed yet — migration 0079 has not been applied"
    : null;
}

async function charger(
  db: Db,
  id: string,
  assetId: string,
): Promise<{ ok: true; ligne: LigneRelecture } | { ok: false; res: NextResponse }> {
  if (!isUuid(id)) return { ok: false, res: jsonError("invalid occurrence id", 400) };
  // ⛔ SCOPÉE MARQUE : sans `asset_id`, une marque relirait — et modifierait — l'envoi d'une autre.
  const { data, error } = await db
    .from("campaign_occurrence")
    .select(COLONNES)
    .eq("id", id)
    .eq("asset_id", assetId)
    .maybeSingle();
  if (error) {
    const friendly = migrationRelecture(error.message);
    return { ok: false, res: jsonError(friendly ?? error.message, friendly ? 503 : 500) };
  }
  if (!data) return { ok: false, res: jsonError("edition not found in this brand", 404) };
  return { ok: true, ligne: data as unknown as LigneRelecture };
}

/**
 * Pourquoi cette édition ne se relit PLUS — `null` = elle se relit.
 *
 * ⛔ `sending` ET `sent` : la file est écrite, les messages partent ou sont partis. Accepter une
 * relecture ferait croire qu'on a corrigé un envoi que rien ne peut plus corriger. ⛔ Archivée : la
 * campagne est rangée et arrêtée (0077) ; on la réactive d'abord, on relit ensuite.
 */
export function refusDeRelecture(l: LigneRelecture): string | null {
  if (l.campaign?.archived_at) return "this campaign is archived — reactivate it before reviewing its editions";
  switch (l.status) {
    case "planned":
      return null;
    case "frozen":
      return lireBase(l.review_base)
        ? null
        : "this edition was frozen before edition review existed — it cannot be edited (cancel it if it must not go out)";
    case "sending":
      return "this edition is being sent right now — it can no longer be changed";
    case "sent":
      return "this edition has already been sent — it cannot be changed";
    case "held":
      return "this edition is held — nothing will go out, so there is nothing to review";
    case "cancelled":
      return "this edition is cancelled — nothing will go out";
    default:
      return `a ${l.status} edition cannot be reviewed`;
  }
}

/** Le contexte de validation : gelée = tout vient de sa base ; planifiée = sujet et preheader seulement. */
function contexte(l: LigneRelecture): ContexteRelecture {
  if (l.status === "frozen") return contexteGele(lireBase(l.review_base));
  return { etat: "planned", base: null, sujetDeBase: l.subject ?? "", preheaderDeBase: l.preheader ?? null };
}

/** JSON à clés triées : deux écarts égaux s'écrivent pareil, quel que soit l'ordre de leurs clés. */
function canon(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/* ------------------------------------------------------------------ *
 * GET — ce que l'écran de relecture affiche
 * ------------------------------------------------------------------ */

export function vueRelecture(l: LigneRelecture) {
  const base = lireBase(l.review_base);
  const refus = refusDeRelecture(l);
  return {
    id: l.id,
    seq: l.seq,
    localDate: l.local_date,
    scheduledAt: l.scheduled_at,
    status: l.status,
    campaign: { id: l.campaign?.id ?? l.campaign_id, name: l.campaign?.name ?? null, archived: Boolean(l.campaign?.archived_at) },
    editable: refus === null,
    lockedReason: refus,
    /** `planned` : sujet et preheader seulement ; `frozen` : tout. */
    stage: l.status === "frozen" ? ("frozen" as const) : ("planned" as const),
    rev: l.review_rev ?? 0,
    appliedRev: l.review_applied_rev ?? 0,
    /** Même définition que le fan-out (`@nf/edition`) : l'écran dit « pending » exactement quand il saute. */
    pending: revisionEnAttente(l.review_rev, l.review_applied_rev),
    error: l.review_error,
    updatedAt: l.review_updated_at,
    updatedBy: l.review_updated_by,
    aiStatus: l.ai_status,
    aiReason: l.ai_reason,
    /** Les valeurs D'AVANT relecture — celles que « reset » rétablit. */
    base: base
      ? {
          subject: base.subject,
          preheader: base.preheader,
          ai: base.ai,
          aiIntro: base.ai_intro,
          aiPreheader: base.ai_preheader,
          articles: articlesDeLEdition(base.doc),
        }
      : {
          subject: l.subject ?? "",
          preheader: l.preheader,
          ai: false,
          aiIntro: null,
          aiPreheader: null,
          articles: [],
        },
    overrides: lireOverrides(l.review_overrides),
  };
}

export async function getReview(_req: Request, { params }: { params: Promise<{ id: string }> }, deps: ReviewDeps) {
  const c = await deps.requireContext();
  if (!c.ok) return c.res;
  const { id } = await params;
  const lu = await charger(c.ctx.db, id, c.ctx.asset.id);
  if (!lu.ok) return lu.res;
  return NextResponse.json(vueRelecture(lu.ligne));
}

/* ------------------------------------------------------------------ *
 * POST — enregistrer une relecture
 * ------------------------------------------------------------------ */

const CHAMPS = ["subject", "preheader", "ai_intro", "ai_preheader"] as const;

/** Ce qu'un enregistrement change, en NOMS de champs — l'audit ne recopie aucun texte. */
export function changementsDeRelecture(avant: EditionOverrides | null, apres: EditionOverrides | null) {
  const changed: string[] = [];
  const reset: string[] = [];
  for (const k of CHAMPS) {
    const a = avant?.[k];
    const b = apres?.[k];
    if (canon(a) === canon(b)) continue;
    changed.push(k);
    if (a !== undefined && b === undefined) reset.push(k);
  }
  const articlesAvant = avant?.articles ?? {};
  const articlesApres = apres?.articles ?? {};
  const ids = new Set([...Object.keys(articlesAvant), ...Object.keys(articlesApres)]);
  const articlesTouches = [...ids].filter((id) => canon(articlesAvant[id]) !== canon(articlesApres[id]));
  if (articlesTouches.length > 0) changed.push("articles");
  const valeurs = Object.values(articlesApres);
  return {
    changed,
    reset,
    articles_changed: articlesTouches.length,
    articles_hidden: valeurs.filter((a) => a.hidden === true).length,
    articles_edited: valeurs.filter((a) => Object.keys(a).some((k) => k !== "hidden")).length,
  };
}

/**
 * La trace d'une relecture. ⛔ AUCUNE donnée d'abonné dans `meta` : la campagne, l'édition, la
 * révision et les NOMS des champs touchés — pas même le texte relu (il est dans l'occurrence).
 *
 * ⚠️ Un audit raté ne défait PAS la relecture (même règle que l'archivage) : elle EST enregistrée, le
 * dire autrement mentirait. La réponse porte `audited: false`.
 */
async function journaliser(
  db: Db,
  ctx: Context,
  l: LigneRelecture,
  rev: number,
  changements: ReturnType<typeof changementsDeRelecture>,
): Promise<boolean> {
  const { error } = await db.from("audit_log").insert({
    actor: `admin:${ctx.user.email}`,
    action: "edition-reviewed",
    target_type: "campaign_occurrence",
    target_id: l.id,
    asset_id: ctx.asset.id,
    meta: {
      campaign_id: l.campaign_id,
      campaign_name: l.campaign?.name ?? null,
      seq: l.seq,
      local_date: l.local_date,
      stage: l.status,
      rev,
      ...changements,
    },
  });
  if (error) console.error(JSON.stringify({ event: "edition-reviewed-audit-failed", message: error.message }));
  return !error;
}

export async function postReview(req: Request, { params }: { params: Promise<{ id: string }> }, deps: ReviewDeps) {
  const c = await deps.requireContext();
  if (!c.ok) return c.res;
  const { db, asset, user } = c.ctx;
  const { id } = await params;
  const lu = await charger(db, id, asset.id);
  if (!lu.ok) return lu.res;
  const l = lu.ligne;

  const refus = refusDeRelecture(l);
  if (refus) return jsonError(refus, 409, { status: l.status });

  const body = await readJson<{ overrides?: unknown; rev?: unknown }>(req);
  if (!body || typeof body !== "object") return jsonError("invalid JSON body", 400);

  /*
   * ⛔ LA RÉVISION LUE PAR L'ÉCRAN. Deux onglets ouverts sur la même édition : le second enregistrement
   * écraserait le premier sans que personne ne le voie. On refuse, et l'écran recharge.
   */
  const revLue = l.review_rev ?? 0;
  if (body.rev !== revLue) {
    return jsonError(
      "this edition was reviewed by someone else since you opened it — reload it to see their changes",
      409,
      { rev: revLue },
    );
  }

  const v = validerOverrides(body.overrides ?? null, contexte(l));
  if (!v.ok) return jsonError(v.erreur, 422);

  /*
   * ⛔ ESSAYÉE AVANT D'ÊTRE ENREGISTRÉE, PAR LA FONCTION DU WORKER. Une relecture que le worker ne
   * saurait pas reconstruire (recompilation en échec) resterait en attente, et le fan-out sauterait
   * l'édition jusqu'à ce qu'un humain s'en aperçoive. Refusée ici, elle l'est à l'écran, tout de suite.
   */
  const base = lireBase(l.review_base);
  if (l.status === "frozen" && base) {
    const essai = await finaliserEdition(base, v.overrides);
    if (!essai.ok) return jsonError(essai.raison, 422);
  }

  const avant = lireOverrides(l.review_overrides);
  if (canon(avant) === canon(v.overrides)) {
    return NextResponse.json({ ok: true, unchanged: true, rev: revLue, overrides: v.overrides });
  }

  /*
   * ⛔ GARDÉE PAR LE STATUT LU ET LA RÉVISION LUE, ET RELUE. Entre la lecture et cette écriture, le
   * fan-out a pu prendre l'édition (`frozen` → `sending`), le gel a pu la figer (`planned` → `frozen`),
   * un autre onglet a pu enregistrer : l'écriture ne touche alors aucune ligne — et un UPDATE qui ne
   * touche rien RÉUSSIT en silence, d'où le `.select()`.
   */
  const maintenant = deps.maintenant().toISOString();
  const rev = revLue + 1;
  const { data: touchees, error } = await db
    .from("campaign_occurrence")
    .update({
      review_overrides: v.overrides,
      review_rev: rev,
      review_updated_at: maintenant,
      review_updated_by: user.email,
      // L'erreur d'une révision précédente ne dit plus rien de celle-ci.
      review_error: null,
      updated_at: maintenant,
    })
    .eq("id", id)
    .eq("asset_id", asset.id)
    .eq("status", l.status)
    .eq("review_rev", revLue)
    .select("id");
  if (error) {
    const friendly = migrationRelecture(error.message);
    return jsonError(friendly ?? `the review could not be saved: ${error.message}`, friendly ? 503 : 500);
  }
  if (!touchees || (touchees as unknown[]).length === 0) {
    return jsonError(
      "this edition changed while you were editing it (it may have been frozen, or started sending) — reload it and check its state",
      409,
    );
  }

  const audited = await journaliser(db, c.ctx, l, rev, changementsDeRelecture(avant, v.overrides));

  return NextResponse.json({
    ok: true,
    rev,
    overrides: v.overrides,
    /**
     * Ce qui se passe ensuite, en toutes lettres. Gelée : le worker reconstruit à sa prochaine passe,
     * et d'ici là l'édition ne part pas. Planifiée : l'écart s'applique au gel.
     */
    next:
      l.status === "frozen"
        ? "saved — the edition is rebuilt with your changes within a few minutes; until then it is not sent"
        : "saved — your changes apply when the edition is frozen, shortly before the send",
    audited,
  });
}

/* ------------------------------------------------------------------ *
 * POST /preview — l'e-mail recompilé, AVANT ou APRÈS enregistrement
 * ------------------------------------------------------------------ */

const FOOTER_SIMULE_TEXTE = "[Preview] The legal footer is built for each recipient at send time.";
const FOOTER_SIMULE_HTML =
  '<div style="font:12px/1.5 Arial,Helvetica,sans-serif;color:#6B6B76;padding:8px 0;">' + FOOTER_SIMULE_TEXTE + "</div>";

/** La date de l'édition, écrite comme un lecteur la lirait (valeur d'exemple, voir le bandeau). */
function dateLisible(localDate: string | null, doc: unknown): string {
  if (!localDate) return "";
  const locale = (doc as { meta?: { locale?: unknown } } | null)?.meta?.locale;
  try {
    return new Intl.DateTimeFormat(typeof locale === "string" ? locale : "en", { dateStyle: "long", timeZone: "UTC" }).format(
      new Date(`${localDate}T12:00:00Z`),
    );
  } catch {
    return localDate;
  }
}

/**
 * Les variables d'un destinataire d'EXEMPLE. ⚠️ Seuls les textes de l'édition sont vrais (intro,
 * accroche, article de tête, numéro) ; le prénom, l'adresse (non délivrable, RFC 2606) et le pied légal
 * sont simulés — le pied est construit par destinataire à l'envoi.
 */
function varsDApercu(
  l: LigneRelecture,
  base: EditionBase,
  e: EditionFinale,
  ia: { ai_intro: string | null; ai_preheader: string | null } | null,
): MergeVars {
  return {
    is_gdpr: "1",
    is_lgpd: "",
    is_can_spam: "",
    first_name: "Alex",
    has_first_name: "1",
    email: "preview@example.com",
    campaign_name: base.campaign_name,
    edition_number: String(l.seq),
    edition_date: dateLisible(l.local_date, base.doc),
    first_article: e.first_article_title ?? "",
    article_count: String(e.article_count),
    ai_intro: ia?.ai_intro ?? "",
    ai_preheader: ia?.ai_preheader ?? "",
    legal_footer_html: FOOTER_SIMULE_HTML,
    legal_footer_text: FOOTER_SIMULE_TEXTE,
  };
}

export async function postReviewPreview(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
  deps: ReviewDeps,
) {
  const c = await deps.requireContext();
  if (!c.ok) return c.res;
  const { id } = await params;
  const lu = await charger(c.ctx.db, id, c.ctx.asset.id);
  if (!lu.ok) return lu.res;
  const l = lu.ligne;

  const base = lireBase(l.review_base);
  if (!base) {
    return jsonError(
      l.status === "planned"
        ? "this edition is not frozen yet — its articles and AI text are picked at freeze, shortly before the send, so there is nothing to preview yet"
        : "this edition was frozen before edition review existed — there is no base to preview it from",
      409,
    );
  }

  // Sans corps : l'écart ENREGISTRÉ. Avec `overrides` : le brouillon de l'écran, pas encore enregistré.
  const body = await readJson<{ overrides?: unknown }>(req);
  const brut = body && typeof body === "object" && "overrides" in body ? body.overrides : l.review_overrides;
  const v = validerOverrides(brut ?? null, contexteGele(base));
  if (!v.ok) return jsonError(v.erreur, 422);

  const fin = await finaliserEdition(base, v.overrides);
  if (!fin.ok) return jsonError(fin.raison, 422);

  const ia = textesIa(base, v.overrides);
  const vars = varsDApercu(l, base, fin.edition, ia);
  return NextResponse.json({
    /** Ce que verrait un destinataire d'exemple. */
    html: hydrate(fin.edition.html_shell, vars),
    /** Le shell EXACT que le worker écrira pour ce même écart (avant hydratation par destinataire). */
    shell: fin.edition.html_shell,
    subject: fin.edition.subject,
    subjectRendered: hydrateText(fin.edition.subject, vars),
    preheader: fin.edition.preheader,
    articleCount: fin.edition.article_count,
    sizeBytes: fin.edition.size_bytes,
    recompiled: fin.recompilee,
    warnings: fin.warnings,
  });
}
