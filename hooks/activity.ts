// Feeds Ember's mood and the task board from the main loop's turns and tool calls.
import { atom, update } from 'claude-code'
import type { Args, EngineInterface } from 'claude-code'

import type { Phase } from '../types'
import type { NextFn, StepResult } from './chain'
import { withFlash, withPhase } from './mascot'
import { INITIAL_BOARD, INITIAL_MOOD } from './state'
import { applyCreate, applyTodoWrite, applyUpdate, clearIfDone, createdTask, createdTaskId } from './tasks'

const moodAtom = atom({ plugin: 'jar', key: 'mood' } as const, INITIAL_MOOD, { shape: 'mood-1' })
const boardAtom = atom({ plugin: 'jar', key: 'board' } as const, INITIAL_BOARD, { shape: 'board-1' })

const ERROR_FLASH_MS = 3_000
const COMPLETE_FLASH_MS = 1_600
const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TodoWrite'])

/** Tool calls in flight on the main loop; a module value, since a reload ends them anyway. */
let toolsInFlight = 0

async function setPhase($: EngineInterface, phase: Phase): Promise<void> {
  const now = await $.clock.now()
  await update($, moodAtom, state => withPhase(state, phase, now))
}

function phaseAfterTool(): Phase {
  if (toolsInFlight > 0) {
    return 'tool'
  }

  return 'generating'
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object') {
    return value as Record<string, unknown>
  }

  return {}
}

function phaseDuring(tool: string): Phase {
  if (tool === 'AskUserQuestion') {
    return 'waiting'
  }

  return 'tool'
}

export async function activityPromptSubmit(
  $: EngineInterface,
  e: Args<'prompt.submit'>,
  next: NextFn<'prompt.submit'>,
): StepResult<'prompt.submit'> {
  await update($, boardAtom, clearIfDone)

  return next(e)
}

export async function activityTurnStart(
  $: EngineInterface,
  e: Args<'turn.start'>,
  next: NextFn<'turn.start'>,
): StepResult<'turn.start'> {
  if (e.agentId === undefined) {
    toolsInFlight = 0
    await setPhase($, 'generating')
  }

  return next(e)
}

export async function activityTurnComplete(
  $: EngineInterface,
  e: Args<'turn.complete'>,
  next: NextFn<'turn.complete'>,
): StepResult<'turn.complete'> {
  if (e.agentId === undefined) {
    toolsInFlight = 0
    await flashForEnd($, e.reason)
  }

  return next(e)
}

export async function activityToolCall(
  $: EngineInterface,
  e: Args<'tool.call'>,
  next: NextFn<'tool.call'>,
): StepResult<'tool.call'> {
  const tool = String(e.tool)
  const isMain = e.agentId === undefined

  if (isMain) {
    toolsInFlight += 1
    await setPhase($, phaseDuring(tool))
  }

  let ran: Awaited<StepResult<'tool.call'>>

  try {
    ran = await next(e)
  } finally {
    if (isMain) {
      toolsInFlight = Math.max(0, toolsInFlight - 1)
      await setPhase($, phaseAfterTool())
    }
  }

  if (TASK_TOOLS.has(tool) && ran.deny === undefined && ran.isError !== true) {
    await recordTaskCall($, tool, asRecord(e), ran.result, ran.text ?? '')
  }

  return ran
}

async function flashForEnd($: EngineInterface, reason: string): Promise<void> {
  const now = await $.clock.now()

  if (reason === 'error') {
    await update($, moodAtom, state => withFlash(state, 'error', ERROR_FLASH_MS, now))

    return
  }

  if (reason === 'answer') {
    await update($, moodAtom, state => withFlash(state, 'complete', COMPLETE_FLASH_MS, now))

    return
  }

  await update($, moodAtom, state => withPhase(state, 'idle', now))
}

async function recordTaskCall(
  $: EngineInterface,
  tool: string,
  input: Record<string, unknown>,
  result: unknown,
  resultText: string,
): Promise<void> {
  if (tool === 'TodoWrite') {
    await update($, boardAtom, board => applyTodoWrite(board, input))

    return
  }

  if (tool === 'TaskUpdate') {
    await update($, boardAtom, board => applyUpdate(board, input))

    return
  }

  const created = createdTask(result)
  const id = created?.id ?? createdTaskId(resultText)

  if (id === undefined) {
    return
  }

  let fields = input

  if (created?.subject !== undefined) {
    fields = { ...input, subject: created.subject }
  }

  await update($, boardAtom, board => applyCreate(board, id, fields))
}
