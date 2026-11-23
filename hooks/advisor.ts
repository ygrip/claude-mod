// Auto advisor: a second opinion from the `advisor` role when the main agent loops or keeps failing,
// plus the jar_advisor tool and /advisor. Advice reaches the main agent as a reminder on its next request.
import { atom, read, update } from 'claude-code'
import type { Args, EngineInterface, On, PluginOptions } from 'claude-code'

import type { AdvisorData, AdvisorRecord } from '../types'
import type { NextFn, StepResult } from './chain'
import {
  ADVISOR_SYSTEM,
  type AdvisorRequest,
  advisorPrompt,
  callKey,
  loopExempt,
  StuckDetector,
  transcript,
} from './advisor-core'
import { loadRoles } from './role-files'
import { isResolved, resolveRole } from './roles'
import { INITIAL_ADVISOR } from './state'

const advisorAtom = atom({ plugin: 'jar', key: 'advisor' } as const, INITIAL_ADVISOR, { shape: 'advisor-1' })

export const ADVISOR_TOOL = 'mcp__jar__jar_advisor'
const DEADLINE_MS = 60_000
const MAX_RUNNING = 2
const MAX_KEPT = 16
const MAX_WAIT_MS = 30_000
const WAIT_STEP_MS = 500
const GIT_LIMIT = 4_000
const ANSWER_LIMIT = 8_000
const QUESTION_LIMIT = 2_000
const DRAFT_LIMIT = 8_000

const DESCRIPTION = [
  'Start a background second opinion from the advisor model and return its request ID immediately.',
  'Start is a pending receipt, not approval: collect the advice with get or wait before deciding.',
  'Use only when the user asks or after two failed attempts at the same problem; pass your candidate approach as draft.',
  'Actions: start (question?, draft?), status, get (id), wait (id, waitMs ≤30000), cancel (id).',
].join(' ')

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['start', 'status', 'get', 'wait', 'cancel'] },
    id: { type: 'string', description: 'get/wait/cancel: the request id, e.g. a3.' },
    waitMs: { type: 'number', description: 'wait: up to 30000 ms.' },
    question: { type: 'string', description: 'start: what to ask (≤2000 chars).' },
    draft: { type: 'string', description: 'start: your candidate approach (≤8000 chars).' },
  },
}

/** Per-session gate counters and cancel handles; a reload starts them over. */
const detector = new StuckDetector()
const controllers = new Map<string, AbortController>()

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object') {
    return value as Record<string, unknown>
  }

  return {}
}

function optionalText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined
  }

  return value.trim().slice(0, limit)
}

async function gitState($: EngineInterface): Promise<string> {
  const run = async (argv: string[]) => {
    try {
      const result = await $.process.run(argv, { timeoutMs: 5_000 })

      return result.stdout.trim()
    } catch (error) {
      return `(${argv.join(' ')} failed: ${String(error)})`
    }
  }
  const status = await run(['git', 'status', '--short', '--branch'])
  const diff = await run(['git', 'diff', '--stat', 'HEAD'])

  return [status, diff].filter(part => part !== '').join('\n').slice(0, GIT_LIMIT)
}

function record(data: AdvisorData, id: string): AdvisorRecord | undefined {
  return data.records.find(entry => entry.id === id)
}

function withRecord(data: AdvisorData, id: string, change: Partial<AdvisorRecord>): AdvisorData {
  const records = data.records.map(entry => {
    if (entry.id !== id) {
      return entry
    }

    return { ...entry, ...change }
  })

  return { ...data, records }
}

async function finish($: EngineInterface, id: string, change: Partial<AdvisorRecord>): Promise<void> {
  await update($, advisorAtom, data => withRecord(data, id, change))
}

async function deliverAdvice($: EngineInterface, id: string, text: string): Promise<void> {
  const note = `[advisor ${id}] Second opinion from the advisor role:\n${text}`
  const appended = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: note }] } })

  if (appended.deny !== undefined) {
    $.ui.log(`jar advisor: ${id} could not be delivered (${appended.deny}); use jar_advisor get`)
  }

  $.ui.toast(`Advisor ${id} completed; result available`)
}

async function consult($: EngineInterface, id: string, request: AdvisorRequest, controller: AbortController): Promise<void> {
  const roles = await loadRoles($)
  const role = resolveRole(roles, 'advisor')
  let model = await $.session.model()
  let effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined

  if (isResolved(role)) {
    model = role.model ?? model
    effort = role.effort
  }

  const conversation = transcript(await $.session.messages())
  const reply = await $.model.complete(
    {
      model,
      effort,
      maxTokens: 2_048,
      system: ADVISOR_SYSTEM,
      prompt: advisorPrompt(request, conversation, await gitState($)),
    },
    { signal: controller.signal },
  )

  if (!reply.isAnswered) {
    await finish($, id, { status: 'failed', text: `no advice: ${reply.reason}` })

    return
  }

  const text = reply.text.slice(0, ANSWER_LIMIT)
  await finish($, id, { status: 'done', text })
  await deliverAdvice($, id, text)
}

/** Starts a consultation in the background; answers its id, or why none started. */
export async function startAdvisor($: EngineInterface, request: AdvisorRequest): Promise<string> {
  const data = await read($, advisorAtom)
  const running = data.records.filter(entry => entry.status === 'running').length

  if (running >= MAX_RUNNING) {
    throw new Error(`${running} advisor requests are already running; wait for one first.`)
  }

  const id = `a${data.next}`
  const entry: AdvisorRecord = {
    id,
    status: 'running',
    startedAt: await $.clock.now(),
    trigger: request.trigger,
    question: request.question,
  }
  await update($, advisorAtom, current => ({
    next: current.next + 1,
    records: [...current.records, entry].slice(-MAX_KEPT),
  }))

  void consultInBackground($, id, request)

  return id
}

/** Never rejects: a failure is recorded on the request, or logged when even that fails. */
async function consultInBackground($: EngineInterface, id: string, request: AdvisorRequest): Promise<void> {
  const controller = new AbortController()
  controllers.set(id, controller)
  const deadline = $.clock.after(DEADLINE_MS, () => controller.abort())

  try {
    await consult($, id, request, controller)
  } catch (error) {
    await recordFailure($, id, error)
  } finally {
    deadline.cancel()
    controllers.delete(id)
  }
}

async function recordFailure($: EngineInterface, id: string, error: unknown): Promise<void> {
  try {
    await finish($, id, { status: 'failed', text: String(error) })
  } catch (recordError) {
    $.ui.log(`jar advisor: ${id} failed (${String(error)}); recording it failed too (${String(recordError)})`)
  }
}

function describe(entry: AdvisorRecord): string {
  const head = `${entry.id} · ${entry.status}`

  if (entry.text === undefined) {
    return head
  }

  return `${head}\n${entry.text}`
}

async function waitFor($: EngineInterface, id: string, waitMs: number): Promise<AdvisorRecord | undefined> {
  const until = (await $.clock.now()) + Math.min(Math.max(0, waitMs), MAX_WAIT_MS)

  for (;;) {
    const entry = record(await read($, advisorAtom), id)

    if (entry === undefined || entry.status !== 'running') {
      return entry
    }

    if ((await $.clock.now()) >= until) {
      return entry
    }

    await $.clock.sleep(WAIT_STEP_MS)
  }
}

async function runTool($: EngineInterface, input: Record<string, unknown>): Promise<string> {
  const action = String(input.action ?? 'start')
  const id = optionalText(input.id, 64) ?? ''

  if (action === 'start') {
    const started = await startAdvisor($, {
      question: optionalText(input.question, QUESTION_LIMIT),
      draft: optionalText(input.draft, DRAFT_LIMIT),
    })

    return `Advisor ${started} started. Collect it with jar_advisor action=wait id=${started}.`
  }

  if (action === 'status') {
    const data = await read($, advisorAtom)

    return data.records.map(entry => `${entry.id} · ${entry.status}`).join('\n') || 'No advisor requests yet.'
  }

  if (action === 'cancel') {
    controllers.get(id)?.abort()
    await finish($, id, { status: 'cancelled' })

    return `Advisor ${id} cancelled.`
  }

  let waitMs = 0

  if (action === 'wait') {
    waitMs = Number(input.waitMs ?? MAX_WAIT_MS)
  }

  const entry = await waitFor($, id, waitMs)

  if (entry === undefined) {
    return `Unknown advisor request ${id}.`
  }

  return describe(entry)
}

export async function advisorSummary($: EngineInterface): Promise<string> {
  const data = await read($, advisorAtom)
  const running = data.records.filter(entry => entry.status === 'running').length

  return `advisor: ${data.records.length} kept, ${running} running`
}

/** Set at register from the mod's options. */
let isGated = true

export function registerAdvisor(on: On, options: PluginOptions): void {
  isGated = options.advisorGates !== false

  on('tool.run', { tool: ADVISOR_TOOL }, async ($, e) => {
    try {
      return { result: await runTool($, asRecord(e)) }
    } catch (error) {
      return { deny: String(error) }
    }
  })
}

export async function advisorSessionStart(
  $: EngineInterface,
  e: Args<'session.start'>,
  next: NextFn<'session.start'>,
): StepResult<'session.start'> {
  const answer = await next(e)
  // Kept in the tool list, so a loop-gate refusal can point at it without a ToolSearch first.
  await $.tool.register({ name: 'jar_advisor', description: DESCRIPTION, inputSchema: INPUT_SCHEMA, isDeferred: false })

  return answer
}

export async function advisorPromptSubmit(
  $: EngineInterface,
  e: Args<'prompt.submit'>,
  next: NextFn<'prompt.submit'>,
): StepResult<'prompt.submit'> {
  detector.reset()

  return next(e)
}

const LOOP_DENIAL =
  'Loop detected: you made the same call repeatedly. Change approach. ' +
  'An advisor is reviewing in the background'

/** The loop gate refuses the repeat; the failure gate consults without blocking. */
export async function advisorToolCall(
  $: EngineInterface,
  e: Args<'tool.call'>,
  next: NextFn<'tool.call'>,
): StepResult<'tool.call'> {
  const tool = String(e.tool)
  const isOwnTool = tool.startsWith('mcp__jar__')

  if (!isGated || e.agentId !== undefined || isOwnTool) {
    return next(e)
  }

  const input = asRecord(e)

  if (!loopExempt(tool, input)) {
    const loop = detector.call(callKey(tool, stripEnvelope(input)))

    if (loop !== undefined) {
      return { deny: await loopDenial($, loop) }
    }
  }

  const ran = await next(e)
  const failure = detector.result(ran.deny !== undefined || ran.isError === true, tool)

  if (failure !== undefined) {
    await startQuietly($, failure)
  }

  return ran
}

async function loopDenial($: EngineInterface, trigger: string): Promise<string> {
  try {
    const id = await startAdvisor($, { trigger })

    return `${LOOP_DENIAL} as ${id}; collect its advice with jar_advisor action=wait id=${id}.`
  } catch (error) {
    $.ui.log(`jar advisor: ${String(error)}`)

    return `${LOOP_DENIAL.replace('An advisor is reviewing in the background', 'Step back and rethink the approach')}.`
  }
}

async function startQuietly($: EngineInterface, trigger: string): Promise<void> {
  try {
    await startAdvisor($, { trigger })
  } catch (error) {
    $.ui.log(`jar advisor: ${String(error)}`)
  }
}

/** The call's own arguments, without the envelope keys every call carries. */
function stripEnvelope(input: Record<string, unknown>): Record<string, unknown> {
  const { tool: _tool, tool_use_id: _id, agentId: _agent, requestMeta: _meta, ...rest } = input

  return rest
}
