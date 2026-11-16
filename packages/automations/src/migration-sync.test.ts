/**
 * LE CATALOGUE ET LA MIGRATION 0082 DISENT LA MÊME CHOSE.
 *
 * ⛔ POURQUOI. Les règles d'éligibilité existent DEUX fois : en TypeScript (`catalog.ts`, qui sert
 * l'aperçu, la validation et les tests) et en SQL (`automation_due`, qui sélectionne et écrit). Ce
 * test relit le TEXTE de la migration et rougit dès qu'une liste, une borne ou une clé de payload
 * diverge — sans base : la migration n'a jamais tourné, et ce dépôt n'a aucune base jetable.
 *
 * ⚠️ Ce qu'il NE prouve PAS : que le SQL se comporte comme le TypeScript. Il prouve que les constantes
 * partagées sont les mêmes. L'équivalence des gardes se relit à l'œil (chaque condition SQL porte en
 * commentaire le nom de sa garde) et s'éprouvera sur une copie de la base avant application.
 *
 * ⚠️ Chaque extraction vérifie d'abord qu'elle a TROUVÉ quelque chose : une regex qui ne matche plus
 * rendrait `[]`, et `[]` comparé à `[]` passerait en silence.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AUTOMATION_STATUSES,
  EVENT_HORIZON_DAYS,
  LABEL_SLUG_RE,
  MIN_STEP_GAP_HOURS,
  PURPOSES,
  TRIGGERS,
  TRIGGER_IDS,
  TX_TRIGGER_STATUS,
  VARIABLES,
} from "./catalog";
import { maskEmail } from "./mask";
import { DAILY_CAP_MAX } from "./validate";

const SQL = readFileSync(
  fileURLToPath(new URL("../../../supabase/migrations/0082_automations.sql", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

/** Corps de `automation_due`, entre ses deux `$$`. */
const CORPS = (() => {
  const debut = SQL.indexOf("create or replace function newsletter.automation_due(");
  const ouvre = SQL.indexOf("as $$", debut);
  const ferme = SQL.indexOf("$$;", ouvre + 5);
  return debut >= 0 && ouvre > debut && ferme > ouvre ? SQL.slice(ouvre + 5, ferme) : "";
})();

/** `'a', 'b'` → `["a", "b"]`, trié. */
function liste(texte: string | undefined): string[] {
  return [...(texte ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string).sort();
}

/** Le premier groupe de `re` dans `src`, ou échec EXPLICITE si la regex ne trouve rien. */
function extraire(src: string, re: RegExp, quoi: string): string {
  const m = src.match(re);
  if (!m || m[1] === undefined) throw new Error(`0082 : ${quoi} introuvable (regex à mettre à jour ?)`);
  return m[1];
}

const tri = (xs: readonly string[]) => [...xs].sort();
const MARKETING = tri(TRIGGER_IDS.filter((t) => TRIGGERS[t].policy === "marketing"));

describe("0082 ⇄ catalog.ts", () => {
  test("le corps de la fonction est trouvé", () => {
    expect(CORPS.length).toBeGreaterThan(5000);
  });

  test("la liste FERMÉE des déclencheurs est la même en base", () => {
    const sql = liste(extraire(SQL, /check \(trigger in \(([^)]*)\)\)/, "CHECK de automation.trigger"));
    expect(sql).toHaveLength(TRIGGER_IDS.length);
    expect(sql).toEqual(tri(TRIGGER_IDS));
  });

  test("les déclencheurs que la fonction exécute sont ceux que le catalogue dit exécutables", () => {
    const sql = liste(extraire(CORPS, /if a\.trigger not in \(([^)]*)\) then\s*\n\s*reason := 'no_engine'/, "liste no_engine"));
    expect(sql).toEqual(tri(TRIGGER_IDS.filter((t) => TRIGGERS[t].engine)));
  });

  test("⛔ la liste marketing est la même aux TROIS endroits du SQL (finalité exigée / interdite / porte)", () => {
    const exigee = liste(extraire(SQL, /or trigger not in \(([^)]*)\)\s*\n\s*or purpose is not null/, "automation_marketing_purpose"));
    const interdite = liste(extraire(SQL, /trigger in \(([^)]*)\)\s*\n\s*or purpose is null/, "automation_non_marketing_no_purpose"));
    const porte = liste(extraire(CORPS, /v_marketing := a\.trigger in \(([^)]*)\)/, "v_marketing"));
    expect(MARKETING.length).toBeGreaterThan(0);
    expect(exigee).toEqual(MARKETING);
    expect(interdite).toEqual(MARKETING);
    expect(porte).toEqual(MARKETING);
  });

  test("⛔ l'exception transactionnelle est bornée aux MÊMES déclencheurs que la porte du worker", () => {
    const bloc = extraire(SQL, /add constraint email_outbox_automation_tx_trigger\s*\n\s*check \(([\s\S]*?)\);/, "email_outbox_automation_tx_trigger");
    const sql = [...bloc.matchAll(/'automation_trigger', ''\) = '([a-z_]+)'/g)].map((m) => m[1] as string).sort();
    expect(sql).toEqual(tri(Object.keys(TX_TRIGGER_STATUS)));
    // et la fonction émet `automation_tx` pour exactement ceux-là
    const kind = liste(extraire(CORPS, /when a\.trigger in \(([^)]*)\) then 'automation_tx'/, "v_kind automation_tx"));
    expect(kind).toEqual(tri(Object.keys(TX_TRIGGER_STATUS)));
  });

  test("statuts, finalités, plafond", () => {
    expect(liste(extraire(SQL, /check \(status in \(([^)]*)\)\)/, "CHECK de automation.status"))).toEqual(tri(AUTOMATION_STATUSES));
    expect(liste(extraire(SQL, /check \(purpose is null or purpose in \(([^)]*)\)\)/, "CHECK de automation.purpose"))).toEqual(tri(PURPOSES));
    expect(Number(extraire(SQL, /check \(daily_cap between 1 and (\d+)\)/, "borne du plafond"))).toBe(DAILY_CAP_MAX);
  });

  test("nombre d'étapes : la base accepte au moins ce que le catalogue permet", () => {
    const max = Number(extraire(SQL, /jsonb_array_length\(steps\) <= (\d+)/, "borne des étapes"));
    for (const t of TRIGGER_IDS) expect(TRIGGERS[t].steps.max).toBeLessThanOrEqual(max);
  });

  test("horizon des événements et écart minimal entre étapes", () => {
    expect(Number(extraire(CORPS, /v_horizon\s+constant interval := interval '(\d+) days'/, "v_horizon"))).toBe(EVENT_HORIZON_DAYS);
    expect(Number(extraire(CORPS, /v_min_gap\s+constant interval := interval '(\d+) hours'/, "v_min_gap"))).toBe(MIN_STEP_GAP_HOURS);
  });

  test("⛔ aucun délai événementiel ne dépasse l'horizon (sinon le curseur sauterait l'événement)", () => {
    for (const t of ["preferences_updated", "welcome_back", "optin_promo", "confirmation_reminder"] as const) {
      expect(TRIGGERS[t].steps.maxDelayHours).toBeLessThan(EVENT_HORIZON_DAYS * 24);
    }
  });

  test("réglages : mêmes défauts et mêmes bornes en SQL", () => {
    const entiers: Array<[string, string, string]> = [
      ["sunset", "grace_days", "v_grace"],
      ["anniversary", "catchup_days", "v_catchup"],
      ["consent_renewal", "months", "v_months"],
    ];
    for (const [t, cle, variable] of entiers) {
      const spec = TRIGGERS[t as keyof typeof TRIGGERS].settings[cle];
      expect(spec).not.toBeUndefined();
      if (!spec) continue;
      expect(CORPS).toContain(`coalesce((a.settings->>'${cle}')::integer, ${spec.default})`);
      expect(CORPS).toContain(`${variable} not between ${spec.min} and ${spec.max}`);
    }
    const booleens: Array<[string, string]> = [
      ["reengagement", "include_untracked"],
      ["sunset", "require_reengagement"],
    ];
    for (const [t, cle] of booleens) {
      const spec = TRIGGERS[t as keyof typeof TRIGGERS].settings[cle];
      expect(spec).not.toBeUndefined();
      if (!spec) continue;
      expect(CORPS).toContain(`coalesce((a.settings->>'${cle}')::boolean, ${spec.default})`);
    }
  });

  test("⛔ chaque variable annoncée « écrite au payload » l'est vraiment par la fonction", () => {
    const cles: string[] = [];
    for (const v of Object.values(VARIABLES)) {
      if ("payloadKey" in v && typeof v.payloadKey === "string") cles.push(v.payloadKey);
    }
    expect(cles.length).toBeGreaterThan(5);
    for (const k of cles) expect(`${k}:${CORPS.includes(`'${k}'`)}`).toBe(`${k}:true`);
  });

  test("⛔ la serrure SQL : seule une automation `live`, avec l'accord du worker, atteint la file", () => {
    expect(CORPS).toContain("if a.status not in ('simulation', 'live') then reason := 'not_armed'");
    expect(CORPS).toContain("if a.status = 'live' and not coalesce(p_live_allowed, false) then");
    // Le mode se décide sur le STATUT, jamais sur le drapeau du worker.
    expect(CORPS).toContain("v_simulated := a.status <> 'live';");
    const sonde = CORPS.indexOf("if p_probe then reason := 'probe'; return next; return; end if;");
    const trace = CORPS.indexOf("insert into newsletter.automation_send");
    const simulation = CORPS.indexOf("if v_simulated then reason := 'simulated'; return next; return; end if;");
    const file = CORPS.indexOf("insert into newsletter.email_outbox");
    expect(sonde).toBeGreaterThan(0);
    // sonde → trace → retour de la simulation → file : dans CET ordre, et une seule écriture de file.
    expect(trace).toBeGreaterThan(sonde);
    expect(simulation).toBeGreaterThan(trace);
    expect(file).toBeGreaterThan(simulation);
    expect(CORPS.split("insert into newsletter.email_outbox")).toHaveLength(2);
  });

  test("⛔ les abonnés de démonstration sont retirés pour TOUS les déclencheurs (ceinture et bretelles)", () => {
    expect(CORPS).toMatch(/delete from _auto_cand c\s+using newsletter\.subscription s, newsletter\.subscriber sub\s+where s\.id = c\.subscription_id and sub\.id = s\.subscriber_id and sub\.is_demo;/);
  });

  test("⛔ l'échantillon de l'aperçu sort MASQUÉ de la base, en sonde seulement, et comme `maskEmail`", () => {
    const expr = "left(split_part(c.email, '@', 1), 3) || '…@' || split_part(c.email, '@', 2)";
    expect(SQL).toContain("sample     text[]");
    // Une seule affectation, dans le bloc de la sonde, AVANT son retour.
    expect(CORPS.split("sample := array(")).toHaveLength(2);
    const affectation = CORPS.indexOf("sample := array(");
    const blocSonde = CORPS.lastIndexOf("if p_probe then", affectation);
    const retourSonde = CORPS.indexOf("if p_probe then reason := 'probe'; return next; return; end if;");
    expect(blocSonde).toBeGreaterThan(0);
    expect(affectation - blocSonde).toBeLessThan(40);
    expect(retourSonde).toBeGreaterThan(affectation);
    expect(CORPS.slice(affectation, retourSonde)).toContain(expr);
    // La contre-épreuve relit la même expression.
    expect(SQL).toContain("not like '%left(split_part(c.email, ''@'', 1), 3) || ''…@''%'");
    // Le masque TypeScript des journaux rend ce que rend l'expression SQL.
    expect(maskEmail("abcdef@exemple.com")).toBe("abc…@exemple.com");
    expect(maskEmail("ab@x.io")).toBe("ab…@x.io");
    expect(maskEmail("a@b@c")).toBe("a…@b");
  });

  test("⛔ `status_changed_at` existe, non nul : sans elle, « la simulation a tourné » ne se prouve pas", () => {
    expect(SQL).toMatch(/status_changed_at timestamptz not null default now\(\)/);
    expect(SQL).toContain("column_name = 'status_changed_at' and is_nullable = 'NO'");
  });

  test("⛔ le registre est la DERNIÈRE instruction, après la contre-épreuve", () => {
    const registre = SQL.lastIndexOf("insert into newsletter.applied_migration");
    expect(registre).toBeGreaterThan(SQL.lastIndexOf("contre-epreuve OK"));
    expect(SQL.slice(registre)).toContain("'0082'");
    expect(SQL.slice(SQL.indexOf(";", SQL.indexOf("backfilled = false", registre)) + 1).trim()).toBe("");
  });
});

/**
 * ⛔ LA DÉFINITION EN VIGUEUR EST CELLE DE 0095, PAS CELLE DE 0082. Les tests ci-dessus relisent 0082 :
 * ils ne restent vrais que si 0090 est 0082 à UNE ligne près (la garde `returning`), si 0095 est 0090
 * à ses remplacements déclarés près (le filtre `labels`, bloc suivant), et si aucune autre migration ne
 * redéfinit la fonction. Une nouvelle redéfinition doit mettre ce fichier à jour.
 */
describe("0090 ⇄ 0082 : une seule garde change", () => {
  const DOSSIER = fileURLToPath(new URL("../../../supabase/migrations/", import.meta.url));
  const corps = (sql: string) => {
    const debut = sql.indexOf("create or replace function newsletter.automation_due(");
    const ferme = sql.indexOf("\n$$;", debut);
    return debut >= 0 && ferme > debut ? sql.slice(debut, ferme) : "";
  };
  const SQL_0090 = readFileSync(`${DOSSIER}0090_welcome_back_retour_newsletter.sql`, "utf8").replace(/\r\n/g, "\n");
  const AVANT = "                and p.event_type in ('unsubscribe', 'deletion_request')))         -- returning";
  const APRES =
    "                and (p.event_type in ('unsubscribe', 'deletion_request')\n" +
    "                     or (p.event_type = 'withdrawn' and p.purpose = 'content'))))  -- returning";

  test("0090 recopie 0082 et ne change que la garde `returning`", () => {
    const c82 = corps(SQL);
    expect(c82.split(AVANT)).toHaveLength(2);
    expect(corps(SQL_0090)).toBe(c82.replace(AVANT, APRES));
  });

  test("aucune autre migration ne redéfinit `automation_due`", () => {
    const redefinissent = readdirSync(DOSSIER)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => readFileSync(`${DOSSIER}${f}`, "utf8").includes("create or replace function newsletter.automation_due("));
    expect(redefinissent.sort()).toEqual([
      "0082_automations.sql",
      "0090_welcome_back_retour_newsletter.sql",
      "0095_label_d_automation.sql",
    ]);
  });
});

/**
 * ⛔ 0095 = 0090 + LES REMPLACEMENTS QU'ELLE DÉCLARE, ET RIEN D'AUTRE. Les paires (avant, après) sont
 * relues DANS la migration (les tableaux `v_avant` / `v_nouveau` de sa contre-épreuve) : la base et ce
 * banc vérifient donc la même liste.
 */
describe("0095 ⇄ 0090 : le filtre labels, par remplacements déclarés", () => {
  const DOSSIER = fileURLToPath(new URL("../../../supabase/migrations/", import.meta.url));
  const lire = (f: string) => readFileSync(`${DOSSIER}${f}`, "utf8").replace(/\r\n/g, "\n");
  const SQL_0090 = lire("0090_welcome_back_retour_newsletter.sql");
  const SQL_0095 = lire("0095_label_d_automation.sql");
  const corps = (sql: string) => {
    const debut = sql.indexOf("create or replace function newsletter.automation_due(");
    const ferme = sql.indexOf("\n$$;", debut);
    return debut >= 0 && ferme > debut ? sql.slice(debut, ferme) : "";
  };
  const paires = (prefixe: "a" | "b") =>
    [...SQL_0095.matchAll(new RegExp(`\\$${prefixe}(\\d+)\\$([\\s\\S]*?)\\$${prefixe}\\1\\$`, "g"))].map((m) => [
      Number(m[1]),
      m[2] as string,
    ]) as [number, string][];
  const AVANT = paires("a");
  const APRES = paires("b");

  test("les paires sont trouvées, numérotées 1..N dans les deux tableaux", () => {
    expect(AVANT.length).toBe(6);
    expect(AVANT.map(([n]) => n)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(APRES.map(([n]) => n)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("0095 recopie 0090 et n'applique que ses remplacements, chacun trouvé UNE fois", () => {
    let attendu = corps(SQL_0090);
    expect(attendu.length).toBeGreaterThan(5000);
    AVANT.forEach(([n, avant], i) => {
      expect(`${n}:${attendu.split(avant).length - 1}`).toBe(`${n}:1`);
      attendu = attendu.replace(avant, APRES[i]![1]);
    });
    expect(corps(SQL_0095)).toBe(attendu);
  });

  test("l'empreinte attendue par 0095 est celle du corps de 0090", () => {
    const debut = SQL_0090.indexOf("as $$", SQL_0090.indexOf("create or replace function newsletter.automation_due(")) + 5;
    const prosrc = SQL_0090.slice(debut, SQL_0090.indexOf("$$;", debut));
    expect(SQL_0095).toContain(`'${createHash("md5").update(prosrc).digest("hex")}'`);
  });

  test("le filtre labels est lu, appliqué à tous, et `optin_promo` l'accepte à la place d'un opt-in", () => {
    const c = corps(SQL_0095);
    expect(c).toContain("v_labels    := array(select lower(btrim(x)) from jsonb_array_elements_text(coalesce(a.filters->'labels', '[]'::jsonb)) x);");
    expect(c).toContain("if a.trigger = 'optin_promo' and cardinality(v_optins) = 0 and cardinality(v_labels) = 0 then");
    expect(c).toContain("and ce.automation_label = any(v_labels)");
    // Le refus s'appelle toujours `missing_optin_filter` : l'écran de l'admin le traduit déjà.
    expect(c).toContain("reason := 'missing_optin_filter'");
  });

  test("le slug a la même forme dans le catalogue et dans les DEUX contraintes de 0095", () => {
    expect(SQL_0095).toContain(`constraint automation_label_slug_format check (slug ~ '${LABEL_SLUG_RE.source}')`);
    expect(SQL_0095).toContain(`check (automation_label is null or automation_label ~ '${LABEL_SLUG_RE.source}')`);
    expect(TRIGGERS.optin_promo.requiredFilter).toEqual(["optin_ids", "labels"]);
  });

  test("⛔ le registre est la DERNIÈRE instruction, après la contre-épreuve", () => {
    const registre = SQL_0095.lastIndexOf("insert into newsletter.applied_migration");
    expect(registre).toBeGreaterThan(SQL_0095.lastIndexOf("contre-epreuve 3 OK"));
    expect(SQL_0095.slice(registre)).toContain("'0095'");
    expect(SQL_0095.slice(SQL_0095.indexOf(";", SQL_0095.indexOf("backfilled = false", registre)) + 1).trim()).toBe("");
  });
});
