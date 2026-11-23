import '@tanstack/react-start/server-only'

import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import Database from 'better-sqlite3'

type Migration = {
  id: string
  sql: string
}

let database: Database.Database | undefined

const migrations: readonly Migration[] = [
  {
    id: '001_initial_taskboard',
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE,
        description TEXT NOT NULL DEFAULT '',
        color TEXT NOT NULL DEFAULT '#5E81AC',
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE bots (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        last_seen_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('inbox', 'backlog', 'ready', 'in_progress', 'blocked', 'complete')),
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        archived_at TEXT,
        completed_at TEXT,
        locked_by_bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL,
        lock_expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE task_comments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'bot', 'system')),
        actor_id TEXT NOT NULL,
        actor_name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE task_events (
        id TEXT PRIMARY KEY,
        task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'bot', 'system')),
        actor_id TEXT NOT NULL,
        actor_name TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE INDEX idx_tasks_board ON tasks (archived_at, status, sort_order DESC, updated_at DESC);
      CREATE INDEX idx_tasks_project ON tasks (project_id, archived_at);
      CREATE INDEX idx_tasks_lock ON tasks (locked_by_bot_id, lock_expires_at);
      CREATE INDEX idx_comments_task ON task_comments (task_id, created_at DESC);
      CREATE INDEX idx_events_task ON task_events (task_id, created_at DESC);
      CREATE INDEX idx_events_recent ON task_events (created_at DESC);
    `,
  },
  {
    id: '002_nord_project_palette',
    sql: `
      UPDATE projects
      SET color = '#5E81AC'
      WHERE color IN ('#7c3aed', '#8b5cf6');
    `,
  },
]

export function getDatabasePath() {
  return resolve(process.env.TASKBOARD_DB_PATH ?? 'data/taskboard.sqlite')
}

export function getDatabase() {
  if (database) {
    return database
  }

  const databasePath = getDatabasePath()
  mkdirSync(dirname(databasePath), { recursive: true })

  database = new Database(databasePath)
  database.pragma('journal_mode = WAL')
  database.pragma('foreign_keys = ON')
  database.pragma('busy_timeout = 5000')

  applyMigrations(database)
  seedDatabase(database)

  return database
}

function applyMigrations(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `)

  const alreadyApplied = db.prepare<[string], { id: string }>(
    'SELECT id FROM schema_migrations WHERE id = ?',
  )
  const markApplied = db.prepare<[string, string]>(
    'INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)',
  )

  for (const migration of migrations) {
    if (alreadyApplied.get(migration.id)) {
      continue
    }

    db.transaction((nextMigration: Migration) => {
      db.exec(nextMigration.sql)
      markApplied.run(nextMigration.id, new Date().toISOString())
    })(migration)
  }
}

function seedDatabase(db: Database.Database) {
  if (process.env.TASKBOARD_SEED === 'false') {
    return
  }

  const { count } = db
    .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM tasks')
    .get() ?? { count: 0 }

  if (count > 0) {
    return
  }

  const now = new Date().toISOString()
  const projectId = 'getting-started-project'
  const taskId = 'welcome-task'

  db.transaction(() => {
    db.prepare(
      `INSERT INTO projects (id, name, description, color, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      projectId,
      'Getting started',
      'A small local project to show how the board works.',
      '#5E81AC',
      now,
      now,
    )

    db.prepare(
      `INSERT INTO tasks (
        id, title, description, status, project_id, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      taskId,
      'Welcome to your local taskboard',
      'Open this task, add a comment, then drag it across the board. Agents can claim tasks through MCP.',
      'inbox',
      projectId,
      1000,
      now,
      now,
    )

    db.prepare(
      `INSERT INTO task_events (
        id, task_id, type, actor_kind, actor_id, actor_name, data, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'welcome-task-created',
      taskId,
      'task_created',
      'system',
      'taskboard',
      'Taskboard',
      JSON.stringify({ status: 'inbox' }),
      now,
    )
  })()
}

export function closeDatabase() {
  database?.close()
  database = undefined
}
