import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDatabase } from './db'
import {
  TaskboardError,
  addComment,
  archiveTask,
  claimTask,
  createTask,
  getTask,
  listTasks,
  unarchiveTask,
  updateTask,
} from './task-service'

const user = { id: 'test-user', name: 'Test user', kind: 'user' as const }
const firstBot = { id: 'first-bot', name: 'First bot', kind: 'bot' as const }
const secondBot = { id: 'second-bot', name: 'Second bot', kind: 'bot' as const }

let databaseDirectory = ''
let previousDatabasePath: string | undefined
let previousSeedSetting: string | undefined

beforeEach(() => {
  previousDatabasePath = process.env.TASKBOARD_DB_PATH
  previousSeedSetting = process.env.TASKBOARD_SEED
  databaseDirectory = mkdtempSync(join(tmpdir(), 'taskboard-test-'))
  process.env.TASKBOARD_DB_PATH = join(databaseDirectory, 'taskboard.sqlite')
  process.env.TASKBOARD_SEED = 'false'
  closeDatabase()
})

afterEach(() => {
  closeDatabase()
  rmSync(databaseDirectory, { recursive: true, force: true })
  if (previousDatabasePath === undefined) {
    delete process.env.TASKBOARD_DB_PATH
  } else {
    process.env.TASKBOARD_DB_PATH = previousDatabasePath
  }
  if (previousSeedSetting === undefined) {
    delete process.env.TASKBOARD_SEED
  } else {
    process.env.TASKBOARD_SEED = previousSeedSetting
  }
})

describe('task service', () => {
  it('prevents a second bot from changing a claimed task', () => {
    const created = createTask({ title: 'Coordinate release', status: 'ready' }, user)

    const claimed = claimTask({ taskId: created.task.id, minutes: 10 }, firstBot)
    expect(claimed.task.status).toBe('in_progress')
    expect(claimed.task.lock?.botId).toBe(firstBot.id)

    expect(() =>
      updateTask({ id: created.task.id, status: 'blocked' }, secondBot),
    ).toThrow(TaskboardError)

    addComment(
      { taskId: created.task.id, body: 'Validating the release path now.' },
      firstBot,
    )
    const completed = updateTask({ id: created.task.id, status: 'complete' }, firstBot)

    expect(completed.task.status).toBe('complete')
    expect(completed.task.lock).toBeNull()
    expect(completed.comments).toHaveLength(1)
    expect(completed.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['task_claimed', 'comment_added', 'status_changed', 'lock_released']),
    )
  })

  it('archives and restores a task without deleting its history', () => {
    const created = createTask({ title: 'Keep the audit trail', status: 'backlog' }, user)

    archiveTask(created.task.id, user)
    expect(listTasks()).toHaveLength(0)
    expect(getTask(created.task.id).task.archivedAt).not.toBeNull()

    const restored = unarchiveTask(created.task.id, user)
    expect(restored.task.archivedAt).toBeNull()
    expect(restored.task.status).toBe('backlog')
    expect(restored.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['task_archived', 'task_unarchived']),
    )
  })
})
