// pi-jar's light-inspired activity phrases (src/working.ts) in place of the spinner's word.
import type { Args, EngineInterface, On } from 'claude-code'

import type { NextFn, StepResult } from './chain'

const PROGRESSION = [
  'A spark remains',
  'Kindling a thought',
  'Following the faint light',
  'Gathering scattered sparks',
  'The path is beginning to glow',
  'There is a way through',
  'A clearer path is forming',
  'The horizon is clearer now',
] as const

/** Seconds into the turn at which each phrase starts. */
const STAGES = [0, 8, 20, 35, 50, 70, 90, 120] as const

export function progressionPhrase(elapsedSeconds: number): string {
  let index = 0

  STAGES.forEach((threshold, stage) => {
    if (elapsedSeconds >= threshold) {
      index = stage
    }
  })

  return PROGRESSION[index] ?? PROGRESSION[0]
}

export function spinnerWord(mode: string, elapsedSeconds: number, tool: string | undefined): string {
  if (mode === 'tool-use' || mode === 'tool-input') {
    return `Tracing light through ${tool ?? 'a tool'}`
  }

  return progressionPhrase(elapsedSeconds)
}

/** Main-loop turn facts; module values, so a reload starts the phrase over. */
let turnStartedAt: number | undefined
let currentTool: string | undefined

export async function spinnerTurnStart(
  $: EngineInterface,
  e: Args<'turn.start'>,
  next: NextFn<'turn.start'>,
): StepResult<'turn.start'> {
  if (e.agentId === undefined) {
    turnStartedAt = await $.clock.now()
    currentTool = undefined
  }

  return next(e)
}

export async function spinnerToolCall(
  $: EngineInterface,
  e: Args<'tool.call'>,
  next: NextFn<'tool.call'>,
): StepResult<'tool.call'> {
  if (e.agentId === undefined) {
    currentTool = String(e.tool).replace(/^mcp__[^_]+__/, '')
  }

  return next(e)
}

export function registerSpinner(on: On): void {
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    // The desktop's word names the step it is on, which is worth more than a phrase.
    const isTerminal = e.surface === 'terminal'

    if (!isTerminal || e.props.message !== null) {
      return next(e)
    }

    const now = await $.clock.now()
    const elapsed = Math.floor((now - (turnStartedAt ?? now)) / 1000)
    const word = spinnerWord(e.props.mode, elapsed, currentTool)

    return next({ ...e, props: { ...e.props, word } })
  })
}
