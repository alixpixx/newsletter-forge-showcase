/**
 * 0081 — ce que la migration doit dire, lu dans le fichier (aucun accès à la base).
 *
 * ⛔ La migration n'est appliquée nulle part par ce banc : sa preuve d'exécution est sa propre
 * contre-épreuve, qui tourne dans la transaction de l'applicateur. Ici on tient ce qui ne doit pas
 * dériver entre le fichier SQL et le code qui l'appelle — une signature renommée d'un côté ferait
 * répondre « fonction inconnue » à PostgREST, et la limite de débit, qui laisse passer sur panne,
 * disparaîtrait sans bruit.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { limiterInscription, LIMITE_PAR_ADRESSE, LIMITE_PAR_IP } from "../apps/public/src/lib/debit-inscription";
import { SEUIL_REBONDS_MOUS } from "../apps/public/src/app/api/v1/webhooks/mailgun/handler";

const FICHIER = "0081_securite_inscription_consentement_rebonds.sql";
const BRUT = readFileSync(join(import.meta.dir, "migrations", FICHIER), "utf8");
/** Sans commentaires de ligne, blancs écrasés, en minuscules. */
const SQL = BRUT.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").toLowerCase();

/** Le corps d'une fonction, de son `create or replace` au `$$;` qui la ferme. */
function corps(nom: string): string {
  const debut = SQL.indexOf(`create or replace function newsletter.${nom}(`);
  expect(debut).toBeGreaterThan(-1);
  return SQL.slice(debut, SQL.indexOf("$$;", debut));
}

describe("0081 §1 — signup_rate_take", () => {
  const f = corps("signup_rate_take");

  test("⛔ les noms de paramètres SQL sont exactement ceux que le site envoie", async () => {
    const entete = f.slice(f.indexOf("(") + 1, f.indexOf(") returns"));
    const sql = entete.split(",").map((p) => p.trim().split(" ")[0]).sort();

    let envoyes: string[] = [];
    const db = {
      rpc: async (nom: string, args: Record<string, unknown>) => {
        expect(nom).toBe("signup_rate_take");
        envoyes = Object.keys(args).sort();
        return { data: { allowed: true }, error: null };
      },
    };
    await limiterInscription(db as never, { ip: "203.0.113.7", email: "x@example.invalid" });
    expect(sql).toEqual(envoyes);
    expect(sql).toHaveLength(6);
  });

  test("SECURITY DEFINER, search_path figé, verrou par clé, purge au-delà de 48 h", () => {
    expect(f).toContain("security definer");
    expect(f).toContain("set search_path = newsletter, extensions");
    expect(f).toContain("pg_advisory_xact_lock(hashtextextended('signup_rate:address:'");
    expect(f).toContain("pg_advisory_xact_lock(hashtextextended('signup_rate:ip:'");
    expect(f).toContain("interval '48 hours'");
    expect(f).toContain("not between 1 and 172800");
  });

  test("les fenêtres du site tiennent dans la borne SQL (48 h), sinon chaque appel lèverait", () => {
    expect(LIMITE_PAR_ADRESSE.fenetreSecondes).toBeLessThanOrEqual(172800);
    expect(LIMITE_PAR_IP.fenetreSecondes).toBeLessThanOrEqual(172800);
  });

  test("⛔ la place n'est réservée qu'APRÈS les deux contrôles : un refus ne compte pas", () => {
    const insertion = f.indexOf("insert into newsletter.signup_attempt");
    expect(insertion).toBeGreaterThan(f.lastIndexOf("'limited_by', 'ip'"));
    expect(insertion).toBeGreaterThan(f.lastIndexOf("'limited_by', 'address'"));
  });

  test("⛔ fermée aux rôles publics : revoke AVANT grant, et la table sous RLS", () => {
    const revoke = SQL.indexOf("revoke all on function newsletter.signup_rate_take(");
    const grant = SQL.indexOf("grant execute on function newsletter.signup_rate_take(");
    expect(revoke).toBeGreaterThan(-1);
    expect(grant).toBeGreaterThan(revoke);
    expect(SQL.slice(revoke, grant)).toContain("from public, anon, authenticated");
    expect(SQL).toContain("alter table newsletter.signup_attempt enable row level security");
    expect(SQL).toContain("check (key_hash ~ '^[0-9a-f]{64}$')");
  });

  test("la contre-épreuve EXÉCUTE la fonction et efface ses propres lignes", () => {
    expect(SQL).toContain("r := newsletter.signup_rate_take(");
    expect(SQL).toContain("where key_hash = any (v_cles)");
  });
});

describe("0081 §2 — consent_event append-only", () => {
  const f = corps("consent_event_append_only");
  const PERMISES = ["ip_address", "user_agent", "source_url"];

  test("⛔ plus aucun rôle applicatif ne peut UPDATE, DELETE ni TRUNCATE", () => {
    expect(SQL).toContain(
      "revoke update, delete, truncate on newsletter.consent_event from public, anon, authenticated, service_role;",
    );
  });

  test("⛔ deux déclencheurs : ligne (UPDATE, DELETE) et instruction (TRUNCATE), sur la même fonction", () => {
    expect(SQL).toContain(
      "before update or delete on newsletter.consent_event for each row execute function newsletter.consent_event_append_only();",
    );
    expect(SQL).toContain(
      "before truncate on newsletter.consent_event for each statement execute function newsletter.consent_event_append_only();",
    );
  });

  test("le refus lève restrict_violation, et SEULE la mise à NULL des trois PII passe", () => {
    expect(f.split("errcode = 'restrict_violation'")).toHaveLength(3);
    expect(f).toContain(`(to_jsonb(new) - ${PERMISES.map((c) => `'${c}'`).join(" - ")}) = (to_jsonb(old) - ${PERMISES.map((c) => `'${c}'`).join(" - ")})`);
    for (const c of PERMISES) expect(f).toContain(`(new.${c} is null or new.${c} is not distinct from old.${c})`);
  });

  /*
   * ⛔ LE DÉCLENCHEUR NE DOIT PAS CASSER L'EFFACEMENT. Toute écriture de `consent_event` déjà posée
   * par une migration (`erase_subscriber` 0006, `purge_expired_proof` 0016…) ne doit mettre à NULL
   * que des colonnes permises — sinon, après 0081, le droit à l'oubli lèverait.
   */
  test("⛔ chaque UPDATE de consent_event des migrations antérieures reste permis", () => {
    const dir = join(import.meta.dir, "migrations");
    const vus: string[] = [];
    for (const nom of readdirSync(dir).filter((n) => n.endsWith(".sql") && n < "0081")) {
      const sql = readFileSync(join(dir, nom), "utf8").replace(/--[^\n]*/g, "").replace(/\s+/g, " ").toLowerCase();
      for (const m of sql.matchAll(/update newsletter\.consent_event\b(?: \w+)? set (.*?) (?:from|where)\b/g)) {
        for (const affectation of m[1]!.split(",")) {
          const [col, val] = affectation.split("=").map((x) => x.trim());
          vus.push(`${nom}:${col}`);
          expect(PERMISES).toContain(col!);
          expect(val).toBe("null");
        }
      }
    }
    // Contre-épreuve : le relevé voit bien l'effacement et la rétention.
    expect(vus).toContain("0006_compliance_dsar_tracking.sql:ip_address");
    expect(vus).toContain("0016_retention_purge.sql:source_url");
  });

  /*
   * ⛔ LE REVOKE NE DOIT PAS CASSER LE SITE. Aucun code ne doit tenter d'écrire `consent_event`
   * autrement que par INSERT : après 0081, un UPDATE ou un DELETE lèverait en production.
   */
  test("⛔ aucun code applicatif ne modifie ni n'efface consent_event", () => {
    const racine = join(import.meta.dir, "..");
    let appels = 0;
    for (const base of ["apps", "packages"]) {
      for (const rel of readdirSync(join(racine, base), { recursive: true }) as string[]) {
        if (!/\.(ts|tsx)$/.test(rel) || /node_modules|\.next/.test(rel) || /\.test\.tsx?$/.test(rel)) continue;
        const src = readFileSync(join(racine, base, rel), "utf8");
        const trouves = [...src.matchAll(/from\(\s*["']consent_event["']\s*\)([^;]*)/g)];
        appels += trouves.length;
        for (const t of trouves) expect(`${rel}: ${/\.(update|delete|upsert)\(/.test(t[1]!)}`).toBe(`${rel}: false`);
      }
    }
    // Contre-épreuve : le relevé voit les écritures connues (inscription, confirmation, préférences…).
    expect(appels).toBeGreaterThan(5);
  });

  test("la contre-épreuve éprouve sur une vraie ligne : refus d'UPDATE et de DELETE, mise à NULL annulée", () => {
    expect(SQL).toContain("update newsletter.consent_event set method = coalesce(method, '') || '~0081' where id = v_id;");
    expect(SQL).toContain("delete from newsletter.consent_event where id = v_id;");
    expect(SQL.split("exception when restrict_violation then null;")).toHaveLength(3);
    expect(SQL).toContain("raise exception using errcode = 'nf081'");
    expect(SQL).toContain("exception when sqlstate 'nf081' then null;");
  });
});

describe("0081 §3 — rebonds mous", () => {
  test("le seuil écrit sur la colonne est celui du webhook", () => {
    expect(BRUT).toContain(`SEUIL_REBONDS_MOUS = ${SEUIL_REBONDS_MOUS}`);
    expect(SQL).toContain("comment on column newsletter.subscription.soft_bounce_count is");
  });

  test("la contre-épreuve vérifie ce dont le webhook a besoin pour écrire", () => {
    expect(SQL).toContain("has_column_privilege('service_role', 'newsletter.subscription', 'soft_bounce_count', 'update')");
    expect(SQL).toContain("like '%severity%temporary%'");
  });
});

describe("0081 §4 — la suppression pour rebonds mous est levée par une réinscription confirmée", () => {
  const lire = (f: string) =>
    readFileSync(join(import.meta.dir, "migrations", f), "utf8").replace(/--[^\n]*/g, "").replace(/\s+/g, " ").toLowerCase();
  /** Le corps d'une fonction à `$function$`, de son `create or replace` au `$function$;` qui la ferme. */
  const fonction = (sql: string, nom: string) => {
    const debut = sql.indexOf(`create or replace function newsletter.${nom}(`);
    expect(debut).toBeGreaterThan(-1);
    return sql.slice(debut, sql.indexOf("$function$;", debut));
  };
  const M0073 = lire("0073_interactifs_instantanes_reinscription.sql");
  const dure = fonction(SQL, "is_hard_suppressed");
  const levee = fonction(SQL, "lift_voluntary_suppression");
  const PREFIXE = "starts_with(coalesce(reason, ''), 'soft_bounce:')";
  const CLAUSE_DURE = `and not (scope = 'asset' and ${PREFIXE})`;
  const CLAUSE_LEVEE = `or (scope = 'asset' and asset_id = p_asset_id and ${PREFIXE})`;
  const nommes = (texte: string, prefixe: string) => {
    const i = texte.indexOf(prefixe);
    expect(i).toBeGreaterThan(-1);
    return [...texte.slice(i + prefixe.length, texte.indexOf(")", i + prefixe.length)).matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  };

  /**
   * ⛔ LA DOCTRINE DE 0073 : on NOMME les levables, tout le reste est dur (motif nul compris).
   * MUTATIONS QUI DOIVENT LE TUER : retirer la clause ; une sous-chaîne (`strpos`) ; `like` (où `_` est un joker).
   */
  test("`is_hard_suppressed` nomme trois levables : erasure, global_optout, et le PRÉFIXE soft_bounce: par marque", () => {
    expect(nommes(dure, "coalesce(reason, '') not in (")).toEqual(["erasure", "global_optout"]);
    expect(dure).toContain(CLAUSE_DURE);
    for (const lache of [" like ", "strpos", "position(", "'%soft_bounce", " ~ "]) expect(dure).not.toContain(lache);
  });

  /** MUTATION QUI DOIT LE TUER : lever `soft_bounce:` sans la restreindre à la marque confirmée. */
  test("`lift_voluntary_suppression` lève exactement les mêmes motifs, rebonds mous pour la seule marque confirmée", () => {
    expect(nommes(levee, "and (reason in (")).toEqual(nommes(dure, "coalesce(reason, '') not in ("));
    expect(levee).toContain(CLAUSE_LEVEE);
    for (const lache of [" like ", "strpos", "position(", "'%soft_bounce", " ~ "]) expect(levee).not.toContain(lache);
  });

  /** ⛔ Le motif complet d'un rebond embarque le texte du serveur distant, qui cite souvent l'adresse. */
  test("la trace d'une levée écrit `soft_bounce`, jamais le motif complet", () => {
    expect(levee).toContain(`returning case when ${PREFIXE} then 'soft_bounce' else reason end as reason`);
  });

  /** Rien d'autre ne bouge : sans le troisième motif, les deux corps sont ceux de 0073 (identiques à la prod le 24/09). */
  test("hors le troisième motif, les deux fonctions sont celles de 0073, mot pour mot", () => {
    expect(dure.replace(` ${CLAUSE_DURE}`, "")).toBe(fonction(M0073, "is_hard_suppressed"));
    const levee0073 = levee
      .replace(`and (reason in ('erasure', 'global_optout') ${CLAUSE_LEVEE})`, "and reason in ('erasure', 'global_optout')")
      .replace(`returning case when ${PREFIXE} then 'soft_bounce' else reason end as reason`, "returning reason");
    expect(levee0073).toBe(fonction(M0073, "lift_voluntary_suppression"));
  });

  /** Le préfixe levé est celui que le webhook écrit : un renommage d'un côté rendrait la levée muette. */
  test("le webhook écrit bien des motifs qui commencent par `soft_bounce:`", () => {
    const webhook = readFileSync(join(import.meta.dir, "..", "apps/public/src/app/api/v1/webhooks/mailgun/handler.ts"), "utf8");
    expect(webhook).toContain("p_reason: `soft_bounce:${n}:");
  });

  /**
   * ⛔ LES CAS ÉPROUVÉS À L'APPLICATION, sur de vraies lignes. Le banc ne peut pas exécuter le SQL :
   * il tient la LISTE des cas que la contre-épreuve 4 exécute, et le compte qu'elle exige.
   * MUTATION QUI DOIT LE TUER : retirer le rebond dur dont la raison contient « soft_bounce: ».
   */
  test("la contre-épreuve 4 éprouve levable, dur, plainte, nul, sans deux-points, joker, sous-chaîne et portée globale", () => {
    const bloc = BRUT.slice(BRUT.indexOf("CONTRE-ÉPREUVE 4"));
    const cas = [...bloc.matchAll(/\(\s*(?:'([^']*)'|(null))\s*,\s*'(asset|global)'\s*,\s*(true|false)\s*\)/g)].map((m) => [
      m[2] ? null : m[1]!,
      m[3],
      m[4] === "true",
    ]);
    expect(cas).toEqual([
      ["soft_bounce:4:generic", "asset", false],
      ["hard_bounce:no such user", "asset", true],
      ["spam_complaint", "asset", true],
      [null, "asset", true],
      ["soft_bounce", "asset", true],
      ["softXbounce:4", "asset", true],
      ["hard_bounce:550 soft_bounce:1", "asset", true],
      ["soft_bounce:4:generic", "global", true],
    ]);
    expect(bloc).toContain(`v_attendus constant integer := ${cas.length};`);
    expect(bloc).toContain("v_dur := newsletter.is_hard_suppressed(v_email, v_asset);");
    expect(bloc).toContain("v_levees := newsletter.lift_voluntary_suppression(v_email, v_asset, gen_random_uuid());");
  });

  test("la contre-épreuve 4 relit le catalogue : les deux fonctions portent le préfixe, la vue passe par la fonction", () => {
    expect(SQL).toContain("in pg_get_functiondef('newsletter.is_hard_suppressed(text,uuid)'::regprocedure)) = 0");
    expect(SQL).toContain("in pg_get_functiondef('newsletter.lift_voluntary_suppression(text,uuid,uuid)'::regprocedure)) = 0");
    expect(SQL).toContain("position('is_hard_suppressed(' in pg_get_viewdef('newsletter.outbox_context'::regclass)) = 0");
  });
});

describe("0081 — registre", () => {
  test("⛔ l'inscription au registre est la DERNIÈRE instruction, après toutes les contre-épreuves", () => {
    const registre = SQL.indexOf("insert into newsletter.applied_migration");
    expect(registre).toBeGreaterThan(SQL.lastIndexOf("do $$"));
    expect(registre).toBeGreaterThan(SQL.lastIndexOf("$$;"));
    expect(SQL.slice(registre)).toContain("values ('0081', '0081_securite_inscription_consentement_rebonds.sql'");
    expect(SQL.slice(registre).split(";").filter((s) => s.trim() !== "")).toHaveLength(1);
  });
});
