// The jar panel mounted through the engine's own chain, on every surface.
import type { AgentInfo, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'jar',
  component: 'Pane',
  requestId: 'jar',
  props: {
    title: 'jar',
    isFocused: true,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

const NOW = 1_000_000

const AGENTS = [
  {
    id: 'a1',
    description: 'map the repo',
    type: 'Explore',
    status: 'running',
    kind: 'local_agent',
    taskStatus: 'running',
    label: 'a1',
    startTime: NOW - 65_000,
    cwd: '/proj',
    model: 'claude-haiku-5-5',
    tokenCount: 5_000,
    contextWindowSize: 20_000,
    tokenSamples: [1_000, 2_500, 5_000],
    hasRow: true,
    cost: { usd: 0.25 },
    usage: [
      {
        model: 'claude-haiku-5-5',
        input_tokens: 4_000,
        output_tokens: 1_000,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    ],
  },
] as unknown as AgentInfo[]

function world(on: On, files: Record<string, string> = {}, writes: Array<{ path: string; text: string }> = []) {
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/home/me' })
  on('session.cwd', () => ({ value: '/proj' }))
  on('agent.list', () => ({ value: AGENTS }))
  on('ui.log', () => ({ value: undefined }))
  on('fs.exists', (_, e) => ({ value: files[e.path] !== undefined }))
  on('fs.read', (_, e) => ({ value: files[e.path] ?? '' }))
  on('fs.write', (_, e) => {
    writes.push({ path: e.path, text: e.text })

    return { value: undefined }
  })
  on('process.run', () => ({
    value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('session.usage', () => ({
    value: {
      startedAt: NOW - 600_000,
      context: { tokens: 50_000, window: 200_000, percent: 25 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 40, resetsAt: new Date(NOW + 3_600_000).toISOString() }],
      cost: { usd: 1.75 },
    },
  }))
}

for (const surface of SURFACES) {
  test(`agents tab lists a subagent and opens its detail on ${surface}`, async ($, on) => {
    world(on)
    const ui = await $.ui.mount({ ...PANE, surface })

    const row = await ui.find({ key: 'agent-a1' })
    expect(row?.text).toContain('map the repo')
    expect(row?.text).toContain('Explore')

    await ui.press({ key: 'agent-a1' })

    expect(await ui.find({ key: 'agents-back' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /input 4\.0k/ }))?.text).toContain('output 1.0k')

    await ui.press({ key: 'agents-back' })
    expect(await ui.find({ key: 'agent-a1' })).toBeDefined()
    await ui.unmount()
  })
}

test('cost tab splits the session total between main thread and subagents', async ($, on) => {
  world(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'tab-cost' })

  const total = await ui.find({ type: 'Text', text: /Session \$1\.75/ })
  expect(total).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /main thread/ }))?.text).toContain('subagents $0.25')
  await ui.unmount()
})

test('roles tab edits a role and saves it to the chosen file', async ($, on) => {
  const writes: Array<{ path: string; text: string }> = []
  world(on, {}, writes)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'tab-roles' })
  expect((await ui.find({ key: 'role-worker' }))?.text).toContain('sonnet')

  await ui.press({ key: 'role-worker' })
  await ui.select({ key: 'edit-model', value: 'opus' })
  await ui.select({ key: 'edit-effort', value: 'high' })
  await ui.select({ key: 'edit-scope', value: 'project' })
  expect((await ui.find({ type: 'Text', text: /will save/ }))?.text).toBe('will save: worker → opus:high (project)')

  await ui.press({ key: 'edit-save' })

  expect(writes).toHaveLength(1)
  expect(writes[0]?.path).toBe('/proj/.claude/jar-roles.json')
  expect(JSON.parse(writes[0]?.text ?? '{}')).toEqual({ version: 2, roles: { worker: 'opus:high' } })
  expect(await ui.find({ key: 'edit-save' })).toBeUndefined()
  await ui.unmount()
})

test('a typed model spec fills the draft, a bad one is refused', async ($, on) => {
  world(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'tab-roles' })
  await ui.press({ key: 'role-scout' })
  await ui.input({ key: 'edit-custom', text: 'two words' })
  expect((await ui.find({ type: 'Text', text: /Not a model spec/ }))?.text).toContain('two words')

  await ui.input({ key: 'edit-custom', text: 'claude-opus-5-5:max' })
  expect((await ui.find({ type: 'Text', text: /will save/ }))?.text).toBe('will save: scout → claude-opus-5-5:max (global)')
  await ui.unmount()
})

test('reset removes a role from the file that holds it', async ($, on) => {
  const writes: Array<{ path: string; text: string }> = []
  world(on, { '/home/me/.claude/jar/roles.json': JSON.stringify({ version: 2, roles: { worker: 'opus', scout: 'sonnet' } }) }, writes)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'tab-roles' })
  await ui.press({ key: 'role-worker' })
  await ui.press({ key: 'edit-reset' })

  expect(writes).toHaveLength(1)
  expect(JSON.parse(writes[0]?.text ?? '{}')).toEqual({ version: 2, roles: { scout: 'sonnet' } })
  await ui.unmount()
})
