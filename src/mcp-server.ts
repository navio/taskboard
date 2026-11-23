import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { TASK_STATUSES, type TaskStatus } from './shared/types'
import {
  TaskboardError,
  addComment,
  archiveTask,
  claimTask,
  createProject,
  createTask,
  getTask,
  listBots,
  listProjects,
  listTasks,
  registerBot,
  releaseTaskLock,
  renewTaskLock,
  unarchiveTask,
  updateTask,
} from './server/task-service'

export type BotIdentity = {
  id: string
  name: string
  description?: string
}

const taskStatusSchema = z.enum(TASK_STATUSES)

function textResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  }
}

function errorResult(error: unknown) {
  const message =
    error instanceof TaskboardError
      ? error.message
      : error instanceof Error
        ? error.message
        : 'The taskboard could not complete this request.'

  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true,
  }
}

export function createTaskboardMcpServer(bot: BotIdentity) {
  registerBot(bot)

  const server = new McpServer({
    name: 'local-taskboard',
    version: '0.1.0',
  })

  const run = async (operation: () => unknown | Promise<unknown>) => {
    try {
      registerBot(bot)
      return textResult(await operation())
    } catch (error) {
      return errorResult(error)
    }
  }

  server.registerTool(
    'list_tasks',
    {
      title: 'List tasks',
      description:
        'List local taskboard tasks. Locked tasks include the bot currently working on them.',
      inputSchema: z.object({
        status: taskStatusSchema.optional(),
        project_id: z.string().min(1).max(100).optional(),
        include_archived: z.boolean().optional(),
        search: z.string().max(240).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
    },
    ({ status, project_id, include_archived, search, limit }) =>
      run(() =>
        listTasks({
          status,
          projectId: project_id,
          includeArchived: include_archived,
          search,
          limit,
        }),
      ),
  )

  server.registerTool(
    'get_task',
    {
      title: 'Get task details',
      description: 'Read a task, its comments, its status history, and any active bot lock.',
      inputSchema: z.object({ task_id: z.string().min(1).max(100) }),
    },
    ({ task_id }) => run(() => getTask(task_id)),
  )

  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description: 'List projects available for task grouping. Tasks may also have no project.',
    },
    () => run(() => listProjects()),
  )

  server.registerTool(
    'create_project',
    {
      title: 'Create project',
      description: 'Create a local project for grouping tasks.',
      inputSchema: z.object({
        name: z.string().min(1).max(120),
        description: z.string().max(2000).optional(),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      }),
    },
    ({ name, description, color }) =>
      run(() => createProject({ name, description, color }, { ...bot, kind: 'bot' })),
  )

  server.registerTool(
    'create_task',
    {
      title: 'Create task',
      description:
        'Create a task in Inbox, Backlog, Ready, In progress, Blocked, or Complete. New tasks are not locked until claimed.',
      inputSchema: z.object({
        title: z.string().min(1).max(240),
        description: z.string().max(10_000).optional(),
        status: taskStatusSchema.optional(),
        project_id: z.string().min(1).max(100).nullable().optional(),
      }),
    },
    ({ title, description, status, project_id }) =>
      run(() =>
        createTask(
          { title, description, status, projectId: project_id },
          { ...bot, kind: 'bot' },
        ),
      ),
  )

  server.registerTool(
    'claim_task',
    {
      title: 'Claim task',
      description:
        'Atomically lock a task for this bot and move it to In progress. Claim before updating or commenting so other bots do not take it.',
      inputSchema: z.object({
        task_id: z.string().min(1).max(100),
        minutes: z.number().int().min(5).max(120).optional(),
      }),
    },
    ({ task_id, minutes }) =>
      run(() => claimTask({ taskId: task_id, minutes }, { ...bot, kind: 'bot' })),
  )

  server.registerTool(
    'renew_task_lock',
    {
      title: 'Renew task lock',
      description: 'Extend this bot’s active task lock while work is still in progress.',
      inputSchema: z.object({
        task_id: z.string().min(1).max(100),
        minutes: z.number().int().min(5).max(120).optional(),
      }),
    },
    ({ task_id, minutes }) =>
      run(() => renewTaskLock({ taskId: task_id, minutes }, { ...bot, kind: 'bot' })),
  )

  server.registerTool(
    'update_task',
    {
      title: 'Update claimed task',
      description:
        'Update the title, description, project, or progress state of a task claimed by this bot. Completing a task releases its lock.',
      inputSchema: z
        .object({
          task_id: z.string().min(1).max(100),
          title: z.string().min(1).max(240).optional(),
          description: z.string().max(10_000).optional(),
          status: taskStatusSchema.optional(),
          project_id: z.string().min(1).max(100).nullable().optional(),
        })
        .refine(
          (input) =>
            input.title !== undefined ||
            input.description !== undefined ||
            input.status !== undefined ||
            input.project_id !== undefined,
          { message: 'Provide at least one task change.' },
        ),
    },
    ({ task_id, title, description, status, project_id }) =>
      run(() =>
        updateTask(
          {
            id: task_id,
            title,
            description,
            status: status as TaskStatus | undefined,
            projectId: project_id,
          },
          { ...bot, kind: 'bot' },
        ),
      ),
  )

  server.registerTool(
    'add_task_comment',
    {
      title: 'Comment on claimed task',
      description: 'Add a progress note to a task claimed by this bot.',
      inputSchema: z.object({
        task_id: z.string().min(1).max(100),
        body: z.string().min(1).max(5000),
      }),
    },
    ({ task_id, body }) =>
      run(() => addComment({ taskId: task_id, body }, { ...bot, kind: 'bot' })),
  )

  server.registerTool(
    'release_task_lock',
    {
      title: 'Release task lock',
      description: 'Release this bot’s lock when it is no longer working on the task.',
      inputSchema: z.object({ task_id: z.string().min(1).max(100) }),
    },
    ({ task_id }) => run(() => releaseTaskLock(task_id, { ...bot, kind: 'bot' })),
  )

  server.registerTool(
    'archive_task',
    {
      title: 'Archive claimed task',
      description: 'Archive a task claimed by this bot. Archiving also releases the lock.',
      inputSchema: z.object({ task_id: z.string().min(1).max(100) }),
    },
    ({ task_id }) => run(() => archiveTask(task_id, { ...bot, kind: 'bot' })),
  )

  server.registerTool(
    'unarchive_task',
    {
      title: 'Unarchive task',
      description: 'Restore an archived task to its previous progress state.',
      inputSchema: z.object({ task_id: z.string().min(1).max(100) }),
    },
    ({ task_id }) => run(() => unarchiveTask(task_id, { ...bot, kind: 'bot' })),
  )

  server.registerTool(
    'list_bots',
    {
      title: 'List bots',
      description: 'See registered MCP bots and their active task-lock counts.',
    },
    () => run(() => listBots()),
  )

  return server
}
