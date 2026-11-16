/**
 * LE PREMIER BANC DE LA ROUTE D'INSCRIPTION — celle qui fabrique les abonnés, et qui n'en avait
 * jamais eu.
 *
 * ⛔ CE QUE CES TESTS TIENNENT EN PLACE, en une phrase chacun :
 *  · « champ absent » et « champ à null » ne doivent JAMAIS se confondre — le premier ne touche à
 *    rien, le second détache. Une confusion ici détacherait une créative de sa campagne à chaque
 *    inscription où l'émetteur se tait, sans un mot dans les journaux.
 *  · « on ignore ce qui était proposé » (`offered` absent ⇒ colonne NULL) et « rien n'était
 *    proposé » (`[]` ⇒ `'{}'`) sont deux faits opposés. Le premier est le dénominateur de tout taux
 *    d'intérêt : perdu une fois, il ne se reconstitue pas.
 *  · une inscription sur une souscription DÉJÀ ACTIVE écrit son événement et n'envoie AUCUN
 *    e-mail. Se tromper dans ce sens-là confirme quelqu'un de déjà confirmé : irréversible, public.
 *  · un champ inconnu ressort dans `ignored_fields`. C'est le seul signal qui distingue « pas
 *    compris » de « compris et vide » ; sans lui, `capture.creatives` au pluriel rend `200 {ok:true}`.
 *  · l'écho est RELU. Un écho recopié depuis l'entrée ne prouve que la capacité à parser du JSON.
 *
 * ⚠️ AUCUN ACCÈS RÉSEAU. Le client Supabase est un double chaînable qui répond par table et
 * enregistre les arguments reçus : ce qui est mesuré, c'est le PAYLOAD envoyé — le seul contrôle
 * possible sur des noms de colonnes que `createClient<any>` ne vérifie jamais à la compilation.
 *
 * ⚠️ Le handler `POST` n'est pas appelé directement : `getDb()` est sa première ligne et rend
 * `null` sans variables d'environnement (la route répondrait 503). La DÉCISION a donc été extraite
 * dans `decideSignup`, que la route appelle réellement — pas une copie de ses règles.
 */
import { describe, expect, test } from "bun:test";
import {
  CAPTURE_CONTRACT,
  captureProbe,
  collectIgnored,
  ipInet,
  optinIdPremiereTouche,
  decideSignup,
  finalitesContact,
  interestSlug,
  lireMode,
  mergePurposes,
  parseCapture,
  paysAlpha2,
  paysPremiereTouche,
  readCaptureEcho,
  resolveCaptureCampaign,
  resolveInterestTags,
  writeCaptureEvent,
  type CaptureV2,
} from "./capture";
import { MAX_SLUGS } from "./interests";

const CREATIVE_ID = "9f1c4a1e-2b3d-4c5e-8a90-1234567890ab";
const CAMPAGNE_ID = "11111111-2222-4333-8444-555555555555";
const ASSET = "asset_1";

/* ── Outils de lecture, pour que chaque test dise ce qu'il vérifie et rien d'autre ────────────── */

function luV2(raw: unknown): CaptureV2 {
  const r = parseCapture(raw);
  if (!r.ok) throw new Error(`refus inattendu : ${r.error} sur ${r.field}`);
  if (!r.value) throw new Error("capture attendue, `null` rendu");
  return r.value;
}

function refuse(raw: unknown): { error: string; field: string; expected: string } {
  const r = parseCapture(raw);
  if (r.ok) throw new Error("acceptation inattendue");
  return { error: r.error, field: r.field, expected: r.expected };
}

const capture = (extra: Record<string, unknown>) => ({ v: 2, lead_id: "lead-1", ...extra });

/* ── Le double de base de données (même convention que `apps/admin/.../campaigns.test.ts`) ────── */

type Reponse = { data?: unknown; error?: unknown };
type Appel = { table: string; methodes: { m: string; args: unknown[] }[] };

function fauxDb(reponses: (table: string, n: number) => Reponse) {
  const appels: Appel[] = [];
  const compteur: Record<string, number> = {};

  const db = {
    from(table: string) {
      compteur[table] = (compteur[table] ?? 0) + 1;
      const rep = reponses(table, compteur[table]);
      const appel: Appel = { table, methodes: [] };
      appels.push(appel);

      const chaine: unknown = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === "then") {
              return (resoudre: (v: unknown) => void) =>
                resoudre({ data: rep.data ?? null, error: rep.error ?? null });
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

  return { db: db as unknown as Parameters<typeof writeCaptureEvent>[0], appels };
}

const payloadDe = (appel: Appel, m: string): Record<string, unknown> =>
  (appel.methodes.find((x) => x.m === m)?.args[0] ?? {}) as Record<string, unknown>;

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * 1. Absence ≠ null
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

describe("parseCapture — l'absence et le null ne disent pas la même chose", () => {
  /**
   * ⛔ MUTATION QUI DOIT TUER CE TEST : lire la campagne avec `raw.campaign ?? null`.
   * Symptôme en production : chaque inscription d'un émetteur muet sur la campagne DÉTACHE la
   * créative de sa campagne. Le niveau 1 disparaît sans erreur et sans journal.
   */
  test("campagne ABSENTE ⇒ rien à toucher (undefined)", () => {
    expect(luV2(capture({})).campaign).toBeUndefined();
  });

  test("campagne à NULL ⇒ détachement explicite (null)", () => {
    expect(luV2(capture({ campaign: null })).campaign).toBeNull();
  });

  test("campagne fournie ⇒ uuid en minuscules et nom conservés", () => {
    const c = luV2(capture({ campaign: { external_id: CAMPAGNE_ID.toUpperCase(), name: "  Verão 2026  " } }));
    expect(c.campaign?.externalId).toBe(CAMPAGNE_ID);
    expect(c.campaign?.name).toBe("Verão 2026");
  });

  /**
   * ⚠️ La colonne d'accueil est un `uuid` PostgreSQL, qui accepte toutes les versions. Refuser un
   * uuid v7 (générateurs récents) perdrait le lead pour une raison purement cosmétique.
   */
  test("un uuid v7 est accepté : la base l'accepterait", () => {
    const v7 = "018f3a5c-9d2e-7b1a-9c3d-0123456789ab";
    expect(luV2(capture({ campaign: { external_id: v7, name: "X" } })).campaign?.externalId).toBe(v7);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * 2. Les trois absences des intérêts (P6)
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

describe("parseCapture — `offered` absent et `offered: []` sont deux faits opposés", () => {
  /**
   * ⛔ MUTATION QUI DOIT TUER CE TEST : `offered: lu.kept` sans le garde d'absence, ou
   * `offered ?? []`. Symptôme : `interests_offered` vaut `'{}'` partout, donc « rien n'était
   * proposé » pour tout le monde — le dénominateur de tout taux d'intérêt devient faux et il
   * n'existe aucun moyen de le reconstituer après coup.
   */
  test("`offered` ABSENT ⇒ undefined (la colonne ne sera pas citée)", () => {
    const c = luV2(capture({ interests: { asks: true, chosen: [] } }));
    expect(c.interests?.offered).toBeUndefined();
  });

  test("`offered: []` ⇒ tableau vide (« rien n'était proposé »)", () => {
    const c = luV2(capture({ interests: { asks: true, offered: [], chosen: [] } }));
    expect(c.interests?.offered).toEqual([]);
  });

  test("`asks:false` ⇒ ce formulaire ne pose pas la question", () => {
    expect(luV2(capture({ interests: { asks: false } })).interests?.asks).toBe(false);
  });

  test("`interests` absent ⇒ undefined, distinct de `asks:false`", () => {
    expect(luV2(capture({})).interests).toBeUndefined();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * 3. Ce qui est REFUSÉ, et ce qui est seulement ÉCARTÉ
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

describe("parseCapture — un accessoire ne coûte jamais une inscription, un identifiant si", () => {
  test("`v:3` ⇒ refus nommant `capture.v`", () => {
    const r = refuse({ v: 3, lead_id: "x" });
    expect(r.error).toBe("capture-version-inconnue");
    expect(r.field).toBe("capture.v");
    expect(r.expected).toBe(String(CAPTURE_CONTRACT));
  });

  /**
   * ⛔ POURQUOI UN REFUS ET PAS UN REPLI. Côté optinforge, `noticias` peut être une catégorie ET un
   * tag WordPress. Se replier sur une taxonomie par défaut ferait fusionner les deux en un seul
   * intérêt, DÉFINITIVEMENT — l'identité d'un tag est `unique(asset_id, slug)`.
   */
  test("`taxonomy:\"wp\"` ⇒ refus nommant le champ fautif et son index", () => {
    const r = refuse(capture({ interests: { asks: true, chosen: [{ slug: "colo-colo", taxonomy: "wp" }] } }));
    expect(r.error).toBe("capture-taxonomie-inconnue");
    expect(r.field).toBe("capture.interests.chosen[0].taxonomy");
  });

  test("créative sans nom ⇒ refus nommant `capture.creative.name`", () => {
    const r = refuse(capture({ creative: { external_id: CREATIVE_ID } }));
    expect(r.field).toBe("capture.creative.name");
  });

  test("créative dont l'`external_id` n'est pas un uuid ⇒ refus nommant le champ", () => {
    const r = refuse(capture({ creative: { external_id: "sidebar-guide", name: "Guide" } }));
    expect(r.field).toBe("capture.creative.external_id");
  });

  /**
   * ⚠️ Une date illisible deviendrait « maintenant » et réécrirait l'ordre des touches — donc la
   * PREMIÈRE touche, donc le rattachement de campagne que le trigger recopie sur la souscription.
   */
  test("`occurred_at` illisible ⇒ refus nommant le champ", () => {
    expect(refuse(capture({ occurred_at: "hier soir" })).field).toBe("capture.occurred_at");
  });

  test("`occurred_at` valide ⇒ normalisé en ISO", () => {
    expect(luV2(capture({ occurred_at: "2026-09-09T10:00:00Z" })).occurredAt).toBe("2026-09-09T10:00:00.000Z");
  });

  test("`lead_id` absent ⇒ null, et l'événement s'écrira quand même", () => {
    const r = parseCapture({ v: 2 });
    if (!r.ok || !r.value) throw new Error("capture attendue");
    expect(r.value.leadId).toBeNull();
  });

  /**
   * ⛔ MUTATION QUI DOIT TUER CE TEST : refuser en 422 au lieu d'écarter. Symptôme : un slug
   * accentué envoyé par une créative fait perdre l'INSCRIPTION ENTIÈRE — le consentement ne se
   * rattrape pas, un intérêt si.
   */
  test("slug accentué ⇒ ÉCARTÉ avec son motif, jamais refusé", () => {
    const c = luV2(capture({ interests: { asks: true, chosen: [{ slug: "seleção", taxonomy: "tag" }] } }));
    expect(c.interests?.chosen).toHaveLength(0);
    expect(c.interests?.rejected).toEqual([{ slug: "seleção", reason: "slug-hors-format" }]);
  });

  test("25 intérêts ⇒ 24 gardés et le 25ᵉ écarté AVEC son slug", () => {
    const chosen = Array.from({ length: 25 }, (_v, i) => ({ slug: `sujet-${i}`, taxonomy: "tag" }));
    const c = luV2(capture({ interests: { asks: true, chosen } }));
    expect(c.interests?.chosen).toHaveLength(MAX_SLUGS);
    expect(c.interests?.rejected).toEqual([{ slug: "sujet-24", reason: `au-dela-de-${MAX_SLUGS}` }]);
  });

  test("un doublon (même taxonomie, même slug) est écarté et nommé", () => {
    const chosen = [
      { slug: "colo-colo", taxonomy: "tag" },
      { slug: "COLO-COLO", taxonomy: "tag" },
    ];
    const c = luV2(capture({ interests: { asks: true, chosen } }));
    expect(c.interests?.chosen).toHaveLength(1);
    expect(c.interests?.rejected).toEqual([{ slug: "colo-colo", reason: "doublon" }]);
  });

  /**
   * ⛔ LE PRÉFIXE EST L'ANTIDOTE DE P7 : sans lui, la catégorie `noticias` et le tag `noticias`
   * partageraient un seul et même tag, pour toujours.
   */
  test("deux taxonomies homonymes ne fabriquent pas le même slug d'identité", () => {
    expect(interestSlug({ slug: "noticias", label: "N", taxonomy: "tag" })).toBe("interest:tag:noticias");
    expect(interestSlug({ slug: "noticias", label: "N", taxonomy: "category" })).toBe("interest:category:noticias");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * 4. `ignored_fields` — le seul signal qui distingue « inconnu » de « vide »
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

describe("collectIgnored — ce qu'on n'a pas compris se dit", () => {
  test("clé inconnue aux trois niveaux ⇒ chemins pointés", () => {
    const ignored = collectIgnored({
      email: "a@b.co",
      foo: 1,
      capture: {
        v: 2,
        creatives: [],
        creative: { external_id: CREATIVE_ID, name: "G", colour: "red" },
        interests: { asks: true, chosen: [{ slug: "x", taxonomy: "tag", colour: "red" }] },
      },
    });
    expect(ignored).toContain("foo");
    expect(ignored).toContain("capture.creatives");
    expect(ignored).toContain("capture.creative.colour");
    expect(ignored).toContain("capture.interests.chosen[0].colour");
  });

  /**
   * ⛔ `parent_external_id` est COMPRIS mais n'a AUCUNE colonne d'accueil (vérifié dans 0063). Le
   * taire donnerait à l'émetteur l'illusion d'une hiérarchie de créatives enregistrée.
   */
  test("un champ du contrat que rien ne stocke est déclaré ignoré", () => {
    const ignored = collectIgnored({
      capture: { v: 2, creative: { external_id: CREATIVE_ID, name: "G", parent_external_id: CREATIVE_ID } },
    });
    expect(ignored).toContain("capture.creative.parent_external_id");
  });

  /**
   * ⛔ MUTATION QUI DOIT TUER CE TEST : retirer `interests` ou `optin` de la liste des clés
   * connues. Symptôme : chaque appel v1 se voit reprocher ses propres champs, et l'émetteur croit
   * à une régression là où le contrat est tenu.
   */
  test("un corps v1 pur n'a RIEN d'ignoré", () => {
    const ignored = collectIgnored({
      email: "a@b.co", asset: "sd", consent: true,
      interests: ["colo-colo"], optin: { slug: "sidebar", name: "Sidebar" },
      source: "content_upgrade", source_detail: { origin: "optinforge", lead_id: "l1" },
    });
    expect(ignored).toEqual([]);
  });

  test("un corps v1 pur laisse `parseCapture` rendre `null`, sans erreur", () => {
    const r = parseCapture(undefined);
    if (!r.ok) throw new Error("refus inattendu sur un corps v1");
    expect(r.value).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * 5. La séquence — le geste irréversible
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

describe("decideSignup — sur une souscription active, l'événement seul", () => {
  /**
   * ⛔ LE TEST CENTRAL DE TOUT LE LOT. MUTATION QUI DOIT LE TUER : rendre `sendConfirmation: true`
   * ou `issueToken: true` pour un statut `active`. Symptôme : un e-mail de confirmation part vers
   * quelqu'un de DÉJÀ confirmé, à chaque nouvelle inscription. Public et irréversible.
   */
  test("active + pont ⇒ événement écrit, aucun jeton, aucun e-mail", () => {
    const seq = decideSignup({ existingStatus: "active", serverIngest: true });
    expect(seq.writeCaptureEvent).toBe(true);
    expect(seq.issueToken).toBe(false);
    expect(seq.sendConfirmation).toBe(false);
    expect(seq.writeConsentEvent).toBe(false);
    expect(seq.updateSubscription).toBe(false);
    expect(seq.forceStatusPending).toBe(false);
    expect(seq.earlyAlready).toBe(false);
  });

  /**
   * ⛔ Le chemin PUBLIC ne bouge pas : `signup-form.tsx` lit `already` pour afficher « déjà
   * inscrit », et un appelant anonyme ne doit rien apprendre de plus.
   */
  test("active + public ⇒ retour anticipé, exactement comme avant", () => {
    const seq = decideSignup({ existingStatus: "active", serverIngest: false });
    expect(seq.earlyAlready).toBe(true);
    expect(seq.writeCaptureEvent).toBe(false);
    expect(seq.updateSubscription).toBe(false);
  });

  /**
   * ⛔ MUTATION QUI DOIT TUER CE TEST : poser `forceStatusPending: true` quand le statut est
   * `active`. Symptôme : un abonné actif repasse en `pending`, sort de `sendable_subscription`, ne
   * reçoit plus rien — et rien ne le signale.
   */
  test("pending + pont ⇒ tout se rejoue, y compris le statut", () => {
    const seq = decideSignup({ existingStatus: "pending", serverIngest: true });
    expect(seq.updateSubscription).toBe(true);
    expect(seq.forceStatusPending).toBe(true);
    expect(seq.issueToken).toBe(true);
    expect(seq.sendConfirmation).toBe(true);
    expect(seq.writeCaptureEvent).toBe(true);
  });

  test("pending + public ⇒ inchangé, et aucun événement de capture", () => {
    const seq = decideSignup({ existingStatus: "pending", serverIngest: false });
    expect(seq.updateSubscription).toBe(true);
    expect(seq.sendConfirmation).toBe(true);
    expect(seq.writeCaptureEvent).toBe(false);
  });

  test("aucune souscription + pont ⇒ création, confirmation et événement", () => {
    const seq = decideSignup({ existingStatus: null, serverIngest: true });
    expect(seq.updateSubscription).toBe(false);
    expect(seq.issueToken).toBe(true);
    expect(seq.writeCaptureEvent).toBe(true);
  });

  test("aucune souscription + public ⇒ création sans événement de capture", () => {
    const seq = decideSignup({ existingStatus: null, serverIngest: false });
    expect(seq.issueToken).toBe(true);
    expect(seq.writeCaptureEvent).toBe(false);
  });

  /**
   * ⛔ MUTATION QUI DOIT TUER CE TEST : revenir à `granted_purposes: nouveau`. Symptôme : `offers`
   * recule de `true` à `false` à la deuxième inscription, SANS aucun `consent_event` de retrait —
   * une réduction de consentement sans preuve, invisible des deux côtés.
   */
  test("mergePurposes — une réinscription n'enlève jamais une finalité", () => {
    expect(mergePurposes({ content: true, offers: true }, { content: true, offers: false })).toEqual({
      content: true,
      offers: true,
    });
  });

  /**
   * ⛔ MUTATION QUI DOIT TUER CE TEST : ne garder que les `true` (`if (v === true) out[k] = true`).
   * Symptôme SILENCIEUX : la clé `offers` DISPARAÎT du jsonb. Or `purposeAllowed`
   * (packages/config/src/send-policy.ts) rend `granted[p] !== false` sous une base légale
   * `opt_out`, et `purposeGateFilter` traduit la clé absente en `col.is.null` ⇒ « pas de retrait ».
   * Une personne qui avait DÉCOCHÉ « offres » se remet donc à en recevoir, sans une erreur nulle
   * part. Une clé absente et une clé à `false` ne sont pas le même fait.
   */
  test("mergePurposes — un refus EXPLICITE reste une clé à false, jamais une clé absente", () => {
    const fusion = mergePurposes(
      { content: true, offers: false, events: false, partners: false },
      { content: true, offers: false, events: false, partners: false },
    );
    expect(fusion).toEqual({ content: true, offers: false, events: false, partners: false });
    expect(Object.keys(fusion).sort()).toEqual(["content", "events", "offers", "partners"]);
    expect(fusion.offers).toBe(false);
  });

  test("mergePurposes — sans existant, toutes les clés reçues survivent telles quelles", () => {
    expect(mergePurposes(null, { content: true, offers: false })).toEqual({
      content: true,
      offers: false,
    });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * 6. Les résolveurs — ce qui part VRAIMENT dans le payload
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

describe("resolveCaptureCampaign — upsert sur l'unique PLEIN, puis relecture", () => {
  test("le payload cite la clé d'identité et le libellé, jamais `first_seen_at`", async () => {
    const { db, appels } = fauxDb((t, n) =>
      t === "capture_campaign" && n === 2 ? { data: { id: "cc_1" } } : { data: null },
    );
    const r = await resolveCaptureCampaign(db, ASSET, { externalId: CAMPAGNE_ID, name: "Verão" });
    expect(r.value?.id).toBe("cc_1");

    const p = payloadDe(appels[0] as Appel, "upsert");
    expect(p.external_id).toBe(CAMPAGNE_ID);
    expect(p.name).toBe("Verão");
    // ⛔ `first_seen_at` NON CITÉ : PostgREST ne met à jour que les colonnes présentes. La citer
    //    remettrait la date de première apparition à chaque inscription.
    expect(Object.keys(p)).not.toContain("first_seen_at");
    const options = (appels[0] as Appel).methodes.find((m) => m.m === "upsert")?.args[1] as Record<string, unknown>;
    expect(options.onConflict).toBe("asset_id,external_id");
  });

  test("un échec de relecture rend son motif au lieu de lever", async () => {
    const { db } = fauxDb(() => ({ error: { message: "boom" } }));
    const r = await resolveCaptureCampaign(db, ASSET, { externalId: CAMPAGNE_ID, name: "V" });
    expect(r.value).toBeNull();
    expect(r.error).toBe("campaign-upsert:boom");
  });
});

describe("resolveInterestTags — on LIT avant d'écrire", () => {
  /**
   * ⛔ MUTATION QUI DOIT TUER CE TEST : remplacer la lecture par un `upsert
   * ignoreDuplicates:false`. Symptôme : un tag MANUEL homonyme est requalifié en tag d'intérêt —
   * l'unique de `tag` est `(asset_id, slug)` SEUL, `kind` n'en fait pas partie. Un tag posé par
   * l'équipe deviendrait un goût déclaré par l'abonné, et le filtre par `kind` cesserait de dire
   * quoi que ce soit.
   */
  test("un slug déjà occupé par un tag manuel est ÉCARTÉ, avec son motif", async () => {
    const { db, appels } = fauxDb((t, n) => {
      if (t === "tag" && n === 1) {
        return { data: [{ id: 7, slug: "interest:tag:colo-colo", kind: "manual" }] };
      }
      return { data: [] };
    });
    const r = await resolveInterestTags(db, ASSET, [{ slug: "colo-colo", label: "Colo-Colo", taxonomy: "tag" }]);
    expect(r.ids).toEqual([]);
    expect(r.rejected).toEqual([
      { slug: "interest:tag:colo-colo", reason: "slug-occupe-par-un-tag-kind-manual" },
    ]);
    // Aucune écriture : un seul appel à `tag`, la lecture.
    expect(appels).toHaveLength(1);
  });

  test("les tags manquants sont créés avec `kind`, `taxonomy` et `source_slug`", async () => {
    const { db, appels } = fauxDb((t, n) => {
      if (t === "tag" && n === 1) return { data: [] };
      if (t === "tag" && n === 3) return { data: [{ id: 42, slug: "interest:category:noticias", kind: "interest" }] };
      return { data: [] };
    });
    const r = await resolveInterestTags(db, ASSET, [
      { slug: "noticias", label: "Notícias", taxonomy: "category" },
    ]);
    expect(r.ids).toEqual([42]);

    const lignes = payloadDe(appels[1] as Appel, "upsert") as unknown as Record<string, unknown>[];
    const ligne = lignes[0] as Record<string, unknown>;
    expect(ligne.slug).toBe("interest:category:noticias");
    expect(ligne.kind).toBe("interest");
    expect(ligne.taxonomy).toBe("category");
    expect(ligne.source_slug).toBe("noticias");
    expect(ligne.label).toBe("Notícias");
  });

  test("l'ordre des intérêts reçus est conservé (deux appels identiques ⇒ même tableau)", async () => {
    const { db } = fauxDb((t, n) =>
      t === "tag" && n === 1
        ? {
            data: [
              { id: 9, slug: "interest:tag:b", kind: "interest" },
              { id: 3, slug: "interest:tag:a", kind: "interest" },
            ],
          }
        : { data: [] },
    );
    const r = await resolveInterestTags(db, ASSET, [
      { slug: "a", label: "A", taxonomy: "tag" },
      { slug: "b", label: "B", taxonomy: "tag" },
    ]);
    expect(r.ids).toEqual([3, 9]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * 7. L'écriture de l'événement
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

const EVENEMENT = {
  subscriptionId: "sub_1",
  assetId: ASSET,
  optinId: "op_1",
  captureCampaignId: "cc_1",
  leadExternalId: "lead-1",
  occurredAt: undefined,
  interestIds: [1, 2],
  interestsOffered: undefined,
  campaignNameAtCapture: "Verão",
  optinNameAtCapture: "Sidebar",
  variantExternalId: null,
  sourceUrl: null,
  ipAddress: null,
  userAgent: null,
  automationLabel: null,
};

describe("writeCaptureEvent — la base arbitre le doublon, pas le code", () => {
  /**
   * ⛔ MUTATION QUI DOIT TUER CE TEST : `interests_offered: args.interestsOffered ?? null`.
   * Symptôme : « on ne sait pas ce qui était proposé » devient « rien n'était proposé », pour
   * toutes les inscriptions et pour toujours.
   */
  test("`interestsOffered` undefined ⇒ la colonne N'EST PAS citée", async () => {
    const { db, appels } = fauxDb(() => ({ data: { id: "ev_1" } }));
    await writeCaptureEvent(db, EVENEMENT);
    const p = payloadDe(appels[0] as Appel, "insert");
    expect(Object.keys(p)).not.toContain("interests_offered");
    expect(Object.keys(p)).not.toContain("occurred_at");
    expect(p.interest_ids).toEqual([1, 2]);
  });

  test("`interestsOffered: []` ⇒ la colonne EST citée, à vide", async () => {
    const { db, appels } = fauxDb(() => ({ data: { id: "ev_1" } }));
    await writeCaptureEvent(db, { ...EVENEMENT, interestsOffered: [] });
    const p = payloadDe(appels[0] as Appel, "insert");
    expect(Object.keys(p)).toContain("interests_offered");
    expect(p.interests_offered).toEqual([]);
  });

  /**
   * ⛔ MUTATION QUI DOIT TUER CE TEST : ajouter `onConflict: "asset_id,lead_external_id"`.
   * Symptôme : HTTP 500 (42P10) à chaque inscription — l'index est PARTIEL, et PostgREST n'envoie
   * qu'une liste de colonnes, ce qui empêche Postgres d'inférer la contrainte.
   */
  test("une violation 23505 devient `duplicate:true` et relit la ligne existante", async () => {
    const { db, appels } = fauxDb((t, n) =>
      t === "capture_event" && n === 1
        ? { error: { code: "23505", message: "duplicate key" } }
        : { data: { id: "ev_deja" } },
    );
    const r = await writeCaptureEvent(db, EVENEMENT);
    expect(r.duplicate).toBe(true);
    expect(r.id).toBe("ev_deja");
    expect(r.error).toBeNull();
    // L'insert n'a PAS tenté d'inférer la contrainte partielle.
    const insert = (appels[0] as Appel).methodes.find((m) => m.m === "insert");
    expect(insert?.args).toHaveLength(1);
  });

  test("sans `lead_id`, l'événement s'écrit quand même", async () => {
    const { db, appels } = fauxDb(() => ({ data: { id: "ev_2" } }));
    const r = await writeCaptureEvent(db, { ...EVENEMENT, leadExternalId: null });
    expect(r.id).toBe("ev_2");
    expect(payloadDe(appels[0] as Appel, "insert").lead_external_id).toBeNull();
  });

  /**
   * ⛔ Un échec d'écriture ne lève pas : l'abonné et son consentement sont déjà enregistrés quand
   * cette fonction est appelée. L'événement est important, le consentement l'est davantage.
   */
  test("tout autre échec rend son motif, sans lever", async () => {
    const { db } = fauxDb(() => ({ error: { code: "42703", message: "column x does not exist" } }));
    const r = await writeCaptureEvent(db, EVENEMENT);
    expect(r.id).toBeNull();
    expect(r.duplicate).toBe(false);
    expect(r.error).toBe("event-insert:column x does not exist");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * 8. L'écho — preuve par sabotage
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

describe("readCaptureEcho — relu, jamais recopié", () => {
  /**
   * ⛔ LA PREUVE PAR SABOTAGE. Le double rend une ligne DIFFÉRENTE de ce qui aurait été demandé :
   * `interest_ids: [9]` là où la requête portait `[1,2]`. Si l'écho dit `[1,2]`, c'est qu'il
   * recopie l'entrée — et un tel écho ne prouve que la capacité à parser du JSON. Il dirait
   * « campagne rattachée » alors que la résolution a échoué et que la colonne est NULL.
   */
  test("l'écho dit ce que la BASE contient, pas ce que la requête demandait", async () => {
    const { db, appels } = fauxDb(() => ({
      data: { id: "ev_1", capture_campaign_id: "cc_saboté", optin_id: null, interest_ids: [9] },
    }));
    const echo = await readCaptureEcho(db, "ev_1");
    expect(echo?.interest_ids).toEqual([9]);
    expect(echo?.campaign_id).toBe("cc_saboté");
    expect(echo?.optin_id).toBeNull();
    // Une requête DISTINCTE de l'insert, adressée par l'id rendu par la base.
    expect((appels[0] as Appel).methodes.find((m) => m.m === "eq")?.args).toEqual(["id", "ev_1"]);
  });

  test("une ligne introuvable rend `null`, pas un écho inventé", async () => {
    const { db } = fauxDb(() => ({ data: null }));
    expect(await readCaptureEcho(db, "ev_absent")).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * 9. La sonde
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

describe("captureProbe — elle annonce ce qu'elle applique", () => {
  /**
   * ⛔ MUTATION QUI DOIT TUER CE TEST : recopier `24` en littéral dans la sonde. Symptôme : le jour
   * où la borne change, la sonde continue d'annoncer l'ancienne — et une sonde qui ment est pire
   * qu'une absence de sonde, parce qu'on la croit.
   */
  test("les bornes annoncées sont celles qui sont appliquées", () => {
    const p = captureProbe();
    expect(p.contract).toBe(CAPTURE_CONTRACT);
    expect((p.limits as Record<string, unknown>).max_interests).toBe(MAX_SLUGS);
    expect(p.taxonomies).toEqual(["tag", "category", "custom"]);
  });

  /**
   * ⛔ MUTATION QUI DOIT TUER CE TEST : remettre `source_url` sous `accepts.capture`. Symptôme :
   * l'émetteur croit la sonde, écrit `capture.source_url`, la clé n'est pas dans `CLES_CAPTURE`,
   * elle ressort en `ignored_fields` — et `capture_event.source_url` reçoit l'origine de NOTRE
   * requête à la place de la page du visiteur. Un champ faux, sans une seule erreur.
   */
  test("la sonde n'annonce que des champs que le contrat lit vraiment", () => {
    const accepts = captureProbe().accepts as Record<string, Record<string, unknown>>;
    for (const cle of Object.keys(accepts.capture)) {
      expect(collectIgnored({ capture: { v: 2, [cle]: "x" } })).not.toContain(`capture.${cle}`);
    }
    // Et le champ du CORPS est annoncé là où il vit.
    expect(Object.keys(accepts.body)).toContain("source_url");
  });

  test("la sonde ne dit rien de l'environnement", () => {
    // ⛔ Dire si `NF_INGEST_SECRET` est posée apprendrait à un anonyme si la porte est ouverte.
    const rendu = JSON.stringify(captureProbe());
    expect(rendu).not.toContain("NF_INGEST_SECRET");
    expect(rendu).not.toContain("SUPABASE");
  });
});

/**
 * D8 — `optin_id` ET `capture_campaign_id` DÉSIGNENT LA MÊME TOUCHE.
 *
 * ⛔ CE QUE CE BANC TIENT. Les deux colonnes vivent sur la même ligne de `subscription` et
 * répondent à la même question. Le trigger 0063 écrit la PREMIÈRE occurrence ; si la route
 * écrivait la dernière, les deux se contrediraient en silence. Aucune erreur, aucun journal :
 * seulement deux écrans qui n'attribuent pas le même abonné au même endroit.
 */
describe("optinIdPremiereTouche (D8)", () => {
  test("une première inscription pose la créative", () => {
    expect(optinIdPremiereTouche(null, "opt-1")).toEqual({ optin_id: "opt-1" });
  });

  test("une réinscription par une AUTRE créative ne déplace pas l'origine", () => {
    expect(optinIdPremiereTouche("opt-1", "opt-2")).toEqual({});
  });

  test("un émetteur muet ne détache jamais l'origine existante", () => {
    // « absent » ne veut pas dire « à null » : sans cette garde, un formulaire sans `optin`
    // effacerait la provenance de quelqu'un qui en avait une.
    expect(optinIdPremiereTouche("opt-1", null)).toEqual({});
    expect(optinIdPremiereTouche("opt-1", undefined)).toEqual({});
    expect(optinIdPremiereTouche(null, null)).toEqual({});
  });
});

/**
 * L'IP DE LA PREUVE DE CONSENTEMENT.
 *
 * ⛔ CE QUE CES TESTS EMPÊCHENT. `ip` part dans deux colonnes `inet` dont les INSERT ne lisent pas
 * leur retour. Une valeur mal formée les fait échouer en 22P02 SANS erreur remontée, sur une
 * réponse 200 : il ne resterait aucune preuve du consentement, et cela ne se verrait que le jour
 * d'un contrôle, sur des mois de leads. Le cas nominal — un émetteur qui recopie son
 * `X-Forwarded-For` complet — est le PREMIER test, pas un cas limite.
 */
describe("ipInet", () => {
  test("une liste X-Forwarded-For garde sa première adresse au lieu de tout perdre", () => {
    expect(ipInet("203.0.113.7, 70.41.3.18, 150.172.238.178")).toBe("203.0.113.7");
    expect(ipInet("  203.0.113.7  ")).toBe("203.0.113.7");
  });

  test("les formes qu'une colonne inet accepte passent", () => {
    for (const bonne of ["1.2.3.4", "255.255.255.255", "0.0.0.0", "2001:db8::1", "::1", "fe80::1ff:fe23:4567:890a"]) {
      expect(ipInet(bonne)).toBe(bonne);
    }
  });

  test("tout ce qu'une colonne inet refuserait rend null, jamais une valeur douteuse", () => {
    for (const mauvaise of [
      "256.1.1.1", // octet hors bornes
      "1.2.3", // tronquée
      "1.2.3.4.5",
      "01.2.3.4", // zéro non significatif : lu en octal par certaines piles, donc ambigu
      "192.168.0.0/24", // un réseau n'est pas une machine
      "localhost",
      "", // en-tête présent mais vide
      "  ,  ",
      "2001:db8::1::2", // deux `::`
      "12345::1", // groupe de plus de 4 chiffres
      "1:2:3:4:5:6:7:8:9",
      "<script>alert(1)</script>",
      "a".repeat(60),
      null,
      undefined,
      42,
      ["1.2.3.4"], // un tableau : `String(...)` aurait pu le faire passer
      { ip: "1.2.3.4" },
    ]) {
      expect(ipInet(mauvaise)).toBeNull();
    }
  });
});

/**
 * LE RELEVÉ D'ÉCARTS EST BORNÉ — et le dit quand il tronque.
 *
 * ⛔ POURQUOI. `collectIgnored` s'exécute sur le corps brut AVANT le contrôle du secret et avant
 * l'anti-bot : c'est du travail offert à un appelant non authentifié, dont le coût grandissait
 * avec ce qu'IL envoie. Et une troncature muette rendrait exactement le « 200 rassurant » que ce
 * relevé existe pour empêcher.
 */
describe("collectIgnored borné", () => {
  test("un corps hostile ne fait pas grandir le relevé sans fin", () => {
    const inconnues: Record<string, unknown> = {};
    for (let i = 0; i < 5000; i++) inconnues[`cle_${i}`] = "x";
    const out = collectIgnored({ ...inconnues, capture: { v: 2, ...inconnues } });
    expect(out.length).toBeLessThanOrEqual(61);
    expect(out.some((c) => c.includes("tronqué"))).toBe(true);
  });

  test("une liste d'intérêts démesurée est bornée, et la troncature se déclare", () => {
    const items = Array.from({ length: 900 }, () => ({ inconnu: 1 }));
    const out = collectIgnored({ capture: { v: 2, interests: { offered: items } } });
    expect(out.length).toBeLessThanOrEqual(61);
    expect(out.some((c) => c.includes("tronqué"))).toBe(true);
  });

  test("un émetteur honnête ne voit AUCUNE troncature — la borne ne doit pas mordre en vrai", () => {
    const items = Array.from({ length: 40 }, (_, i) => ({ slug: `s${i}`, label: `Sujet ${i}`, taxonomy: "tag" }));
    const out = collectIgnored({
      email: "a@b.c",
      capture: { v: 2, interests: { offered: items, chosen: items.slice(0, 3) }, creatives: "faute de frappe" },
    });
    expect(out).toEqual(["capture.creatives"]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * 11. Le pays du CONTACT — l'autre géographie, celle qu'on ne doit jamais confondre
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * ⛔ DEUX COLONNES, DEUX QUESTIONS. `consent_event.country` reçoit `edition.market` — le marché de
 * la PUBLICATION, arbitré et documenté. `subscription.country` reçoit le pays de la PERSONNE. Un
 * lead brésilien inscrit sur une édition chilienne porte légitimement `BR` et `CL` : écraser l'un
 * par l'autre écrirait une géographie fausse dans une preuve légale, sans une seule erreur.
 *
 * ⚠️ Ce banc tient la moitié RÉCEPTEUR. `subscription.country` est le prédicat de segmentation
 * (index `idx_sub_asset_country`, 0003) : une valeur inventée fait entrer des gens dans un ciblage
 * qui ne les vise pas, et personne ne s'en aperçoit — un envoi part, c'est tout.
 */
describe("paysAlpha2 — illisible ⇒ null, jamais une valeur inventée", () => {
  /**
   * ⛔ MUTATION QUI DOIT TUER CE TEST : rendre `t` sans `.toUpperCase()`. Symptôme : `"br"` et
   * `"BR"` deviennent deux pays distincts dans une colonne texte sans contrainte, et la
   * segmentation `country = 'BR'` rate silencieusement la moitié des nouveaux contacts.
   */
  test("le cas nominal : deux lettres, en majuscules quoi qu'il arrive", () => {
    expect(paysAlpha2("br")).toBe("BR");
    expect(paysAlpha2("BR")).toBe("BR");
    expect(paysAlpha2("  cl  ")).toBe("CL");
  });

  /**
   * ⛔ MUTATION QUI DOIT TUER CE TEST : remplacer la regex par un `slice(0, 2)`. Symptôme :
   * `"BRA"` (alpha-3) devient `"BR"` et `"Brazil"` devient `"BR"` — des valeurs FABRIQUÉES qui
   * ressemblent tellement à la bonne réponse que rien ne les dénoncera jamais en base.
   */
  test("un alpha-3 ou un nom de pays n'est pas rogné en alpha-2, il est refusé", () => {
    expect(paysAlpha2("BRA")).toBeNull();
    expect(paysAlpha2("Brazil")).toBeNull();
    expect(paysAlpha2("B")).toBeNull();
    expect(paysAlpha2("B1")).toBeNull();
    expect(paysAlpha2("")).toBeNull();
  });

  test("ce qui n'est pas une chaîne n'est pas un pays", () => {
    expect(paysAlpha2(undefined)).toBeNull();
    expect(paysAlpha2(null)).toBeNull();
    expect(paysAlpha2(76)).toBeNull();
    expect(paysAlpha2(["BR"])).toBeNull();
  });
});

/**
 * ⛔ PREMIÈRE TOUCHE, MÊME RÈGLE QUE `optinIdPremiereTouche` (D8) — et une raison de plus : le pays
 * déjà posé a servi à segmenter des envois DÉJÀ PARTIS. Le réécrire déplacerait la personne d'un
 * ciblage à un autre, et l'historique d'envois ne correspondrait plus à la colonne censée
 * l'expliquer.
 */
describe("paysPremiereTouche", () => {
  test("une première inscription pose le pays", () => {
    expect(paysPremiereTouche(null, "BR")).toEqual({ country: "BR" });
  });

  /**
   * ⛔ MUTATION QUI DOIT TUER CE TEST : rendre `{ country: nouveau }` dès que `nouveau` est posé.
   * Symptôme : une réinscription depuis un VPN, ou depuis un émetteur qui géolocalise autrement,
   * déplace silencieusement un abonné de `BR` à `US`.
   */
  test("une réinscription depuis un autre pays ne déplace JAMAIS l'existant", () => {
    expect(paysPremiereTouche("BR", "US")).toEqual({});
    expect(paysPremiereTouche("BR", "BR")).toEqual({});
  });

  /**
   * ⛔ MUTATION QUI DOIT TUER CE TEST : écrire `{ country: nouveau ?? null }` sans condition.
   * Symptôme : un émetteur muet sur `country` EFFACE le pays d'un abonné qui en avait un — la clé
   * doit rester NON CITÉE, pas posée à null.
   */
  test("un émetteur muet n'efface pas un pays déjà posé", () => {
    expect(paysPremiereTouche("BR", null)).toEqual({});
    expect(paysPremiereTouche("BR", undefined)).toEqual({});
    expect(paysPremiereTouche(null, null)).toEqual({});
  });
});

/**
 * ⛔⛔ L'ORDRE DE DÉPLOIEMENT EST DANS CE TEST. Tant que `country` n'est pas une clé COMPRISE,
 * `collectIgnored` la range dans `ignored_fields`, l'émetteur écrit `champs-ignores:country` dans
 * `bridge_error` sur CHAQUE lead relayé, et la colonne d'alerte du pont se remplit de faux
 * positifs. Le récepteur doit donc partir AVANT l'émetteur.
 */
describe("country annoncé — le pont ne doit pas le prendre pour un champ inconnu", () => {
  /**
   * ⛔ MUTATION QUI DOIT TUER CE TEST : retirer `"country"` de `CLES_CORPS`.
   */
  test("un corps portant country ne produit AUCUN champ ignoré", () => {
    expect(collectIgnored({ email: "a@b.c", asset: "x", consent: true, country: "BR" })).toEqual([]);
  });

  /**
   * ⛔ LA SONDE DIT CE QUE LE CODE APPLIQUE, sinon elle est pire qu'absente : l'émetteur la LIT
   * pour décider s'il peut partir. Et elle doit dire les DEUX moitiés — que le champ existe, et
   * qu'il ne touche pas au marché de l'édition.
   */
  test("la sonde annonce country, en première touche, et distinct du marché", () => {
    const accepts = captureProbe().accepts as { body: Record<string, string> };
    expect(typeof accepts.body.country).toBe("string");
    expect(accepts.body.country).toContain("alpha-2");
    expect(accepts.body.country).toContain("FIRST touch");
    expect(accepts.body.country).toContain("market");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * 7. Le contact hors newsletter (0088, lot E)
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

describe("lireMode — le contact est une porte de serveur, au vocabulaire fermé", () => {
  test("absent ou null ⇒ l'inscription de toujours", () => {
    expect(lireMode(undefined, false)).toEqual({ ok: true, mode: "subscribe" });
    expect(lireMode(null, true)).toEqual({ ok: true, mode: "subscribe" });
  });

  test("\"contact\" sur le pont ⇒ contact", () => {
    expect(lireMode("contact", true)).toEqual({ ok: true, mode: "contact" });
  });

  /**
   * ⛔ MUTATION QUI DOIT LE TUER : retirer la garde `serverIngest`. Symptôme : un appelant anonyme
   * inscrit l'adresse d'un tiers comme contact, SANS double opt-in, et elle reçoit des campagnes.
   */
  test("\"contact\" d'un appelant anonyme ⇒ refusé en 403", () => {
    const lu = lireMode("contact", false);
    expect(lu.ok).toBe(false);
    if (!lu.ok) {
      expect(lu.status).toBe(403);
      expect(lu.error).toBe("mode-reserve-ingestion");
    }
  });

  /**
   * ⛔ MUTATION QUI DOIT LE TUER : se replier sur `subscribe` pour une valeur inconnue. Symptôme :
   * `"contacts"` au pluriel ferait partir un e-mail de confirmation à quelqu'un qui n'a rien demandé.
   */
  test("une valeur inconnue ⇒ 422, jamais un repli sur l'inscription", () => {
    for (const brut of ["contacts", "Contact", "subscribe", true, 1, {}]) {
      const lu = lireMode(brut, true);
      expect(lu.ok).toBe(false);
      if (!lu.ok) {
        expect(lu.status).toBe(422);
        expect(lu.error).toBe("mode-inconnu");
      }
    }
  });
});

describe("decideSignup — un contact ne touche jamais l'existant, et n'envoie rien", () => {
  /**
   * ⛔ LE TEST CENTRAL DU LOT E3. MUTATIONS QUI DOIVENT LE TUER : laisser le contact tomber dans la
   * branche `pending` (jeton + e-mail de confirmation) ; `updateSubscription: true` (un désinscrit
   * repasserait atteignable) ; `forceStatusPending: true` (un actif sortirait des envois).
   */
  for (const statut of ["active", "pending", "unsubscribed", "suppressed_soft", "contact", "deleted"]) {
    test(`souscription « ${statut} » existante ⇒ seul l'événement de capture s'ajoute`, () => {
      const seq = decideSignup({ existingStatus: statut, serverIngest: true, mode: "contact" });
      expect(seq).toEqual({
        earlyAlready: false,
        updateSubscription: false,
        forceStatusPending: false,
        writeConsentEvent: false,
        issueToken: false,
        sendConfirmation: false,
        writeCaptureEvent: true,
        createStatus: "contact",
        applyTags: false,
      });
    });
  }

  /** ⛔ MUTATION QUI DOIT LE TUER : créer en `pending`. Le contact attendrait un clic qui ne vient jamais. */
  test("aucune souscription ⇒ création au statut contact, sans preuve d'opt-in, sans jeton, sans e-mail", () => {
    const seq = decideSignup({ existingStatus: null, serverIngest: true, mode: "contact" });
    expect(seq.createStatus).toBe("contact");
    expect(seq.writeConsentEvent).toBe(false);
    expect(seq.issueToken).toBe(false);
    expect(seq.sendConfirmation).toBe(false);
    expect(seq.writeCaptureEvent).toBe(true);
    expect(seq.applyTags).toBe(true);
  });

  /** Le défaut reste l'inscription : les appelants d'avant créent toujours en `pending`. */
  test("sans mode ⇒ création en pending, tags sur le pont seulement", () => {
    expect(decideSignup({ existingStatus: null, serverIngest: true }).createStatus).toBe("pending");
    expect(decideSignup({ existingStatus: null, serverIngest: true }).applyTags).toBe(true);
    expect(decideSignup({ existingStatus: "active", serverIngest: true }).applyTags).toBe(true);
    expect(decideSignup({ existingStatus: null, serverIngest: false }).applyTags).toBe(false);
  });
});

describe("finalitesContact — rien de plus que ce que l'émetteur a transmis", () => {
  /**
   * ⛔ MUTATION QUI DOIT LE TUER : forcer `content: true` comme l'inscription. Symptôme : un contact
   * qui n'a coché aucune case reçoit toute campagne `content` sans que la case
   * `contacts_ignore_purpose` ait été cochée.
   */
  test("sans finalités transmises ⇒ aucune", () => {
    expect(finalitesContact(undefined)).toEqual({});
    expect(finalitesContact(null)).toEqual({});
  });

  test("les clés transmises survivent, seul `true` vaut accord", () => {
    expect(finalitesContact({ offers: true, events: false, content: "yes" })).toEqual({
      offers: true,
      events: false,
      content: false,
    });
  });
});

describe("mode annoncé et compris", () => {
  /** ⛔ MUTATION QUI DOIT LE TUER : retirer `"mode"` de `CLES_CORPS` (chaque contact relayé porterait `champs-ignores:mode`). */
  test("un corps portant mode ne produit AUCUN champ ignoré", () => {
    expect(collectIgnored({ email: "a@b.c", asset: "x", mode: "contact" })).toEqual([]);
  });

  /** L'émetteur lit cette clé avant d'envoyer un contact : sans elle, il doit s'arrêter. */
  test("la sonde annonce le mode contact, réservé au serveur, sans e-mail", () => {
    const accepts = captureProbe().accepts as { body: Record<string, string> };
    expect(accepts.body.mode).toContain('"contact"');
    expect(accepts.body.mode).toContain("server ingestion only");
    expect(accepts.body.mode).toContain("no email");
    // L'écho rend le mode appliqué : l'émetteur l'asserte sur chaque contact, donc la sonde le nomme.
    expect(captureProbe().echo).toContain("mode");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * Le label d'automation (0095)
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

describe("label d'automation — le nom arrive, le slug s'écrit, rien ne coûte une inscription", () => {
  const creative = (extra: Record<string, unknown>) =>
    capture({ creative: { external_id: CREATIVE_ID, name: "Popup Libertadores", ...extra } });

  test("le NOM envoyé devient le slug, calculé ici", () => {
    expect(luV2(creative({ automation_label: "Libertadores 2026" })).creative?.automationLabel).toBe("libertadores-2026");
    expect(luV2(creative({ automation_label: "  Lakeside — Libertadores  " })).creative?.automationLabel).toBe(
      "lakeside-libertadores",
    );
  });

  test("absent, vide ou inutilisable ⇒ null, et l'inscription passe", () => {
    expect(luV2(creative({})).creative?.automationLabel).toBeNull();
    expect(luV2(creative({ automation_label: "   " })).creative?.automationLabel).toBeNull();
    expect(luV2(creative({ automation_label: "⚽⚽" })).creative?.automationLabel).toBeNull();
    expect(luV2(creative({ automation_label: 42 })).creative?.automationLabel).toBeNull();
    expect(luV2(creative({ automation_label: "x".repeat(81) })).creative?.automationLabel).toBeNull();
  });

  /** ⛔ MUTATION QUI DOIT LE TUER : retirer `"automation_label"` de `CLES_CREATIVE` (chaque lead à label porterait `champs-ignores`). */
  test("la clé est COMPRISE : elle ne ressort pas dans ignored_fields", () => {
    expect(collectIgnored({ capture: creative({ automation_label: "Libertadores 2026" }) })).toEqual([]);
  });

  /** ⛔ MUTATION QUI DOIT LE TUER : citer `automation_label` même à null (tout l'événement échouerait si 0095 manquait). */
  test("la colonne n'est citée QUE si un label est porté", async () => {
    const sans = fauxDb(() => ({ data: { id: "ev_1" } }));
    await writeCaptureEvent(sans.db, EVENEMENT);
    expect(Object.keys(payloadDe(sans.appels[0] as Appel, "insert"))).not.toContain("automation_label");

    const avec = fauxDb(() => ({ data: { id: "ev_1" } }));
    await writeCaptureEvent(avec.db, { ...EVENEMENT, automationLabel: "libertadores-2026" });
    expect(payloadDe(avec.appels[0] as Appel, "insert").automation_label).toBe("libertadores-2026");
  });

  test("l'écho rend le label RELU en base, pas celui de la requête", async () => {
    const { db } = fauxDb(() => ({
      data: { id: "ev_1", capture_campaign_id: null, optin_id: null, interest_ids: [], automation_label: "relu-en-base" },
    }));
    expect((await readCaptureEcho(db, "ev_1"))?.automation_label).toBe("relu-en-base");
  });

  test("la sonde annonce la clé et l'écho", () => {
    const accepts = captureProbe().accepts as { capture: Record<string, string> };
    expect(accepts.capture.creative).toContain("automation_label?");
    expect(captureProbe().echo).toContain("resolved.automation_label");
  });
});
