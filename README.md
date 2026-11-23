# Taskboard

A local-first taskboard for one person and the agents helping them work. It uses **TanStack Start + React**, a local **SQLite** file, and MCP servers for local stdio or authenticated remote HTTP clients.

## Start here

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The first run creates `data/taskboard.sqlite` and a welcome task. The `data/` directory is ignored by Git.

## Run with Docker

1. Create a private deployment file and generate its MCP token:

   ```bash
   cp .env.example .env
   openssl rand -base64 48 | tr -d '\n'
   ```

   Paste that token into `TASKBOARD_MCP_TOKEN` in `.env`. Keep the web binding at `127.0.0.1`. Set `TASKBOARD_MCP_BIND` to this machine’s trusted-LAN IP only when remote agents need access.

2. Build and start both services:

   ```bash
   docker compose up --build -d
   docker compose ps
   ```

The Compose stack runs a production web server and a separate authenticated Streamable HTTP MCP server against one named SQLite volume. Both run as the unprivileged `node` user. Open the web UI at [http://localhost:3000](http://localhost:3000), and inspect logs with `docker compose logs -f`.

Mount the database directory, not only its `.sqlite` file: SQLite WAL mode also writes `-wal` and `-shm` files. Stop the stack with `docker compose down`; its named volume remains intact.

## What works

- Nord-themed board with Inbox, Backlog, Ready, In progress, Blocked, and Complete states.
- Tasks can belong to a project or stay standalone.
- Drag cards between board columns, or change their state in the task panel.
- Activity has its own live, auto-refreshing workspace tab.
- Archive and restore tasks without deleting their comments or history.
- Browser users and MCP bots are distinct actors in the activity history.

## Connect any MCP client

The taskboard server supports ordinary local stdio MCP and authenticated remote Streamable HTTP MCP. Pi, Claude Code, Codex, and compatible clients use the same bounded task tools; no client is privileged.

Start one server process per agent identity:

```bash
npm run mcp -- --bot work-agent --name "Work agent"
```

Set this project folder as the MCP process `cwd` in your client configuration:

```json
{
  "command": "npm",
  "args": ["run", "mcp", "--", "--bot", "work-agent", "--name", "Work agent"],
  "cwd": "/path/to/tasks"
}
```

Give each connection a unique `--bot` ID. The server stores that identity in SQLite and shows it in the board’s **Agents** section.

### Agent work protocol

1. Call `list_tasks` or `get_task` to find work.
2. Call `claim_task` before changing a task. It locks the task and moves it to **In progress**.
3. Add meaningful progress with `add_task_comment`.
4. Renew longer work with `renew_task_lock`.
5. Use `update_task` for progress; completion releases the lock. Release early with `release_task_lock`.

A bot cannot update or comment on a task held by another bot. Locks expire after 5–120 minutes so abandoned work does not block the board indefinitely.

### Taskboard MCP tools

**Discover:** `list_tasks`, `get_task`, `list_projects`, `list_bots`.

**Create and claim:** `create_project`, `create_task`, `claim_task`, `renew_task_lock`.

**Work and close:** `update_task`, `add_task_comment`, `release_task_lock`, `archive_task`, `unarchive_task`.

The taskboard server exposes bounded task operations only: no arbitrary SQL, shell commands, files, source code, or logs. Its stdout is reserved for MCP protocol messages.

### Connect Pi or Claude Code over a trusted LAN

The Docker MCP service listens at `http://<docker-host-ip>:3001/mcp` when `TASKBOARD_MCP_BIND` is set to that LAN IP. Every request needs a bearer token and a unique bot identity in headers.

```bash
export TASKBOARD_MCP_TOKEN='the-token-from-.env'
export TASKBOARD_MCP_URL='http://192.168.1.20:3001/mcp'
```

Add it to Pi from a shell where `TASKBOARD_MCP_TOKEN` is set:

```bash
pi mcp add taskboard \
  --url "$TASKBOARD_MCP_URL" \
  --bearer-token-env-var TASKBOARD_MCP_TOKEN \
  --header 'X-Taskboard-Bot-Id=pi-agent-alberto' \
  --header 'X-Taskboard-Bot-Name=Pi agent' \
  --description 'Read and update the personal Taskboard' \
  --exposure deferred
pi mcp list
```

Add it to Claude Code without saving the token in its config:

```bash
claude mcp add --scope user --transport http \
  -H 'Authorization: Bearer ${TASKBOARD_MCP_TOKEN}' \
  -H 'X-Taskboard-Bot-Id: claude-code-alberto' \
  -H 'X-Taskboard-Bot-Name: Claude Code' \
  taskboard "$TASKBOARD_MCP_URL"
```

Use a different `X-Taskboard-Bot-Id` for every concurrent agent. The HTTP endpoint intentionally accepts only authenticated `POST /mcp` requests. It is suitable for a trusted LAN; do not publish it to the Internet without HTTPS and an authenticated reverse proxy.

## Inspect or call any local stdio MCP server

`mcp:client` is a project-neutral local CLI. It starts a local stdio MCP server command, lists its advertised tools, or calls one tool. It is not tied to Taskboard, Pi, Codex, or Claude Code.

```bash
# List a server’s tools
npm run mcp:client -- tools -- node ./server.mjs

# Call a server tool with a JSON object
npm run mcp:client -- call echo --args '{"message":"hello"}' -- node ./server.mjs

# Inspect this taskboard server through the generic client
npm run mcp:client -- tools -- npm run mcp -- --bot local-client --name "Local client"
```

Client options before the delimiter: `--cwd <path>`, repeatable `--env NAME=VALUE`, `--timeout-ms <ms>`, `--max-total-timeout-ms <ms>`, `--max-buffer-bytes <bytes>`, and `--pretty`.

Successful list/call output is exactly one JSON document on stdout. Diagnostics go to stderr. A tool-level MCP error still prints JSON and exits with status `2`; connection, protocol, and input errors exit with status `1`. The command after `--` is trusted local code—review it before running it.

## Commands

```bash
npm run dev                         # Start the local web app on port 3000
npm run mcp -- --bot agent --name "Agent"  # Start a Taskboard stdio MCP bot
npm run mcp:http                       # Start authenticated HTTP MCP on port 3001
npm run mcp:client -- tools -- node ./server.mjs  # Inspect any stdio MCP server
npm run typecheck                   # Check TypeScript
npm run test                        # Run tests
npm run build                       # Build the TanStack Start/Nitro app
npm run build:mcp                   # Build Node artifacts for the MCP server and client
npm run start                       # Serve the production build after npm run build
npm run check                       # Typecheck, test, and build
```

## Local data and safety

- Default database: `data/taskboard.sqlite`
- Override database location: `TASKBOARD_DB_PATH=/absolute/path/to/tasks.sqlite`
- Disable the welcome task when scripting: `TASKBOARD_SEED=false`
- SQLite runs in WAL mode with a five-second busy timeout so the web app and MCP processes can share the local file.
- This is a local single-workspace app, not a multi-user authenticated service. Do not publish its web port to an untrusted network.
- Do not run multiple web containers against one SQLite volume or store that volume on a network filesystem.
