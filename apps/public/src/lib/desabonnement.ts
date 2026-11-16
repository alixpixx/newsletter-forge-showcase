import { normalizeLocale } from "@/lib/i18n";

/**
 * L'ÉCRITURE du désabonnement — une seule, pour les deux chemins qui y mènent.
 *
 * Il y a deux gestes distincts et il n'y en aura jamais qu'une écriture :
 *
 *  - **la machine** : `POST /unsubscribe` avec le marqueur RFC 8058, réécrit par le middleware vers
 *    `api/v1/unsubscribe` — Gmail, Yahoo. Trace `list_unsub_one_click`.
 *  - **l'humain** : la page `/unsubscribe?token=…`, qui affiche un bouton et POSTe vers
 *    `api/v1/unsubscribe/confirm`. Trace `list_unsub`.
 *
 * ⛔ CE MODULE EXISTE PARCE QUE LA ROUTE ONE-CLICK DÉCLARE L'INVARIANT ELLE-MÊME : « une seule
 * façon de se désinscrire […] deux chemins qui divergeraient donneraient un abonné désinscrit d'un
 * côté et toujours servi de l'autre — invisible jusqu'à la plainte ». Le seul écart autorisé entre
 * les deux appelants est le LIBELLÉ de la trace, parce qu'un audit doit pouvoir distinguer un
 * désabonnement machine d'un geste humain.
 */

/** Les deux seuls libellés d'audit. Aucun autre ne doit atteindre `consent_event.method`. */
export const METHODE_MACHINE = "list_unsub_one_click" as const;
export const METHODE_HUMAIN = "list_unsub" as const;
export type MethodeDesabonnement = typeof METHODE_MACHINE | typeof METHODE_HUMAIN;

/**
 * Ce qui s'est passé. `deja` est un SUCCÈS : le désabonnement est acquis, simplement pas par nous.
 * `echec` est le seul cas où la personne est TOUJOURS ABONNÉE.
 *
 * ⛔ `fait` EST RENDU À UN SEUL APPELANT, celui qui a gagné l'écriture : c'est lui, et lui seul, qui
 * met en file l'accusé de désinscription (page humaine uniquement — jamais le one-click).
 */
export type IssueDesabonnement = "fait" | "deja" | "echec";

type ClientMinimal = {
  from: (table: string) => any;
};

/**
 * Désabonne, une fois, sans course.
 *
 * ⛔ IDEMPOTENCE ATOMIQUE — LE LIRE-PUIS-ÉCRIRE NE PROTÈGE DE RIEN. Gmail rejoue le POST et deux
 * rejeux peuvent se CROISER. Tester `status !== 'unsubscribed'` après un `select` séparé laisse les
 * deux requêtes lire `active` et écrire toutes les deux : mesuré, 6 POST simultanés portant le même
 * jeton = 6× HTTP 200 et **5 `consent_event` en trop**. La table est append-only (migration 0001
 * révoque `update`/`delete` à `public`) : la preuve de consentement reste gonflée POUR TOUJOURS.
 *
 * La condition vit donc DANS l'instruction d'écriture (`.neq('status','unsubscribed')`). Postgres
 * sérialise les UPDATE concurrents sur la ligne et ré-évalue le WHERE après le premier : un seul
 * appelant voit une ligne revenir, et c'est LUI SEUL qui écrit la trace.
 *
 * ⛔ NE PAS refactoriser en `update(...).eq('id')` suivi d'un test applicatif : ce serait remettre
 * exactement le défaut mesuré ci-dessus. Un test de ce module l'exige explicitement.
 *
 * ⛔ UNE SOUSCRIPTION EFFACÉE (`deleted`) N'EST PAS RÉÉCRITE (22/09/2026). Un vieux lien reste signé
 * après le droit à l'oubli : sans ce second `.neq`, le cliquer faisait repasser `deleted` à
 * `unsubscribed` et réécrivait une IP et un user-agent dans la trace d'une personne effacée. Depuis
 * que `fait` déclenche l'accusé de désinscription, c'était pire : un e-mail vers l'adresse
 * pseudonymisée `erased+…@deleted.invalid`, qu'aucune suppression ne couvre. Une souscription
 * effacée rend donc `deja` — l'objectif est atteint, et bien au-delà.
 */
export async function ecrireDesabonnement(
  db: ClientMinimal,
  subId: string,
  o: {
    methode: MethodeDesabonnement;
    /** `?lang` de l'URL, puis la langue de la souscription. Normalisée ici, jamais brute. */
    langue: string | null;
    ip: string | null;
    ua: string | null;
  },
): Promise<IssueDesabonnement> {
  const { data: lignesModifiees, error: erreurMaj } = await db
    .from("subscription")
    .update({ status: "unsubscribed" })
    .eq("id", subId)
    .neq("status", "unsubscribed")
    .neq("status", "deleted")
    .select("id");

  // Écriture refusée = le désabonnement N'A PAS eu lieu. L'appelant doit le dire, pas rendre un
  // faux succès qui laisserait la personne abonnée sans que rien ne le signale.
  if (erreurMaj) return "echec";

  // Zéro ligne = déjà désabonné (avant cet appel, ou par la requête qui a gagné la course), ou effacé.
  if (!lignesModifiees || lignesModifiees.length === 0) return "deja";

  const { error: erreurTrace } = await db.from("consent_event").insert({
    subscription_id: subId,
    event_type: "unsubscribe",
    method: o.methode,
    /**
     * ⛔ NORMALISÉE, JAMAIS BRUTE. Écrire la langue telle quelle (ou `NULL`) donnait deux traces de
     * forme différente pour le MÊME acte juridique, et perdait l'information quand elle est nulle.
     */
    language: normalizeLocale(o.langue ?? undefined),
    ip_address: o.ip,
    user_agent: o.ua,
  });

  /**
   * ⛔ ON NE REND PAS « echec » ICI, MAIS ON NE SE TAIT PAS. Le statut est déjà passé : un rejeu
   * retomberait dans la branche « déjà » et n'écrirait toujours pas la trace. Mais un insert avalé
   * en silence transforme la panne de la PREUVE LÉGALE en 200 vert — c'est le `except: pass` du
   * RGPD. On journalise en nommant la souscription ET le geste, pour que l'audit sache quelle ligne
   * réparer à la main.
   */
  if (erreurTrace) {
    console.error(
      `[unsubscribe/${o.methode}] desabonnement APPLIQUE mais consent_event NON ECRIT — ` +
        `subscription_id=${subId} — la preuve de consentement manque, la reconstituer a la main : ${erreurTrace.message}`,
    );
  }

  return "fait";
}

/**
 * L'IP du demandeur, telle que le bord l'a vue.
 *
 * ⛔ LE PREMIER MAILLON SEULEMENT. `x-forwarded-for` porte une chaîne « client, proxy1, proxy2 » :
 * prendre la chaîne entière écrirait trois adresses dans une colonne qui en attend une, et prendre
 * la dernière écrirait l'adresse de notre propre infrastructure comme preuve de consentement.
 */
export function ipDeLaRequete(h: Headers): string | null {
  const chaine = h.get("x-forwarded-for");
  const premier = chaine?.split(",")[0]?.trim();
  if (premier) return premier;
  return h.get("x-real-ip") || null;
}
