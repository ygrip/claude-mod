import { describe, expect, test } from 'claude-code/testing'

import { advisorPrompt, callKey, loopExempt, StuckDetector, transcript } from '../hooks/advisor-core'

describe('loop gate', () => {
  test('the fourth identical call in eight is a loop', () => {
    const detector = new StuckDetector()
    const key = callKey('Bash', { command: 'ls' })

    expect([detector.call(key), detector.call(key), detector.call(key)]).toEqual([undefined, undefined, undefined])
    expect(detector.call(key)).toContain('same tool call 4 times')
  })

  test('different calls in between still count inside the window', () => {
    const detector = new StuckDetector()
    const key = callKey('Edit', { file_path: 'a.ts' })
    const results = [key, 'x', key, 'y', key, 'z'].map(item => detector.call(item))

    expect(results.every(result => result === undefined)).toBe(true)
    expect(detector.call(key)).toBeDefined()
  })

  test('two automatic consults per prompt, then quiet until reset', () => {
    const detector = new StuckDetector()
    const failThreeTimes = () => [1, 2, 3].map(() => detector.result(true, 'Bash')).at(-1)

    expect(failThreeTimes()).toContain('3 tool calls in a row failed')
    expect(failThreeTimes()).toBeDefined()
    expect(failThreeTimes()).toBeUndefined()
    detector.reset()
    expect(failThreeTimes()).toBeDefined()
  })

  test('a success breaks the failure streak', () => {
    const detector = new StuckDetector()
    detector.result(true, 'Bash')
    detector.result(true, 'Bash')
    detector.result(false, 'Bash')

    expect(detector.result(true, 'Bash')).toBeUndefined()
  })

  test('a long input keeps a prefix and a digest', () => {
    const key = callKey('Write', { content: 'x'.repeat(5_000) })

    expect(key.length).toBeLessThan(260)
    expect(key).toContain('…#')
    expect(callKey('Write', { content: 'y'.repeat(5_000) })).not.toBe(key)
  })
})

describe('loopExempt', () => {
  const cases: ReadonlyArray<readonly [string, Record<string, unknown>, boolean]> = [
    ['Read', { file_path: 'a' }, true],
    ['Grep', { pattern: 'x' }, true],
    ['Bash', { command: 'npm test' }, true],
    ['Bash', { command: 'cd x && ./gradlew clean test' }, true],
    ['Bash', { command: 'claude plugin test jar' }, true],
    ['Bash', { command: 'git status' }, false],
    ['Edit', { file_path: 'a' }, false],
  ]

  for (const [tool, input, expected] of cases) {
    test(`${tool} ${JSON.stringify(input)} → ${String(expected)}`, () => {
      expect(loopExempt(tool, input)).toBe(expected)
    })
  }
})

describe('advisor prompt', () => {
  test('names the trigger, question, draft, repository and conversation in order', () => {
    const prompt = advisorPrompt({ trigger: 'loop', question: 'Why?', draft: 'Plan B' }, 'convo', 'M a.ts')

    expect(prompt.split('\n\n')).toEqual([
      'Automatic consultation: loop',
      "Executor's question: Why?",
      "Executor's draft / candidate approach:\nPlan B",
      'Repository state:\nM a.ts',
      'Recent conversation:\nconvo',
    ])
  })

  test('the transcript keeps the newest messages and cuts tool results', () => {
    const text = transcript(
      [
        { role: 'user', text: 'old '.repeat(100), toolUses: [] },
        {
          role: 'assistant',
          text: 'Running it',
          toolUses: [{ tool_use_id: 't', tool: 'Bash', input: { command: 'make' }, text: 'e'.repeat(3_000), isError: true }],
        },
      ],
      500,
    )

    expect(text.startsWith('### user') || text.startsWith('### assistant')).toBe(true)
    expect(text).toContain('[tool Bash command=make]')
    expect(text.length).toBeLessThanOrEqual(500 + 2)
  })
})
