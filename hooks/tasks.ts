// The session task list, rebuilt from the model's TaskCreate / TaskUpdate / TodoWrite calls.
import type { TaskBoard, TaskItem, TaskStatus } from '../types'

export const MAX_ROWS = 4

const STATUSES: readonly TaskStatus[] = ['pending', 'in_progress', 'completed']

function asStatus(value: unknown): TaskStatus | undefined {
  return STATUSES.find(status => status === value)
}

function asText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const trimmed = value.trim()

  if (trimmed === '') {
    return undefined
  }

  return trimmed
}

/** TaskCreate's structured result: `{ task: { id, subject } }`. */
export function createdTask(result: unknown): { id: string; subject?: string } | undefined {
  if (result === null || typeof result !== 'object') {
    return undefined
  }

  const task = (result as Record<string, unknown>).task

  if (task === null || typeof task !== 'object') {
    return undefined
  }

  const fields = task as Record<string, unknown>
  const id = asText(fields.id)

  if (id === undefined) {
    return undefined
  }

  return { id, subject: asText(fields.subject) }
}

/** `Task #12 created successfully: ...` → `12`; for results without the structured record. */
export function createdTaskId(resultText: string): string | undefined {
  const match = /#(\d+)/.exec(resultText)

  if (match === null) {
    return undefined
  }

  return match[1]
}

export function applyCreate(board: TaskBoard, id: string, input: Record<string, unknown>): TaskBoard {
  const title = asText(input.subject) ?? asText(input.content) ?? `Task ${id}`
  const others = board.items.filter(item => item.id !== id)

  return { ...board, items: [...others, { id, title, status: 'pending' }] }
}

export function applyUpdate(board: TaskBoard, input: Record<string, unknown>): TaskBoard {
  const id = asText(input.taskId)

  if (id === undefined) {
    return board
  }

  if (input.status === 'deleted') {
    return { ...board, items: board.items.filter(item => item.id !== id) }
  }

  const items = board.items.map(item => {
    if (item.id !== id) {
      return item
    }

    return {
      ...item,
      title: asText(input.subject) ?? item.title,
      status: asStatus(input.status) ?? item.status,
    }
  })

  return { ...board, items }
}

/** TodoWrite sends the whole list each time. */
export function applyTodoWrite(board: TaskBoard, input: Record<string, unknown>): TaskBoard {
  if (!Array.isArray(input.todos)) {
    return board
  }

  const items = input.todos.flatMap((todo: unknown, index: number): TaskItem[] => {
    if (todo === null || typeof todo !== 'object') {
      return []
    }

    const fields = todo as Record<string, unknown>
    const title = asText(fields.content) ?? asText(fields.subject)

    if (title === undefined) {
      return []
    }

    return [{ id: String(index + 1), title, status: asStatus(fields.status) ?? 'pending' }]
  })

  return { ...board, items }
}

export function isAllDone(board: TaskBoard): boolean {
  return board.items.length > 0 && board.items.every(item => item.status === 'completed')
}

/** A finished list stays until the next prompt, as in pi-jar. */
export function clearIfDone(board: TaskBoard): TaskBoard {
  if (isAllDone(board)) {
    return { ...board, items: [] }
  }

  return board
}

export function doneCount(board: TaskBoard): number {
  return board.items.filter(item => item.status === 'completed').length
}

export function currentTask(board: TaskBoard): TaskItem | undefined {
  return board.items.find(item => item.status === 'in_progress')
}

export function heading(board: TaskBoard): string {
  let arrow = '▸'

  if (board.isExpanded) {
    arrow = '▾'
  }

  const parts = [`${arrow} Tasks`, `${doneCount(board)}/${board.items.length} done`]
  const current = currentTask(board)

  if (current !== undefined) {
    parts.push(current.title)
  }

  return parts.join(' · ')
}

/** At most MAX_ROWS rows, the window following the task in progress. */
export function visibleItems(board: TaskBoard): TaskItem[] {
  const items = board.items

  if (items.length <= MAX_ROWS) {
    return items
  }

  const focus = Math.max(0, items.findIndex(item => item.status === 'in_progress'))
  const start = Math.min(Math.max(0, focus - 1), items.length - MAX_ROWS)

  return items.slice(start, start + MAX_ROWS)
}

export function glyphOf(status: TaskStatus): string {
  if (status === 'completed') {
    return '✔'
  }

  if (status === 'in_progress') {
    return '◼'
  }

  return '☐'
}
