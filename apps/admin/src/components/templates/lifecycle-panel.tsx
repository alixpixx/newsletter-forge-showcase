"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, Languages, Layers, Loader2, PenLine, Wand2 } from "lucide-react";
import type { LifecycleKind } from "@nf/render/lifecycle-checks";
import { Modal } from "@/components/builder/modal";
import { Btn, Card, CardHead, Pill } from "@/components/ui";
// Les libellés vivent dans un module SANS `"use client"` : la fiche du modèle et la liste doivent
// donner les mêmes noms aux mêmes e-mails, et un Server Component ne peut pas lire une constante
// déclarée ici (il n'en recevrait qu'une référence, qui lèverait à l'exécution).
import { LIFECYCLE_LABELS } from "@/components/templates/lifecycle-labels";
import { lifecycleSlotChoices, type LifecycleSlot } from "@/lib/lifecycle-slots";

/*
 * Les quatre e-mails de cycle de vie de la marque, réglables sans quitter la liste.
 *
 * ⛔ POURQUOI CE PANNEAU EXISTE. Le réglage ne vivait que dans la fiche d'un modèle, derrière une
 * carte qu'il fallait déjà connaître pour aller la chercher ; la liste n'en montrait la trace que
 * s'il existait DÉJÀ un rattachement. Sur une marque neuve — le seul moment où l'on cherche — il n'y
 * avait rien à voir. Les quatre e-mails partent de toute façon : l'écran les montre donc toujours.
 *
 * ⛔ AUCUN FAUX SUCCÈS. On n'affiche l'état que si le serveur l'a rendu (`known`), on n'écrit que par
 * la route qui contrôle déjà le contenu, et on ne rafraîchit qu'après un 2xx. Le message d'erreur du
 * serveur est affiché tel quel : c'est lui qui nomme le jeton manquant (`{{confirm_url}}`…), le
 * traduire en « erreur réseau » ferait chercher la panne au mauvais endroit.
 */

const SELECT =
  "max-w-[240px] rounded-lg border border-border bg-card px-2 py-1.5 text-[12px] outline-none focus:border-brand disabled:opacity-50";

/** Même dessin que `Btn variant="ghost"`, porté par une ancre — voir le commentaire du lien « Edit ». */
const BOUTON_LIEN =
  "inline-flex items-center gap-2 rounded-[9px] px-2.5 py-1.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 focus-visible:ring-offset-2";

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error) return body.error;
  } catch {
    /* corps non-JSON — on garde le statut */
  }
  return `Request failed (${res.status})`;
}

export interface LifecyclePanelTemplate {
  id: string;
  name: string;
  publishedVersion: number | null;
}

function StatusPill({ slot, known }: { slot: LifecycleSlot; known: boolean }) {
  // ⛔ « La base n'a pas répondu » n'est PAS « aucun rattachement » : les deux faits sont opposés, et
  // écrire « Built-in email » sur une lecture ratée ferait prendre une panne pour un réglage.
  if (!known) {
    return (
      <span title="This setting could not be read just now.">
        <Pill tone="amber">Status unavailable</Pill>
      </span>
    );
  }

  if (slot.state === "built-in") {
    if (slot.staleBinding) {
      // ⛔ MÊME AMBRE, MÊME PHRASE QUE LE CAS NON PUBLIÉ : la conséquence est identique (le texte
      // livré part), donc l'écran doit le dire pareil. Un vocabulaire d'« occupation » ici ferait
      // croire à un e-mail maison en service alors que la vue du worker écarte l'archivé.
      return (
        <span title="A template is set for this email, but it is archived — so the built-in email is what goes out. Restore it, or pick another template.">
          <Pill tone="amber">Built-in email still goes out</Pill>
        </span>
      );
    }
    // ⚠️ Ton neutre, jamais rouge : sans modèle, l'e-mail livré avec le produit part et il est
    // correct. C'est un état de repos, pas un trou à combler.
    return (
      <Pill tone="grey" dot>
        Built-in email
      </Pill>
    );
  }

  if (slot.state === "bound-hidden") {
    // ⚠️ On dit CE QUI PART, sans qualifier le droit du lecteur : « you have not been given access »
    // lui apprenait un refus d'accès qu'aucun autre écran ne lui annonce, et se trompait pour un
    // super_admin. Ce qui est vrai dans tous les cas, c'est que ce modèle n'est pas dans sa liste.
    return (
      <span title="This email is served by a template that is not in your library. Picking one of yours replaces it.">
        <Pill tone="grey" dot>
          Set by someone else
        </Pill>
      </span>
    );
  }

  if (!slot.published) {
    // Même phrase et même ambre que les badges du tableau et l'avertissement de la fiche : un
    // troisième vocabulaire pour le même fait finirait par le contredire.
    return (
      <span title="Publish a version to put this template live.">
        <Pill tone="amber">Built-in email still goes out</Pill>
      </span>
    );
  }

  return (
    <Pill tone="green" dot>
      Your template
    </Pill>
  );
}

export function LifecyclePanel({
  slots,
  templates,
  known,
  brandKnown,
  languages,
  assetId,
  canSeedAllBrands = false,
  head,
}: {
  slots: LifecycleSlot[];
  /** Modèles proposables : exactement ceux que la liste montre, donc ceux que la route acceptera. */
  templates: LifecyclePanelTemplate[];
  /** Faux = l'état n'a pas pu être lu. On affiche les quatre e-mails, sans prononcer de verdict. */
  known: boolean;
  /**
   * Faux = la marque elle-même n'a pas pu être résolue, ce que la PAGE annonce déjà dans son propre
   * encadré ambre. Le bandeau interne se tait alors : deux encadrés identiques pour un incident
   * unique font chercher deux causes.
   */
  brandKnown: boolean;
  /**
   * Les langues que la marque ENVOIE (ses éditions), normalisées et dédoublonnées — pas celles
   * qu'elle déclare au registre. Vide = lecture non aboutie : on ne dit rien plutôt que d'affirmer
   * « une seule langue », qui est exactement l'affirmation dangereuse ici.
   */
  languages: string[];
  /**
   * La marque POUR LAQUELLE ce panneau a été rendu.
   *
   * ⛔ POURQUOI L'ÉCRAN LA PORTE. « Customise » n'envoie aucun identifiant de modèle : sans elle, la
   * route n'aurait que le cookie de marque — global au navigateur — et créerait le modèle sur la
   * marque qu'un AUTRE onglet vient de choisir, sans que rien ne puisse échouer. Elle voyage donc
   * avec le geste, et le serveur refuse net si les deux ne coïncident plus.
   */
  assetId: string | null;
  /** Super_admin seulement : l'action « toutes les marques » écrit chez chacune d'elles. */
  canSeedAllBrands?: boolean;
  /** En-tête de la carte : la page d'UN e-mail (`/automations/system/[kind]`) parle de SON modèle. */
  head?: { title: string; sub: string };
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<LifecycleKind | null>(null);
  const [error, setError] = useState<{ kind: LifecycleKind; message: string } | null>(null);
  /**
   * ⛔ UN VERROU SYNCHRONE, PAS SEULEMENT `disabled`. « Customise » ÉCRIT : deux clics rapprochés
   * créeraient deux modèles, tous deux facturés à la marque et tous deux dans la liste. React ne
   * garantit pas d'avoir re-rendu le bouton désarmé entre deux clics d'un double-clic ; une `ref`
   * lue et posée dans le même tour de boucle, elle, ne peut pas être doublée.
   */
  const enEcriture = useRef(false);
  // ⛔ LE RAFRAÎCHISSEMENT FAIT PARTIE DE L'ÉCRITURE. `router.refresh()` ne se termine pas quand il
  // rend la main : la page est `force-dynamic`, il faut le temps d'un aller-retour serveur avant que
  // le nouvel état arrive. Relâcher `busy` avant, c'est rendre au repos, sans le moindre signe
  // d'attente, un écran qui affiche encore l'ANCIENNE valeur — et le sélecteur, contrôlé par le
  // serveur, revient visiblement en arrière. La personne rejoue le geste, ou croit que le
  // détachement a échoué.
  const [refreshing, startTransition] = useTransition();

  /**
   * Un seul écrivain : la route qui sert déjà la fiche du modèle. Elle contrôle le contenu avant de
   * mettre l'e-mail en service (422 nommant le jeton manquant) — un second chemin d'écriture
   * finirait par oublier ce contrôle et mettrait en ligne une confirmation sans lien de confirmation.
   */
  const apply = async (slot: LifecycleSlot, nextTemplateId: string) => {
    // Détacher se fait sur le modèle QUI PORTE la fente, avec le kind explicite : sans lui, le
    // serveur devrait deviner quel rattachement retirer, et se tromperait sur un modèle qui en sert
    // deux.
    // « hidden » n'est pas un identifiant : c'est l'étiquette de l'occupant qu'on n'a pas le droit
    // de nommer. Le sélecteur ne peut pas le réémettre (même valeur = pas d'événement), mais un
    // appel qui le laisserait passer construirait une URL sur un id inventé.
    if (nextTemplateId === "hidden") return;
    const detach = nextTemplateId === "";
    const cible = detach ? slot.templateId : nextTemplateId;
    if (!cible) return;
    if (enEcriture.current) return;
    enEcriture.current = true;

    setBusy(slot.kind);
    setError(null);
    try {
      const res = await fetch(`/api/builder/templates/${cible}/lifecycle`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(detach ? { kind: slot.kind, detach: true } : { kind: slot.kind }),
      });
      if (!res.ok) {
        setError({ kind: slot.kind, message: await readError(res) });
        setBusy(null);
        enEcriture.current = false;
        return;
      }
      // La liste est rendue à chaque requête (`dynamic = "force-dynamic"`) : ce rafraîchissement
      // relit la base, donc la fiche du modèle et ce panneau ne peuvent pas diverger.
      // `busy` n'est PAS relâché ici : c'est l'arrivée du nouvel état serveur qui l'éteindra
      // (`refreshing`), sans quoi l'écran se déclarerait au repos sur la valeur d'avant.
      startTransition(() => {
        router.refresh();
        setBusy(null);
        enEcriture.current = false;
      });
    } catch (err) {
      setError({ kind: slot.kind, message: err instanceof Error ? err.message : "Network error" });
      setBusy(null);
      enEcriture.current = false;
    }
  };

  /**
   * « Customise » : le point de départ qui manquait.
   *
   * ⛔ POURQUOI CE GESTE EXISTE. Rattacher un modèle de campagne à une `confirmation` échoue en 422
   * (il n'a pas `{{confirm_url}}`), et rien ne le disait avant l'échec. La route ci-dessous fabrique
   * SERVEUR une copie éditable de l'e-mail intégré — jetons exigés déjà posés, footer légal en
   * dernier — la rattache, et rend l'identifiant à ouvrir.
   *
   * ⛔ AUCUN FAUX SUCCÈS, MÊME PARTIEL. Le modèle peut être créé sans avoir été rattaché (`attached:
   * false`) : on ne navigue PAS dans ce cas, on nomme ce qui s'est passé et on rafraîchit, pour que
   * le modèle apparaisse dans le sélecteur — qui fait précisément le geste restant.
   *
   * ⛔ TOUTE ISSUE RAFRAÎCHIT, Y COMPRIS L'ÉCHEC. « La réponse n'est pas arrivée » n'est pas « rien
   * n'a été écrit » : les écritures de la route sont commitées une par une (PostgREST, aucune
   * transaction) et la réponse peut se perdre après coup — une passerelle qui rend 504, une
   * connexion qui tombe. Laisser la ligne sur « Built-in email » avec son bouton affirme alors le
   * contraire de la base et rend le geste rejouable sur une fente déjà servie.
   */
  const customise = async (kind: LifecycleKind) => {
    if (enEcriture.current) return;
    enEcriture.current = true;

    setBusy(kind);
    setError(null);
    /** Relit la base : après un échec, c'est elle qui dit si l'écriture avait abouti malgré tout. */
    const echec = (message: string) => {
      setError({ kind, message });
      startTransition(() => {
        router.refresh();
        setBusy(null);
        enEcriture.current = false;
      });
    };
    try {
      const res = await fetch("/api/builder/lifecycle-seed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // La marque de l'ÉCRAN voyage avec le geste : voir la prop `assetId`.
        body: JSON.stringify({ kind, assetId }),
      });
      if (!res.ok) {
        echec(await readError(res));
        return;
      }

      const body = (await res.json()) as { id?: string; attached?: boolean; attachError?: string };
      if (!body?.id) {
        echec("The server did not return a template id.");
        return;
      }

      if (body.attached !== true) {
        echec(
          `The template was created but could not be set for this email${
            body.attachError ? ` (${body.attachError})` : ""
          }. It is now in the list — pick it above to finish.`,
        );
        return;
      }

      /*
       * ⛔ ON INVALIDE AVANT DE PARTIR. `router.push` seul laisse l'entrée de cette page
       * (/automations/lifecycle depuis le 24/09, /templates avant) dans le cache
       * client du routeur, telle qu'elle était AVANT la création — et le retour arrière du
       * navigateur la restaure toujours depuis ce cache. La ligne réafficherait « Built-in email »
       * et son bouton « Customise » : le travail semblerait perdu, et un second clic déplacerait le
       * rattachement sur un jumeau vide. `router.refresh()` invalide cette entrée, donc le retour
       * arrière relit la base.
       */
      router.refresh();
      // ⚠️ Ni `busy` ni le verrou ne sont relâchés : la navigation est la fin du geste. Rendre
      // l'écran au repos ici le laisserait cliquable pendant le temps du chargement du builder.
      router.push(`/builder/${body.id}`);
    } catch (err) {
      echec(err instanceof Error ? err.message : "Network error");
    }
  };

  /*
   * ⛔ ON ANNONCE LA PERTE DE LANGUE AVANT LE GESTE, PAS APRÈS. Les quatre e-mails intégrés sont
   * traduits (six langues, repli anglais) et suivent la langue de l'ÉDITION qui envoie ; un modèle
   * du builder est un texte figé, et le rattachement porte sur (marque, kind) — donc sur toutes les
   * éditions de la marque. Sur une marque mono-langue — le cas de toutes les marques à ce jour, une
   * seule `asset_edition` chacune — cette phrase n'apprendrait rien et encombrerait quatre lignes
   * pour rien : on la tait. `languages` vide veut dire « lecture non aboutie » : on se tait aussi,
   * plutôt que d'affirmer une mono-langue qu'on n'a pas lue.
   */
  const multilingue = languages.length > 1;

  return (
    <Card className="mb-5">
      <CardHead
        title={head?.title ?? "Lifecycle emails"}
        sub={
          head?.sub ??
          "Emails the platform sends on its own when their trigger fires. Each one goes out with the built-in copy unless you point it at one of your templates — and you can import your brand header, footer and legal footer into those templates like any other."
        }
      />

      {/* ⛔ AUCUNE RÉASSURANCE SUR CE QU'ON NE PEUT PAS LIRE. La phrase disait « Nothing is broken on
          the sending side » : `known` retombe à faux notamment quand la base ne répond pas, or le
          worker lit la MÊME base. On s'en tient donc à ce que l'écran sait — et on se tait quand la
          page a déjà annoncé l'incident (`brandKnown`). */}
      {!known && brandKnown && (
        <div className="mb-2 flex items-start gap-2.5 rounded-[10px] border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[12.5px] text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            These settings could not be read, so what you see below is not their state. Try again in a
            moment.
          </span>
        </div>
      )}

      {multilingue && (
        <div className="mb-2 flex items-start gap-2.5 rounded-[10px] border border-border bg-accent/40 px-3.5 py-2.5 text-[12.5px] leading-snug text-muted-foreground">
          <Languages className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {/* ⛔ ON DIT CE QUE LE WORKER FAIT. Le rendu prend `normalizeLocale(ctx.language)`, et
                `outbox_context` tire cette langue de l'ÉDITION de l'abonnement, jamais de
                `subscription.language` : promettre « each reader’s language » attribuait au repli
                intégré une adaptation par personne qu'il ne fait pas — et sur la seule marque où la
                nuance compte, celle qui a plusieurs éditions. */}
            The built-in emails follow the language of the edition a reader is on — this brand sends
            in {languages.join(", ")}. A template is one fixed text and it applies to the whole
            brand, so a single language reaches all of them; “Customise” writes it in {languages[0]}.
          </span>
        </div>
      )}

      <div>
        {slots.map((slot) => {
          const label = LIFECYCLE_LABELS[slot.kind];
          // Le voyant reste allumé jusqu'à l'arrivée du rendu serveur, pas jusqu'au 200.
          const enCours = busy === slot.kind;
          const erreur = error?.kind === slot.kind ? error.message : null;
          // ⛔ ON NE VERROUILLE QUE L'IGNORANCE. Une fente occupée par le modèle de quelqu'un d'autre
          // reste réglable : poser le sien est un upsert sur (asset_id, kind) que la fiche d'un
          // modèle autorise déjà. La bloquer ici seulement ferait dire le contraire à deux écrans.
          const choix = lifecycleSlotChoices(slot, templates, known);

          return (
            <div key={slot.kind} className="border-b border-border py-2.5 last:border-0">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <div className="min-w-[210px] flex-1">
                  <div className="text-[12.5px] font-medium">{label.titre}</div>
                  <div className="text-[11.5px] leading-snug text-muted-foreground">{label.quand}</div>
                  {label.pasEnvoye && (
                    <div className="mt-0.5 text-[11.5px] font-medium leading-snug text-amber-700">{label.pasEnvoye}</div>
                  )}
                </div>

                <StatusPill slot={slot} known={known} />

                <div className="flex items-center gap-2">
                  <select
                    aria-label={`Template used for the ${label.titre} email`}
                    title={
                      slot.state === "bound-hidden"
                        ? "This email is served by a template that is not in your library. Picking one of yours replaces it."
                        : "Pick a template to send instead of the built-in email."
                    }
                    className={SELECT}
                    // ⚠️ Contrôlé par le serveur, pas par un état local : après un 2xx on relit la
                    // base. Un état local ferait persister à l'écran un choix que le serveur a refusé.
                    value={choix.value}
                    disabled={choix.locked || busy !== null || refreshing}
                    onChange={(e) => void apply(slot, e.target.value)}
                  >
                    {choix.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  {/* ⛔ « CUSTOMISE » N'APPARAÎT QUE LÀ OÙ IL Y A QUELQUE CHOSE À COMMENCER.
                      Sur une fente déjà servie par un modèle à soi, ce bouton en créerait un
                      SECOND et déplacerait le rattachement dessus : la personne croirait éditer
                      son e-mail et éditerait un jumeau vide de son travail. On lui propose donc
                      « Edit », qui ouvre le modèle qui part réellement. Une fente occupée par le
                      modèle d'autrui (`bound-hidden`) garde « Customise » : c'est justement le
                      moyen de reprendre la main. */}
                  {known &&
                    (slot.state === "bound" && slot.templateId ? (
                      // Une VRAIE ancre, pas un bouton qui navigue : elle se tabule, s'ouvre dans
                      // un nouvel onglet et affiche sa destination dans la barre d'état.
                      <Link
                        href={`/builder/${slot.templateId}`}
                        className={BOUTON_LIEN}
                        title="Open this template in the builder."
                        // ⚠️ « SET FOR », PAS « USED FOR ». L'état `bound` couvre aussi le modèle
                        // rattaché mais JAMAIS publié — celui que « Customise » produit à tous les
                        // coups — dont la pastille dit, elle, « Built-in email still goes out ».
                        // Dire « used for » à un lecteur d'écran lui ferait conclure que son modèle
                        // est en service, donc renoncer à le publier.
                        aria-label={`Open the template set for the ${label.titre} email`}
                      >
                        <PenLine className="h-[13px] w-[13px]" /> Edit
                      </Link>
                    ) : (
                      <Btn
                        variant="ghost"
                        className="px-2.5 py-1.5 text-[12.5px]"
                        onClick={() => void customise(slot.kind)}
                        disabled={busy !== null || refreshing}
                        /* ⛔ CE QUE CE BOUTON PROMET DOIT ÊTRE CE QU'IL FAIT, DANS LES DEUX ÉTATS.
                           Sur une fente déjà servie par le modèle de quelqu'un d'autre, le
                           rattachement est un upsert sur (asset_id, kind) : le brouillon neuf
                           REMPLACE l'autre modèle immédiatement, et comme il n'a aucune version
                           publiée, la vue du worker ne rend plus de shell — c'est l'e-mail intégré
                           qui part dès l'envoi suivant. « Nothing changes for readers » y serait le
                           contraire de la vérité. Sur `built-in`, la phrase reste exacte.
                           ⚠️ « COPY » NE PROMET PAS L'APPARENCE DE L'INTÉGRÉ : le document semé reprend
                           ses TEXTES, et les couleurs du dernier modèle publié de la marque (thème par
                           défaut du builder si elle n'en a aucun). */
                        title={
                          slot.state === "bound-hidden"
                            ? "This email is currently served by another template — customising replaces it now, and the built-in email goes out until you publish yours."
                            : "Create an editable draft with the same wording as the built-in email (in your brand’s colours, taken from its latest published template), set it for this email, and open it in the builder. Nothing changes for readers until you publish it."
                        }
                        aria-label={`Create an editable draft of the ${label.titre} email`}
                      >
                        <Wand2 className="h-[13px] w-[13px]" /> Customise
                      </Btn>
                    ))}
                  {enCours && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                </div>
              </div>

              {erreur && <p className="mt-1.5 text-[11.5px] leading-snug text-[#c0392b]">{erreur}</p>}
            </div>
          );
        })}
      </div>

      {/* ⛔ NE PLUS ENVOYER AILLEURS POUR UN GESTE QUI EST ICI. Cette phrase disait « create one
          first, then come back » — sous quatre boutons qui créent précisément ce modèle sur place,
          et déjà pré-rempli. Suivre l'ancienne consigne menait à créer un modèle de campagne vide,
          puis à prendre le 422 sur le jeton de confirmation manquant, que « Customise » existe
          précisément pour supprimer. */}
      {known && templates.length === 0 && (
        <p className="mt-2.5 text-[11.5px] leading-snug text-muted-foreground">
          No template of yours yet — “Customise” on any row above creates one from the built-in
          email, ready to edit.
        </p>
      )}

      {canSeedAllBrands && <SemerToutesLesMarques />}
    </Card>
  );
}

type LigneSemisVue = { assetSlug: string; kind: LifecycleKind; statut: string; message?: string };

const STATUT_SEMIS: Record<string, string> = {
  created: "Draft created and set",
  already_bound: "Already set — left untouched",
  taken_meanwhile: "Set by someone meanwhile — theirs kept",
  failed: "Failed",
};

/**
 * « Create editable versions for all brands » (décision d'Alix du 22/09/2026).
 *
 * ⛔ UNE CONFIRMATION, PUIS UN RAPPORT LIGNE À LIGNE. Le geste écrit dans TOUTES les marques : on dit
 * avant ce qu'il fera (et ce qu'il ne fera jamais : écraser un réglage), et après, pour chaque marque
 * et chaque e-mail, ce qu'il a fait. Un « Done » global cacherait l'échec d'une marque sous le succès
 * des autres.
 *
 * ⚠️ LES MODÈLES CRÉÉS SONT DES BROUILLONS : rien ne change pour les lecteurs avant qu'ils soient
 * publiés. La modale le dit, sinon on croirait les e-mails de toutes les marques déjà basculés.
 */
export function SemerToutesLesMarques() {
  const router = useRouter();
  const [ouverte, setOuverte] = useState(false);
  const [envoi, setEnvoi] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [lignes, setLignes] = useState<LigneSemisVue[] | null>(null);
  const enEcriture = useRef(false);

  const lancer = async () => {
    if (enEcriture.current) return;
    enEcriture.current = true;
    setEnvoi(true);
    setErreur(null);
    try {
      const res = await fetch("/api/builder/lifecycle-seed/all-brands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "all-brands" }),
      });
      if (!res.ok) {
        setErreur(await readError(res));
        return;
      }
      const body = (await res.json()) as { lignes?: LigneSemisVue[] };
      setLignes(body.lignes ?? []);
    } catch (err) {
      setErreur(err instanceof Error ? err.message : "Network error");
    } finally {
      // Toute issue relit la base : une réponse perdue n'est pas « rien n'a été écrit ».
      router.refresh();
      setEnvoi(false);
      enEcriture.current = false;
    }
  };

  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-[10px] border border-border bg-card/60 px-3.5 py-2.5">
      <span className="text-[11.5px] leading-snug text-muted-foreground">
        Admin: give every brand an editable template for each of these emails, in its own colours.
      </span>
      <Btn variant="ghost" className="px-2.5 py-1.5 text-[12.5px]" onClick={() => setOuverte(true)}>
        <Layers className="h-[13px] w-[13px]" /> Create editable versions for all brands
      </Btn>

      {ouverte && (
        <Modal
          title="Create editable versions for all brands"
          onClose={() => !envoi && setOuverte(false)}
          footer={
            lignes ? (
              <Btn onClick={() => setOuverte(false)}>Close</Btn>
            ) : (
              <>
                <Btn variant="ghost" onClick={() => setOuverte(false)} disabled={envoi}>
                  Cancel
                </Btn>
                <Btn onClick={() => void lancer()} disabled={envoi}>
                  {envoi ? "Creating…" : "Create drafts"}
                </Btn>
              </>
            )
          }
        >
          {!lignes ? (
            <div className="space-y-2 text-[12.5px] leading-relaxed">
              <p>
                For every brand, and for each of the four lifecycle emails that has no template yet,
                this creates a draft with the built-in wording, in the brand&apos;s language and
                colours, and sets it for that email.
              </p>
              <p>
                An email that already has a template is never touched — running this again only
                fills what is still empty.
              </p>
              <p className="text-muted-foreground">
                Nothing changes for readers yet: the drafts must be published, one by one, in the
                builder. Until then the built-in email keeps going out.
              </p>
              {erreur && <p className="text-[#c0392b]">{erreur}</p>}
            </div>
          ) : (
            <div className="max-h-[360px] overflow-auto text-[12px]">
              {lignes.length === 0 ? (
                <p className="text-muted-foreground">No brand found.</p>
              ) : (
                <table className="w-full">
                  <tbody>
                    {lignes.map((l) => (
                      <tr key={`${l.assetSlug}:${l.kind}`} className="border-b border-border last:border-0">
                        <td className="py-1.5 pr-2 font-medium">{l.assetSlug}</td>
                        <td className="py-1.5 pr-2">{LIFECYCLE_LABELS[l.kind]?.titre ?? l.kind}</td>
                        <td className={l.statut === "failed" ? "py-1.5 text-[#c0392b]" : "py-1.5 text-muted-foreground"}>
                          {STATUT_SEMIS[l.statut] ?? l.statut}
                          {l.message ? ` — ${l.message}` : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
