import { getDb } from "@/lib/supabase";
import { verifyUnsub, signPrefs } from "@/lib/tokens";
import { dict, normalizeLocale, type Locale } from "@/lib/i18n";
import { UnsubscribeConfirm } from "./confirm-client";

export const dynamic = "force-dynamic";

/**
 * La page HUMAINE de désabonnement.
 *
 * ⛔⛔ CETTE PAGE N'ÉCRIT RIEN. Jusqu'au 18/09/2026 elle passait la souscription en
 * `unsubscribed` et insérait un `consent_event` **au rendu du GET** — donc dès que l'URL était
 * ouverte, par qui que ce soit. Or tout ce qui PRÉ-CHARGE une URL ouvre ce lien : antivirus de
 * messagerie, proxy d'entreprise, aperçu de client mail, robot antispam. Chacun désabonnait
 * quelqu'un qui n'avait rien cliqué — et la trace écrivait `method: 'list_unsub'`, donc
 * l'historique AFFIRMAIT ensuite que la personne l'avait demandé. Une donnée perdue se répare ;
 * une **fausse preuve de volonté** se défend devant un régulateur.
 *
 * Le risque était théorique tant que rien ne partait. Il a cessé de l'être le 18/09 à 12:58 UTC,
 * quand l'envoi a été armé et que ces liens sont entrés dans de vrais e-mails.
 *
 * Le motif appliqué est celui que `preferences/page.tsx` suivait déjà : **le rendu montre, le
 * navigateur écrit.** L'écriture part de `UnsubscribeConfirm` vers `api/v1/unsubscribe/confirm`.
 *
 * ⚠️ Le GET reste la page humaine, et il doit le rester : l'en-tête `List-Unsubscribe` posé par le
 * worker porte cette URL, et tout client sans RFC 8058 l'ouvre en GET. La cible POST du one-click
 * est `api/v1/unsubscribe`, où le middleware réécrit les POST faits sur `/unsubscribe`.
 */

function Shell({ ok, title, children }: { ok: boolean; title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-4" style={{ background: "#f7f7fb" }}>
      <div className="w-full max-w-[420px] rounded-2xl border bg-white p-7 text-center" style={{ borderColor: "var(--line)" }}>
        <div className="mx-auto mb-3.5 flex h-12 w-12 items-center justify-center rounded-full" style={{ background: "#f0f0f4" }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={ok ? "#1f9d57" : "#999"} strokeWidth="2.3">
            {ok ? <path d="M20 6L9 17l-5-5" /> : <path d="M18 6L6 18M6 6l12 12" />}
          </svg>
        </div>
        <h1 className="text-[19px] font-bold tracking-tight">{title}</h1>
        <div className="mt-1.5 text-[13.5px] leading-relaxed" style={{ color: "var(--muted)" }}>{children}</div>
      </div>
    </div>
  );
}

export default async function UnsubscribePage({ searchParams }: { searchParams: Promise<{ token?: string; lang?: string }> }) {
  const { token, lang } = await searchParams;
  const db = getDb();
  const subId = verifyUnsub(token);
  let locale: Locale = normalizeLocale(lang);

  if (!db || !subId) {
    const t = dict(locale).u;
    return <Shell ok={false} title={t.invalidTitle}>{t.invalidBody}</Shell>;
  }

  const { data: sub } = await db
    .from("subscription").select("id, status, subscriber_id, language, asset:asset_id(name)").eq("id", subId).maybeSingle();
  if (!sub) {
    const t = dict(locale).u;
    return <Shell ok={false} title={t.invalidTitle}>{t.notFound}</Shell>;
  }

  // Locale : ?lang (posé par le worker) → langue de la souscription → en.
  locale = normalizeLocale(lang ?? (sub.language as string | undefined));
  const t = dict(locale).u;
  const assetName = (sub.asset as { name?: string } | null)?.name ?? "—";
  const prefsUrl = `/preferences?token=${signPrefs(sub.subscriber_id as string)}&lang=${locale}`;

  /**
   * Déjà désabonné : on l'annonce comme un fait accompli, sans rien réécrire et sans proposer un
   * bouton qui ne ferait rien. ⚠️ C'est aussi ce que voit quelqu'un dont le lien a été pré-chargé
   * AVANT ce correctif — l'écran doit rester vrai pour lui.
   */
  if (sub.status === "unsubscribed") {
    return (
      <Shell ok title={t.doneTitle}>
        {t.doneBody(assetName)}
        <div className="mt-4">
          <a href={prefsUrl} className="text-[12.5px] font-medium underline" style={{ color: "var(--muted)" }}>{t.managePrefs}</a>
        </div>
      </Shell>
    );
  }

  return (
    <UnsubscribeConfirm
      token={token ?? ""}
      lang={locale}
      assetName={assetName}
      prefsUrl={prefsUrl}
      textes={{
        confirmTitle: t.confirmTitle,
        confirmBody: t.confirmBody(assetName),
        confirmCta: t.confirmCta,
        doneTitle: t.doneTitle,
        doneBody: t.doneBody(assetName),
        managePrefs: t.managePrefs,
        failed: t.failed,
      }}
    />
  );
}
