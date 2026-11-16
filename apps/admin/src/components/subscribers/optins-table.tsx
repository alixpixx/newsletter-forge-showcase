"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2, Tag as TagIcon, AlertTriangle, Check } from "lucide-react";
import type { OptinRow } from "@/lib/data/optins";

/**
 * Le tableau des sous-listes, et les DEUX gestes de tag.
 *
 * ⛔ POURQUOI DEUX GESTES SÉPARÉS (décision d'Alix, 08/09/2026) :
 *  — choisir le tag par défaut n'engage que les contacts À VENIR. C'est un réglage, il s'annule en
 *    changeant d'avis, il ne touche personne.
 *  — l'appliquer aux contacts déjà arrivés change des milliers de lignes et ne s'annule pas d'un
 *    clic. Ce geste-là affiche d'abord COMBIEN de personnes changeraient, puis demande confirmation.
 * Les fondre en un seul contrôle ferait du second un effet de bord du premier.
 */

interface Props {
  rows: OptinRow[];
  tags: { id: number; slug: string; label: string }[];
}

type EtatLigne =
  | { phase: "repos" }
  | { phase: "occupe" }
  | { phase: "confirmer"; affected: number }
  | { phase: "fait"; affected: number }
  | { phase: "erreur"; message: string };

export function OptinsTable({ rows, tags }: Props) {
  const router = useRouter();
  const [etats, setEtats] = useState<Record<string, EtatLigne>>({});
  const etat = (id: string): EtatLigne => etats[id] ?? { phase: "repos" };
  const poser = (id: string, e: EtatLigne) => setEtats((s) => ({ ...s, [id]: e }));

  async function changerTag(optinId: string, valeur: string) {
    poser(optinId, { phase: "occupe" });
    try {
      const res = await fetch(`/api/optins/${optinId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tagId: valeur === "" ? null : Number(valeur) }),
      });
      const d = (await res.json()) as { ok?: boolean; reason?: string };
      if (!res.ok || !d.ok) {
        poser(optinId, { phase: "erreur", message: d.reason ?? `HTTP ${res.status}` });
        return;
      }
      poser(optinId, { phase: "repos" });
      // Les compteurs « tagged » viennent du serveur : on les relit plutôt que de les deviner ici.
      router.refresh();
    } catch (e) {
      poser(optinId, { phase: "erreur", message: e instanceof Error ? e.message : "network" });
    }
  }

  /** Premier temps : COMPTER. Rien n'est écrit tant que la confirmation n'est pas donnée. */
  async function compter(optinId: string) {
    poser(optinId, { phase: "occupe" });
    try {
      const res = await fetch(`/api/optins/${optinId}/apply-tag`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: false }),
      });
      const d = (await res.json()) as { ok?: boolean; affected?: number; reason?: string };
      if (!res.ok || !d.ok) {
        poser(optinId, { phase: "erreur", message: d.reason ?? `HTTP ${res.status}` });
        return;
      }
      poser(optinId, { phase: "confirmer", affected: d.affected ?? 0 });
    } catch (e) {
      poser(optinId, { phase: "erreur", message: e instanceof Error ? e.message : "network" });
    }
  }

  /** Second temps : ÉCRIRE, et seulement après que le nombre a été affiché. */
  async function appliquer(optinId: string) {
    poser(optinId, { phase: "occupe" });
    try {
      const res = await fetch(`/api/optins/${optinId}/apply-tag`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      const d = (await res.json()) as { ok?: boolean; affected?: number; reason?: string };
      if (!res.ok || !d.ok) {
        poser(optinId, { phase: "erreur", message: d.reason ?? `HTTP ${res.status}` });
        return;
      }
      poser(optinId, { phase: "fait", affected: d.affected ?? 0 });
      router.refresh();
    } catch (e) {
      poser(optinId, { phase: "erreur", message: e instanceof Error ? e.message : "network" });
    }
  }

  const fmt = (n: number) => n.toLocaleString("en-US");

  return (
    <div className="overflow-hidden rounded-[14px] border border-border bg-card">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1040px] border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-border bg-[#fcfcfe] text-left text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-2.5">Creative</th>
              {/* ⛔ Les deux côte à côte : leur ÉCART est l'information. « Contacts » compte tout le
                  monde, contacts de démonstration et désabonnés compris ; « Sendable » ne compte
                  que ce qu'une campagne peut réellement servir. */}
              <th className="px-4 py-2.5 text-right">Contacts</th>
              <th className="px-4 py-2.5 text-right">Sendable</th>
              <th className="px-4 py-2.5 text-right">New (30d)</th>
              <th className="px-4 py-2.5">Last signup</th>
              <th className="px-4 py-2.5">Default tag</th>
              <th className="px-4 py-2.5">Existing contacts</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const e = etat(r.id);
              const aTag = r.defaultTagId !== null;
              return (
                <tr key={r.id} className="border-b border-border/60 last:border-b-0 align-top">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 font-medium">
                      {r.name}
                      {r.archivedAt && (
                        <span className="rounded-full bg-muted px-2 py-px text-[10.5px] font-semibold text-muted-foreground">
                          archived
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-[11.5px] text-muted-foreground">
                      {r.campaignName ?? "No campaign"}{r.placement ? ` · ${r.placement}` : ""}
                    </div>
                    <div className="mt-0.5 font-mono text-[11px] text-muted-foreground/70">{r.slug}</div>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{fmt(r.contacts)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{fmt(r.sendable)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{fmt(r.new30d)}</td>
                  <td className="px-4 py-3 text-[12px] text-muted-foreground">
                    {r.lastSignupAt
                      ? new Date(r.lastSignupAt).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" })
                      : "Never"}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <TagIcon className="h-[13px] w-[13px] shrink-0 text-muted-foreground" />
                      <select
                        value={r.defaultTagId ?? ""}
                        disabled={e.phase === "occupe"}
                        onChange={(ev) => changerTag(r.id, ev.target.value)}
                        className="max-w-[190px] rounded-lg border border-border bg-card px-2 py-1.5 text-[12.5px] outline-none focus:border-brand disabled:opacity-50"
                      >
                        <option value="">No tag</option>
                        {tags.map((t) => (
                          <option key={t.id} value={t.id}>{t.slug}</option>
                        ))}
                        {/* Un tag par défaut supprimé de la marque doit rester VISIBLE, sinon le
                            select afficherait « No tag » pour une ligne qui en porte un. */}
                        {aTag && !tags.some((t) => t.id === r.defaultTagId) && (
                          <option value={r.defaultTagId as number}>{r.defaultTagSlug} (missing)</option>
                        )}
                      </select>
                    </div>
                    <p className="mt-1 text-[11px] leading-snug text-muted-foreground/80">
                      Applies to the next contacts only.
                    </p>
                  </td>
                  <td className="px-4 py-3">
                    {!aTag ? (
                      <span className="text-[12px] text-muted-foreground/70">Pick a tag first.</span>
                    ) : e.phase === "occupe" ? (
                      <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Working…
                      </span>
                    ) : e.phase === "confirmer" ? (
                      e.affected === 0 ? (
                        <span className="inline-flex items-center gap-1.5 text-[12px] text-[#1f9d57]">
                          {/* Le compte vient du dry-run, pas de la vue première touche : citer
                              `firstTouchContacts` ici aurait annoncé « all 0 already tagged » sur
                              une créative qui compte des contacts en seconde touche. */}
                          <Check className="h-3.5 w-3.5" /> Nothing to do — every contact recorded on this creative already has the tag.
                        </span>
                      ) : (
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[12px]">
                            <strong className="font-semibold">{fmt(e.affected)}</strong> contact
                            {e.affected > 1 ? "s" : ""} would get <code>{r.defaultTagSlug}</code>.
                          </span>
                          <button
                            onClick={() => appliquer(r.id)}
                            className="rounded-[9px] bg-brand px-2.5 py-1 text-[12px] font-semibold text-brand-foreground"
                          >
                            Confirm
                          </button>
                          <button
                            onClick={() => poser(r.id, { phase: "repos" })}
                            className="rounded-[9px] border border-border px-2.5 py-1 text-[12px] font-medium text-muted-foreground hover:bg-accent"
                          >
                            Cancel
                          </button>
                        </div>
                      )
                    ) : e.phase === "fait" ? (
                      <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[#1f9d57]">
                        <Check className="h-3.5 w-3.5" /> Tagged {fmt(e.affected)} contact{e.affected > 1 ? "s" : ""}.
                      </span>
                    ) : e.phase === "erreur" ? (
                      <span className="inline-flex items-start gap-1.5 text-[12px] text-red-700">
                        <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" /> {e.message}
                      </span>
                    ) : (
                      <div className="flex flex-wrap items-center gap-2">
                        {/* ⛔ Aucun grisage calculé sur la première touche : depuis 0063 le geste
                            rétroactif frappe `capture_optin_ids @> [créative] OR optin_id =
                            créative`, un SUR-ensemble. Un bouton grisé « rien à faire » aurait
                            décrit une population plus étroite que l'écriture. Le seul nombre qui
                            fait foi est celui du dry-run, affiché au clic. */}
                        <button
                          onClick={() => compter(r.id)}
                          className="rounded-[9px] border border-border px-2.5 py-1 text-[12px] font-medium transition-colors hover:bg-accent"
                        >
                          Apply to existing…
                        </button>
                        <span
                          className="text-[11.5px] text-muted-foreground/80"
                          title="First-touch contacts only. The retroactive write also reaches people whose first signup was on another creative, so it can affect more — the exact number is shown before you confirm."
                        >
                          {fmt(r.taggedSubscriptions)}/{fmt(r.firstTouchContacts)} tagged on first touch
                        </span>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {/* ⛔ Deux définitions de « contacts » cohabitent dans ce tableau, et elles divergeront à la
          première double inscription. Les nommer ici est ce qui empêche de lire le ratio « tagged »
          comme une part de la colonne Contacts. */}
      <div className="space-y-1 border-t border-border bg-[#fcfcfe] px-4 py-2.5 text-[11.5px] text-muted-foreground">
        <p>
          <strong>Contacts</strong> and <strong>Sendable</strong> count every signup recorded for the
          creative, one person once. <strong>tagged on first touch</strong> counts only the people
          whose <em>first</em> signup was this creative. <strong>Apply to existing</strong> reaches
          every signup recorded here, so it can affect more people than that ratio suggests — the
          exact number is counted and shown before you confirm.
        </p>
        <p>
          Target a form in a campaign with the <strong>Opt-in form</strong> condition in{" "}
          <Link href="/automations/targeting" className="font-medium text-brand hover:underline">Automations › Targeting</Link>.
        </p>
      </div>
    </div>
  );
}
