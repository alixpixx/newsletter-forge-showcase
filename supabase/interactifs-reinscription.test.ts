/**
 * 0073 — ce que la migration doit dire, lu dans le fichier (aucun accès à la base).
 *
 * Deux listes y vivent, et chacune a une JUMELLE ailleurs qu'on ne doit pas laisser diverger :
 *   · les kinds INTERACTIFS de `claim_outbox_interactive` = ceux que `claim_outbox` met en tête (0057) ;
 *   · les motifs VOLONTAIRES qu'une réinscription lève = ceux que `is_hard_suppressed` ignore.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const lire = (f: string) =>
  readFileSync(join(import.meta.dir, "migrations", f), "utf8")
    .replace(/--[^\n]*/g, "")
    .replace(/\s+/g, " ");
const M0057 = lire("0057_lifecycle_sunset.sql");
const M0073 = lire("0073_interactifs_instantanes_reinscription.sql");

/** Le corps d'une fonction, de son `create or replace` au `$function$;` qui la ferme. */
function corps(sql: string, nom: string): string {
  const debut = sql.indexOf(`create or replace function newsletter.${nom}(`);
  expect(debut).toBeGreaterThan(-1);
  return sql.slice(debut, sql.indexOf("$function$;", debut));
}

/** Les littéraux d'une liste `in ('a', 'b')` qui suit `prefixe`. */
function liste(texte: string, prefixe: string): string[] {
  const i = texte.indexOf(prefixe);
  expect(i).toBeGreaterThan(-1);
  const brut = texte.slice(i + prefixe.length, texte.indexOf(")", i + prefixe.length));
  return [...brut.matchAll(/'([^']+)'/g)].map((m) => m[1]!).sort();
}

describe("0073 — claim_outbox_interactive", () => {
  const f = corps(M0073, "claim_outbox_interactive");

  /**
   * ⛔ MÊMES KINDS QUE LE TRI DE 0057. Un kind prioritaire là-bas mais absent ici attendrait de nouveau
   * derrière les newsletters ; un kind ici mais pas là-bas serait une masse qui double la file.
   * MUTATION QUI DOIT LE TUER : ajouter `'campaign'` à la liste de 0073.
   */
  test("réclame exactement les kinds que 0057 place en tête", () => {
    const interactifs0057 = liste(corps(M0057, "claim_outbox"), "when c.kind in (");
    expect(interactifs0057).toEqual(["confirmation", "test", "unsubscribe_ack", "welcome"]);
    expect(liste(f, "and c.kind in (")).toEqual(interactifs0057);
  });

  test("garde les attributs de sûreté de `claim_outbox` : SECURITY DEFINER et search_path figé", () => {
    expect(f).toContain("security definer");
    expect(f).toContain("set search_path to 'newsletter', 'extensions'");
    expect(f).toContain("for update skip locked");
  });
});

describe("0073 — ce qu'une réinscription lève, et ce qu'elle ne lève jamais", () => {
  const dure = corps(M0073, "is_hard_suppressed");
  const levee = corps(M0073, "lift_voluntary_suppression");

  /**
   * ⛔ LE SENS DU DÉFAUT : on nomme les motifs LEVABLES, tout le reste est dur — motif nul compris.
   * MUTATION QUI DOIT LE TUER : `reason in ('hard_bounce', 'spam_complaint')` (liste des durs) —
   * un motif inconnu ou nul deviendrait levable.
   */
  test("`is_hard_suppressed` exclut les deux motifs volontaires, et SEULEMENT eux, motif nul compris", () => {
    expect(liste(dure, "coalesce(reason, '') not in (")).toEqual(["erasure", "global_optout"]);
  });

  /** MUTATION QUI DOIT LE TUER : ajouter `'spam_complaint'` aux motifs levés. */
  test("`lift_voluntary_suppression` ne supprime que ces deux mêmes motifs", () => {
    expect(liste(levee, "and reason in (")).toEqual(liste(dure, "coalesce(reason, '') not in ("));
  });

  test("la levée laisse une trace dans audit_log, sans l'adresse", () => {
    expect(levee).toContain("insert into newsletter.audit_log");
    expect(levee).toContain("'suppression-lifted'");
    const trace = levee.slice(levee.indexOf("insert into newsletter.audit_log"));
    expect(trace).not.toContain("p_email");
  });

  test("les trois fonctions sont retirées à PUBLIC avant d'être accordées à service_role", () => {
    for (const nom of ["claim_outbox_interactive", "is_hard_suppressed", "lift_voluntary_suppression"]) {
      const iRevoke = M0073.indexOf(`revoke all on function newsletter.${nom}(`);
      const iGrant = M0073.indexOf(`grant execute on function newsletter.${nom}(`);
      expect(iRevoke).toBeGreaterThan(-1);
      expect(iGrant).toBeGreaterThan(iRevoke);
    }
  });

  /** ⛔ La vue garde `suppressed` : welcome et campagnes restent gardés par la suppression complète. */
  test("outbox_context garde `suppressed` et ajoute `hard_suppressed` en dernière colonne", () => {
    const vue = M0073.slice(M0073.indexOf("create or replace view newsletter.outbox_context"));
    expect(vue).toContain("newsletter.is_suppressed(o.to_email::text, o.asset_id) AS suppressed");
    expect(vue).toContain(
      "ltv.subject AS lifecycle_subject, newsletter.is_hard_suppressed(o.to_email::text, o.asset_id) AS hard_suppressed FROM",
    );
  });
});
