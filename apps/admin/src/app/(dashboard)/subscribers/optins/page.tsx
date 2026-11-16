import { redirect } from "next/navigation";

/**
 * L'ANCIENNE ADRESSE DE L'ÉCRAN DES FORMULAIRES.
 *
 * Elle a servi de « Manage forms » pendant tout le mois : elle vit dans des favoris et dans des
 * échanges internes. La faire répondre 404 ferait conclure que l'écran a disparu, alors qu'il a
 * seulement gagné deux voisins (les campagnes et les intérêts) sous `/subscribers/capture`.
 *
 * ⚠️ Redirection ici et pas dans `next.config.ts` : y toucher sortirait de la zone de ce lot, et le
 * fichier n'a aujourd'hui aucun bloc `redirects()` à étendre.
 * L'onglet `creatives` est explicite : c'est exactement ce que cette URL montrait.
 */
export default function OptinsPage() {
  redirect("/subscribers/capture?tab=creatives");
}
