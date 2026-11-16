"use client";

/**
 * Les shortcodes d'une ligne d'objet : des puces cliquables, et l'aperçu de ce que ça donne.
 *
 * ⛔ POURQUOI L'APERÇU N'EST PAS DÉCORATIF. Un jeton hors registre est retiré EN SILENCE par
 * l'hydratation (fail-closed voulu) : « Edição de {{data}} » part en « Edição de  » chez 1 200
 * abonnés, sans la moindre erreur nulle part. Tant qu'on ne montre pas le sujet RÉSOLU, personne
 * ne peut voir ce qui manque.
 *
 * ⛔ ET L'APERÇU UTILISE LE VRAI MOTEUR (`hydrateText` de @nf/render), jamais un remplacement
 * réécrit ici : deux implémentations de la même substitution finissent toujours par diverger, et
 * c'est l'aperçu qui aurait raison à l'écran pendant que l'envoi ferait autre chose.
 */
import { useMemo, type RefObject } from "react";
import { hydrateText, MERGE_VARS } from "@nf/render/hydrate";
import { JETONS_DE_SERIE, jetonsSansValeurHorsSerie } from "@/components/campaigns/cadence";
import { cn } from "@/lib/utils";

type TokenName = keyof typeof MERGE_VARS;

export interface JetonProposable {
  name: TokenName;
  aide: string;
}

/**
 * Les jetons qui ont un sens dans une LIGNE D'OBJET, dans l'ordre où on les propose.
 *
 * ⛔ Le type `TokenName` est ce qui protège cette liste : un nom qui n'existe pas dans le registre
 * fait échouer le typecheck, au lieu de produire une puce qui insère un jeton mort.
 *
 * Écartés volontairement : les URL (`unsubscribe_url`…), le footer légal, les drapeaux et `email` —
 * aucun n'a sa place dans un objet d'email, et `email` y serait même un signal de spam.
 *
 * ⛔ ET `edition_title` EN EST SORTI LE 18/09/2026, PARCE QU'IL PART TOUJOURS VIDE. Mesuré des
 * deux côtés : `apps/worker/src/render.ts:140` ne le lit QUE dans le payload de la ligne, et
 * `0038_enqueue_campaign_batch.sql:90-91` ne met dans ce payload que `first_name`. Aucun envoi de
 * campagne ne l'alimente donc, ni ponctuel ni en série. Pire qu'un jeton inconnu : celui-là est
 * DANS le registre, donc l'alerte rouge ci-dessous ne le voyait pas passer — d'où `JAMAIS_SERVIS`.
 */
export const SUJET: JetonProposable[] = [
  { name: "first_article", aide: "Titre de l'article de tête de cette édition" },
  { name: "article_count", aide: "Nombre d'articles de l'édition" },
  { name: "edition_number", aide: "Numéro d'édition, incrémenté à chaque envoi de la série" },
  { name: "edition_date", aide: "Jour de l'envoi, en toutes lettres" },
  { name: "edition_date_short", aide: "Jour de l'envoi, format court" },
  { name: "weekday", aide: "Jour de la semaine" },
  { name: "campaign_name", aide: "Nom de la campagne" },
  { name: "asset_name", aide: "Nom de la marque" },
  { name: "first_name", aide: "Prénom de l'abonné — le seul jeton qui varie par destinataire" },
];

/**
 * Les jetons qui ont un sens dans une LIGNE D'APERÇU (le preheader), demandés par Alix le
 * 18/09/2026 : « pre header met les mêmes tag shortcode cliquable que pour le champ subject […]
 * mais plus orienté pre header ».
 *
 * ⛔ CE N'EST PAS LA MÊME LISTE QUE LE SUJET, ET TROIS ÉCARTS SONT DÉLIBÉRÉS :
 *
 *  1. **`ai_preheader` EN TÊTE — il n'était pas servable AVANT ce lot.** Les deux déclencheurs de
 *     génération ne lisaient que le preheader DU MODÈLE (`doc.meta.preheader`) : un
 *     `{{ai_preheader}}` écrit sur la campagne n'appelait rien et partait en blanc. Depuis que le
 *     preheader de la campagne écrase celui du modèle, le déclencheur lit le preheader EFFECTIF
 *     (`lock/route.ts`, `planner.ts`) et la valeur a bien un repli campagne
 *     (`render.ts` : `occurrence_ai_preheader ?? campaign_ai_preheader`). C'est désormais son
 *     champ naturel : une ligne d'aperçu écrite à partir des titres réellement expédiés.
 *  2. ⛔ **`campaign_name` EN EST ABSENT.** C'est un libellé INTERNE (« TEST SINGLE »,
 *     « Friday NL TW ») : le mettre dans la ligne d'aperçu gaspillerait la seule phrase que le
 *     lecteur voit avant d'ouvrir, pour lui montrer notre nomenclature. Il reste proposé au sujet,
 *     où il a parfois un sens éditorial.
 *  3. ⛔ **`edition_title` N'Y EST PAS NON PLUS**, pour la raison qui l'a fait sortir du sujet : rien
 *     ne l'alimente sur un envoi de campagne, il part TOUJOURS vide (voir `JAMAIS_SERVIS`).
 */
export const PREHEADER: JetonProposable[] = [
  { name: "ai_preheader", aide: "Ligne d'aperçu écrite par le modèle à partir des articles envoyés" },
  { name: "first_article", aide: "Titre de l'article de tête de cette édition" },
  { name: "article_count", aide: "Nombre d'articles de l'édition" },
  { name: "edition_number", aide: "Numéro d'édition, incrémenté à chaque envoi de la série" },
  { name: "edition_date", aide: "Jour de l'envoi, en toutes lettres" },
  { name: "edition_date_short", aide: "Jour de l'envoi, format court" },
  { name: "weekday", aide: "Jour de la semaine" },
  { name: "first_name", aide: "Prénom de l'abonné — le seul jeton qui varie par destinataire" },
  { name: "asset_name", aide: "Nom de la marque" },
];

/**
 * Valeurs d'EXEMPLE pour l'aperçu, utilisées seulement quand la campagne ne connaît pas encore la
 * vraie. Elles sont volontairement reconnaissables : personne ne doit croire qu'un aperçu montre
 * une donnée réelle alors qu'il montre un échantillon.
 */
const EXEMPLES: Partial<Record<TokenName, string>> = {
  // Reconnaissable comme un échantillon : le vrai texte est écrit par le modèle au verrouillage (ou
  // au gel), à partir des titres RÉELLEMENT expédiés — donc il n'existe pas encore à la saisie.
  ai_preheader: "Le récap de la journée, en trois minutes",
  first_article: "Palmeiras vence o clássico",
  article_count: "7",
  edition_number: "12",
  edition_date: "6 septembre 2026",
  edition_date_short: "6 sept. 2026",
  weekday: "dimanche",
  first_name: "Ana",
};

/**
 * Des jetons du registre que RIEN n'alimente sur un envoi de campagne.
 *
 * ⛔ LES RETIRER DES PUCES NE SUFFIT PAS : une campagne qui en porte déjà un continuerait à
 * partir amputée, en silence, puisque le contrôle de jeton inconnu les reconnaît. On les nomme
 * donc, et on le dit à l'écran.
 */
const JAMAIS_SERVIS: Partial<Record<TokenName, string>> = {
  edition_title: "no campaign send fills it in — it would be sent blank",
};

/**
 * Les noms de jetons écrits dans un texte, dans l'ordre, sans doublon.
 *
 * ⚠️ Le motif tolère les espaces et un filtre (`{{ first_name | upper }}`) : ne reconnaître que la
 * forme la plus courte laisserait passer, sans alerte, exactement les écritures les plus risquées.
 */
function jetonsEcrits(texte: string): string[] {
  const trouves: string[] = [];
  const re = /\{\{\s*([A-Za-z0-9_]+)\s*(?:\|[^}]*)?\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(texte)) !== null) {
    const nom = m[1] as string;
    if (!trouves.includes(nom)) trouves.push(nom);
  }
  return trouves;
}

export interface SubjectTokensProps {
  /** Le champ à alimenter — l'insertion se fait à la POSITION DU CURSEUR, pas à la fin. */
  inputRef: RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (next: string) => void;
  /**
   * Ce que la campagne sait déjà (nom, date planifiée, marque…). Ces valeurs-là ne sont pas des
   * exemples : elles seront celles de l'envoi.
   */
  connu?: Partial<Record<TokenName, string>>;
  disabled?: boolean;
  /** Limite du champ, pour dire quand le texte RÉSOLU la dépasse. */
  maxLength?: number;
  /** Les puces à proposer. `SUJET` par défaut ; `PREHEADER` pour la ligne d'aperçu. */
  jetons?: JetonProposable[];
  /**
   * ⛔ Y A-T-IL UNE CADENCE ? `first_article`, `article_count` et `edition_number` ne sont écrits
   * qu'au GEL D'UNE OCCURRENCE (`render.ts` : `ctx.occurrence_*`). Sur une campagne ponctuelle ils
   * s'hydratent en chaîne vide, TOUJOURS. Les proposer là serait la faute `edition_title` refaite :
   * une puce qui insère un jeton mort, et un texte qui part troué sans la moindre erreur.
   *
   * ⚠️ La question est « y a-t-il une cadence ? », pas « est-elle armée ? » — même règle que
   * `jetonsSansValeurHorsSerie`, dont cette liste est le pendant côté SAISIE : le sujet, lui, se
   * faisait refuser au verrou, c'est-à-dire beaucoup trop tard.
   */
  serie?: boolean;
  /** L'étiquette de l'aperçu — ce que le lecteur voit à cet endroit de sa boîte. */
  apercuLabel?: string;
}

export function SubjectTokens({
  inputRef,
  value,
  onChange,
  connu = {},
  disabled = false,
  maxLength = 200,
  jetons = SUJET,
  serie = true,
  apercuLabel = "Inbox preview",
}: SubjectTokensProps) {
  /*
   * ⛔ ON NE PROPOSE QUE CE QUE CETTE CAMPAGNE-LÀ SAIT REMPLIR. Une ponctuelle n'a ni occurrence ni
   * gel : les trois jetons de série y partiraient vides. On les retire des puces — et on ALERTE
   * quand même plus bas si quelqu'un en a déjà écrit un, parce que les retirer du menu ne répare pas
   * les campagnes qui en portent déjà.
   */
  const proposes = useMemo(
    () => (serie ? jetons : jetons.filter((j) => !(JETONS_DE_SERIE as readonly string[]).includes(j.name))),
    [jetons, serie],
  );
  function inserer(name: TokenName) {
    const token = `{{${name}}}`;
    const el = inputRef.current;
    // Sans champ monté (cas théorique), on ajoute à la fin plutôt que de ne rien faire.
    const debut = el?.selectionStart ?? value.length;
    const fin = el?.selectionEnd ?? value.length;
    const suivant = value.slice(0, debut) + token + value.slice(fin);
    onChange(suivant);
    // Le curseur se replace APRÈS le jeton inséré : on compose une phrase, on ne repart pas du début.
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const pos = debut + token.length;
      el.setSelectionRange(pos, pos);
    });
  }

  const apercu = useMemo(() => {
    const vars: Record<string, string> = {};
    let aDeLExemple = false;
    // ⛔ `proposes` ET PAS `jetons` : un jeton de série écrit dans une campagne ponctuelle ne doit
    // recevoir AUCUNE valeur d'exemple. L'aperçu montre alors le trou qu'il fera réellement — c'est
    // toute la différence entre un aperçu et une jolie promesse.
    for (const { name } of proposes) {
      const reel = connu[name];
      if (reel !== undefined && reel !== "") {
        vars[name] = reel;
        continue;
      }
      const exemple = EXEMPLES[name];
      if (exemple !== undefined) {
        vars[name] = exemple;
        // Seul un jeton RÉELLEMENT écrit dans le sujet rend l'aperçu approximatif.
        if (value.includes(`{{${name}`)) aDeLExemple = true;
      }
    }
    return { texte: hydrateText(value, vars).trim(), aDeLExemple };
  }, [value, connu, proposes]);

  const inconnus = useMemo(() => jetonsEcrits(value).filter((n) => !(n in MERGE_VARS)), [value]);

  /** Les jetons écrits ici que l’envoi ne saura pas remplir. */
  const vides = useMemo(
    () => (Object.keys(JAMAIS_SERVIS) as TokenName[]).filter((n) => value.includes(`{{${n}`)),
    [value],
  );

  /*
   * ⛔ LES RETIRER DU MENU NE RÉPARE PAS CE QUI EST DÉJÀ ÉCRIT. Une campagne ponctuelle qui porte
   * déjà `{{first_article}}` — écrit quand elle était une série, ou copié d'une autre — continuerait
   * à partir avec un trou, en silence. On le dit.
   */
  const deSerie = useMemo(
    () => (serie ? [] : jetonsSansValeurHorsSerie(jetonsEcrits(value), serie)),
    [value, serie],
  );

  const tropLong = apercu.texte.length > maxLength;

  return (
    <div className="mt-1.5">
      <div className="flex flex-wrap gap-1">
        {proposes.map((t) => (
          <button
            key={t.name}
            type="button"
            disabled={disabled}
            title={t.aide}
            onClick={() => inserer(t.name)}
            className={cn(
              "rounded-full border border-border px-2 py-[3px] font-mono text-[10.5px] transition-colors",
              disabled
                ? "cursor-not-allowed opacity-40"
                : "text-muted-foreground hover:border-foreground/30 hover:bg-accent hover:text-foreground",
            )}
          >
            {MERGE_VARS[t.name].label}
          </button>
        ))}
      </div>

      {value.trim() !== "" && (
        <div className="mt-1.5 rounded-lg border border-border bg-muted/40 px-2.5 py-1.5 text-[11.5px]">
          <span className="mr-1.5 font-semibold uppercase tracking-wide text-muted-foreground">
            {apercuLabel}
          </span>
          <span className="text-foreground">{apercu.texte || "(empty)"}</span>
          {apercu.aDeLExemple && (
            <span className="ml-1.5 text-muted-foreground">— sample values, the real edition fills them in</span>
          )}
        </div>
      )}

      {inconnus.length > 0 && (
        <p className="mt-1 text-[11.5px] text-red-600">
          Unknown shortcode{inconnus.length > 1 ? "s" : ""} {inconnus.map((n) => `{{${n}}}`).join(", ")} — it
          would be silently removed from the subject. Use a chip above.
        </p>
      )}

      {deSerie.length > 0 && (
        <p className="mt-1 text-[11.5px] text-red-600">
          {deSerie.map((n) => `{{${n}}}`).join(", ")} —{" "}
          {deSerie.length > 1 ? "these are filled" : "this is filled"} from each edition of a series,
          and this campaign sends once. {deSerie.length > 1 ? "They" : "It"} would arrive blank. Turn
          recurrence on, or remove {deSerie.length > 1 ? "them" : "it"}.
        </p>
      )}

      {vides.length > 0 && (
        <p className="mt-1 text-[11.5px] text-red-600">
          {vides.map((n) => `{{${n}}}`).join(", ")} — {JAMAIS_SERVIS[vides[0]!]}. Remove it, or the
          sentence around it will arrive with a hole in it.
        </p>
      )}

      {tropLong && (
        <p className="mt-1 text-[11.5px] text-amber-700">
          Once filled in, this subject is {apercu.texte.length} characters — above the {maxLength} allowed.
          Shortcodes expand: what you type is shorter than what is sent.
        </p>
      )}
    </div>
  );
}
