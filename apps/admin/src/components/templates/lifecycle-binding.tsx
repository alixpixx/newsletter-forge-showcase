"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { LIFECYCLE_KINDS, type LifecycleKind } from "@nf/render/lifecycle-checks";
import { isLifecycleEditable } from "@/lib/automations";
// Les libellés vivent dans un module SANS `"use client"` : la liste des modèles est un Server
// Component et ne peut pas lire une constante déclarée ici (elle n'en aurait qu'une référence).
import { LIFECYCLE_LABELS } from "@/components/templates/lifecycle-labels";

/*
 * Rattacher un modèle à un e-mail de cycle de vie.
 *
 * ⛔ CE QUE CE GESTE FAIT VRAIMENT, ET POURQUOI L'ÉCRAN LE DIT. À partir du rattachement, cette
 * marque envoie CE modèle à la place du texte livré avec le produit — pour des e-mails que personne
 * ne relit avant qu'ils partent, et dont l'un (la confirmation) porte la preuve du consentement.
 * L'écran nomme donc l'effet, pas le mécanisme, et il dit ce qui se passe si le modèle disparaît.
 *
 * Règle d'honnêteté du dossier : aucun faux succès. L'erreur du serveur est affichée telle quelle
 * — c'est elle qui nomme le jeton manquant — et l'écran n'est rafraîchi qu'après un 2xx.
 */

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error) return body.error;
  } catch {
    /* corps non-JSON — on garde le statut */
  }
  return `Request failed (${res.status})`;
}

export function LifecycleBinding({
  templateId,
  current,
  published,
  known,
}: {
  templateId: string;
  /**
   * Les kinds que ce modèle sert aujourd'hui — un tableau, pas un kind. La clé primaire du
   * rattachement est (asset_id, kind) : rien n'interdit à un modèle d'en servir deux, et n'en
   * afficher qu'un laisserait croire l'autre libre alors que la liste, elle, le badge.
   */
  current: LifecycleKind[];
  /** Faux quand le modèle n'a aucune version publiée : le rattachement est alors sans effet. */
  published: boolean;
  /**
   * Faux = le réglage n'a pas pu être LU (base absente, requête en erreur). Ce n'est pas « aucun
   * rattachement ».
   *
   * ⛔ POURQUOI CETTE CARTE-LÀ EN A BESOIN PLUS QUE TOUTE AUTRE. Sans elle, `current` vide se lit
   * « libre » : les quatre lignes affichent « Use this », donc un clic envoie un ATTACHEMENT — sur
   * une fente peut-être déjà servie par un autre modèle, que l'upsert (asset_id, kind) évincerait.
   * La liste, elle, refuse déjà de prononcer un verdict dans ce cas : deux écrans qui se
   * contredisent sur « qu'est-ce qui part ? » valent moins qu'un seul qui se tait.
   */
  known: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const set = async (kind: LifecycleKind, detach: boolean) => {
    setBusy(kind);
    setError(null);
    try {
      const res = await fetch(`/api/builder/templates/${templateId}/lifecycle`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // ⛔ LE KIND EST TOUJOURS EXPLICITE, MÊME POUR DÉTACHER. Sans lui, le serveur devait
        // redécouvrir « le kind de ce modèle » — lecture qui rendait une erreur, donc rien, donc un
        // 200 « détaché » sans rien supprimer, dès que le modèle en servait deux.
        body: JSON.stringify(detach ? { kind, detach: true } : { kind }),
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <p className="mb-3 text-[12.5px] leading-relaxed text-muted-foreground">
        Pick a lifecycle email to send with this template instead of the built-in one. Publishing a new
        version puts the change live.
      </p>

      {!known && (
        <p className="mb-3 text-[11.5px] leading-snug text-[#b9790a]">
          These settings could not be read, so what you see below is not their state. Try again in a
          moment.
        </p>
      )}

      <div className="space-y-1.5">
        {/* ⛔ `reengagement` n'est plus proposé (la relance est une automation du moteur) ; un modèle
            DÉJÀ rattaché reste affiché, avec sa raison, pour pouvoir être détaché — jamais caché. */}
        {LIFECYCLE_KINDS.filter((k) => isLifecycleEditable(k) || current.includes(k)).map((kind) => {
          const active = current.includes(kind);
          return (
            <button
              key={kind}
              type="button"
              disabled={busy !== null || !known}
              onClick={() => void set(kind, active)}
              className={`flex w-full items-start justify-between gap-3 rounded-[10px] border px-3.5 py-2.5 text-left transition ${
                active ? "border-brand bg-brand/5" : "border-border hover:border-foreground/20"
              } ${busy !== null || !known ? "cursor-not-allowed opacity-60" : ""}`}
            >
              <span>
                <span className="block text-[13px] font-medium">{LIFECYCLE_LABELS[kind].titre}</span>
                <span className="block text-[11.5px] text-muted-foreground">{LIFECYCLE_LABELS[kind].quand}</span>
                {LIFECYCLE_LABELS[kind].pasEnvoye && (
                  <span className="block text-[11.5px] font-medium text-amber-700">{LIFECYCLE_LABELS[kind].pasEnvoye}</span>
                )}
              </span>
              <span className="shrink-0 pt-0.5 text-[11.5px] text-muted-foreground">
                {/* ⚠️ « Use this » sur un état illisible se lit « cette fente est libre » : on ne le
                    dit pas, on dit qu'on ne sait pas. */}
                {busy === kind ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : !known ? (
                  "Unknown"
                ) : active ? (
                  "In use — click to stop"
                ) : (
                  "Use this"
                )}
              </span>
            </button>
          );
        })}
      </div>

      {current.length > 0 && !published && (
        /* ⚠️ Le rattachement existe mais ne sert à rien tant qu'aucune version n'est publiée : le
           worker n'a pas de shell et sert le texte livré. Le taire laisserait croire au changement. */
        <p className="mt-3 text-[11.5px] leading-snug text-[#b9790a]">
          This template has never been published, so the built-in email is still what goes out. Publish a
          version to put this template live.
        </p>
      )}

      {current.length > 0 && published && (
        /* ⚠️ Le repli n'est plus silencieux (inventaire du 22/09/2026, élément 114) : quand le worker
           ne peut pas servir le modèle publié (shell vide, pas d'emplacement de pied légal, sujet vide,
           erreur d'hydratation — `renderLifecycle`), il envoie l'e-mail intégré ET poste une alerte
           Slack, une par modèle et par fenêtre de cinq minutes. */
        <p className="mt-3 text-[11.5px] leading-snug text-muted-foreground">
          If this template is archived or unpublished, the built-in email takes over again — these emails
          are never skipped for a missing template. If the published version cannot be used (for
          instance it has no legal footer), the built-in email goes out instead and the team is alerted
          on Slack.
        </p>
      )}

      {error && <p className="mt-3 text-[11.5px] leading-snug text-[#c0392b]">{error}</p>}
    </div>
  );
}
