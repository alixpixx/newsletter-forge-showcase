# @nf/render

Le **contrat** du builder d'emails : un document JSON (`EmailDoc v2`), un compilateur qui en fait
du HTML email, et un hydrateur sans dépendance qui remplit les tokens au moment de l'envoi.

Trois consommateurs, une seule source de vérité : le **builder**, le **worker** et le
**générateur IA** parlent tous `EmailDoc`.

## Les deux points d'entrée (ne jamais les confondre)

| Import | Poids | Qui l'utilise | Ce qu'il fait |
|---|---|---|---|
| `@nf/render` | schéma + Zod | tout le monde | le contrat : `EmailDoc`, types, `BLOCK_TYPES`, `MERGE_VARS` |
| `@nf/render/compile` | **lourd (MJML)** | `apps/admin` uniquement | `await compileDoc(doc)` → `{ html, text, warnings, sizeBytes }` |
| `@nf/render/hydrate` | **zéro dépendance** | `apps/worker` | `hydrate(htmlShell, vars)` → HTML personnalisé |

⛔ Le worker ne doit **jamais** importer `@nf/render/compile`. Aucun MJML dans le worker.

## Le cycle de vie

```
  builder / IA
      │  écrit un EmailDoc (jsonb template_version.doc)
      ▼
  PUBLICATION (admin)          compileDoc(doc)
      │                        → html_shell / text_shell FIGÉS, tokens {{…}} NON résolus
      ▼                        → warnings + sizeBytes + compilerVersion
  template_version (DB)
      │
      ▼
  ENVOI (worker)               hydrate(html_shell, vars)  ·  hydrateText(text_shell, vars)
                               → 1 HTML par destinataire, sans recompiler quoi que ce soit
```

Le rendu a lieu **à la publication, pas à l'envoi**. C'est ce qui rend l'envoi déterministe : le
HTML expédié est exactement celui qui a été prévisualisé et approuvé.

## Le document

```
EmailDoc { schema: 2, meta, theme, rows[] }
  Row    { id, layout, style?, columns[] }      layout ∈ 1 | 1-1 | 1-1-1 | 1-1-1-1 | 2-1 | 1-2 | 3-1 | 1-3
    Column { id, widthPct?, style?, blocks[] }
      Block  = union discriminée sur `type`
```

`layout` est une **énumération fermée** : les ghost tables Outlook exigent une arithmétique de
largeurs exacte, un ratio libre la casse en silence. Les largeurs réelles sont **toujours** dérivées
de `LAYOUT_WEIGHTS`, jamais de `widthPct` (qui n'est qu'une aide d'affichage).

Blocs implémentés (`BLOCK_TYPES`) : `text`, `image`, `button`, `divider`, `spacer`, `html`,
`social`, `menu`, `footer_legal`.

### Cascade de styles

`theme → row → column → block`, **résolue avant génération** (Outlook n'hérite d'aucun style de
façon fiable). Deux familles :

- **héritables** — typo, couleurs, alignement ;
- **propres à la boîte** — `padding`, `backgroundColor`, bordure, `hideOnMobile` : jamais héritées,
  sinon le padding d'une row s'ajouterait à celui de chacun de ses blocs.

### Contraintes email tenues par le compilateur

- `<head>` : `color-scheme: light dark`, viewport, `x-apple-disable-message-reformatting`, preheader
  masqué (`mj-preview`).
- **Jamais de `#000000` ni `#ffffff` purs** — déclencheurs d'inversion dark mode ; le schéma les
  refuse et le HTML final est repassé au filtre (`#0E0E0E` / fond du thème).
- `<style>` réservé aux media queries, au dark mode et au `:hover` (Gmail jette le bloc entier
  au-delà de 16 Ko). Tout le reste est inline.
- `keepComments: true` est **non négociable** : les marqueurs `<!--nf:if-->` sont des commentaires.

## Tokens et conditions (`hydrate`)

```html
Bonjour {{first_name}},                     <!-- échappé, fallback registre : « there » -->
Bonjour {{first_name|champion}},            <!-- fallback inline -->
<!--nf:if is_premium--> … <!--nf:endif-->   <!-- imbrication supportée -->
<!--nf:if !first_name--> … <!--nf:endif-->  <!-- négation -->
```

- Toute valeur est **échappée** (`<script>` dans un prénom ne s'injecte pas). Seuls les champs
  `kind: "raw"` y échappent : uniquement du HTML système (`legal_footer_html`).
- Les conditions sont résolues **avant** la substitution — une valeur d'abonné ne peut donc pas
  forger un `<!--nf:endif-->`.
- Champ hors registre : token **retiré**, condition **fail-closed** (bloc masqué).
  `hydrateReport()` les remonte pour le diagnostic.
- Le registre `MERGE_VARS` vit dans `src/hydrate/index.ts` (fichier sans aucun import) et est
  ré-exporté par `schema.ts` — jamais l'inverse, sinon Zod remonterait dans le worker.

## Le footer légal

`footer_legal` est **verrouillé, sans props éditables** (un footer éditable = risque LGPD/GDPR).
Il compile vers le token `{{legal_footer_html}}` ; c'est le worker qui y injecte le footer conforme
de `@nf/email` avec les liens unsub/prefs **signés du destinataire**. Un document sans bloc
`footer_legal` produit un warning : l'envoi serait vetoé.

## Ajouter un type de bloc

1. **`src/schema.ts`** — écrire le schéma Zod (`.strict()`, `id` + `style?` via `blockBase`),
   l'ajouter à `z.discriminatedUnion("type", […])`, exporter le type inféré, **et ajouter le nom à
   `BLOCK_TYPES`** (c'est ce que lisent la palette du builder et le prompt IA).
2. **`src/compile/mjml.ts`** — ajouter le `case` dans `blockNode()`. Le `switch` est exhaustif :
   si vous l'oubliez, TypeScript refuse de compiler.
3. **`src/compile/text.ts`** — ajouter le `case` dans `blockToText()`, même exhaustivité.
4. **`src/compile/index.ts`** — si le bloc porte des liens, les déclarer dans `hrefsOf()` pour
   qu'ils passent les contrôles qualité ; ajouter les warnings spécifiques dans `collectWarnings()`.
5. Bump `COMPILER_VERSION` si le HTML produit change pour des documents existants.

## ⚠️ Pièges MJML 5 (vérifiés sur mjml@5.4.0, pas des suppositions)

1. **`mjml2html` est ASYNCHRONE.** En v4 il était synchrone ; en v5 il renvoie une `Promise`.
   `renderMjml()` et `compileDoc()` sont donc `async` — la route de publication, l'aperçu et le
   générateur IA doivent `await`. Sans `await`, on lit `undefined` sur `.html`/`.errors`.
2. **Les attributs booléens de l'AST JSON sont validés par TYPE.** `"fluid-on-mobile": "true"`
   (chaîne) est rejeté avec `invalid value: true for type Boolean` ; seul le booléen natif `true`
   passe. D'où `MjmlAttrValue = string | number | boolean` sur `MjmlNode.attributes`.
3. **MJML pose déjà** viewport, charset, `X-UA-Compatible` et le bloc mso `<o:PixelsPerInch>96`.
   On ne les redéclare pas : doublons dans le `<head>`, et dupliquer le bloc mso perturbe Word.

## À faire au moment de l'installation

`mjml@^5.4.0` est **déclaré mais pas installé** (installation groupée à la fin de la vague).
`src/types/mjml.d.ts` fournit en attendant la déclaration ambiante de `mjml2html(objetJSON)`.
Si le paquet installé finit par exposer ses propres types pour l'API JSON, supprimer ce fichier.

Le package a été validé hors dépôt (sandbox scratch) avec `zod@4.4.3` + `mjml@5.4.0` :
`tsc --noEmit` propre en strict + `noUncheckedIndexedAccess`, 21 tests `hydrate` et 55 tests
`compile` au vert, zéro erreur de validation MJML.
