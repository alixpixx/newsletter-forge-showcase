/**
 * CE QUE LE RETRAIT D'UN RATTACHEMENT SUPPRIME EXACTEMENT.
 *
 * ⛔ CE QUE CE BANC EXISTE POUR EMPÊCHER. La route lit d'abord « qui porte cette fente ? », puis
 * supprime. Entre les deux gestes, quelqu'un d'autre peut avoir posé SON modèle sur la même fente
 * (la clé est (asset_id, kind), et l'écran de l'autre personne n'a aucune raison d'attendre). Si le
 * DELETE ne porte que sur (asset_id, kind), il efface un réglage que personne n'a demandé de
 * retirer, et que son auteur ne peut même pas voir disparaître : son écran affichera « Built-in
 * email » après rafraîchissement, sans qu'aucune erreur n'ait été levée nulle part.
 *
 * ⚠️ Aucun accès réseau : le client Supabase est un double qui enregistre les filtres reçus. Ce qui
 * est mesuré, c'est la REQUÊTE construite, pas ce que PostgREST en ferait.
 */
import { describe, expect, test } from "bun:test";
import { fauxDb as fauxDbOrdonne, eqsDe } from "@/lib/testing/faux-db";
import { lifecycleTemplateToReopen, publishedLifecycleShell, setLifecycleBinding } from "./lifecycle-templates";

type Appel = { table: string; methodes: { m: string; args: unknown[] }[] };

function fauxDb() {
  const appels: Appel[] = [];

  const db = {
    from(table: string) {
      const appel: Appel = { table, methodes: [] };
      appels.push(appel);

      const chaine: unknown = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === "then") {
              return (resoudre: (v: unknown) => void) => resoudre({ data: null, error: null });
            }
            return (...args: unknown[]) => {
              appel.methodes.push({ m: prop, args });
              return chaine;
            };
          },
        },
      );
      return chaine;
    },
  };

  return { db: db as unknown as Parameters<typeof setLifecycleBinding>[0], appels };
}

const filtres = (appel: Appel): [string, unknown][] =>
  appel.methodes.filter((m) => m.m === "eq").map((m) => [String(m.args[0]), m.args[1]]);

const ASSET = "asset_1";
const T1 = "11111111-1111-4111-8111-111111111111";

describe("setLifecycleBinding — retirer un rattachement", () => {
  /**
   * ⛔ LE TEST CENTRAL. MUTATION QUI DOIT LE TUER : retirer le `.eq("template_id", …)` conditionnel
   * de `setLifecycleBinding`, la suppression redevenant un `(asset_id, kind)` nu.
   * Symptôme en production : A détache la confirmation ; entre sa lecture et son DELETE, B a posé
   * son propre modèle sur la même fente. Le réglage de B disparaît, alors que A n'avait aucun droit
   * dessus et n'a jamais rien vu de tel à l'écran.
   */
  test("le modèle attendu est porté par le DELETE, pas seulement par le contrôle préalable", async () => {
    const { db, appels } = fauxDb();
    const r = await setLifecycleBinding(db, ASSET, "confirmation", null, "moi@example.com", T1);

    expect(r.ok).toBe(true);
    const appel = appels[0]!;
    expect(appel.table).toBe("lifecycle_template");
    expect(appel.methodes.some((m) => m.m === "delete")).toBe(true);
    expect(filtres(appel)).toEqual([
      ["asset_id", ASSET],
      ["kind", "confirmation"],
      ["template_id", T1],
    ]);
  });

  test("sans modèle attendu, la fente est vidée telle quelle — le geste reste possible", async () => {
    const { db, appels } = fauxDb();
    await setLifecycleBinding(db, ASSET, "welcome", null, null);

    expect(filtres(appels[0]!)).toEqual([
      ["asset_id", ASSET],
      ["kind", "welcome"],
    ]);
  });

  /** Poser un rattachement reste un upsert sur (asset_id, kind) : c'est lui qui évince le précédent. */
  test("attacher n'ajoute aucun filtre : c'est un upsert, pas une suppression", async () => {
    const { db, appels } = fauxDb();
    await setLifecycleBinding(db, ASSET, "reengagement", T1, null);

    const appel = appels[0]!;
    expect(appel.methodes.some((m) => m.m === "upsert")).toBe(true);
    expect(appel.methodes.some((m) => m.m === "delete")).toBe(false);
  });
});

/**
 * CE QU'UN SECOND « CUSTOMISE » DOIT FAIRE — ET SURTOUT NE PAS FAIRE.
 *
 * ⛔ CE QUE CE BANC EXISTE POUR EMPÊCHER. « Customise » crée un modèle et DÉPLACE le rattachement
 * dessus. L'écran ne propose ce bouton que sur une fente qu'aucun modèle à soi ne sert déjà, mais ce
 * garde-fou ne vit que dans un rendu serveur : le retour arrière du navigateur restaure la page
 * périmée, un second onglet l'ignore, une réponse perdue après commit la fait rejouer. Sans contrôle
 * côté route, le second clic fabrique un jumeau vide de tout travail, y déplace le rattachement, et
 * laisse le premier modèle orphelin et homonyme dans la bibliothèque.
 */
function fauxDbAvec(reponse: { data: unknown; error: unknown }) {
  const appels: Appel[] = [];

  const db = {
    from(table: string) {
      const appel: Appel = { table, methodes: [] };
      appels.push(appel);

      const chaine: unknown = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === "then") {
              return (resoudre: (v: unknown) => void) => resoudre(reponse);
            }
            return (...args: unknown[]) => {
              appel.methodes.push({ m: prop, args });
              return chaine;
            };
          },
        },
      );
      return chaine;
    },
  };

  return { db: db as unknown as Parameters<typeof lifecycleTemplateToReopen>[0], appels };
}

describe("lifecycleTemplateToReopen — rouvrir plutôt que semer un jumeau", () => {
  test("la fente est libre : il faut vraiment créer, et on n'a rien à juger", async () => {
    const { db } = fauxDbAvec({ data: null, error: null });
    let juge = 0;
    const r = await lifecycleTemplateToReopen(db, ASSET, "confirmation", async () => {
      juge += 1;
      return true;
    });

    expect(r).toEqual({ known: true, value: null });
    expect(juge).toBe(0);
  });

  /**
   * ⛔ LE TEST CENTRAL. MUTATION QUI DOIT LE TUER : rendre `pose.value` sans consulter `reprenable`.
   * Symptôme en production : la fente est servie par le modèle PUBLIÉ d'un collègue (non octroyé) ou
   * par un modèle ARCHIVÉ — les deux cas où l'écran propose « Customise » à dessein. La route
   * rouvrirait un modèle que la personne ne peut pas éditer (404 du builder) au lieu de lui en
   * fabriquer un.
   */
  test("un modèle qu'on ne peut pas rouvrir ne bloque pas la création", async () => {
    const { db } = fauxDbAvec({ data: { template_id: T1 }, error: null });
    const r = await lifecycleTemplateToReopen(db, ASSET, "confirmation", async () => false);

    expect(r).toEqual({ known: true, value: null });
  });

  /**
   * ⛔ MUTATION QUI DOIT LE TUER : rendre `{ known: true, value: null }` quand la lecture échoue.
   * Le second clic recréerait alors un modèle précisément au moment où l'on ne sait pas si la fente
   * est déjà servie — le doublon que ce module existe pour empêcher.
   */
  test("une lecture en erreur n'est PAS une fente libre", async () => {
    const { db } = fauxDbAvec({ data: null, error: { message: "timeout" } });
    let juge = 0;
    const r = await lifecycleTemplateToReopen(db, ASSET, "welcome", async () => {
      juge += 1;
      return true;
    });

    expect(r).toEqual({ known: false, value: null });
    expect(juge).toBe(0);
  });

  test("le modèle en place et ouvrable est RENDU : c'est lui qu'on rouvre, on ne crée rien", async () => {
    const { db, appels } = fauxDbAvec({ data: { template_id: T1 }, error: null });
    const r = await lifecycleTemplateToReopen(db, ASSET, "reengagement", async (id) => id === T1);

    expect(r).toEqual({ known: true, value: T1 });
    // La lecture est bien scopée sur la marque ET le kind : la clé primaire de la table.
    expect(filtres(appels[0]!)).toEqual([
      ["asset_id", ASSET],
      ["kind", "reengagement"],
    ]);
  });
});

/*
 * LE SHELL QU'ON JUGE AU RATTACHEMENT — celui de la version EN LIGNE, pas le brouillon (16/09).
 * ⛔ Symptôme évité : rattacher une confirmation dont la version publiée n'a pas de lien de
 * confirmation ; le worker la sert aussitôt.
 */
describe("publishedLifecycleShell", () => {
  const V = "22222222-2222-4222-8222-222222222222";

  test("jamais publié ⇒ known, value null, une seule lecture", async () => {
    const { db, appels } = fauxDbOrdonne({ data: { current_version_id: null }, error: null });
    const r = await publishedLifecycleShell(db as never, T1);
    expect(r).toEqual({ known: true, value: null });
    expect(appels).toHaveLength(1);
  });

  test("version courante publiée ⇒ son shell, lu sur CETTE version de CE template", async () => {
    const { db, appels } = fauxDbOrdonne(
      { data: { current_version_id: V }, error: null },
      { data: { html_shell: "<a>{{confirm_url}}</a>", text_shell: "t", subject: "s", status: "published" }, error: null },
    );
    const r = await publishedLifecycleShell(db as never, T1);
    expect(r).toEqual({ known: true, value: { html: "<a>{{confirm_url}}</a>", text: "t", subject: "s" } });
    expect(appels[1]!.table).toBe("template_version");
    expect(eqsDe(appels[1]!)).toEqual([
      ["id", V],
      ["template_id", T1],
    ]);
  });

  test("⛔ lecture en erreur ⇒ inconnu, jamais « rien de publié »", async () => {
    expect(await publishedLifecycleShell(fauxDbOrdonne({ data: null, error: { message: "x" } }).db as never, T1)).toEqual({
      known: false,
      value: null,
    });
    const deux = fauxDbOrdonne({ data: { current_version_id: V }, error: null }, { data: null, error: { message: "x" } });
    expect((await publishedLifecycleShell(deux.db as never, T1)).known).toBe(false);
  });

  test("pointeur vers une version non publiée ⇒ inconnu", async () => {
    const { db } = fauxDbOrdonne(
      { data: { current_version_id: V }, error: null },
      { data: { html_shell: "x", text_shell: "", subject: "s", status: "draft" }, error: null },
    );
    expect((await publishedLifecycleShell(db as never, T1)).known).toBe(false);
  });
});
