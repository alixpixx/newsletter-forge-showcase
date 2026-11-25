# newsletter-forge

A multi-brand newsletter platform: one back office to design, schedule and send newsletters for
several brands, each with its own sending domain, legal footer, consent texts and audience.

> **About this repository.** This is a public showcase of a production codebase. Brand names,
> domains, people and company details have been replaced with fictitious values (`*.example`,
> `example.com`, "Example Media Ltd"); deployment configuration and internal design notes are not
> included. Code comments and commit-level rationale are written in French.

## Live demo

A public demo runs on fictitious data:

| | |
|---|---|
| Back office | https://newsletter-forge-demo.178-156-233-96.sslip.io |
| Sign in | `demo@example.com` / `Showcase-Demo-2026` |
| Public pages (signup widget, preferences, unsubscribe) | https://newsletter-forge-public-demo.178-156-233-96.sslip.io |

The demo is safe to click around: no email is ever sent (the sending worker does not run), image
uploads are disabled, and the account password and user management are locked. Other changes are
allowed and the data may be reset at any time.

## What it does

- **Email builder** — drag-and-drop rows and blocks, saved rows, brand partials (header/footer),
  templates, merge tags, live preview. Documents are JSON (`EmailDoc`) compiled to email-safe HTML
  through MJML; the preview and the delivered email come from the same compiler.
- **Editions and campaigns** — recurring editions per brand and market, one-off campaigns,
  scheduled occurrences, freeze window with review before send, feed-driven content (WordPress
  sources), optional AI-written intros and subject lines.
- **Subscribers** — per-brand subscriptions, tags, segments (one rule compiler shared by the
  preview count and the actual audience), CSV import, server-to-server ingestion API.
- **Consent and compliance** — **double opt-in**, versioned consent texts, append-only consent
  events, granular purposes (marketing / tracking), per-country legal regimes (GDPR, LGPD,
  CAN-SPAM), one-click unsubscribe, preferences page, suppression list, retention purge, audit log.
- **Send queue** — a Postgres outbox (`email_outbox`) claimed with `FOR UPDATE SKIP LOCKED`,
  priorities (transactional before marketing), retries, stale-lock reclaim, idempotent enqueue.
- **Worker** — drains the outbox through Mailgun, materialises campaign occurrences, plans
  editions, recomputes engagement scores, runs lifecycle automations (welcome, sunset,
  re-engagement).
- **Analytics and deliverability** — sends, opens, clicks, bounces and complaints per campaign
  and brand (Mailgun webhooks), first-party engagement, optional page-view ranking of articles.

## Stack

| Layer | Choice |
|---|---|
| Runtime / package manager | [bun](https://bun.sh) workspaces |
| Web apps | Next.js 16 (App Router), React 19, Tailwind CSS 4, TypeScript |
| Database | Postgres via Supabase (`supabase-js`, dedicated `newsletter` schema, RLS default-deny) |
| Email | MJML compiler, Mailgun HTTP API, signed HMAC links |
| Validation | zod |
| Tests | `bun test` (unit, golden-output and SQL-contract tests) |

## Architecture

```
apps/
  admin/     Next.js back office: builder, campaigns, subscribers, analytics, settings, users
  public/    Next.js public surface: signup widget (/w.js), double opt-in confirmation,
             preferences, unsubscribe, Mailgun webhooks, ingestion API (/api/v1/*)
  worker/    bun process: outbox drain, fan-out, planner, engagement, lifecycle
packages/
  ai/          model client shared by admin and worker
  analytics/   article page-view lookups
  automations/ closed catalogue of automation triggers, guards and variables
  config/      brands, compliance regimes, consent, send policy, Message-Id, env helpers
  edition/     the single "freeze an edition" routine used by admin and worker
  email/       footers, transactional templates, i18n, dates
  render/      EmailDoc schema, merge tags and the MJML compiler
  segments/    targeting rules -> SQL, one implementation for preview and send
  tokens/      signing and verification of unsubscribe / preferences / opt-in tokens
  wp/          WordPress feed reading
supabase/
  migrations/  0001 -> 0097, plain SQL (see supabase/README.md)
```

The admin and the worker share the packages that decide what a subscriber receives (`segments`,
`render`, `email`, `edition`), so the preview in the back office and the email actually delivered
are produced by the same code. The public app and the worker share `tokens`, so a link signed in an
email footer is verified by the same routine that signed it.

Dockerfiles are provided for each app (`Dockerfile`, `Dockerfile.public`, `Dockerfile.worker`);
the Next.js apps build in `standalone` mode.

## Running locally

Prerequisites: bun 1.2+, and a Supabase project (local `supabase start` or hosted) for a demo
database.

```sh
bun install

# 1. Database — apply the migrations in order (details in supabase/README.md)
for f in supabase/migrations/*.sql; do
  psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f "$f" || break
done
# then expose the `newsletter` schema to the API (Project Settings -> API -> Exposed schemas)

# 2. Environment — placeholder values, every variable documented
cp .env.example apps/admin/.env.local     # keep the shared + admin blocks
cp .env.example apps/public/.env.local    # keep the shared + public blocks
cp apps/worker/.env.example apps/worker/.env

# 3. Apps
cd apps/admin  && bun run dev     # http://localhost:3000
cd apps/public && bun run dev     # http://localhost:3001
cd apps/worker && bun run start   # dry-run: logs what it would send, sends nothing
```

The first login to the admin bootstraps a super-admin from `AUTH_EMAIL` / `AUTH_PASSWORD` while
the user table is empty.

```sh
bun test                                   # whole suite, from the repository root
cd apps/admin && bun run build             # production build (needs NEXT_PUBLIC_PUBLIC_BASE_URL)
cd apps/public && bun run build
```

## Send safety (worker)

Sending real email to real people is the one irreversible thing this system does, so the worker
is **fail-closed** by default:

- **Dry-run by default.** `WORKER_MODE=dry-run` claims and renders rows but never calls Mailgun.
  Only `WORKER_MODE=live` sends.
- **Sandbox by default.** `WORKER_SENDING_MODE=sandbox` sends through Mailgun's sandbox domain,
  which only delivers to authorised recipients. `asset` (each brand's verified subdomain) is opt-in.
- **Allowlist.** In live mode an empty `WORKER_ALLOWLIST` refuses to boot. Recipients outside the
  list are skipped terminally (`not_allowlisted`). Opening to everyone requires the explicit value
  `*`, which is itself refused together with the sandbox.
- **Boot guards.** Live mode also refuses to start without a Mailgun key, without a sandbox domain
  in sandbox mode, or with the development `TOKEN_SECRET` (unsubscribe links would be unverifiable).
  A token-secret fingerprint is printed at boot by both the worker and the public app.
- **No double send.** The HTTP timeout must stay well under the stale-lock window (checked at
  boot), so an in-flight send is never reclaimed and sent twice.
- **Throughput caps.** `WORKER_MAX_PER_RUN` bounds a whole run (not just one batch);
  transactional mail has its own per-window cap.
- **Per-row compliance gate.** Right before sending, each row is re-checked against subscription
  status, live suppression, consent purpose and legal regime; tracking is only enabled when the
  regime and consent allow it. Demo addresses on reserved domains are excluded from sendable views.
- **Task separated from mode.** `WORKER_TASK` (drain / plan / enqueue / engagement / lifecycle)
  decides what the process does; planning and engagement never instantiate the mail client. An
  unknown task name is an error, not a silent fallback to `drain`.
- **Simulation switches.** `FANOUT_SIMULATE`, `PLANNER_SIMULATE` and `ENGAGEMENT_DRY_RUN` count
  without writing.

## Migrations

`supabase/migrations/` holds 97 sequential SQL migrations. Each is applied once, in order; from
`0062` onward each records itself in `newsletter.applied_migration`, and many end with a
counter-check block that aborts if the database does not match what the file claims.
`supabase/migrations.test.ts` enforces naming and registration rules.

<details>
<summary>Full list</summary>

- `0001_newsletter_init.sql`
- `0002_seed_assets.sql`
- `0003_add_country.sql`
- `0004_seed_demo_subscribers.sql`
- `0005_email_outbox.sql`
- `0006_compliance_dsar_tracking.sql`
- `0007_seed_editions_footer.sql`
- `0008_suppression_functions.sql`
- `0009_sendable_subscription_view.sql`
- `0010_email_outbox_worker.sql`
- `0011_outbox_release.sql`
- `0012_seed_consent_texts.sql`
- `0013_granular_consent.sql`
- `0014_granular_consent_backfill.sql`
- `0015_consent_views.sql`
- `0016_retention_purge.sql`
- `0017_builder_templates.sql`
- `0018_builder_media_campaigns_ai.sql`
- `0019_outbox_context_campaign.sql`
- `0020_saved_rows.sql`
- `0021_media_archive.sql`
- `0022_seed_timezone_fix.sql`
- `0023_outbox_priority.sql`
- `0024_wp_source.sql`
- `0025_campaign_occurrences.sql`
- `0026_multi_edition.sql`
- `0027_campaign_occurrence.sql`
- `0028_occurrence_duplicate_guard.sql`
- `0029_atlas_review_primary_edition_br.sql`
- `0030_legal_footer_privacy_urls.sql`
- `0031_atlas_review_real_domain.sql`
- `0032_fanout_guards.sql`
- `0033_is_demo_reserved_domain.sql`
- `0034_sendable_excludes_demo.sql`
- `0035_excluded_demo_subscription.sql`
- `0036_outbox_context_occurrence.sql`
- `0037_fanout_state.sql`
- `0038_enqueue_campaign_batch.sql`
- `0039_real_domains_ff_quartz_tips.sql`
- `0040_reconcile_counters.sql`
- `0041_email_event.sql`
- `0042_feed_article_sent.sql`
- `0043_record_feed_articles.sql`
- `0044_app_user.sql`
- `0045_retirer_marques_bluefin_news_pixel_daily_lumen_living.sql`
- `0046_asset_analytics.sql`
- `0047_article_views_null_non_mesure.sql`
- `0048_outbox_context_edition.sql`
- `0049_campaign_mix_latest.sql`
- `0050_subject_shortcodes.sql`
- `0051_optin.sql`
- `0052_optin_in_sendable_views.sql`
- `0053_apply_optin_default_tag.sql`
- `0054_optin_stats.sql`
- `0055_ai_intro.sql`
- `0056_recompute_engagement.sql`
- `0057_lifecycle_sunset.sql`
- `0058_reengagement_engine.sql`
- `0059_lifecycle_template.sql`
- `0060_reengagement_result.sql`
- `0061_first_party_engagement.sql`
- `0062_migration_marker.sql`
- `0063_capture_provenance.sql`
- `0064_brand_partial.sql`
- `0065_legal_footer_template.sql`
- `0066_brand_footers_seed.sql`
- `0067_campaign_edition_start.sql`
- `0068_pf_edition_dynamique.sql`
- `0069_deliverability_summary.sql`
- `0070_suppress_idempotent.sql`
- `0071_revoke_public_execute.sql`
- `0072_audit_log_target_index.sql`
- `0073_interactifs_instantanes_reinscription.sql`
- `0074_app_user_all_access.sql`
- `0075_app_user_all_brands_all_templates.sql`
- `0076_app_user_drop_all_access.sql`
- `0077_campaign_archive.sql`
- `0078_expediteur_edition.sql`
- `0079_edition_review.sql`
- `0080_brand_partial_block.sql`
- `0081_securite_inscription_consentement_rebonds.sql`
- `0082_automations.sql`
- `0083_article_views_lien_marts.sql`
- `0084_article_views_chemins_distants.sql`
- `0085_campaign_send_stats.sql`
- `0086_lifecycle_setting.sql`
- `0087_subscription_history_columns.sql`
- `0088_contacts_hors_newsletter.sql`
- `0089_recreer_pixel_daily.sql`
- `0090_welcome_back_retour_newsletter.sql`
- `0091_app_user_password_changed_at.sql`
- `0092_suivi_pour_tous_et_detail_evenements.sql`
- `0093_campagne_masquee_des_analytics.sql`
- `0094_analytics_comportement.sql`
- `0095_label_d_automation.sql`
- `0096_envois_en_cours.sql`
- `0097_creer_marque_fabrikam.sql`

</details>
