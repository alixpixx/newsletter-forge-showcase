"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, Check, ChevronDown, ChevronRight, Lock, Pencil, Plus, Scale } from "lucide-react";
import { FOOTER_FIELDS, type FooterConfig } from "@nf/email";
import { Modal } from "@/components/builder/modal";
import { Btn, Card, CardHead, Pill } from "@/components/ui";
import { canonique } from "@/lib/cfg-canonique";
import { Apercu, Bandeau, Champ, Formulation, Habillage, NOM_REGIME, Verrous, type EditionVue } from "./legal-footer-form";

/**
 * PIEDS LÉGAUX RÉUTILISABLES — la bibliothèque, onglet « Legal footers ».
 *
 * Alix, 16/09 : « si jveux cree 3 templates de header et 2 de footer et 3 legal footer c'est a ma
 * guise ». Chaque pied légal porte son propre contenu ; un e-mail en choisit un dans le builder.
 *
 * ⛔ CE QUI DIFFÈRE D'UN HEADER : un pied légal n'est PAS copié dans l'e-mail. L'envoi lit sa version
 * à jour — corriger une adresse ici la corrige partout, sans republier. D'où la règle serveur qu'on
 * rappelle à l'écran : un pied légal incomplet est refusé, parce qu'il bloquerait d'un coup tous les
 * envois qui l'utilisent.
 */

export interface LegalTemplateVu {
  id: string;
  name: string;
  config: FooterConfig;
  updatedAt: string;
}

export function LegalFooterTemplatesPanel({
  templates,
  known,
  brandKnown,
  brandName,
  editions,
  editionsKnown,
}: {
  templates: LegalTemplateVu[];
  known: boolean;
  brandKnown: boolean;
  brandName: string;
  editions: EditionVue[];
  editionsKnown: boolean;
}) {
  const [ouvert, setOuvert] = useState<string | null>(null);
  const [creation, setCreation] = useState(false);
  const [renommage, setRenommage] = useState<LegalTemplateVu | null>(null);
  const [archivage, setArchivage] = useState<LegalTemplateVu | null>(null);

  // Le point de départ d'un nouveau pied : celui de l'édition primaire (triée en tête), complet par
  // construction dès qu'aucun envoi n'est bloqué — sinon la création serait refusée d'emblée.
  const depart = editions[0]?.cfg ?? null;

  return (
    <Card className="mb-4">
      <CardHead
        title="Legal footers"
        sub="Write as many as you need, then pick one per email — with “Import template” or on the legal footer block. Emails always send the latest version: no republishing."
        right={
          brandKnown && known && editionsKnown && depart ? (
            <Btn variant="primary" onClick={() => setCreation(true)}>
              <Plus className="h-3.5 w-3.5" strokeWidth={2} />
              New legal footer
            </Btn>
          ) : undefined
        }
      />

      {!brandKnown ? (
        <Bandeau>Database unavailable — the brand could not be resolved, so its legal footers cannot be listed.</Bandeau>
      ) : !known || !editionsKnown ? (
        <Bandeau>
          The legal footers could not be read. This is not the same as having none — check back rather than
          creating one again.
        </Bandeau>
      ) : templates.length === 0 ? (
        <div className="flex items-start gap-3 rounded-[10px] border border-dashed border-border bg-accent/30 px-4 py-4">
          <Scale className="mt-0.5 h-4 w-4 shrink-0 text-brand" strokeWidth={1.9} />
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            No legal footer yet — every email uses the brand default below. “New legal footer” starts from a copy of
            it, so you only change what differs (another company, another address, a responsible gambling notice…).
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {templates.map((t) => (
            <li key={t.id} className="rounded-[10px] border border-border bg-background">
              <div className="flex items-center gap-2 px-3 py-2.5">
                <button
                  type="button"
                  aria-expanded={ouvert === t.id}
                  onClick={() => setOuvert((o) => (o === t.id ? null : t.id))}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  {ouvert === t.id ? (
                    <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.9} />
                  ) : (
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.9} />
                  )}
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium">{t.name}</span>
                    <span className="block truncate text-[11.5px] text-muted-foreground">
                      {resume(t.config, brandName)}
                    </span>
                  </span>
                </button>
                <Btn variant="ghost" onClick={() => setRenommage(t)} aria-label={`Rename ${t.name}`}>
                  <Pencil className="h-3.5 w-3.5" strokeWidth={1.9} />
                  Rename
                </Btn>
                <Btn variant="ghost" onClick={() => setArchivage(t)} aria-label={`Archive ${t.name}`}>
                  <Archive className="h-3.5 w-3.5" strokeWidth={1.9} />
                  Archive
                </Btn>
              </div>
              {ouvert === t.id && (
                <div className="border-t border-border px-3 pb-3 pt-3">
                  {/* Clé = id, pas `updatedAt` : le `router.refresh()` d'après enregistrement remonterait
                      l'éditeur et effacerait le « Saved » qui vient de s'afficher. */}
                  <EditeurLegal key={t.id} template={t} editions={editions} brandName={brandName} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {creation && depart && (
        <CreerLegal
          depart={depart}
          onClose={() => setCreation(false)}
          onCree={(id) => {
            setCreation(false);
            setOuvert(id);
          }}
        />
      )}
      {renommage && <RenommerLegal template={renommage} onClose={() => setRenommage(null)} />}
      {archivage && <ArchiverLegal template={archivage} onClose={() => setArchivage(null)} />}
    </Card>
  );
}

/** Une ligne qui distingue deux pieds légaux dans la liste : qui envoie, et où est la politique. */
function resume(cfg: FooterConfig, brandName: string): string {
  const parts = [cfg.controller ?? brandName];
  if (cfg.physical_address) parts.push(cfg.physical_address);
  if (cfg.privacy_url) {
    try {
      parts.push(new URL(cfg.privacy_url).host);
    } catch {
      parts.push(cfg.privacy_url);
    }
  }
  if (cfg.responsible_gambling) parts.push("18+");
  return parts.join(" · ");
}

function EditeurLegal({
  template,
  editions,
  brandName,
}: {
  template: LegalTemplateVu;
  editions: EditionVue[];
  brandName: string;
}) {
  const router = useRouter();
  const [cfg, setCfg] = useState<FooterConfig>(template.config);
  const [base, setBase] = useState(template.config);
  const [baseUpdatedAt, setBaseUpdatedAt] = useState(template.updatedAt);
  const [envoi, setEnvoi] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [enregistre, setEnregistre] = useState(false);

  // Les champs utiles à AU MOINS une édition de la marque : ce pied part vers toutes.
  const champs = useMemo(
    () =>
      FOOTER_FIELDS.filter(
        (f) =>
          f.appliesTo.length === 0 ||
          editions.some((e) => f.appliesTo.includes(e.regime) || f.appliesTo.includes(e.market)),
      ),
    [editions],
  );

  // Indication locale ; le serveur (`buildFooter`) reste seul juge au moment d'enregistrer.
  const requis = (key: string) => {
    const champ = FOOTER_FIELDS.find((f) => f.key === key);
    return Boolean(
      champ?.requiredFor?.some((r) => editions.some((e) => e.regime === r || e.market === r)),
    );
  };

  const modifie = canonique(cfg) !== canonique(base);

  function poser(key: string, value: unknown) {
    setEnregistre(false);
    setCfg((c) => {
      const suivant = { ...c } as Record<string, unknown>;
      if (value === "" || value === undefined || value === false) delete suivant[key];
      else suivant[key] = value;
      return suivant as FooterConfig;
    });
  }

  async function enregistrer() {
    setEnvoi(true);
    setErreur(null);
    try {
      const res = await fetch(`/api/builder/legal-footer-templates/${template.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config: cfg, baseUpdatedAt }),
      });
      const data = (await res.json()) as { error?: string; kind?: string; config?: FooterConfig; updatedAt?: string };
      if (res.status === 409 && data.kind === "stale") {
        setErreur("Someone saved this legal footer while you had it open. Reload the page, then reapply your change.");
        return;
      }
      if (!res.ok) {
        setErreur(data.error ?? `could not save (${res.status})`);
        return;
      }
      // La config NORMALISÉE par le serveur devient la référence (voir `LegalFooterForm`).
      if (data.config) {
        setCfg(data.config);
        setBase(data.config);
      }
      if (data.updatedAt) setBaseUpdatedAt(data.updatedAt);
      setEnregistre(true);
      router.refresh();
    } catch (e) {
      setErreur((e as Error).message);
    } finally {
      setEnvoi(false);
    }
  }

  return (
    <div>
      <div className="mb-2.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-muted-foreground">
        Sent to
        {editions.map((e) => (
          <Pill key={e.id}>
            {e.market} · {e.language} · {NOM_REGIME[e.regime]}
          </Pill>
        ))}
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {champs.map((f) => (
          <Champ
            key={f.key}
            champ={f}
            valeur={(cfg as Record<string, unknown>)[f.key]}
            manquant={requis(f.key) && !(cfg as Record<string, unknown>)[f.key]}
            onChange={(v) => poser(f.key, v)}
            brandName={brandName}
          />
        ))}
      </div>

      <Habillage cfg={cfg} onChange={(style) => poser("style", style)} />

      {/* ⚠️ Ce pied part vers TOUTES les éditions de la marque, donc dans toutes leurs langues : un
          texte écrit ici remplace le défaut traduit partout. L'exemple grisé est celui de la première
          édition ; l'aperçu permet de voir chacune. */}
      <Formulation
        cfg={cfg}
        regimes={editions.map((e) => e.regime)}
        markets={editions.map((e) => e.market)}
        language={editions[0]?.language ?? "en"}
        onChange={(w) => poser("wording", w)}
      />
      {new Set(editions.map((e) => e.language)).size > 1 && (
        <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
          This footer goes to editions in several languages: a text written here replaces the
          translated default in all of them. Leave it empty to keep each edition in its own language.
        </p>
      )}

      <Apercu cfg={cfg} editions={editions} brandName={brandName} />

      <div className="mt-3 flex items-start gap-2.5 rounded-[10px] border border-border bg-card/60 px-3.5 py-3 text-[12.5px] leading-relaxed text-muted-foreground">
        <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.9} />
        <span>Saving updates every email that uses this legal footer, from its next send.</span>
      </div>
      <Verrous />

      {erreur && <p className="mt-3 text-[12.5px] text-amber-800">{erreur}</p>}

      <div className="mt-3 flex items-center justify-end gap-2">
        {enregistre && !modifie && (
          <span className="inline-flex items-center gap-1.5 text-[12px] text-[#1f7a47]">
            <Check className="h-3.5 w-3.5" strokeWidth={2.1} />
            Saved
          </span>
        )}
        <Btn onClick={enregistrer} disabled={envoi || !modifie}>
          {envoi ? "Saving…" : "Save"}
        </Btn>
      </div>
    </div>
  );
}

function CreerLegal({
  depart,
  onClose,
  onCree,
}: {
  depart: FooterConfig;
  onClose: () => void;
  onCree: (id: string) => void;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [envoi, setEnvoi] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  async function soumettre() {
    setEnvoi(true);
    setErreur(null);
    try {
      const res = await fetch("/api/builder/legal-footer-templates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), config: depart }),
      });
      const data = (await res.json()) as { id?: string; error?: string };
      if (!res.ok || !data.id) {
        setErreur(data.error ?? `could not create the legal footer (${res.status})`);
        return;
      }
      onCree(data.id);
      router.refresh();
    } catch (e) {
      setErreur((e as Error).message);
    } finally {
      setEnvoi(false);
    }
  }

  return (
    <Modal
      title="New legal footer"
      onClose={onClose}
      footer={
        <>
          <Btn variant="ghost" onClick={onClose}>
            Cancel
          </Btn>
          <Btn variant="primary" onClick={soumettre} disabled={envoi || !name.trim()}>
            {envoi ? "Creating…" : "Create and edit"}
          </Btn>
        </>
      }
    >
      <p className="mb-3 text-[12.5px] leading-relaxed text-muted-foreground">
        Starts as a copy of the brand default legal footer. Change what differs right after.
      </p>
      <label className="block text-[12.5px]">
        <span className="mb-1 block font-medium">Name</span>
        <input
          className="w-full rounded-[8px] border border-border bg-background px-2.5 py-2 text-[12.5px]"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Betting partner footer"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter" && name.trim() && !envoi) void soumettre();
          }}
        />
      </label>
      {erreur && <p className="mt-2 text-[12.5px] text-amber-800">{erreur}</p>}
    </Modal>
  );
}

function RenommerLegal({ template, onClose }: { template: LegalTemplateVu; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(template.name);
  const [envoi, setEnvoi] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  async function soumettre() {
    setEnvoi(true);
    setErreur(null);
    try {
      const res = await fetch(`/api/builder/legal-footer-templates/${template.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), baseUpdatedAt: template.updatedAt }),
      });
      const data = (await res.json()) as { error?: string; kind?: string };
      if (res.status === 409 && data.kind === "stale") {
        setErreur("This legal footer was saved elsewhere while this list was open. Reload the page, then rename it.");
        return;
      }
      if (!res.ok) {
        setErreur(data.error ?? `could not rename (${res.status})`);
        return;
      }
      onClose();
      router.refresh();
    } catch (e) {
      setErreur((e as Error).message);
    } finally {
      setEnvoi(false);
    }
  }

  return (
    <Modal
      title="Rename legal footer"
      onClose={onClose}
      footer={
        <>
          <Btn variant="ghost" onClick={onClose}>
            Cancel
          </Btn>
          <Btn onClick={soumettre} disabled={envoi || !name.trim() || name.trim() === template.name}>
            {envoi ? "Saving…" : "Save"}
          </Btn>
        </>
      }
    >
      <label className="block text-[12.5px]">
        <span className="mb-1 block font-medium">Name</span>
        <input
          className="w-full rounded-[8px] border border-border bg-background px-2.5 py-2 text-[12.5px]"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
      </label>
      {erreur && <p className="mt-2 text-[12.5px] text-amber-800">{erreur}</p>}
    </Modal>
  );
}

function ArchiverLegal({ template, onClose }: { template: LegalTemplateVu; onClose: () => void }) {
  const router = useRouter();
  const [envoi, setEnvoi] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  async function soumettre() {
    setEnvoi(true);
    setErreur(null);
    try {
      const res = await fetch(`/api/builder/legal-footer-templates/${template.id}`, { method: "DELETE" });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setErreur(data.error ?? `could not archive (${res.status})`);
        return;
      }
      onClose();
      router.refresh();
    } catch (e) {
      setErreur((e as Error).message);
    } finally {
      setEnvoi(false);
    }
  }

  return (
    <Modal
      title={`Archive “${template.name}”`}
      onClose={onClose}
      footer={
        <>
          <Btn variant="ghost" onClick={onClose}>
            Cancel
          </Btn>
          <Btn onClick={soumettre} disabled={envoi}>
            {envoi ? "Archiving…" : "Archive"}
          </Btn>
        </>
      }
    >
      <p className="text-[12.5px] leading-relaxed text-muted-foreground">
        It leaves the list, so no new email can pick it. Emails that already use it keep sending it, exactly as it
        is now — to change those, pick another legal footer in each email and publish again.
      </p>
      {erreur && <p className="mt-2 text-[12.5px] text-amber-800">{erreur}</p>}
    </Modal>
  );
}
