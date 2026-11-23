import { describe, expect, test } from 'claude-code/testing'

import type { MoodState, TaskBoard } from '../types'
import {
  encodeCells,
  faceOf,
  type MascotMood,
  moodAt,
  PERCH_ROWS,
  perchCells,
  SLEEPY_AFTER_MS,
  SPRITE_WIDTH,
  withFlash,
} from '../hooks/mascot'
import { progressionPhrase, spinnerWord } from '../hooks/spinner'
import {
  applyCreate,
  applyTodoWrite,
  applyUpdate,
  clearIfDone,
  createdTask,
  createdTaskId,
  heading,
  visibleItems,
} from '../hooks/tasks'

const MOODS: readonly MascotMood[] = ['idle', 'blink', 'happy', 'thinking', 'tool', 'waiting', 'sleepy', 'error', 'complete']

describe('Ember', () => {
  for (const mood of MOODS) {
    test(`${mood} fills the 11x6 perch in every pose`, () => {
      for (const pose of [0, 1, 2, 3]) {
        const cells = perchCells(mood, pose)

        expect(cells.length).toBe(SPRITE_WIDTH * PERCH_ROWS)
        expect(encodeCells(cells).length).toBe(Math.ceil((cells.length * 12) / 3) * 4)
      }
    })
  }

  const moodCases: ReadonlyArray<readonly [string, MoodState, number, MascotMood]> = [
    ['tool phase', { phase: 'tool', lastActive: 0 }, 1_000, 'tool'],
    ['waiting phase', { phase: 'waiting', lastActive: 0 }, 1_000, 'waiting'],
    ['long idle', { phase: 'idle', lastActive: 0 }, SLEEPY_AFTER_MS + 1_000, 'sleepy'],
    ['idle between blinks', { phase: 'idle', lastActive: 0 }, 1_000, 'idle'],
    ['blink window', { phase: 'idle', lastActive: 0 }, 4_500 * 3 + 10, 'blink'],
  ]

  for (const [name, state, now, expected] of moodCases) {
    test(`${name} → ${expected}`, () => {
      expect(moodAt(state, now)).toBe(expected)
    })
  }

  test('a flash wins until it ends', () => {
    const flashed = withFlash({ phase: 'idle', lastActive: 0 }, 'error', 3_000, 10_000)

    expect(moodAt(flashed, 12_000)).toBe('error')
    expect(moodAt(flashed, 14_000)).toBe('idle')
  })

  test('the compact face', () => {
    expect(faceOf('idle')).toBe('▐▪▄▪▌')
  })
})

describe('task board', () => {
  const empty: TaskBoard = { items: [], isExpanded: false }

  test('create, update and delete', () => {
    const id = createdTaskId('Task #7 created successfully: Write tests') ?? ''
    let board = applyCreate(empty, id, { subject: 'Write tests' })
    board = applyCreate(board, '8', { subject: 'Ship' })
    board = applyUpdate(board, { taskId: '7', status: 'in_progress' })

    expect(heading(board)).toBe('▸ Tasks · 0/2 done · Write tests')

    board = applyUpdate(board, { taskId: '8', status: 'deleted' })
    board = applyUpdate(board, { taskId: '7', status: 'completed' })

    expect(board.items).toEqual([{ id: '7', title: 'Write tests', status: 'completed' }])
    expect(clearIfDone(board).items).toEqual([])
  })

  const createdCases: ReadonlyArray<readonly [unknown, unknown]> = [
    [{ task: { id: '3', subject: 'Port Ember' } }, { id: '3', subject: 'Port Ember' }],
    [{ task: { id: '' } }, undefined],
    ['Task #3 created', undefined],
    [null, undefined],
  ]

  for (const [result, expected] of createdCases) {
    test(`createdTask(${JSON.stringify(result)})`, () => {
      expect(createdTask(result)).toEqual(expected)
    })
  }

  test('TodoWrite replaces the list', () => {
    const board = applyTodoWrite(empty, {
      todos: [
        { content: 'one', status: 'completed' },
        { content: 'two', status: 'in_progress' },
        { content: '', status: 'pending' },
      ],
    })

    expect(board.items.map(item => `${item.id}:${item.status}`)).toEqual(['1:completed', '2:in_progress'])
  })

  test('the window follows the task in progress', () => {
    const todos = Array.from({ length: 8 }, (_, index) => {
      let status = 'pending'

      if (index === 6) {
        status = 'in_progress'
      }

      return { content: `t${index}`, status }
    })
    const board = applyTodoWrite(empty, { todos })

    expect(visibleItems(board).map(item => item.title)).toEqual(['t4', 't5', 't6', 't7'])
  })
})

describe('spinner phrases', () => {
  const cases: ReadonlyArray<readonly [number, string]> = [
    [0, 'A spark remains'],
    [10, 'Kindling a thought'],
    [36, 'Gathering scattered sparks'],
    [500, 'The horizon is clearer now'],
  ]

  for (const [seconds, phrase] of cases) {
    test(`${seconds}s → ${phrase}`, () => {
      expect(progressionPhrase(seconds)).toBe(phrase)
    })
  }

  test('a tool call names the tool', () => {
    expect(spinnerWord('tool-use', 3, 'Bash')).toBe('Tracing light through Bash')
  })
})
