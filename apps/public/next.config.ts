import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  // Auto-heberge : outputFileTracingRoot doit viser la racine du monorepo,
  // sinon les workspaces @nf/* ne sont pas embarques dans la sortie.
  output: "standalone",
  outputFileTracingRoot: path.join(here, "..", ".."),
  turbopack: { root: path.join(here, "..", "..") },
  transpilePackages: ["@nf/config", "@nf/tokens"],
  // Le widget est embarqué en iframe sur des sites WordPress tiers : autoriser l'embed partout.
  async headers() {
    return [
      {
        source: "/embed/:path*",
        headers: [{ key: "Content-Security-Policy", value: "frame-ancestors *" }],
      },
    ];
  },
};

export default nextConfig;
