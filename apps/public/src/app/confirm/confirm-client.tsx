"use client";

import { useState } from "react";
import { Shell } from "./shell";

/**
 * Le bouton qui confirme un double opt-in — et la raison pour laquelle il existe.
 *
 * ⛔ C'EST LE CLIC QUI CONFIRME, PAS LE RENDU (24/09/2026). La page n'écrit plus rien au GET : un
 * antivirus de messagerie ou un proxy qui pré-charge le lien voit maintenant cette question, et
 * repart sans avoir rien confirmé. Avant, il confirmait pour de bon, et le journal légal affirmait
 * que la personne l'avait fait.
 *
 * ⛔ AUCUNE CONFIRMATION AUTOMATIQUE ICI NON PLUS. Pas d'`useEffect` qui appellerait la route au
 * montage : ce serait remettre le même défaut un étage plus bas, et il repasserait inaperçu parce
 * que l'écran afficherait exactement ce qu'on attend.
 */

export type TextesConfirmation = {
  confirmTitle: string;
  confirmBody: string;
  confirmCta: string;
  failed: string;
  doneTitle: string;
  doneBody: string;
  alreadyTitle: string;
  alreadyBody: string;
  expiredTitle: string;
  expiredBody: string;
  invalidTitle: string;
  incompleteBody: string;
  notFound: string;
};

type Issue = "question" | "envoi" | "fait" | "deja" | "expire" | "inconnu" | "introuvable" | "echec";

export function ConfirmationBouton({
  token,
  lang,
  brand,
  textes,
}: {
  token: string;
  lang: string;
  brand: string;
  textes: TextesConfirmation;
}) {
  const [issue, setIssue] = useState<Issue>("question");

  async function confirmer() {
    if (issue === "envoi") return;
    setIssue("envoi");
    try {
      const r = await fetch("/api/v1/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, lang }),
      });
      const corps = (await r.json().catch(() => ({}))) as { etat?: string };
      /**
       * ⛔ ON NE DIT « confirmé » QUE SUR UN VRAI SUCCÈS. Afficher la confirmation quoi qu'il arrive
       * laisserait quelqu'un partir en croyant être inscrit, alors que sa souscription serait restée
       * en attente — et qu'il ne recevrait jamais rien.
       */
      const connu: Issue[] = ["fait", "deja", "expire", "inconnu", "introuvable"];
      setIssue(connu.includes(corps.etat as Issue) ? (corps.etat as Issue) : "echec");
    } catch {
      setIssue("echec");
    }
  }

  if (issue === "fait") return <Shell brand={brand} icone="ok" title={textes.doneTitle}>{textes.doneBody}</Shell>;
  if (issue === "deja") return <Shell brand={brand} icone="ok" title={textes.alreadyTitle}>{textes.alreadyBody}</Shell>;
  if (issue === "expire") return <Shell brand={brand} icone="ko" title={textes.expiredTitle}>{textes.expiredBody}</Shell>;
  if (issue === "inconnu") return <Shell brand={brand} icone="ko" title={textes.invalidTitle}>{textes.incompleteBody}</Shell>;
  if (issue === "introuvable") return <Shell brand={brand} icone="ko" title={textes.invalidTitle}>{textes.notFound}</Shell>;

  return (
    <Shell brand={brand} icone="question" title={textes.confirmTitle}>
      {textes.confirmBody}
      <div className="mt-4">
        <button
          type="button"
          onClick={confirmer}
          disabled={issue === "envoi"}
          className="w-full rounded-[10px] px-4 py-2.5 text-[13.5px] font-semibold text-white transition-opacity disabled:opacity-60"
          style={{ background: brand }}
        >
          {textes.confirmCta}
        </button>
      </div>
      {issue === "echec" && (
        <p className="mt-3 text-[12.5px]" style={{ color: "#b4341f" }}>
          {textes.failed}
        </p>
      )}
    </Shell>
  );
}
