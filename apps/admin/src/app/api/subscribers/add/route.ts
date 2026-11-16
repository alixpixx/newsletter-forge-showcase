import { NextResponse } from "next/server";
import { getCurrentAsset } from "@/lib/asset-context";
import { PUBLIC_BASE } from "@/lib/data/forms";
import { EMAIL_VALIDE } from "@/lib/csv-lecture";
import { inscrireUnContact } from "@/lib/ingestion";

/**
 * POST /api/subscribers/add — inscrit UNE adresse, en `pending`, avec e-mail de confirmation.
 *
 * ⛔⛔ CETTE ROUTE N'ÉCRIT RIEN EN BASE. Elle appelle le parcours public
 * (`POST /api/v1/signup`, mode ingestion) — le seul chemin de création d'abonné du dépôt. Écrire
 * ici un `insert` sur `subscriber` donnerait deux définitions de « inscrire quelqu'un », et la
 * seconde n'aurait ni liste de suppression, ni version de consentement, ni jeton, ni e-mail.
 *
 * ⛔ LA MARQUE VIENT DE LA SESSION, jamais du corps. Et elle doit venir de la BASE : quand la
 * base ne répond pas, `getCurrentAsset()` retombe sur le registre de configuration avec `id: null`.
 * Ce slug-là a l'air bon et ne désigne peut-être aucune marque réelle — l'inscription partirait
 * vers `marque-inconnue`, ou pire vers la mauvaise marque.
 */
export async function POST(req: Request) {
  const asset = await getCurrentAsset();
  if (!asset.id) {
    return NextResponse.json({ ok: false, reason: "no-asset" }, { status: 409 });
  }

  const secret = process.env.NF_INGEST_SECRET ?? "";
  if (secret === "") {
    /*
     * ⛔ ON LE DIT, ON NE LE DEVINE PAS. Sans secret, la route publique répond 401 en silence.
     * Laisser partir l'appel produirait « refusé » sans cause lisible, et on chercherait le défaut
     * dans le fichier de l'utilisateur pendant que la panne est une variable d'environnement.
     */
    return NextResponse.json({ ok: false, reason: "no-secret" }, { status: 503 });
  }

  const body = (await req.json().catch(() => ({}))) as { email?: unknown; firstName?: unknown };
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const prenom = typeof body.firstName === "string" ? body.firstName : "";

  if (!EMAIL_VALIDE.test(email)) {
    return NextResponse.json({ ok: false, reason: "email-invalide" }, { status: 400 });
  }

  const resultat = await inscrireUnContact(
    { email, prenom, assetSlug: asset.slug, origine: "add" },
    { base: PUBLIC_BASE, secret },
  );

  return NextResponse.json({
    ok: resultat.etat === "mis-en-file" || resultat.etat === "deja-actif",
    etat: resultat.etat,
    code: resultat.code,
    message: resultat.message,
    email,
  });
}
