/**
 * LA COLONNE « SUBSCRIPTION OPTIONS » — le garde de ce qui ne peut pas être rendu ici.
 *
 * Cette suite ne monte pas de composant : le dépôt n'a pas de banc de rendu React, et en ajouter un
 * pour une colonne coûterait plus que ce qu'il protège. On tient donc, sur la SOURCE, les trois
 * propriétés qu'un rendu aurait vérifiées — et uniquement celles-là.
 *
 * ⛔ CE GARDE NE CITE PAS LE JSX, il tient une ABSENCE, un ORDRE et un ACCORD. Un motif qui
 * décrirait la cellule entière rougirait au premier reformatage sans qu'aucune propriété n'ait
 * bougé (même doctrine que `apps/worker/src/debit.test.ts`).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const TABLE = readFileSync(new URL("./bulk-actions.tsx", import.meta.url), "utf8");
const DRAWER = readFileSync(new URL("./subscriber-drawer.tsx", import.meta.url), "utf8");

/** La source SANS ses commentaires : ils citent les clés et les libellés pour les expliquer, et un
 *  comptage qui les inclut mesure la prose au lieu du code. */
const sansCommentaires = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join("\n");

const CODE = sansCommentaires(TABLE);

describe("colonne Subscription options — l'ordre demandé et la structure du tableau", () => {
  test("⛔ ORDRE — la colonne est JUSTE APRÈS « Tags & interests », comme demandé", () => {
    // MUTATION QUI DOIT TUER CE TEST : déplacer l'en-tête ailleurs dans le `<thead>`. La demande
    // nomme la position (« à côté de la colonne tag »), pas seulement la présence : une colonne
    // correcte au mauvais endroit est un autre écran.
    const entetes = [...CODE.matchAll(/<HeadCell[^>]*>([^<]+)<\/HeadCell>/g)].map((m) => m[1].trim());
    const iTags = entetes.indexOf("Tags &amp; interests");
    const iOptions = entetes.indexOf("Subscription options");
    expect(iTags).toBeGreaterThan(-1);
    expect(iOptions).toBe(iTags + 1);
  });

  test("⛔ STRUCTURE — autant de cellules que d'en-têtes, sinon TOUT le tableau glisse", () => {
    // MUTATION QUI DOIT TUER CE TEST : ajouter l'en-tête sans la cellule (ou l'inverse). Le défaut
    // ne se voit alors sur AUCUNE colonne en particulier : chaque valeur se décale d'un cran vers
    // la droite, et « Joined » affiche des finalités.
    const thead = CODE.match(/<thead>[\s\S]*?<\/thead>/)?.[0] ?? "";
    const ligne = CODE.match(/<tr\s+key=\{s\.id\}[\s\S]*?\n {16}<\/tr>/)?.[0] ?? "";
    expect(thead).not.toBe("");
    expect(ligne).not.toBe("");
    const nbEntetes = (thead.match(/<HeadCell[\s>]/g) ?? []).length;
    const nbCellules = (ligne.match(/<Td[\s>]/g) ?? []).length;
    // ⛔ L'ÉGALITÉ est la propriété, pas le total : figer « 10 » ferait rougir ce test le jour où
    // une colonne légitime s'ajoute, pour un défaut qui n'existe pas. Le plancher ne sert qu'à
    // empêcher un `0 === 0` silencieux si les deux motifs cessaient de matcher.
    expect(nbEntetes).toBeGreaterThanOrEqual(10);
    expect(nbCellules).toBe(nbEntetes);
  });
});

describe("colonne Subscription options — une clé absente n'est pas un refus", () => {
  test("⛔ ABSENCE — la cellule n'énumère pas les finalités, elle filtre celles à `true`", () => {
    // MUTATION QUI DOIT TUER CE TEST : rendre `PURPOSE_ORDER.map(...)` dans la cellule, comme le
    // drawer. Le drawer montre UNE souscription et peut barrer les refusées ; une ligne de tableau
    // qui affiche les 4 ferait passer « jamais demandé » pour « a refusé » sur les 1 105
    // abonnements antérieurs au recueil du choix (mesuré en base le 18/09/2026).
    expect(/\bconst accordees = Object\.keys\(s\.purposes\)/.test(CODE)).toBe(true);
    expect(/\.filter\(\(p\) => s\.purposes\[p\] === true\)/.test(CODE)).toBe(true);
    // `PURPOSE_ORDER` ne sert QU'au tri : il ne doit jamais devenir la liste rendue.
    expect(/PURPOSE_ORDER\.map\(/.test(CODE)).toBe(false);
  });

  test("⛔ les deux silences restent deux mots différents", () => {
    // MUTATION QUI DOIT TUER CE TEST : écrire « — » dans les deux cas. Un objet vide (le choix n'a
    // jamais été recueilli) et des clés toutes à `false` (la personne a tout refusé) sont deux
    // états distincts en base — les confondre à l'écran invente une réponse.
    expect(CODE).toContain('Object.keys(s.purposes).length ? "None" : "—"');
  });
});

describe("colonne Subscription options — un seul vocabulaire pour les deux écrans", () => {
  /** Les paires `clé: "Libellé"` de la table `PURPOSE_LABEL` d'un fichier. */
  const libelles = (src: string): Record<string, string> => {
    const bloc = sansCommentaires(src).match(/const PURPOSE_LABEL[^=]*=\s*\{([\s\S]*?)\};/)?.[1] ?? "";
    return Object.fromEntries([...bloc.matchAll(/(\w+)\s*:\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]));
  };

  test("le tableau et le drawer nomment les finalités EXACTEMENT pareil", () => {
    // MUTATION QUI DOIT TUER CE TEST : renommer une finalité d'un seul côté, ou afficher la clé
    // brute. La capture dit `newsletter`, le stockage dit `content` : si les deux écrans ne
    // s'accordent pas, une même personne paraît avoir coché deux choses différentes.
    const table = libelles(TABLE);
    const drawer = libelles(DRAWER);
    expect(Object.keys(drawer).length).toBe(4);
    expect(table).toEqual(drawer);
  });

  test("le tri couvre les quatre finalités connues, dans l'ordre du formulaire", () => {
    // Deux lignes voisines doivent présenter leurs pastilles dans le même ordre, sinon la colonne
    // devient illisible à la verticale.
    const ordre = CODE.match(/const PURPOSE_ORDER = \[([^\]]+)\]/)?.[1] ?? "";
    expect([...ordre.matchAll(/"([^"]+)"/g)].map((m) => m[1]))
      .toEqual(["content", "offers", "events", "partners"]);
  });
});
