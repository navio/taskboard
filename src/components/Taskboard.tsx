import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import {
  type DragEvent,
  type FormEvent,
  useEffect,
  useMemo,
  useState,
} from 'react'
import {
  STATUS_META,
  TASK_STATUSES,
  type Actor,
  type Project,
  type Task,
  type TaskDetail,
  type TaskEvent,
  type TaskStatus,
} from '../shared/types'
import {
  addTaskComment,
  archiveTask,
  createProject,
  createTask,
  getArchivedBoard,
  getBoard,
  getTask,
  unarchiveTask,
  updateTask,
} from '../server/functions'

type View = 'board' | 'activity' | 'archive'

type TaskDraft = {
  title: string
  description: string
  status: TaskStatus
  projectId: string | null
}

type UserActor = Actor & { kind: 'user' }

const defaultActor: UserActor = {
  id: 'local-user',
  name: 'You',
  kind: 'user',
}

const nordProjectColors = [
  { value: '#5E81AC', label: 'Frost blue' },
  { value: '#88C0D0', label: 'Frost cyan' },
  { value: '#8FBCBB', label: 'Frost teal' },
  { value: '#B48EAD', label: 'Aurora purple' },
  { value: '#D08770', label: 'Aurora orange' },
  { value: '#A3BE8C', label: 'Aurora green' },
] as const

export function Taskboard() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 1_000,
            retry: 1,
            refetchOnWindowFocus: true,
          },
        },
      }),
  )

  return (
    <QueryClientProvider client={queryClient}>
      <TaskboardContent />
    </QueryClientProvider>
  )
}

function TaskboardContent() {
  const queryClient = useQueryClient()
  const activeBoard = useServerFn(getBoard)
  const archivedBoard = useServerFn(getArchivedBoard)
  const taskDetails = useServerFn(getTask)
  const createTaskAction = useServerFn(createTask)
  const updateTaskAction = useServerFn(updateTask)
  const archiveTaskAction = useServerFn(archiveTask)
  const unarchiveTaskAction = useServerFn(unarchiveTask)
  const addCommentAction = useServerFn(addTaskComment)
  const createProjectAction = useServerFn(createProject)

  const [actor, setActor] = useLocalActor()
  const [view, setView] = useState<View>('board')
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [projectFilter, setProjectFilter] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [createTaskOpen, setCreateTaskOpen] = useState(false)
  const [createProjectOpen, setCreateProjectOpen] = useState(false)
  const [mcpOpen, setMcpOpen] = useState(false)
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  const boardQuery = useQuery({
    queryKey: ['board', view],
    queryFn: () => (view === 'archive' ? archivedBoard() : activeBoard()),
    refetchInterval: 3_000,
  })

  const detailQuery = useQuery({
    queryKey: ['task', selectedTaskId],
    queryFn: () => taskDetails({ data: { id: selectedTaskId ?? '' } }),
    enabled: selectedTaskId !== null,
    refetchInterval: selectedTaskId ? 3_000 : false,
  })

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['board'] }),
      queryClient.invalidateQueries({ queryKey: ['task'] }),
    ])
  }

  const createTaskMutation = useMutation({
    mutationFn: (draft: TaskDraft) =>
      createTaskAction({
        data: {
          ...draft,
          actor,
        },
      }),
    onSuccess: async (detail) => {
      setCreateTaskOpen(false)
      setSelectedTaskId(detail.task.id)
      setNotice('Task created.')
      await refresh()
    },
    onError: (error) => setNotice(errorMessage(error)),
  })

  const updateTaskMutation = useMutation({
    mutationFn: (input: TaskDraft & { id: string }) =>
      updateTaskAction({
        data: {
          ...input,
          actor,
        },
      }),
    onSuccess: async () => {
      setNotice('Task updated.')
      await refresh()
    },
    onError: (error) => setNotice(errorMessage(error)),
  })

  const archiveMutation = useMutation({
    mutationFn: (id: string) => archiveTaskAction({ data: { id, actor } }),
    onSuccess: async () => {
      setSelectedTaskId(null)
      setNotice('Task archived.')
      await refresh()
    },
    onError: (error) => setNotice(errorMessage(error)),
  })

  const unarchiveMutation = useMutation({
    mutationFn: (id: string) => unarchiveTaskAction({ data: { id, actor } }),
    onSuccess: async () => {
      setNotice('Task restored to the board.')
      await refresh()
    },
    onError: (error) => setNotice(errorMessage(error)),
  })

  const commentMutation = useMutation({
    mutationFn: (input: { taskId: string; body: string }) =>
      addCommentAction({
        data: {
          ...input,
          actor,
        },
      }),
    onSuccess: async () => {
      setNotice('Comment added.')
      await refresh()
    },
    onError: (error) => setNotice(errorMessage(error)),
  })

  const createProjectMutation = useMutation({
    mutationFn: (input: { name: string; description: string; color: string }) =>
      createProjectAction({
        data: {
          ...input,
          actor,
        },
      }),
    onSuccess: async (project) => {
      setCreateProjectOpen(false)
      setProjectFilter(project.id)
      setNotice('Project created.')
      await refresh()
    },
    onError: (error) => setNotice(errorMessage(error)),
  })

  const board = boardQuery.data
  const tasks = useMemo(() => {
    if (!board) {
      return []
    }

    const normalizedSearch = search.trim().toLowerCase()
    return board.tasks.filter((task) => {
      const matchesProject = !projectFilter || task.project?.id === projectFilter
      const matchesSearch =
        !normalizedSearch ||
        task.title.toLowerCase().includes(normalizedSearch) ||
        task.description.toLowerCase().includes(normalizedSearch)
      return matchesProject && matchesSearch
    })
  }, [board, projectFilter, search])

  const taskCounts = useMemo(() => {
    const counts = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0])) as Record<
      TaskStatus,
      number
    >
    for (const task of tasks) {
      counts[task.status] += 1
    }
    return counts
  }, [tasks])

  const selectedTask = detailQuery.data
  const isMutating =
    createTaskMutation.isPending ||
    updateTaskMutation.isPending ||
    archiveMutation.isPending ||
    unarchiveMutation.isPending ||
    commentMutation.isPending

  function openBoard() {
    setView('board')
    setProjectFilter(null)
    setSelectedTaskId(null)
  }

  function openActivity() {
    setView('activity')
    setProjectFilter(null)
    setSelectedTaskId(null)
  }

  function openArchive() {
    setView('archive')
    setSelectedTaskId(null)
  }

  function moveTask(taskId: string, status: TaskStatus) {
    const task = board?.tasks.find((candidate) => candidate.id === taskId)
    if (!task || task.status === status) {
      return
    }
    updateTaskMutation.mutate({
      id: taskId,
      title: task.title,
      description: task.description,
      projectId: task.project?.id ?? null,
      status,
    })
  }

  function handleDrop(event: DragEvent<HTMLElement>, status: TaskStatus) {
    event.preventDefault()
    const taskId = event.dataTransfer.getData('text/task-id') || draggedTaskId
    setDraggedTaskId(null)
    if (taskId) {
      moveTask(taskId, status)
    }
  }

  return (
    <main className="app-shell">
      <aside
        className={`sidebar ${menuOpen ? 'is-expanded' : ''}`}
        aria-label="Taskboard navigation"
      >
        <div className="brand">
          <span className="brand-mark">T</span>
          <span>Taskboard</span>
        </div>

        <div className="sidebar-bar">
          <nav className="nav-list">
          <button
            className={`nav-item ${view === 'board' && !projectFilter ? 'is-active' : ''}`}
            aria-current={view === 'board' && !projectFilter ? 'page' : undefined}
            onClick={openBoard}
            type="button"
          >
            <span>▦</span>
            Board
            <strong>{board?.tasks.length ?? 0}</strong>
          </button>
          <button
            className={`nav-item ${view === 'activity' ? 'is-active' : ''}`}
            aria-current={view === 'activity' ? 'page' : undefined}
            onClick={openActivity}
            type="button"
          >
            <span>◌</span>
            Activity
            <strong>{board?.events.length ?? 0}</strong>
          </button>
          <button
            className={`nav-item ${view === 'archive' ? 'is-active' : ''}`}
            aria-current={view === 'archive' ? 'page' : undefined}
            onClick={openArchive}
            type="button"
          >
            <span>⌫</span>
            Archive
          </button>
          </nav>
          <button
            className="sidebar-toggle"
            type="button"
            aria-expanded={menuOpen}
            aria-controls="sidebar-drawer"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span className="sr-only">{menuOpen ? 'Close menu' : 'Open menu'}</span>
            {menuOpen ? '×' : '☰'}
          </button>
        </div>

        <div className="sidebar-drawer" id="sidebar-drawer">
        <div className="identity-card">
          <span className="identity-dot" />
          <div>
            <span className="eyebrow">LOCAL USER</span>
            <label className="identity-name" htmlFor="local-user-name">
              <span className="sr-only">Your local name</span>
              <input
                id="local-user-name"
                value={actor.name}
                maxLength={100}
                onChange={(event) => setActorName(setActor, event.target.value)}
              />
            </label>
          </div>
        </div>

        <section className="sidebar-section">
          <div className="section-heading">
            <span>PROJECTS</span>
            <button
              className="icon-button"
              type="button"
              title="Create project"
              onClick={() => setCreateProjectOpen(true)}
            >
              +
            </button>
          </div>
          <div className="project-list">
            {board?.projects.filter((project) => !project.archivedAt).map((project) => (
              <button
                className={`project-item ${projectFilter === project.id && view === 'board' ? 'is-active' : ''}`}
                key={project.id}
                onClick={() => {
                  setView('board')
                  setProjectFilter(project.id)
                  setSelectedTaskId(null)
                  setMenuOpen(false)
                }}
                type="button"
              >
                <span className="project-color" style={{ backgroundColor: project.color }} />
                <span>{project.name}</span>
                <small>{project.taskCount}</small>
              </button>
            ))}
            {!board?.projects.length ? <p className="sidebar-empty">No projects yet.</p> : null}
          </div>
        </section>

        <section className="sidebar-section agents-section">
          <div className="section-heading">
            <span>AGENTS</span>
            <button className="text-button" onClick={() => setMcpOpen(true)} type="button">
              MCP
            </button>
          </div>
          <div className="agent-list">
            {board?.bots.slice(0, 4).map((bot) => (
              <div className="agent-item" key={bot.id}>
                <span className="bot-avatar">{bot.name.slice(0, 1).toUpperCase()}</span>
                <span>
                  <b>{bot.name}</b>
                  <small>
                    {bot.lockedTaskCount
                      ? `${bot.lockedTaskCount} task${bot.lockedTaskCount === 1 ? '' : 's'} locked`
                      : 'Available'}
                  </small>
                </span>
              </div>
            ))}
            {!board?.bots.length ? (
              <button className="empty-agent" onClick={() => setMcpOpen(true)} type="button">
                Connect your first agent →
              </button>
            ) : null}
          </div>
        </section>

        <button
          className="mcp-launcher"
          onClick={() => {
            setMcpOpen(true)
            setMenuOpen(false)
          }}
          type="button"
        >
          <span>◇</span>
          <span>
            <b>Agent workspace</b>
            <small>Connect any MCP client</small>
          </span>
        </button>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">
              {view === 'archive'
                ? 'ARCHIVED WORK'
                : view === 'activity'
                  ? 'LIVE ACTIVITY'
                  : 'WORKSPACE'}
            </p>
            <h1>
              {projectFilter && board
                ? projectName(board.projects, projectFilter)
                : view === 'archive'
                  ? 'Archive'
                  : view === 'activity'
                    ? 'Activity'
                    : 'My board'}
            </h1>
          </div>
          <div className="topbar-actions">
            {view !== 'activity' ? (
              <label className="search-box">
                <span>⌕</span>
                <span className="sr-only">Search tasks</span>
                <input
                  placeholder="Search tasks"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>
            ) : null}
            <button className="primary-button" onClick={() => setCreateTaskOpen(true)} type="button">
              <span>+</span> New task
            </button>
          </div>
        </header>

        {notice ? (
          <div className="notice" role="status">
            <span>{notice}</span>
            <button onClick={() => setNotice(null)} type="button" aria-label="Dismiss message">
              ×
            </button>
          </div>
        ) : null}

        {boardQuery.isError ? (
          <div className="error-state">
            <h2>Taskboard could not load.</h2>
            <p>{errorMessage(boardQuery.error)}</p>
            <button className="secondary-button" onClick={() => boardQuery.refetch()} type="button">
              Try again
            </button>
          </div>
        ) : null}

        {!boardQuery.isError && view === 'board' ? (
          <>
            <section className="summary-row" aria-label="Board summary">
              <SummaryCard label="Open tasks" value={tasks.filter((task) => task.status !== 'complete').length} />
              <SummaryCard label="In progress" value={taskCounts.in_progress} accent="amber" />
              <SummaryCard label="Blocked" value={taskCounts.blocked} accent="rose" />
              <SummaryCard label="Completed" value={taskCounts.complete} accent="emerald" />
            </section>

            <section className="board-area" aria-label="Task board">
              <div className="board-columns">
                {TASK_STATUSES.map((status) => (
                  <StatusColumn
                    key={status}
                    status={status}
                    tasks={tasks.filter((task) => task.status === status)}
                    onDrop={handleDrop}
                    onOpenTask={setSelectedTaskId}
                    onDragStart={setDraggedTaskId}
                    busy={isMutating}
                  />
                ))}
              </div>
            </section>
          </>
        ) : null}

        {!boardQuery.isError && view === 'activity' ? (
          <ActivityView events={board?.events ?? []} onOpenTask={setSelectedTaskId} />
        ) : null}

        {!boardQuery.isError && view === 'archive' ? (
          <ArchiveView
            tasks={tasks}
            onOpenTask={setSelectedTaskId}
            onRestore={(id) => unarchiveMutation.mutate(id)}
            busy={unarchiveMutation.isPending}
          />
        ) : null}

        {boardQuery.isLoading ? <BoardSkeleton /> : null}
      </section>

      {selectedTaskId ? (
        <TaskDetailPanel
          detail={selectedTask?.task.id === selectedTaskId ? selectedTask : undefined}
          error={detailQuery.isError ? errorMessage(detailQuery.error) : undefined}
          loading={detailQuery.isLoading}
          projects={board?.projects ?? []}
          busy={isMutating}
          onClose={() => setSelectedTaskId(null)}
          onUpdate={(input) => updateTaskMutation.mutate(input)}
          onArchive={(id) => archiveMutation.mutate(id)}
          onUnarchive={(id) => unarchiveMutation.mutate(id)}
          onComment={(input) => commentMutation.mutate(input)}
        />
      ) : null}

      {createTaskOpen ? (
        <TaskFormModal
          projects={board?.projects ?? []}
          busy={createTaskMutation.isPending}
          onClose={() => setCreateTaskOpen(false)}
          onSubmit={(draft) => createTaskMutation.mutate(draft)}
        />
      ) : null}

      {createProjectOpen ? (
        <ProjectFormModal
          busy={createProjectMutation.isPending}
          onClose={() => setCreateProjectOpen(false)}
          onSubmit={(input) => createProjectMutation.mutate(input)}
        />
      ) : null}

      {mcpOpen ? <McpModal onClose={() => setMcpOpen(false)} /> : null}
    </main>
  )
}

function SummaryCard({
  label,
  value,
  accent = 'slate',
}: {
  label: string
  value: number
  accent?: string
}) {
  return (
    <div className={`summary-card summary-${accent}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function StatusColumn({
  status,
  tasks,
  onDrop,
  onOpenTask,
  onDragStart,
  busy,
}: {
  status: TaskStatus
  tasks: Task[]
  onDrop: (event: DragEvent<HTMLElement>, status: TaskStatus) => void
  onOpenTask: (id: string) => void
  onDragStart: (id: string) => void
  busy: boolean
}) {
  const meta = STATUS_META[status]

  return (
    <section
      className={`status-column status-${meta.accent}`}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => onDrop(event, status)}
    >
      <header className="column-heading">
        <div>
          <span className="status-dot" />
          <h2>{meta.label}</h2>
        </div>
        <span>{tasks.length}</span>
      </header>
      <div className="column-cards">
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            draggable={!busy}
            onOpen={() => onOpenTask(task.id)}
            onDragStart={() => onDragStart(task.id)}
          />
        ))}
        {!tasks.length ? <div className="empty-column">Drop a task here</div> : null}
      </div>
    </section>
  )
}

function TaskCard({
  task,
  draggable,
  onOpen,
  onDragStart,
}: {
  task: Task
  draggable: boolean
  onOpen: () => void
  onDragStart: () => void
}) {
  return (
    <article
      className="task-card"
      draggable={draggable}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/task-id', task.id)
        onDragStart()
      }}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen()
        }
      }}
      role="button"
      tabIndex={0}
    >
      <div className="task-card-topline">
        {task.project ? (
          <span className="task-project">
            <i style={{ backgroundColor: task.project.color }} />
            {task.project.name}
          </span>
        ) : (
          <span className="task-project is-standalone">Standalone</span>
        )}
        {task.lock ? <span className="lock-pill" title={`Locked by ${task.lock.botName}`}>⌁ {task.lock.botName}</span> : null}
      </div>
      <h3>{task.title}</h3>
      {task.description ? <p>{task.description}</p> : null}
      <footer>
        <span>{task.commentCount ? `◌ ${task.commentCount}` : '◌ Add note'}</span>
        <time dateTime={task.updatedAt}>{formatTimestamp(task.updatedAt)}</time>
      </footer>
    </article>
  )
}

function ActivityFeed({
  events,
  onOpenTask,
}: {
  events: TaskEvent[]
  onOpenTask: (id: string) => void
}) {
  return (
    <aside className="activity-feed" aria-label="Recent task activity">
      <div className="activity-heading">
        <div>
          <p className="eyebrow">LIVE FEED</p>
          <h2>What’s happening</h2>
        </div>
        <span className="live-indicator">Live</span>
      </div>
      <div className="activity-list">
        {events.map((event) => (
          <article className="activity-item" key={event.id}>
            <span className={`activity-avatar actor-${event.actor.kind}`}>
              {event.actor.name.slice(0, 1).toUpperCase()}
            </span>
            <div>
              <p>
                <b>{event.actor.name}</b> {describeEvent(event)}
              </p>
              {event.taskId ? (
                <button className="activity-task-link" onClick={() => onOpenTask(event.taskId!)} type="button">
                  {event.taskTitle ?? 'Task'}
                </button>
              ) : null}
              <time dateTime={event.createdAt}>{formatTimestamp(event.createdAt)}</time>
            </div>
          </article>
        ))}
        {!events.length ? <p className="empty-activity">Activity will appear here.</p> : null}
      </div>
    </aside>
  )
}

function ActivityView({
  events,
  onOpenTask,
}: {
  events: TaskEvent[]
  onOpenTask: (id: string) => void
}) {
  return (
    <section className="activity-view" aria-label="Activity workspace">
      <ActivityFeed events={events} onOpenTask={onOpenTask} />
    </section>
  )
}

function ArchiveView({
  tasks,
  onOpenTask,
  onRestore,
  busy,
}: {
  tasks: Task[]
  onOpenTask: (id: string) => void
  onRestore: (id: string) => void
  busy: boolean
}) {
  return (
    <section className="archive-view">
      <div className="archive-intro">
        <div>
          <p className="eyebrow">OUT OF SIGHT, NOT GONE</p>
          <h2>{tasks.length} archived task{tasks.length === 1 ? '' : 's'}</h2>
        </div>
        <p>Restore a task to put it back in its previous board column.</p>
      </div>
      <div className="archive-list">
        {tasks.map((task) => (
          <article className="archive-row" key={task.id}>
            <button className="archive-title" onClick={() => onOpenTask(task.id)} type="button">
              <StatusBadge status={task.status} />
              <span>
                <b>{task.title}</b>
                <small>{task.project?.name ?? 'Standalone task'} · archived {formatTimestamp(task.archivedAt ?? task.updatedAt)}</small>
              </span>
            </button>
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => onRestore(task.id)}
              type="button"
            >
              Restore
            </button>
          </article>
        ))}
        {!tasks.length ? <div className="empty-archive">Nothing has been archived yet.</div> : null}
      </div>
    </section>
  )
}

function TaskDetailPanel({
  detail,
  projects,
  loading,
  error,
  busy,
  onClose,
  onUpdate,
  onArchive,
  onUnarchive,
  onComment,
}: {
  detail: TaskDetail | undefined
  projects: Project[]
  loading: boolean
  error?: string
  busy: boolean
  onClose: () => void
  onUpdate: (input: TaskDraft & { id: string }) => void
  onArchive: (id: string) => void
  onUnarchive: (id: string) => void
  onComment: (input: { taskId: string; body: string }) => void
}) {
  const [draft, setDraft] = useState<TaskDraft | null>(null)
  const [comment, setComment] = useState('')

  useEffect(() => {
    if (detail) {
      setDraft({
        title: detail.task.title,
        description: detail.task.description,
        status: detail.task.status,
        projectId: detail.task.project?.id ?? null,
      })
      setComment('')
    }
  }, [detail?.task.id, detail?.task.updatedAt])

  if (loading || !detail || !draft) {
    return (
      <div className="modal-backdrop">
        <aside className="detail-panel" aria-label="Task details">
          <button className="close-button" onClick={onClose} type="button">×</button>
          {error ? <p className="panel-error">{error}</p> : <div className="detail-loading">Loading task…</div>}
        </aside>
      </div>
    )
  }

  const { task } = detail
  const taskDraft: TaskDraft = draft

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    onUpdate({
      id: task.id,
      title: taskDraft.title,
      description: taskDraft.description,
      status: taskDraft.status,
      projectId: taskDraft.projectId,
    })
  }

  function submitComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!comment.trim()) {
      return
    }
    onComment({ taskId: task.id, body: comment.trim() })
    setComment('')
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <aside
        className="detail-panel"
        aria-label={`Task details for ${task.title}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="detail-header">
          <span className={`status-dot status-${STATUS_META[task.status].accent}`} />
          <span>{task.archivedAt ? 'ARCHIVED TASK' : 'TASK DETAILS'}</span>
          <button className="close-button" onClick={onClose} type="button" aria-label="Close task details">
            ×
          </button>
        </header>

        {task.lock ? (
          <div className="lock-banner">
            <span>⌁</span>
            <div>
              <b>{task.lock.botName} is working on this</b>
              <small>Lock expires {formatTimestamp(task.lock.expiresAt)}</small>
            </div>
          </div>
        ) : null}

        <form className="task-detail-form" onSubmit={save}>
          <label>
            Task title
            <input
              value={draft.title}
              maxLength={240}
              onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            />
          </label>
          <div className="field-grid">
            <label>
              Status
              <select
                value={draft.status}
                onChange={(event) =>
                  setDraft({ ...draft, status: event.target.value as TaskStatus })
                }
              >
                {TASK_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {STATUS_META[status].label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Project
              <select
                value={draft.projectId ?? ''}
                onChange={(event) =>
                  setDraft({ ...draft, projectId: event.target.value || null })
                }
              >
                <option value="">Standalone</option>
                {projects.filter((project) => !project.archivedAt).map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            Description
            <textarea
              value={draft.description}
              rows={5}
              maxLength={10_000}
              placeholder="Add context, acceptance criteria, or the next action…"
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          </label>
          <div className="detail-actions">
            <button className="primary-button" disabled={busy} type="submit">
              {busy ? 'Saving…' : 'Save changes'}
            </button>
            {task.archivedAt ? (
              <button className="secondary-button" disabled={busy} onClick={() => onUnarchive(task.id)} type="button">
                Restore task
              </button>
            ) : (
              <button className="danger-button" disabled={busy} onClick={() => onArchive(task.id)} type="button">
                Archive task
              </button>
            )}
          </div>
        </form>

        <section className="comments-section">
          <div className="panel-section-heading">
            <h3>Progress notes</h3>
            <span>{detail.comments.length}</span>
          </div>
          <form className="comment-form" onSubmit={submitComment}>
            <textarea
              value={comment}
              maxLength={5000}
              placeholder="Write a progress update…"
              rows={3}
              onChange={(event) => setComment(event.target.value)}
            />
            <button className="secondary-button" disabled={busy || !comment.trim()} type="submit">
              Add note
            </button>
          </form>
          <div className="comment-list">
            {detail.comments.map((entry) => (
              <article className="comment" key={entry.id}>
                <span className={`activity-avatar actor-${entry.actor.kind}`}>
                  {entry.actor.name.slice(0, 1).toUpperCase()}
                </span>
                <div>
                  <p>
                    <b>{entry.actor.name}</b>
                    <time dateTime={entry.createdAt}>{formatTimestamp(entry.createdAt)}</time>
                  </p>
                  <span>{entry.body}</span>
                </div>
              </article>
            ))}
            {!detail.comments.length ? <p className="empty-comments">No updates yet. Add the first note.</p> : null}
          </div>
        </section>

        <section className="history-section">
          <div className="panel-section-heading">
            <h3>Task history</h3>
          </div>
          {detail.events.slice(-8).reverse().map((event) => (
            <div className="history-item" key={event.id}>
              <span className={`history-dot actor-${event.actor.kind}`} />
              <span>
                <b>{event.actor.name}</b> {describeEvent(event)}
              </span>
              <time dateTime={event.createdAt}>{formatTimestamp(event.createdAt)}</time>
            </div>
          ))}
        </section>
      </aside>
    </div>
  )
}

function TaskFormModal({
  projects,
  busy,
  onClose,
  onSubmit,
}: {
  projects: Project[]
  busy: boolean
  onClose: () => void
  onSubmit: (draft: TaskDraft) => void
}) {
  const [draft, setDraft] = useState<TaskDraft>({
    title: '',
    description: '',
    status: 'inbox',
    projectId: null,
  })

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (draft.title.trim()) {
      onSubmit({ ...draft, title: draft.title.trim(), description: draft.description.trim() })
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="dialog" onMouseDown={(event) => event.stopPropagation()} aria-label="Create task">
        <header className="dialog-header">
          <div>
            <p className="eyebrow">NEW WORK</p>
            <h2>Create a task</h2>
          </div>
          <button className="close-button" onClick={onClose} type="button">×</button>
        </header>
        <form className="dialog-form" onSubmit={submit}>
          <label>
            What needs to happen?
            <input
              autoFocus
              value={draft.title}
              maxLength={240}
              placeholder="e.g. Review onboarding flow"
              onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            />
          </label>
          <div className="field-grid">
            <label>
              Start in
              <select
                value={draft.status}
                onChange={(event) =>
                  setDraft({ ...draft, status: event.target.value as TaskStatus })
                }
              >
                {TASK_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {STATUS_META[status].label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Project
              <select
                value={draft.projectId ?? ''}
                onChange={(event) => setDraft({ ...draft, projectId: event.target.value || null })}
              >
                <option value="">No project</option>
                {projects.filter((project) => !project.archivedAt).map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            Context
            <textarea
              rows={5}
              value={draft.description}
              placeholder="Add enough detail for a person or an agent to start."
              maxLength={10_000}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          </label>
          <footer className="dialog-actions">
            <button className="ghost-button" onClick={onClose} type="button">Cancel</button>
            <button className="primary-button" disabled={busy || !draft.title.trim()} type="submit">
              {busy ? 'Creating…' : 'Create task'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  )
}

function ProjectFormModal({
  busy,
  onClose,
  onSubmit,
}: {
  busy: boolean
  onClose: () => void
  onSubmit: (input: { name: string; description: string; color: string }) => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [color, setColor] = useState('#5E81AC')

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (name.trim()) {
      onSubmit({ name: name.trim(), description: description.trim(), color })
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="dialog compact-dialog" onMouseDown={(event) => event.stopPropagation()} aria-label="Create project">
        <header className="dialog-header">
          <div>
            <p className="eyebrow">ORGANIZE WORK</p>
            <h2>New project</h2>
          </div>
          <button className="close-button" onClick={onClose} type="button">×</button>
        </header>
        <form className="dialog-form" onSubmit={submit}>
          <label>
            Project name
            <input autoFocus value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            Description
            <textarea rows={3} value={description} maxLength={2000} onChange={(event) => setDescription(event.target.value)} />
          </label>
          <label className="color-field">
            Project color
            <select value={color} onChange={(event) => setColor(event.target.value)}>
              {nordProjectColors.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <footer className="dialog-actions">
            <button className="ghost-button" onClick={onClose} type="button">Cancel</button>
            <button className="primary-button" disabled={busy || !name.trim()} type="submit">
              {busy ? 'Creating…' : 'Create project'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  )
}

function McpModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="dialog mcp-dialog" onMouseDown={(event) => event.stopPropagation()} aria-label="Connect an agent">
        <header className="dialog-header">
          <div>
            <p className="eyebrow">LOCAL MCP</p>
            <h2>Connect an agent</h2>
          </div>
          <button className="close-button" onClick={onClose} type="button">×</button>
        </header>
        <div className="mcp-copy">
          <p>Each stdio MCP connection becomes a named bot. Any compatible client can use it; bots must claim a task before they update it or add progress notes.</p>
          <ol>
            <li>Keep the board running with <code>npm run dev</code>.</li>
            <li>Use this project folder as the MCP server working directory.</li>
            <li>Give every connected agent a different <code>--bot</code> ID.</li>
          </ol>
          <p className="code-label">Generic MCP server command</p>
          <pre><code>npm run mcp -- --bot work-agent --name "Work agent"</code></pre>
          <p className="code-label">Generic stdio MCP entry</p>
          <pre><code>{`{
  "command": "npm",
  "args": ["run", "mcp", "--", "--bot", "work-agent", "--name", "Work agent"],
  "cwd": "/path/to/tasks"
}`}</code></pre>
          <p className="mcp-note">Use this standard stdio entry in Pi, Codex, Claude Code, or any compatible MCP client. The server writes protocol data only through stdio and stores all task data in your local SQLite file.</p>
        </div>
        <footer className="dialog-actions">
          <button className="primary-button" onClick={onClose} type="button">Done</button>
        </footer>
      </section>
    </div>
  )
}

function StatusBadge({ status }: { status: TaskStatus }) {
  return <span className={`status-badge status-${STATUS_META[status].accent}`}>{STATUS_META[status].shortLabel}</span>
}

function BoardSkeleton() {
  return (
    <div className="board-skeleton" aria-label="Loading taskboard">
      {Array.from({ length: 4 }, (_, index) => <span key={index} />)}
    </div>
  )
}

function randomId(): string {
  const cryptoObject = globalThis.crypto
  if (cryptoObject?.randomUUID) {
    return cryptoObject.randomUUID()
  }

  // crypto.randomUUID only exists in secure contexts (HTTPS or localhost),
  // but the board is also served over plain HTTP on the LAN. getRandomValues
  // works there, so build a UUID v4 from it.
  const bytes = new Uint8Array(16)
  if (cryptoObject?.getRandomValues) {
    cryptoObject.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function useLocalActor(): [UserActor, (actor: UserActor | ((current: UserActor) => UserActor)) => void] {
  const [actor, setActor] = useState<UserActor>(defaultActor)

  useEffect(() => {
    const stored = window.localStorage.getItem('taskboard-local-user')
    if (!stored) {
      const next = {
        id: randomId(),
        name: 'You',
        kind: 'user' as const,
      }
      window.localStorage.setItem('taskboard-local-user', JSON.stringify(next))
      setActor(next)
      return
    }

    try {
      const parsed: unknown = JSON.parse(stored)
      if (
        parsed &&
        typeof parsed === 'object' &&
        'id' in parsed &&
        'name' in parsed &&
        typeof parsed.id === 'string' &&
        typeof parsed.name === 'string'
      ) {
        setActor({ id: parsed.id, name: parsed.name || 'You', kind: 'user' })
      }
    } catch {
      window.localStorage.removeItem('taskboard-local-user')
    }
  }, [])

  return [actor, setActor]
}

function setActorName(
  setActor: (actor: UserActor | ((current: UserActor) => UserActor)) => void,
  name: string,
) {
  setActor((current) => {
    const next = { ...current, name: name || 'You' }
    window.localStorage.setItem('taskboard-local-user', JSON.stringify(next))
    return next
  })
}

function projectName(projects: Project[], id: string) {
  return projects.find((project) => project.id === id)?.name ?? 'Project'
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'The taskboard could not complete that action.'
}

function formatTimestamp(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return 'just now'
  }
  const day = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `${day} · ${time}`
}

function describeEvent(event: TaskEvent) {
  const from = typeof event.data.from === 'string' ? event.data.from : undefined
  const to = typeof event.data.to === 'string' ? event.data.to : undefined

  if (event.type === 'task_created') return 'created this task'
  if (event.type === 'project_created') return 'created a project'
  if (event.type === 'status_changed' && from && to) {
    return `moved it from ${STATUS_META[from as TaskStatus]?.shortLabel ?? from} to ${STATUS_META[to as TaskStatus]?.shortLabel ?? to}`
  }
  if (event.type === 'task_updated') return 'updated task details'
  if (event.type === 'comment_added') return 'added a progress note'
  if (event.type === 'task_claimed') return 'claimed the task'
  if (event.type === 'lock_renewed') return 'renewed its lock'
  if (event.type === 'lock_released') return 'released its lock'
  if (event.type === 'task_archived') return 'archived the task'
  if (event.type === 'task_unarchived') return 'restored the task'
  return 'updated the task'
}
