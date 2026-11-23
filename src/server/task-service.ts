import '@tanstack/react-start/server-only'

import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  TASK_STATUSES,
  type Actor,
  type ActorKind,
  type BoardSnapshot,
  type Bot,
  type EventData,
  type Project,
  type Task,
  type TaskComment,
  type TaskDetail,
  type TaskEvent,
  type TaskStatus,
} from '../shared/types'
import { getDatabase } from './db'

export class TaskboardError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_FOUND' | 'LOCKED' | 'INVALID' | 'CONFLICT',
  ) {
    super(message)
    this.name = 'TaskboardError'
  }
}

export type MutableActor = {
  id: string
  name: string
  kind: Exclude<ActorKind, 'system'>
}

export type CreateTaskInput = {
  title: string
  description?: string
  status?: TaskStatus
  projectId?: string | null
}

export type UpdateTaskInput = {
  id: string
  title?: string
  description?: string
  status?: TaskStatus
  projectId?: string | null
}

export type CreateProjectInput = {
  name: string
  description?: string
  color?: string
}

export type ListTaskFilters = {
  status?: TaskStatus
  projectId?: string
  includeArchived?: boolean
  search?: string
  limit?: number
}

type TaskRow = {
  id: string
  title: string
  description: string
  status: TaskStatus
  project_id: string | null
  project_name: string | null
  project_color: string | null
  sort_order: number
  archived_at: string | null
  completed_at: string | null
  locked_by_bot_id: string | null
  lock_expires_at: string | null
  locked_by_bot_name: string | null
  created_at: string
  updated_at: string
  comment_count: number
}

type ProjectRow = {
  id: string
  name: string
  description: string
  color: string
  archived_at: string | null
  created_at: string
  updated_at: string
  task_count: number
}

type BotRow = {
  id: string
  name: string
  description: string
  last_seen_at: string | null
  created_at: string
  locked_task_count: number
}

type CommentRow = {
  id: string
  task_id: string
  body: string
  actor_kind: ActorKind
  actor_id: string
  actor_name: string
  created_at: string
}

type EventRow = {
  id: string
  task_id: string | null
  task_title: string | null
  type: string
  actor_kind: ActorKind
  actor_id: string
  actor_name: string
  data: string
  created_at: string
}

type LockedTaskRow = {
  id: string
  title: string
  status: TaskStatus
  project_id: string | null
  archived_at: string | null
  locked_by_bot_id: string | null
  lock_expires_at: string | null
}

const taskSelect = `
  SELECT
    t.id,
    t.title,
    t.description,
    t.status,
    t.project_id,
    p.name AS project_name,
    p.color AS project_color,
    t.sort_order,
    t.archived_at,
    t.completed_at,
    t.locked_by_bot_id,
    t.lock_expires_at,
    b.name AS locked_by_bot_name,
    t.created_at,
    t.updated_at,
    COUNT(c.id) AS comment_count
  FROM tasks t
  LEFT JOIN projects p ON p.id = t.project_id
  LEFT JOIN bots b ON b.id = t.locked_by_bot_id
  LEFT JOIN task_comments c ON c.task_id = t.id
`

const taskGroupBy = `
  GROUP BY
    t.id,
    t.title,
    t.description,
    t.status,
    t.project_id,
    p.name,
    p.color,
    t.sort_order,
    t.archived_at,
    t.completed_at,
    t.locked_by_bot_id,
    t.lock_expires_at,
    b.name,
    t.created_at,
    t.updated_at
`

function now() {
  return new Date().toISOString()
}

function isTaskStatus(value: string): value is TaskStatus {
  return TASK_STATUSES.includes(value as TaskStatus)
}

function requireText(value: string, field: string, maxLength: number) {
  const text = value.trim()
  if (!text) {
    throw new TaskboardError(`${field} is required.`, 'INVALID')
  }
  if (text.length > maxLength) {
    throw new TaskboardError(`${field} must be at most ${maxLength} characters.`, 'INVALID')
  }
  return text
}

function optionalText(value: string | undefined, field: string, maxLength: number) {
  const text = value?.trim() ?? ''
  if (text.length > maxLength) {
    throw new TaskboardError(`${field} must be at most ${maxLength} characters.`, 'INVALID')
  }
  return text
}

function ensureActor(db: Database.Database, actor: MutableActor) {
  const id = requireText(actor.id, 'Actor ID', 100)
  const name = requireText(actor.name, 'Actor name', 100)
  const timestamp = now()

  if (actor.kind === 'user') {
    db.prepare(
      `INSERT INTO users (id, name, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
    ).run(id, name, timestamp, timestamp)
    return { id, name, kind: 'user' as const }
  }

  db.prepare(
    `INSERT INTO bots (id, name, last_seen_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       last_seen_at = excluded.last_seen_at,
       updated_at = excluded.updated_at`,
  ).run(id, name, timestamp, timestamp, timestamp)
  return { id, name, kind: 'bot' as const }
}

function writeEvent(
  db: Database.Database,
  input: {
    taskId: string | null
    type: string
    actor: Actor
    data?: EventData
    createdAt?: string
  },
) {
  db.prepare(
    `INSERT INTO task_events (
      id, task_id, type, actor_kind, actor_id, actor_name, data, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    input.taskId,
    input.type,
    input.actor.kind,
    input.actor.id,
    input.actor.name,
    JSON.stringify(input.data ?? {}),
    input.createdAt ?? now(),
  )
}

function clearExpiredLocks(db: Database.Database) {
  db.prepare(
    `UPDATE tasks
     SET locked_by_bot_id = NULL, lock_expires_at = NULL
     WHERE lock_expires_at IS NOT NULL AND lock_expires_at <= ?`,
  ).run(now())
}

function mapTask(row: TaskRow): Task {
  const lockIsActive =
    row.locked_by_bot_id !== null &&
    row.lock_expires_at !== null &&
    row.lock_expires_at > now()

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    project:
      row.project_id && row.project_name && row.project_color
        ? {
            id: row.project_id,
            name: row.project_name,
            color: row.project_color,
          }
        : null,
    sortOrder: row.sort_order,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    lock:
      lockIsActive && row.locked_by_bot_id && row.lock_expires_at
        ? {
            botId: row.locked_by_bot_id,
            botName: row.locked_by_bot_name ?? 'Unknown bot',
            expiresAt: row.lock_expires_at,
          }
        : null,
    commentCount: Number(row.comment_count),
  }
}

function mapProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    color: row.color,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    taskCount: Number(row.task_count),
  }
}

function mapBot(row: BotRow): Bot {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    lockedTaskCount: Number(row.locked_task_count),
  }
}

function mapComment(row: CommentRow): TaskComment {
  return {
    id: row.id,
    taskId: row.task_id,
    body: row.body,
    actor: {
      id: row.actor_id,
      name: row.actor_name,
      kind: row.actor_kind,
    },
    createdAt: row.created_at,
  }
}

function parseEventData(value: string) {
  try {
    const parsed: unknown = JSON.parse(value)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as EventData
    }
  } catch {
    // Historical malformed metadata should not hide the activity feed.
  }
  return {}
}

function mapEvent(row: EventRow): TaskEvent {
  return {
    id: row.id,
    taskId: row.task_id,
    taskTitle: row.task_title,
    type: row.type,
    actor: {
      id: row.actor_id,
      name: row.actor_name,
      kind: row.actor_kind,
    },
    data: parseEventData(row.data),
    createdAt: row.created_at,
  }
}

function getLockedTask(db: Database.Database, taskId: string) {
  const task = db
    .prepare<[string], LockedTaskRow>(
      `SELECT
        id, title, status, project_id, archived_at, locked_by_bot_id, lock_expires_at
       FROM tasks
       WHERE id = ?`,
    )
    .get(taskId)

  if (!task) {
    throw new TaskboardError('Task not found.', 'NOT_FOUND')
  }

  return task
}

function ensureProject(db: Database.Database, projectId: string | null | undefined) {
  if (projectId === null || projectId === undefined || projectId === '') {
    return null
  }

  const project = db
    .prepare<[string], { id: string; archived_at: string | null }>(
      'SELECT id, archived_at FROM projects WHERE id = ?',
    )
    .get(projectId)

  if (!project) {
    throw new TaskboardError('Project not found.', 'NOT_FOUND')
  }
  if (project.archived_at) {
    throw new TaskboardError('Archived projects cannot receive new tasks.', 'INVALID')
  }

  return project.id
}

function assertBotOwnsLock(task: LockedTaskRow, actor: MutableActor) {
  if (actor.kind !== 'bot') {
    return
  }

  if (task.locked_by_bot_id !== actor.id || !task.lock_expires_at || task.lock_expires_at <= now()) {
    throw new TaskboardError(
      'Claim this task before changing it. Another agent may own the lock.',
      'LOCKED',
    )
  }
}

function assertNotArchived(task: LockedTaskRow) {
  if (task.archived_at) {
    throw new TaskboardError('Unarchive this task before changing it.', 'CONFLICT')
  }
}

function nextSortOrder(db: Database.Database, status: TaskStatus) {
  const result = db
    .prepare<[TaskStatus], { next_sort_order: number }>(
      `SELECT COALESCE(MAX(sort_order), 0) + 1000 AS next_sort_order
       FROM tasks
       WHERE status = ? AND archived_at IS NULL`,
    )
    .get(status)
  return result?.next_sort_order ?? 1000
}

function getTaskRow(db: Database.Database, id: string) {
  return db
    .prepare<[string], TaskRow>(
      `${taskSelect}
       WHERE t.id = ?
       ${taskGroupBy}`,
    )
    .get(id)
}

function getTaskOrThrow(db: Database.Database, id: string) {
  const row = getTaskRow(db, id)
  if (!row) {
    throw new TaskboardError('Task not found.', 'NOT_FOUND')
  }
  return mapTask(row)
}

export function listTasks(filters: ListTaskFilters = {}): Task[] {
  const db = getDatabase()
  clearExpiredLocks(db)

  const clauses = ['1 = 1']
  const params: Record<string, string | number> = {}

  if (!filters.includeArchived) {
    clauses.push('t.archived_at IS NULL')
  }
  if (filters.status) {
    clauses.push('t.status = @status')
    params.status = filters.status
  }
  if (filters.projectId) {
    clauses.push('t.project_id = @projectId')
    params.projectId = filters.projectId
  }
  if (filters.search?.trim()) {
    clauses.push('(t.title LIKE @search OR t.description LIKE @search)')
    params.search = `%${filters.search.trim()}%`
  }

  const limit = Math.min(Math.max(filters.limit ?? 300, 1), 500)
  params.limit = limit

  const rows = db
    .prepare(
      `${taskSelect}
       WHERE ${clauses.join(' AND ')}
       ${taskGroupBy}
       ORDER BY t.sort_order DESC, t.updated_at DESC
       LIMIT @limit`,
    )
    .all(params) as TaskRow[]

  return rows.map(mapTask)
}

export function listProjects(): Project[] {
  const db = getDatabase()
  const rows = db
    .prepare(
      `SELECT
        p.id, p.name, p.description, p.color, p.archived_at, p.created_at, p.updated_at,
        COUNT(t.id) AS task_count
       FROM projects p
       LEFT JOIN tasks t ON t.project_id = p.id AND t.archived_at IS NULL
       GROUP BY p.id, p.name, p.description, p.color, p.archived_at, p.created_at, p.updated_at
       ORDER BY p.archived_at IS NOT NULL, p.name COLLATE NOCASE`,
    )
    .all() as ProjectRow[]

  return rows.map(mapProject)
}

export function listBots(): Bot[] {
  const db = getDatabase()
  clearExpiredLocks(db)
  const rows = db
    .prepare(
      `SELECT
        b.id, b.name, b.description, b.last_seen_at, b.created_at,
        COUNT(t.id) AS locked_task_count
       FROM bots b
       LEFT JOIN tasks t ON t.locked_by_bot_id = b.id
         AND t.lock_expires_at > ?
         AND t.archived_at IS NULL
       GROUP BY b.id, b.name, b.description, b.last_seen_at, b.created_at
       ORDER BY b.last_seen_at DESC, b.name COLLATE NOCASE`,
    )
    .all(now()) as BotRow[]

  return rows.map(mapBot)
}

export function listEvents(limit = 30, taskId?: string): TaskEvent[] {
  const db = getDatabase()
  const boundedLimit = Math.min(Math.max(limit, 1), 200)
  const rows = taskId
    ? (db
        .prepare(
          `SELECT
            e.id, e.task_id, t.title AS task_title, e.type,
            e.actor_kind, e.actor_id, e.actor_name, e.data, e.created_at
           FROM task_events e
           LEFT JOIN tasks t ON t.id = e.task_id
           WHERE e.task_id = ?
           ORDER BY e.created_at DESC
           LIMIT ?`,
        )
        .all(taskId, boundedLimit) as EventRow[])
    : (db
        .prepare(
          `SELECT
            e.id, e.task_id, t.title AS task_title, e.type,
            e.actor_kind, e.actor_id, e.actor_name, e.data, e.created_at
           FROM task_events e
           LEFT JOIN tasks t ON t.id = e.task_id
           ORDER BY e.created_at DESC
           LIMIT ?`,
        )
        .all(boundedLimit) as EventRow[])

  return rows.map(mapEvent)
}

export function getBoard(): BoardSnapshot {
  return {
    tasks: listTasks(),
    projects: listProjects(),
    events: listEvents(),
    bots: listBots(),
    generatedAt: now(),
  }
}

export function getArchivedBoard(): BoardSnapshot {
  const snapshot = getBoard()
  return {
    ...snapshot,
    tasks: listTasks({ includeArchived: true }).filter((task) => task.archivedAt !== null),
  }
}

export function getTask(id: string): TaskDetail {
  const db = getDatabase()
  clearExpiredLocks(db)
  const task = getTaskOrThrow(db, id)
  const comments = db
    .prepare<[string], CommentRow>(
      `SELECT id, task_id, body, actor_kind, actor_id, actor_name, created_at
       FROM task_comments
       WHERE task_id = ?
       ORDER BY created_at ASC`,
    )
    .all(id)
    .map(mapComment)

  return {
    task,
    comments,
    events: listEvents(100, id).reverse(),
  }
}

export function registerBot(input: { id: string; name: string; description?: string }): Bot {
  const db = getDatabase()
  const id = requireText(input.id, 'Bot ID', 100)
  const name = requireText(input.name, 'Bot name', 100)
  const description = optionalText(input.description, 'Bot description', 500)
  const timestamp = now()

  db.prepare(
    `INSERT INTO bots (id, name, description, last_seen_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       description = excluded.description,
       last_seen_at = excluded.last_seen_at,
       updated_at = excluded.updated_at`,
  ).run(id, name, description, timestamp, timestamp, timestamp)

  const bot = listBots().find((candidate) => candidate.id === id)
  if (!bot) {
    throw new TaskboardError('Bot registration failed.', 'CONFLICT')
  }
  return bot
}

export function createProject(input: CreateProjectInput, actor: MutableActor): Project {
  const db = getDatabase()
  const name = requireText(input.name, 'Project name', 120)
  const description = optionalText(input.description, 'Project description', 2000)
  const color = input.color?.trim() || '#7c3aed'
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
    throw new TaskboardError('Project color must be a six-digit hex color.', 'INVALID')
  }

  const projectId = randomUUID()
  const timestamp = now()
  const savedActor = ensureActor(db, actor)

  db.transaction(() => {
    const duplicate = db
      .prepare<[string], { id: string }>('SELECT id FROM projects WHERE name = ?')
      .get(name)
    if (duplicate) {
      throw new TaskboardError('A project with that name already exists.', 'CONFLICT')
    }

    db.prepare(
      `INSERT INTO projects (id, name, description, color, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(projectId, name, description, color, timestamp, timestamp)

    writeEvent(db, {
      taskId: null,
      type: 'project_created',
      actor: savedActor,
      data: { projectId, name },
      createdAt: timestamp,
    })
  })()

  const project = listProjects().find((candidate) => candidate.id === projectId)
  if (!project) {
    throw new TaskboardError('Project creation failed.', 'CONFLICT')
  }
  return project
}

export function createTask(input: CreateTaskInput, actor: MutableActor): TaskDetail {
  const db = getDatabase()
  const taskId = randomUUID()
  const title = requireText(input.title, 'Task title', 240)
  const description = optionalText(input.description, 'Task description', 10000)
  const status = input.status ?? 'inbox'
  const timestamp = now()
  const savedActor = ensureActor(db, actor)

  if (!isTaskStatus(status)) {
    throw new TaskboardError('Task status is invalid.', 'INVALID')
  }

  db.transaction(() => {
    const projectId = ensureProject(db, input.projectId)
    const sortOrder = nextSortOrder(db, status)

    db.prepare(
      `INSERT INTO tasks (
        id, title, description, status, project_id, sort_order, completed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      taskId,
      title,
      description,
      status,
      projectId,
      sortOrder,
      status === 'complete' ? timestamp : null,
      timestamp,
      timestamp,
    )

    writeEvent(db, {
      taskId,
      type: 'task_created',
      actor: savedActor,
      data: { status, projectId },
      createdAt: timestamp,
    })
  }).immediate()

  return getTask(taskId)
}

export function updateTask(input: UpdateTaskInput, actor: MutableActor): TaskDetail {
  const db = getDatabase()
  const hasChange =
    input.title !== undefined ||
    input.description !== undefined ||
    input.status !== undefined ||
    input.projectId !== undefined
  if (!hasChange) {
    throw new TaskboardError('Provide at least one task change.', 'INVALID')
  }

  const taskId = requireText(input.id, 'Task ID', 100)
  const savedActor = ensureActor(db, actor)

  db.transaction(() => {
    const existing = getLockedTask(db, taskId)
    assertNotArchived(existing)
    assertBotOwnsLock(existing, savedActor)

    const timestamp = now()
    const assignments: string[] = ['updated_at = @updatedAt']
    const params: Record<string, string | number | null> = {
      id: taskId,
      updatedAt: timestamp,
    }
    const changedFields: string[] = []

    if (input.title !== undefined) {
      params.title = requireText(input.title, 'Task title', 240)
      assignments.push('title = @title')
      if (params.title !== existing.title) {
        changedFields.push('title')
      }
    }

    if (input.description !== undefined) {
      params.description = optionalText(input.description, 'Task description', 10000)
      assignments.push('description = @description')
      changedFields.push('description')
    }

    if (input.projectId !== undefined) {
      params.projectId = ensureProject(db, input.projectId)
      assignments.push('project_id = @projectId')
      if (params.projectId !== existing.project_id) {
        changedFields.push('project')
      }
    }

    if (input.status !== undefined) {
      if (!isTaskStatus(input.status)) {
        throw new TaskboardError('Task status is invalid.', 'INVALID')
      }
      params.status = input.status
      assignments.push('status = @status')
      assignments.push('sort_order = @sortOrder')
      assignments.push('completed_at = @completedAt')
      params.sortOrder = nextSortOrder(db, input.status)
      params.completedAt = input.status === 'complete' ? timestamp : null

      if (input.status !== existing.status) {
        writeEvent(db, {
          taskId,
          type: 'status_changed',
          actor: savedActor,
          data: { from: existing.status, to: input.status },
          createdAt: timestamp,
        })
      }
    }

    db.prepare(`UPDATE tasks SET ${assignments.join(', ')} WHERE id = @id`).run(params)

    if (changedFields.length > 0) {
      writeEvent(db, {
        taskId,
        type: 'task_updated',
        actor: savedActor,
        data: { fields: changedFields },
        createdAt: timestamp,
      })
    }

    if (input.status === 'complete' && existing.locked_by_bot_id) {
      db.prepare(
        `UPDATE tasks
         SET locked_by_bot_id = NULL, lock_expires_at = NULL
         WHERE id = ?`,
      ).run(taskId)
      writeEvent(db, {
        taskId,
        type: 'lock_released',
        actor: savedActor,
        data: { reason: 'completed' },
        createdAt: timestamp,
      })
    }
  }).immediate()

  return getTask(taskId)
}

export function archiveTask(taskId: string, actor: MutableActor): TaskDetail {
  const db = getDatabase()
  const id = requireText(taskId, 'Task ID', 100)
  const savedActor = ensureActor(db, actor)

  db.transaction(() => {
    const task = getLockedTask(db, id)
    assertNotArchived(task)
    assertBotOwnsLock(task, savedActor)
    const timestamp = now()

    db.prepare(
      `UPDATE tasks
       SET archived_at = ?, locked_by_bot_id = NULL, lock_expires_at = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(timestamp, timestamp, id)

    writeEvent(db, {
      taskId: id,
      type: 'task_archived',
      actor: savedActor,
      createdAt: timestamp,
    })
  }).immediate()

  return getTask(id)
}

export function unarchiveTask(taskId: string, actor: MutableActor): TaskDetail {
  const db = getDatabase()
  const id = requireText(taskId, 'Task ID', 100)
  const savedActor = ensureActor(db, actor)

  db.transaction(() => {
    const task = getLockedTask(db, id)
    if (!task.archived_at) {
      throw new TaskboardError('Task is already active.', 'CONFLICT')
    }
    const timestamp = now()

    db.prepare(
      `UPDATE tasks
       SET archived_at = NULL, updated_at = ?, sort_order = ?
       WHERE id = ?`,
    ).run(timestamp, nextSortOrder(db, task.status), id)

    writeEvent(db, {
      taskId: id,
      type: 'task_unarchived',
      actor: savedActor,
      createdAt: timestamp,
    })
  }).immediate()

  return getTask(id)
}

export function addComment(
  input: { taskId: string; body: string },
  actor: MutableActor,
): TaskComment {
  const db = getDatabase()
  const taskId = requireText(input.taskId, 'Task ID', 100)
  const body = requireText(input.body, 'Comment', 5000)
  const commentId = randomUUID()
  const timestamp = now()
  const savedActor = ensureActor(db, actor)

  db.transaction(() => {
    const task = getLockedTask(db, taskId)
    assertNotArchived(task)
    assertBotOwnsLock(task, savedActor)

    db.prepare(
      `INSERT INTO task_comments (
        id, task_id, body, actor_kind, actor_id, actor_name, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      commentId,
      taskId,
      body,
      savedActor.kind,
      savedActor.id,
      savedActor.name,
      timestamp,
    )

    db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(timestamp, taskId)
    writeEvent(db, {
      taskId,
      type: 'comment_added',
      actor: savedActor,
      data: { commentId },
      createdAt: timestamp,
    })
  }).immediate()

  const comment = db
    .prepare<[string], CommentRow>(
      `SELECT id, task_id, body, actor_kind, actor_id, actor_name, created_at
       FROM task_comments
       WHERE id = ?`,
    )
    .get(commentId)
  if (!comment) {
    throw new TaskboardError('Comment creation failed.', 'CONFLICT')
  }
  return mapComment(comment)
}

export function claimTask(
  input: { taskId: string; minutes?: number },
  actor: MutableActor,
): TaskDetail {
  if (actor.kind !== 'bot') {
    throw new TaskboardError('Only a bot can claim a task lock.', 'INVALID')
  }

  const db = getDatabase()
  const taskId = requireText(input.taskId, 'Task ID', 100)
  const savedActor = ensureActor(db, actor)
  const minutes = Math.min(Math.max(Math.floor(input.minutes ?? 30), 5), 120)

  db.transaction(() => {
    const task = getLockedTask(db, taskId)
    assertNotArchived(task)
    if (task.status === 'complete') {
      throw new TaskboardError('Reopen a completed task before claiming it.', 'CONFLICT')
    }

    const timestamp = now()
    if (
      task.locked_by_bot_id &&
      task.locked_by_bot_id !== savedActor.id &&
      task.lock_expires_at &&
      task.lock_expires_at > timestamp
    ) {
      throw new TaskboardError('Another bot currently holds this task lock.', 'LOCKED')
    }

    const expiresAt = new Date(Date.now() + minutes * 60_000).toISOString()
    db.prepare(
      `UPDATE tasks
       SET locked_by_bot_id = ?, lock_expires_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(savedActor.id, expiresAt, timestamp, taskId)

    writeEvent(db, {
      taskId,
      type: task.locked_by_bot_id === savedActor.id ? 'lock_renewed' : 'task_claimed',
      actor: savedActor,
      data: { expiresAt },
      createdAt: timestamp,
    })

    if (task.status !== 'in_progress') {
      db.prepare(
        `UPDATE tasks
         SET status = 'in_progress', sort_order = ?, completed_at = NULL, updated_at = ?
         WHERE id = ?`,
      ).run(nextSortOrder(db, 'in_progress'), timestamp, taskId)
      writeEvent(db, {
        taskId,
        type: 'status_changed',
        actor: savedActor,
        data: { from: task.status, to: 'in_progress' },
        createdAt: timestamp,
      })
    }
  }).immediate()

  return getTask(taskId)
}

export function renewTaskLock(
  input: { taskId: string; minutes?: number },
  actor: MutableActor,
): TaskDetail {
  if (actor.kind !== 'bot') {
    throw new TaskboardError('Only a bot can renew a task lock.', 'INVALID')
  }

  const db = getDatabase()
  const taskId = requireText(input.taskId, 'Task ID', 100)
  const savedActor = ensureActor(db, actor)
  const minutes = Math.min(Math.max(Math.floor(input.minutes ?? 30), 5), 120)

  db.transaction(() => {
    const task = getLockedTask(db, taskId)
    assertNotArchived(task)
    assertBotOwnsLock(task, savedActor)
    const timestamp = now()
    const expiresAt = new Date(Date.now() + minutes * 60_000).toISOString()

    db.prepare(
      `UPDATE tasks
       SET lock_expires_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(expiresAt, timestamp, taskId)
    writeEvent(db, {
      taskId,
      type: 'lock_renewed',
      actor: savedActor,
      data: { expiresAt },
      createdAt: timestamp,
    })
  }).immediate()

  return getTask(taskId)
}

export function releaseTaskLock(taskId: string, actor: MutableActor): TaskDetail {
  if (actor.kind !== 'bot') {
    throw new TaskboardError('Only a bot can release a task lock.', 'INVALID')
  }

  const db = getDatabase()
  const id = requireText(taskId, 'Task ID', 100)
  const savedActor = ensureActor(db, actor)

  db.transaction(() => {
    const task = getLockedTask(db, id)
    assertNotArchived(task)
    assertBotOwnsLock(task, savedActor)
    const timestamp = now()

    db.prepare(
      `UPDATE tasks
       SET locked_by_bot_id = NULL, lock_expires_at = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(timestamp, id)
    writeEvent(db, {
      taskId: id,
      type: 'lock_released',
      actor: savedActor,
      createdAt: timestamp,
    })
  }).immediate()

  return getTask(id)
}
