import { NextResponse } from "next/server";
import { getDb } from "@/lib/supabase";
import { getCurrentAsset } from "@/lib/asset-context";
import { getField } from "@nf/segments/fields";

/**
 * Les valeurs RÉELLES que le constructeur de segment peut proposer, pour la marque courante.
 *
 * ⛔ POURQUOI CETTE ROUTE EXISTE. `packages/segments` ne connaît pas la base — c'est ce qui lui
 * permet d'être importé par un worker Bun comme par un composant client. Ses `options` sont donc
 * des EXEMPLES écrits en dur (« interesse:paris », « futebol »…), et l'écran les affichait tels
 * quels : on choisissait un tag qui n'existe nulle part, le compilateur ne trouvait pas son
 * identifiant, le prédicat était ignoré, et le segment comptait toute la marque. Une liste de
 * choix qui ne vient pas des données ne propose pas, elle ment.
 *
 * ⚠️ SCOPÉ MARQUE, comme le compilateur : `tag` et `optin` sont uniques par `(asset_id, slug)`.
 * Proposer les valeurs d'une autre marque produirait des slugs que la compilation rejette.
 *
 * Les optins ARCHIVÉS sont rendus, marqués comme tels : un formulaire retiré du site garde ses
 * contacts, et un segment enregistré qui le cite doit rester modifiable.
 *
 * ⛔ LES TROIS LISTES DE PROVENANCE (campagnes d'acquisition, créatives, intérêts) NE SONT PAS UN
 * ORNEMENT. Les champs `capture_campaign`, `capture_creative` et `interest` portent des
 * IDENTIFIANTS, pas des slugs : sans cette route, le menu n'a rien à proposer, la règle reste vide
 * et le critère de provenance est inerte — il compile sans erreur et ne filtre rien. Les valeurs
 * servies ici sont exactement celles que `ruleContextForAsset` (lib/data/campaigns.ts) autorise à
 * la compilation ; un écart entre les deux ferait cocher une valeur que le compte refuserait.
 *
 * ⚠️ UNE CLÉ ABSENTE N'EST PAS UNE LISTE VIDE. L'écran distingue « cette marque n'a aucune
 * campagne » (`[]`) de « je n'ai pas pu lire » (clé absente) et dit deux phrases différentes. Une
 * lecture en échec ne se replie donc JAMAIS sur un tableau vide.
 */

type Db = NonNullable<ReturnType<typeof getDb>>;

/**
 * Plafond d'une liste PROPOSÉE à l'écran.
 *
 * ⛔ Il ne borne QUE ce que l'on offre à cocher. La liste blanche qui autorise la compilation
 * (`ruleContextForAsset`) n'est, elle, jamais plafonnée : la borner ferait cesser de compter un
 * segment enregistré le jour où la marque crée une créative de plus.
 */
const LIMITE_OPTIONS = 100;

/** Taille d'un paquet de comptages — voir `parPaquets`. */
const PAQUET_COMPTAGE = 10;

/**
 * Le nombre d'abonnés SERVABLES derrière une valeur de provenance.
 *
 * ⛔ MÊME POPULATION QUE LE COMPTE DU SEGMENT (`sendable_subscription`, scopée marque) et MÊME
 * COLONNE QUE LE COMPILATEUR (table `COLUMN` de `compile.ts`). Une pastille comptée sur
 * `subscription` annoncerait 40 là où le segment rend 12, et on accuserait la règle qu'on vient
 * d'écrire.
 *
 * ⛔ `contains` SUR UN SEUL ÉLÉMENT, jamais sur un tableau construit ailleurs : `cs.{}` (contains
 * d'un ensemble vide) matche TOUT LE MONDE — mesuré 1 203 / 1 203 en production le 09/09/2026.
 *
 * ⚠️ `undefined` quand la lecture échoue ou que PostgREST ne renvoie pas l'en-tête de comptage.
 * « Je ne sais pas » ne s'écrit pas « 0 » : un zéro inventé fait renoncer à cocher une option
 * parfaitement valide.
 */
async function compteServables(
  db: Db, assetId: string, colonne: string, valeur: string | number,
): Promise<number | undefined> {
  const { count, error } = await db
    .from("sendable_subscription")
    .select("id", { count: "exact", head: true })
    .eq("asset_id", assetId)
    .contains(colonne, [valeur]);
  if (error || count === null || count === undefined) return undefined;
  return count;
}

/**
 * Exécute par petits paquets.
 *
 * ⛔ Trois listes de cent valeurs font trois cents `head` lancés d'un coup ; PostgREST répond alors
 * en erreur sur une partie, et l'écran perdrait MÊME les compteurs qu'on savait calculer.
 */
async function parPaquets<T, R>(items: T[], taille: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += taille) {
    out.push(...(await Promise.all(items.slice(i, i + taille).map(fn))));
  }
  return out;
}

export async function GET() {
  const db = getDb();
  if (!db) return NextResponse.json({ tags: [], optins: [], reason: "no-db" });

  const asset = await getCurrentAsset();
  if (!asset.id) return NextResponse.json({ tags: [], optins: [], reason: "no-asset" });
  const assetId = asset.id;

  const [tagRes, optinRes, campRes, autoRes] = await Promise.all([
    // ⚠️ `kind` est lu ici pour en dériver les INTÉRÊTS : une seconde requête sur la même table
    // pourrait rendre un ensemble différent de la première (une écriture concurrente suffit), et
    // l'écran proposerait alors un intérêt absent de la liste des tags.
    db.from("tag").select("id, slug, label, kind").eq("asset_id", assetId).order("slug"),
    db.from("optin")
      .select("id, slug, name, archived_at, capture_campaign_id")
      .eq("asset_id", assetId).order("name"),
    // ⛔ PAS de filtre sur `archived_at` : une campagne d'acquisition terminée garde ses contacts,
    // et « les gens venus de la Copa » reste un ciblage légitime six mois plus tard.
    db.from("capture_campaign").select("id, name, archived_at").eq("asset_id", assetId).order("name"),
    // ⛔ TOUS STATUTS (demande d'Alix, 24/09/2026) : une automation neuve entre d'office dans la liste,
    // et une automation repassée en brouillon a toujours envoyé ce qu'elle a envoyé.
    db.from("automation").select("id, name, status").eq("asset_id", assetId).order("name"),
  ]);

  // Un échec de lecture n'est PAS une liste vide : l'écran doit pouvoir dire « pas chargé » plutôt
  // que « cette marque n'a aucun tag », deux situations qui appellent des gestes opposés.
  if (tagRes.error || optinRes.error) {
    return NextResponse.json(
      { tags: [], optins: [], reason: tagRes.error?.message ?? optinRes.error?.message ?? "read-failed" },
      { status: 200 },
    );
  }

  const tagRows = ((tagRes.data as unknown[]) ?? []).map(
    (raw) => raw as { id: number; slug: string; label: string | null; kind: string | null },
  );
  const optinRows = ((optinRes.data as unknown[]) ?? []).map(
    (raw) => raw as {
      id: string; slug: string; name: string | null;
      archived_at: string | null; capture_campaign_id: string | null;
    },
  );

  const tags = tagRows.map((t) => ({ value: t.slug, label: t.label || t.slug }));

  const optins = optinRows.map((o) => {
    const nom = o.name || o.slug;
    return { value: o.slug, label: o.archived_at ? `${nom} (archived)` : nom };
  });

  /* ---------- Niveau 1 : les campagnes d'acquisition ---------- */

  // ⛔ `null` (lecture en échec) et `[]` (aucune campagne sur cette marque) restent distincts
  // jusqu'à la réponse : c'est la seule chose qui empêche l'écran d'annoncer une panne inexistante.
  const campRows = campRes.error
    ? null
    : ((campRes.data as unknown[]) ?? []).map(
        (raw) => raw as { id: string; name: string | null; archived_at: string | null },
      );

  const nomDeCampagne = new Map((campRows ?? []).map((c) => [c.id, c.name || "Untitled campaign"]));

  const captureCampaigns = campRows
    ? await parPaquets(campRows.slice(0, LIMITE_OPTIONS), PAQUET_COMPTAGE, async (c) => ({
        value: c.id,
        label: c.name || "Untitled campaign",
        archived: !!c.archived_at,
        count: await compteServables(db, assetId, "capture_campaign_ids", c.id),
      }))
    : null;

  /* ---------- Niveau 2 : les créatives ---------- */

  /*
   * ⛔ DEUX CRÉATIVES PEUVENT PORTER LE MÊME NOM — l'émetteur ne garantit rien là-dessus. Une liste
   * à cocher qui affiche deux fois « Guia » fait cocher l'une pour l'autre, et le segment cible à
   * côté sans qu'aucune erreur ne le dise : les deux valeurs sont des uuid parfaitement valides.
   * On désambiguïse donc par la CAMPAGNE, qui est la question qu'on se pose devant deux homonymes.
   * ⚠️ Résidu assumé : deux homonymes de la MÊME campagne restent indistinguables à l'œil. Le cas
   * ne s'est jamais présenté sur cette base, et une troisième ligne de désambiguïsation coûterait
   * plus de lecture qu'elle n'en économise.
   */
  const homonymes = new Map<string, number>();
  for (const o of optinRows) {
    const nom = o.name || o.slug;
    homonymes.set(nom, (homonymes.get(nom) ?? 0) + 1);
  }

  const captureCreatives = await parPaquets(
    optinRows.slice(0, LIMITE_OPTIONS),
    PAQUET_COMPTAGE,
    async (o) => {
      const nom = o.name || o.slug;
      const campagne = o.capture_campaign_id ? nomDeCampagne.get(o.capture_campaign_id) : undefined;
      return {
        // ⛔ L'IDENTIFIANT, PAS LE SLUG. `capture_creative` lit `capture_optin_ids`, une colonne
        // d'uuid ; un slug y serait refusé par la ceinture `UUID` du compilateur et le prédicat
        // serait dénoncé — le critère redeviendrait inerte.
        value: o.id,
        label: (homonymes.get(nom) ?? 0) > 1 && campagne ? `${nom} — ${campagne}` : nom,
        archived: !!o.archived_at,
        count: await compteServables(db, assetId, "capture_optin_ids", o.id),
      };
    },
  );

  /* ---------- Niveau 3 : les intérêts ---------- */

  // ⛔ `kind`, jamais un LIKE sur le slug : un tag manuel nommé « interest:… » se ferait passer pour
  // une donnée du pont (même barrière que `listCaptureInterests`).
  const interestRows = tagRows.filter((t) => t.kind === "interest");

  const interests = await parPaquets(
    interestRows.slice(0, LIMITE_OPTIONS),
    PAQUET_COMPTAGE,
    async (t) => ({
      // `interest_ids` porte des entiers `newsletter.tag.id` ; l'écran travaille en chaînes, et le
      // compilateur compare `String(id)` — les deux se rejoignent ici, et nulle part ailleurs.
      value: String(t.id),
      label: t.label || t.slug,
      count: await compteServables(db, assetId, "interest_ids", t.id),
    }),
  );

  /* ---------- La famille « Automations » ---------- */

  // Même colonne que le compilateur (`automations_sent`), même population que le compte du segment.
  const autoRows = autoRes.error
    ? null
    : ((autoRes.data as unknown[]) ?? []).map((raw) => raw as { id: string; name: string | null; status: string });

  const automations = autoRows
    ? await parPaquets(autoRows.slice(0, LIMITE_OPTIONS), PAQUET_COMPTAGE, async (a) => {
        const nom = a.name || "Untitled automation";
        return {
          value: a.id,
          // Le statut se lit dans le libellé : cocher un brouillon est légitime (il a pu envoyer
          // avant d'y revenir), mais il ne faut pas le prendre pour une automation qui tourne.
          label: a.status === "live" ? nom : `${nom} (${a.status})`,
          count: await compteServables(db, assetId, "automations_sent", a.id),
        };
      })
    : null;

  // Les e-mails système sont ceux du REGISTRE (aucune lecture) ; la route n'y ajoute que les compteurs.
  const systemEmails = await parPaquets(
    getField("lifecycle_email")?.options ?? [],
    PAQUET_COMPTAGE,
    async (o) => ({ ...o, count: await compteServables(db, assetId, "lifecycle_sent", o.value) }),
  );

  const echec = campRes.error ?? autoRes.error;
  return NextResponse.json({
    tags,
    optins,
    // ⚠️ Clé OMISE quand la lecture a échoué (`null`), et pas `[]` : voir l'en-tête.
    ...(captureCampaigns ? { captureCampaigns } : {}),
    captureCreatives,
    interests,
    ...(automations ? { automations } : {}),
    systemEmails,
    ...(echec ? { reason: echec.message } : {}),
  });
}
