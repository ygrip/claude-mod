import { describe, expect, test } from 'claude-code/testing'

import { DEFAULT_ROLES, mergeRoles, normalizeSpec, parseRoleConfig, resolveRole } from '../hooks/roles'
import { classifierPrompt, parseClassifierAnswer, roleForType } from '../hooks/route-rules'

describe('normalizeSpec', () => {
  const cases: ReadonlyArray<readonly [string, string | undefined]> = [
    ['haiku', 'haiku'],
    ['  sonnet:high ', 'sonnet:high'],
    ['claude-opus-5-5[1m]', 'claude-opus-5-5[1m]'],
    ['@plan:xhigh', '@plan:xhigh'],
    ['*', '*'],
    ['inherit', '*'],
    ['@Bad', undefined],
    ['two words', undefined],
    ['', undefined],
  ]

  for (const [raw, expected] of cases) {
    test(`"${raw}" → ${String(expected)}`, () => {
      expect(normalizeSpec(raw)).toBe(expected)
    })
  }
})

describe('resolveRole', () => {
  const roles = mergeRoles({ alpha: '@beta:low', beta: '@gamma', gamma: 'opus:max', loop: '@loop', open: '@missing' })
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ['scout', { model: 'haiku', effort: undefined, via: ['scout'] }],
    ['advisor', { model: 'opus', effort: 'high', via: ['advisor'] }],
    ['alpha', { model: 'opus', effort: 'low', via: ['alpha', 'beta', 'gamma'] }],
    ['task', { model: undefined, effort: undefined, via: ['task', 'default'] }],
    ['loop', { error: 'alias cycle: loop → loop' }],
    ['open', { error: '@missing is not assigned' }],
  ]

  for (const [role, expected] of cases) {
    test(`resolves ${role}`, () => {
      expect(resolveRole(roles, role)).toEqual(expected)
    })
  }
})

describe('config files', () => {
  test('keeps valid roles and drops the rest, project over global over defaults', () => {
    const global = parseRoleConfig({ version: 2, roles: { worker: 'opus', Bad: 'haiku', scout: 'not a spec!' } })
    const project = parseRoleConfig({ version: 2, roles: { worker: '@plan:high' } })
    const merged = mergeRoles(global.roles, project.roles)

    expect(global.roles).toEqual({ worker: 'opus' })
    expect(merged.worker).toBe('@plan:high')
    expect(merged.scout).toBe(DEFAULT_ROLES.scout)
  })

  test('ignores a file that is not an object', () => {
    expect(parseRoleConfig('nope')).toEqual({ version: 2, roles: {} })
  })
})

describe('roleForType', () => {
  const cases: ReadonlyArray<readonly [string, string | undefined]> = [
    ['Explore', 'scout'],
    ['Plan', 'plan'],
    ['claude-code-guide', 'scout'],
    ['punakawan-bagong-high', 'reviewer'],
    ['punakawan-petruk', 'worker'],
    ['punakawan-gareng', 'plan'],
    ['general-purpose', undefined],
    ['statusline-setup', undefined],
  ]

  for (const [type, expected] of cases) {
    test(`${type} → ${String(expected)}`, () => {
      expect(roleForType(type)).toBe(expected)
    })
  }
})

describe('parseClassifierAnswer', () => {
  const cases: ReadonlyArray<readonly [string, string | undefined]> = [
    ['worker', 'worker'],
    [' Reviewer.\n', 'reviewer'],
    ['plan - design first', 'plan'],
    ['banana', undefined],
    ['', undefined],
  ]

  for (const [text, expected] of cases) {
    test(`"${text.trim()}" → ${String(expected)}`, () => {
      expect(parseClassifierAnswer(text)).toBe(expected)
    })
  }

  test('the classifier prompt clips a long task', () => {
    const prompt = classifierPrompt('Fix it', 'x'.repeat(5_000))

    expect(prompt.length).toBeLessThan(1_600)
    expect(prompt.startsWith('Task title: Fix it')).toBe(true)
  })
})
