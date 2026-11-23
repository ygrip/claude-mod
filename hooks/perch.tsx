// The band above the prompt: Ember on the left, the task panel perched beside it (pi-jar's composer perch).
import { atom, read, update } from 'claude-code'
import type { Args, EngineInterface, On, PluginOptions } from 'claude-code'

import type { TaskBoard } from '../types'
import type { NextFn, StepResult } from './chain'
import {
  encodeCells,
  faceOf,
  frameKey,
  type MascotMood,
  moodAt,
  PERCH_ROWS,
  perchCells,
  poseAt,
  SPRITE_WIDTH,
} from './mascot'
import { AMBER } from './palette'
import { INITIAL_BOARD, INITIAL_MOOD } from './state'
import { glyphOf, heading, visibleItems } from './tasks'

const moodAtom = atom({ plugin: 'jar', key: 'mood' } as const, INITIAL_MOOD, { shape: 'mood-1' })
const boardAtom = atom({ plugin: 'jar', key: 'board' } as const, INITIAL_BOARD, { shape: 'board-1' })

const EMBER_KEY = 'ember'
const TICK_MS = 250
/** pi-jar shows the full sprite from 60 columns; below that, the compact face. */
const FULL_SPRITE_COLUMNS = 60
const PANEL_GAP = 3
const MIN_PANEL_COLUMNS = 16

/** Where the band was last drawn, for repainting Ember between renders. Lost on reload; the next render sets it. */
let bandRequestId: string | undefined
let lastFrame = ''

/** Set at register from the mod's options. */
let isMascotOn = true

export async function perchSessionStart(
  $: EngineInterface,
  e: Args<'session.start'>,
  next: NextFn<'session.start'>,
): StepResult<'session.start'> {
  if (isMascotOn) {
    $.clock.every(TICK_MS, () => {
      void animate($)
    })
  }

  return next(e)
}

export function registerPerch(on: On, options: PluginOptions): void {
  isMascotOn = options.mascot !== false

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const board = await read($, boardAtom)
    const hasTasks = board.items.length > 0

    if (!isMascotOn && !hasTasks) {
      return next(e)
    }

    const now = await $.clock.now()
    const mood = moodAt(await read($, moodAtom), now)
    const columns = e.props.bodyColumns
    const isFullSprite = e.surface === 'terminal' && columns >= FULL_SPRITE_COLUMNS
    let mascotColumns = 0

    if (isMascotOn) {
      bandRequestId = e.requestId
      lastFrame = frameKey(mood, now)
      mascotColumns = SPRITE_WIDTH
    }

    const isStacked = columns - mascotColumns - PANEL_GAP < MIN_PANEL_COLUMNS
    const { Box } = $.ui.resolve(e)
    let direction: 'row' | 'column' = 'row'
    let panelMargin = PANEL_GAP

    if (isStacked) {
      direction = 'column'
      panelMargin = 0
    }

    return (
      <Box flexDirection={direction} alignItems="center">
        {isMascotOn && drawEmber($, e, mood, poseAt(mood, now), isFullSprite)}
        {hasTasks && (
          <Box flexDirection="column" marginLeft={panelMargin}>
            {drawTasks($, e, board)}
          </Box>
        )}
      </Box>
    )
  })
}

type BandEvent = Parameters<EngineInterface['ui']['resolve']>[0]

function drawEmber($: EngineInterface, e: BandEvent, mood: MascotMood, pose: number, isFullSprite: boolean) {
  if (isFullSprite && e.surface === 'terminal') {
    const { Raster } = $.ui.resolve(e)

    return (
      <Raster
        key={EMBER_KEY}
        columns={SPRITE_WIDTH}
        rows={PERCH_ROWS}
        cells={encodeCells(perchCells(mood, pose))}
      />
    )
  }

  const { Text } = $.ui.resolve(e)

  return <Text color={AMBER.accent}>{faceOf(mood)}</Text>
}

function drawTasks($: EngineInterface, e: BandEvent, board: TaskBoard) {
  const { Box, Button, Text } = $.ui.resolve(e)
  const toggle = () => update($, boardAtom, current => ({ ...current, isExpanded: !current.isExpanded }))
  let rows = visibleItems(board)

  if (!board.isExpanded) {
    rows = []
  }

  return (
    <Box flexDirection="column">
      <Button key="jar-tasks" plain hotkey="t" onPress={toggle}>
        <Text color={AMBER.accent} bold wrap="end">
          {heading(board)}
        </Text>
      </Button>
      {rows.map(item => {
        if (item.status === 'completed') {
          return (
            <Text wrap="end">
              {'  '}
              <Text color={AMBER.green}>{glyphOf(item.status)}</Text>{' '}
              <Text dimColor strikethrough>
                {item.title}
              </Text>
            </Text>
          )
        }

        if (item.status === 'in_progress') {
          return (
            <Text wrap="end">
              {'  '}
              <Text color={AMBER.accent}>{glyphOf(item.status)}</Text>{' '}
              <Text color={AMBER.accent} bold>
                {item.title}
              </Text>
            </Text>
          )
        }

        return (
          <Text wrap="end" color={AMBER.muted}>
            {'  '}
            {glyphOf(item.status)} {item.title}
          </Text>
        )
      })}
    </Box>
  )
}

/**
 * Repaint Ember in place when its pose or mood changes; no render pass. Any failure (the band
 * collapsed, hidden, redrawn without the sprite, or the mod reloading) pauses it until the next
 * render seats the sprite again.
 */
async function animate($: EngineInterface): Promise<void> {
  const requestId = bandRequestId

  if (requestId === undefined) {
    return
  }

  try {
    const now = await $.clock.now()
    const mood = moodAt(await read($, moodAtom), now)
    const key = frameKey(mood, now)

    if (key === lastFrame) {
      return
    }

    lastFrame = key
    await $.ui.blit({ requestId, key: EMBER_KEY, cells: encodeCells(perchCells(mood, poseAt(mood, now))) })
  } catch (error) {
    bandRequestId = undefined
    $.ui.log(`jar: Ember paused (${String(error)})`)
  }
}
