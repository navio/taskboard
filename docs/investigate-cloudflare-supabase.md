# Taskboard on Cloudflare + Supabase — investigation

Question: how do we implement the taskboard with **Cloudflare** (hosting) and **Supabase** (database)? Focus: what happens to the SQLite data layer.

Status: investigation only. No code changed. Updated 2026-11-24: added multi-user authentication design (§ Auth for multiple users).

## TL;DR

| Part | Today (Docker on Mac) | Proposed (Cloudflare + Supabase) |
| --- | --- | --- |
| Web UI | Nitro Node server, port 3000 | Nitro `cloudflare_module` preset → one Worker |
| MCP HTTP | Node `http` server, port 3001, bearer token | Same Worker, `/mcp` route, same bearer token + bot headers |
| DB | better-sqlite3 file + WAL | Supabase Postgres via Hyperdrive, `postgres` (postgres.js) driver |
| Auth for humans | none (LAN only), localStorage persona | **Supabase Auth: multiple users, magic-link/OAuth, server-injected actor** (optional Cloudflare Access hardening) |
| Auth for agents | shared bearer token in `X-` headers | unchanged |

Recommended DB approach: **port `src/server/db.ts` + `task-service.ts` from better-sqlite3 to `postgres` (postgres.js) over Hyperdrive**, translate the schema to Postgres DDL, and move migrations into the Supabase CLI. The service layer is the only significant rewrite; the MCP tool surface, HTTP contract, and frontend need almost no changes.

## Why not Cloudflare D1 (short note)

D1 is SQLite-compatible, so the current SQL would port with near-zero changes. It is the cheaper option if Cloudflare-only is the goal. But the task explicitly asks for Supabase, and Supabase gives: real Postgres (transactional SQL, `jsonb`, richer tooling), local dev stack (`supabase start` gives local Postgres + Studio), and a migration framework that doesn't depend on Cloudflare. Decision point: if the only requirement were "host it on Cloudflare," D1 would be simpler. Going Supabase = a real DB port.

## Target architecture

```
Browser ── Cloudflare Access ──┐
                               ▼
MCP clients (Pi/Claude Code) ──► Worker: taskboard.<name>.workers.dev
                                  ├─ /            web UI (Nitro build, TanStack server fns)
                                  ├─ /healthz
                                  └─ /mcp         bearer token + X-Taskboard-Bot-* headers
                                        │
                                        ▼
                                  Hyperdrive binding (pooled)
                                        │
                                        ▼
                                  Supabase Postgres (Supavisor transaction pooler :6543)
```

One Worker serves both the web app and MCP. Both hit the same Postgres. The existing bot-locking protocol (claim/renew/release with expiry) already works across processes, which is what a serverless deployment needs.

## The DB: how to implement it

### 1. Schema (SQLite → Postgres DDL)

The current schema (src/server/db.ts, migration `001`) translates directly. Differences:

- `COLLATE NOCASE` on `projects.name` → Postgres has none; use a unique expression index on `lower(name)` (matches current case-insensitive name checks in `createProject`).
- TEXT ISO timestamps → `timestamptz` (or keep TEXT to minimize code churn; see row mapping below).
- `task_events.data` TEXT JSON → `jsonb`.
- `schema_migrations` ledger is dropped here — Supabase CLI owns migrations (see §4), keeping one migration authority. (Lesson from the Notes project: two migration ledgers drift; pick one source of truth.)

```sql
-- supabase/migrations/20261124000001_init_taskboard.sql
create table projects (
  id text primary key,
  name text not null,
  description text not null default '',
  color text not null default '#5E81AC',
  archived_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create unique index projects_name_ci on projects (lower(name));

create table users (
  id text primary key,
  name text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table bots (
  id text primary key,
  name text not null,
  description text not null default '',
  last_seen_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table tasks (
  id text primary key,
  title text not null,
  description text not null default '',
  status text not null check (status in ('inbox','backlog','ready','in_progress','blocked','complete')),
  project_id text references projects(id) on delete set null,
  sort_order integer not null default 0,
  archived_at timestamptz,
  completed_at timestamptz,
  locked_by_bot_id text references bots(id) on delete set null,
  lock_expires_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table task_comments (
  id text primary key,
  task_id text not null references tasks(id) on delete cascade,
  body text not null,
  actor_kind text not null check (actor_kind in ('user','bot','system')),
  actor_id text not null,
  actor_name text not null,
  created_at timestamptz not null
);

create table task_events (
  id text primary key,
  task_id text references tasks(id) on delete cascade,
  type text not null,
  actor_kind text not null check (actor_kind in ('user','bot','system')),
  actor_id text not null,
  actor_name text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null
);

create index idx_tasks_board on tasks (archived_at, status, sort_order desc, updated_at desc);
create index idx_tasks_project on tasks (project_id, archived_at);
create index idx_tasks_lock on tasks (locked_by_bot_id, lock_expires_at);
create index idx_comments_task on task_comments (task_id, created_at desc);
create index idx_events_task on task_events (task_id, created_at desc);
create index idx_events_recent on task_events (created_at desc);
```

Timestamp choice: `timestamptz` is correct long-term. postgres.js parses it to `Date`; hydrate rows with `.toISOString()` in the existing `toTask`/`toEvent` mappers, or configure the driver to keep strings during the port to shrink the diff. Text ids, CHECK constraints, and all existing queries port as-is.

### 2. Driver and connection path

- Driver: [`postgres`](https://github.com/porsager/postgresql) (postgres.js), not `better-sqlite3` (native module — cannot run on Workers) and not `@supabase/supabase-js` (REST, no transactions).
- Connection: Worker → **Hyperdrive** binding → Supabase **Supavisor transaction pooler** (port 6543). Hyperdrive pools and caches connections; the pooler terminates PG wire protocol server-side.
- Critical config for postgres.js over a transaction pooler / Hyperdrive: `prepare: false` (no session prepared statements), and note that session-level features (LISTEN/NOTIFY, advisory locks, SET session) are unavailable. Verify during the spike that `sql.begin()` transactions route to a single connection through Supavisor+Hyperdrive; if not, fall back to single-statement conditional writes (§3) which don't need interactive transactions.

```ts
// src/server/db.ts (deployed variant)
import postgres from 'postgres'

type Sql = postgres.Sql<{}>

let sql: Sql | undefined

export function getSql(): Sql {
  if (!sql) {
    const connectionString =
      (globalThis as any).__env__?.HYPERDRIVE?.connectionString ??
      process.env.DATABASE_URL // local dev: direct Postgres URL
    sql = postgres(connectionString, {
      prepare: false,
      max: 10,               // local dev; on Workers Hyperdrive owns pooling
      types: { /* optionally map timestamptz → ISO strings */ },
    })
  }
  return sql
}
```

### 3. Rewriting the service layer (the real work)

`src/server/task-service.ts` (1053 lines) is synchronous better-sqlite3: `db.prepare(...).get/run/all` and `db.transaction(() => {...}).immediate()`. Mapping:

| SQLite (today) | postgres.js |
| --- | --- |
| `db.prepare(s).get(...)` | `await sql\`...\`` (single row) |
| `db.prepare(s).all(...)` | `await sql\`...\`` (array) |
| `db.prepare(s).run(...)` | `await sql\`...\`` (use `.count` / `RETURNING`) |
| `db.transaction(fn)` | `await sql.begin(fn)` (rows passed as `sql` param) |
| `randomUUID` from `node:crypto` | `crypto.randomUUID()` (web standard, works in Node + Workers) |

Every exported function in task-service becomes `async`. Both call sites already tolerate this:
- TanStack server functions (`src/server/functions.ts`) have `async` handlers — add `await`.
- MCP tool handlers (`src/mcp-server.ts`) are async handlers — add `await`.

**Claim locking gets simpler and safer.** The current read-then-write inside a transaction relies on SQLite's single-writer model. On Postgres, replace `claimTask`'s check with one conditional statement (race-free across N Workers):

```sql
update tasks
set locked_by_bot_id = $bot, lock_expires_at = $expires, updated_at = $now
where id = $taskId
  and archived_at is null
  and status <> 'complete'
  and (
    locked_by_bot_id is null
    or locked_by_bot_id = $bot
    or lock_expires_at <= now()
  )
returning id, locked_by_bot_id, lock_expires_at;
```

Zero rows returned → re-select the task and throw `LOCKED` / `CONFLICT` as today. `renewTaskLock` and `releaseTaskLock` follow the same pattern. `nextSortOrder` (`max(sort_order)+100`) is unchanged.

### 4. Migrations, seeding, RLS

- **Migrations:** replace the in-code `migrations` array with `supabase/migrations/*.sql` and `supabase db push` / `supabase db pull` via the Supabase CLI. Local dev: `supabase start` + `supabase db reset` runs migrations + a `seed.sql`. Remove `applyMigrations`/`seedDatabase` from `db.ts` (keep `TASKBOARD_SEED=false` equivalent by trimming seed.sql).
- **Existing data migration:** one-off Node script that opens the old SQLite file with better-sqlite3 (dev-only dep) and re-inserts rows through the new service layer (or plain SQL) — trivial volume.
- **RLS — hard requirement:** Supabase exposes every table in `public` through PostgREST using the *public* anon key. Tables with RLS disabled are readable/writable by anyone holding that key. Since the app talks to Postgres directly (never via PostgREST), enable RLS with **no policies** on all six tables (deny-all for anon/authenticated) so the PostgREST surface stays closed. The app connects with the direct DB connection, bypassing PostgREST.

### 5. Supabase project setup

1. Create project → copy the **Transaction pooler** connection string (port 6543, user `postgres.<ref>`).
2. `supabase init` + migration files as above → `supabase db push`.
3. Enable RLS (no policies) on all tables; keep Postgres connection string as the Worker secret (never the service_role key via public surface).

## Cloudflare side

### Web app

Nitro already supports Workers: `NITRO_PRESET=cloudflare_module` (or per-build config) produces `.output/server/index.mjs` deployable with Wrangler. TanStack Start documents the same path. Needed `wrangler.jsonc` sketch:

```jsonc
{
  "name": "taskboard",
  "main": ".output/server/index.mjs",
  "compatibility_date": "2026-11-01",
  "compatibility_flags": ["nodejs_compat"],
  "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "<hyperdrive-id>" }],
  "vars": { "TASKBOARD_SEED": "false" },
  "secrets": ["TASKBOARD_MCP_TOKEN"] // via `wrangler secret put`
}
```

`createHyperdrive` (or `wrangler hyperdrive create`) points at the Supabase pooler URL. In Workers, bindings arrive via `env`; Nitro's `cloudflare_module` preset exposes them on `process.env`-style access / `useRuntimeConfig` — read `HYPERDRIVE.connectionString` in `db.ts` (the preset maps bindings; confirm exact access pattern in the spike).

### MCP HTTP on the Worker

Current implementation (src/mcp-http-server.ts) uses `node:http` — not portable. Two options:

1. **Recommended: rewrite the `/mcp` route as a Workers Request handler.** The transport is already stateless (`sessionIdGenerator: undefined`, new server per request), which maps to a plain `fetch` handler. The MCP TS SDK (1.32.2, installed) has an Express adapter but no web-standard one; use the community `mcp-hono-web-adapter` (`toReqResPair` / `toFetchResponse`) or write the same ~60-line shim. Keep the existing bearer-token + bot-header validation as plain header checks in the route (constant-time compare via WebCrypto).
2. **Cloudflare Agents SDK** (`agents/mcp`, McpAgent) — the officially supported remote-MCP path, gives session state via Durable Objects and optional OAuth. Heavier: it re-shapes the tool registration and adds Durable Object classes. Worth it only if per-session MCP state or OAuth becomes a requirement.

Stdio MCP (`npm run mcp`) stays exactly as-is for local use; the tool registration in `src/mcp-server.ts` is shared between transports.

### Auth for multiple users

Requirement (added 2026-11-24): more than one human uses the board, and every action must be attributed to a real, verified identity — not the browser's localStorage persona.

Two viable models:

**Model A — Supabase Auth (recommended on this path)**

- Supabase Auth owns user management: magic-link email and optional Google OAuth. No passwords to store.
- The app `users` table gains `auth_user_id uuid unique references auth.users(id)` and `email text unique`; a row is upserted on first login. App actor ids stay stable for the activity history.
- Sessions: httpOnly, `SameSite=Lax` cookie set after the auth callback, read and validated by every TanStack server function from the request context.
- **The client stops sending `actor` — this is the security-critical change.** Today `functions.ts` validators accept `actor {id, name, kind:'user'}` from the browser payload, which is untrusted input anyone can forge. Remove `actor` from all input schemas and inject the session-derived actor server-side. (The MCP side is unaffected: bots are identified by the registered bot identity, already verified by the token.)
- Login UI: one `/login` route with a magic-link form; unauthenticated page loads redirect there; logout clears the session. The sidebar identity card shows the logged-in user (name editable in profile) instead of the localStorage persona.
- Configure custom SMTP in Supabase for reliable magic links (the built-in sender is rate-limited).
- Works identically on Workers and the local Docker/dev stack — no Cloudflare dependency in the auth path.

**Model B — Cloudflare Access with a user list**

- Zero Trust free tier admits up to 50 users; the Access policy lists allowed emails or a workspace group. No passwords, no login UI, no session code.
- The Worker verifies the `Cf-Access-Jwt-Assertion` header (team-domain public keys + the app's AUD tag) and maps the verified email to the `users` table; actor injection is server-side exactly like Model A.
- Limitation: only works behind Cloudflare — useless for the LAN Docker deployment and clumsy in local dev.

**Recommendation:** Model A, because the platform is already chosen, there is no 50-user cap, and auth works in every deployment. Model B remains useful as optional edge hardening in front of the Worker (defense in depth against session-cookie theft) — the two compose.

**Agents stay on tokens.** MCP bots keep the bearer token + bot headers; humans and bots remain distinct actor kinds in comments and events. Unchanged data model.

**Authorization scope:** the workspace stays shared — every authenticated human can see and edit the whole board, like one team room; identity is for attribution, not isolation. If permission levels are wanted later, add a `role` column (`owner`/`member`/`viewer`) to `users` and check it in the service layer; nothing more invasive.

**CSRF:** server functions are POST; TanStack's built-in CSRF middleware stays on, and sessions use SameSite cookies.

**D1 note:** this requirement further favors the Supabase path — on D1 there is no Supabase Auth, so multi-user auth would force Model B (Cloudflare-only, 50-user cap).


## Local dev story

Two options:

- **A. Postgres everywhere (recommended for this goal):** `supabase start` (local Postgres in Docker) + `npm run dev` against the local pooler. One code path, same DDL, migrations tested locally. Loses offline-first local SQLite.
- **B. Dual driver:** keep better-sqlite3 for `npm run dev` behind a small repository interface. ~Double the test/maintenance surface; only worth it if offline local-first remains a hard requirement.

## Plan (spike → migrate)

1. **Spike (half a day):** Supabase project + local `supabase start`; add `postgres` dep; port `db.ts` + 2 functions (`getBoard`, `createTask`); confirm `sql.begin` + `prepare:false` through Supavisor; `npm run test` with a Postgres-backed service.
2. **Port task-service (1–2 days):** all functions async; conditional-UPDATE lock trio; tests still pass against local Postgres (SQLite tests move to Postgres test container).
3. **Multi-user auth (1–1.5 days):** enable Supabase Auth (magic link + optional Google); `auth_user_id`/`email` columns on `users`; `/login` route + session cookie helper; **strip `actor` from all `functions.ts` input schemas and inject it from the session server-side**; swap the sidebar persona for the logged-in user; tests: unauthenticated server-function calls rejected, actor attribution comes from the session. (Optional: Cloudflare Access policy in front as extra hardening.)
4. **Workers deploy (half a day):** Nitro `cloudflare_module` build, Hyperdrive binding, `/mcp` fetch route with token check, `/healthz`; `wrangler secret put TASKBOARD_MCP_TOKEN`.
5. **Data + cleanup (half a day):** one-off SQLite → Postgres import (existing localStorage personas merge into real users on first login, or map by name with a manual review); drop migration/seed code from `db.ts`; update README (auth model, no Docker requirement, MCP URL becomes `https://taskboard.<name>.workers.dev/mcp`).

## Risks / open decisions

- `sql.begin` through Supavisor transaction mode + Hyperdrive must route a transaction to one connection — spike item; fallback is the conditional-UPDATE pattern everywhere.
- MCP web-standard adapter shim needs validation on Workers (the transport writes SSE/JSON responses through the shimmed `ServerResponse`).
- Supabase free tier (500 MB DB, pauses after inactivity) is fine for this app; a paused project breaks agents mid-work — decide if that matters (paid tier ~$25/mo, or keep the Docker local stack as the always-on fallback).
- Removing the client-supplied `actor` from server-function inputs is a **required security fix** for multi-user, not an optional cleanup — while it exists, any local user can impersonate any other by editing localStorage. Ship it with auth, not after.
- Magic-link deliverability depends on SMTP setup in Supabase; test on real inboxes during the auth step.
- The LAN/Docker deployment remains valid; this is an alternative, not a replacement. The lighter alternative to the whole plan stays: keep Docker + add a Cloudflare Tunnel for HTTPS (the pending HTTPS decision from 2026-11-23).
- Multi-user model: Supabase Auth with a shared workspace (Model A). Access-only (Model B) caps at 50 users and does not work off-Cloudflare. Per-user data isolation is explicitly out of scope; add `users.role` later if permission levels are needed.

## Files that would change (for sizing)

- `src/server/db.ts` — rewrite (driver, migrations out)
- `src/server/task-service.ts` — async port + lock rewrite (bulk of the work)
- `src/server/functions.ts`, `src/mcp-server.ts` — add `await` (mechanical); **`functions.ts` additionally loses the client `actor` input and gains session-derived actor injection**
- `+ src/routes/login.tsx`, `+ src/server/session.ts` (cookie read/validate, actor resolution)
- `src/mcp-http-server.ts` / new `src/mcp-worker.ts` — fetch-based MCP route
- `package.json` — `+postgres`, `-better-sqlite3` (moved to dev for the import script)
- `+ wrangler.jsonc`, `+ supabase/migrations/*`, `+ supabase/config.toml`, README
- `vite.config.ts` / build scripts — cloudflare_module preset target
