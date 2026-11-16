import type { Db } from "@/lib/supabase";
import { lireConfirmation } from "@/lib/confirmation";
import { dict, normalizeLocale } from "@/lib/i18n";
import { Shell } from "./shell";
import { ConfirmationBouton } from "./confirm-client";

/**
 * Le rendu de `/confirm` — séparé de `page.tsx` pour qu'un banc l'exécute sans secret ni réseau
 * (`page.tsx` ne peut exporter que ce que Next attend d'une page).
 *
 * ⛔⛔ CE RENDU N'ÉCRIT RIEN (24/09/2026). Il LIT l'état du lien et montre, au mieux, un bouton.
 * La confirmation part du bouton vers `api/v1/confirm` (POST). Avant ce jour, ce même rendu passait
 * la souscription `active`, écrivait la preuve `optin_confirm` et mettait le bienvenue en file dès
 * que l'URL était chargée — y compris par un antivirus qui pré-charge les liens. Le banc
 * `vue.test.ts` rend cette page sur une souscription en attente et exige qu'elle y reste.
 *
 * ⚠️ Les messages, la couleur et le choix de la langue sont ceux d'avant : `lang` (le paramètre du
 * lien) d'abord, puis la langue de la souscription.
 */
export interface VueConfirmationDeps {
  getDb: () => Db | null;
}

const BRAND = "#ff368d";

export async function vueConfirmation(
  { token, lang }: { token?: string; lang?: string },
  deps: VueConfirmationDeps,
) {
  const db = deps.getDb();
  const early = dict(normalizeLocale(lang)).c;

  if (!db || !token) {
    return <Shell brand={BRAND} icone="ko" title={early.invalidTitle}>{early.invalidBody}</Shell>;
  }

  const lu = await lireConfirmation(db, token);
  if (lu.etat === "inconnu") return <Shell brand={BRAND} icone="ko" title={early.invalidTitle}>{early.incompleteBody}</Shell>;
  if (lu.etat === "expire") return <Shell brand={BRAND} icone="ko" title={early.expiredTitle}>{early.expiredBody}</Shell>;
  if (lu.etat === "introuvable") return <Shell brand={BRAND} icone="ko" title={early.invalidTitle}>{early.notFound}</Shell>;

  const locale = normalizeLocale(lang ?? lu.sub.language ?? undefined);
  const t = dict(locale).c;
  const marque = lu.sub.assetName;

  if (lu.etat === "deja") return <Shell brand={BRAND} icone="ok" title={t.alreadyTitle}>{t.alreadyBody(marque)}</Shell>;
  if (lu.etat === "efface") return <Shell brand={BRAND} icone="ko" title={t.invalidTitle}>{t.notFound}</Shell>;

  return (
    <ConfirmationBouton
      token={token}
      lang={locale}
      brand={BRAND}
      textes={{
        confirmTitle: t.confirmTitle,
        confirmBody: t.confirmBody(marque),
        confirmCta: t.confirmCta,
        failed: t.failed,
        doneTitle: t.doneTitle,
        doneBody: t.doneBody(marque),
        alreadyTitle: t.alreadyTitle,
        alreadyBody: t.alreadyBody(marque),
        expiredTitle: t.expiredTitle,
        expiredBody: t.expiredBody,
        invalidTitle: t.invalidTitle,
        incompleteBody: t.incompleteBody,
        notFound: t.notFound,
      }}
    />
  );
}
