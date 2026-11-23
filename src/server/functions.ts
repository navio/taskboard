import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { TASK_STATUSES } from '../shared/types'

const taskStatusSchema = z.enum(TASK_STATUSES)

const userActorSchema = z.object({
  id: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(100),
  kind: z.literal('user'),
})

const taskIdSchema = z.string().trim().min(1).max(100)
const projectIdSchema = z.string().trim().min(1).max(100)

const createTaskSchema = z.object({
  title: z.string().trim().min(1).max(240),
  description: z.string().max(10_000).optional(),
  status: taskStatusSchema.optional(),
  projectId: projectIdSchema.nullable().optional(),
  actor: userActorSchema,
})

const updateTaskSchema = z
  .object({
    id: taskIdSchema,
    title: z.string().trim().min(1).max(240).optional(),
    description: z.string().max(10_000).optional(),
    status: taskStatusSchema.optional(),
    projectId: projectIdSchema.nullable().optional(),
    actor: userActorSchema,
  })
  .refine(
    (input) =>
      input.title !== undefined ||
      input.description !== undefined ||
      input.status !== undefined ||
      input.projectId !== undefined,
    { message: 'Provide at least one task change.' },
  )

const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  actor: userActorSchema,
})

const taskActionSchema = z.object({
  id: taskIdSchema,
  actor: userActorSchema,
})

const addCommentSchema = z.object({
  taskId: taskIdSchema,
  body: z.string().trim().min(1).max(5000),
  actor: userActorSchema,
})

export const getBoard = createServerFn({ method: 'GET' }).handler(async () => {
  const service = await import('./task-service')
  return service.getBoard()
})

export const getArchivedBoard = createServerFn({ method: 'GET' }).handler(
  async () => {
    const service = await import('./task-service')
    return service.getArchivedBoard()
  },
)

export const getTask = createServerFn({ method: 'GET' })
  .validator(z.object({ id: taskIdSchema }))
  .handler(async ({ data }) => {
    const service = await import('./task-service')
    return service.getTask(data.id)
  })

export const createTask = createServerFn({ method: 'POST' })
  .validator(createTaskSchema)
  .handler(async ({ data }) => {
    const service = await import('./task-service')
    return service.createTask(data, data.actor)
  })

export const updateTask = createServerFn({ method: 'POST' })
  .validator(updateTaskSchema)
  .handler(async ({ data }) => {
    const service = await import('./task-service')
    return service.updateTask(data, data.actor)
  })

export const archiveTask = createServerFn({ method: 'POST' })
  .validator(taskActionSchema)
  .handler(async ({ data }) => {
    const service = await import('./task-service')
    return service.archiveTask(data.id, data.actor)
  })

export const unarchiveTask = createServerFn({ method: 'POST' })
  .validator(taskActionSchema)
  .handler(async ({ data }) => {
    const service = await import('./task-service')
    return service.unarchiveTask(data.id, data.actor)
  })

export const addTaskComment = createServerFn({ method: 'POST' })
  .validator(addCommentSchema)
  .handler(async ({ data }) => {
    const service = await import('./task-service')
    return service.addComment(data, data.actor)
  })

export const createProject = createServerFn({ method: 'POST' })
  .validator(createProjectSchema)
  .handler(async ({ data }) => {
    const service = await import('./task-service')
    return service.createProject(data, data.actor)
  })
