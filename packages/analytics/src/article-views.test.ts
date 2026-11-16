/**
 * Banc de la lecture d'audience (`newsletter.article_views`).
 *
 * Ce qui se joue ici ne se voit sur aucun écran : ce sont quatre façons de rendre « rien » qui se
 * ressemblent trait pour trait une fois affichées, et qui appellent quatre actions différentes.
 *
 *  1. **Une panne ne devient JAMAIS une liste vide.** Une erreur PostgREST réduite à zéro vue est
 *     indiscernable de « ces articles n'ont pas été lus » — la première envoie voir la base, la
 *     seconde envoie changer de catégorie.
 *  2. **« Non mesuré » n'est pas « zéro vue ».** Un href absent de la réponse doit rester ABSENT de
 *     la carte : à zéro, il se confondrait avec un article réellement lu par personne.
 *  3. **La fenêtre rendue est celle qui a été COUVERTE, pas celle qui a été demandée.** La RPC borne
 *     à J−2 ; recopier la borne demandée ferait afficher une fenêtre qui n'a pas été mesurée.
 *  4. **Une `Map` ne survit pas à `JSON.stringify`** — elle devient `{}`, sans erreur. Le témoin de
 *     ce banc le prouve dans les deux sens.
 */
import { describe, expect, test } from "bun:test";

const { audienceEnJson, fenetreParDefaut, lireAudience, publieApresLaFenetre, raisonLisible } =
  await import("./article-views");

type Appel = { nom: string; params: Record<string, unknown> };

/** Double minimal du client : n'expose que `rpc`, et journalise ce qui part réellement. */
function fauxDb(repondre: () => { data: unknown; error: null | { message: string } }) {
  const journal: Appel[] = [];
  const db = {
    rpc: async (nom: string, params: Record<string, unknown>) => {
      journal.push({ nom, params });
      return repondre();
    },
  };
  // Le client réel porte des génériques de schéma dont ce banc n'a pas besoin : seul `rpc` est
  // appelé, et c'est la forme de l'appel qui est sous test.
  return { db: db as unknown as Parameters<typeof lireAudience>[0], journal };
}

const REPONSE_SAINE = {
  ok: true,
  reason: null,
  site_slug: "copper-kettle",
  window: { from: "2026-08-24", to: "2026-08-30", to_requested: "2026-09-01" },
  freshness: { max_event_date: "2026-08-31", rows_last_day: 3678, rows_prev_day: 4424 },
  candidates: 3,
  rejected_relative: 1,
  matched: 2,
  views: [
    { href: "https://x.cl/a/", path: "/a/", views: 191 },
    { href: "https://x.cl/b/", path: "/b/", views: 0 },
  ],
};

describe("lireAudience — les quatre façons de rendre « rien »", () => {
  test("une erreur RPC devient un refus nommé, jamais une audience vide", async () => {
    const { db } = fauxDb(() => ({ data: null, error: { message: "PGRST202 function not found" } }));

    const a = await lireAudience(db, "asset-1", ["https://x.cl/a/"], "2026-08-24", "2026-09-01");

    expect(a.ok).toBe(false);
    if (a.ok) throw new Error("le refus attendu n'a pas eu lieu");
    expect(a.motif).toBe("unavailable");
    // ⛔ Le point de tout le test : la panne ne doit PAS se présenter comme une mesure à zéro.
    // (`toHaveProperty` n'est pas typé par les définitions bun de ce package — on teste la clé.)
    expect("vues" in a).toBe(false);
    expect(a.detail).toContain("PGRST202");
  });

  test("une réponse absente est aussi une panne, pas un silence", async () => {
    const { db } = fauxDb(() => ({ data: null, error: null }));
    const a = await lireAudience(db, "asset-1", ["https://x.cl/a/"], "2026-08-24", "2026-09-01");
    expect(a.ok).toBe(false);
    if (a.ok) throw new Error("le refus attendu n'a pas eu lieu");
    expect(a.motif).toBe("unavailable");
  });

  test("le refus de la RPC garde SA raison — une marque sans propriété élue n'est pas une panne", async () => {
    const { db } = fauxDb(() => ({
      data: { ...REPONSE_SAINE, ok: false, reason: "no_property", site_slug: null },
      error: null,
    }));

    const a = await lireAudience(db, "asset-1", ["https://x.cl/a/"], "2026-08-24", "2026-09-01");

    expect(a.ok).toBe(false);
    if (a.ok) throw new Error("le refus attendu n'a pas eu lieu");
    expect(a.motif).toBe("no_property");
    expect(a.siteSlug).toBe(null);
  });

  test("une source qui n'émet plus est distinguée d'une source qui n'a jamais émis", async () => {
    for (const reason of ["source_silent", "source_stale"] as const) {
      const { db } = fauxDb(() => ({ data: { ...REPONSE_SAINE, ok: false, reason }, error: null }));
      const a = await lireAudience(db, "asset-1", ["https://x.cl/a/"], "2026-08-24", "2026-09-01");
      expect(a.ok).toBe(false);
      if (a.ok) throw new Error("le refus attendu n'a pas eu lieu");
      expect(a.motif).toBe(reason);
    }
  });

  // TÉMOIN : sans lui, tous les tests ci-dessus passeraient sur une fonction qui refuse TOUJOURS.
  test("témoin — une réponse saine passe, et porte ses vues", async () => {
    const { db, journal } = fauxDb(() => ({ data: REPONSE_SAINE, error: null }));

    const a = await lireAudience(db, "asset-1", ["https://x.cl/a/", "https://x.cl/b/"], "2026-08-24", "2026-09-01");

    expect(a.ok).toBe(true);
    if (!a.ok) throw new Error("le succès attendu n'a pas eu lieu");
    expect(a.vues.get("https://x.cl/a/")).toBe(191);
    expect(a.apparies).toBe(2);
    expect(journal.length).toBe(1);
    expect(journal[0]!.nom).toBe("article_views");
    expect(journal[0]!.params.p_asset_id).toBe("asset-1");
  });
});

describe("« non mesuré » n'est pas « zéro vue »", () => {
  /**
   * Le défaut réel de la migration 0046, constaté en production le 01/09/2026 : `coalesce(sum(),0)`
   * derrière un `left join` donnait une valeur à TOUT candidat, apparié ou non. Les 8 articles
   * servis par défaut sur copper-kettle — tous publiés après la borne haute — s'affichaient donc
   * « 0 views », c'est-à-dire « personne ne les a lus », alors qu'aucune mesure n'existait.
   * 0047 rend `null` ; ce test interdit de le retraduire en 0 côté TypeScript.
   */
  test("un `views` nul rendu par la RPC n'entre PAS dans la carte", async () => {
    const { db } = fauxDb(() => ({
      data: {
        ...REPONSE_SAINE,
        matched: 1,
        views: [
          { href: "https://x.cl/a/", path: "/a/", views: 191 },
          { href: "https://x.cl/trop-recent/", path: "/trop-recent/", views: null },
        ],
      },
      error: null,
    }));

    const a = await lireAudience(db, "asset-1", ["https://x.cl/a/", "https://x.cl/trop-recent/"], "2026-08-24", "2026-09-01");

    if (!a.ok) throw new Error("le succès attendu n'a pas eu lieu");
    expect(a.vues.get("https://x.cl/a/")).toBe(191);
    // ⛔ Le cœur du test : ni 0, ni présent. Absent.
    expect(a.vues.has("https://x.cl/trop-recent/")).toBe(false);
    expect(a.vues.get("https://x.cl/trop-recent/")).toBe(undefined);
  });


  test("un href absent de la réponse reste ABSENT de la carte", async () => {
    const { db } = fauxDb(() => ({ data: REPONSE_SAINE, error: null }));

    const a = await lireAudience(
      db,
      "asset-1",
      ["https://x.cl/a/", "https://x.cl/b/", "/chemin-relatif"],
      "2026-08-24",
      "2026-09-01",
    );

    if (!a.ok) throw new Error("le succès attendu n'a pas eu lieu");
    // Mesuré à zéro : la clé EXISTE et vaut 0.
    expect(a.vues.has("https://x.cl/b/")).toBe(true);
    expect(a.vues.get("https://x.cl/b/")).toBe(0);
    // Jamais mesuré : la clé N'EXISTE PAS. C'est ce qui permet à l'écran d'écrire « not measured »
    // plutôt que « 0 view » — et au tri de le ranger sous les zéros réels.
    expect(a.vues.has("/chemin-relatif")).toBe(false);
    expect(a.vues.get("/chemin-relatif")).toBe(undefined);
    expect(a.rejetesRelatifs).toBe(1);
  });
});

describe("la fenêtre rendue est celle qui a été couverte", () => {
  test("la borne haute vient de la RPC, pas de la demande", async () => {
    const { db } = fauxDb(() => ({ data: REPONSE_SAINE, error: null }));

    const a = await lireAudience(db, "asset-1", ["https://x.cl/a/"], "2026-08-24", "2026-09-01");

    if (!a.ok) throw new Error("le succès attendu n'a pas eu lieu");
    // Demandé jusqu'au 01/09, réellement couvert jusqu'au 30/08 : c'est la seconde date qui compte.
    expect(a.fenetre.au).toBe("2026-08-30");
    expect(a.fenetre.auDemande).toBe("2026-09-01");
    expect(a.fenetre.au).not.toBe(a.fenetre.auDemande);
  });

  test("aucun candidat : succès neutre, et AUCUN appel réseau", async () => {
    const { db, journal } = fauxDb(() => {
      throw new Error("la RPC ne doit pas être appelée sans candidat");
    });

    const a = await lireAudience(db, "asset-1", [], "2026-08-24", "2026-09-01");

    expect(a.ok).toBe(true);
    expect(journal.length).toBe(0);
  });
});

describe("audienceEnJson — la Map ne survit pas au transport", () => {
  test("le témoin : une Map sérialisée directement se vide en silence", () => {
    const brut = JSON.stringify({ vues: new Map([["https://x.cl/a/", 191]]) });
    // Aucune erreur n'est levée, et pourtant la donnée a disparu. C'est CE défaut que la conversion
    // évite — sans ce témoin, le test suivant ne prouverait pas qu'il sert à quelque chose.
    expect(brut).toBe('{"vues":{}}');
  });

  test("après conversion, les vues traversent JSON", () => {
    const json = audienceEnJson({
      ok: true,
      siteSlug: "copper-kettle",
      fenetre: { du: "2026-08-24", au: "2026-08-30", auDemande: "2026-09-01" },
      fraicheur: { dernierJour: "2026-08-31", lignesDernierJour: 1, lignesVeille: 2 },
      candidats: 2,
      apparies: 1,
      rejetesRelatifs: 0,
      vues: new Map([["https://x.cl/a/", 191]]),
    });

    const retour = JSON.parse(JSON.stringify(json)) as { ok: boolean; vues: Record<string, number> };
    expect(retour.ok).toBe(true);
    expect(retour.vues["https://x.cl/a/"]).toBe(191);
  });

  test("un refus emporte son message, pour que l'écran n'ait pas à connaître les motifs", () => {
    const json = audienceEnJson({ ok: false, motif: "source_stale", siteSlug: "tff_betting_news" });
    if (json.ok) throw new Error("le refus attendu n'a pas eu lieu");
    expect(json.message).toBe(raisonLisible("source_stale"));
    expect(json.message.length).toBeGreaterThan(0);
  });
});

describe("raisonLisible — quatre causes, quatre phrases", () => {
  test("aucun message n'est réutilisé pour deux causes différentes", () => {
    const motifs = ["no_property", "source_silent", "source_stale", "unavailable"] as const;
    const messages = motifs.map(raisonLisible);
    expect(new Set(messages).size).toBe(motifs.length);
    // La panne technique doit dire d'où elle vient : c'est ce qui évite d'aller accuser WordPress.
    expect(raisonLisible("unavailable")).toContain("not a WordPress one");
  });
});

describe("publieApresLaFenetre — la troisième cause d'un « rien »", () => {
  // Les dates sont celles mesurées en production le 01/09/2026 sur copper-kettle : le pool par défaut
  // (0/8 apparié) et le pool antérieur au 29/08 (8/8 apparié). Ce banc fige la frontière qui sépare
  // les deux, sans quoi l'écran expliquerait le mauvais problème.
  const FIN = "2026-08-30";

  test("un article publié après la fin de la fenêtre est hors de portée de la mesure", () => {
    expect(publieApresLaFenetre("2026-09-01T23:37:52.000Z", FIN)).toBe(true);
    expect(publieApresLaFenetre("2026-08-31T00:00:01.000Z", FIN)).toBe(true);
  });

  // TÉMOIN : sans lui, une fonction qui rend TOUJOURS `true` passerait le test ci-dessus — et
  // l'écran écrirait « too recent » sur des articles réellement mesurables, donc sur de vraies
  // pannes d'appariement.
  test("témoin — un article publié dans la fenêtre, ou le jour même de sa fin, ne l'est pas", () => {
    expect(publieApresLaFenetre("2026-08-29T02:35:39.000Z", FIN)).toBe(false);
    expect(publieApresLaFenetre("2026-08-30T23:59:59.000Z", FIN)).toBe(false);
    expect(publieApresLaFenetre("2026-08-24T00:00:00.000Z", FIN)).toBe(false);
  });

  test("une date absente ou illisible ne devient JAMAIS « trop récent »", () => {
    // Sinon une date manquante fabriquerait une explication rassurante à la place d'un vrai défaut.
    expect(publieApresLaFenetre(null, FIN)).toBe(false);
    expect(publieApresLaFenetre("pas une date", FIN)).toBe(false);
    expect(publieApresLaFenetre("2026-09-01T23:37:52.000Z", "pas une date")).toBe(false);
  });
});

describe("fenetreParDefaut", () => {
  test("sept jours pleins, en dates ISO", () => {
    const { du, au } = fenetreParDefaut(new Date("2026-09-01T18:30:00Z"));
    expect(au).toBe("2026-09-01");
    expect(du).toBe("2026-08-25");
  });

  test("le nombre de jours est un paramètre, pas une constante cachée", () => {
    const { du } = fenetreParDefaut(new Date("2026-09-01T00:00:00Z"), 1);
    expect(du).toBe("2026-08-31");
  });
});

describe("bornePublicationMesurable — ne récolter que ce qui est classable", () => {
  test("la borne tombe à la fin du jour J−2", async () => {
    const { bornePublicationMesurable } = await import("./article-views");
    expect(bornePublicationMesurable(new Date("2026-09-01T18:30:00Z"))).toBe("2026-08-30T23:59:59");
  });

  // TÉMOIN : sans lui, une borne posée à J ou à J−1 passerait — or c'est exactement l'erreur qui
  // rendait le tri par vues inutilisable (0 article mesuré sur 7 en production le 01/09).
  test("témoin — la borne n'est ni aujourd'hui ni hier", async () => {
    const { bornePublicationMesurable } = await import("./article-views");
    const b = bornePublicationMesurable(new Date("2026-09-01T18:30:00Z"));
    expect(b).not.toContain("2026-09-01");
    expect(b).not.toContain("2026-08-31");
  });

  test("elle traverse un changement de mois", async () => {
    const { bornePublicationMesurable } = await import("./article-views");
    expect(bornePublicationMesurable(new Date("2026-09-01T00:00:00Z"))).toBe("2026-08-30T23:59:59");
    expect(bornePublicationMesurable(new Date("2026-03-02T12:00:00Z"))).toBe("2026-02-28T23:59:59");
  });
});

/**
 * ⛔ CE QUI SE JOUE ICI : récolte et mesure doivent désigner la MÊME période. Tant qu'elles étaient
 * calculées par deux appels séparés (`bornePublicationMesurable` d'un côté, `fenetreParDefaut` de
 * l'autre), rien n'empêchait l'une de dériver — et un article récolté hors de la fenêtre mesurée
 * perd ses vues sans que le classement ait l'air anormal.
 */
describe("fenetreClassement — la récolte et la mesure ne peuvent plus diverger", () => {
  test("sept jours pleins, finissant à J−2", async () => {
    const { fenetreClassement } = await import("./article-views");
    const f = fenetreClassement(new Date("2026-09-03T09:15:00Z"));

    // `after` est la FIN du jour qui précède la fenêtre : elle court donc du 26/08 au 01/09 inclus.
    expect(f.apres).toBe("2026-08-25T23:59:59");
    expect(f.avant).toBe("2026-09-01T23:59:59");
    expect(f.jours).toBe(7);
  });

  test("la fenêtre de mesure couvre la fenêtre de publication", async () => {
    const { fenetreClassement } = await import("./article-views");
    const f = fenetreClassement(new Date("2026-09-03T09:15:00Z"));

    // ⛔ LE TÉMOIN CENTRAL. `du` ne doit JAMAIS être postérieur au premier jour publié, sinon les
    // premiers articles de la fenêtre sont amputés de leurs meilleures journées (97 vues moyennes
    // à un jour d'exposition contre 32 à sept, mesuré le 01/09).
    expect(f.du <= f.apres.slice(0, 10)).toBe(true);
    expect(f.au).toBe(f.avant.slice(0, 10));
  });

  test("la durée est celle demandée, pas une constante cachée", async () => {
    const { fenetreClassement } = await import("./article-views");
    const maintenant = new Date("2026-09-03T09:15:00Z");

    // Une cadence de deux semaines : la fenêtre s'allonge par le bas, la borne haute ne bouge pas.
    const quinze = fenetreClassement(maintenant, 14);
    expect(quinze.apres).toBe("2026-08-18T23:59:59");
    expect(quinze.avant).toBe("2026-09-01T23:59:59");
    expect(quinze.jours).toBe(14);

    // Deux envois par semaine : quatre jours, puis trois.
    expect(fenetreClassement(maintenant, 4).apres).toBe("2026-08-28T23:59:59");
    expect(fenetreClassement(maintenant, 3).apres).toBe("2026-08-29T23:59:59");
  });

  test("un nombre de jours absurde ne produit pas une fenêtre inversée", async () => {
    const { fenetreClassement } = await import("./article-views");
    const f = fenetreClassement(new Date("2026-09-03T09:15:00Z"), 0);
    // ⚠️ Ramené à un jour : une fenêtre de zéro jour rendrait `apres > avant`, et WordPress
    // répondrait une liste vide — indiscernable d'une période sans publication.
    expect(f.jours).toBe(1);
    expect(f.apres < f.avant).toBe(true);
  });

  test("elle traverse un changement de mois", async () => {
    const { fenetreClassement } = await import("./article-views");
    const f = fenetreClassement(new Date("2026-03-05T12:00:00Z"));
    expect(f.avant).toBe("2026-03-03T23:59:59");
    expect(f.apres).toBe("2026-02-24T23:59:59");
  });
});

/**
 * ⛔ CE QUI SE JOUE ICI : c'est la fonction qui rend vraie la promesse « les plus lus depuis la
 * dernière lettre ». Elle lit une liste d'occurrences théoriques et en tire un écart — et la
 * fonction SQL qui produit cette liste a une borne haute INCLUSIVE, donc l'occurrence courante y
 * figure. La garder donnerait zéro jour, donc une fenêtre vide, indiscernable d'une période sans
 * publication.
 */
describe("ecartDeCadence — l'écart depuis l'envoi précédent", () => {
  // Les dimanches à 20 h, heure de São Paulo, tels que `campaign_occurrences` les rend
  // (relevé en base le 03/09/2026).
  const DIMANCHES = [
    "2026-08-16T23:00:00+00:00",
    "2026-08-23T23:00:00+00:00",
    "2026-08-30T23:00:00+00:00",
    "2026-09-06T23:00:00+00:00",
  ];

  test("une hebdomadaire donne sept jours", async () => {
    const { ecartDeCadence } = await import("./article-views");
    expect(ecartDeCadence(DIMANCHES, "2026-09-06T23:00:00+00:00")).toBe(7);
  });

  test("⛔ l'occurrence COURANTE est exclue, pas comptée comme précédente", async () => {
    const { ecartDeCadence } = await import("./article-views");
    // TÉMOIN : la cible EST dans la liste. Un filtre `<=` au lieu de `<` rendrait 0.
    const r = ecartDeCadence(DIMANCHES, "2026-09-06T23:00:00+00:00");
    expect(r === 0).toBe(false);
    expect(r).toBe(7);
  });

  test("lundi + vendredi alterne quatre jours puis trois", async () => {
    const { ecartDeCadence } = await import("./article-views");
    // Relevé en base : c'est exactement ce qu'une fenêtre fixe de sept jours ferait faux, en
    // recomptant les mêmes articles d'un envoi à l'autre.
    const bihebdo = [
      "2026-08-24T12:00:00+00:00",
      "2026-08-28T12:00:00+00:00",
      "2026-08-31T12:00:00+00:00",
      "2026-09-04T12:00:00+00:00",
    ];
    expect(ecartDeCadence(bihebdo, "2026-08-28T12:00:00+00:00")).toBe(4);
    expect(ecartDeCadence(bihebdo, "2026-08-31T12:00:00+00:00")).toBe(3);
    expect(ecartDeCadence(bihebdo, "2026-09-04T12:00:00+00:00")).toBe(4);
  });

  test("l'ordre de la liste n'a aucune importance", async () => {
    const { ecartDeCadence } = await import("./article-views");
    // On prend le MAXIMUM sous la cible, pas le dernier élément : un tri différent côté base ne
    // doit pas changer la période classée.
    expect(ecartDeCadence([...DIMANCHES].reverse(), "2026-09-06T23:00:00+00:00")).toBe(7);
  });

  test("aucune occurrence antérieure ⇒ `null`, jamais un nombre inventé", async () => {
    const { ecartDeCadence } = await import("./article-views");
    expect(ecartDeCadence([], "2026-09-06T23:00:00+00:00")).toBe(null);
    // Uniquement des occurrences FUTURES : rien à mesurer en arrière.
    expect(ecartDeCadence(["2026-09-13T23:00:00+00:00"], "2026-09-06T23:00:00+00:00")).toBe(null);
  });

  test("un écart infra-journalier rend `null`, jamais une fenêtre de zéro jour", async () => {
    const { ecartDeCadence } = await import("./article-views");
    // ⚠️ CAS IMPOSSIBLE PAR LE SCHÉMA, gardé comme filet : `recurrence_time` est une heure UNIQUE
    // (migration 0027), donc une campagne ne peut pas partir deux fois le même jour. Si un écart
    // sous-journalier arrivait quand même, l'arrondi donnerait 0 — soit `apres > avant`, une
    // fenêtre inversée que la récolte lirait comme « aucun article ».
    expect(ecartDeCadence(["2026-09-06T19:00:00+00:00"], "2026-09-06T21:00:00+00:00")).toBe(null);
  });

  test("⛔ le format lu est celui de PostgREST, pas le rendu texte de Postgres", async () => {
    const { ecartDeCadence } = await import("./article-views");
    // Mesuré le 03/09 : `to_json(fires_at)` — ce que supabase-js reçoit — rend `+00:00`, alors que
    // `fires_at::text` (ce qu'affiche psql ou une console SQL) rend `+00`, que `Date.parse` refuse.
    // Ce témoin fixe la frontière : un jour où la source changerait de sérialisation, l'écart
    // devient `null` et l'appelant ANNONCE son défaut — il n'invente pas une période.
    expect(ecartDeCadence(["2026-08-30T23:00:00+00:00"], "2026-09-06T23:00:00+00:00")).toBe(7);
    expect(ecartDeCadence(["2026-08-30T23:00:00+00"], "2026-09-06T23:00:00+00:00")).toBe(null);
  });

  test("le passage à l'heure d'été ne rabote pas un jour de la fenêtre", async () => {
    const { ecartDeCadence } = await import("./article-views");
    // Dates MESURÉES sur la RPC (Europe/London, dimanche 20:00, 03/09) : le printemps avance
    // l'horloge, donc l'écart réel vaut 6 j 23 h. Tronquer au lieu d'arrondir classerait six jours
    // pour une hebdomadaire — un jour d'articles perdu deux fois par an, sans rien dans le journal.
    expect(ecartDeCadence(["2026-03-22T20:00:00+00:00"], "2026-03-29T19:00:00+00:00")).toBe(7);
    // L'automne recule l'horloge : 7 j 1 h, qui ne doit pas donner huit jours non plus.
    expect(ecartDeCadence(["2026-10-18T19:00:00+00:00"], "2026-10-25T20:00:00+00:00")).toBe(7);
  });

  test("une date illisible est ignorée, jamais prise pour une occurrence", async () => {
    const { ecartDeCadence } = await import("./article-views");
    expect(ecartDeCadence(["pas une date", "2026-08-30T23:00:00+00:00"], "2026-09-06T23:00:00+00:00")).toBe(7);
    expect(ecartDeCadence(DIMANCHES, "pas une date")).toBe(null);
  });
});

/**
 * ⛔ CE QUI SE JOUE ICI : « sept jours parce que la campagne est hebdomadaire » et « sept jours
 * parce qu'on n'a rien trouvé » donnent le MÊME classement et appellent deux gestes opposés. Rendre
 * un simple nombre effacerait la différence, et l'auteur croirait que sa période suit ses envois
 * alors qu'aucune récurrence n'est armée.
 */
describe("joursDeFenetre — la durée ET sa provenance", () => {
  test("une durée fixe est respectée et se dit `fixed`", async () => {
    const { joursDeFenetre } = await import("./article-views");
    expect(joursDeFenetre(30)).toEqual({ jours: 30, origine: "fixed" });
    // Même avec une cadence connue : le modèle a tranché, la campagne ne le contredit pas.
    expect(joursDeFenetre(30, 7)).toEqual({ jours: 30, origine: "fixed" });
  });

  test("la cadence de la campagne l'emporte quand le modèle la demande", async () => {
    const { joursDeFenetre } = await import("./article-views");
    expect(joursDeFenetre("cadence", 7)).toEqual({ jours: 7, origine: "cadence" });
    // Lundi + vendredi : quatre jours puis trois — c'est tout l'intérêt de suivre la cadence.
    expect(joursDeFenetre("cadence", 4)).toEqual({ jours: 4, origine: "cadence" });
    expect(joursDeFenetre("cadence", 3)).toEqual({ jours: 3, origine: "cadence" });
  });

  test("les deux façons de ne pas savoir ne se confondent PAS", async () => {
    const { joursDeFenetre, JOURS_PAR_DEFAUT } = await import("./article-views");
    // Aucune campagne : l'aperçu d'un modèle qui n'en a pas encore.
    expect(joursDeFenetre("cadence")).toEqual({ jours: JOURS_PAR_DEFAUT, origine: "no-campaign" });
    // Campagne connue, mais sans récurrence armée — c'est un défaut à corriger, pas un état normal.
    expect(joursDeFenetre("cadence", null)).toEqual({ jours: JOURS_PAR_DEFAUT, origine: "no-cadence" });
  });

  test("une cadence absurde lue en base est bornée, jamais propagée", async () => {
    const { joursDeFenetre } = await import("./article-views");
    // Une récurrence mal remplie ne doit produire ni fenêtre vide ni fenêtre de trois ans.
    expect(joursDeFenetre("cadence", 0).jours).toBe(1);
    expect(joursDeFenetre("cadence", 4000).jours).toBe(90);
    expect(joursDeFenetre(0).jours).toBe(1);
    expect(joursDeFenetre(4000).jours).toBe(90);
  });
});

/**
 * BANC DE LA ZONE FRAÎCHE ET DU MODE EFFECTIF (mode `mixed`, 03/09/2026).
 *
 * ⛔ CE QUI SE JOUE ICI : le mode `mixed` compose la lettre à partir de DEUX périodes. Si elles se
 * chevauchent, un article sort deux fois ; si un trou les sépare, des articles disparaissent sans
 * qu'aucun compteur ne bouge. Les deux défauts sont muets, et aucun ne se voit sur un aperçu.
 */
describe("fenetreClassement — la zone fraîche colle à la fenêtre mesurable", () => {
  const NOW = new Date("2026-09-01T12:00:00Z");

  test("les deux périodes se touchent exactement : la frontière est `avant`, pas un second repère", async () => {
    const { fenetreClassement } = await import("./article-views");
    const f = fenetreClassement(NOW, 7);
    // ⛔ Une seule limite. Un champ `fraisApres` distinct finirait par diverger de `avant` — c'est
    // la faute que cette fonction unique existe pour empêcher.
    expect(f.frontiereFraicheUtc.slice(0, 19)).toBe(f.avant.slice(0, 19));
    expect(f.fraisAvant).toBe(NOW.toISOString().slice(0, 19));
  });

  /**
   * ⛔ LE `Z` EST LA RAISON D'ÊTRE DU SECOND CHAMP. `avant` part dans `before` et WordPress le lit
   * dans le fuseau du SITE ; `frontiereFraicheUtc` sert à comparer des `publishedAt` issus de
   * `date_gmt`, donc de l'UTC. Sans le suffixe, `Date.parse` lirait la borne dans le fuseau de la
   * machine — trois heures d'écart chez northwind-sports, et les articles publiés en soirée changeraient de
   * moitié selon le serveur qui exécute le worker.
   */
  test("la frontière de comparaison porte son fuseau, la borne WordPress ne le porte pas", async () => {
    const { fenetreClassement } = await import("./article-views");
    const f = fenetreClassement(NOW, 7);
    expect(f.frontiereFraicheUtc.endsWith("Z")).toBe(true);
    expect(f.avant.endsWith("Z")).toBe(false);
    expect(Number.isFinite(Date.parse(f.frontiereFraicheUtc))).toBe(true);
  });

  /**
   * ⛔ LA ZONE FRAÎCHE DOIT ÊTRE ASSEZ LARGE POUR REMPLIR UNE MOITIÉ. C'est tout l'enjeu du mode
   * mixte : elle vaut le retard de l'entrepôt, à l'heure de l'envoi près — jamais zéro (la moitié
   * serait vide à chaque échéance), jamais plusieurs jours de plus (on servirait comme « récents »
   * des articles que l'entrepôt sait déjà mesurer).
   */
  test("la zone fraîche couvre le retard de l'entrepôt, ni plus ni moins", async () => {
    const { fenetreClassement, RETARD_ENTREPOT_JOURS } = await import("./article-views");
    const f = fenetreClassement(NOW, 7);
    const JOUR = 86_400_000;
    const largeur = (Date.parse(`${f.fraisAvant}Z`) - Date.parse(f.frontiereFraicheUtc)) / JOUR;
    expect(largeur > RETARD_ENTREPOT_JOURS - 1).toBe(true);
    expect(largeur <= RETARD_ENTREPOT_JOURS).toBe(true);
    // Et les trois bornes restent dans l'ordre, quelle que soit l'heure de l'envoi.
    expect(f.apres < f.avant).toBe(true);
    expect(f.avant < f.fraisAvant).toBe(true);
  });
});

/**
 * ⭐ LA DEMANDE D'ALIX (03/09/2026) : quotidienne ⇒ les derniers articles seulement ; hebdomadaire
 * ou plus ⇒ moitié-moitié. Le seuil n'est écrit nulle part en dur : il DÉCOULE du retard de
 * l'entrepôt, donc il suivra l'ingestion le jour où elle gagne ou perd un jour.
 */
describe("modeDeSelection — la cadence décide, pas un nombre magique", () => {
  test("une quotidienne ne peut pas classer par vues : elle sert les derniers", async () => {
    const { modeDeSelection } = await import("./article-views");
    expect(modeDeSelection("mixed", 1)).toEqual({ mode: "date", degrade: true });
    // ⛔ Deux jours non plus : l'entrepôt s'arrête à J−2, il n'y aurait rien de mesurable à classer.
    expect(modeDeSelection("mixed", 2)).toEqual({ mode: "date", degrade: true });
  });

  test("dès trois jours, le mélange a de quoi se composer", async () => {
    const { modeDeSelection } = await import("./article-views");
    expect(modeDeSelection("mixed", 3)).toEqual({ mode: "mixed", degrade: false });
    expect(modeDeSelection("mixed", 7)).toEqual({ mode: "mixed", degrade: false });
  });

  /**
   * ⛔ LE SEUIL SUIT `RETARD_ENTREPOT_JOURS`, IL NE LE RECOPIE PAS. Écrire « si cadence < 3 » aurait
   * donné le même résultat aujourd'hui et serait devenu faux le jour où l'ingestion change, sans
   * que personne ne fasse le lien. Ce témoin tombe si quelqu'un fige le 3.
   */
  test("témoin — la bascule est exactement au retard de l'entrepôt", async () => {
    const { modeDeSelection, cadencePeutClasserParVues, RETARD_ENTREPOT_JOURS } = await import("./article-views");
    expect(modeDeSelection("mixed", RETARD_ENTREPOT_JOURS)).toEqual({ mode: "date", degrade: true });
    expect(modeDeSelection("mixed", RETARD_ENTREPOT_JOURS + 1)).toEqual({ mode: "mixed", degrade: false });
    expect(cadencePeutClasserParVues(RETARD_ENTREPOT_JOURS)).toBe(false);
    expect(cadencePeutClasserParVues(RETARD_ENTREPOT_JOURS + 1)).toBe(true);
  });

  /**
   * ⚠️ CADENCE INCONNUE ⇒ ON SERT CE QUI EST DEMANDÉ. `undefined` (aucune campagne) et `null`
   * (campagne connue mais sans récurrence armée) veulent tous deux dire « on ne peut pas prouver
   * que la lettre est quotidienne » : retomber sur `date` retirerait en silence une règle que
   * l'auteur a posée, et il chercherait la panne dans l'entrepôt.
   */
  test("une cadence inconnue ne dégrade pas le mode", async () => {
    const { modeDeSelection } = await import("./article-views");
    expect(modeDeSelection("mixed", undefined)).toEqual({ mode: "mixed", degrade: false });
    expect(modeDeSelection("mixed", null)).toEqual({ mode: "mixed", degrade: false });
  });

  /** ⛔ La règle ne touche QUE `mixed` : elle n'a pas à changer le sens des deux modes existants. */
  test("les autres modes traversent sans être touchés", async () => {
    const { modeDeSelection } = await import("./article-views");
    expect(modeDeSelection("views", 1)).toEqual({ mode: "views", degrade: false });
    expect(modeDeSelection("date", 30)).toEqual({ mode: "date", degrade: false });
    // Un bloc dont le mode n'est pas encore écrit se comporte comme le défaut du schéma.
    expect(modeDeSelection(undefined, 1)).toEqual({ mode: "date", degrade: false });
  });

  /** ⚠️ Une récurrence mal remplie ne doit pas faire décider le mode sur une fraction de jour. */
  test("une cadence fractionnaire est tronquée, pas arrondie au supérieur", async () => {
    const { modeDeSelection } = await import("./article-views");
    // 2,9 jours reste une cadence de deux jours : pas encore de quoi classer.
    expect(modeDeSelection("mixed", 2.9)).toEqual({ mode: "date", degrade: true });
    expect(modeDeSelection("mixed", 3.1)).toEqual({ mode: "mixed", degrade: false });
  });
});

/**
 * L'INTERRUPTEUR DE CAMPAGNE (04/09/2026).
 *
 * ⭐ QUI DÉCIDE QUOI : le modèle dit COMMENT CLASSER, la campagne dit S'IL FAUT COMPLÉTER. Le
 * réglage vit dans la campagne parce qu'un modèle sert plusieurs campagnes — « Friday NL TW » et
 * « Resumo da rodada » partagent la version 509c87c3 — et qu'Alix veut le mélange sur l'une et pas
 * sur l'autre.
 *
 * ⛔ LES DEUX FAÇONS DONT CETTE CASE POURRAIT NUIRE SANS LEVER D'ERREUR :
 *  1. promouvoir un bloc « les plus récents », qui exigerait alors une propriété d'audience élue —
 *     goalpost-weekly n'en a plus depuis le 16/08, et des blocs qui marchaient deviendraient des
 *     refus ;
 *  2. faire perdre au bloc son classement par vues quand le mélange est impossible : la case
 *     n'ajoute qu'une chose, elle ne doit jamais pouvoir en retirer une autre.
 */
describe("modeDeSelection — l'interrupteur vit dans la campagne", () => {
  test("un bloc classé par vues + la case cochée ⇒ mélange", async () => {
    const { modeDeSelection } = await import("./article-views");
    expect(modeDeSelection("views", 7, true)).toEqual({ mode: "mixed", degrade: false });
  });

  test("la case décochée, absente ou nulle laisse le bloc tel quel", async () => {
    const { modeDeSelection } = await import("./article-views");
    expect(modeDeSelection("views", 7, false)).toEqual({ mode: "views", degrade: false });
    expect(modeDeSelection("views", 7, undefined)).toEqual({ mode: "views", degrade: false });
    // `null` = la colonne n'a jamais été écrite. Ce n'est pas « oui ».
    expect(modeDeSelection("views", 7, null)).toEqual({ mode: "views", degrade: false });
  });

  /**
   * ⛔ LA CASE NE PROMEUT JAMAIS UN BLOC « LES PLUS RÉCENTS ». Le mélange a besoin d'un lecteur de
   * vues ; un bloc `date` promu de force refuserait de se résoudre sur toute marque sans propriété
   * d'audience élue. Une porte qui condamne en masse n'est pas un réglage.
   * MUTATION QUI DOIT TUER CE TEST : retirer le `orderby === "views" &&` de `veutMelange`.
   */
  test("un bloc « les plus récents » n'est JAMAIS promu par la case", async () => {
    const { modeDeSelection } = await import("./article-views");
    expect(modeDeSelection("date", 7, true)).toEqual({ mode: "date", degrade: false });
    expect(modeDeSelection(undefined, 7, true)).toEqual({ mode: "date", degrade: false });
  });

  /**
   * ⛔ LA DÉGRADATION RAMÈNE AU MODE DU BLOC, PAS À `date`. Une quotidienne dont la case est cochée
   * perd le MÉLANGE ; elle garde le classement par vues que le modèle demandait. Sinon la case
   * d'une campagne effacerait un réglage du modèle qui n'est pas le sien.
   * MUTATION QUI DOIT TUER CE TEST : rendre `{ mode: "date", degrade: true }` au lieu de `base`.
   */
  test("quotidienne + case cochée : le mélange saute, le classement par vues reste", async () => {
    const { modeDeSelection } = await import("./article-views");
    expect(modeDeSelection("views", 1, true)).toEqual({ mode: "views", degrade: true });
    expect(modeDeSelection("views", 2, true)).toEqual({ mode: "views", degrade: true });
    // ⛔ TÉMOIN — l'héritage `mixed`, lui, retombe bien sur `date` : c'est le mode que ce bloc
    // demandait sans mélange, et le comportement du 03/09 ne change pas.
    expect(modeDeSelection("mixed", 1, false)).toEqual({ mode: "date", degrade: true });
  });

  /**
   * ⚠️ `orderby: "mixed"` est un héritage : l'option a quitté l'inspecteur le 04/09, mais le schéma
   * l'accepte encore pour ne casser aucun document. Un document qui le porte est HONORÉ — un
   * réglage écrit puis ignoré en silence est le pire des deux mondes. Les deux entrées sont deux
   * façons de dire oui, jamais deux avis à départager.
   */
  test("l'héritage `mixed` du bloc reste honoré, case ou pas", async () => {
    const { modeDeSelection } = await import("./article-views");
    expect(modeDeSelection("mixed", 7, false)).toEqual({ mode: "mixed", degrade: false });
    expect(modeDeSelection("mixed", 7, true)).toEqual({ mode: "mixed", degrade: false });
  });

  test("cadence inconnue : la case s'applique quand même", async () => {
    const { modeDeSelection } = await import("./article-views");
    // ⭐ C'est ce qui rend cet interrupteur exerçable AUJOURD'HUI : les quatre campagnes en base
    // ont `recurrence_active = false`, donc aucune cadence — contrairement à la fenêtre par cadence
    // et à `{{edition_number}}`, ce réglage n'attend pas qu'Alix arme une récurrence.
    expect(modeDeSelection("views", null, true)).toEqual({ mode: "mixed", degrade: false });
    expect(modeDeSelection("views", undefined, true)).toEqual({ mode: "mixed", degrade: false });
  });
});
