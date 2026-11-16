/**
 * Lecture de CSV — le fichier qu'un humain dépose pour importer des contacts.
 *
 * Le pendant de `csv.ts`, qui n'écrit que. Lire est plus dangereux qu'écrire : à l'écriture on
 * connaît la donnée, à la lecture on reçoit ce qu'un tableur inconnu a bien voulu produire.
 *
 * Quatre pièges vivent ici, et aucun ne lève d'erreur — chacun rend un import « réussi » qui a
 * perdu ou déformé des lignes :
 *
 *  1. LE SÉPARATEUR N'EST PAS TOUJOURS LA VIRGULE. Excel en français, en allemand, en espagnol
 *     exporte avec des POINTS-VIRGULES. Lire un tel fichier en supposant la virgule rend UNE
 *     colonne par ligne, dont le contenu est la ligne entière : aucune colonne « email » n'est
 *     trouvée, et l'import annonce tranquillement zéro contact sur un fichier de mille.
 *
 *  2. LE BOM COLLE AU PREMIER EN-TÊTE. Un fichier UTF-8 produit par Excel commence par U+FEFF.
 *     Le premier en-tête n'est alors pas `email` mais `﻿email`, qui n'est égal à rien. La
 *     colonne des adresses est introuvable — dans un fichier où elle est pourtant la première.
 *
 *  3. UN CHAMP CITÉ PEUT CONTENIR UN SAUT DE LIGNE. On ne peut donc PAS découper le texte en
 *     lignes puis chaque ligne en champs : il faut un seul balayage, caractère par caractère, qui
 *     sache s'il est à l'intérieur de guillemets. Découper d'abord casse en silence toute ligne
 *     portant une adresse postale ou une note sur deux lignes.
 *
 *  4. LA MÊME ADRESSE DEUX FOIS DANS LE FICHIER PART DEUX FOIS. `docs/INGEST-API.md` §7 : rejouer
 *     l'appel pour un contact `pending` « remet à jour la souscription ET émet un nouveau jeton »
 *     — donc un deuxième e-mail de confirmation. Un fichier de 500 lignes contenant 40 doublons
 *     enverrait 40 e-mails de trop, à des gens qui n'ont rien demandé deux fois. Le dédoublonnage
 *     se fait ICI, avant le premier appel, et il se DIT (rien n'est écarté en silence).
 */

/** Les séparateurs qu'un tableur peut avoir produit, par ordre de fréquence. */
export const SEPARATEURS = [",", ";", "\t"] as const;
export type Separateur = (typeof SEPARATEURS)[number];

/**
 * ⛔ LA MÊME EXPRESSION QUE LA ROUTE D'INSCRIPTION, mot pour mot.
 *
 * Elle est volontairement laxiste. La tentation est d'être plus strict ici « pour rendre un
 * meilleur message » : ce serait refuser localement des adresses que le serveur accepte, donc
 * perdre des contacts que le formulaire public, lui, aurait pris. Plus laxiste serait l'erreur
 * inverse : envoyer pour se faire répondre 422, un aller-retour réseau par ligne fautive.
 * Les deux doivent dire la même chose ; si la route change, celle-ci change avec elle.
 */
export const EMAIL_VALIDE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Les en-têtes sous lesquels une colonne d'adresses peut se présenter. */
export const ENTETES_EMAIL = [
  "email",
  "e-mail",
  "mail",
  "adresse",
  "adresse e-mail",
  "address",
  "email address",
  "correo",
  "correo electronico",
  "e-mail address",
];

/** Les en-têtes sous lesquels un prénom peut se présenter. */
export const ENTETES_PRENOM = [
  "first_name",
  "firstname",
  "first name",
  "prenom",
  "prénom",
  "name",
  "nom",
  "nombre",
  "given name",
];

/** Un contact retenu, avec la ligne d'où il vient — c'est elle qu'on montrera en cas de refus. */
export type ContactLu = {
  ligne: number;
  email: string;
  prenom: string;
};

/** Une ligne écartée, et pourquoi. Jamais de rejet muet. */
export type RefusLu = {
  ligne: number;
  valeur: string;
  motif: "email-invalide" | "email-absent" | "doublon-dans-le-fichier";
};

/**
 * Retire la marque d'octets de tête, si elle est là.
 *
 * ⛔ AVANT TOUT LE RESTE. Retirée plus tard, elle a déjà servi à comparer un en-tête.
 */
export function sansBom(texte: string): string {
  return texte.charCodeAt(0) === 0xfeff ? texte.slice(1) : texte;
}

/**
 * Le séparateur le plus probable, déduit de la PREMIÈRE ligne seulement.
 *
 * On compte hors guillemets : un point-virgule à l'intérieur d'un libellé cité ne dit rien du
 * format. À égalité, la virgule gagne — c'est la norme, et un fichier d'une seule colonne n'a de
 * toute façon aucun séparateur à trouver.
 */
export function separateurProbable(texte: string): Separateur {
  const premiere = sansBom(texte).split(/\r\n|\n|\r/, 1)[0] ?? "";
  let meilleur: Separateur = ",";
  let record = 0;

  for (const sep of SEPARATEURS) {
    let compte = 0;
    let dansGuillemets = false;
    for (const c of premiere) {
      if (c === '"') dansGuillemets = !dansGuillemets;
      else if (c === sep && !dansGuillemets) compte += 1;
    }
    if (compte > record) {
      record = compte;
      meilleur = sep;
    }
  }
  return meilleur;
}

/**
 * Le balayage RFC 4180 : un seul passage, qui sait s'il est dans un champ cité.
 *
 * Rend les enregistrements ET le numéro de ligne PHYSIQUE où chacun commence — un enregistrement
 * portant un saut de ligne cité couvre plusieurs lignes du fichier, et c'est la première que
 * l'humain verra en ouvrant son tableur.
 */
export function lireCsv(texte: string, separateur?: Separateur): { enregistrements: string[][]; debuts: number[] } {
  const sep = separateur ?? separateurProbable(texte);
  const src = sansBom(texte);

  const enregistrements: string[][] = [];
  const debuts: number[] = [];

  let champs: string[] = [];
  let champ = "";
  let dansGuillemets = false;
  let ligne = 1;
  let debutCourant = 1;
  let commence = false;

  const finDeChamp = () => {
    champs.push(champ);
    champ = "";
  };

  const finDEnregistrement = () => {
    finDeChamp();
    // Une ligne vide n'est pas un enregistrement : c'est le saut final du fichier, ou une
    // respiration au milieu. La compter rendrait une ligne fantôme « email absent ».
    if (!(champs.length === 1 && champs[0].trim() === "")) {
      enregistrements.push(champs);
      debuts.push(debutCourant);
    }
    champs = [];
    commence = false;
  };

  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];

    if (!commence) {
      debutCourant = ligne;
      commence = true;
    }

    if (dansGuillemets) {
      if (c === '"') {
        // Deux guillemets d'affilée = un guillemet littéral, et on reste dedans.
        if (src[i + 1] === '"') {
          champ += '"';
          i += 1;
        } else {
          dansGuillemets = false;
        }
      } else {
        if (c === "\n") ligne += 1;
        champ += c;
      }
      continue;
    }

    if (c === '"') {
      dansGuillemets = true;
    } else if (c === sep) {
      finDeChamp();
    } else if (c === "\r") {
      // CRLF ou CR seul : on traite au \r et on avale le \n qui suit s'il est là.
      if (src[i + 1] === "\n") i += 1;
      ligne += 1;
      finDEnregistrement();
    } else if (c === "\n") {
      ligne += 1;
      finDEnregistrement();
    } else {
      champ += c;
    }
  }

  // Le dernier enregistrement n'a pas de saut de ligne derrière lui si le fichier n'en a pas.
  if (commence || champ !== "" || champs.length > 0) finDEnregistrement();

  return { enregistrements, debuts };
}

/** Normalise un en-tête pour la comparaison : minuscules, sans accents, sans bordures. */
export function normaliserEntete(brut: string): string {
  return brut
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[_\s]+/g, " ");
}

/**
 * L'indice de la première colonne dont l'en-tête figure parmi les candidats.
 *
 * Rend -1 si aucune. ⛔ Ne devine pas « la première colonne » en dernier recours : un fichier dont
 * la première colonne est un identifiant interne importerait alors des identifiants comme adresses.
 */
export function trouverColonne(entetes: string[], candidats: string[]): number {
  const voulus = candidats.map(normaliserEntete);
  for (let i = 0; i < entetes.length; i += 1) {
    if (voulus.includes(normaliserEntete(entetes[i] ?? ""))) return i;
  }
  return -1;
}

export type LectureContacts = {
  entetes: string[];
  separateur: Separateur;
  colonneEmail: number;
  colonnePrenom: number;
  contacts: ContactLu[];
  refus: RefusLu[];
};

/**
 * Ce que le fichier contient vraiment : les contacts retenus, et TOUT ce qui a été écarté.
 *
 * La première ligne est traitée comme des en-têtes. Si aucune colonne d'adresses n'est reconnue,
 * `colonneEmail` vaut -1 et la liste des contacts est vide : l'appelant doit le dire à l'écran
 * plutôt que d'annoncer « 0 contact importé », qui laisserait croire le fichier vide.
 *
 * ⛔ Le dédoublonnage est fait ici, sur l'adresse normalisée en minuscules — exactement comme la
 * route, qui fait `email.toLowerCase()` avant de chercher en base. Dédoublonner sur la casse brute
 * laisserait passer `Ana@x.com` et `ana@x.com` comme deux contacts, donc deux e-mails.
 */
export function contactsDuCsv(texte: string): LectureContacts {
  const separateur = separateurProbable(texte);
  const { enregistrements, debuts } = lireCsv(texte, separateur);

  if (enregistrements.length === 0) {
    return {
      entetes: [],
      separateur,
      colonneEmail: -1,
      colonnePrenom: -1,
      contacts: [],
      refus: [],
    };
  }

  const entetes = enregistrements[0].map((e) => e.trim());
  const colonneEmail = trouverColonne(entetes, ENTETES_EMAIL);
  const colonnePrenom = trouverColonne(entetes, ENTETES_PRENOM);

  const contacts: ContactLu[] = [];
  const refus: RefusLu[] = [];
  const vus = new Set<string>();

  if (colonneEmail === -1) {
    return { entetes, separateur, colonneEmail, colonnePrenom, contacts, refus };
  }

  for (let i = 1; i < enregistrements.length; i += 1) {
    const champs = enregistrements[i];
    const ligne = debuts[i] ?? i + 1;
    const brut = (champs[colonneEmail] ?? "").trim();

    if (brut === "") {
      refus.push({ ligne, valeur: "", motif: "email-absent" });
      continue;
    }

    const email = brut.toLowerCase();
    if (!EMAIL_VALIDE.test(email)) {
      refus.push({ ligne, valeur: brut, motif: "email-invalide" });
      continue;
    }
    if (vus.has(email)) {
      refus.push({ ligne, valeur: brut, motif: "doublon-dans-le-fichier" });
      continue;
    }

    vus.add(email);
    contacts.push({
      ligne,
      email,
      prenom: colonnePrenom === -1 ? "" : (champs[colonnePrenom] ?? "").trim(),
    });
  }

  return { entetes, separateur, colonneEmail, colonnePrenom, contacts, refus };
}
