"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, Lock } from "lucide-react";
import { LOCALES } from "@nf/email";
import { Btn, Card, CardHead, Pill } from "@/components/ui";
import type { EditionReglages, ModeSuivi, ReglagesMarque } from "@/lib/data/brand-settings";

/**
 * LE FORMULAIRE DES RÉGLAGES D'UNE MARQUE (décision d'Alix du 22/09/2026).
 *
 * ⛔ N'ENVOIE QUE CE QUI A CHANGÉ. La route valide chaque champ reçu : renvoyer une langue inchangée
 * hors des six servies ferait refuser un enregistrement qui ne la touchait pas. Et un régime renvoyé à
 * l'identique déclencherait pour rien la demande de confirmation.
 *
 * ⛔ LE RÉGIME ET LE MARCHÉ SE CONFIRMENT. Ils décident des mentions légales obligatoires : le dire au
 * moment du geste, pas après que les envois se soient arrêtés.
 */

const REGIMES: { value: string; label: string }[] = [
  { value: "gdpr", label: "GDPR (EU / UK)" },
  { value: "lgpd", label: "LGPD (Brazil)" },
  { value: "canspam", label: "CAN-SPAM (US)" },
];

type Brouillon = Pick<EditionReglages, "language" | "market" | "regime"> & { fromName: string; replyTo: string };

const brouillonDe = (e: EditionReglages): Brouillon => ({
  language: e.language,
  market: e.market,
  regime: e.regime,
  fromName: e.fromName ?? "",
  replyTo: e.replyTo ?? "",
});

const CHAMP = "w-full rounded-[8px] border border-border bg-background px-2.5 py-2 text-[12.5px] disabled:opacity-50";

/**
 * Le suivi des ouvertures et des clics (0092). ⛔ Le risque juridique de `all` est DIT au moment du
 * choix, pas dans une page d'aide : c'est la raison même de ce réglage (décision d'Alix du 07/10/2026,
 * risque signalé avant).
 */
const MODES: { value: ModeSuivi; label: string; aide: string }[] = [
  {
    value: "all",
    label: "All recipients, except those who turned tracking off",
    aide:
      "Opens and clicks are tracked for everyone who has not refused it in the preference center. In the UK and the EU a tracking pixel generally requires prior consent (PECR / ePrivacy): this option carries a legal risk there.",
  },
  {
    value: "consent",
    label: "Only recipients who opted in",
    aide: "Only people who accepted tracking are tracked. The safe choice under UK / EU rules — open and click figures then cover fewer people.",
  },
];

export function BrandSettingsForm({ marque }: { marque: ReglagesMarque }) {
  const router = useRouter();
  const [nom, setNom] = useState(marque.name);
  // `null` = 0092 absente : rien à choisir, le contrôle est grisé.
  const [suivi, setSuivi] = useState<ModeSuivi | null>(marque.trackingMode);
  const [eds, setEds] = useState<Record<string, Brouillon>>(() =>
    Object.fromEntries(marque.editions.map((e) => [e.id, brouillonDe(e)])),
  );
  const [confirmer, setConfirmer] = useState(false);
  const [envoi, setEnvoi] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [manques, setManques] = useState<{ id: string; missing: string[] }[] | null>(null);
  const [enregistre, setEnregistre] = useState(false);

  const changements = marque.editions
    .map((e) => {
      const b = eds[e.id]!;
      const d = brouillonDe(e);
      const p: Record<string, string | null> = {};
      if (b.language !== d.language) p.language = b.language;
      if (b.market.trim().toUpperCase() !== d.market) p.market = b.market.trim().toUpperCase();
      if (b.regime !== d.regime) p.compliance_regime = b.regime;
      if (b.fromName.trim() !== d.fromName) p.from_name = b.fromName.trim() || null;
      if (b.replyTo.trim() !== d.replyTo) p.reply_to = b.replyTo.trim() || null;
      return Object.keys(p).length > 0 ? { id: e.id, ...p } : null;
    })
    .filter((x): x is { id: string } & Record<string, string | null> => x !== null);
  const nomChange = nom.trim() !== marque.name;
  // ⛔ Envoyé SEULEMENT s'il a changé : la route trace chaque changement de mode, et un renvoi à
  // l'identique n'a rien à dire.
  const suiviChange = marque.trackingMode !== null && suivi !== null && suivi !== marque.trackingMode;
  const toucheConformite = changements.some((c) => "market" in c || "compliance_regime" in c);
  const modifie = nomChange || suiviChange || changements.length > 0;

  function poser(id: string, cle: keyof Brouillon, v: string) {
    setEnregistre(false);
    setEds((s) => ({ ...s, [id]: { ...s[id]!, [cle]: v } }));
  }

  async function enregistrer() {
    setEnvoi(true);
    setErreur(null);
    try {
      const res = await fetch(`/api/brands/${marque.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(nomChange ? { name: nom } : {}),
          ...(suiviChange ? { trackingMode: suivi } : {}),
          ...(changements.length > 0 ? { editions: changements } : {}),
          ...(toucheConformite ? { confirmComplianceChange: confirmer } : {}),
        }),
      });
      const data = (await res.json()) as { error?: string; missing?: { id: string; missing: string[] }[] | null };
      if (!res.ok) {
        setErreur(data.error ?? `could not save (${res.status})`);
        return;
      }
      setManques(data.missing ?? null);
      setEnregistre(true);
      setConfirmer(false);
      // La page relit la base : les valeurs affichées sont celles qui partiront, pas l'état local.
      router.refresh();
    } catch (e) {
      setErreur((e as Error).message);
    } finally {
      setEnvoi(false);
    }
  }

  const bloquees = (manques ?? []).filter((m) => m.missing.length > 0);

  return (
    <>
      <Card className="mb-4">
        <CardHead title="Brand" sub="The name readers see as the sender, unless an edition sets its own sender name below." />
        <label className="block max-w-[420px] text-[12.5px]">
          <span className="mb-1 block font-medium">Brand name</span>
          <input className={CHAMP} value={nom} maxLength={80} onChange={(e) => (setEnregistre(false), setNom(e.target.value))} />
          <span className="mt-1 block text-[11.5px] text-muted-foreground">
            Also used in the default legal footer (“You are receiving this email because…”) and by the{" "}
            <code className="font-mono">{"{{asset_name}}"}</code> merge tag.
          </span>
        </label>
      </Card>

      <Card className="mb-4">
        <CardHead title="Open & click tracking" sub="Who gets a tracking pixel and tracked links in this brand's emails. Applies to emails sent after saving." />
        <fieldset disabled={marque.trackingMode === null} className="space-y-2 disabled:opacity-50">
          <legend className="sr-only">Open & click tracking</legend>
          {MODES.map((m) => (
            <label key={m.value} className="flex cursor-pointer items-start gap-2.5 rounded-[8px] border border-border px-3 py-2.5 text-[12.5px]">
              <input
                type="radio"
                name="tracking-mode"
                className="mt-0.5"
                value={m.value}
                checked={suivi === m.value}
                onChange={() => (setEnregistre(false), setSuivi(m.value))}
              />
              <span>
                <span className="block font-medium">{m.label}</span>
                <span className="mt-0.5 block text-[11.5px] leading-relaxed text-muted-foreground">{m.aide}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {marque.trackingMode === null && (
          // ⛔ Grisé, pas caché : sans 0092 le mode n'existe pas en base, et le worker suit encore la règle
          // du consentement — le dire vaut mieux que de laisser croire qu'un choix est en vigueur.
          <p className="mt-2 text-[11.5px] text-amber-800">
            Not available until database migration 0092 is applied — until then, only recipients who opted in are tracked.
          </p>
        )}
      </Card>

      {marque.editions.map((e) => {
        const b = eds[e.id]!;
        return (
          <Card key={e.id} className="mb-4">
            <CardHead
              title={`${e.market} · ${e.language}`}
              sub={e.sendingSubdomain ? `Sends from ${e.sendingSubdomain}` : "No sending domain set yet."}
              right={e.isPrimary ? <Pill tone="pink">Primary</Pill> : undefined}
            />
            <div className="grid gap-3 md:grid-cols-3">
              <label className="block text-[12.5px]">
                <span className="mb-1 block font-medium">Language</span>
                <select className={CHAMP} value={b.language} onChange={(ev) => poser(e.id, "language", ev.target.value)}>
                  {/* Une langue hors des six reste affichée telle quelle : l'écran ne la réécrit pas en silence. */}
                  {!(LOCALES as readonly string[]).includes(e.language) && <option value={e.language}>{e.language}</option>}
                  {LOCALES.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
                <span className="mt-1 block text-[11.5px] text-muted-foreground">
                  Language of the built-in emails and of the default legal footer.
                </span>
              </label>
              <label className="block text-[12.5px]">
                <span className="mb-1 block font-medium">Market</span>
                <input
                  className={`${CHAMP} font-mono uppercase`}
                  value={b.market}
                  maxLength={2}
                  onChange={(ev) => poser(e.id, "market", ev.target.value)}
                />
                <span className="mt-1 block text-[11.5px] text-muted-foreground">Two-letter country code (BR, GB, US…).</span>
              </label>
              <label className="block text-[12.5px]">
                <span className="mb-1 block font-medium">Compliance regime</span>
                <select className={CHAMP} value={b.regime} onChange={(ev) => poser(e.id, "regime", ev.target.value)}>
                  {REGIMES.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block text-[12.5px]">
                <span className="mb-1 block font-medium">Sender name</span>
                <input
                  className={CHAMP}
                  value={b.fromName}
                  maxLength={64}
                  placeholder={nom || marque.name}
                  disabled={!marque.expediteurDisponible}
                  onChange={(ev) => poser(e.id, "fromName", ev.target.value)}
                />
                <span className="mt-1 block text-[11.5px] text-muted-foreground">Shown as the From name. Empty = the brand name.</span>
              </label>
              <label className="block text-[12.5px]">
                <span className="mb-1 block font-medium">Reply-to address</span>
                <input
                  type="email"
                  className={CHAMP}
                  value={b.replyTo}
                  placeholder="team@brand.com"
                  disabled={!marque.expediteurDisponible}
                  onChange={(ev) => poser(e.id, "replyTo", ev.target.value)}
                />
                <span className="mt-1 block text-[11.5px] text-muted-foreground">Where replies go. Empty = no reply-to.</span>
              </label>
              <div className="flex items-start gap-2 rounded-[8px] border border-border bg-card/60 px-2.5 py-2 text-[11.5px] leading-relaxed text-muted-foreground">
                <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.9} />
                <span>
                  The sending address stays on the verified domain
                  {e.sendingSubdomain ? <> (<code className="font-mono">{e.sendingSubdomain}</code>)</> : null}: sending from
                  another domain breaks DMARC and the brand&apos;s emails land in spam. Replies can still go anywhere.
                </span>
              </div>
            </div>
            {!marque.expediteurDisponible && (
              <p className="mt-2 text-[11.5px] text-amber-800">
                Sender name and reply-to become available once database migration 0078 is applied.
              </p>
            )}
          </Card>
        );
      })}

      {toucheConformite && (
        <div className="mb-3 flex items-start gap-2.5 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] leading-relaxed text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <span className="font-semibold">You are changing a market or compliance regime.</span> This changes the legal
            mentions every email of that edition must carry — CAN-SPAM, for instance, requires a postal address, and emails
            missing one are not sent. Check the legal footer right after saving.
            <label className="mt-2 flex items-center gap-2 font-medium">
              <input type="checkbox" checked={confirmer} onChange={(e) => setConfirmer(e.target.checked)} />
              I understand, apply this change
            </label>
          </span>
        </div>
      )}

      {bloquees.length > 0 && (
        <div className="mb-3 flex items-start gap-2.5 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] leading-relaxed text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Saved — but emails for {bloquees.length === 1 ? "one edition are" : `${bloquees.length} editions are`} now blocked
            by a legal footer missing{" "}
            <code className="font-mono">{[...new Set(bloquees.flatMap((m) => m.missing))].join(", ")}</code>. Fill it in{" "}
            <a className="underline" href="/templates?tab=legal">
              Templates › Legal footers
            </a>{" "}
            with this brand selected.
          </span>
        </div>
      )}

      {erreur && <p className="mb-3 text-[12.5px] text-amber-800">{erreur}</p>}

      <div className="flex items-center justify-end gap-2">
        {enregistre && !modifie && (
          <span className="inline-flex items-center gap-1.5 text-[12px] text-[#1f7a47]">
            <Check className="h-3.5 w-3.5" strokeWidth={2.1} />
            Saved
          </span>
        )}
        <Btn onClick={enregistrer} disabled={envoi || !modifie || (toucheConformite && !confirmer)}>
          {envoi ? "Saving…" : "Save"}
        </Btn>
      </div>
    </>
  );
}
