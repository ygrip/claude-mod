// The mod against the engine's own hooks chain: each `on` here stands for the engine beneath it.
import { describe, expect, mock, test } from 'claude-code/testing'
import type { AgentSpawnInput, On } from 'claude-code'

/** What the Agent tool hands agent.spawn, with the fields the engine pins. */
function spawnInput(subagentType: string, description: string, model?: string): AgentSpawnInput {
  return {
    tool_use_id: '',
    prompt: `Task for ${description}`,
    description,
    subagentType,
    provider: { plugin: 'engine', tier: 'core' },
    model,
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  }
}

function standardWorld(on: On, classifierReply = 'worker') {
  mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/home/me' })
  on('fs.exists', () => ({ value: false }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.messages', () => ({ value: [] }))
  on('agent.list', () => ({ value: [] }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('model.complete', () => ({
    value: {
      isAnswered: true,
      text: classifierReply,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }))
}

describe('auto route', () => {
  const cases: ReadonlyArray<readonly [string, string | undefined, string]> = [
    ['Explore', undefined, 'haiku'],
    ['Plan', undefined, 'opus'],
    ['punakawan-bagong', undefined, 'sonnet'],
    ['general-purpose', undefined, 'sonnet'],
    ['Explore', 'opus', 'opus'],
  ]

  for (const [subagentType, given, expected] of cases) {
    test(`${subagentType} with model ${String(given)} runs on ${expected}`, async ($, on) => {
      standardWorld(on)
      const seen: Array<string | undefined> = []
      on('agent.spawn', (_, e) => {
        seen.push(e.model)

        return { model: e.model ?? 'inherit', agentId: 'agent-1' }
      })

      await $.agent.spawn(spawnInput(subagentType, 'find', given))

      expect(seen).toEqual([expected])
    })
  }

  test('an unknown classifier answer leaves the model to the agent', async ($, on) => {
    standardWorld(on, 'banana')
    const seen: Array<string | undefined> = []
    on('agent.spawn', (_, e) => {
      seen.push(e.model)

      return { model: 'inherit', agentId: 'agent-2' }
    })

    await $.agent.spawn(spawnInput('general-purpose', 'misc'))

    expect(seen).toEqual([undefined])
  })

  test('autoRoute off leaves every spawn alone', { options: { autoRoute: false } }, async ($, on) => {
    standardWorld(on)
    const seen: Array<string | undefined> = []
    on('agent.spawn', (_, e) => {
      seen.push(e.model)

      return { model: 'inherit', agentId: 'agent-3' }
    })

    await $.agent.spawn(spawnInput('Explore', 'find'))

    expect(seen).toEqual([undefined])
  })
})

describe('advisor loop gate', () => {
  test('the fourth identical call is refused and an advisor starts', async ($, on) => {
    standardWorld(on)
    let ran = 0
    on('tool.call', () => {
      ran += 1

      return { result: {} }
    })

    const results = []

    for (let index = 0; index < 4; index++) {
      results.push(await $.tool.call({ tool: 'Bash', command: 'git push' }))
    }

    expect(ran).toBe(3)
    expect(results[3]?.deny).toContain('Loop detected')
    expect(results[3]?.deny).toContain('jar_advisor action=wait id=a1')
  })

  test('re-reading a file is never a loop', async ($, on) => {
    standardWorld(on)
    on('tool.call', () => ({ result: {} }))

    for (let index = 0; index < 5; index++) {
      const result = await $.tool.call({ tool: 'Read', file_path: '/proj/a.ts' })

      expect(result.deny).toBeUndefined()
    }
  })

  test('gates off lets the loop run', { options: { advisorGates: false } }, async ($, on) => {
    standardWorld(on)
    on('tool.call', () => ({ result: {} }))

    for (let index = 0; index < 5; index++) {
      const result = await $.tool.call({ tool: 'Bash', command: 'git push' })

      expect(result.deny).toBeUndefined()
    }
  })
})

const BAND = {
  plugin: 'jar',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 12,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
} as const

describe('perch', () => {
  test('Ember draws as a Raster on the terminal and as a face elsewhere', async ($, on) => {
    standardWorld(on)
    const terminal = await $.ui.mount({ ...BAND, surface: 'terminal' })

    expect(await terminal.find({ key: 'ember' })).toBeDefined()
    await terminal.unmount()

    const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })

    expect((await desktop.find({ type: 'Text', text: /▐/ }))?.text).toContain('▐')
    await desktop.unmount()
  })

  test('a created task perches beside Ember and expands on press', async ($, on) => {
    standardWorld(on)
    on('tool.call', () => ({ result: { task: { id: '1', subject: 'Write tests' } } }))

    await $.tool.call({ tool: 'TaskCreate', subject: 'Write tests', description: 'cover the mod' })

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface })

      expect((await ui.find({ type: 'Text', text: /Tasks · 0\/1 done/ }))?.text).toContain('▸ Tasks')
      await ui.press({ key: 'jar-tasks' })
      expect(await ui.find({ type: 'Text', text: /☐ Write tests/ })).toBeDefined()
      await ui.press({ key: 'jar-tasks' })
      await ui.unmount()
    }
  })
})

describe('jar_discuss', () => {
  test('a subagent question reaches the main conversation', async ($, on) => {
    standardWorld(on)
    const session = mock.session(on)
    on('agent.spawn', () => ({ model: 'inherit', agentId: 'agent-9' }))
    on('tool.run', () => ({ result: 'unanswered' }))

    await $.agent.spawn(spawnInput('Explore', 'scout'))
    const asked = await $.tool.run({
      tool: 'mcp__jar__jar_discuss',
      tool_use_id: 't1',
      agentId: 'agent-9',
      action: 'ask',
      text: 'Which module owns routing?',
      to: 'moderator',
    } as never)

    expect(String(asked.result)).toContain('Posted d1 → moderator')
    expect(JSON.stringify(session.appended())).toContain('[d1] Q · scout → moderator: Which module owns routing?')
  })
})
