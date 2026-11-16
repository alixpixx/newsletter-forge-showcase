/**
 * LE PREMIER BANC DE `@nf/segments` — et il arrive tard pour un paquet qui décide QUI reçoit.
 *
 * Ce compilateur a trois appelants : l'écran de segment (qui affiche un nombre), l'estimation
 * d'audience d'une campagne (qui affiche le même nombre ailleurs) et le fan-out (qui écrit une
 * ligne de file par personne). Les trois passent par la MÊME fonction, et c'est tout ce qui
 * garantit que le nombre annoncé et le nombre envoyé parlent de la même population. Un défaut ici
 * ne se voit donc jamais comme une incohérence : les deux moitiés restent d'accord entre elles,
 * et se trompent ensemble.
 *
 * ⚠️ CE QUI N'EST PAS TESTÉ ICI : que PostgREST comprenne les expressions produites. Ce paquet ne
 * connaît pas la base. La correspondance colonne↔vue est vérifiée par la migration 0052 et par la
 * mesure en base, pas par ce fichier.
 */
import { describe, expect, test } from "bun:test";
import { compileRule, type RuleContext } from "./compile";
import {
  FIELDS, NO_OPTIN, OP_LABEL, defaultValue,
  type Group, type Operator, type PredValue,
} from "./fields";

const GUIA = "11111111-2222-4333-8444-555555555555";
const NEWSLETTER_FOOTER = "99999999-8888-4777-8666-555555555555";

/** Provenance : deux campagnes d'acquisition, une créative, deux intérêts, tous de CETTE marque. */
const COPA = "3f2a8c11-1111-4222-8333-444444444444";
const CLAUSURA = "9c1b4d02-1111-4222-8333-444444444444";
const CREATIVE_A = "7d40aa33-1111-4222-8333-444444444444";
const CAMPAGNE_AUTRE_MARQUE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const CTX: RuleContext = {
  tagIdBySlug: { vip: 7, futebol: 12 },
  optinIdBySlug: { guia: GUIA, "footer-newsletter": NEWSLETTER_FOOTER },
  captureCampaignIds: [COPA, CLAUSURA],
  captureOptinIds: [CREATIVE_A],
  interestIds: [7, 12],
};

/** Un prédicat seul, enveloppé dans le groupe racine que le compilateur attend. */
function regle(field: string, op: Operator, value: PredValue): Group {
  return {
    id: "root",
    type: "group",
    op: "AND",
    children: [{ id: "n1", type: "predicate", field, op, value }],
  };
}

const compile = (node: Group, ctx: RuleContext = CTX) => compileRule(node, ctx);

/**
 * ⛔ LE TEST QUI ATTRAPE LA CASE OUBLIÉE — et aucun test « cas heureux » ne le peut.
 *
 * Le compilateur dispatchait sur des ternaires BINAIRES (`p.op === "has" ? A : B`). Un opérateur
 * neuf n'y produit pas une erreur : il tombe dans le `else`, c'est-à-dire dans la NÉGATION du
 * filtre demandé. `creative any_of ["A"]` compilait ainsi en « toute la marque sauf A », avec
 * `widened: false` et `unsupported: []` — un envoi PLUS LARGE que la règle affichée, sans qu'aucun
 * garde-fou ne se lève.
 *
 * La liste des opérateurs est dérivée de `OP_LABEL` (un `Record<Operator, string>` exhaustif) et
 * non recopiée : une liste recopiée ici cesserait de couvrir le jour où l'union grandit, sans
 * qu'une seule ligne rougisse — exactement le défaut qu'on teste.
 */
const ALL_OPS = Object.keys(OP_LABEL) as Operator[];

describe("produit cartésien Opérateur × Champ — toute paire non déclarée rend null", () => {
  for (const f of FIELDS) {
    for (const op of ALL_OPS) {
      if (f.ops.includes(op)) continue;
      test(`${f.key} × ${op} ⇒ null`, () => {
        // MUTATION QUI DOIT TUER CE TEST : rouvrir n'importe lequel des six `switch` en ternaire
        // binaire, ou retirer la garde « le champ déclare-t-il cet opérateur ».
        const { expr } = compile(regle(f.key, op, defaultValue(f)));
        expect(expr).toBeNull();
      });
    }
  }
});

describe("optin — le formulaire d'origine devient un ciblage", () => {
  test("« is <formulaire> » vise l'identifiant de la base, jamais le slug", () => {
    // MUTATION QUI DOIT TUER CE TEST : interpoler `p.value` au lieu de `ctx.optinIdBySlug[...]`.
    // Le slug est une saisie, l'identifiant est une donnée — seul le second entre dans une requête.
    const { expr, unsupported } = compile(regle("optin", "eq", "guia"));
    expect(expr).toBe(`optin_id.eq.${GUIA}`);
    expect(expr).not.toContain("guia");
    expect(unsupported).toEqual([]);
  });

  /**
   * ⛔ LE TEST CENTRAL DE CE FICHIER.
   *
   * MUTATION QUI DOIT LE TUER : remplacer la disjonction par `optin_id.neq.<id>` seul.
   *
   * En SQL, `NULL <> 'x'` ne vaut pas « vrai », il vaut NULL — donc faux. Les 1 203 souscriptions
   * antérieures au lot optin ont toutes `optin_id` à NULL. Un `neq` nu les exclurait donc de
   * « tout sauf le guide », alors qu'elles ne viennent précisément PAS du guide. Personne ne le
   * verrait : le compte serait cohérent avec l'envoi, et les deux seraient faux.
   */
  test("« is not <formulaire> » GARDE les contacts sans formulaire", () => {
    const { expr } = compile(regle("optin", "neq", "guia"));
    expect(expr).toBe(`or(optin_id.neq.${GUIA},optin_id.is.null)`);
    expect(expr).toContain("is.null");
  });

  test("« aucun formulaire » est une valeur, pas une absence", () => {
    // MUTATION QUI DOIT TUER CE TEST : traiter NO_OPTIN comme un slug ordinaire. Il n'est dans
    // aucune table, donc le prédicat serait ignoré — et « les contacts sans optin » viserait
    // silencieusement toute la marque.
    expect(compile(regle("optin", "eq", NO_OPTIN)).expr).toBe("optin_id.is.null");
    expect(compile(regle("optin", "neq", NO_OPTIN)).expr).toBe("optin_id.not.is.null");
  });

  test("un formulaire inconnu de la marque est DÉNONCÉ PAR SON NOM, et élargit", () => {
    // Le cas réel : un segment enregistré cite un optin archivé puis supprimé, ou l'écran a servi
    // la liste d'une autre marque.
    // MUTATION QUI DOIT TUER CE TEST : pousser `p.field` au lieu de `field:valeur`. Un
    // avertissement qui dit « optin » sans dire LEQUEL n'est pas actionnable quand la règle en
    // porte trois.
    const { expr, unsupported, widened } = compile(regle("optin", "eq", "formulaire-fantome"));
    expect(expr).toBeNull();
    expect(unsupported).toEqual(["optin:formulaire-fantome"]);
    expect(widened).toBe(true);
  });

  test("une table qui rend autre chose qu'un uuid ne compile pas", () => {
    // Ceinture : la valeur vient de la base, donc elle est censée être sûre. « Censée » n'est pas
    // une garantie — c'est la seule valeur de ce fichier qui soit interpolée sans quotes.
    const ctx: RuleContext = { ...CTX, optinIdBySlug: { guia: "1;drop table" } };
    const { expr, unsupported } = compile(regle("optin", "eq", "guia"), ctx);
    expect(expr).toBeNull();
    expect(unsupported).toEqual(["optin:guia"]);
  });

  test("le formulaire se combine avec le reste de la règle", () => {
    // Un ET entre « vient du guide » et « parle portugais » : c'est l'usage qu'Alix a décrit
    // (« trier mes contacts et envoyer une newsletter dédiée à la bonne liste sur le même site »).
    const { expr, unsupported } = compile({
      id: "root",
      type: "group",
      op: "AND",
      children: [
        { id: "n1", type: "predicate", field: "optin", op: "eq", value: "guia" },
        { id: "n2", type: "predicate", field: "language", op: "eq", value: "pt-BR" },
      ],
    });
    expect(expr).toBe(`and(optin_id.eq.${GUIA},language.eq."pt-BR")`);
    expect(unsupported).toEqual([]);
  });

  test("la disjonction du « is not » survit à l'imbrication dans un OU", () => {
    // MUTATION QUI DOIT TUER CE TEST : produire `optin_id.neq.<id>` sans parenthèses propres.
    // Une expression mal parenthésée à l'intérieur d'un groupe change le sens de TOUT le groupe.
    const { expr } = compile({
      id: "root",
      type: "group",
      op: "OR",
      children: [
        { id: "n1", type: "predicate", field: "optin", op: "neq", value: "guia" },
        { id: "n2", type: "predicate", field: "country", op: "eq", value: "BR" },
      ],
    });
    expect(expr).toBe(`or(or(optin_id.neq.${GUIA},optin_id.is.null),country.eq."BR")`);
  });
});

/**
 * ⛔ LA SECTION LA PLUS IMPORTANTE DE CE FICHIER.
 *
 * Un prédicat qu'on ne sait pas compiler était jeté et le reste assemblé. L'asymétrie va dans le
 * mauvais sens : sous un ET, jeter un terme AJOUTE des destinataires. L'écran, lui, continue
 * d'afficher la règle entière — donc rien ne révèle l'écart, et l'effet d'un envoi ne se reprend
 * pas. Ce qui suit vérifie que le compilateur le DIT, et que ce qu'il dit distingue les deux sens.
 */
describe("un prédicat écarté sous un ET élargit l'audience — et doit être refusé", () => {
  test("terme perdu dans un ET ⇒ widened", () => {
    // MUTATION QUI DOIT TUER CE TEST : retirer la comparaison `parts.length < children.length`.
    // Le filtre compilerait « pays = BR » seul, pour une règle qui dit « BR ET tagué vip-parti ».
    const { expr, unsupported, widened } = compile({
      id: "root",
      type: "group",
      op: "AND",
      children: [
        { id: "n1", type: "predicate", field: "country", op: "eq", value: "BR" },
        { id: "n2", type: "predicate", field: "tag", op: "has", value: "vip-parti" },
      ],
    });
    expect(widened).toBe(true);
    expect(unsupported).toEqual(["tag:vip-parti"]);
    // L'expression reste calculée — l'appelant refuse, ce paquet ne décide pas à sa place.
    expect(expr).toBe('country.eq."BR"');
  });

  test("terme perdu dans un OU ⇒ PAS widened", () => {
    // L'autre sens de l'asymétrie, et il faut qu'il reste distinct : un OU privé d'une branche
    // vise MOINS de monde. Refuser ici bloquerait des envois parfaitement sûrs.
    const { unsupported, widened } = compile({
      id: "root",
      type: "group",
      op: "OR",
      children: [
        { id: "n1", type: "predicate", field: "country", op: "eq", value: "BR" },
        { id: "n2", type: "predicate", field: "tag", op: "has", value: "vip-parti" },
      ],
    });
    expect(widened).toBe(false);
    expect(unsupported).toEqual(["tag:vip-parti"]);
  });

  test("un sous-groupe OU entièrement effondré élargit son parent ET", () => {
    // Le cas qu'un test par prédicat rate : chaque branche du OU est signalée, le OU rend `null`,
    // et c'est le PARENT qui perd un terme. « BR ET (vip OU futebol) » devient « BR ».
    const { expr, widened } = compile({
      id: "root",
      type: "group",
      op: "AND",
      children: [
        { id: "n1", type: "predicate", field: "country", op: "eq", value: "BR" },
        {
          id: "g1", type: "group", op: "OR", children: [
            { id: "n2", type: "predicate", field: "tag", op: "has", value: "parti-1" },
            { id: "n3", type: "predicate", field: "tag", op: "has", value: "parti-2" },
          ],
        },
      ],
    });
    expect(widened).toBe(true);
    expect(expr).toBe('country.eq."BR"');
  });

  test("une règle entièrement compilable n'élargit rien", () => {
    // Le témoin : sans lui, un `widened: true` constant passerait les trois tests précédents.
    const { widened, unsupported } = compile(regle("tag", "has", "vip"));
    expect(widened).toBe(false);
    expect(unsupported).toEqual([]);
  });
});

describe("non-régression — l'ajout du contexte n'a rien déplacé", () => {
  test("les tags compilent toujours sur `tag_ids`", () => {
    expect(compile(regle("tag", "has", "vip")).expr).toBe("tag_ids.cs.{7}");
    expect(compile(regle("tag", "not_has", "vip")).expr).toBe("tag_ids.not.cs.{7}");
  });

  test("un tag inconnu est dénoncé par son slug", () => {
    const { expr, unsupported } = compile(regle("tag", "has", "inexistant"));
    expect(expr).toBeNull();
    expect(unsupported).toEqual(["tag:inexistant"]);
  });

  test("un champ qui exige le flux d'événements reste non supporté", () => {
    // `clicked_cta` a besoin de `email_event`, qui n'est alimenté que par de vrais envois.
    // Il doit rester DIT, jamais compilé approximativement.
    const { expr, unsupported } = compile(regle("clicked_cta", "within_days", { days: 14, cta: "paris" }));
    expect(expr).toBeNull();
    expect(unsupported).toEqual(["clicked_cta"]);
  });

  test("une valeur exotique fait rejeter le prédicat plutôt que d'entrer dans l'expression", () => {
    const { expr, unsupported } = compile(regle("country", "eq", 'BR" or "1'));
    expect(expr).toBeNull();
    expect(unsupported).toEqual(["country"]);
  });

  test("un groupe vide ne vaut pas « tout le monde »", () => {
    // Un `and()` vide serait accepté par PostgREST et ne filtrerait rien. Le compilateur rend
    // `null`, et c'est à l'appelant de décider — l'estimation refuse de compter, elle ne devine pas.
    const { expr } = compile({ id: "root", type: "group", op: "AND", children: [] });
    expect(expr).toBeNull();
  });

  /**
   * ⛔ LE TROU QUE « UN TERME PERDU DANS UN OU RÉTRÉCIT » LAISSE OUVERT.
   *
   * « Rétrécit » n'est vrai que tant qu'il RESTE une branche. Quand elles tombent TOUTES, le OU
   * rend `null` — et `null` n'est pas un filtre étroit, c'est l'ABSENCE de filtre : les trois
   * appelants écrivent `if (expr) q.or(expr)`, donc ils comptent et ENVOIENT à toute la marque.
   *
   * MUTATION QUI DOIT TUER CE TEST : retirer la garde de `compileRule` sur `expr === null`.
   */
  test("un OU dont TOUTES les branches tombent élargit au maximum, et doit être dénoncé", () => {
    const { expr, unsupported, widened } = compile({
      id: "root",
      type: "group",
      op: "OR",
      children: [
        { id: "n1", type: "predicate", field: "tag", op: "has", value: "parti-1" },
        { id: "n2", type: "predicate", field: "tag", op: "has", value: "parti-2" },
      ],
    });
    expect(expr).toBeNull();
    expect(unsupported).toEqual(["tag:parti-1", "tag:parti-2"]);
    // `false` ici ⇒ `if (expr) q.or(expr)` ne pose AUCUN filtre ⇒ toute la marque, sous une
    // pastille verte « Exact count », et le fan-out ne s'arrête pas.
    expect(widened).toBe(true);
  });

  test("le prédicat racine SEUL qui tombe élargit aussi — il n'y a pas de groupe pour le voir", () => {
    // Le même trou sans aucun groupe : `compileNode` ne compare des longueurs que sur un GROUPE.
    const { expr, widened } = compile({
      id: "root",
      type: "group",
      op: "OR",
      children: [{ id: "n1", type: "predicate", field: "capture_campaign", op: "any_of", value: [] }],
    });
    expect(expr).toBeNull();
    expect(widened).toBe(true);
  });

  test("une règle SANS AUCUNE condition reste « toute la liste », et n'est pas un élargissement", () => {
    // Le témoin qui empêche la garde ci-dessus de tout refuser : un groupe sans enfant est un
    // ciblage VOLONTAIREMENT absent (l'écran l'écrit : « the group targets the entire list »).
    // Le confondre avec un effondrement bloquerait l'envoi à toute la liste, qui est légitime.
    const { expr, widened } = compile({ id: "root", type: "group", op: "OR", children: [] });
    expect(expr).toBeNull();
    expect(widened).toBe(false);
  });
});

/**
 * ⛔ LE CIBLAGE « UNE OU DES » — ET IL SE TESTE SUR LA CHAÎNE PRODUITE, PAS SUR `widened`.
 *
 * C'est la leçon de R3 : `cs` et `ov` compilent tous les deux, les deux rendent `widened: false`,
 * et un test qui ne regarde que les drapeaux les trouve identiques. Ils répondent pourtant à deux
 * questions opposées — `@>` « contient TOUTES », `&&` « au moins une en commun ». Seule la chaîne
 * les distingue.
 */
describe("multi-valeurs — « une ou des » campagnes, créatives, intérêts", () => {
  test("« is any of » compile en ov, jamais en cs", () => {
    // MUTATION QUI DOIT TUER CE TEST : écrire `cs` au lieu de `ov`. La règle deviendrait « entré
    // par la campagne Copa ET par la campagne Clausura » — personne, donc aucun envoi, donc rien
    // à l'écran pour dire qu'on s'est trompé de question.
    const { expr, unsupported, widened } = compile(regle("capture_campaign", "any_of", [COPA, CLAUSURA]));
    expect(expr).toBe(`capture_campaign_ids.ov.{${COPA},${CLAUSURA}}`);
    expect(expr).not.toContain("cs.");
    expect(unsupported).toEqual([]);
    expect(widened).toBe(false);
  });

  test("« is none of » compile en not.ov — mesuré accepté (206) en production", () => {
    // MUTATION QUI DOIT TUER CE TEST : replier sur `and(not.cs.{a},not.cs.{b})`. Ce repli était
    // prévu au plan « si not.ov est refusé » ; la mesure a tranché. Deux chemins pour la même
    // question dont un seul est exercé, c'est l'autre qui se trompera.
    const { expr } = compile(regle("capture_creative", "none_of", [CREATIVE_A]));
    expect(expr).toBe(`capture_optin_ids.not.ov.{${CREATIVE_A}}`);
    expect(expr).not.toContain("cs.");
  });

  test("des intérêts sont des entiers de `newsletter.tag`, pas des slugs", () => {
    const { expr } = compile(regle("interest", "any_of", ["7", "12"]));
    expect(expr).toBe("interest_ids.ov.{7,12}");
  });

  /**
   * ⛔ LE TEST LE PLUS IMPORTANT DE CE DESCRIBE.
   *
   * MUTATION QUI DOIT LE TUER : déplacer le test de liste vide APRÈS la résolution, ou le retirer.
   * Mesuré en production sur PostgREST : `cs.{}` matche 1 203 / 1 203 (tout tableau contient
   * l'ensemble vide) et `ov.{}` ne matche personne. Même clic — l'utilisateur décoche sa dernière
   * valeur — deux pannes opposées, et `widened` reste aveugle parce que le prédicat a COMPILÉ.
   */
  test("une liste vide ne compile JAMAIS, dans les deux sens", () => {
    for (const op of ["any_of", "none_of"] as const) {
      const { expr, unsupported, widened } = compile(regle("capture_campaign", op, []));
      // `null`, et surtout pas la chaîne `…cs.{}` ni `…ov.{}` : c'est bien l'ABSENCE d'expression
      // qu'on exige, pas une expression prudente.
      expect(expr).toBeNull();
      expect(unsupported).toEqual(["capture_campaign"]);
      expect(widened).toBe(true);
    }
  });

  test("la ceinture historique inspecte `String(valeur)` et ne voit JAMAIS un élément", () => {
    // R4, mesuré ici plutôt que supposé — et la mesure a corrigé l'énoncé du plan. La regex de
    // compile.ts n'accepte pas la virgule : une liste de DEUX éléments était donc rejetée, mais
    // par accident, sur la virgule du `join` et jamais sur un élément.
    const SAFE_VALUE_COPIE = /^[A-Za-z0-9:_\-.+]+$/; // copie de compile.ts, pour la démonstration
    expect(String([COPA, CLAUSURA])).toBe(`${COPA},${CLAUSURA}`);
    expect(SAFE_VALUE_COPIE.test(String([COPA, CLAUSURA]))).toBe(false);

    // Le vrai trou est à UN élément : la chaîne jointe passe la ceinture, et une regex de FORME ne
    // dit rien de l'APPARTENANCE à la marque. Sans validation par élément + liste blanche, un
    // identifiant d'une autre marque compilerait donc un filtre parfaitement valide.
    expect(SAFE_VALUE_COPIE.test(String([CAMPAGNE_AUTRE_MARQUE]))).toBe(true);
    expect(compile(regle("capture_campaign", "any_of", [CAMPAGNE_AUTRE_MARQUE])).expr).toBeNull();
  });

  test("une tentative d'injection dans le 2e élément fait tomber le prédicat ENTIER", () => {
    // MUTATION QUI DOIT TUER CE TEST : « filtrer l'élément fautif » au lieu de rendre null. Le
    // prédicat compilerait sur les deux éléments restants — un `any_of` amputé RÉTRÉCIT en
    // silence, un `none_of` amputé ÉLARGIT, et rien ne le dit.
    const injection = '},x,and(country.eq."XX"';
    const { expr, unsupported, widened } = compile(
      regle("capture_campaign", "any_of", [COPA, injection, CLAUSURA]),
    );
    expect(expr).toBeNull();
    expect(unsupported).toEqual([`capture_campaign:${injection}`]);
    expect(widened).toBe(true);
  });

  test("un identifiant sur trois non résolu ⇒ tout tombe, et CET identifiant est nommé", () => {
    // Le cas réel : une campagne supprimée, ou la liste d'une AUTRE marque servie par erreur.
    // MUTATION QUI DOIT TUER CE TEST : pousser `p.field` au lieu de `champ:valeur` — un
    // avertissement qui dit « capture_campaign » sans dire LEQUEL des trois n'est pas actionnable.
    const { expr, unsupported, widened } = compile({
      id: "root",
      type: "group",
      op: "AND",
      children: [
        { id: "n1", type: "predicate", field: "country", op: "eq", value: "BR" },
        {
          id: "n2", type: "predicate", field: "capture_campaign", op: "any_of",
          value: [COPA, CAMPAGNE_AUTRE_MARQUE, CLAUSURA],
        },
      ],
    });
    expect(expr).toBe('country.eq."BR"');
    expect(unsupported).toEqual([`capture_campaign:${CAMPAGNE_AUTRE_MARQUE}`]);
    expect(widened).toBe(true);
  });

  test("sans liste blanche, la capture ne compile RIEN — le repli est fermé, pas ouvert", () => {
    // MUTATION QUI DOIT TUER CE TEST : traiter une liste blanche absente comme « tout est permis »,
    // en se contentant de la FORME de l'uuid. Un appelant pas encore mis à jour produirait alors un
    // filtre parfaitement valide sur des identifiants d'une autre marque : personne en `any_of`,
    // TOUT LE MONDE en `none_of`, et `unsupported` vide dans les deux cas.
    const sansListes: RuleContext = { tagIdBySlug: {}, optinIdBySlug: {} };
    const { expr, unsupported, widened } = compile(
      regle("capture_campaign", "any_of", [COPA]),
      sansListes,
    );
    expect(expr).toBeNull();
    expect(unsupported).toEqual(["capture_campaign"]);
    expect(widened).toBe(true);
  });

  test("un tableau posé sur un champ SCALAIRE ne compile pas non plus", () => {
    // MUTATION QUI DOIT TUER CE TEST : remettre la branche multi après les booléens dérivés.
    // `never_opened: ["x"]` tombait dans un ternaire binaire et compilait `open_count.gt.0` —
    // « ceux qui ont ouvert au moins une fois », pour une règle qui dit l'inverse.
    const { expr } = compile(regle("never_opened", "is_true", ["x"]));
    expect(expr).toBeNull();
  });

  test("la multi-sélection se combine avec le reste de la règle", () => {
    const { expr, unsupported } = compile({
      id: "root",
      type: "group",
      op: "AND",
      children: [
        { id: "n1", type: "predicate", field: "capture_creative", op: "any_of", value: [CREATIVE_A] },
        { id: "n2", type: "predicate", field: "interest", op: "none_of", value: ["12"] },
      ],
    });
    expect(expr).toBe(`and(capture_optin_ids.ov.{${CREATIVE_A}},interest_ids.not.ov.{12})`);
    expect(unsupported).toEqual([]);
  });
});

/**
 * LES OPTIONS DE SOUSCRIPTION — ce que la personne a coché, devenu ciblage.
 *
 * Ce champ a une propriété qu'aucun autre n'a ici : sa valeur vit dans UN jsonb, où une clé peut
 * être absente. C'est la seule source de « ni d'un côté ni de l'autre » du paquet, et c'est ce que
 * ce bloc défend.
 */
describe("purpose — la finalité acceptée devient un ciblage", () => {
  test("« a accepté » lit la clé du jsonb, pas la colonne", () => {
    // MUTATION QUI DOIT TUER CE TEST : compiler `granted_purposes.cs.{"offers":true}` — accolades
    // et guillemets dans une liste déjà délimitée par virgules et parenthèses.
    const { expr, unsupported, widened } = compile(regle("purpose", "eq", "offers"));
    expect(expr).toBe("granted_purposes->>offers.eq.true");
    expect(unsupported).toEqual([]);
    expect(widened).toBe(false);
  });

  /**
   * ⛔ LE TEST QUI COMPTE. Mesuré en base le 18/09/2026 sur `partners` : 1 208 abonnements, 5
   * acceptés, 1 202 refusés, 1 À CLÉ ABSENTE. La négation naïve `not(…eq.true)` rend 1 202 : la
   * ligne sans la clé disparaît des DEUX côtés du filtre, parce qu'en SQL `NOT (NULL = 'true')`
   * vaut NULL, donc faux. Les deux moitiés doivent couvrir tout le monde : 5 + 1 203 = 1 208.
   */
  test("« n'a pas accepté » attrape AUSSI la clé absente", () => {
    // MUTATION QUI DOIT TUER CE TEST : remplacer la disjonction par `granted_purposes->>x.neq.true`
    // ou par `granted_purposes->>x.eq.false` seul.
    const { expr } = compile(regle("purpose", "neq", "partners"));
    expect(expr).toBe("or(granted_purposes->>partners.eq.false,granted_purposes->>partners.is.null)");
    expect(expr).toContain("is.null");
  });

  test("les deux moitiés sont exactement complémentaires, finalité par finalité", () => {
    // Le témoin de la contre-épreuve : si un jour `eq` et `neq` cessent de parler de la MÊME clé,
    // une population se retrouve comptée deux fois ou jamais — et les deux écrans resteront
    // d'accord entre eux en se trompant ensemble.
    for (const cle of ["content", "offers", "events", "partners"]) {
      expect(compile(regle("purpose", "eq", cle)).expr).toBe(`granted_purposes->>${cle}.eq.true`);
      expect(compile(regle("purpose", "neq", cle)).expr)
        .toBe(`or(granted_purposes->>${cle}.eq.false,granted_purposes->>${cle}.is.null)`);
    }
  });

  test("une finalité inconnue est DÉNONCÉE, jamais interpolée", () => {
    // MUTATION QUI DOIT TUER CE TEST : retirer la garde `PURPOSE_KEYS.includes(cle)`. La valeur
    // partirait telle quelle dans l'expression — et sous un ET, un terme perdu en silence élargit
    // l'audience réellement envoyée.
    const { expr, unsupported } = compile(regle("purpose", "eq", "whatsapp"));
    expect(expr).toBeNull();
    expect(unsupported).toEqual(["purpose:whatsapp"]);
  });

  test("la disjonction se niche dans le reste de la règle sans le casser", () => {
    // Un `or(…)` produit par un prédicat vit À L'INTÉRIEUR du `and(…)` du groupe : c'est la forme
    // qui part réellement à PostgREST, et aucun test de prédicat isolé ne la voit.
    const { expr, unsupported } = compile({
      id: "root",
      type: "group",
      op: "AND",
      children: [
        { id: "n1", type: "predicate", field: "country", op: "eq", value: "BR" },
        { id: "n2", type: "predicate", field: "purpose", op: "neq", value: "partners" },
      ],
    });
    expect(expr).toBe(
      'and(country.eq."BR",or(granted_purposes->>partners.eq.false,granted_purposes->>partners.is.null))',
    );
    expect(unsupported).toEqual([]);
  });
});
