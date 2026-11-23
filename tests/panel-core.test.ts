import type { AgentInfo, TurnUsage } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import {
  agentRows,
  costSplit,
  draftOf,
  duration,
  modelChoices,
  money,
  resetsIn,
  roleRows,
  sparkline,
  specOf,
  tokens,
} from '../hooks/panel-core'

const NOW = 1_000_000

function usage(model: string, input: number, output: number): TurnUsage {
  return { model, input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
}

function agent(fields: Partial<AgentInfo>): AgentInfo {
  const base = {
    id: 'a1',
    description: 'look around',
    type: 'Explore',
    status: 'running',
    kind: 'local_agent',
    taskStatus: 'running',
    label: 'a1',
    startTime: NOW - 65_000,
    cwd: '/tmp',
    tokenCount: 5_000,
    tokenSamples: [],
    hasRow: true,
  }

  return { ...base, ...fields } as AgentInfo
}

describe('formatting', () => {
  const moneyCases: ReadonlyArray<readonly [number, string]> = [
    [0, '$0.00'],
    [0.004, '<$0.01'],
    [0.126, '$0.13'],
    [12, '$12.00'],
  ]

  for (const [usd, expected] of moneyCases) {
    test(`money ${usd}`, () => {
      expect(money(usd)).toBe(expected)
    })
  }

  const tokenCases: ReadonlyArray<readonly [number, string]> = [
    [999, '999'],
    [1_500, '1.5k'],
    [2_340_000, '2.34M'],
  ]

  for (const [count, expected] of tokenCases) {
    test(`tokens ${count}`, () => {
      expect(tokens(count)).toBe(expected)
    })
  }

  const durationCases: ReadonlyArray<readonly [number, string]> = [
    [4_000, '4s'],
    [65_000, '1m 05s'],
    [3_720_000, '1h 02m'],
  ]

  for (const [ms, expected] of durationCases) {
    test(`duration ${ms}`, () => {
      expect(duration(ms)).toBe(expected)
    })
  }

  test('sparkline scales to the peak and needs two samples', () => {
    expect(sparkline([1], 8)).toBe('')
    expect(sparkline([0, 4, 8], 8)).toBe('▁▅█')
    expect(sparkline([1, 2, 3, 4], 2)).toHaveLength(2)
  })

  test('resetsIn counts down and hides a past stamp', () => {
    expect(resetsIn(new Date(NOW + 125_000).toISOString(), NOW)).toBe('resets in 2m 05s')
    expect(resetsIn(new Date(NOW - 1).toISOString(), NOW)).toBe('')
    expect(resetsIn(undefined, NOW)).toBe('')
  })
})

describe('agents', () => {
  test('live agents come first, then the newest', () => {
    const rows = agentRows(
      [
        agent({ id: 'old', status: 'completed', startTime: NOW - 500 }),
        agent({ id: 'new', status: 'completed', startTime: NOW - 100 }),
        agent({ id: 'live', status: 'running', startTime: NOW - 900 }),
      ],
      NOW,
    )

    expect(rows.map(row => row.id)).toEqual(['live', 'new', 'old'])
  })

  test('a row carries elapsed time, context share and cost', () => {
    const [row] = agentRows(
      [agent({ contextWindowSize: 20_000, cost: { usd: 0.5 }, model: 'claude-haiku-5-5', name: 'scout-1' })],
      NOW,
    )

    expect(row).toMatchObject({ title: 'scout-1', elapsed: '1m 05s', contextPercent: 25, usd: 0.5, model: 'claude-haiku-5-5' })
  })
})

describe('cost split', () => {
  test('main thread is the total minus the subagents', () => {
    const split = costSplit(
      3,
      false,
      [
        agent({ id: 'a', cost: { usd: 1 }, usage: [usage('haiku', 100, 50)] }),
        agent({ id: 'b', cost: { usd: 0.5 }, usage: [usage('haiku', 10, 5), usage('sonnet', 1, 1)] }),
      ],
      NOW,
    )

    expect(split.subagentsUsd).toBe(1.5)
    expect(split.mainUsd).toBe(1.5)
    expect(split.topAgents.map(row => row.id)).toEqual(['a', 'b'])
    expect(split.byModel.map(entry => entry.model)).toEqual(['haiku', 'sonnet'])
    expect(split.byModel[0]?.totals).toMatchObject({ input: 110, output: 55 })
  })

  test('never goes negative', () => {
    expect(costSplit(0.1, false, [agent({ cost: { usd: 1 } })], NOW).mainUsd).toBe(0)
  })
})

describe('roles', () => {
  const merged = { default: '*', task: '@default', scout: 'haiku', worker: 'opus:high', zed: '@ghost' }

  test('rows put routed roles first and name their source', () => {
    const rows = roleRows(merged, { worker: 'opus:high' }, { scout: 'haiku' }, ['scout', 'worker'])

    expect(rows.map(row => row.role)).toEqual(['scout', 'worker', 'default', 'task', 'zed'])
    expect(rows.map(row => row.source)).toEqual(['project', 'global', 'default', 'default', 'default'])
    expect(rows[1]).toMatchObject({ resolved: 'opus · high', isBroken: false })
    expect(rows[4]).toMatchObject({ isBroken: true })
  })

  const specCases: ReadonlyArray<readonly [string, string, string]> = [
    ['opus:high', 'opus', 'high'],
    ['haiku', 'haiku', ''],
    ['@plan:low', '@plan', 'low'],
    ['*', '*', ''],
  ]

  for (const [spec, head, effort] of specCases) {
    test(`spec ${spec} round-trips`, () => {
      const draft = draftOf(spec)

      expect(draft).toEqual({ head, effort })
      expect(specOf(draft)).toBe(spec)
    })
  }

  test('inherit drops the effort', () => {
    expect(specOf({ head: '*', effort: 'high' })).toBe('*')
  })

  test('model choices offer other roles and keep a custom value', () => {
    const choices = modelChoices('worker', ['worker', 'plan', 'scout'], 'claude-opus-5-5')

    expect(choices).toEqual(['claude-opus-5-5', '*', 'haiku', 'sonnet', 'opus', '@plan', '@scout'])
  })
})
