import { describe, expect, test } from "bun:test";
import { etatLienConfirmation } from "./doi-link";

/**
 * ⛔ CE QUE CE BANC EXISTE POUR EMPÊCHER : qu'un e-mail de confirmation parte avec un lien mort.
 *
 * Le défaut réel, mesuré le 15/09/2026 : quatre personnes inscrites le 13/09 avec un jeton de 48 h,
 * quatre lignes `pending` dans la file à `attempts = 0`, et un worker en `dry-run` qui n'avait rien
 * tenté. Rien dans `apps/worker` ne nommait `doi_token` ; la seule garde vérifiait que l'URL
 * existait. La bascule aurait donc envoyé quatre liens périmés à de vraies personnes.
 *
 * Ce banc ne teste pas « la fonction renvoie ce qu'elle renvoie » : il fixe les quatre états et,
 * surtout, l'ORDRE dans lequel ils sont décidés — c'est lui qui décide ce qu'on écrira en base sur
 * la ligne écartée, donc ce qu'on racontera de la personne.
 */

const T0 = new Date("2026-09-15T10:00:00Z");

describe("etatLienConfirmation", () => {
  test("un jeton dont l'échéance est devant nous est le SEUL cas envoyable", () => {
    expect(etatLienConfirmation({ expires_at: "2026-09-29T13:38:00Z", confirmed_at: null }, T0)).toBe("valide");
  });

  test("un jeton échu ne part pas", () => {
    // Le cas des 4 leads Copper Kettle si personne n'avait prolongé : 48 h à partir du 13/09.
    expect(etatLienConfirmation({ expires_at: "2026-09-15T13:38:00Z", confirmed_at: null }, new Date("2026-09-15T13:38:01Z"))).toBe("expire");
  });

  test("l'instant EXACT de l'échéance est déjà trop tard", () => {
    // `>` et non `>=` : à la seconde pile, le lien ne vaut plus rien. Une borne inclusive ferait
    // partir un e-mail dont la page de destination, elle, refuserait le jeton — deux verdicts
    // opposés sur le même instant.
    expect(etatLienConfirmation({ expires_at: "2026-09-15T10:00:00Z", confirmed_at: null }, T0)).toBe("expire");
  });

  test("aucun jeton derrière une confirmation en file = anomalie, pas envoi", () => {
    expect(etatLienConfirmation(null, T0)).toBe("absent");
    expect(etatLienConfirmation(undefined, T0)).toBe("absent");
  });

  test("une personne qui a DÉJÀ confirmé ne reçoit pas une seconde demande", () => {
    expect(etatLienConfirmation({ expires_at: "2026-09-29T13:38:00Z", confirmed_at: "2026-09-14T09:00:00Z" }, T0)).toBe("deja_confirme");
  });

  test("⛔ confirmé PUIS périmé se raconte « déjà confirmé », jamais « expiré »", () => {
    // C'est le cas des 2 souscriptions Northwind Sports du 20/08 : confirmées le jour même, jetons échus
    // depuis. Les dire « expirées » écrirait en base que ces personnes ont laissé passer le délai —
    // l'inverse exact de ce qu'elles ont fait. La raison du skip est lue par un humain, plus tard.
    expect(etatLienConfirmation({ expires_at: "2026-08-22T18:04:40Z", confirmed_at: "2026-08-20T18:04:55Z" }, T0)).toBe("deja_confirme");
  });

  test("une échéance illisible ne vaut pas « encore valable »", () => {
    // Le doute ne se résout pas en envoyant : sans date exploitable, on ne peut rien affirmer sur
    // la vie du lien.
    expect(etatLienConfirmation({ expires_at: "pas-une-date", confirmed_at: null }, T0)).toBe("expire");
    expect(etatLienConfirmation({ expires_at: "", confirmed_at: null }, T0)).toBe("expire");
  });

  test("les quatre états sont DISTINCTS deux à deux", () => {
    // Un seul état fourre-tout (« pas envoyable ») ferait perdre la différence entre une anomalie
    // de données, le temps qui passe, et un geste déjà accompli.
    const etats = new Set([
      etatLienConfirmation(null, T0),
      etatLienConfirmation({ expires_at: "2026-09-29T00:00:00Z", confirmed_at: null }, T0),
      etatLienConfirmation({ expires_at: "2026-09-01T00:00:00Z", confirmed_at: null }, T0),
      etatLienConfirmation({ expires_at: "2026-09-29T00:00:00Z", confirmed_at: "2026-09-14T00:00:00Z" }, T0),
    ]);
    expect(etats.size).toBe(4);
  });
});
