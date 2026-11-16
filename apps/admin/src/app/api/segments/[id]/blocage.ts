/**
 * Le refus de supprimer un segment encore utilisé — la phrase, écrite une fois et testée.
 *
 * ⛔ UNE CAMPAGNE ARCHIVÉE BLOQUE TOUJOURS (décision d'Alix, 22/09/2026). Archiver est une PAUSE :
 * « Reactivate » peut la remettre en route, et elle repartirait alors vers un segment disparu — à
 * personne, ou à une audience recalculée par défaut. Mais elle est rangée dans un onglet qu'on ne
 * regarde pas : sans le « (archived) », l'utilisateur chercherait dans la liste active une campagne
 * qui n'y est pas, et conclurait que le refus ment.
 *
 * Module séparé de `route.ts`, qui ne peut exporter que ses méthodes HTTP.
 */
export function messageDeBlocage(blockers: { name: string; archived_at?: unknown }[]): string {
  const noms = blockers.map((b) => (b.archived_at ? `${b.name} (archived)` : b.name));
  const archivees = blockers.some((b) => b.archived_at);
  return (
    `This segment is the audience of ${blockers.length} campaign(s) that have not been sent (${noms.join(", ")}). ` +
    `Change their audience first.` +
    (archivees ? " Archived campaigns still count: restore them from the Archived tab to change their audience." : "")
  );
}
