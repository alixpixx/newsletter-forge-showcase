import { NextResponse } from "next/server";
import { getCurrentAsset } from "@/lib/asset-context";
import { PUBLIC_BASE } from "@/lib/data/forms";
import { contactsDuCsv } from "@/lib/csv-lecture";
import { inscrireUnContact, MAX_IMPORT, MAX_PAR_APPEL, type LigneResultat } from "@/lib/ingestion";

/**
 * POST /api/subscribers/import — une TRANCHE d'un fichier CSV, inscrite en `pending`.
 *
 * ⛔⛔ COMME `add`, CETTE ROUTE N'ÉCRIT RIEN EN BASE : elle appelle le parcours public, ligne par
 * ligne. C'est le seul chemin de création d'abonné du dépôt.
 *
 * POURQUOI UNE TRANCHE ET PAS LE FICHIER ENTIER : chaque ligne est un aller-retour HTTP vers l'app
 * publique. Mille lignes dans une seule requête dépasseraient toute limite de temps d'exécution,
 * et l'écran perdrait le résultat des lignes déjà écrites — donc on les rejouerait, donc on
 * enverrait une deuxième confirmation à des gens qui l'ont déjà reçue.
 *
 * ⛔ LE FICHIER ENTIER EST RELU À CHAQUE TRANCHE, et c'est voulu : le dédoublonnage de
 * `contactsDuCsv` est GLOBAL au fichier. Ne relire que la tranche laisserait passer deux fois une
 * adresse présente dans deux tranches différentes — donc deux e-mails.
 *
 * ⛔ LE CLIENT NE DÉCIDE PAS QUI EST INSCRIT. Il envoie le texte du fichier et un rang, jamais une
 * liste d'adresses : sinon il pourrait contourner la validation, le dédoublonnage et le plafond.
 */
export async function POST(req: Request) {
  const asset = await getCurrentAsset();
  if (!asset.id) {
    return NextResponse.json({ ok: false, reason: "no-asset" }, { status: 409 });
  }

  const secret = process.env.NF_INGEST_SECRET ?? "";
  if (secret === "") {
    return NextResponse.json({ ok: false, reason: "no-secret" }, { status: 503 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    csv?: unknown;
    debut?: unknown;
    fichier?: unknown;
  };

  const csv = typeof body.csv === "string" ? body.csv : "";
  if (csv.trim() === "") {
    return NextResponse.json({ ok: false, reason: "fichier-vide" }, { status: 400 });
  }

  const fichier = typeof body.fichier === "string" ? body.fichier.slice(0, 120) : undefined;
  const lu = contactsDuCsv(csv);

  if (lu.colonneEmail === -1) {
    /*
     * ⛔ « Aucune colonne d'adresses » N'EST PAS « zéro contact ». Le second laisserait croire le
     * fichier vide alors qu'il est plein — et l'utilisateur chercherait ses lignes, pas son en-tête.
     */
    return NextResponse.json(
      { ok: false, reason: "colonne-email-absente", entetes: lu.entetes },
      { status: 422 },
    );
  }

  if (lu.contacts.length > MAX_IMPORT) {
    // ⛔ Refus net, jamais de troncature muette : importer 1 000 lignes d'un fichier de 4 000 en
    // annonçant « terminé » perdrait 3 000 contacts sans un mot.
    return NextResponse.json(
      { ok: false, reason: "trop-de-lignes", trouves: lu.contacts.length, max: MAX_IMPORT },
      { status: 413 },
    );
  }

  const debut = Number.isInteger(body.debut) && Number(body.debut) >= 0 ? Number(body.debut) : 0;
  const tranche = lu.contacts.slice(debut, debut + MAX_PAR_APPEL);

  const resultats: LigneResultat[] = [];
  for (const contact of tranche) {
    const r = await inscrireUnContact(
      {
        email: contact.email,
        prenom: contact.prenom,
        assetSlug: asset.slug,
        origine: "import",
        fichier,
      },
      { base: PUBLIC_BASE, secret },
    );
    resultats.push({ ligne: contact.ligne, email: contact.email, ...r });
  }

  const suivant = debut + tranche.length;
  return NextResponse.json({
    ok: true,
    resultats,
    // Les refus de LECTURE (adresse illisible, doublon dans le fichier) ne sont rendus qu'au
    // premier appel : ils décrivent le fichier, pas la tranche, et les répéter les compterait
    // autant de fois qu'il y a de tranches.
    refus: debut === 0 ? lu.refus : [],
    total: lu.contacts.length,
    suivant,
    fini: suivant >= lu.contacts.length,
  });
}
