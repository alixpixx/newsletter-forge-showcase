import { NextResponse } from "next/server";
import { listEditionLegalFooters } from "@/lib/data/asset-editions";
import {
  colonneAbsente,
  modeSuiviAbsent,
  validerLangue,
  validerMarche,
  validerModeSuivi,
  validerNomExpediteur,
  validerNomMarque,
  validerRegime,
  validerReplyTo,
  type ModeSuivi,
} from "@/lib/data/brand-settings";
import { isUuid } from "@/lib/data/templates";
import { jsonError, readJson, type requireContext } from "@/app/api/builder/_shared";

/*
 * Module séparé de `route.ts` : la session y est injectée, pour qu'un banc mesure la route sans
 * cookie — et surtout, qu'il prouve le refus d'un `member` (voir `handler.test.ts`).
 */
export type Garde = () => ReturnType<typeof requireContext>;

type PatchEdition = {
  language?: string;
  market?: string;
  compliance_regime?: string;
  from_name?: string | null;
  reply_to?: string | null;
};

/** Le message de la 503 quand 0092 n'est pas appliquée — nommé, pas un 500 opaque. */
const SANS_0092 =
  "Open & click tracking settings need database migration 0092, which is not applied yet. Run migration 0092 first.";

/**
 * PATCH /api/brands/[id] — nom de la marque, suivi des ouvertures/clics, et par édition : langue,
 * marché, régime, expéditeur.
 * Corps : `{ name?, trackingMode?: "all" | "consent", editions?: [{ id, language?, market?,
 * compliance_regime?, from_name?, reply_to? }], confirmComplianceChange? }`.
 *
 * ⛔ LE SUIVI EST TRACÉ (`audit_log`, action `brand.tracking_mode`, `meta: { from, to }`). Passer une
 * marque de `consent` à `all` pose un pixel chez des gens qui n'ont rien accepté — un geste à risque
 * juridique au Royaume-Uni et dans l'UE : on doit pouvoir dire qui l'a fait et quand. La valeur
 * courante est lue AVANT : identique ⇒ ni écriture ni trace (`changed: false`). Une trace ratée ne
 * défait pas le geste (même règle que l'archivage) : la réponse porte `audited: false`.
 *
 * ⛔ SUPER_ADMIN SEULEMENT, ET LE CONTRÔLE EST ICI, PAS SEULEMENT DANS LE PROXY. Le proxy réserve
 * `/settings` au super_admin, mais `/api/brands/…` n'est pas `/settings` : une garde qui n'existerait
 * qu'au niveau de la page laisserait n'importe quel membre renommer une marque, ou basculer son régime
 * légal, par un simple appel. Ces réglages décident de ce que CHAQUE abonné de la marque reçoit.
 *
 * ⛔ LIMITÉE À LA MARQUE DU CHEMIN. Une édition d'une autre marque glissée dans le corps n'est pas
 * modifiée : chaque identifiant est vérifié contre les éditions de CETTE marque avant toute écriture,
 * et chaque écriture porte en plus `asset_id` dans son filtre.
 *
 * ⛔ LE RÉGIME ET LE MARCHÉ EXIGENT UNE CONFIRMATION EXPLICITE (`confirmComplianceChange`). Ils
 * décident des mentions obligatoires du pied légal : passer une édition en CAN-SPAM exige une adresse
 * postale, et sans elle ses e-mails s'arrêtent (`footer_incomplete`). La réponse rend donc, après
 * l'écriture, ce qui manque désormais — pour que l'écran le dise avant que le premier envoi bute.
 *
 * ⛔ TOUT EST VALIDÉ AVANT LA PREMIÈRE ÉCRITURE. PostgREST n'offre pas de transaction : une erreur de
 * saisie découverte à la troisième édition laisserait les deux premières modifiées.
 */
export async function modifierMarque(req: Request, assetId: string, garde: Garde): Promise<NextResponse> {
  const c = await garde();
  if (!c.ok) return c.res;
  const { db, user } = c.ctx;
  if (!user.isSuperAdmin) return jsonError("Only administrators can change brand settings.", 403);

  if (!isUuid(assetId)) return jsonError("not found", 404);

  const body = await readJson<{
    name?: unknown;
    trackingMode?: unknown;
    editions?: unknown;
    confirmComplianceChange?: unknown;
  }>(req);
  if (!body || typeof body !== "object" || Array.isArray(body)) return jsonError("invalid JSON body", 400);

  /* ------------------------------------------------ Validation, sans rien écrire */
  let nom: string | undefined;
  if (body.name !== undefined) {
    const v = validerNomMarque(body.name);
    if (!v.ok) return jsonError(v.error, 422);
    nom = v.value;
  }

  let mode: ModeSuivi | undefined;
  if (body.trackingMode !== undefined) {
    const v = validerModeSuivi(body.trackingMode);
    if (!v.ok) return jsonError(v.error, 400);
    mode = v.value;
  }

  const patches: { id: string; patch: PatchEdition }[] = [];
  let toucheConformite = false;
  if (body.editions !== undefined) {
    if (!Array.isArray(body.editions) || body.editions.length > 20) return jsonError("editions must be a list", 400);
    for (const brut of body.editions) {
      const e = (brut ?? {}) as Record<string, unknown>;
      if (typeof e.id !== "string" || !isUuid(e.id)) return jsonError("edition not found", 404);
      const patch: PatchEdition = {};
      if (e.language !== undefined) {
        const v = validerLangue(e.language);
        if (!v.ok) return jsonError(v.error, 422);
        patch.language = v.value;
      }
      if (e.market !== undefined) {
        const v = validerMarche(e.market);
        if (!v.ok) return jsonError(v.error, 422);
        patch.market = v.value;
        toucheConformite = true;
      }
      if (e.compliance_regime !== undefined) {
        const v = validerRegime(e.compliance_regime);
        if (!v.ok) return jsonError(v.error, 422);
        patch.compliance_regime = v.value;
        toucheConformite = true;
      }
      if (e.from_name !== undefined) {
        const v = validerNomExpediteur(e.from_name);
        if (!v.ok) return jsonError(v.error, 422);
        patch.from_name = v.value;
      }
      if (e.reply_to !== undefined) {
        const v = validerReplyTo(e.reply_to);
        if (!v.ok) return jsonError(v.error, 422);
        patch.reply_to = v.value;
      }
      if (Object.keys(patch).length > 0) patches.push({ id: e.id, patch });
    }
  }
  if (toucheConformite && body.confirmComplianceChange !== true) {
    return jsonError(
      "Changing a market or compliance regime changes the legal mentions every email must carry. Confirm the change to apply it.",
      409,
      { kind: "confirm_compliance" },
    );
  }
  if (nom === undefined && patches.length === 0 && mode === undefined) return jsonError("nothing to change", 400);

  /* ------------------------------------------------ La marque et SES éditions */
  // `tracking_mode` n'est lu que s'il est demandé : sans 0092, le reste des réglages doit continuer
  // de s'enregistrer comme avant.
  const a = await db
    .from("asset")
    .select(mode !== undefined ? "id, name, tracking_mode" : "id, name")
    .eq("id", assetId)
    .maybeSingle();
  if (a.error && mode !== undefined && modeSuiviAbsent(a.error)) return jsonError(SANS_0092, 503, { kind: "migration_0092" });
  if (a.error) return jsonError("could not read the brand — try again", 503);
  if (!a.data) return jsonError("not found", 404);
  // ⛔ Lu AVANT toute écriture : c'est le `from` de la trace, et l'égalité qui dispense d'écrire.
  const modeAvant = (a.data as { tracking_mode?: unknown }).tracking_mode;
  const suiviChange = mode !== undefined && modeAvant !== mode;

  if (patches.length > 0) {
    const e = await db.from("asset_edition").select("id").eq("asset_id", assetId);
    if (e.error) return jsonError("could not read the brand's editions — try again", 503);
    const siennes = new Set((((e.data as unknown[]) ?? []) as { id?: unknown }[]).map((r) => String(r.id)));
    const etrangere = patches.find((p) => !siennes.has(p.id));
    if (etrangere) return jsonError("edition not found for this brand", 404);
  }

  /* ------------------------------------------------ Écritures */
  if (nom !== undefined) {
    const { error } = await db.from("asset").update({ name: nom }).eq("id", assetId);
    if (error) return jsonError(`could not rename the brand: ${error.message}`, 500);
  }

  for (const p of patches) {
    const { data, error } = await db
      .from("asset_edition")
      .update(p.patch)
      .eq("id", p.id)
      .eq("asset_id", assetId)
      .select("id");
    if (error) {
      const deja = nom !== undefined || patches.indexOf(p) > 0 ? " Earlier changes in this save were applied — reload the page." : "";
      if (colonneAbsente(error)) {
        return jsonError(
          `The sender name and reply-to need database migration 0078, which is not applied yet. Save without them, or ask for the migration.${deja}`,
          409,
          { kind: "migration_0078" },
        );
      }
      if ((error as { code?: unknown }).code === "23505") {
        return jsonError(`Another edition of this brand already uses this market and language.${deja}`, 409);
      }
      if ((error as { code?: unknown }).code === "23514") {
        return jsonError(`The database refused a value: ${error.message}.${deja}`, 422);
      }
      return jsonError(`could not save the edition: ${error.message}.${deja}`, 500);
    }
    // Un `update` qui ne touche aucune ligne ne lève pas : sans ce contrôle, on répondrait « saved ».
    if (!Array.isArray(data) || data.length === 0) return jsonError("edition not found for this brand", 404);
  }

  /* ------------------------------------------------ Le suivi des ouvertures et des clics */
  let suivi: { from: string | null; to: ModeSuivi; changed: boolean; audited?: boolean } | undefined;
  if (mode !== undefined) {
    const from = typeof modeAvant === "string" ? modeAvant : null;
    if (!suiviChange) {
      // Identique : ni écriture, ni trace. Une trace « all → all » ne dirait rien et noierait les vraies.
      suivi = { from, to: mode, changed: false };
    } else {
      const deja = nom !== undefined || patches.length > 0 ? " Earlier changes in this save were applied — reload the page." : "";
      const { data, error } = await db.from("asset").update({ tracking_mode: mode }).eq("id", assetId).select("id");
      if (error) {
        if (modeSuiviAbsent(error)) return jsonError(`${SANS_0092}${deja}`, 503, { kind: "migration_0092" });
        if ((error as { code?: unknown }).code === "23514") {
          return jsonError(`The database refused a value: ${error.message}.${deja}`, 422);
        }
        return jsonError(`could not change tracking: ${error.message}.${deja}`, 500);
      }
      if (!Array.isArray(data) || data.length === 0) return jsonError("not found", 404);

      // ⛔ AUCUNE donnée d'abonné dans `meta` : l'ancien et le nouveau mode, rien d'autre.
      const trace = await db.from("audit_log").insert({
        actor: `admin:${user.email}`,
        action: "brand.tracking_mode",
        target_type: "asset",
        target_id: assetId,
        asset_id: assetId,
        meta: { from, to: mode },
      });
      if (trace.error) {
        console.error(JSON.stringify({ event: "brand.tracking_mode-audit-failed", message: trace.error.message }));
      }
      suivi = { from, to: mode, changed: true, audited: !trace.error };
    }
  }

  /* ------------------------------------------------ Ce qui manque DÉSORMAIS */
  const nomFinal = nom ?? String((a.data as { name?: unknown }).name ?? "");
  const pieds = await listEditionLegalFooters(db as never, assetId, nomFinal);
  return NextResponse.json({
    ok: true,
    // `null` = on n'a pas pu relire : l'écran ne doit PAS en conclure que rien ne manque.
    missing: pieds.known ? pieds.value.map((p) => ({ id: p.id, missing: p.missing })) : null,
    ...(suivi ? { trackingMode: suivi } : {}),
  });
}
