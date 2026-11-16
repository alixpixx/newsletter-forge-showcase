/**
 * `@nf/wp` — lecture de sites WordPress, partagée entre l'admin et le worker.
 *
 * POURQUOI UN PACKAGE. Ces trois modules vivaient dans `apps/admin/src/lib/wp/`. Le matérialiseur
 * (S-4) doit rafraîchir les articles au moment du GEL, dans le worker : sans ce déplacement, la
 * deuxième occurrence d'une série hebdomadaire réenverrait les articles de la première — le défaut
 * exact que toute l'architecture d'occurrence existe pour rendre impossible.
 *
 * ⛔ AUCUNE DÉPENDANCE À NEXT NI À LA BASE : ces modules ne font que parler HTTP à un site tiers et
 * normaliser ce qu'il répond. Ce qui touche la base (réhébergement des vignettes) reste dans
 * l'admin (`lib/wp/media-import.ts`), qui a le contexte de marque et le stockage.
 */
export * from "./guard";
export * from "./normalize";
export * from "./client";
export * from "./rss";
// La DÉCISION (quels articles composent un bloc flux) est ici et pas dans l'appelant : l'admin qui
// remplit l'aperçu et le worker qui gèle l'occurrence doivent trancher avec le même code, sinon
// l'aperçu promet des articles que l'envoi ne choisit pas.
export * from "./feed";
