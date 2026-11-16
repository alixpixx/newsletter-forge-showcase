/**
 * Banc de la couche d'accès aux comptes (`newsletter.app_user` et ses deux tables d'octroi).
 *
 * Ce qui est prouvé ici ne se voit pas à la lecture d'un écran : la FORME des requêtes émises.
 * Trois propriétés valent d'être tenues, et chacune a déjà été perdue ailleurs dans ce dépôt :
 *
 *  1. Réconcilier n'est pas « tout effacer puis tout réécrire ». Un octroi conservé doit garder
 *     sa ligne — donc son `granted_at` et son `granted_by`, la trace de qui a donné quoi.
 *  2. Consommer une invitation doit être NON REJOUABLE. C'est le filtre `status = 'invited'` qui
 *     le garantit, et un filtre ne se voit dans aucun rendu.
 *  3. Un update qui ne touche aucune ligne RÉUSSIT en silence (le piège de `template_restore`).
 *     Il faut donc relire la ligne écrite pour distinguer « fait » de « rien ne correspondait ».
 *
 * Le double client Supabase enregistre chaque requête au moment où elle est attendue, avec ses
 * filtres : les assertions portent sur ce journal, pas sur une valeur de retour arrangée.
 */
import { describe, expect, test } from "bun:test";

const { acceptInvite, CHAMPS, createUser, findById, listUsers, setAssets, setPassword, setTemplates, updateUser } =
  await import("./app-user");

type Requete = {
  table: string;
  op: "select" | "insert" | "update" | "delete";
  filtres: Record<string, unknown>;
  charge?: unknown;
  /** Les colonnes demandées au dernier `.select(...)` de la chaîne. */
  colonnes?: string;
};

type Reponse = { data: unknown; error: null | { message: string } };

/** Double du client Supabase : chaîne les mêmes appels, et journalise ce qui part réellement. */
function fauxDb(repondre: (r: Requete) => Reponse) {
  const journal: Requete[] = [];

  const from = (table: string) => {
    const ctx: Requete = { table, op: "select", filtres: {} };

    const terminer = (): Reponse => {
      journal.push(ctx);
      return repondre(ctx);
    };

    const q = {
      select: (c?: string) => {
        if (c !== undefined) ctx.colonnes = c;
        return q;
      },
      insert: (rows: unknown) => {
        ctx.op = "insert";
        ctx.charge = rows;
        return q;
      },
      update: (patch: unknown) => {
        ctx.op = "update";
        ctx.charge = patch;
        return q;
      },
      delete: () => {
        ctx.op = "delete";
        return q;
      },
      eq: (k: string, v: unknown) => {
        ctx.filtres[k] = v;
        return q;
      },
      in: (k: string, v: unknown[]) => {
        ctx.filtres[`${k}:in`] = [...v].sort();
        return q;
      },
      order: (_k: string, _o?: unknown) => q,
      maybeSingle: async () => terminer(),
      single: async () => terminer(),
      // Thenable : `await db.from(...).select(...).eq(...)` termine la requête.
      then: (
        resoudre: (v: Reponse) => unknown,
        rejeter?: (e: unknown) => unknown,
      ) => {
        try {
          return Promise.resolve(resoudre(terminer()));
        } catch (e) {
          return rejeter ? Promise.resolve(rejeter(e)) : Promise.reject(e);
        }
      },
    };
    return q;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: { from } as any, journal };
}

const OK = (data: unknown): Reponse => ({ data, error: null });

const USER = "11111111-1111-1111-1111-111111111111";
const A = "aaaaaaaa-0000-0000-0000-000000000001";
const B = "bbbbbbbb-0000-0000-0000-000000000002";
const C = "cccccccc-0000-0000-0000-000000000003";

/* ------------------------------------------------------------------ *
 * 1. Réconciliation des octrois
 * ------------------------------------------------------------------ */

describe("setAssets — réconciliation d'ensembles", () => {
  test("ajoute ce qui manque, retire ce qui est en trop, et ne réécrit pas ce qui reste", async () => {
    const { db, journal } = fauxDb((r) =>
      r.op === "select" ? OK([{ asset_id: A }, { asset_id: B }]) : OK(null),
    );

    await setAssets(db, USER, [B, C], "moi");

    const suppr = journal.filter((r) => r.op === "delete");
    const ins = journal.filter((r) => r.op === "insert");

    expect(suppr).toHaveLength(1);
    expect(suppr[0].filtres["asset_id:in"]).toEqual([A]);
    expect(ins).toHaveLength(1);
    expect(ins[0].charge).toEqual([{ user_id: USER, asset_id: C, granted_by: "moi" }]);

    // B est conservé : il n'apparaît NI dans la suppression NI dans l'insertion. C'est cette
    // absence qui prouve que sa ligne — donc sa date d'octroi — survit à l'enregistrement.
    const cite = JSON.stringify(suppr.concat(ins));
    expect(cite).not.toContain(B);
  });

  test("un enregistrement sans changement n'écrit rien du tout", async () => {
    const { db, journal } = fauxDb((r) => (r.op === "select" ? OK([{ asset_id: A }]) : OK(null)));

    await setAssets(db, USER, [A], "moi");

    expect(journal.filter((r) => r.op !== "select")).toHaveLength(0);
  });

  test("tout retirer supprime tout et n'insère rien", async () => {
    const { db, journal } = fauxDb((r) =>
      r.op === "select" ? OK([{ asset_id: A }, { asset_id: B }]) : OK(null),
    );

    await setAssets(db, USER, [], "moi");

    const suppr = journal.filter((r) => r.op === "delete");
    expect(suppr).toHaveLength(1);
    expect(suppr[0].filtres["asset_id:in"]).toEqual([A, B].sort());
    expect(journal.filter((r) => r.op === "insert")).toHaveLength(0);
  });

  test("setTemplates vise l'autre table, avec l'autre colonne", async () => {
    const { db, journal } = fauxDb((r) => (r.op === "select" ? OK([]) : OK(null)));

    await setTemplates(db, USER, [A], "moi");

    const ins = journal.find((r) => r.op === "insert");
    expect(ins?.table).toBe("app_user_template");
    expect(ins?.charge).toEqual([{ user_id: USER, template_id: A, granted_by: "moi" }]);
  });

  test("une erreur de lecture arrête l'enregistrement au lieu d'écrire à l'aveugle", async () => {
    // ⚠️ Sans cette propriété, une lecture en échec rendrait un ensemble d'octrois VIDE, et la
    // réconciliation en conclurait qu'il faut tout supprimer.
    const { db, journal } = fauxDb((r) =>
      r.op === "select" ? { data: null, error: { message: "boom" } } : OK(null),
    );

    // `expect().rejects` n'est pas typé par les définitions bun de ce package : on attrape à la
    // main, ce qui a l'avantage d'exiger explicitement qu'une exception ait bien eu lieu.
    let leve: string | null = null;
    try {
      await setAssets(db, USER, [A], "moi");
    } catch (e) {
      leve = e instanceof Error ? e.message : String(e);
    }
    expect(leve).toContain("boom");
    expect(journal.filter((r) => r.op !== "select")).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * 2. Consommation d'une invitation
 * ------------------------------------------------------------------ */

describe("acceptInvite — non rejouable", () => {
  const LIGNE = {
    id: USER,
    email: "invite@example.com",
    role: "member",
    status: "active",
    password_hash: "pbkdf2$1$x$y",
    invite_expires_at: null,
    last_login_at: null,
    created_at: "2026-08-31T00:00:00Z",
  };

  test("l'écriture est filtrée sur status='invited' et efface le jeton", async () => {
    const { db, journal } = fauxDb(() => OK(LIGNE));

    const res = await acceptInvite(db, USER, "pbkdf2$210000$sel$empreinte");

    expect(res?.id).toBe(USER);
    const maj = journal.find((r) => r.op === "update");
    // Le filtre EST la garantie : sans lui, un lien rejoué réécrirait le mot de passe d'un
    // compte déjà actif.
    expect(maj?.filtres).toEqual({ id: USER, status: "invited" });

    const patch = maj?.charge as Record<string, unknown>;
    expect(patch.password_hash).toBe("pbkdf2$210000$sel$empreinte");
    expect(patch.status).toBe("active");
    // Le jeton et son échéance sont EFFACÉS : un lien déjà consommé ne doit plus retrouver
    // aucun compte, même si quelqu'un le rejoue avec le bon mot de passe.
    expect(patch.invite_token_hash).toBeNull();
    expect(patch.invite_expires_at).toBeNull();
  });

  test("aucune ligne touchée rend null — un update vide réussit en silence", async () => {
    const { db } = fauxDb(() => OK(null));
    expect(await acceptInvite(db, USER, "peu importe")).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 3. Lecture de l'écran d'administration
 * ------------------------------------------------------------------ */

describe("listUsers", () => {
  const compte = (id: string, email: string) => ({
    id,
    email,
    role: "member",
    status: "active",
    password_hash: "x",
    invite_expires_at: null,
    last_login_at: null,
    created_at: "2026-08-31T00:00:00Z",
  });

  test("rattache à chaque compte SES octrois, et laisse les autres vides", async () => {
    const { db } = fauxDb((r) => {
      if (r.table === "app_user") return OK([compte(USER, "a@x.io"), compte(B, "b@x.io")]);
      if (r.table === "app_user_asset") return OK([{ user_id: USER, asset_id: A }]);
      return OK([
        { user_id: USER, template_id: C },
        { user_id: B, template_id: A },
      ]);
    });

    const [u1, u2] = await listUsers(db);
    expect(u1.assetIds).toEqual([A]);
    expect(u1.templateIds).toEqual([C]);
    // Le second n'a pas de marque : la liste doit être VIDE, jamais celle du voisin.
    expect(u2.assetIds).toEqual([]);
    expect(u2.templateIds).toEqual([A]);
  });

  test("aucun compte : on n'interroge même pas les tables d'octroi", async () => {
    const { db, journal } = fauxDb(() => OK([]));
    expect(await listUsers(db)).toEqual([]);
    expect(journal.map((r) => r.table)).toEqual(["app_user"]);
  });

  test("rend les DEUX drapeaux de chaque compte — l'écran en tire « All » colonne par colonne", async () => {
    // ⛔ Le cas d'Alix est la seconde ligne : une marque, tous les templates. Les deux colonnes de
    // l'écran lisent des drapeaux DIFFÉRENTS, et un compte peut n'en porter qu'un.
    const { db, journal } = fauxDb((r) => {
      if (r.table === "app_user") {
        return OK([
          { ...compte(USER, "a@x.io"), all_assets: true, all_templates: false },
          { ...compte(B, "b@x.io"), all_assets: false, all_templates: true },
        ]);
      }
      return OK([]);
    });

    const [u1, u2] = await listUsers(db);
    expect(u1.all_assets).toBe(true);
    expect(u1.all_templates).toBe(false);
    expect(u2.all_assets).toBe(false);
    expect(u2.all_templates).toBe(true);
    expect(journal[0].colonnes).toBe(CHAMPS);
  });
});

/* ------------------------------------------------------------------ *
 * 4. « All brands » et « All templates » (0075) — deux colonnes, deux droits
 * ------------------------------------------------------------------ */

describe("all_assets / all_templates — lus à chaque requête, écrits sans perte", () => {
  const colonnes = (s: string | undefined) => (s ?? "").split(",").map((c) => c.trim());
  const LES_DEUX = ["all_assets", "all_templates"];

  test("CHAMPS porte les DEUX colonnes, et findById les demande vraiment", async () => {
    // ⛔ C'est cette lecture que lib/session.ts consulte à chaque requête : sans une colonne ici,
    // son drapeau vaudrait `undefined` et le compte perdrait ce droit-là, en silence.
    // ⚠️ Pas de `test.each` dans apps/admin (TS2339) : boucle explicite.
    for (const c of LES_DEUX) expect(colonnes(CHAMPS)).toContain(c);

    const { db, journal } = fauxDb(() => OK(null));
    await findById(db, USER);
    for (const c of LES_DEUX) expect(colonnes(journal[0].colonnes)).toContain(c);
  });

  test("⛔ CHAMPS ne demande PLUS all_access — c'est ce silence qui permet à 0076 de la retirer", () => {
    // Le nouveau code ne doit dépendre de l'ancienne colonne nulle part : la retirer après le
    // déploiement doit être un non-événement.
    expect(colonnes(CHAMPS)).not.toContain("all_access");
  });

  test("createUser écrit les deux drapeaux demandés, et false par défaut", async () => {
    const avec = fauxDb(() => OK({ id: USER }));
    await createUser(avec.db, {
      email: "a@x.io",
      role: "member",
      status: "invited",
      allAssets: true,
      allTemplates: true,
    });
    const chargeAvec = avec.journal[0].charge as Record<string, unknown>;
    expect(chargeAvec.all_assets).toBe(true);
    expect(chargeAvec.all_templates).toBe(true);

    const sans = fauxDb(() => OK({ id: USER }));
    await createUser(sans.db, { email: "a@x.io", role: "member", status: "invited" });
    const chargeSans = sans.journal[0].charge as Record<string, unknown>;
    expect(chargeSans.all_assets).toBe(false);
    expect(chargeSans.all_templates).toBe(false);
  });

  test("⛔ createUser sait écrire l'un SANS l'autre — le cas d'Alix à l'invitation", async () => {
    const { db, journal } = fauxDb(() => OK({ id: USER }));
    await createUser(db, {
      email: "a@x.io",
      role: "member",
      status: "invited",
      allAssets: false,
      allTemplates: true,
    });
    const charge = journal[0].charge as Record<string, unknown>;
    expect(charge.all_assets).toBe(false);
    expect(charge.all_templates).toBe(true);
  });

  test("updateUser écrit false — retirer « All » est une modification, pas une absence", async () => {
    for (const champ of LES_DEUX) {
      const { db, journal } = fauxDb(() => OK(null));
      await updateUser(db, USER, champ === "all_assets" ? { allAssets: false } : { allTemplates: false });
      const patch = journal[0].charge as Record<string, unknown>;
      // ⚠️ La CLÉ doit être présente, pas seulement « pas vraie » : un champ sauté laisse la base
      // à `true` et l'écran affiche décoché. `in` distingue les deux, `patch[champ]` non.
      expect(champ in patch).toBe(true);
      expect(patch[champ]).toBe(false);
      expect(journal[0].filtres).toEqual({ id: USER });
    }
  });

  test("⛔ updateUser n'écrit QUE le drapeau demandé — l'autre n'est pas touché", async () => {
    const { db, journal } = fauxDb(() => OK(null));
    await updateUser(db, USER, { allTemplates: true });
    const patch = journal[0].charge as Record<string, unknown>;
    expect(patch.all_templates).toBe(true);
    expect("all_assets" in patch).toBe(false);
  });

  test("updateUser sans aucun drapeau n'en touche aucun", async () => {
    const { db, journal } = fauxDb(() => OK(null));
    await updateUser(db, USER, { role: "member" });
    const patch = journal[0].charge as Record<string, unknown>;
    for (const c of LES_DEUX) expect(c in patch).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 5. Mot de passe défini ou changé (0091)
 * ------------------------------------------------------------------ */

describe("setPassword — une écriture conditionnelle, datée", () => {
  const LIGNE = { id: USER, email: "x@example.com", role: "member", status: "active" };

  test("CHAMPS lit password_changed_at — sans elle, aucune session ne serait jamais fermée", () => {
    expect(CHAMPS.split(",").map((c) => c.trim())).toContain("password_changed_at");
  });

  test("compte actif : empreinte + date, filtré sur le statut LU, sans toucher au statut", async () => {
    const { db, journal } = fauxDb(() => OK(LIGNE));
    const avant = Date.now();

    const res = await setPassword(db, USER, "pbkdf2$210000$sel$neuf", "active");

    expect(res?.id).toBe(USER);
    const maj = journal.find((r) => r.op === "update");
    // Le filtre sur le statut lu rend l'écriture conditionnelle : un compte désactivé entre la
    // lecture et l'écriture n'est pas touché.
    expect(maj?.filtres).toEqual({ id: USER, status: "active" });
    const patch = maj?.charge as Record<string, unknown>;
    expect(patch.password_hash).toBe("pbkdf2$210000$sel$neuf");
    const date = Date.parse(String(patch.password_changed_at));
    expect(date >= avant && date <= Date.now()).toBe(true);
    expect("status" in patch).toBe(false);
    expect("invite_token_hash" in patch).toBe(false);
    expect(maj?.colonnes).toBe(CHAMPS);
  });

  test("⛔ compte invité : ACTIVÉ par la même écriture, et le lien d'invitation meurt", async () => {
    const { db, journal } = fauxDb(() => OK(LIGNE));

    await setPassword(db, USER, "pbkdf2$210000$sel$neuf", "invited");

    const maj = journal.find((r) => r.op === "update");
    expect(maj?.filtres).toEqual({ id: USER, status: "invited" });
    const patch = maj?.charge as Record<string, unknown>;
    expect(patch.status).toBe("active");
    // Laissé en place, le jeton permettrait au lien déjà envoyé de réécrire ce mot de passe.
    expect(patch.invite_token_hash).toBeNull();
    expect(patch.invite_expires_at).toBeNull();
  });

  test("compte désactivé : le mot de passe change, le compte reste désactivé", async () => {
    const { db, journal } = fauxDb(() => OK({ ...LIGNE, status: "disabled" }));
    await setPassword(db, USER, "h", "disabled");
    const patch = journal.find((r) => r.op === "update")?.charge as Record<string, unknown>;
    expect("status" in patch).toBe(false);
  });

  test("aucune ligne touchée rend null — pas de faux succès", async () => {
    const { db } = fauxDb(() => OK(null));
    expect(await setPassword(db, USER, "h", "active")).toBeNull();
  });

  test("une erreur de la base remonte, elle ne devient pas un null", async () => {
    const { db } = fauxDb(() => ({ data: null, error: { message: "boom" } }));
    await expect(setPassword(db, USER, "h", "active")).rejects.toThrow("app_user password: boom");
  });
});
