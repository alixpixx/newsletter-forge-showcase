import { isLifecycleKind, LIFECYCLE_KINDS, type LifecycleKind } from "@nf/render/lifecycle-checks";
import { getDb } from "@/lib/supabase";

/**
 * Le rattachement « quel template sert quel e-mail de cycle de vie », par marque
 * (`newsletter.lifecycle_template`, 0059).
 *
 * ⛔ POURQUOI LE RATTACHEMENT POINTE UN TEMPLATE ET NON UNE VERSION. Le worker suit
 * `template.current_version_id` : publier une correction la met en service. Avec une version figée,
 * l'auteur corrigerait une faute, republierait, verrait « publié » — et l'e-mail ne changerait pas.
 *
 * ⛔ LE SCOPE MARQUE N'EST PAS UNE COMMODITÉ. Sans lui, on pourrait servir l'e-mail de confirmation
 * d'une marque sous l'identité d'une autre. La base rend l'erreur impossible par une clé composite
 * `(id, asset_id)` ; ce module ne fait que refuser plus tôt et plus clairement.
 */

type Db = NonNullable<ReturnType<typeof getDb>>;

export interface LifecycleBinding {
  kind: LifecycleKind;
  templateId: string;
  templateName: string;
  /** Faux quand le template n'a aucune version publiée : le worker sert alors le HTML en dur. */
  hasPublishedVersion: boolean;
  /**
   * Vrai quand le template rattaché est ARCHIVÉ.
   *
   * ⛔ POURQUOI CE FAIT REMONTE JUSQU'À L'ÉCRAN. La vue `outbox_context` (0059) joint le template
   * `on lft.archived_at is null` : sur un rattachement archivé, le worker ne reçoit AUCUN shell et
   * sert le HTML en dur. Sans cette colonne, un écran ne voit que « ce modèle ne m'est pas
   * listable » et confond deux faits opposés — un modèle maison qui part vraiment (non octroyé) et
   * un rattachement mort dont c'est l'e-mail intégré qui part (archivé).
   */
  templateArchived: boolean;
}

/**
 * Résultat d'une LECTURE de rattachements.
 *
 * ⛔ POURQUOI `known` EXISTE. Un tableau vide répondait jusqu'ici à deux questions opposées :
 * « cette marque n'a rattaché aucun e-mail » (fonctionnement normal, le worker sert le texte livré)
 * et « la base n'a pas répondu » (on ne sait rien). Un écran qui les confond écrit « Built-in email »
 * comme un verdict sur une lecture ratée, et une barrière de publication qui les confond laisse
 * passer un e-mail de confirmation qu'elle aurait dû contrôler. Les deux faits sont donc séparés
 * ici, à la source, et non devinés par chaque appelant.
 */
export interface LifecycleRead<T> {
  /** Faux = état INCONNU (base absente, marque non résolue, requête en erreur). Jamais « aucun ». */
  known: boolean;
  value: T;
}

/**
 * À quels kinds ce template est-il rattaché ? Tableau vide = aucun, et c'est le cas de la quasi-
 * totalité des templates.
 *
 * ⛔ C'est CETTE fonction qui décide si le contrôle de publication s'applique. Si elle rendait un
 * kind par défaut, TOUS les templates de campagne deviendraient impubliables faute de
 * `{{confirm_url}}`. Le silence est donc le bon défaut — mais il doit rester distinct de l'ignorance,
 * d'où `known`.
 *
 * ⚠️ PLUSIEURS KINDS, PAS UN SEUL. La clé primaire est (asset_id, kind) : rien n'empêche un même
 * template de servir deux e-mails. Un `.maybeSingle()` rendait alors une erreur — donc `null`, donc
 * « ce template ne sert aucun e-mail de cycle de vie » — et la barrière de publication sautait
 * exactement sur le template le plus engagé du produit.
 */
export async function lifecycleKindsOfTemplate(
  db: Db,
  assetId: string,
  templateId: string,
): Promise<LifecycleRead<LifecycleKind[]>> {
  const { data, error } = await db
    .from("lifecycle_template")
    .select("kind")
    .eq("asset_id", assetId)
    .eq("template_id", templateId);
  if (error) return { known: false, value: [] };

  const kinds = ((data as unknown[]) ?? [])
    .map((row) => (row as { kind?: unknown }).kind)
    .filter((k): k is LifecycleKind => isLifecycleKind(k))
    .sort((a, b) => LIFECYCLE_KINDS.indexOf(a) - LIFECYCLE_KINDS.indexOf(b));
  return { known: true, value: kinds };
}

/** Quel template sert ce kind sur cette marque ? `null` = aucun (le worker sert le texte livré). */
export async function templateOfLifecycleKind(
  db: Db,
  assetId: string,
  kind: LifecycleKind,
): Promise<LifecycleRead<string | null>> {
  // La clé primaire étant (asset_id, kind), il ne peut y avoir qu'une ligne : `maybeSingle` est ici
  // exact, contrairement au sens inverse (un template peut servir plusieurs kinds).
  const { data, error } = await db
    .from("lifecycle_template")
    .select("template_id")
    .eq("asset_id", assetId)
    .eq("kind", kind)
    .maybeSingle();
  if (error) return { known: false, value: null };
  const id = (data as { template_id?: unknown } | null)?.template_id;
  return { known: true, value: typeof id === "string" ? id : null };
}

/**
 * Le shell que le worker SERVIRAIT pour ce template : celui de `template.current_version_id`, tel que
 * la vue `outbox_context` le lit. `value: null` = jamais publié (le worker sert alors le HTML en dur).
 *
 * ⛔ C'EST LUI QU'ON JUGE AU RATTACHEMENT, PAS LE BROUILLON. Un brouillon corrigé ne met rien en
 * service ; la version publiée, si. Juger le brouillon laissait rattacher un template dont la version
 * EN LIGNE n'a pas de lien de confirmation — et elle partait aussitôt.
 */
export async function publishedLifecycleShell(
  db: Db,
  templateId: string,
): Promise<LifecycleRead<{ html: string; text: string; subject: string } | null>> {
  const t = await db.from("template").select("current_version_id").eq("id", templateId).maybeSingle();
  if (t.error) return { known: false, value: null };
  const versionId = (t.data as { current_version_id?: unknown } | null)?.current_version_id;
  if (typeof versionId !== "string") return { known: true, value: null };

  const v = await db
    .from("template_version")
    .select("html_shell, text_shell, subject, status")
    .eq("id", versionId)
    .eq("template_id", templateId)
    .maybeSingle();
  if (v.error || !v.data) return { known: false, value: null };
  const r = v.data as { html_shell?: unknown; text_shell?: unknown; subject?: unknown; status?: unknown };
  // Un pointeur vers une version non publiée est une incohérence : on ne conclut rien.
  if (r.status !== "published") return { known: false, value: null };
  return {
    known: true,
    value: {
      html: typeof r.html_shell === "string" ? r.html_shell : "",
      text: typeof r.text_shell === "string" ? r.text_shell : "",
      subject: typeof r.subject === "string" ? r.subject : "",
    },
  };
}

/**
 * LE MODÈLE QU'IL FAUT ROUVRIR AU LIEU D'EN SEMER UN SECOND — ou `null` s'il faut vraiment semer.
 *
 * ⛔ POURQUOI CETTE LECTURE EXISTE. « Customise » crée un modèle et DÉPLACE le rattachement dessus.
 * L'écran ne propose ce geste que sur une fente qu'aucun modèle à soi ne sert déjà — mais ce
 * garde-fou ne vit que dans un rendu serveur, que le cache client peut restaurer périmé (retour
 * arrière du navigateur), qu'un second onglet ignore, et qu'une réponse perdue après un commit fait
 * rejouer. Sans contrôle côté route, le second clic fabrique un jumeau vide de tout travail, y
 * déplace le rattachement, et laisse le premier modèle orphelin et homonyme dans la bibliothèque.
 *
 * ⛔ « REPRENABLE » N'EST PAS « EXISTE ». La fente peut être servie par un modèle ARCHIVÉ (le worker
 * sert alors l'intégré) ou par le modèle de quelqu'un d'autre (non octroyé) : dans ces deux cas
 * l'écran propose « Customise » à dessein, et il FAUT créer. C'est l'appelant qui tranche, avec les
 * mêmes fonctions que l'écran (`findTemplate` écarte l'archivé et l'autre marque, `canEditTemplate`
 * l'octroi) — les recopier ici les ferait diverger.
 *
 * ⛔ `known: false` NE VEUT PAS DIRE « AUCUN ». Une lecture ratée rendue comme « fente libre » ferait
 * créer un doublon précisément quand on ne sait rien : l'appelant doit refuser, pas semer.
 */
export async function lifecycleTemplateToReopen(
  db: Db,
  assetId: string,
  kind: LifecycleKind,
  reprenable: (templateId: string) => Promise<boolean>,
): Promise<LifecycleRead<string | null>> {
  const pose = await templateOfLifecycleKind(db, assetId, kind);
  if (!pose.known) return { known: false, value: null };
  if (!pose.value) return { known: true, value: null };
  return { known: true, value: (await reprenable(pose.value)) ? pose.value : null };
}

/** Tous les rattachements d'une marque, pour l'écran de réglage. */
export async function listLifecycleBindings(
  assetId: string | null,
): Promise<LifecycleRead<LifecycleBinding[]>> {
  const db = getDb();
  // Pas de base ou pas de marque : on ne SAIT pas ce qui est rattaché. L'écran doit le dire ainsi.
  if (!db || !assetId) return { known: false, value: [] };

  const { data, error } = await db
    .from("lifecycle_template")
    .select("kind, template_id")
    .eq("asset_id", assetId);
  if (error) return { known: false, value: [] };

  const liens = ((data as unknown[]) ?? [])
    .map((row) => row as { kind?: unknown; template_id?: unknown })
    .filter((r) => isLifecycleKind(r.kind) && typeof r.template_id === "string")
    .map((r) => ({ kind: r.kind as LifecycleKind, templateId: String(r.template_id) }));
  if (liens.length === 0) return { known: true, value: [] };

  /*
   * ⛔ DEUX REQUÊTES, PAS UN EMBED POSTGREST. L'écriture naturelle serait
   * `.select("kind, template:template_id (name, current_version_id)")` — mais la clé étrangère de
   * `lifecycle_template` est COMPOSITE (`(template_id, asset_id) → template(id, asset_id)`, ce qui
   * rend impossible de rattacher le template d'une autre marque). PostgREST ne résout pas
   * l'imbrication de la même façon selon la version, et un échec de résolution ne lève pas : il rend
   * `data: null`. L'écran afficherait « aucun rattachement » sur une marque qui en a un, et le
   * réglage semblerait s'être perdu. Une jointure explicite ne peut pas se tromper ainsi.
   */
  const { data: templates, error: erreurTemplates } = await db
    .from("template")
    // `archived_at` : c'est la colonne dont dépend le fait de savoir CE QUI PART (voir
    // `LifecycleBinding.templateArchived`). Elle ne coûte rien de plus à la même requête.
    .select("id, name, current_version_id, archived_at")
    .in("id", liens.map((l) => l.templateId));
  // Sans les noms, on n'a que des identifiants : mieux vaut dire « je ne sais pas » qu'afficher un
  // rattachement anonyme, que l'écran lirait comme un modèle sans nom.
  if (erreurTemplates) return { known: false, value: [] };
  const parId = new Map(
    ((templates as unknown[]) ?? [])
      .map(
        (row) =>
          row as { id?: unknown; name?: unknown; current_version_id?: unknown; archived_at?: unknown },
      )
      .map((t) => [String(t.id ?? ""), t] as const),
  );

  return {
    known: true,
    value: liens
      .map((l) => ({
        kind: l.kind,
        templateId: l.templateId,
        templateName: String(parId.get(l.templateId)?.name ?? ""),
        hasPublishedVersion: Boolean(parId.get(l.templateId)?.current_version_id),
        // ⚠️ Un rattachement dont la ligne `template` n'est pas revenue est traité comme ARCHIVÉ :
        // c'est le cas où le worker ne servira rien non plus. Mieux vaut annoncer le repli que
        // laisser croire à un modèle en service.
        templateArchived: parId.has(l.templateId)
          ? parId.get(l.templateId)?.archived_at != null
          : true,
      }))
      .sort((a, b) => LIFECYCLE_KINDS.indexOf(a.kind) - LIFECYCLE_KINDS.indexOf(b.kind)),
  };
}

/**
 * Pose ou retire le rattachement d'un kind. `templateId` nul = retirer, et le worker retombe alors
 * sur le HTML en dur — ce qui n'est jamais une panne.
 *
 * ⛔ `expectedTemplateId` REND LE RETRAIT ATOMIQUE. Lire « qui porte cette fente ? » puis supprimer
 * par `(asset_id, kind)` laisse entre les deux gestes une fenêtre où quelqu'un d'autre a pu poser
 * SON modèle sur la même fente : la suppression l'efface, alors que le contrôle venait de dire
 * qu'on ne toucherait qu'au nôtre. Le prédicat porte donc la condition jusque dans le DELETE, où
 * elle est évaluée par Postgres et non par un état d'écran vieux de quelques centaines de
 * millisecondes.
 */
export async function setLifecycleBinding(
  db: Db,
  assetId: string,
  kind: LifecycleKind,
  templateId: string | null,
  updatedBy: string | null,
  expectedTemplateId?: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (templateId === null) {
    let q = db.from("lifecycle_template").delete().eq("asset_id", assetId).eq("kind", kind);
    if (expectedTemplateId !== undefined) q = q.eq("template_id", expectedTemplateId);
    const { error } = await q;
    return error ? { ok: false, message: error.message } : { ok: true };
  }

  const { error } = await db
    .from("lifecycle_template")
    .upsert(
      { asset_id: assetId, kind, template_id: templateId, updated_by: updatedBy, updated_at: new Date().toISOString() },
      { onConflict: "asset_id,kind" },
    );
  // ⚠️ Une violation de clé étrangère ici veut dire « ce template n'appartient pas à cette marque ».
  // Le message le dit : l'erreur brute de Postgres nomme une contrainte que personne ne connaît.
  if (error) {
    const horsMarque = error.code === "23503";
    return {
      ok: false,
      message: horsMarque ? "that template belongs to another brand" : error.message,
    };
  }
  return { ok: true };
}
