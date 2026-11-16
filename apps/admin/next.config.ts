import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  // Auto-heberge (image Docker) : l'image n'embarque que le serveur.
  // outputFileTracingRoot doit pointer la racine du monorepo, sinon les
  // workspaces @nf/* ne sont pas embarques dans la sortie standalone.
  output: "standalone",
  outputFileTracingRoot: path.join(here, "..", ".."),
  // Épingle la racine du monorepo (sinon Next peut inférer un dossier parent qui porte un autre lockfile).
  turbopack: { root: path.join(here, "..", "..") },
  // Les packages TS partagés sont transpilés par Next (pas de build séparé).
  // @nf/render porte le schéma EmailDoc + le compilateur MJML (serveur uniquement).
  transpilePackages: ["@nf/config", "@nf/render"],
  serverExternalPackages: ["mjml"],
};

export default nextConfig;
