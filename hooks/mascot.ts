// Ember, ported from pi-jar src/mascot.ts: an 11x10 pixel pet drawn as half-blocks.
import type { FlashMood, MoodState, Phase } from '../types'

import { AMBER_RGB, type Rgb, rgbToInt } from './palette'

export type MascotMood =
  | 'idle'
  | 'blink'
  | 'happy'
  | 'thinking'
  | 'tool'
  | 'waiting'
  | 'sleepy'
  | 'error'
  | 'complete'

export const SPRITE_WIDTH = 11
export const SPRITE_HEIGHT = 10
/** Spark row plus five half-block rows. */
export const PERCH_ROWS = 6
export const SLEEPY_AFTER_MS = 120_000
const BLINK_EVERY_MS = 4_500
const BLINK_MS = 300

const FACES: Record<MascotMood, string> = {
  idle: '▪▄▪',
  blink: '─▄─',
  happy: '▀▄▀',
  thinking: '▪─▪',
  tool: '>▄<',
  waiting: '▪o▪',
  sleepy: '─_─',
  error: '×_×',
  complete: '✦▄✦',
}

const TIMELINES: Record<MascotMood, ReadonlyArray<readonly [number, number]>> = {
  idle: [[0, 1000]],
  blink: [[0, 1000]],
  sleepy: [[0, 1400], [1, 1400]],
  happy: [[0, 640], [1, 140], [2, 240], [1, 120], [0, 360]],
  complete: [[0, 360], [1, 120], [2, 260], [1, 120]],
  thinking: [[0, 900], [1, 260], [2, 900], [3, 260]],
  tool: [[0, 280], [1, 200], [0, 280], [3, 200]],
  waiting: [[0, 1200], [1, 420]],
  error: [[0, 420], [1, 120], [0, 160], [1, 120], [0, 600]],
}

const BODY = [
  '.....o.....',
  '....oho....',
  '...ohhbo...',
  '..ohhffbo..',
  '.ohfffffbo.',
  'ohfffffffbo',
  'ohfffffffbo',
  'offfffffbso',
  '.osfffffso.',
  '..ooooooo..',
] as const

const EYES: Record<MascotMood, readonly string[]> = {
  idle: ['.k.', '.k.'],
  blink: ['...', '.k.'],
  happy: ['.k.', 'k.k'],
  thinking: ['..k', '..k'],
  tool: ['kk.', '.k.'],
  waiting: ['.k.', '.k.'],
  sleepy: ['...', 'kkk'],
  error: ['k..', '.k.'],
  complete: ['.k.', 'k.k'],
}

const BLACK: Rgb = [12, 8, 10]
const WHITE: Rgb = [255, 252, 245]
const WARM: Rgb = [255, 128, 112]
const MOUTH: Rgb = [196, 62, 52]

function mix(from: Rgb, to: Rgb, amount: number): Rgb {
  const channel = (index: 0 | 1 | 2) => Math.round(from[index] + (to[index] - from[index]) * amount)

  return [channel(0), channel(1), channel(2)]
}

/** Ember in the accent: outline, shadow, body, face, highlight, blush, eye, glint, mouth. */
export function accentPalette(accent: Rgb): Readonly<Record<string, Rgb>> {
  return {
    o: mix(accent, BLACK, 0.62),
    s: mix(accent, BLACK, 0.3),
    b: accent,
    f: mix(accent, WHITE, 0.38),
    h: mix(accent, WHITE, 0.68),
    c: mix(WARM, accent, 0.25),
    k: mix(accent, BLACK, 0.84),
    w: WHITE,
    m: mix(MOUTH, accent, 0.2),
  }
}

export const AMBER_EMBER = accentPalette(AMBER_RGB)

// ---- mood ----------------------------------------------------------------

export function withPhase(state: MoodState, phase: Phase, now: number): MoodState {
  return { ...state, phase, lastActive: now }
}

export function withFlash(state: MoodState, mood: FlashMood, ms: number, now: number): MoodState {
  return { ...state, phase: 'idle', lastActive: now, flash: { mood, until: now + ms } }
}

export function moodAt(state: MoodState, now: number): MascotMood {
  if (state.flash !== undefined && now < state.flash.until) {
    return state.flash.mood
  }

  if (state.phase === 'generating') {
    return generatingMood(now)
  }

  if (state.phase === 'tool') {
    return 'tool'
  }

  if (state.phase === 'waiting') {
    return 'waiting'
  }

  if (now - state.lastActive >= SLEEPY_AFTER_MS) {
    return 'sleepy'
  }

  if (now % BLINK_EVERY_MS < BLINK_MS) {
    return 'blink'
  }

  return 'idle'
}

function generatingMood(now: number): MascotMood {
  const isThinkingBeat = Math.floor(now / 2400) % 3 === 2

  if (isThinkingBeat) {
    return 'thinking'
  }

  return 'happy'
}

export function poseAt(mood: MascotMood, now: number): number {
  const timeline = TIMELINES[mood]
  const total = timeline.reduce((sum, [, ms]) => sum + ms, 0)
  let offset = ((Math.floor(now) % total) + total) % total

  for (const [pose, ms] of timeline) {
    if (offset < ms) {
      return pose
    }

    offset -= ms
  }

  return 0
}

export function faceOf(mood: MascotMood): string {
  return `▐${FACES[mood]}▌`
}

// ---- pixels ----------------------------------------------------------------

function isHopMood(mood: MascotMood): boolean {
  return mood === 'happy' || mood === 'complete'
}

function mirror(rows: readonly string[]): string[] {
  return rows.map(row => [...row].reverse().join(''))
}

function stamp(grid: string[][], x: number, y: number, rows: readonly string[]): void {
  rows.forEach((row, dy) => {
    ;[...row].forEach((pixel, dx) => {
      const line = grid[y + dy]
      const isInside = line !== undefined && line[x + dx] !== undefined

      if (pixel !== '.' && isInside) {
        line[x + dx] = pixel
      }
    })
  })
}

function eyesFor(mood: MascotMood, pose: number): readonly string[] {
  const isGlancingBack = mood === 'thinking' && pose >= 2

  if (isGlancingBack) {
    return mirror(EYES.thinking)
  }

  return EYES[mood]
}

function rowOf(grid: readonly string[][], y: number): string[] {
  return grid[y] ?? Array<string>(SPRITE_WIDTH).fill('.')
}

function swayTuft(grid: string[][]): void {
  for (let y = 0; y < 3; y++) {
    grid[y] = ['.', ...rowOf(grid, y).slice(0, -1)]
  }
}

function squash(grid: string[][]): void {
  for (let y = 3; y > 0; y--) {
    grid[y] = [...rowOf(grid, y - 1)]
  }

  grid[0] = Array(SPRITE_WIDTH).fill('.')
}

/** Pixel rows for a mood and pose; `.` is transparent. */
export function mascotPixels(mood: MascotMood, pose: number): string[] {
  const grid = BODY.map(row => [...row])
  const isCalm = mood === 'idle' || mood === 'blink' || mood === 'sleepy'

  if (!isCalm && pose % 2 === 1) {
    swayTuft(grid)
  }

  const eyes = eyesFor(mood, pose)
  let eyeRow = 5

  if (mood === 'waiting') {
    eyeRow = 4
  }

  stamp(grid, 2, eyeRow, eyes)

  if (mood === 'thinking') {
    stamp(grid, 6, eyeRow, eyes)
  } else {
    stamp(grid, 6, eyeRow, mirror(eyes))
  }

  if (mood === 'error') {
    stamp(grid, 1, 7, ['cc'])
    stamp(grid, 8, 7, ['cc'])
  } else {
    stamp(grid, 2, 7, ['c'])
    stamp(grid, 8, 7, ['c'])
  }

  if (isHopMood(mood)) {
    stamp(grid, 5, 7, ['m'])
  } else {
    stamp(grid, 5, 7, ['k'])
  }

  if (mood === 'complete') {
    stamp(grid, 5, 1, ['w'])
  }

  const isSquashing = (isHopMood(mood) && pose === 1) || (mood === 'error' && pose % 2 === 1)

  if (isSquashing) {
    squash(grid)
  }

  return grid.map(row => row.join(''))
}

export function sparkRow(mood: MascotMood, pose: number): string {
  if (mood === 'sleepy') {
    if (pose % 2 === 1) {
      return '      zzz  '
    }

    return '       zzz '
  }

  if (mood === 'complete') {
    if (pose % 2 === 1) {
      return '  ✦     ✦  '
    }

    return '   ✦   ✦   '
  }

  if (mood === 'waiting') {
    return '        ?  '
  }

  return ' '.repeat(SPRITE_WIDTH)
}

// ---- raster cells --------------------------------------------------------------

/** A cell for Raster: code point, foreground, background (0x01000000 = terminal default). */
export type Cell = readonly [number, number, number]

export const DEFAULT_COLOR = 0x01000000
const UPPER_HALF = 0x2580
const LOWER_HALF = 0x2584
const SPACE = 0x20

function blankCell(): Cell {
  return [SPACE, DEFAULT_COLOR, DEFAULT_COLOR]
}

function colorOf(pixel: string): number {
  const color = AMBER_EMBER[pixel]

  if (color === undefined) {
    return DEFAULT_COLOR
  }

  return rgbToInt(color)
}

/** The pixel at (x, y), transparent outside the sprite. */
function pixelAt(pixels: readonly string[], x: number, y: number): string {
  return pixels[y]?.[x] ?? '.'
}

function halfBlockCell(top: string, bottom: string): Cell {
  const isTopClear = top === '.'
  const isBottomClear = bottom === '.'

  if (isTopClear && isBottomClear) {
    return blankCell()
  }

  if (isTopClear) {
    return [LOWER_HALF, colorOf(bottom), DEFAULT_COLOR]
  }

  if (isBottomClear) {
    return [UPPER_HALF, colorOf(top), DEFAULT_COLOR]
  }

  return [UPPER_HALF, colorOf(top), colorOf(bottom)]
}

function spriteCells(pixels: readonly string[]): Cell[] {
  const cells: Cell[] = []

  for (let y = 0; y < SPRITE_HEIGHT; y += 2) {
    for (let x = 0; x < SPRITE_WIDTH; x++) {
      cells.push(halfBlockCell(pixelAt(pixels, x, y), pixelAt(pixels, x, y + 1)))
    }
  }

  return cells
}

function sparkCells(mood: MascotMood, pose: number): Cell[] {
  let color = colorOf('h')

  if (mood === 'sleepy') {
    color = colorOf('s')
  }

  return [...sparkRow(mood, pose)].map(char => {
    if (char === ' ') {
      return blankCell()
    }

    return [char.codePointAt(0) ?? SPACE, color, DEFAULT_COLOR] as Cell
  })
}

/** Every cell of the 11x6 perch, row-major; a hop lifts the sprite into the spark row. */
export function perchCells(mood: MascotMood, pose: number): Cell[] {
  const sprite = spriteCells(mascotPixels(mood, pose))
  const isAirborne = isHopMood(mood) && pose === 2

  if (isAirborne) {
    const blankRow = Array.from({ length: SPRITE_WIDTH }, blankCell)

    return [...sprite, ...blankRow]
  }

  return [...sparkCells(mood, pose), ...sprite]
}

/** Raster's `cells`: padded base64 of little-endian u32 triplets. */
export function encodeCells(cells: readonly Cell[]): string {
  const bytes = new Uint8Array(cells.length * 12)
  const view = new DataView(bytes.buffer)

  cells.forEach((cell, index) => {
    view.setUint32(index * 12, cell[0], true)
    view.setUint32(index * 12 + 4, cell[1], true)
    view.setUint32(index * 12 + 8, cell[2], true)
  })

  let binary = ''

  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary)
}

/** A key that changes only when the drawing does, so a tick repaints nothing it need not. */
export function frameKey(mood: MascotMood, now: number): string {
  return `${mood}:${poseAt(mood, now)}`
}
