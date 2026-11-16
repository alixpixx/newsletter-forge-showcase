import { personnesDistinctes } from "@/lib/data/subscriber-actions";

/**
 * Droit à l'oubli — la décision, séparée du transport.
 *
 * ⛔⛔ ON N'ÉCRIT PAS UNE SECONDE FOIS L'EFFACEMENT. `newsletter.erase_subscriber(uuid)` existe
 * depuis la migration 0006 et sert déjà au parcours public (« Delete my data ») : elle inscrit
 * l'adresse dans la table de suppression pour ne jamais la recontacter, pseudonymise l'identité,
 * passe les souscriptions en `deleted` et RETIRE la PII du journal de consentement tout en gardant
 * la preuve juridique. Réécrire ces quatre gestes ici, c'est garantir que les deux chemins
 * divergeront — et que celui qui divergera sera celui qu'on ne teste pas.
 *
 * ⛔⛔ IDENTIFIANT DE PERSONNE, PAS DE SOUSCRIPTION. L'écran manipule des `subscription.id`. Passer
 * l'un pour l'autre à la fonction ne lève RIEN : elle cherche l'adresse, ne trouve pas la ligne, et
 * sort. L'interface annoncerait un effacement qui n'a pas eu lieu.
 *
 * ⛔ DEUX APPELS. Sans `confirm`, on COMPTE et on n'écrit rien : c'est ce nombre-là que la
 * confirmation affiche. Et le nombre qui compte n'est pas celui des lignes cochées — une personne
 * peut en porter plusieurs.
 *
 * ⚠️ LA PORTÉE EST GLOBALE, ET L'INTERFACE DOIT LE DIRE. Effacer une personne la retire de TOUTES
 * les marques, pas seulement de celle qu'on regarde : c'est le sens même du droit à l'oubli. La
 * sélection, elle, reste scopée — on ne peut effacer qu'à partir d'une ligne qu'on a le droit de voir.
 *
 * ⛔ CE FICHIER EXISTE POUR POUVOIR ÊTRE ÉPROUVÉ. Jusqu'au 18/09/2026, ce chemin — le plus
 * destructeur de l'admin — n'avait AUCUN test, et n'avait jamais été exécuté depuis l'écran. Le
 * gabarit `handler.ts` + `handler.test.ts` est celui que le dépôt applique déjà à trois routes.
 */

type ClientMinimal = { from: (t: string) => any; rpc: (f: string, a: Record<string, unknown>) => any };

export type ContexteEffacement = {
  /** L'identifiant de la marque en session. `null` = non résolue : on refuse, on ne devine pas. */
  assetId: string | null;
  db: ClientMinimal | null;
};

export type ReponseEffacement = { statut: number; corps: Record<string, unknown> };

export async function traiterEffacement(
  corpsRecu: unknown,
  ctx: ContexteEffacement,
): Promise<ReponseEffacement> {
  if (!ctx.assetId) return { statut: 409, corps: { ok: false, reason: "no-asset" } };
  if (!ctx.db) return { statut: 503, corps: { ok: false, reason: "no-db" } };

  const body = (corpsRecu ?? {}) as { ids?: unknown; confirm?: unknown };
  const ids = Array.isArray(body.ids) ? body.ids.filter((i): i is string => typeof i === "string") : [];
  /** ⛔ `=== true` et non « truthy » : une chaîne « false » venue d'un formulaire effacerait. */
  const confirm = body.confirm === true;
  if (ids.length === 0) return { statut: 400, corps: { ok: false, reason: "no-selection" } };

  const cibles = await ctx.db
    .from("subscription")
    .select("id, subscriber_id")
    .in("id", ids)
    // ⛔ Le scope de marque est sur la LECTURE : on ne peut effacer qu'à partir d'une ligne qu'on
    // a le droit de voir. Sans lui, un identifiant d'une autre marque suffirait.
    .eq("asset_id", ctx.assetId);

  if (cibles.error) return { statut: 500, corps: { ok: false, reason: "read-failed" } };

  const lignes = (cibles.data ?? []) as { id: string; subscriber_id: string | null }[];
  const personnes = personnesDistinctes(lignes);
  if (personnes.length === 0) {
    // Aucune ligne de cette marque derrière ces identifiants : rien à effacer, et surtout rien à
    // annoncer comme effacé.
    return { statut: 409, corps: { ok: false, reason: "no-match", people: 0 } };
  }

  // Ce que l'effacement touchera VRAIMENT : toutes les souscriptions de ces personnes, marques
  // comprises que cet écran ne montre pas. La confirmation doit annoncer ce nombre-là.
  const portee = await ctx.db
    .from("subscription")
    .select("*", { count: "exact", head: true })
    .in("subscriber_id", personnes);

  if (!confirm) {
    return {
      statut: 200,
      corps: {
        ok: true,
        applied: false,
        people: personnes.length,
        subscriptions: portee.count ?? lignes.length,
        selected: ids.length,
      },
    };
  }

  let erased = 0;
  const failed: string[] = [];
  for (const personne of personnes) {
    const { error } = await ctx.db.rpc("erase_subscriber", { p_subscriber_id: personne });
    if (error) failed.push(personne);
    else erased += 1;
  }

  return {
    statut: 200,
    corps: {
      ok: failed.length === 0,
      applied: true,
      people: personnes.length,
      erased,
      failed: failed.length,
      subscriptions: portee.count ?? lignes.length,
    },
  };
}
