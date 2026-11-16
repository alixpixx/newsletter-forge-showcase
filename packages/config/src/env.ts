/**
 * Schéma d'environnement (zod). Toutes les intégrations sont optionnelles tant
 * que les gates ne sont pas tranchées (voir docs/OPEN-DECISIONS.md) — l'admin
 * tourne sans elles. Appeler parseEnv() côté serveur uniquement.
 */
import { z } from "zod";

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // Base de données (projet Supabase dédié EU) — gate #1
  DATABASE_URL: z.string().url().optional(),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

  // Envoi (Mailgun) — gate #2. Clé + région globales ; le domaine d'envoi est par-asset
  // (asset_edition.sending_subdomain). Region EU par défaut (future-proof marques GDPR).
  MAILGUN_API_KEY: z.string().optional(),
  MAILGUN_REGION: z.enum(["us", "eu"]).default("eu"),

  // Auth SSO (IdP société) — gate #4
  AUTH_SECRET: z.string().optional(),
  AUTH_ISSUER: z.string().url().optional(),

  // Divers
  APP_URL: z.string().url().default("http://localhost:3000"),
  SLACK_WEBHOOK_URL: z.string().url().optional(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function parseEnv(src: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  cached = envSchema.parse(src);
  return cached;
}
