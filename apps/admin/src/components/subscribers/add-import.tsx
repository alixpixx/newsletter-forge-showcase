"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Download, Plus, X } from "lucide-react";
import { Btn } from "@/components/ui";
import { contactsDuCsv, type LectureContacts, type RefusLu } from "@/lib/csv-lecture";
import { resumerInscriptions, MAX_IMPORT, type LigneResultat } from "@/lib/ingestion";
import { cn } from "@/lib/utils";

/**
 * « Add » et « Import CSV » — les deux gestes qui font entrer une adresse dans la base.
 *
 * ⛔⛔ CE QUI ENTRE ICI ARRIVE EN `pending` ET REÇOIT UN E-MAIL DE CONFIRMATION. Personne ne reçoit
 * une campagne avant d'avoir cliqué. C'est la décision d'Alix du 18/09, et c'est aussi la seule
 * position tenable : une adresse tapée dans un écran d'administration n'a donné son accord à
 * personne, et l'admin n'a aucune preuve à produire à sa place.
 *
 * ⛔ L'ÉCRAN NE DIT JAMAIS « SUBSCRIBED » NI « EMAILS SENT ». La route publique répond la même
 * chose pour une inscription créée et pour une adresse en liste de suppression — silencieusement,
 * à dessein, pour ne jamais confirmer à un tiers qu'une adresse est supprimée
 * (`docs/INGEST-API.md` §5). « Accepted » est le seul mot qu'on puisse tenir.
 */

const MOTIFS_LECTURE: Record<RefusLu["motif"], string> = {
  "email-invalide": "not a valid address",
  "email-absent": "empty address cell",
  "doublon-dans-le-fichier": "already listed earlier in this file",
};

function messageDeRefus(statut: number, corps: Record<string, unknown>): string {
  const raison = typeof corps.reason === "string" ? corps.reason : "";
  if (raison === "no-asset") return "No brand resolved — reload the page and pick a brand first.";
  if (raison === "no-secret")
    return "The admin cannot reach the signup route: NF_INGEST_SECRET is not set on this app. Nothing was written.";
  if (raison === "email-invalide") return "Not a valid email address.";
  if (raison === "fichier-vide") return "That file has no rows.";
  if (raison === "colonne-email-absente")
    return `No email column found. Columns read: ${
      Array.isArray(corps.entetes) && corps.entetes.length ? corps.entetes.join(", ") : "none"
    }.`;
  if (raison === "trop-de-lignes")
    return `${String(corps.trouves ?? "")} valid rows — more than the ${String(
      corps.max ?? MAX_IMPORT,
    )} allowed in one import. Split the file.`;
  if (statut === 500) return "The server could not complete that. Nothing was written.";
  return `Refused (${statut}).`;
}

type Panneau = null | "add" | "import";

export function AddImport() {
  const router = useRouter();
  const [panneau, setPanneau] = useState<Panneau>(null);

  return (
    /*
     * ⛔ LE PANNEAU EST ANCRÉ EN ABSOLU, PAS POSÉ DANS LE FLUX. `PageHead` range ses enfants dans
     * une colonne de droite dont la largeur est celle de son contenu — deux boutons. Un panneau
     * placé dedans hériterait de cette largeur et s'afficherait en colonne de 200 px, sans qu'aucune
     * classe ne le dise. C'est le même défaut que le sélecteur de date, et la même parade.
     * ⛔ Pas de `max-w-full` ici : il annulerait la largeur qu'on vient de fixer.
     */
    <div className="relative flex flex-wrap items-center gap-2.5">
      <Btn
        onClick={() => setPanneau((p) => (p === "import" ? null : "import"))}
        className={cn(panneau === "import" && "bg-accent")}
      >
        <Download className="h-[15px] w-[15px]" strokeWidth={2} /> Import CSV
      </Btn>
      <Btn
        variant="dark"
        onClick={() => setPanneau((p) => (p === "add" ? null : "add"))}
      >
        <Plus className="h-[15px] w-[15px]" strokeWidth={2} /> Add
      </Btn>

      {panneau !== null && (
        <div className="absolute right-0 top-[calc(100%+8px)] z-30 w-[560px] rounded-[14px] border border-border bg-card p-5 shadow-lg">
          <div className="mb-3 flex items-start justify-between gap-4">
            <div>
              <p className="text-[13.5px] font-semibold">
                {panneau === "add" ? "Add one subscriber" : "Import a CSV"}
              </p>
              <p className="mt-1 max-w-[62ch] text-[12.5px] leading-relaxed text-muted-foreground">
                {panneau === "add"
                  ? "The address is created as pending and receives a confirmation email. It joins no campaign until the person clicks that link."
                  : "Every valid address is created as pending and receives a confirmation email. Nobody receives a campaign until they click that link — no consent is recorded on their behalf."}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setPanneau(null)}
              className="rounded-[7px] p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label="Close"
            >
              <X className="h-4 w-4" strokeWidth={2} />
            </button>
          </div>

          {panneau === "add" ? (
            <PanneauAjout onDone={() => router.refresh()} />
          ) : (
            <PanneauImport onDone={() => router.refresh()} />
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ Add */

function PanneauAjout({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [prenom, setPrenom] = useState("");
  const [envoi, setEnvoi] = useState(false);
  const [retour, setRetour] = useState<{ ton: "ok" | "ko"; texte: string } | null>(null);

  async function soumettre(e: React.FormEvent) {
    e.preventDefault();
    if (envoi) return;
    setEnvoi(true);
    setRetour(null);

    try {
      const r = await fetch("/api/subscribers/add", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, firstName: prenom }),
      });
      const corps = (await r.json().catch(() => ({}))) as Record<string, unknown>;

      if (!r.ok) {
        setRetour({ ton: "ko", texte: messageDeRefus(r.status, corps) });
        return;
      }
      if (corps.etat === "deja-actif") {
        setRetour({
          ton: "ok",
          texte: "Already an active subscriber on this brand — nothing was changed, no email sent.",
        });
      } else if (corps.etat === "mis-en-file") {
        setRetour({ ton: "ok", texte: "Accepted — a confirmation email is on its way." });
        setEmail("");
        setPrenom("");
        onDone();
      } else {
        setRetour({
          ton: "ko",
          texte: typeof corps.message === "string" ? corps.message : "Refused.",
        });
      }
    } finally {
      setEnvoi(false);
    }
  }

  return (
    <form onSubmit={soumettre} className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1.5">
        <span className="text-[12px] font-medium text-muted-foreground">Email</span>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="name@example.org"
          className="w-[280px] rounded-[9px] border border-border bg-background px-3 py-2 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-[12px] font-medium text-muted-foreground">First name (optional)</span>
        <input
          type="text"
          value={prenom}
          onChange={(e) => setPrenom(e.target.value)}
          className="w-[180px] rounded-[9px] border border-border bg-background px-3 py-2 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        />
      </label>
      <Btn type="submit" variant="dark" disabled={envoi || email.trim() === ""}>
        {envoi ? "Sending…" : "Send confirmation"}
      </Btn>

      {retour && (
        <p
          className={cn(
            "basis-full text-[12.5px]",
            retour.ton === "ok" ? "text-foreground" : "text-amber-700",
          )}
        >
          {retour.texte}
        </p>
      )}
    </form>
  );
}

/* --------------------------------------------------------------- Import */

function PanneauImport({ onDone }: { onDone: () => void }) {
  const champ = useRef<HTMLInputElement>(null);
  const [nomFichier, setNomFichier] = useState("");
  const [csv, setCsv] = useState("");
  const [lecture, setLecture] = useState<LectureContacts | null>(null);
  const [enCours, setEnCours] = useState(false);
  const [fait, setFait] = useState(0);
  const [resultats, setResultats] = useState<LigneResultat[]>([]);
  const [erreur, setErreur] = useState("");
  const [fini, setFini] = useState(false);

  async function choisir(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setErreur("");
    setResultats([]);
    setFait(0);
    setFini(false);

    const texte = await f.text();
    setNomFichier(f.name);
    setCsv(texte);
    // Le même module que la route : l'aperçu ne peut pas contredire ce qui sera fait.
    setLecture(contactsDuCsv(texte));
  }

  async function lancer() {
    if (!lecture || enCours) return;
    setEnCours(true);
    setErreur("");
    setResultats([]);
    setFait(0);
    setFini(false);

    try {
      let debut = 0;
      const recoltes: LigneResultat[] = [];

      // ⛔ Boucle bornée par le total ANNONCÉ PAR LE SERVEUR, jamais par `while (true)` : une
      // réponse inattendue tournerait sans fin en envoyant de vrais e-mails à chaque tour.
      for (let garde = 0; garde <= Math.ceil(MAX_IMPORT / 25) + 1; garde += 1) {
        const r = await fetch("/api/subscribers/import", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ csv, debut, fichier: nomFichier }),
        });
        const corps = (await r.json().catch(() => ({}))) as Record<string, unknown>;

        if (!r.ok) {
          setErreur(messageDeRefus(r.status, corps));
          return;
        }

        const lot = Array.isArray(corps.resultats) ? (corps.resultats as LigneResultat[]) : [];
        recoltes.push(...lot);
        setResultats([...recoltes]);
        setFait(recoltes.length);

        if (corps.fini === true || lot.length === 0) {
          setFini(true);
          break;
        }
        debut = Number(corps.suivant ?? debut + lot.length);
      }
      onDone();
    } finally {
      setEnCours(false);
    }
  }

  const resume = resumerInscriptions(resultats);
  const refusRoute = resultats.filter((r) => r.etat === "refus" || r.etat === "injoignable");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={champ}
          type="file"
          accept=".csv,text/csv,text/plain"
          onChange={choisir}
          className="text-[12.5px] file:mr-3 file:rounded-[9px] file:border file:border-border file:bg-card file:px-3 file:py-2 file:text-[13px] file:font-medium hover:file:bg-accent"
        />
      </div>

      {lecture && lecture.colonneEmail === -1 && (
        <p className="rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[12.5px] text-amber-800">
          No email column found in <code>{nomFichier}</code>. Columns read:{" "}
          {lecture.entetes.length ? lecture.entetes.join(", ") : "none"}. Rename the header to{" "}
          <code>email</code> and try again — the file is not empty, its header is just unreadable.
        </p>
      )}

      {lecture && lecture.colonneEmail !== -1 && (
        <div className="rounded-[10px] border border-border bg-background px-4 py-3">
          <p className="text-[12.5px]">
            <span className="font-semibold">{lecture.contacts.length}</span> address
            {lecture.contacts.length === 1 ? "" : "es"} ready
            {lecture.refus.length > 0 && (
              <>
                {" · "}
                <span className="font-semibold">{lecture.refus.length}</span> line
                {lecture.refus.length === 1 ? "" : "s"} skipped
              </>
            )}
            {lecture.separateur !== "," && (
              <span className="text-muted-foreground">
                {" "}
                · separator “{lecture.separateur === "\t" ? "tab" : lecture.separateur}”
              </span>
            )}
          </p>

          {lecture.refus.length > 0 && (
            <ul className="mt-2 max-h-[120px] space-y-0.5 overflow-y-auto text-[12px] text-muted-foreground">
              {lecture.refus.slice(0, 50).map((r) => (
                <li key={`${r.ligne}-${r.motif}`}>
                  line {r.ligne}: {MOTIFS_LECTURE[r.motif]}
                  {r.valeur ? ` — ${r.valeur}` : ""}
                </li>
              ))}
              {lecture.refus.length > 50 && (
                <li className="italic">…and {lecture.refus.length - 50} more.</li>
              )}
            </ul>
          )}

          {lecture.contacts.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Btn variant="dark" onClick={lancer} disabled={enCours}>
                {enCours
                  ? `Sending… ${fait}/${lecture.contacts.length}`
                  : `Send ${lecture.contacts.length} confirmation email${lecture.contacts.length === 1 ? "" : "s"}`}
              </Btn>
              <span className="text-[12px] text-muted-foreground">
                Each address gets one email asking it to confirm. This cannot be undone.
              </span>
            </div>
          )}
        </div>
      )}

      {erreur && (
        <p className="rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[12.5px] text-amber-800">
          {erreur}
        </p>
      )}

      {resultats.length > 0 && (
        <div className="rounded-[10px] border border-border bg-background px-4 py-3">
          <p className="text-[12.5px]">
            {/* ⛔ « accepted », jamais « subscribed » : une adresse supprimée rend la même réponse. */}
            <span className="font-semibold">{resume.misEnFile}</span> accepted
            {resume.dejaActifs > 0 && <> · {resume.dejaActifs} already active, untouched</>}
            {resume.refuses > 0 && <> · {resume.refuses} refused</>}
            {resume.injoignables > 0 && <> · {resume.injoignables} unreachable</>}
            {!fini && enCours && <span className="text-muted-foreground"> · still going…</span>}
          </p>

          {refusRoute.length > 0 && (
            <ul className="mt-2 max-h-[160px] space-y-0.5 overflow-y-auto text-[12px] text-muted-foreground">
              {refusRoute.map((r) => (
                <li key={`${r.ligne}-${r.email}`}>
                  line {r.ligne}: {r.message ?? r.code}
                </li>
              ))}
            </ul>
          )}

          {fini && resume.injoignables > 0 && (
            <p className="mt-2 text-[12px] text-amber-700">
              The unreachable lines were never written. Run the same file again — addresses already
              accepted are recognised and will not be emailed twice.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
