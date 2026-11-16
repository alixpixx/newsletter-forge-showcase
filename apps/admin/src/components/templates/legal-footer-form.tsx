"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowDown, ArrowUp, Check, Lock } from "lucide-react";
import {
  FOOTER_FIELDS,
  FOOTER_LINES,
  FOOTER_LINE_LABELS,
  FOOTER_WORDING_FIELDS,
  buildFooter,
  defaultWording,
  footerLineOrder,
  normalizeLocale,
  type FooterConfig,
  type FooterField,
  type FooterWording,
  type FooterWordingField,
} from "@nf/email";
import { Btn, Card, CardHead, Pill } from "@/components/ui";
import { canonique } from "@/lib/cfg-canonique";
import { cn } from "@/lib/utils";

/**
 * ÉDITER LE PIED LÉGAL D'UNE ÉDITION.
 *
 * ⛔ CE QUE CET ÉCRAN NE PROPOSE PAS, ET POURQUOI IL LE DIT. Le TEXTE de chaque lien se reformule
 * (décision d'Alix du 22/09/2026, voir `Formulation`) ; le lien de désinscription et le lien de
 * préférences eux-mêmes ne sont pas modifiables : ils sont signés pour CHAQUE destinataire et calculés à
 * l'envoi. Les taire donnerait l'impression d'un oubli ; les afficher grisés, avec la raison, évite
 * qu'on les cherche ailleurs — ou qu'on tente de les recréer dans un bloc de texte, ce qui poserait
 * dans l'e-mail un second lien, non signé, qui ne désinscrit personne.
 *
 * ⛔ « CE QUI MANQUE » EST UN BLOCAGE D'ENVOI, PAS UN CONSEIL. Un `missing` non vide met le worker
 * en veto (`footer_incomplete`) : les e-mails de cette édition ne partent pas. Le bandeau le dit
 * dans ces termes, avec le code exact, parce que c'est ce code qu'on retrouvera dans les journaux.
 */

export interface EditionVue {
  id: string;
  market: string;
  language: string;
  regime: "gdpr" | "lgpd" | "canspam";
  isPrimary: boolean;
  cfg: FooterConfig;
  missing: string[];
}

export const NOM_REGIME: Record<EditionVue["regime"], string> = {
  gdpr: "GDPR",
  lgpd: "LGPD",
  canspam: "CAN-SPAM",
};

export function LegalFooterForm({
  editions,
  known,
  brandKnown,
  brandName,
}: {
  editions: EditionVue[];
  known: boolean;
  brandKnown: boolean;
  brandName: string;
}) {
  if (!brandKnown) {
    return (
      <Card>
        <Bandeau>
          Database unavailable — the brand could not be resolved, so its legal footer cannot be
          loaded.
        </Bandeau>
      </Card>
    );
  }
  if (!known) {
    return (
      <Card>
        <Bandeau>
          The legal footer could not be read. This is not the same as having nothing configured —
          check back rather than filling it in from scratch.
        </Bandeau>
      </Card>
    );
  }
  if (editions.length === 0) {
    return (
      <Card>
        <CardHead
          title="Legal footer"
          sub={`${brandName} has no edition yet, so there is no legal footer to configure. An edition is created with the brand's first market and language.`}
        />
      </Card>
    );
  }

  return (
    <>
      <Card className="mb-4">
        <CardHead
          title="Brand default legal footer"
          sub="Used by every email that doesn’t pick a legal footer above, and by the built-in welcome and confirmation emails. What it says is yours to write; who it links to is not — unsubscribe links are signed per recipient."
        />
        <div className="rounded-[10px] border border-border bg-card/60 px-3.5 py-3 text-[12.5px] leading-relaxed text-muted-foreground">
          Changes here apply to every email of that edition, including the ones already published:
          the legal footer is injected at send time, not frozen into the template.
        </div>
      </Card>

      {editions.map((e) => (
        <EditionCard key={e.id} edition={e} brandName={brandName} />
      ))}
    </>
  );
}

function EditionCard({ edition, brandName }: { edition: EditionVue; brandName: string }) {
  const router = useRouter();
  const [cfg, setCfg] = useState<FooterConfig>(edition.cfg);
  const [envoi, setEnvoi] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [enregistre, setEnregistre] = useState(false);

  // Seuls les champs que CE régime et CE marché rendent utiles. Les seize d'un coup feraient un mur
  // où l'obligation qui bloque l'envoi se perdrait entre l'Impressum allemand et le NIF espagnol.
  const champs = useMemo(
    () =>
      FOOTER_FIELDS.filter(
        (f) =>
          f.appliesTo.length === 0 ||
          f.appliesTo.includes(edition.regime) ||
          f.appliesTo.includes(edition.market),
      ),
    [edition.regime, edition.market],
  );

  const modifie = canonique(cfg) !== canonique(edition.cfg);

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
      const res = await fetch(`/api/builder/legal-footer/${edition.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cfg }),
      });
      const data = (await res.json()) as { error?: string; cfg?: FooterConfig };
      if (!res.ok) {
        setErreur(data.error ?? `could not save (${res.status})`);
        return;
      }
      // ⛔ ON ADOPTE LA CONFIG NORMALISÉE PAR LE SERVEUR, sinon « Saved » ne s'affiche jamais. La
      // route rogne les espaces, arrondit les nombres et retire les champs vides : l'état local
      // brut ne peut PAS égaler ce qui est en base (un `<input type="number"`> rend la chaîne
      // `"30"`, la base garde le nombre `30`). Se resynchroniser sur le serveur évite d'avoir à
      // réécrire ici sa normalisation — ce qui en ferait une seconde source de vérité.
      if (data.cfg) setCfg(data.cfg);
      setEnregistre(true);
      // La page recalcule `missing` côté serveur : le bandeau de blocage doit venir de la même
      // source que le veto d'envoi, jamais d'un état local optimiste.
      router.refresh();
    } catch (e) {
      setErreur((e as Error).message);
    } finally {
      setEnvoi(false);
    }
  }

  return (
    <Card className="mb-4">
      <CardHead
        title={`${edition.market} · ${edition.language}`}
        sub={`Emails sent to this edition carry ${NOM_REGIME[edition.regime]} obligations.`}
        right={
          <div className="flex items-center gap-2">
            {edition.isPrimary && <Pill tone="pink">Primary</Pill>}
            <Pill>{NOM_REGIME[edition.regime]}</Pill>
          </div>
        }
      />

      {edition.missing.length > 0 && (
        <Bandeau>
          <span className="font-semibold">Emails for this edition are not going out.</span> The
          platform refuses to send a footer that is missing a required mention — the worker logs it
          as{" "}
          {/* ⛔ UN SEUL CODE, LA LISTE JOINTE PAR VIRGULES — c'est la forme EXACTE qu'écrit le worker :
              apps/worker/src/process.ts:60 appelle skip() avec footerMissing joint par des virgules.
              Un code PAR CHAMP se lisait bien à l'écran mais n'existait dans AUCUN journal dès qu'il
              en manquait deux : l'écran envoyait chercher une chaîne introuvable. */}
          <code className="rounded bg-amber-100 px-1 py-px font-mono text-[11.5px]">
            footer_incomplete:{edition.missing.join(",")}
          </code>
          . Fill the matching field{edition.missing.length > 1 ? "s" : ""} below and save.
        </Bandeau>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        {champs.map((f) => (
          <Champ
            key={f.key}
            champ={f}
            valeur={(cfg as Record<string, unknown>)[f.key]}
            manquant={edition.missing.includes(f.key)}
            onChange={(v) => poser(f.key, v)}
            brandName={brandName}
          />
        ))}
      </div>

      <Habillage cfg={cfg} onChange={(style) => poser("style", style)} />

      <Formulation
        cfg={cfg}
        regimes={[edition.regime]}
        markets={[edition.market]}
        language={edition.language}
        onChange={(w) => poser("wording", w)}
      />

      <Apercu cfg={cfg} editions={[edition]} brandName={brandName} />

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
    </Card>
  );
}

export function Champ({
  champ,
  valeur,
  manquant,
  onChange,
  brandName,
}: {
  champ: FooterField;
  valeur: unknown;
  manquant: boolean;
  onChange: (v: unknown) => void;
  brandName: string;
}) {
  if (champ.kind === "boolean") {
    return (
      <label className="flex items-start gap-2.5 rounded-[8px] border border-border bg-background px-2.5 py-2 text-[12.5px] md:col-span-2">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={Boolean(valeur)}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>
          <span className="font-medium">{champ.label}</span>
          <span className="block text-[11.5px] text-muted-foreground">{champ.help}</span>
        </span>
      </label>
    );
  }

  return (
    <label className={cn("block text-[12.5px]", champ.key === "reason" && "md:col-span-2")}>
      <span className="mb-1 flex items-center gap-2 font-medium">
        {champ.label}
        {manquant && <Pill tone="amber">Required</Pill>}
      </span>
      <input
        type={champ.kind === "number" ? "number" : "text"}
        className={cn(
          "w-full rounded-[8px] border bg-background px-2.5 py-2 text-[12.5px]",
          manquant ? "border-amber-300" : "border-border",
        )}
        // ⛔ `null` AUSSI, PAS SEULEMENT `undefined`. La colonne est un `jsonb` : une clé posée à
        // `null` par une migration ou un ancien écrit est bien PRÉSENTE, donc `String(valeur)`
        // affichait les quatre lettres « null » dans le champ — que l'auteur enregistrait ensuite
        // comme mention légale s'il n'y touchait pas.
        value={valeur === undefined || valeur === null ? "" : String(valeur)}
        onChange={(e) => onChange(e.target.value)}
        placeholder={
          champ.key === "controller"
            ? brandName
            : champ.kind === "url"
              ? "https://…"
              : undefined
        }
      />
      <span className="mt-1 block text-[11.5px] leading-relaxed text-muted-foreground">
        {champ.help}
      </span>
    </label>
  );
}

/**
 * L'habillage — la raison pour laquelle toutes les marques ont aujourd'hui le même pied.
 *
 * ⚠️ Un champ laissé vide garde la valeur d'origine : `buildFooter` ne remplace que ce qu'on lui
 * donne. C'est écrit à l'écran, sinon on efface un champ en croyant le neutraliser.
 */
export function Habillage({
  cfg,
  onChange,
}: {
  cfg: FooterConfig;
  onChange: (style: Record<string, unknown> | undefined) => void;
}) {
  const style = (cfg.style ?? {}) as Record<string, unknown>;

  function poser(cle: string, v: string) {
    const suivant = { ...style };
    if (v === "") delete suivant[cle];
    else suivant[cle] = cle === "fontSizePx" ? Number(v) : v;
    onChange(Object.keys(suivant).length > 0 ? suivant : undefined);
  }

  const couleurs: [string, string][] = [
    ["color", "Text colour"],
    ["linkColor", "Link colour"],
    ["borderTopColor", "Top border"],
    ["background", "Background"],
  ];

  return (
    <div className="mt-3 rounded-[10px] border border-border bg-card/60 p-3">
      <div className="mb-1 text-[12.5px] font-semibold">Look</div>
      <p className="mb-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
        Leave a field empty to keep the current look. This is why every brand’s legal footer looks
        the same today — nothing here had a value.
      </p>
      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        {couleurs.map(([cle, label]) => (
          <label key={cle} className="block text-[12px]">
            <span className="mb-1 block font-medium">{label}</span>
            <input
              className="w-full rounded-[8px] border border-border bg-background px-2.5 py-1.5 font-mono text-[12px]"
              value={String(style[cle] ?? "")}
              onChange={(e) => poser(cle, e.target.value.trim())}
              placeholder={cle === "background" ? "none" : "#999999"}
            />
          </label>
        ))}
        <label className="block text-[12px]">
          <span className="mb-1 block font-medium">Text size</span>
          <input
            type="number"
            min={9}
            max={18}
            className="w-full rounded-[8px] border border-border bg-background px-2.5 py-1.5 text-[12px]"
            value={String(style.fontSizePx ?? "")}
            onChange={(e) => poser("fontSizePx", e.target.value)}
            placeholder="11"
          />
        </label>
        <label className="block text-[12px]">
          <span className="mb-1 block font-medium">Alignment</span>
          <select
            className="w-full rounded-[8px] border border-border bg-background px-2.5 py-1.5 text-[12px]"
            value={String(style.align ?? "")}
            onChange={(e) => poser("align", e.target.value)}
          >
            <option value="">Centre (default)</option>
            <option value="left">Left</option>
            <option value="center">Centre</option>
            <option value="right">Right</option>
          </select>
        </label>
      </div>
    </div>
  );
}

const GROUPES: [FooterWordingField["group"], string][] = [
  ["links", "Link texts"],
  ["sentences", "Sentences"],
  ["market", "Market mentions"],
  ["layout", "Separators"],
];

/**
 * LA FORMULATION DU PIED (décision d'Alix du 22/09/2026) : chaque texte, chaque séparateur, l'ordre
 * des lignes.
 *
 * ⚠️ LE TEXTE D'EXEMPLE EST LE TEXTE QUI PART. Un champ vide n'est pas un pied sans ce texte : c'est
 * le texte par défaut, traduit dans la langue de l'édition — et c'est lui qui s'affiche en grisé.
 * Sans cela, on viderait un champ en croyant retirer la mention.
 */
export function Formulation({
  cfg,
  regimes,
  markets,
  language,
  onChange,
}: {
  cfg: FooterConfig;
  /** Les régimes et marchés des éditions qui recevront ce pied : un texte n'est proposé que s'il y sert. */
  regimes: string[];
  markets: string[];
  /** La langue dont les textes par défaut servent d'exemple. */
  language: string;
  onChange: (wording: FooterWording | undefined) => void;
}) {
  const w = (cfg.wording ?? {}) as Record<string, unknown>;
  const defaut = defaultWording(normalizeLocale(language));
  const champs = FOOTER_WORDING_FIELDS.filter(
    (f) => f.appliesTo.length === 0 || f.appliesTo.some((a) => regimes.includes(a) || markets.includes(a)),
  );
  const ordre = footerLineOrder(w.order);

  function poser(cle: string, v: unknown) {
    const suivant = { ...w };
    if (v === "" || v === undefined) delete suivant[cle];
    else suivant[cle] = v;
    onChange(Object.keys(suivant).length > 0 ? (suivant as FooterWording) : undefined);
  }

  function deplacer(i: number, pas: -1 | 1) {
    const j = i + pas;
    if (j < 0 || j >= ordre.length) return;
    const o = [...ordre];
    [o[i], o[j]] = [o[j]!, o[i]!];
    // L'ordre d'origine ne se stocke pas : c'est lui qui part quand rien n'est réglé.
    poser("order", o.every((l, k) => l === FOOTER_LINES[k]) ? undefined : o);
  }

  return (
    <div className="mt-3 rounded-[10px] border border-border bg-card/60 p-3">
      <div className="mb-1 text-[12.5px] font-semibold">Wording</div>
      <p className="mb-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
        Every text of the footer can be reworded. Leave a field empty to send the default shown in
        grey, translated into the edition&apos;s language. Mandatory mentions can be reworded, not
        removed: a text needs at least one word, and the delay sentences must keep{" "}
        <code className="font-mono">{"{days}"}</code>.
      </p>

      {GROUPES.map(([groupe, titre]) => {
        const liste = champs.filter((f) => f.group === groupe);
        if (liste.length === 0) return null;
        return (
          <div key={groupe} className="mb-3">
            <div className="mb-1.5 text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground">{titre}</div>
            <div className="grid gap-2.5 md:grid-cols-2">
              {liste.map((f) => (
                <label key={f.key} className="block text-[12px]">
                  <span className="mb-1 block font-medium">{f.label}</span>
                  <input
                    className={cn(
                      "w-full rounded-[8px] border border-border bg-background px-2.5 py-1.5 text-[12px]",
                      f.group === "layout" && "font-mono",
                    )}
                    value={typeof w[f.key] === "string" ? (w[f.key] as string) : ""}
                    // Un séparateur garde ses espaces : ils SONT le séparateur.
                    onChange={(e) => poser(f.key, e.target.value)}
                    placeholder={defaut[f.key]}
                  />
                  <span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">{f.help}</span>
                </label>
              ))}
            </div>
          </div>
        );
      })}

      <div className="mb-1.5 text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground">Line order</div>
      <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground">
        Lines that do not apply to an edition are skipped. The order can only move lines, never hide
        one.
      </p>
      <ol className="space-y-1">
        {ordre.map((l, i) => (
          <li
            key={l}
            className="flex items-center justify-between rounded-[8px] border border-border bg-background px-2.5 py-1.5 text-[12px]"
          >
            <span>{FOOTER_LINE_LABELS[l]}</span>
            <span className="flex gap-1">
              <button
                type="button"
                aria-label={`Move “${FOOTER_LINE_LABELS[l]}” up`}
                className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-30"
                disabled={i === 0}
                onClick={() => deplacer(i, -1)}
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                aria-label={`Move “${FOOTER_LINE_LABELS[l]}” down`}
                className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-30"
                disabled={i === ordre.length - 1}
                onClick={() => deplacer(i, 1)}
              >
                <ArrowDown className="h-3.5 w-3.5" />
              </button>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * L'APERÇU EN DIRECT — le pied tel que `buildFooter` le rendra, pas une imitation.
 *
 * ⛔ C'EST LA MÊME FONCTION QUE CELLE DU WORKER, ET C'EST TOUT L'INTÉRÊT. Un aperçu recodé côté écran
 * divergerait du premier changement de `buildFooter` : on validerait un pied qui n'est pas celui qui
 * part. Les liens sont des exemples — les vrais sont signés pour chaque lecteur, à l'envoi.
 *
 * ⚠️ `sandbox=""` : le HTML vient d'une saisie. Sans script, sans formulaire, sans navigation, il ne
 * peut rien faire d'autre que s'afficher.
 */
export function Apercu({
  cfg,
  editions,
  brandName,
}: {
  cfg: FooterConfig;
  editions: Pick<EditionVue, "id" | "market" | "language" | "regime">[];
  brandName: string;
}) {
  const [choisie, setChoisie] = useState(editions[0]?.id ?? "");
  const e = editions.find((x) => x.id === choisie) ?? editions[0];
  const pied = useMemo(
    () =>
      e
        ? buildFooter({
            assetName: brandName,
            regime: e.regime,
            cfg,
            unsubUrl: "https://example.com/unsubscribe",
            prefsUrl: "https://example.com/preferences",
            locale: normalizeLocale(e.language),
            market: e.market,
          })
        : null,
    [cfg, e, brandName],
  );
  if (!e || !pied) return null;

  return (
    <div className="mt-3 rounded-[10px] border border-border bg-card/60 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-[12.5px] font-semibold">Live preview</span>
        {editions.length > 1 && (
          <select
            className="rounded-[8px] border border-border bg-background px-2 py-1 text-[12px]"
            value={e.id}
            onChange={(ev) => setChoisie(ev.target.value)}
            aria-label="Preview for edition"
          >
            {editions.map((x) => (
              <option key={x.id} value={x.id}>
                {x.market} · {x.language} · {NOM_REGIME[x.regime]}
              </option>
            ))}
          </select>
        )}
      </div>
      <iframe
        title="Legal footer preview"
        sandbox=""
        srcDoc={`<!DOCTYPE html><html><body style="margin:0;background:#fff">${pied.html}</body></html>`}
        className="h-[200px] w-full rounded-[8px] border border-border bg-white"
      />
      <details className="mt-2 text-[12px]">
        <summary className="cursor-pointer text-muted-foreground">Plain-text version</summary>
        <pre className="mt-1.5 whitespace-pre-wrap rounded-[8px] border border-border bg-background p-2.5 font-mono text-[11.5px]">
          {pied.text}
        </pre>
      </details>
      {pied.missing.length > 0 && (
        <p className="mt-2 text-[12px] text-amber-800">
          With these values, emails would not go out:{" "}
          <code className="font-mono">footer_incomplete:{pied.missing.join(",")}</code>
        </p>
      )}
    </div>
  );
}

/**
 * Ce qui N'EST PAS modifiable, dit à l'endroit où on le chercherait (décision d'Alix du 22/09/2026 :
 * la formulation est libre, la présence des mentions ne l'est pas).
 */
export function Verrous() {
  return (
    <div className="mt-3 flex items-start gap-2.5 rounded-[10px] border border-border bg-card/60 px-3.5 py-3 text-[12.5px] leading-relaxed text-muted-foreground">
      <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.9} />
      <span>
        What the footer says is yours to write; what it must contain is not. The unsubscribe link, the
        privacy link and — where the law asks for it — the postal address are always there: an email
        missing one is not sent. The unsubscribe and preferences links are built per recipient and
        signed, so they cannot be copied into a text block — a second copy would not unsubscribe
        anyone. Gmail and Yahoo also require bulk senders to carry a{" "}
        <code className="font-mono">List-Unsubscribe</code> header (February 2024 rules): the platform
        adds it to every newsletter and welcome email, and it cannot be edited or turned off.
      </span>
    </div>
  );
}

export function Bandeau({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-start gap-2.5 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] leading-relaxed text-amber-800">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{children}</span>
    </div>
  );
}
