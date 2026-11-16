import { requireContext } from "@/app/api/builder/_shared";
import { findPublishedVersionRef } from "@/lib/data/campaigns";
import { deleteAutomation, putUpdate } from "../handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const deps = () => ({ requireContext, versionPubliee: findPublishedVersionRef, maintenant: () => new Date() });

/**
 * PUT /api/automations/[id] — modifie une automation, SEULEMENT en `draft`. Le déclencheur ne change
 * pas. Le contrat est dans `../handler.ts`.
 */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return putUpdate(req, ctx, deps());
}

/**
 * DELETE /api/automations/[id] — seulement `draft`/`paused`, et jamais une automation qui a déjà
 * sélectionné quelqu'un (simulé ou réel). Le contrat est dans `../handler.ts`.
 */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return deleteAutomation(req, ctx, deps());
}
