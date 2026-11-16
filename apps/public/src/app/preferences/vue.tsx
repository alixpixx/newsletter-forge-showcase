import { trackingAccepted } from "@nf/config";
import type { Db } from "@/lib/supabase";
import { PreferencesManager } from "@/components/preferences-manager";
import { dict, normalizeLocale, type Locale } from "@/lib/i18n";
import { resoudreAbonnePrefs } from "@/lib/abonne-prefs";

/**
 * Le rendu de `/preferences`. Module séparé de `page.tsx` (22/09/2026) : la base et la vérification
 * du jeton y sont injectées, pour qu'un banc mesure ce que voit un abonné effacé sans secret ni
 * réseau — `page.tsx` ne peut exporter que ce que Next attend d'une page.
 */
export interface VuePreferencesDeps {
  getDb: () => Db | null;
  verifyPrefs: (token: string | undefined | null) => string | null;
}

function Invalid({ locale }: { locale: Locale }) {
  const t = dict(locale).p;
  return (
    <div className="flex min-h-screen items-center justify-center p-4" style={{ background: "#f7f7fb" }}>
      <div className="w-full max-w-[440px] rounded-2xl border bg-white p-7 text-center" style={{ borderColor: "var(--line)" }}>
        <h1 className="text-[19px] font-bold tracking-tight">{t.invalidTitle}</h1>
        <p className="mt-1.5 text-[13.5px]" style={{ color: "var(--muted)" }}>{t.invalidBody}</p>
      </div>
    </div>
  );
}

export async function vuePreferences(
  { token, lang, ls }: { token?: string; lang?: string; ls?: string },
  deps: VuePreferencesDeps,
) {
  const db = deps.getDb();
  if (!db || !token) return <Invalid locale={normalizeLocale(lang)} />;

  /*
   * ⛔ UN ABONNÉ EFFACÉ VOIT EXACTEMENT L'ÉCRAN D'UN LIEN FAUX (22/09/2026) : ni liste, ni
   * interrupteur, ni adresse pseudonymisée. Son jeton est mort (`resoudreAbonnePrefs`) ; l'écran
   * d'avant affichait `erased+…@deleted.invalid` et des interrupteurs qui écrivaient encore.
   */
  const resolu = await resoudreAbonnePrefs(db, token, deps.verifyPrefs, "email, first_name");
  if (resolu.etat !== "ok") return <Invalid locale={normalizeLocale(lang)} />;
  const subscriber = resolu.abonne;

  const { data: subs } = await db
    .from("subscription")
    .select("asset_id, status, language, granted_purposes, tracking_consent, asset:asset_id(name, slug)")
    .eq("subscriber_id", subscriber.id)
    // ⛔ Un contact hors newsletter (0088) n'est pas une newsletter : l'afficher proposerait un
    //    interrupteur « Newsletter » que la route refuse (`trouverSouscription`).
    .neq("status", "contact")
    .order("created_at", { ascending: true });

  // Locale : ?lang (posé par le worker sur les liens) → langue de la souscription la plus récente → en.
  const locale = normalizeLocale(lang ?? (subs?.[subs.length - 1]?.language as string | undefined));

  /*
   * 0092 — l'état RÉEL du suivi : en mode « pour tous », la personne est suivie tant qu'elle n'a pas
   * coupé l'interrupteur. Lu À PART : sur une base d'avant 0092 cette lecture échoue, et l'interrupteur
   * garde la règle du consentement au lieu de casser la page.
   */
  const { data: suivi, error: eSuivi } = await db
    .from("subscription")
    .select("asset_id, tracking_refused_at, asset:asset_id(tracking_mode)")
    .eq("subscriber_id", subscriber.id)
    .neq("status", "contact");
  const suiviParMarque = new Map(
    eSuivi
      ? []
      : (suivi ?? []).map((x) => [
          x.asset_id as string,
          {
            trackingMode: (x.asset as { tracking_mode?: string | null } | null)?.tracking_mode ?? null,
            trackingRefused: x.tracking_refused_at != null,
          },
        ]),
  );

  const items = (subs ?? []).map((s) => ({
    assetId: s.asset_id as string,
    name: (s.asset as { name?: string } | null)?.name ?? "Newsletter",
    purposes: (s.granted_purposes ?? {}) as Record<string, boolean>,
    tracking: trackingAccepted({ trackingConsent: s.tracking_consent === true, ...suiviParMarque.get(s.asset_id as string) }),
  }));

  /**
   * ⛔ `ls` EST TRANSMIS AU CLIENT, IL N'EST PAS TRAITÉ ICI. Enregistrer la réaction au rendu de
   * cette page compterait les préchargeurs et les antivirus de messagerie, qui suivent les liens
   * d'un e-mail sans qu'aucun humain n'ait rien fait. L'écriture est déclenchée par le navigateur
   * (`PreferencesManager`), et validée côté serveur par la route qui la reçoit.
   */
  return (
    <PreferencesManager
      token={token}
      email={subscriber.email as string}
      firstName={(subscriber.first_name as string | null) ?? null}
      items={items}
      locale={locale}
      lifecycleRef={ls ?? null}
    />
  );
}
