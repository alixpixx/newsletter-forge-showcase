# Database — newsletter-forge

Everything lives in a dedicated Postgres schema, **`newsletter`**. The three apps talk to it through
`supabase-js` with `db: { schema: "newsletter" }` and the **service-role** key; the anon key reaches
nothing (RLS is enabled, default-deny, on every table).

## Requirements

A Supabase project, or a Postgres 15+ database that provides what Supabase provides:

- the roles `anon`, `authenticated` and `service_role` (migrations grant and revoke on them);
- a schema named `extensions`, where `citext` is installed (`0001`);
- PostgREST with the `newsletter` schema added to the exposed schemas
  (Supabase dashboard → *Project Settings → API → Exposed schemas*).

## Applying the migrations

The files in `migrations/` are plain SQL, numbered `0001` → `0097`. Apply them **once each, in
order**, each one in its own transaction:

```sh
for f in supabase/migrations/*.sql; do
  psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f "$f" || break
done
```

⛔ **Never `supabase db push`.** The Supabase CLI keeps its own registry
(`supabase_migrations.schema_migrations`), which this folder does not use. On a database that
already has the schema, the CLI would replay files that were applied, and three replays break it:
`0018` recreates a check constraint without a later value, `0019` fails (`create or replace view`
cannot drop columns added since), and `0046` restores the "0 views" bug fixed by `0047`. Those
three files say so in their first line.

The source of truth for what has been applied is the table **`newsletter.applied_migration`**
(created by `0062`). From `0062` onward, each migration records itself as its **last** statement,
so a migration that fails half-way leaves no row behind. `migrations.test.ts` rejects a file that
does not do so. Before writing the next one:

```sql
select max(version) from newsletter.applied_migration;
```

Several migrations end with a *counter-check* block (`do $$ … raise exception … $$`) that verifies
their own effect — privileges, function bodies, column sets — and aborts the transaction if the
database does not match what the file claims to have done.

## Optional: page-view analytics (`0083`)

`newsletter.article_views` ranks candidate articles by page views read from a separate analytics
database (`marts.pages_daily_clean`). The link is **optional**:

- **Without configuration** (fresh database, demo, development), `0083` creates
  `newsletter_ext.pages_daily_clean` as an empty local table. The function then answers
  `source_silent`, and the editor simply shows "not measured".
- **To link a real analytics database** on the same cluster, set the host before applying `0083`:

  ```sql
  alter database <your_db> set newsletter.marts_fdw_host = 'db';
  ```

  `0083` then installs `postgres_fdw`, creates the server and a foreign table pointing to
  `marts.pages_daily_clean`.

`0046` and `0047` define earlier versions of the same function against `marts`; they disable
`check_function_bodies` for that statement so that they apply cleanly on a database where `marts`
does not exist.

## Seed data

Some early migrations seed demo brands, editions, consent texts and a handful of subscribers on
reserved domains (`*.example`, `example.com`). Demo subscribers are excluded from every sendable
view (`0033`–`0035`), so the worker never queues mail for them.
