/**
 * DÉMARRER ET ARRÊTER UNE SÉRIE — ce que les écrans demandent à `/api/campaigns/[id]/arm`.
 *
 * ⛔ DEUX DÉCISIONS D'ALIX, GARDÉES ENSEMBLE PARCE QU'ELLES TOUCHENT LA MÊME ROUTE :
 *  1. 18/09/2026 — arrêter une série ANNULE ce qui est déjà planifié, et l'écran NOMME ce qu'il va
 *     annuler avant le clic. Le défaut d'origine : « Disarm » dans l'assistant et « Turn off » dans
 *     le panneau appelaient la MÊME route avec des intentions opposées.
 *  2. 22/09/2026 — « arm » disparaît de l'écran. Une série se termine dans l'assistant par UN geste,
 *     « Start series », qui est le bouton principal, gardé comme un envoi unique (saisie de SCHEDULE
 *     au-delà de 5 000 destinataires, coupure Gmail, cadence enregistrée) — et qui ne verrouille
 *     JAMAIS (une série n'est jamais verrouillée : `/arm` refuse une campagne verrouillée).
 *
 * ⛔ POURQUOI UN GARDE DE SOURCE ET PAS UN TEST DE COMPORTEMENT : les gestes vivent dans des
 * composants clients, et le dépôt n'a pas de banc de rendu React. Ce qui doit être tenu n'est pas une
 * valeur de retour, c'est **ce que les écrans demandent à la route**, et l'accord entre eux.
 *
 * ⚠️ Ce fichier ne garde PAS le comportement du serveur — `arm/handler.test.ts` s'en charge (refus,
 * écriture, aperçu). Le `DELETE` de la route reste capable de ne rien annuler si on ne lui demande
 * rien : c'est pourquoi TOUT écran qui l'appelle est lu ici, pas seulement les deux d'aujourd'hui.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/** La source SANS ses commentaires : ils citent `cancelUpcoming` et « arm » pour l'expliquer, et un
 *  comptage qui les inclut mesure la prose au lieu du code. */
const sansCommentairesTexte = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
const sansCommentaires = (url: URL) => sansCommentairesTexte(readFileSync(url, "utf8"));

const PANNEAU = sansCommentaires(new URL("./series-panel.tsx", import.meta.url));
const ASSISTANT = sansCommentaires(new URL("./campaign-wizard.tsx", import.meta.url));

/** TOUS les écrans de l'admin (`.tsx`), commentaires retirés — un troisième écran qui arrêterait une
 *  série sans annuler serait le défaut d'origine revenu par une porte que personne ne regarde. */
const SRC = fileURLToPath(new URL("../../", import.meta.url));
const ECRANS_ADMIN: Array<[string, string]> = (readdirSync(SRC, { recursive: true }) as string[])
  .filter((f) => f.endsWith(".tsx") && !f.includes(".test."))
  .map((f) => [f.replaceAll("\\", "/"), sansCommentairesTexte(readFileSync(join(SRC, f), "utf8"))]);

/** Les appels `fetch`/`appeler` visant `…/arm`, avec ce qui suit jusqu'à la fin de l'appel. */
const appelsArm = (src: string) => [...src.matchAll(/\/arm(\?[^`]*)?`[^;]*/g)].map((m) => m[0]);

/** Le corps d'une fonction nommée, accolades équilibrées — ou `""` si elle n'existe pas. */
function corpsDe(src: string, signature: string): string {
  const debut = src.indexOf(signature);
  if (debut < 0) return "";
  const ouvrante = src.indexOf("{", src.indexOf(")", debut));
  let profondeur = 0;
  for (let i = ouvrante; i < src.length; i++) {
    if (src[i] === "{") profondeur++;
    else if (src[i] === "}" && --profondeur === 0) return src.slice(ouvrante, i + 1);
  }
  return "";
}

/** Les éléments `<button …>…</button>` dont le texte contient `motif`. */
const boutonsAvec = (src: string, motif: string) =>
  [...src.matchAll(/<button[\s\S]*?<\/button>/g)].map((m) => m[0]).filter((b) => b.includes(motif));

describe("arrêter une série — AUCUN écran ne peut le faire sans annuler les éditions planifiées", () => {
  test("tout DELETE sur /arm, dans TOUT l'admin, demande l'annulation — et le panneau en a un", () => {
    // MUTATION QUI DOIT TUER CE TEST : retirer `?cancelUpcoming=1` de l'appel du panneau — le défaut
    // d'origine exactement : « arrêter » laissait partir les éditions déjà planifiées.
    const fautifs: string[] = [];
    let total = 0;
    for (const [fichier, src] of ECRANS_ADMIN) {
      for (const appel of appelsArm(src).filter((a) => a.includes('method: "DELETE"'))) {
        total++;
        if (!appel.includes("/arm?cancelUpcoming=1")) fautifs.push(fichier);
      }
    }
    expect(fautifs).toEqual([]);
    expect(total).toBeGreaterThan(0);
    expect(appelsArm(PANNEAU).filter((a) => a.includes('method: "DELETE"')).length).toBeGreaterThan(0);
  });

  test("⛔ ABSENCE — plus aucun chemin ne peut arrêter SANS annuler", () => {
    // MUTATION QUI DOIT TUER CE TEST : remettre le choix (`cancelUpcoming=${…}`) ou le remettre à 0.
    // Une case à cocher qui vaut `false` par défaut redonne au geste son ancien comportement, et
    // c'est celui qui laissait des envois sortir APRÈS l'arrêt.
    for (const [fichier, src] of ECRANS_ADMIN) {
      expect(`${fichier}:${src.includes("cancelUpcoming=0")}`).toBe(`${fichier}:false`);
      expect(`${fichier}:${/cancelUpcoming=\$\{/.test(src)}`).toBe(`${fichier}:false`);
    }
  });

  test("⛔ le panneau DIT ce qui va être annulé AVANT le clic, et le bouton le nomme", () => {
    // Alix : « attention de bien le préciser ». Un geste destructeur annoncé seulement par son
    // résultat est un geste non annoncé. Le panneau relit les dates, les liste, et seul le bouton de
    // la vue de confirmation arrête — « Stop series » au repos ne fait que charger cette vue.
    expect(PANNEAU).toContain("already planned");
    expect(PANNEAU).toContain("Stop and cancel ");
    expect(PANNEAU).toContain("aVenir.dates.slice(");
    expect(PANNEAU).toContain("onClick={demanderExtinction}");
    const occurrences = PANNEAU.split("onClick={eteindre}").length - 1;
    expect(occurrences).toBe(1);
    expect(PANNEAU.indexOf("onClick={eteindre}")).toBeGreaterThan(PANNEAU.indexOf('vue === "extinction"'));
  });

  test("l'assistant n'arrête rien : il n'a plus de DELETE sur /arm (l'arrêt vit sur la page de campagne)", () => {
    // Un arrêt depuis la modale devait passer par un `window.confirm` faute de place pour lister les
    // dates. Il n'existe plus : la seule porte d'arrêt est celle qui NOMME ce qu'elle annule.
    expect(appelsArm(ASSISTANT).filter((a) => a.includes('method: "DELETE"'))).toEqual([]);
  });
});

describe("démarrer une série — « Start series »", () => {
  test("⛔ le témoin : démarrer NE passe PAS l'annulation, dans les deux écrans", () => {
    // Sans lui, « coller `cancelUpcoming=1` sur toutes les URL de /arm » passerait les tests
    // ci-dessus — et démarrer annulerait des éditions à chaque fois qu'on relance la série.
    for (const [nom, src] of [["panneau de série", PANNEAU], ["assistant", ASSISTANT]] as const) {
      const demarrages = appelsArm(src).filter((a) => a.includes('method: "POST"'));
      expect(`${nom}:${demarrages.length > 0}`).toBe(`${nom}:true`);
      for (const appel of demarrages) expect(`${nom}:${appel.includes("cancelUpcoming")}`).toBe(`${nom}:false`);
    }
  });

  const DEMARRER = corpsDe(ASSISTANT, "async function demarrerSerie(");

  test("⛔ l'action finale d'une série appelle POST /arm, et JAMAIS /lock ni /schedule", () => {
    // MUTATION QUI DOIT TUER CE TEST : verrouiller avant de démarrer (`/lock`). `/arm` refuse une
    // campagne verrouillée : la série deviendrait impossible à démarrer, avec un refus incompréhensible.
    expect(DEMARRER).not.toBe("");
    expect(DEMARRER).toMatch(/\/arm`, \{ method: "POST" \}/);
    expect(DEMARRER).not.toContain("/lock");
    expect(DEMARRER).not.toContain("/schedule");
    expect(DEMARRER).not.toContain("cancelUpcoming");
  });

  test("⛔ c'est le BOUTON PRINCIPAL qui démarre, et il est gardé par `canConfirm`", () => {
    // MUTATION QUI DOIT TUER CE TEST : `disabled={busy}` au lieu de `disabled={!canConfirm}` — le
    // défaut du petit bouton ambre, qui sautait la saisie de SCHEDULE et la coupure Gmail.
    const boutons = boutonsAvec(ASSISTANT, "demarrerSerie");
    expect(boutons.length).toBe(1);
    expect(boutons[0]).toContain("disabled={!canConfirm}");
    expect(boutons[0]).toContain('onClick={mode === "series" ? demarrerSerie : lockAndSchedule}');
    expect(boutons[0]).toContain('"Start series"');
  });

  test("⛔ la fonction elle-même refuse de partir sans `canConfirm` (défense en profondeur)", () => {
    const garde = DEMARRER.slice(0, DEMARRER.indexOf("setBusy(true)"));
    expect(garde).toContain("!canConfirm");
    expect(garde).toContain('mode !== "series"');
  });

  test("⛔ `canConfirm` porte les MÊMES gardes pour une série que pour un envoi unique", () => {
    // Une série fait partir ces destinataires CHAQUE semaine : elle n'a droit à aucune garde de moins.
    const expr = ASSISTANT.slice(ASSISTANT.indexOf("const canConfirm ="), ASSISTANT.indexOf(";", ASSISTANT.indexOf("const canConfirm =")));
    expect(expr).toContain("typedOk");
    expect(expr).toContain("!overClip");
    expect(expr).toContain("recurrenceSaved");
  });

  test("⛔ ABSENCE — on ne peut plus finir une série sans la démarrer", () => {
    // « Done — cadence saved » fermait l'assistant : la série restait arrêtée, et personne ne savait
    // pourquoi rien ne partait (mesuré en production le 22/09/2026, campagne « Test »).
    expect(ASSISTANT).not.toContain('mode === "series" ? close');
    expect(ASSISTANT).not.toContain("Done — cadence saved");
  });
});

/**
 * ⛔ LE MÊME INVARIANT CÔTÉ SERVEUR — AUCUNE ROUTE N'ARRÊTE UNE SÉRIE SANS ANNULER CE QUI EST PLANIFIÉ.
 *
 * Né de l'archivage (0077, 22/09/2026) : une TROISIÈME route arrête désormais une série. Les deux
 * premières (`DELETE /arm`, retrait de cadence) annulaient ; une troisième qui l'oublierait laisserait
 * partir, série arrêtée ET rangée, les éditions déjà gelées — l'écran jurerait qu'elle est en pause.
 * Garde de SOURCE, comme le reste de ce fichier : c'est l'ordre des écritures qui est tenu.
 */
describe("⛔ côté serveur — toute route qui arrête une série annule ensuite les éditions à venir", () => {
  const API = fileURLToPath(new URL("../../app/api/", import.meta.url));
  const ROUTES: Array<[string, string]> = (readdirSync(API, { recursive: true }) as string[])
    .filter((f) => f.endsWith(".ts") && !f.includes(".test."))
    .map((f) => [f.replaceAll("\\", "/"), sansCommentairesTexte(readFileSync(join(API, f), "utf8"))]);

  test("chaque écriture de `recurrence_active: false` est suivie d'un appel à cancelUpcomingOccurrences", () => {
    // MUTATION QUI DOIT TUER CE TEST : retirer l'annulation de la route d'archivage (ou de n'importe
    // quelle route qui arrête une série).
    const fautifs: string[] = [];
    let total = 0;
    for (const [fichier, src] of ROUTES) {
      let i = src.indexOf("recurrence_active: false");
      while (i >= 0) {
        total++;
        if (src.indexOf("cancelUpcomingOccurrences(", i) < 0) fautifs.push(fichier);
        i = src.indexOf("recurrence_active: false", i + 1);
      }
    }
    expect(fautifs).toEqual([]);
    // Le témoin : les trois routes qui arrêtent aujourd'hui (arrêt, retrait de cadence, archivage).
    expect(total).toBeGreaterThanOrEqual(3);
  });

  test("l'archivage : arrêt UNE fois, PUIS annulation, PUIS rangement — jamais un autre ordre", () => {
    const src = ROUTES.find(([f]) => f.endsWith("campaigns/[id]/archive/handler.ts"))?.[1] ?? "";
    expect(src).not.toBe("");
    expect(src.split("recurrence_active: false").length - 1).toBe(1);
    const arret = src.indexOf("recurrence_active: false");
    const annulation = src.indexOf("cancelUpcomingOccurrences(");
    const rangement = src.indexOf("archived_at: maintenant");
    expect(arret).toBeGreaterThan(0);
    expect(annulation).toBeGreaterThan(arret);
    expect(rangement).toBeGreaterThan(annulation);
    // ⛔ Et jamais la porte TERMINALE : archiver promet une pause.
    expect(src).not.toMatch(/status:\s*"cancelled"/);
  });
});

describe("⛔ vocabulaire — « arm » a disparu de l'écran (Alix, 22/09/2026)", () => {
  test("aucun texte de l'admin ne dit arm / armed / arming / disarm", () => {
    // Les URL `/arm` et les identifiants de code restent : c'est le mot AFFICHÉ qui trompait.
    // MUTATION QUI DOIT TUER CE TEST : remettre « Series armed » ou « Disarm » dans un écran.
    const MOT = /(?<![\p{L}\p{N}_])(arm|arms|armed|arming|disarm|disarmed|disarming)(?![\p{L}\p{N}_])/iu;
    const trouves: string[] = [];
    for (const [fichier, src] of ECRANS_ADMIN) {
      const lignes = src.replace(/\/arm\b/g, "/ROUTE").split("\n");
      for (const l of lignes) if (MOT.test(l)) trouves.push(`${fichier}: ${l.trim()}`);
    }
    expect(trouves).toEqual([]);
  });
});
