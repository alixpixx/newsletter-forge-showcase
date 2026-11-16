/**
 * LE DOSSIER DES MIGRATIONS — ce qu'un fichier doit porter pour que la base reste traçable.
 *
 * ⛔ POURQUOI. Le registre de la CLI Supabase ne correspond pas à ce dossier (voir README.md) : la
 * seule preuve qu'une migration est passée est la ligne qu'ELLE écrit dans
 * `newsletter.applied_migration`, en dernière instruction. Une migration qui oublie cette ligne
 * s'applique sans laisser de trace, et la suivante se construit sur une hypothèse.
 *
 * Aucun accès à la base : on lit les fichiers.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DOSSIER = join(import.meta.dir, "migrations");
const FICHIERS = readdirSync(DOSSIER).filter((f) => f.endsWith(".sql")).sort();
const lire = (f: string) => readFileSync(join(DOSSIER, f), "utf8");
/** Le SQL sans ses commentaires de ligne : un mot-clé cité dans un commentaire ne compte pas. */
const sansCommentaires = (sql: string) => sql.replace(/--[^\n]*/g, "");

/** Premier fichier soumis au registre : celui qui le crée. */
const PREMIER_REGISTRE = 62;
const INSERT = /insert\s+into\s+newsletter\.applied_migration/gi;

describe("nommage", () => {
  test("chaque fichier est NNNN_nom.sql", () => {
    expect(FICHIERS.filter((f) => !/^\d{4}_[a-z0-9_]+\.sql$/.test(f))).toEqual([]);
  });

  /**
   * ⚠️ NUMÉROS RÉSERVÉS PAR UNE BRANCHE PAS ENCORE FUSIONNÉE. Quand plusieurs lots écrivent des
   * migrations en parallèle, chacun prend un numéro d'avance ; la branche qui part la première n'a pas
   * les fichiers des autres. Renuméroter après coup un fichier déjà transmis à la collègue ferait
   * inscrire deux fichiers sous la même version au registre — on réserve donc le numéro ICI.
   *
   * Un trou n'est toléré QUE pour un numéro listé ici, et un numéro présent redevient strict de
   * lui-même. VIDE depuis le 22/09/2026 : 0075-0079 (accès séparés, archivage, expéditeur, relecture
   * d'édition) ont été fusionnés ensemble sur la branche d'intégration.
   *
   * 0081 (24/09/2026) : sécurité de l'inscription et du consentement, écrite en parallèle de 0082
   * (automations) sur une autre branche.
   */
  const RESERVES_HORS_ARBRE = new Set<number>([81]);

  test("numéros uniques et contigus depuis 0001 (trous tolérés : les seuls numéros réservés)", () => {
    const numeros = FICHIERS.map((f) => Number(f.slice(0, 4)));
    const attendus: number[] = [];
    for (let n = 1; n <= Math.max(...numeros); n++) {
      if (!RESERVES_HORS_ARBRE.has(n) || numeros.includes(n)) attendus.push(n);
    }
    expect(numeros).toEqual(attendus);
  });
});

describe("registre applied_migration", () => {
  const soumis = FICHIERS.filter((f) => Number(f.slice(0, 4)) >= PREMIER_REGISTRE);

  test("le banc voit bien les fichiers soumis au registre", () => {
    expect(soumis.length).toBeGreaterThanOrEqual(9);
    expect(soumis[0]).toBe("0062_migration_marker.sql");
  });

  for (const f of soumis) {
    test(`${f} s'inscrit avec SA version et SON nom de fichier, en dernière instruction`, () => {
      const sql = sansCommentaires(lire(f));
      const inserts = [...sql.matchAll(INSERT)];
      expect(inserts.length).toBeGreaterThan(0);
      const dernier = inserts.at(-1)!;
      const suite = sql.slice(dernier.index!);
      // La ligne porte la version et le fichier exacts : un copier-coller de la migration précédente
      // inscrirait la mauvaise version, et le registre mentirait sans erreur.
      const valeurs = suite.slice(0, suite.indexOf(";"));
      expect(valeurs).toContain(`'${f.slice(0, 4)}'`);
      expect(valeurs).toContain(`'${f}'`);
      // Rien d'autre ne suit : une instruction après l'inscription pourrait échouer APRÈS que la
      // migration s'est déclarée appliquée. Seul le rechargement du cache PostgREST est toléré (0062) :
      // un `notify` n'échoue pas.
      const reste = suite.slice(suite.indexOf(";") + 1).replace(/notify\s+pgrst\s*,\s*'reload schema'\s*;/gi, "");
      expect(reste.trim()).toBe("");
    });
  }
});

describe("fichiers qu'un rejeu casserait", () => {
  for (const f of ["0018_builder_media_campaigns_ai.sql", "0019_outbox_context_campaign.sql", "0046_asset_analytics.sql"]) {
    test(`${f} l'annonce en tête`, () => {
      expect(lire(f).startsWith("-- ⛔ NE PAS REJOUER")).toBe(true);
    });
  }

  test("le README n'enseigne pas `supabase db push`", () => {
    const readme = readFileSync(join(import.meta.dir, "README.md"), "utf8");
    const lignes = readme.split("\n").filter((l) => l.includes("db push"));
    expect(lignes.length).toBeGreaterThan(0);
    // README en anglais dans la vitrine : « Never » vaut « Jamais ».
    expect(lignes.filter((l) => !/Jamais|Never/.test(l))).toEqual([]);
  });
});
