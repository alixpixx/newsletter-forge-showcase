import { NextResponse } from "next/server";
import {
  TRIGGERS,
  validateAutomation,
  type AutomationRecord,
  type AutomationStatus,
  type ValidAutomation,
} from "@nf/automations";
import { jsonError, readJson, type Context, type requireContext } from "@/app/api/builder/_shared";
import type { findPublishedVersionRef } from "@/lib/data/campaigns";
import {
  NOT_INSTALLED,
  countAllSends,
  countSends,
  estAbsente,
  findAutomation,
  toRecord,
  type AutomationRow,
} from "@/lib/data/automations";
import {
  auditAction,
  columnsOf,
  decideTransition,
  isAutomationStatus,
  isCreatableTrigger,
  recordFromBody,
  simulationRan,
} from "@/lib/automations";

/**
 * AUTOMATIONS SUR MESURE — créer, modifier, changer d'état (plan, étapes 10 et 13).
 *
 *   POST   /api/automations               → crée une automation, TOUJOURS `draft`
 *   PUT    /api/automations/[id]          → la modifie, SEULEMENT en `draft`
 *   POST   /api/automations/[id]/status   → `{ to, confirmName? }` : simuler, armer, mettre en pause,
 *                                            reprendre, revenir au brouillon
 *   POST   /api/automations/[id]/duplicate → la copie, `draft`, « Copy of … », SANS son historique
 *   DELETE /api/automations/[id]          → la supprime, SEULEMENT `draft`/`paused` et JAMAIS sélectionnée
 *
 * ⛔ CE MODULE N'ÉCRIT JAMAIS DANS `email_outbox`, NI DANS `automation_send`. Il écrit la ligne
 * `automation` (et `audit_log`). C'est le worker qui exécute, par `automation_due` (0082), et
 * seulement ce qui est `simulation` ou `live` : une automation créée ici ne fait rien tant qu'on ne
 * l'a pas simulée, et n'envoie rien tant qu'un super_admin ne l'a pas armée.
 *
 * ⛔ LA VALIDATION EST CELLE DU WORKER (`validateAutomation`, `@nf/automations`) : ce que l'écran
 * accepte, le moteur l'exécute ; ce qu'il refuserait, l'écran le refuse au clic, avec la même phrase.
 *
 * Module séparé des `route.ts` (qui ne peuvent exporter que leurs méthodes HTTP) : la session, la
 * vérification des modèles (qui lit les cookies pour l'octroi) et l'horloge sont injectées, pour
 * qu'un banc mesure les routes sans cookie, sans base et sans heure qui tourne.
 */

export interface AutomationDeps {
  requireContext: () => ReturnType<typeof requireContext>;
  /** `findPublishedVersionRef` en production : version PUBLIÉE, de CETTE marque, que la personne peut ouvrir. */
  versionPubliee: typeof findPublishedVersionRef;
  maintenant: () => Date;
}

type Db = Context["db"];

/** Une panne d'écriture : 503 nommé si 0082 manque, sinon 500 avec le message. */
function panne(error: { code?: string | null; message?: string | null }, quoi: string) {
  if (estAbsente(error)) return jsonError(NOT_INSTALLED, 503);
  return jsonError(`${quoi}: ${error.message ?? "unknown error"}`, 500);
}

/**
 * ⛔ Chaque étape qui envoie cite une version PUBLIÉE d'un modèle de CETTE marque que la personne
 * peut ouvrir. `validateAutomation` ne vérifie que la FORME (un uuid) : sans ce contrôle, un uuid
 * d'une autre marque — ou d'un modèle non octroyé — serait accepté, et le moteur le refuserait en
 * silence (`template_unusable`) au moment d'envoyer.
 */
async function modelesInvalides(db: Db, v: ValidAutomation, assetId: string, deps: AutomationDeps): Promise<string[]> {
  const erreurs: string[] = [];
  for (const [i, s] of v.steps.entries()) {
    if (!s.template_version_id) continue;
    const ref = await deps.versionPubliee(db, s.template_version_id, assetId);
    if (!ref) erreurs.push(`step ${i + 1}: this template version is not a published template of this brand that you can open`);
  }
  return erreurs;
}

/* ------------------------------------------------------------------ *
 * Créer
 * ------------------------------------------------------------------ */

export async function postCreate(req: Request, deps: AutomationDeps) {
  const c = await deps.requireContext();
  if (!c.ok) return c.res;

  const body = await readJson<Record<string, unknown>>(req);
  const rec = recordFromBody(body, c.ctx.asset.id, "draft");
  if (!rec) return jsonError("a JSON body is required", 400);
  return insererBrouillon(c.ctx, rec, deps);
}

/**
 * ⛔ LE SEUL CHEMIN QUI CRÉE UNE LIGNE `automation` — la création et la copie (`postDuplicate`) passent
 * par ici : même garde du déclencheur, même validation que le worker, même contrôle des versions de
 * modèle, et la ligne naît `draft`, dans la marque de la session, signée par la personne connectée.
 * Une copie ne peut donc pas faire entrer ce que le formulaire refuserait.
 */
async function insererBrouillon(ctx: Context, rec: AutomationRecord, deps: AutomationDeps) {
  const { db, asset, user } = ctx;

  // ⛔ La règle système (rebonds mous) se lit dans la liste « System » : elle ne se crée pas.
  if (!isCreatableTrigger(rec.trigger)) {
    return jsonError(
      rec.trigger in TRIGGERS ? `${TRIGGERS[rec.trigger as keyof typeof TRIGGERS].label} is a system rule: it is not created here` : `unknown trigger: ${rec.trigger}`,
      422,
    );
  }

  const v = validateAutomation(rec);
  if (!v.ok) return jsonError("this automation is not valid", 422, { errors: v.errors });
  const modeles = await modelesInvalides(db, v.automation, asset.id, deps);
  if (modeles.length > 0) return jsonError("this automation is not valid", 422, { errors: modeles });

  const maintenant = deps.maintenant().toISOString();
  const { data, error } = await db
    .from("automation")
    .insert({
      asset_id: asset.id,
      ...columnsOf(v.automation),
      // ⛔ NAÎT `draft`, quoi que dise le corps : `recordFromBody` ne lit pas de statut.
      status: "draft",
      created_by: user.email,
      updated_by: user.email,
      status_changed_at: maintenant,
      updated_at: maintenant,
    })
    .select("id")
    .single();
  if (error) return panne(error, "the automation could not be created");
  return NextResponse.json({ ok: true, id: String((data as { id?: unknown } | null)?.id ?? "") }, { status: 201 });
}

/* ------------------------------------------------------------------ *
 * Modifier
 * ------------------------------------------------------------------ */

/**
 * La ligne, scopée sur la marque. `illisible` = le code d'une lecture en panne : 500 pour les routes
 * d'origine, 503 pour la copie et la suppression (leur contrat avec l'écran).
 */
async function charger(
  db: Db,
  id: string,
  assetId: string,
  illisible: 500 | 503 = 500,
): Promise<{ ok: true; a: AutomationRow } | { ok: false; res: NextResponse }> {
  const lue = await findAutomation(db, id, assetId);
  if (lue.state === "not-installed") return { ok: false, res: jsonError(NOT_INSTALLED, 503) };
  if (lue.state === "error") return { ok: false, res: jsonError(`the automation could not be read: ${lue.message}`, illisible) };
  // Une automation d'une autre marque est indiscernable d'une automation inexistante : 404.
  if (!lue.value) return { ok: false, res: jsonError("automation not found", 404) };
  return { ok: true, a: lue.value };
}

export async function putUpdate(req: Request, { params }: { params: Promise<{ id: string }> }, deps: AutomationDeps) {
  const c = await deps.requireContext();
  if (!c.ok) return c.res;
  const { db, asset, user } = c.ctx;
  const { id } = await params;

  const lue = await charger(db, id, asset.id);
  if (!lue.ok) return lue.res;
  const a = lue.a;

  // ⛔ ON NE MODIFIE QU'UN BROUILLON. Une automation en simulation ou armée se ramène d'abord au
  // brouillon (ce qui l'arrête) : on ne change pas les règles d'un moteur qui tourne.
  if (a.status !== "draft") {
    return jsonError("only a draft can be edited: move this automation back to draft first (that stops it)", 409, {
      status: a.status,
    });
  }

  const body = await readJson<Record<string, unknown>>(req);
  const rec = recordFromBody(body, asset.id, "draft");
  if (!rec) return jsonError("a JSON body is required", 400);
  /*
   * ⭐ LE DÉCLENCHEUR CHANGE — sur un brouillon qui n'a JAMAIS sélectionné personne (Alix, 24/09 : « je
   * veux pouvoir modifier leurs automations »). ⛔ Dès qu'il existe une ligne `automation_send`, simulée
   * ou réelle, il ne change plus : cet historique (clés de période, anti-doublon, « a reçu » des
   * Segments) n'a de sens que pour SON déclencheur ; un autre déclencheur est une autre automation.
   * Historique illisible ⇒ refus : on ne prend pas « non lu » pour « vide ».
   */
  const changeDeDeclencheur = rec.trigger !== a.trigger;
  if (changeDeDeclencheur) {
    if (!isCreatableTrigger(rec.trigger)) {
      return jsonError(`this trigger cannot be used for an automation: ${rec.trigger}`, 422);
    }
    const n = await countAllSends(db, a.id, asset.id);
    if (n === null) return jsonError("the trigger cannot change right now: this automation's history could not be read", 503);
    if (n > 0) {
      return jsonError(
        "the trigger cannot change: this automation has already selected people (simulated or real). Create a new automation instead",
        409,
        { sends: n },
      );
    }
  }

  const v = validateAutomation(rec);
  if (!v.ok) return jsonError("this automation is not valid", 422, { errors: v.errors });
  const modeles = await modelesInvalides(db, v.automation, asset.id, deps);
  if (modeles.length > 0) return jsonError("this automation is not valid", 422, { errors: modeles });

  // ⚠️ Gardée par le statut lu, et RELUE : entre la lecture et l'écriture, un autre onglet a pu
  // lancer la simulation — un UPDATE qui ne touche rien RÉUSSIT en silence, d'où le `.select()`.
  // Nouveau déclencheur ⇒ curseur d'événements et dernier passage REMIS À ZÉRO : il repart « de
  // maintenant », comme une automation neuve (0082 : un curseur nul se pose à la première passe).
  const { data, error } = await db
    .from("automation")
    .update({
      ...columnsOf(v.automation),
      ...(changeDeDeclencheur ? { event_cursor: null, last_run_at: null } : {}),
      updated_by: user.email,
      updated_at: deps.maintenant().toISOString(),
    })
    .eq("id", a.id)
    .eq("asset_id", asset.id)
    .eq("status", "draft")
    .select("id");
  if (error) return panne(error, "the automation could not be saved");
  if (!data || (data as unknown[]).length === 0) {
    return jsonError("this automation changed while it was being saved (it may have been started): reload the page", 409);
  }
  return NextResponse.json({ ok: true, id: a.id });
}

/* ------------------------------------------------------------------ *
 * Changer d'état (étape 13)
 * ------------------------------------------------------------------ */

/**
 * La trace d'un changement d'état — ou d'une suppression (`to: "deleted"`). ⛔ AUCUNE donnée d'abonné
 * dans `meta` : l'automation, ses réglages de sécurité, les deux statuts.
 */
function ligneAudit(
  ctx: Context,
  a: AutomationRow,
  action: string,
  from: AutomationStatus,
  to: AutomationStatus | "deleted",
  extra: Record<string, unknown> = {},
) {
  return {
    actor: `admin:${ctx.user.email}`,
    action,
    target_type: "automation",
    target_id: a.id,
    asset_id: ctx.asset.id,
    meta: {
      automation_name: a.name,
      trigger: a.trigger,
      from,
      to,
      daily_cap: a.dailyCap,
      window: `${a.windowStartHour}-${a.windowEndHour} ${a.timezone}`,
      steps: Array.isArray(a.steps) ? a.steps.length : 0,
      ...extra,
    },
  };
}

export async function postStatus(req: Request, { params }: { params: Promise<{ id: string }> }, deps: AutomationDeps) {
  const c = await deps.requireContext();
  if (!c.ok) return c.res;
  const { db, asset, user } = c.ctx;
  const { id } = await params;

  const body = await readJson<{ to?: unknown; confirmName?: unknown }>(req);
  if (!body || !isAutomationStatus(body.to)) {
    return jsonError("`to` must be one of draft, simulation, live, paused", 400);
  }
  const to = body.to;

  // ⛔ ARMER = ENVOYER POUR DE VRAI : le refus du membre tombe AVANT toute lecture. Il n'apprend pas
  // si l'automation existe, et rien n'est lu ni écrit en son nom.
  if (to === "live" && !user.isSuperAdmin) {
    return jsonError("only a super admin can switch an automation to live: live sends real emails", 403);
  }

  const lue = await charger(db, id, asset.id);
  if (!lue.ok) return lue.res;
  const a = lue.a;
  const from = a.status;

  // La simulation a-t-elle tourné ? Ne se demande que pour `simulation → live`.
  let ran = false;
  if (from === "simulation" && to === "live") {
    const depuis = a.statusChangedAt ?? a.updatedAt ?? a.createdAt;
    const traces = depuis ? await countSends(db, a.id, asset.id, true, depuis) : null;
    ran = simulationRan(a, traces ?? 0);
  }

  const validation = validateAutomation(toRecord(a, to));
  const decision = decideTransition({
    from,
    to,
    name: a.name,
    isSuperAdmin: user.isSuperAdmin,
    confirmName: typeof body.confirmName === "string" ? body.confirmName : null,
    simulationRan: ran,
    validation,
  });
  if (!decision.ok) {
    return jsonError(decision.error, decision.status, decision.errors ? { errors: decision.errors } : undefined);
  }
  // Simuler ou armer relit aussi les modèles : une version dépubliée depuis la sauvegarde partirait
  // en `template_unusable` à chaque passe, sans que l'écran le dise.
  if ((to === "simulation" || to === "live") && validation.ok) {
    const modeles = await modelesInvalides(db, validation.automation, asset.id, deps);
    if (modeles.length > 0) return jsonError("this automation is not valid", 422, { errors: modeles });
  }

  const maintenant = deps.maintenant().toISOString();
  const action = auditAction(from, to);

  /*
   * ⛔ PASSER `live` : LA LIGNE D'AUDIT D'ABORD, LE STATUT ENSUITE — jamais dans l'autre ordre.
   * Dans l'autre ordre, une panne d'audit laisserait une automation ARMÉE que personne n'a tracée, et
   * la passe suivante du worker enverrait. Ici, pas d'audit = pas d'armement. Si l'écriture du statut
   * échoue après, une seconde ligne dit que l'armement n'a PAS eu lieu (la première reste : c'était
   * une tentative).
   */
  if (to === "live") {
    const { error: auditErr } = await db.from("audit_log").insert(ligneAudit(c.ctx, a, action, from, to));
    if (auditErr) {
      // ⛔ Message affiché à l'écran : pas le mot « arm » (décision d'Alix du 22/09/2026).
      return jsonError(`not switched to live: the audit log could not be written (${auditErr.message ?? "unknown error"})`, 500);
    }
  }

  const patch: Record<string, unknown> = {
    status: to,
    status_changed_at: maintenant,
    updated_by: user.email,
    updated_at: maintenant,
    ...(to === "live" ? { armed_by: user.email, armed_at: maintenant } : {}),
  };
  // ⚠️ Gardée par le statut LU, et relue : deux onglets, un seul changement.
  const { data, error } = await db
    .from("automation")
    .update(patch)
    .eq("id", a.id)
    .eq("asset_id", asset.id)
    .eq("status", from)
    .select("id");

  const rate = !!error || !data || (data as unknown[]).length === 0;
  if (rate && to === "live") {
    await db.from("audit_log").insert(ligneAudit(c.ctx, a, "automation-arm-failed", from, to, { error: error?.message ?? "changed meanwhile" }));
  }
  if (error) return panne(error, "the status could not be changed");
  if (rate) return jsonError("this automation changed meanwhile: reload the page", 409);

  // Les autres transitions ARRÊTENT ou simulent : elles ne se bloquent pas sur un audit raté (une
  // pause doit toujours passer). La réponse dit si la trace est écrite.
  let audited = to === "live";
  if (to !== "live") {
    const { error: auditErr } = await db.from("audit_log").insert(ligneAudit(c.ctx, a, action, from, to));
    if (auditErr) console.error(JSON.stringify({ event: `${action}-audit-failed`, message: auditErr.message }));
    audited = !auditErr;
  }

  return NextResponse.json({ ok: true, id: a.id, from, status: to, audited });
}

/* ------------------------------------------------------------------ *
 * Dupliquer (plan AUTO-EDIT, étape 1)
 * ------------------------------------------------------------------ */

/** `validateAutomation` et 0082 (`char_length(btrim(name)) between 1 and 120`). */
const NOM_MAX = 120;

/**
 * « Copy of <nom> », coupé à 120 caractères : sans cette coupe, copier une automation au nom long
 * rendrait un 422 que la personne ne peut pas corriger (on ne renomme pas une copie qui n'existe pas).
 * Coupé par POINT DE CODE : une moitié d'émoji ne part jamais en base.
 */
function nomDeCopie(nom: string): string {
  const car = Array.from(`Copy of ${nom.trim()}`);
  while (car.join("").length > NOM_MAX) car.pop();
  return car.join("").trimEnd();
}

/**
 * POST /api/automations/[id]/duplicate → 201 `{ id }` (la copie).
 *
 * ⛔ LA COPIE REPART DE ZÉRO : les colonnes ÉDITABLES seulement (celles du formulaire), statut `draft`,
 * et rien de l'historique — ni curseur d'événements, ni dernier passage, ni armement, ni traces
 * `automation_send` (elles restent à la source). Elle passe par `insererBrouillon`, comme une création :
 * revalidée par le worker, versions de modèle revérifiées pour CETTE personne, signée par elle.
 */
export async function postDuplicate(_req: Request, { params }: { params: Promise<{ id: string }> }, deps: AutomationDeps) {
  const c = await deps.requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;
  const { id } = await params;

  const lue = await charger(db, id, asset.id, 503);
  if (!lue.ok) return lue.res;
  const a = lue.a;

  return insererBrouillon(
    c.ctx,
    { ...toRecord(a, "draft"), id: undefined, asset_id: asset.id, name: nomDeCopie(a.name), event_cursor: null },
    deps,
  );
}

/* ------------------------------------------------------------------ *
 * Supprimer (plan AUTO-EDIT, étape 2)
 * ------------------------------------------------------------------ */

const DEJA_SELECTIONNE =
  "this automation has already selected people (simulated or real): it cannot be deleted, its history is the record of what was sent. Keep it paused or in draft instead";

/**
 * DELETE /api/automations/[id] → 200 `{ deleted: true }`.
 *
 * ⛔ SEULEMENT CE QUI NE TOURNE PAS ET N'A JAMAIS RIEN FAIT :
 *  - statut `draft` ou `paused` — une automation en simulation ou live s'arrête d'abord (409) ;
 *  - AUCUNE ligne `automation_send`, simulée ou réelle, depuis toujours — cet historique est la preuve
 *    de ce qui est parti (0082 : clé étrangère SANS cascade, « on ne supprime pas une automation qui a
 *    écrit, on la met en pause »). Historique illisible ⇒ 503 : « non lu » n'est pas « zéro ».
 * ⛔ COMME LE PASSAGE `live` : LA LIGNE D'AUDIT D'ABORD, LA SUPPRESSION ENSUITE. Une suppression est
 * irréversible : pas de trace = pas de suppression ; si la suppression échoue ensuite, une seconde ligne
 * le dit.
 */
export async function deleteAutomation(_req: Request, { params }: { params: Promise<{ id: string }> }, deps: AutomationDeps) {
  const c = await deps.requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;
  const { id } = await params;

  const lue = await charger(db, id, asset.id, 503);
  if (!lue.ok) return lue.res;
  const a = lue.a;

  if (a.status !== "draft" && a.status !== "paused") {
    return jsonError(
      a.status === "live"
        ? "this automation is live: stop it first (pause it or move it back to draft), then delete it"
        : "this automation is simulating: stop it first (move it back to draft), then delete it",
      409,
      { status: a.status },
    );
  }

  const selections = await countAllSends(db, a.id, asset.id);
  if (selections === null) return jsonError("this automation cannot be deleted right now: its history could not be read", 503);
  if (selections > 0) return jsonError(DEJA_SELECTIONNE, 409, { sends: selections });

  const { error: auditErr } = await db
    .from("audit_log")
    .insert(ligneAudit(c.ctx, a, "automation-deleted", a.status, "deleted", { sends: 0 }));
  if (auditErr) return jsonError(`not deleted: the audit log could not be written (${auditErr.message ?? "unknown error"})`, 500);

  // ⚠️ Gardée par le statut LU et la marque, et RELUE : un DELETE qui ne touche rien RÉUSSIT en silence.
  const { data, error } = await db
    .from("automation")
    .delete()
    .eq("id", a.id)
    .eq("asset_id", asset.id)
    .eq("status", a.status)
    .select("id");
  const supprimees = error ? 0 : ((data as unknown[] | null) ?? []).length;
  if (supprimees !== 1) {
    await db.from("audit_log").insert(
      ligneAudit(c.ctx, a, "automation-delete-failed", a.status, "deleted", {
        error: error?.message ?? (supprimees === 0 ? "changed meanwhile" : `${supprimees} rows`),
      }),
    );
  }
  if (error) {
    // ⛔ Le dernier filet est la base : une trace écrite entre le compte et la suppression fait
    // échouer celle-ci sur la clé étrangère (23503) — c'est le même refus que le compte.
    if (error.code === "23503") return jsonError(DEJA_SELECTIONNE, 409);
    return panne(error, "the automation could not be deleted");
  }
  if (supprimees === 0) return jsonError("this automation changed meanwhile (it may have been started): reload the page", 409);
  if (supprimees !== 1) return jsonError(`unexpected: ${supprimees} automations deleted`, 500);
  return NextResponse.json({ ok: true, deleted: true, id: a.id });
}
