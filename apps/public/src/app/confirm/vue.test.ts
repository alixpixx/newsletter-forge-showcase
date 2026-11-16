/**
 * `/confirm` — un GET seul ne confirme RIEN (24/09/2026).
 *
 * Un antivirus de messagerie, un proxy ou l'aperçu d'un client mail ouvrent le lien avant la
 * personne. Jusqu'à ce jour, ce chargement suffisait : souscription `active`, preuve `optin_confirm`,
 * bienvenue en file. Ici on rend la page sur une souscription EN ATTENTE, avec un lien valide, et on
 * exige qu'elle y reste — sans une seule écriture.
 * MUTATION QUI DOIT LE TUER : remettre la confirmation dans le rendu (`vue.tsx`) ou dans `page.tsx`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sha256 } from "@nf/tokens";
import { fausseBasePostgrest, type Ligne } from "@/lib/faux-postgrest";
import { vueConfirmation } from "./vue";
import { ConfirmationBouton } from "./confirm-client";
import { Shell } from "./shell";

const SUB = "11111111-1111-4111-8111-111111111111";
const JETON = "jeton-brut-de-test";

function monter(sub: Ligne = {}, jeton: Ligne = {}) {
  return fausseBasePostgrest({
    subscription: [
      {
        id: SUB, status: "pending", asset_id: "a", consent_version_id: null, granted_purposes: { content: true },
        language: "pt-BR", source_detail: {}, subscriber: { email: "lectrice@example.invalid" }, asset: { name: "Northwind Sports" },
        ...sub,
      },
    ],
    doi_token: [
      { id: "tok-1", subscription_id: SUB, token_hash: sha256(JETON), expires_at: "2099-01-01T00:00:00Z", confirmed_at: null, ...jeton },
    ],
  });
}

async function rendre(f: ReturnType<typeof monter>, params: { token?: string; lang?: string }) {
  const el = (await vueConfirmation(params, { getDb: () => f.db as never })) as { type: unknown; props: Record<string, unknown> };
  return { type: el.type, props: el.props };
}

const ecritures = (f: ReturnType<typeof monter>) =>
  f.appels.filter((a) => a.cible.startsWith("rpc:") || a.methodes.some((m) => m.m === "update" || m.m === "insert" || m.m === "delete"));

describe("⛔ GET seul : la souscription reste `pending`", () => {
  for (const lang of [undefined, "en", "es"]) {
    test(`lien valide (lang=${lang ?? "aucune"}) ⇒ un BOUTON, et rien d'écrit`, async () => {
      const f = monter();
      const el = await rendre(f, { token: JETON, lang });
      expect(el.type).toBe(ConfirmationBouton);
      expect(f.tables.subscription[0]!.status).toBe("pending");
      expect(f.tables.doi_token[0]!.confirmed_at).toBeNull();
      expect(ecritures(f)).toHaveLength(0);
      expect(f.outbox()).toHaveLength(0);
      expect(f.tables.consent_event ?? []).toHaveLength(0);
    });
  }

  test("le bouton dit « Confirm my subscription » et porte le jeton, la marque dans le texte", async () => {
    const f = monter();
    const el = await rendre(f, { token: JETON, lang: "en" });
    const textes = el.props.textes as Record<string, string>;
    expect(textes.confirmCta).toBe("Confirm my subscription");
    expect(textes.confirmBody).toContain("Northwind Sports");
    expect(el.props.token).toBe(JETON);
    expect(el.props.lang).toBe("en");
  });

  test("sans `lang`, la langue de la souscription (pt-BR) est gardée, comme avant", async () => {
    const el = await rendre(monter(), { token: JETON });
    expect(el.props.lang).toBe("pt-BR");
    expect((el.props.textes as Record<string, string>).confirmCta).toBe("Confirmar minha inscrição");
  });

  test("deux chargements (antivirus PUIS personne) ⇒ toujours `pending`, toujours zéro écriture", async () => {
    const f = monter();
    await rendre(f, { token: JETON });
    await rendre(f, { token: JETON });
    expect(f.tables.subscription[0]!.status).toBe("pending");
    expect(ecritures(f)).toHaveLength(0);
  });
});

describe("les messages existants ne changent pas", () => {
  const titre = (el: { props: Record<string, unknown> }) => el.props.title;

  test("sans jeton ⇒ « Invalid link »", async () => {
    const el = await rendre(monter(), { lang: "en" });
    expect(el.type).toBe(Shell);
    expect(titre(el)).toBe("Invalid link");
    expect(el.props.children).toBe("This confirmation link is incomplete.");
  });

  test("jeton inconnu ⇒ « This link isn't recognized. »", async () => {
    const el = await rendre(monter(), { token: "jeton-invente", lang: "en" });
    expect(el.props.children).toBe("This link isn't recognized.");
  });

  test("jeton expiré ⇒ « Link expired », rien d'écrit", async () => {
    const f = monter({}, { expires_at: "2020-01-01T00:00:00Z" });
    const el = await rendre(f, { token: JETON, lang: "en" });
    expect(titre(el)).toBe("Link expired");
    expect(ecritures(f)).toHaveLength(0);
  });

  test("déjà confirmée ⇒ « Already confirmed ✅ »", async () => {
    const el = await rendre(monter({ status: "active" }), { token: JETON, lang: "en" });
    expect(titre(el)).toBe("Already confirmed ✅");
  });

  test("⛔ effacée ⇒ « Subscription not found. », jamais un bouton", async () => {
    const el = await rendre(monter({ status: "deleted" }), { token: JETON, lang: "en" });
    expect(el.type).toBe(Shell);
    expect(el.props.children).toBe("Subscription not found.");
  });
});

describe("⛔ `page.tsx` ne fait que brancher : aucune écriture possible au GET", () => {
  /*
   * La page n'est pas sous banc (Next n'y accepte que ses propres exports) : on lit son CODE,
   * commentaires retirés, et on y refuse toute trace d'écriture ou de mise en file.
   */
  test("aucun verbe d'écriture dans la page", () => {
    const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    for (const interdit of [".update(", ".insert(", ".rpc(", "queueEmail", "handleConfirmation", "consent_event", "email_outbox"]) {
      expect(source).not.toContain(interdit);
    }
    // Contre-épreuve : le banc lit bien le bon fichier — celui qui délègue au rendu sous banc.
    expect(source).toContain("vueConfirmation");
  });
});
