import { describe, expect, test } from "bun:test";
import {
  corpsInscription,
  inscrireUnContact,
  interpreterReponse,
  resumerInscriptions,
  MAX_IMPORT,
  MAX_PAR_APPEL,
  SOURCE_IMPORT,
  type LigneResultat,
} from "./ingestion";

/**
 * ⛔ CE BANC TIENT TROIS PROMESSES QUE PERSONNE NE PEUT VÉRIFIER À L'ŒIL :
 *
 *  1. aucune preuve de consentement n'est fabriquée — ni IP, ni agent, ni finalité ;
 *  2. la provenance vaut EXACTEMENT `import` — toute autre valeur est avalée en silence par la
 *     route et rangerait ces contacts sous la mauvaise provenance pour toujours ;
 *  3. un 200 n'est pas « abonné », et un échec ne déclenche JAMAIS un second appel (qui enverrait
 *     un deuxième e-mail de confirmation).
 */

const DEMANDE = {
  email: "Ana@Exemple.cl",
  prenom: "Ana",
  assetSlug: "copper-kettle",
  origine: "import" as const,
  fichier: "contacts.csv",
};

describe("corpsInscription — ce qu'on envoie, et surtout ce qu'on n'envoie pas", () => {
  test("l'adresse est normalisée en minuscules et détourée", () => {
    expect(corpsInscription({ ...DEMANDE, email: "  Ana@Exemple.cl " }).email).toBe(
      "ana@exemple.cl",
    );
  });

  test("la marque est envoyée sous forme de SLUG", () => {
    expect(corpsInscription(DEMANDE).asset).toBe("copper-kettle");
  });

  test("⛔ la provenance vaut exactement `import`", () => {
    // Toute autre valeur retombe sur `content_upgrade` SANS ERREUR (INGEST-API.md §2).
    expect(corpsInscription(DEMANDE).source).toBe("import");
    expect(SOURCE_IMPORT).toBe("import");
  });

  test("⛔ AUCUNE preuve de consentement fabriquée : ni IP, ni agent, ni page d'origine", () => {
    const corps = corpsInscription(DEMANDE);
    expect("ip_address" in corps).toBe(false);
    expect("user_agent" in corps).toBe(false);
    expect("source_url" in corps).toBe(false);
  });

  test("⛔ aucune finalité n'est cochée au nom de la personne", () => {
    expect("granted_purposes" in corpsInscription(DEMANDE)).toBe(false);
    expect("tracking_consent" in corpsInscription(DEMANDE)).toBe(false);
  });

  test("⛔ aucune édition n'est devinée : absente = édition primaire", () => {
    // Un slug inventé serait un 404, pas un repli silencieux.
    expect("edition" in corpsInscription(DEMANDE)).toBe(false);
  });

  test("`consent` vaut true — c'est la DEMANDE de consentement, pas le consentement", () => {
    expect(corpsInscription(DEMANDE).consent).toBe(true);
  });

  test("la traçabilité dit d'où ça vient", () => {
    expect(corpsInscription(DEMANDE).source_detail).toEqual({
      origin: "admin",
      mode: "import",
      file: "contacts.csv",
    });
    expect(corpsInscription({ ...DEMANDE, origine: "add", fichier: undefined }).source_detail).toEqual({
      origin: "admin",
      mode: "add",
    });
  });

  test("⛔ un prénom vide n'est PAS envoyé", () => {
    // La route écrase `first_name` dès que le champ est fourni : une chaîne vide effacerait le
    // prénom d'un contact déjà connu.
    expect("first_name" in corpsInscription({ ...DEMANDE, prenom: "   " })).toBe(false);
    expect("first_name" in corpsInscription({ ...DEMANDE, prenom: undefined })).toBe(false);
    expect(corpsInscription(DEMANDE).first_name).toBe("Ana");
  });
});

describe("interpreterReponse — un 200 veut dire trois choses", () => {
  test("créé et mis en file", () => {
    expect(interpreterReponse(200, { ok: true })).toEqual({ etat: "mis-en-file" });
  });

  test("déjà actif : aucune écriture, aucun e-mail", () => {
    expect(interpreterReponse(200, { ok: true, already: true })).toEqual({ etat: "deja-actif" });
  });

  test("⛔ une adresse supprimée rend AUSSI 200 ok:true — indistinguable, à dessein", () => {
    // La route ne confirme jamais à un tiers qu'une adresse est en liste de suppression.
    // On ne peut donc pas l'annoncer : l'écran dit « accepté », jamais « inscrit ».
    expect(interpreterReponse(200, { ok: true }).etat).toBe("mis-en-file");
  });

  test("le domaine réservé est remonté avec son code", () => {
    const r = interpreterReponse(422, { error: "reserved_domain" });
    expect(r.etat).toBe("refus");
    expect(r.code).toBe("reserved_domain");
    expect(r.message).toContain("Reserved test domain");
  });

  test("le secret refusé est un refus explicite, pas une panne", () => {
    const r = interpreterReponse(401, { error: "ingest-refuse" });
    expect(r.etat).toBe("refus");
    expect(r.message).toContain("shared secret");
  });

  test("chaque code du contrat a sa phrase", () => {
    for (const code of [
      "marque-inconnue",
      "edition-inconnue",
      "email-invalide",
      "consentement-requis",
      "finalites-inconnues",
      "optin-invalide",
      "db",
      "service-indisponible",
    ]) {
      const r = interpreterReponse(422, { error: code });
      expect(r.code).toBe(code);
      expect(r.message).toContain(" ");
    }
  });

  test("⛔ un code inconnu ne casse pas : il est rendu tel quel", () => {
    const r = interpreterReponse(418, { error: "quelque-chose-de-neuf" });
    expect(r.etat).toBe("refus");
    expect(r.code).toBe("quelque-chose-de-neuf");
    expect(r.message).toContain("quelque-chose-de-neuf");
  });

  test("un corps illisible garde quand même le statut", () => {
    expect(interpreterReponse(500, null).code).toBe("http-500");
  });

  test("⛔ un `ok:false` en 200 n'est pas un succès", () => {
    expect(interpreterReponse(200, { ok: false }).etat).toBe("refus");
  });
});

describe("resumerInscriptions — les totaux de l'écran", () => {
  const l = (etat: LigneResultat["etat"], ligne: number): LigneResultat => ({
    ligne,
    email: `x${ligne}@exemple.cl`,
    etat,
  });

  test("chaque état tombe dans sa colonne", () => {
    expect(
      resumerInscriptions([
        l("mis-en-file", 2),
        l("mis-en-file", 3),
        l("deja-actif", 4),
        l("refus", 5),
        l("injoignable", 6),
      ]),
    ).toEqual({ misEnFile: 2, dejaActifs: 1, refuses: 1, injoignables: 1, total: 5 });
  });

  test("⛔ les quatre colonnes font le total — rien ne disparaît", () => {
    const r = resumerInscriptions([l("mis-en-file", 2), l("refus", 3), l("injoignable", 4)]);
    expect(r.misEnFile + r.dejaActifs + r.refuses + r.injoignables).toBe(r.total);
  });

  test("une liste vide ne rend que des zéros", () => {
    expect(resumerInscriptions([])).toEqual({
      misEnFile: 0,
      dejaActifs: 0,
      refuses: 0,
      injoignables: 0,
      total: 0,
    });
  });
});

describe("les plafonds sont des limites de DÉGÂTS, pas de confort", () => {
  test("le plafond par appel tient dans un temps d'exécution", () => {
    // Chaque contact est un aller-retour HTTP : au-delà, la requête expire et l'écran perd le
    // résultat de lignes déjà écrites, qu'on rejouerait — donc un 2e e-mail.
    expect(MAX_PAR_APPEL).toBeLessThanOrEqual(50);
    expect(MAX_PAR_APPEL).toBeGreaterThan(0);
  });

  test("⛔ le plafond de fichier borne le nombre d'e-mails réels d'un seul geste", () => {
    expect(MAX_IMPORT).toBeLessThanOrEqual(1000);
    expect(MAX_IMPORT % MAX_PAR_APPEL).toBe(0);
  });
});

describe("inscrireUnContact — l'appel", () => {
  test("l'en-tête du secret et l'URL sont posés", async () => {
    let vuUrl = "";
    let vuSecret = "";
    let vuCorps: Record<string, unknown> = {};

    const faux = (async (url: string, init: RequestInit) => {
      vuUrl = String(url);
      vuSecret = String((init.headers as Record<string, string>)["x-nf-ingest-secret"]);
      vuCorps = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const r = await inscrireUnContact(DEMANDE, {
      base: "https://public.exemple",
      secret: "s3cr3t",
      fetchImpl: faux,
    });

    expect(r.etat).toBe("mis-en-file");
    expect(vuUrl).toBe("https://public.exemple/api/v1/signup");
    expect(vuSecret).toBe("s3cr3t");
    expect(vuCorps.source).toBe("import");
  });

  test("une barre oblique en trop dans la base ne double pas", async () => {
    let vuUrl = "";
    const faux = (async (url: string) => {
      vuUrl = String(url);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    await inscrireUnContact(DEMANDE, {
      base: "https://public.exemple///",
      secret: "s",
      fetchImpl: faux,
    });
    expect(vuUrl).toBe("https://public.exemple/api/v1/signup");
  });

  test("⛔ une panne réseau rend `injoignable` et N'APPELLE QU'UNE FOIS", async () => {
    let appels = 0;
    const faux = (async () => {
      appels += 1;
      throw new Error("ECONNREFUSED https://public.exemple/api/v1/signup");
    }) as unknown as typeof fetch;

    const r = await inscrireUnContact(DEMANDE, {
      base: "https://public.exemple",
      secret: "s3cr3t",
      fetchImpl: faux,
    });

    expect(appels).toBe(1);
    expect(r.etat).toBe("injoignable");
  });

  test("⛔ le message d'erreur réseau ne laisse fuir NI le secret NI l'URL", async () => {
    const faux = (async () => {
      throw new Error("connect failed to https://public.exemple with x-nf-ingest-secret: s3cr3t");
    }) as unknown as typeof fetch;

    const r = await inscrireUnContact(DEMANDE, {
      base: "https://public.exemple",
      secret: "s3cr3t",
      fetchImpl: faux,
    });

    expect(r.message).not.toContain("s3cr3t");
    expect(r.message).not.toContain("public.exemple");
  });

  test("un corps qui n'est pas du JSON ne fait pas tomber l'appel", async () => {
    const faux = (async () =>
      new Response("<html>502</html>", { status: 502 })) as unknown as typeof fetch;

    const r = await inscrireUnContact(DEMANDE, {
      base: "https://public.exemple",
      secret: "s",
      fetchImpl: faux,
    });
    expect(r.etat).toBe("refus");
    expect(r.code).toBe("http-502");
  });
});
