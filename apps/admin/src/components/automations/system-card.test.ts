/**
 * La carte « System » de /automations (24/09/2026, feature 3) — rendue avec des exemples, sans base.
 *
 * Ce qui est tenu :
 *  - les 15 lignes du tableau d'Alix, dans son ordre ;
 *  - un déclencheur sans automation propose « Set up » vers le formulaire PRÉ-RÉGLÉ sur lui ;
 *  - une automation s'affiche sous SON déclencheur ; une automation sans ligne s'affiche dans « Other » ;
 *  - un e-mail coupé dit « Off », un interrupteur non lu le DIT (jamais « On » par défaut) ;
 *  - la confirmation est « Always on », sans interrupteur ;
 *  - automations non lues ⇒ l'aveu, et aucun « Set up » (on ne propose pas un geste qui échouera) ;
 *  - (plan AUTO-EDIT, 25/09) chaque automation porte ses gestes, et un déclencheur qui en a déjà une
 *    propose « Add another », pré-réglé sur lui.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
// ⚠️ Les gestes d'une ligne sont des composants client qui appellent `useRouter` : hors de l'app Next,
// il lève (« expected app router to be mounted »). Le banc fournit un routeur inerte.
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { SYSTEM_ROWS, systemRowName } from "@/lib/automations";
import { SystemCard, type CustomRow, type LifecycleSwitches, type ListeLue } from "./views";

const TOUT_ON: LifecycleSwitches = { known: true, value: { welcome: true, unsubscribe_ack: true } };
const auto = (p: Partial<CustomRow>): CustomRow => ({
  id: "a1",
  name: "Win back, 60 days",
  trigger: "reengagement",
  status: "simulation",
  lastRunAt: null,
  sent7d: 0,
  simulated7d: 12,
  ...p,
});

const rien = () => undefined;
const ROUTEUR = { back: rien, forward: rien, refresh: rien, push: rien, replace: rien, prefetch: rien };

function rendre(automations: ListeLue<CustomRow[]>, lifecycle: LifecycleSwitches = TOUT_ON) {
  return renderToStaticMarkup(
    createElement(
      AppRouterContext.Provider,
      { value: ROUTEUR as never },
      createElement(SystemCard, { automations, lifecycle, brand: "Copper Kettle" }),
    ),
  );
}
/** Les lignes du corps du tableau, découpées sur `<tr`. */
const lignes = (html: string) => html.split("<tbody>")[1]!.split("</tbody>")[0]!.split("<tr").slice(1);
const echap = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#x27;");

describe("la carte System", () => {
  test("⛔ les 15 lignes, dans l'ordre du tableau", () => {
    const html = rendre({ state: "ok", value: [] });
    const ls = lignes(html);
    expect(ls).toHaveLength(15);
    SYSTEM_ROWS.forEach((r, i) => expect([i, ls[i]!.includes(echap(systemRowName(r)))]).toEqual([i, true]));
  });

  test("sans automation : chaque déclencheur du moteur propose « Set up » pré-réglé sur lui", () => {
    const html = rendre({ state: "ok", value: [] });
    for (const r of SYSTEM_ROWS) {
      if (r.type !== "engine") continue;
      expect([r.trigger, html.includes(`href="/automations/new?trigger=${r.trigger}"`)]).toEqual([r.trigger, true]);
    }
    expect(html).toContain('href="/automations/new"');
  });

  test("une automation s'affiche sous SON déclencheur, qui propose « Add another » au lieu de « Set up »", () => {
    const html = rendre({ state: "ok", value: [auto({})] });
    const ligne7 = lignes(html)[SYSTEM_ROWS.findIndex((r) => r.sheetRow === 7)]!;
    expect(ligne7).toContain('href="/automations/a1"');
    expect(ligne7).toContain("Win back, 60 days");
    expect(ligne7).not.toContain("Set up");
    // ⭐ 25/09 (plan AUTO-EDIT) : on peut en créer une autre sur le même déclencheur, pré-réglée sur lui.
    expect(ligne7).toContain('href="/automations/new?trigger=reengagement"');
    expect(ligne7).toContain("Add another");
    expect(html.split('href="/automations/a1"').length - 1).toBe(2); // bureau + téléphone, même ligne
  });

  test("⭐ chaque automation porte ses gestes, selon son statut (plan AUTO-EDIT)", () => {
    const html = rendre({
      state: "ok",
      value: [
        auto({ id: "d1", name: "Brouillon", status: "draft" }),
        auto({ id: "l1", name: "En ligne", status: "live", trigger: "welcome_back" }),
      ],
    });
    const ligne7 = lignes(html)[SYSTEM_ROWS.findIndex((r) => r.sheetRow === 7)]!;
    const ligne6 = lignes(html)[SYSTEM_ROWS.findIndex((r) => r.sheetRow === 6)]!;
    // Brouillon : Edit = lien vers sa page (le formulaire), Duplicate, Delete.
    expect(ligne7).toContain("> Edit<");
    expect(ligne7).toContain("> Duplicate<");
    expect(ligne7).toContain("> Delete<");
    // Live : Edit (qui l'arrêtera, confirmation), Duplicate, ⛔ jamais Delete.
    expect(ligne6).toContain("> Edit<");
    expect(ligne6).toContain("> Duplicate<");
    expect(ligne6).not.toContain("> Delete<");
  });

  test("⛔ une automation sans ligne n'est pas cachée : ligne « Other »", () => {
    const html = rendre({ state: "ok", value: [auto({ id: "x9", trigger: "soft_bounce_rule", name: "Orpheline" })] });
    const ls = lignes(html);
    expect(ls).toHaveLength(16);
    expect(ls[15]).toContain("Other");
    expect(ls[15]).toContain('href="/automations/x9"');
  });

  test("e-mails : Welcome coupé ⇒ Off ; accusé actif ⇒ On ; confirmation ⇒ Always on ; chacun a son Edit", () => {
    const html = rendre({ state: "ok", value: [] }, { known: true, value: { welcome: false, unsubscribe_ack: true } });
    const [l1, , l3, , l5] = lignes(html);
    expect(l1).toContain("Always on");
    expect(l1).toContain('href="/automations/system/confirmation"');
    expect(l3).toContain(">Off<");
    expect(l3).toContain('href="/automations/system/welcome"');
    expect(l5).toContain(">On<");
    expect(l5).toContain('href="/automations/system/unsubscribe_ack"');
  });

  test("⛔ interrupteurs non lus ⇒ l'aveu, jamais « On » ni « Off »", () => {
    const html = rendre({ state: "ok", value: [] }, { known: false, value: { welcome: true, unsubscribe_ack: true } });
    const l3 = lignes(html)[2]!;
    expect(l3).toContain("could not be read");
    expect(l3).not.toContain(">On<");
    expect(l3).not.toContain(">Off<");
  });

  test("⛔ automations non lues ⇒ l'aveu, aucun « Set up », aucun « New automation »", () => {
    for (const lecture of [{ state: "no-db" }, { state: "error", message: "boom" }, { state: "not-installed", detail: "" }] as const) {
      const html = rendre(lecture);
      expect([lecture.state, html.includes("/automations/new")]).toEqual([lecture.state, false]);
      expect(lignes(html)).toHaveLength(15);
    }
  });
});
