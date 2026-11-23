export const TASK_STATUSES = [
  'inbox',
  'backlog',
  'ready',
  'in_progress',
  'blocked',
  'complete',
] as const

export type TaskStatus = (typeof TASK_STATUSES)[number]

export const STATUS_META: Record<
  TaskStatus,
  { label: string; shortLabel: string; accent: string }
> = {
  inbox: { label: 'Inbox', shortLabel: 'Inbox', accent: 'slate' },
  backlog: { label: 'Backlog', shortLabel: 'Backlog', accent: 'violet' },
  ready: { label: 'Ready', shortLabel: 'Ready', accent: 'sky' },
  in_progress: {
    label: 'In progress',
    shortLabel: 'In progress',
    accent: 'amber',
  },
  blocked: { label: 'Blocked', shortLabel: 'Blocked', accent: 'rose' },
  complete: { label: 'Complete', shortLabel: 'Done', accent: 'emerald' },
}

export type ActorKind = 'user' | 'bot' | 'system'

export interface Actor {
  id: string
  name: string
  kind: ActorKind
}

export interface Project {
  id: string
  name: string
  description: string
  color: string
  archivedAt: string | null
  createdAt: string
  updatedAt: string
  taskCount: number
}

export interface TaskLock {
  botId: string
  botName: string
  expiresAt: string
}

export interface Task {
  id: string
  title: string
  description: string
  status: TaskStatus
  project: Pick<Project, 'id' | 'name' | 'color'> | null
  sortOrder: number
  archivedAt: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
  lock: TaskLock | null
  commentCount: number
}

export interface TaskComment {
  id: string
  taskId: string
  body: string
  actor: Actor
  createdAt: string
}

export type EventData = Record<
  string,
  string | number | boolean | null | readonly string[]
>

export interface TaskEvent {
  id: string
  taskId: string | null
  taskTitle: string | null
  type: string
  actor: Actor
  data: EventData
  createdAt: string
}

export interface TaskDetail {
  task: Task
  comments: TaskComment[]
  events: TaskEvent[]
}

export interface Bot {
  id: string
  name: string
  description: string
  lastSeenAt: string | null
  createdAt: string
  lockedTaskCount: number
}

export interface BoardSnapshot {
  tasks: Task[]
  projects: Project[]
  events: TaskEvent[]
  bots: Bot[]
  generatedAt: string
}
