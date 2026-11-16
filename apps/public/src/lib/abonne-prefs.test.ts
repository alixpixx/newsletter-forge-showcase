import { describe, expect, test } from "bun:test";
import { resoudreAbonnePrefs } from "./abonne-prefs";
import { fausseBasePostgrest, type Ligne } from "./faux-postgrest";

const SUBR = "22222222-2222-4222-8222-222222222222";
const verifier = (t: string | undefined | null) => (t === "ok" ? SUBR : null);
const resoudre = (ligne: Ligne | null, token = "ok") =>
  resoudreAbonnePrefs(fausseBasePostgrest({ subscriber: ligne ? [ligne] : [] }).db as never, token, verifier, "email");

describe("resoudreAbonnePrefs — le jeton d'un abonné effacé est mort", () => {
  test("abonné vivant (`deleted_at` lu à null) ⇒ ok", async () => {
    const r = await resoudre({ id: SUBR, email: "x@example.invalid", deleted_at: null });
    expect(r.etat).toBe("ok");
  });

  test("⛔ abonné effacé ⇒ « invalide », exactement comme un jeton faux", async () => {
    expect(await resoudre({ id: SUBR, email: `erased+${SUBR}@deleted.invalid`, deleted_at: "2026-09-20T10:00:00Z" })).toEqual(
      await resoudre(null, "faux"),
    );
  });

  /** MUTATION QUI DOIT LE TUER : `!= null` à la place de `!== null` (absent vaudrait vivant). */
  test("⛔ `deleted_at` absent ou illisible ⇒ jeton mort (dans le doute, on n'ouvre pas)", async () => {
    expect((await resoudre({ id: SUBR, email: "x@example.invalid" })).etat).toBe("invalide");
  });

  test("jeton bien signé sans ligne ⇒ « inconnu » (inchangé : 404 à la route)", async () => {
    expect((await resoudre(null)).etat).toBe("inconnu");
  });
});
