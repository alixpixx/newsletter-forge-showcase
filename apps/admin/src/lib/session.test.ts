/**
 * Le PÉRIMÈTRE d'un compte — ce que lib/session.ts lui laisse voir, marques et templates.
 *
 * ⛔ Ce qui est tenu ici : « All brands » (`all_assets`) et « All templates » (`all_templates`),
 * 0075, sont DEUX décisions indépendantes. Un membre peut avoir une seule marque et tous les
 * templates de cette marque — c'est la demande d'Alix, mot pour mot : « je veux qu'un user ait
 * accès qu'à un domaine mais à tous les templates automatiquement ».
 * « Futurs » ne se prouve qu'en montrant que la liste est RELUE (la table `asset` interrogée à
 * chaque appel, aucune ligne d'octroi consultée), et que « tous les templates » s'exprime par
 * `null` (aucun filtre PAR TEMPLATE) et JAMAIS par `[]`, qui veut dire « aucun ».
 *
 * ⛔ CE QUE `null` NE DIT PAS. Il ne dit pas « tous les templates de la base » : l'appelant
 * applique TOUJOURS, en plus, son filtre de marque. C'est la composition des deux qui donne « tous
 * les templates de MES marques ». Ce banc mesure les deux moitiés : la décision ici, et le filtre
 * de marque par une garde de frontière sur les deux fichiers qui le portent.
 *
 * ⛔ Et une garde de FRONTIÈRE sur l'octroi : il n'est lu qu'à travers ce module. Un nouvel écran
 * qui appellerait `grantedTemplateIds` en direct retomberait sur l'ancien `isSuperAdmin ?` et
 * ignorerait le drapeau sans que rien ne le signale.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fauxDb as fauxDbFile } from "@/lib/testing/faux-db";

// ⚠️ `session.ts` tire `auth.ts`, qui LÈVE à l'import si AUTH_SECRET manque. Même parade que
// `campaigns.test.ts` : poser la variable, puis charger le module dynamiquement.
process.env.AUTH_SECRET = "secret-de-test-uniquement-22092026";
const { canEditTemplate, identiteDuCompte, perimetreDuCompte, templatesVisibles } = await import("./session");

type Requete = { table: string; filtres: Record<string, unknown>; tete: boolean };
type Reponse = { data?: unknown; count?: number; error: null | { message: string } };

/** Double minimal du client Supabase : journalise chaque requête et la table qu'elle vise. */
function fauxDb(repondre: (r: Requete) => Reponse) {
  const journal: Requete[] = [];
  const from = (table: string) => {
    const ctx: Requete = { table, filtres: {}, tete: false };
    const q = {
      select: (_c?: string, o?: { head?: boolean }) => {
        ctx.tete = o?.head === true;
        return q;
      },
      eq: (k: string, v: unknown) => {
        ctx.filtres[k] = v;
        return q;
      },
      then: (resoudre: (v: Reponse) => unknown) => {
        journal.push(ctx);
        return Promise.resolve(resoudre(repondre(ctx)));
      },
    };
    return q;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: { from } as any, journal };
}

const USER = "11111111-1111-1111-1111-111111111111";
const A = "aaaaaaaa-0000-0000-0000-000000000001";
const B = "bbbbbbbb-0000-0000-0000-000000000002";
const NOUVELLE = "cccccccc-0000-0000-0000-000000000003"; // une marque « créée plus tard »
const T1 = "dddddddd-0000-0000-0000-000000000004";
const T_DE_B = "eeeeeeee-0000-0000-0000-000000000005"; // un template de l'AUTRE marque

/** Base où existent trois marques, dont le compte n'en a reçu qu'UNE explicitement. */
const baseMarques = () =>
  fauxDb((r) => {
    if (r.table === "asset") return { data: [{ id: A }, { id: B }, { id: NOUVELLE }], error: null };
    if (r.table === "app_user_asset") return { data: [{ asset_id: A }], error: null };
    return { data: null, error: { message: `table inattendue : ${r.table}` } };
  });

const compte = (allAssets: boolean, allTemplates: boolean) => ({
  id: USER,
  role: "member" as const,
  all_assets: allAssets,
  all_templates: allTemplates,
});

describe("perimetreDuCompte — les marques suivent all_assets, et lui seul", () => {
  test("super_admin : toutes les marques, lues dans `asset`, les deux décisions vraies", async () => {
    const { db, journal } = baseMarques();
    const p = await perimetreDuCompte(db, {
      id: USER,
      role: "super_admin",
      all_assets: false,
      all_templates: false,
    });
    expect(p.seesAllAssets).toBe(true);
    expect(p.seesAllTemplates).toBe(true);
    expect(p.assetIds).toEqual([A, B, NOUVELLE]);
    expect(journal.map((r) => r.table)).toEqual(["asset"]);
  });

  test("membre coché « All brands » : TOUTES les marques, y compris une créée après l'octroi", async () => {
    const { db, journal } = baseMarques();
    const p = await perimetreDuCompte(db, compte(true, false));
    expect(p.seesAllAssets).toBe(true);
    expect(p.assetIds).toEqual([A, B, NOUVELLE]);
    // La liste est RELUE dans `asset`, pas tirée des octrois : c'est ce qui couvre l'avenir. Les
    // lignes explicites (A seule) sont ignorées tant que le drapeau est posé.
    expect(journal.map((r) => r.table)).toEqual(["asset"]);
  });

  test("membre sans aucun drapeau : SES octrois seulement", async () => {
    const { db, journal } = baseMarques();
    const p = await perimetreDuCompte(db, compte(false, false));
    expect(p.seesAllAssets).toBe(false);
    expect(p.seesAllTemplates).toBe(false);
    expect(p.assetIds).toEqual([A]);
    expect(journal).toHaveLength(1);
    expect(journal[0].table).toBe("app_user_asset");
    expect(journal[0].filtres).toEqual({ user_id: USER });
  });

  test("⛔ « All templates » SEUL n'élargit AUCUNE marque — la demande d'Alix, mesurée", async () => {
    const { db, journal } = baseMarques();
    const p = await perimetreDuCompte(db, compte(false, true));
    expect(p.seesAllTemplates).toBe(true);
    expect(p.seesAllAssets).toBe(false);
    // Toujours la seule marque octroyée : ni B, ni la marque créée plus tard.
    expect(p.assetIds).toEqual([A]);
    expect(journal.map((r) => r.table)).toEqual(["app_user_asset"]);
  });

  test("les quatre combinaisons d'un membre, une par une", async () => {
    // ⚠️ Pas de `test.each` dans apps/admin (TS2339) : boucle explicite.
    const cas: { assets: boolean; templates: boolean; marques: string[] }[] = [
      { assets: false, templates: false, marques: [A] },
      { assets: true, templates: false, marques: [A, B, NOUVELLE] },
      { assets: false, templates: true, marques: [A] },
      { assets: true, templates: true, marques: [A, B, NOUVELLE] },
    ];
    for (const c of cas) {
      const p = await perimetreDuCompte(baseMarques().db, compte(c.assets, c.templates));
      expect(p.seesAllAssets).toBe(c.assets);
      expect(p.seesAllTemplates).toBe(c.templates);
      expect(p.assetIds).toEqual(c.marques);
    }
  });
});

describe("templates — le drapeau des TEMPLATES, jamais celui des marques", () => {
  const grantBase = (octroyes: string[]) =>
    fauxDb((r) => {
      if (r.table !== "app_user_template") return { data: null, error: { message: r.table } };
      if (r.tete) {
        const oui = octroyes.includes(String(r.filtres.template_id));
        return { count: oui ? 1 : 0, error: null };
      }
      return { data: octroyes.map((t) => ({ template_id: t })), error: null };
    });

  test("canEditTemplate : membre coché « All templates » ouvre sans lire d'octroi", async () => {
    const { db, journal } = grantBase([]);
    expect(await canEditTemplate({ id: USER, seesAllTemplates: true }, T1, db)).toBe(true);
    expect(journal).toHaveLength(0);
  });

  test("⛔ canEditTemplate : « All brands » SEUL n'ouvre aucun template", async () => {
    // Le mutant « canEditTemplate lit le drapeau des marques » meurt ici : un membre qui voit
    // toutes les marques mais aucun template en grand doit retomber sur ses octrois.
    const { db, journal } = grantBase([]);
    expect(await canEditTemplate({ id: USER, seesAllTemplates: false }, T1, db)).toBe(false);
    expect(journal).toHaveLength(1);
    expect(journal[0].table).toBe("app_user_template");
  });

  test("canEditTemplate : membre sans le drapeau — seulement le template octroyé", async () => {
    const oui = grantBase([T1]);
    expect(await canEditTemplate({ id: USER, seesAllTemplates: false }, T1, oui.db)).toBe(true);
    expect(oui.journal[0].filtres).toEqual({ user_id: USER, template_id: T1 });

    const non = grantBase([]);
    expect(await canEditTemplate({ id: USER, seesAllTemplates: false }, T1, non.db)).toBe(false);
  });

  test("canEditTemplate : sans base, un membre sans le drapeau est REFUSÉ (fail closed)", async () => {
    expect(await canEditTemplate({ id: USER, seesAllTemplates: false }, T1, null)).toBe(false);
  });

  test("templatesVisibles : « All templates » rend null (aucun filtre) — jamais [] qui voudrait dire « aucun »", async () => {
    const { db, journal } = grantBase([T1]);
    const v = await templatesVisibles({ id: USER, seesAllTemplates: true }, db);
    expect(v).toBeNull();
    expect(journal).toHaveLength(0);
  });

  test("⛔ templatesVisibles : « All brands » SEUL ne lève pas le filtre des templates", async () => {
    // Le mutant « templatesVisibles lit le drapeau des marques » meurt ici.
    const { db } = grantBase([T1]);
    expect(await templatesVisibles({ id: USER, seesAllTemplates: false }, db)).toEqual([T1]);
  });

  test("templatesVisibles : sans le drapeau, les octrois explicites et eux seuls", async () => {
    const { db } = grantBase([T1]);
    expect(await templatesVisibles({ id: USER, seesAllTemplates: false }, db)).toEqual([T1]);
    const vide = grantBase([]);
    expect(await templatesVisibles({ id: USER, seesAllTemplates: false }, vide.db)).toEqual([]);
  });
});

describe("⛔ une marque + tous les templates : tout de A, RIEN de B", () => {
  /**
   * C'est le cas d'usage d'Alix, et c'est aussi celui où une fuite serait la plus coûteuse. Il
   * repose sur DEUX moitiés, mesurées séparément parce qu'elles vivent dans deux fichiers :
   *   1. ICI : le périmètre de marques reste `[A]`, et le filtre PAR TEMPLATE est levé (`null`).
   *   2. PLUS BAS (garde de frontière) : toute lecture de template porte `asset_id`, et la marque
   *      courante est choisie dans `assetIds`. Ces deux lignes de code sont ce qui empêche `null`
   *      de devenir « tous les templates de la base ».
   */
  test("le périmètre : marque A seule, aucun filtre par template", async () => {
    const { db } = baseMarques();
    const p = await perimetreDuCompte(db, compte(false, true));
    expect(p.assetIds).toEqual([A]);
    expect(p.assetIds).not.toContain(B);

    const t = await templatesVisibles({ id: USER, seesAllTemplates: p.seesAllTemplates }, db);
    expect(t).toBeNull();
  });

  test("T_DE_B n'est atteignable que par la marque B, et la marque B n'est pas dans le périmètre", async () => {
    const { db } = baseMarques();
    const p = await perimetreDuCompte(db, compte(false, true));
    // `canEditTemplate` dit « oui » à n'importe quel id — y compris T_DE_B. Ce n'est PAS une fuite :
    // aucun appelant ne l'atteint sans avoir d'abord résolu le template DANS la marque courante
    // (`findTemplate`, `getTemplateWithDraft`, `loadTemplate`), et la marque courante sort de
    // `assetIds`. Le test suivant tient cette phrase sur les fichiers eux-mêmes.
    expect(await canEditTemplate({ id: USER, seesAllTemplates: p.seesAllTemplates }, T_DE_B, db)).toBe(true);
    expect(p.assetIds.includes(B)).toBe(false);
  });
});

describe("frontière — l'octroi de template et le filtre de marque", () => {
  const RACINE = join(import.meta.dir, "..");
  const sources: string[] = [];
  const parcourir = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) parcourir(p);
      else if (/\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n)) sources.push(p);
    }
  };
  parcourir(RACINE);

  const sansCommentaires = (f: string) =>
    readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  test("le banc voit bien les sources de l'admin", () => {
    expect(sources.length).toBeGreaterThan(50);
  });

  test("aucun appel à grantedTemplateIds / hasTemplateGrant hors de session.ts", () => {
    const AUTORISES = new Set(["lib/session.ts", "lib/data/app-user.ts"]);
    const fautifs: string[] = [];
    for (const f of sources) {
      const rel = relative(RACINE, f).split(sep).join("/");
      if (AUTORISES.has(rel)) continue;
      // Les commentaires ne comptent pas : seul un APPEL contourne le drapeau.
      if (/\b(grantedTemplateIds|hasTemplateGrant)\s*\(/.test(sansCommentaires(f))) fautifs.push(rel);
    }
    expect(fautifs).toEqual([]);
  });

  test("⛔ la liste des templates reste filtrée par MARQUE — c'est ce qui borne « All templates »", () => {
    const code = sansCommentaires(join(RACINE, "lib", "data", "templates.ts"));
    // ⚠️ On découpe le corps de `listTemplatesRead` : chercher dans TOUT le fichier laisserait
    // passer le retrait du filtre ici, parce que `findTemplate` porte le même appel plus bas.
    const debut = code.indexOf("export async function listTemplatesRead(");
    expect(debut).toBeGreaterThan(-1);
    const suite = code.indexOf("\nexport ", debut + 1);
    const corps = code.slice(debut, suite > -1 ? suite : undefined);
    // `listTemplatesRead` lève le filtre par template quand `templatesVisibles` rend null ; sans
    // cette ligne, « tous les templates » deviendrait « ceux de toutes les marques ».
    expect(corps).toContain('.eq("asset_id", assetId)');
  });

  test("⛔ la marque courante est choisie DANS le périmètre du compte", () => {
    const code = sansCommentaires(join(RACINE, "lib", "asset-context.ts"));
    // Sans ce filtre, un membre pourrait se poser sur une marque qu'il ne voit pas, et « tous les
    // templates » lui en ouvrirait le contenu.
    expect(code).toContain('.in("id", u.assetIds)');
  });
});

/**
 * ⛔ CHANGER UN MOT DE PASSE FERME LES AUTRES SESSIONS (0091, 01/10/2026) — ici, au seul endroit
 * où une session vérifiée devient une identité. `sessionPerimee` est éprouvée seule dans
 * auth.test.ts ; ce banc prouve qu'elle est BIEN CONSULTÉE : retirer son appel de
 * `identiteDuCompte` laissait toute la suite verte.
 */
describe("identiteDuCompte — une session antérieure au changement de mot de passe ne vaut rien", () => {
  const UID = "11111111-1111-4111-8111-111111111111";
  const CHANGE = "2026-10-01T18:30:00.000Z";
  const T = Date.parse(CHANGE);
  const compte = (password_changed_at: string | null) => ({
    id: UID,
    email: "moi@example.com",
    role: "member",
    status: "active",
    all_assets: false,
    all_templates: false,
    password_hash: "x",
    password_changed_at,
  });
  // 1re réponse : le compte (findById) ; 2e : ses marques (grantedAssetIds).
  const base = (ligne: unknown) =>
    fauxDbFile<Parameters<typeof identiteDuCompte>[0]>(
      { data: ligne, error: null },
      { data: [{ asset_id: "aaaaaaaa-0000-4000-8000-000000000001" }], error: null },
    ).db;

  test("aucun changement daté : la session vaut, même sans iat", async () => {
    expect((await identiteDuCompte(base(compte(null)), { uid: UID }))?.id).toBe(UID);
  });

  test("⛔ session émise AVANT le changement : refusée", async () => {
    expect(await identiteDuCompte(base(compte(CHANGE)), { uid: UID, iat: T - 1 })).toBe(null);
  });

  test("⛔ cookie sans iat (d'avant 0091) après un changement : refusé", async () => {
    expect(await identiteDuCompte(base(compte(CHANGE)), { uid: UID })).toBe(null);
  });

  test("session émise APRÈS le changement (le cookie neuf de la personne) : acceptée", async () => {
    expect((await identiteDuCompte(base(compte(CHANGE)), { uid: UID, iat: T + 1 }))?.id).toBe(UID);
  });
});
