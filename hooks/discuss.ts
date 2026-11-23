// jar_discuss: parent-brokered questions and answers between the main agent (moderator) and subagents.
// Messages go straight to the addressee: a subagent by SendMessage delivery, the main agent as a reminder
// its next request carries. Nothing wakes an idle agent; unread mail also rides on replies and turn starts.
import { atom, read, update } from 'claude-code'
import type { Args, EngineInterface, On } from 'claude-code'

import type { HubData } from '../types'
import type { NextFn, StepResult } from './chain'
import {
  DiscussionError,
  DiscussionHub,
  type MessageView,
  messageLine,
  MODERATOR,
  parseDiscussionId,
  type PostResult,
} from './discuss-hub'
import { INITIAL_HUB } from './state'

const hubAtom = atom({ plugin: 'jar', key: 'discussion' } as const, INITIAL_HUB, { shape: 'hub-1' })

export const DISCUSS_TOOL = 'mcp__jar__jar_discuss'

const DESCRIPTION = [
  "Parent-brokered Q/A between this session's moderator (the main agent) and its subagents; never wakes anyone.",
  'ask/answer reply with the new id (never your text) plus your unread mail when it fits.',
  'A question reaches its addressee directly; unread mail (questions to you, broadcasts, answers to your questions;',
  'never your own) also arrives once at your next turn start. list: your unread (≤4000 chars); thread: one question',
  'in full; pending: open counts. One concise question or answer per call; never poll.',
].join(' ')

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['ask', 'answer', 'list', 'thread', 'pending'] },
    text: { type: 'string', description: 'ask/answer: one concise question or answer (≤1600 chars).' },
    to: {
      type: 'string',
      description: 'ask: moderator, a subagent id or unique name; omit to broadcast.',
    },
    questionId: {
      type: 'string',
      description: 'answer: the question being answered (e.g. d12). thread: the question to read in full.',
    },
    since: {
      type: 'string',
      description: 'list: reread your messages newer than this id (d0 = all retained). thread: only answers after it.',
    },
  },
  required: ['action'],
}

type DiscussInput = { action: string; text: string; to?: string; questionId?: number; since?: number }

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object') {
    return value as Record<string, unknown>
  }

  return {}
}

function optionalString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') {
    return value
  }

  return undefined
}

function parseInput(raw: Record<string, unknown>): DiscussInput {
  return {
    action: String(raw.action ?? ''),
    text: String(raw.text ?? ''),
    to: optionalString(raw.to),
    questionId: parseDiscussionId(raw.questionId),
    since: parseDiscussionId(raw.since),
  }
}

function keyOf(agentId: string | undefined): string {
  return agentId ?? MODERATOR
}

/** Runs one hub operation through $.state; the operation may run again on a version miss. */
async function withHub<T>($: EngineInterface, operation: (hub: DiscussionHub) => T): Promise<T> {
  let result: T | undefined
  let isDone = false

  await update($, hubAtom, (data: HubData) => {
    const hub = new DiscussionHub(data)
    result = operation(hub)
    isDone = true

    return hub.data
  })

  if (!isDone) {
    throw new DiscussionError('Discussion state was not updated.')
  }

  return result as T
}

async function agentName($: EngineInterface, agentId: string): Promise<string> {
  const agents = await $.agent.list()
  const agent = agents.find(entry => entry.id === agentId)

  if (agent === undefined) {
    return agentId
  }

  return agent.name ?? agent.description ?? agent.type
}

async function ensureRegistered($: EngineInterface, key: string): Promise<void> {
  const hub = new DiscussionHub(await read($, hubAtom))

  if (hub.has(key)) {
    return
  }

  const name = await agentName($, key)
  await withHub($, current => current.register(key, name))
}

// ---- delivery --------------------------------------------------------------------

function pushText(view: MessageView): string {
  let hint = ''

  if (view.kind === 'question') {
    hint = `\nReply with jar_discuss action=answer questionId=d${view.id} when you can.`
  }

  return `[jar_discuss] ${messageLine(view)}${hint}`
}

async function pushTo($: EngineInterface, key: string, text: string): Promise<boolean> {
  try {
    if (key === MODERATOR) {
      const appended = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })

      return appended.deny === undefined
    }

    const sent = await $.session.send({ to: { agentId: key }, text })

    return sent.isDelivered !== false
  } catch (error) {
    $.ui.log(`jar discuss: delivery to ${key} failed (${String(error)}); it stays unread`)

    return false
  }
}

async function deliver($: EngineInterface, id: number, keys: readonly string[]): Promise<void> {
  const hub = new DiscussionHub(await read($, hubAtom))
  const view = hub.viewFor(id)

  if (view === undefined) {
    return
  }

  const delivered: string[] = []

  for (const key of keys) {
    const isPushed = await pushTo($, key, pushText(view))

    if (isPushed) {
      delivered.push(key)
    }
  }

  if (delivered.length > 0) {
    await withHub($, current => delivered.forEach(key => current.acknowledge(key, [id])))
  }
}

function recipientsOfQuestion(hub: DiscussionHub, sender: string, result: PostResult): string[] {
  if (result.toKey !== undefined) {
    return [result.toKey]
  }

  return hub.recipients(sender)
}

// ---- actions ---------------------------------------------------------------------------

function postSummary(result: PostResult): string {
  const lines: string[] = []
  let head = `Posted d${result.id}`

  if (result.replyTo !== undefined) {
    head += ` (answer to d${result.replyTo})`
  }

  if (result.to !== undefined) {
    head += ` → ${result.to}`
  }

  if (result.clipped) {
    head += ' (clipped to 1600 chars)'
  }

  lines.push(head + '.')

  if (result.delivered.length > 0) {
    lines.push('Your unread mail:', ...result.delivered.map(messageLine))
  } else if (result.unread > 0) {
    lines.push(`${result.unread} unread: jar_discuss list.`)
  }

  return lines.join('\n')
}

async function runAsk($: EngineInterface, sender: string, input: DiscussInput): Promise<string> {
  const result = await withHub($, hub => hub.ask(sender, input.text, input.to))
  const hub = new DiscussionHub(await read($, hubAtom))
  await deliver($, result.id, recipientsOfQuestion(hub, sender, result))

  return postSummary(result)
}

async function runAnswer($: EngineInterface, sender: string, input: DiscussInput): Promise<string> {
  const questionId = input.questionId

  if (questionId === undefined) {
    throw new DiscussionError('answer needs questionId (e.g. d12).')
  }

  const result = await withHub($, hub => hub.answer(sender, questionId, input.text))

  if (result.askerKey !== undefined && result.askerKey !== sender) {
    await deliver($, result.id, [result.askerKey])
  }

  return postSummary(result)
}

async function runList($: EngineInterface, sender: string, input: DiscussInput): Promise<string> {
  const result = await withHub($, hub => hub.list(sender, input.since))

  if (result.messages.length === 0) {
    return 'No unread discussion mail.'
  }

  const lines = result.messages.map(messageLine)

  if (result.more > 0) {
    lines.push(`+${result.more} more: list again.`)
  }

  return lines.join('\n')
}

async function runThread($: EngineInterface, sender: string, input: DiscussInput): Promise<string> {
  const questionId = input.questionId

  if (questionId === undefined) {
    throw new DiscussionError('thread needs questionId (e.g. d12).')
  }

  const result = await withHub($, hub => hub.thread(sender, questionId, input.since))
  const lines: string[] = []

  if (result.missing) {
    lines.push(`d${result.id}: question no longer retained.`)
  }

  if (result.question !== undefined) {
    lines.push(messageLine(result.question))
  }

  lines.push(...result.answers.map(messageLine))

  if (result.more > 0) {
    lines.push(`+${result.more} more: thread again with since.`)
  }

  return lines.join('\n')
}

async function runPending($: EngineInterface, sender: string): Promise<string> {
  const result = await withHub($, hub => hub.pending(sender))

  return JSON.stringify(result)
}

async function runAction($: EngineInterface, sender: string, input: DiscussInput): Promise<string> {
  if (input.action === 'ask') {
    return runAsk($, sender, input)
  }

  if (input.action === 'answer') {
    return runAnswer($, sender, input)
  }

  if (input.action === 'list') {
    return runList($, sender, input)
  }

  if (input.action === 'thread') {
    return runThread($, sender, input)
  }

  if (input.action === 'pending') {
    return runPending($, sender)
  }

  throw new DiscussionError('action is one of ask, answer, list, thread, pending.')
}

/** Moderator's open-question summary for /jar. */
export async function discussionSummary($: EngineInterface): Promise<string> {
  const hub = new DiscussionHub(await read($, hubAtom))
  const pending = hub.pending(MODERATOR)
  const lines = [`discussion: ${pending.messages} messages, ${pending.unread} unread for moderator`]

  for (const question of pending.unanswered?.questions ?? []) {
    let target = ''

    if (question.to !== undefined) {
      target = ` → ${question.to}`
    }

    lines.push(`  open d${question.id} · ${question.from}${target}`)
  }

  return lines.join('\n')
}

export async function discussSessionStart(
  $: EngineInterface,
  e: Args<'session.start'>,
  next: NextFn<'session.start'>,
): StepResult<'session.start'> {
  const answer = await next(e)
  await $.tool.register({ name: 'jar_discuss', description: DESCRIPTION, inputSchema: INPUT_SCHEMA, isDeferred: false })

  return answer
}

export async function discussAgentSpawn(
  $: EngineInterface,
  e: Args<'agent.spawn'>,
  next: NextFn<'agent.spawn'>,
): StepResult<'agent.spawn'> {
  const answer = await next(e)

  if (answer.deny === undefined && answer.agentId !== undefined) {
    const key = answer.agentId
    const name = e.name ?? e.description
    await withHub($, hub => hub.register(key, name))
  }

  return answer
}

export async function discussTurnStart(
  $: EngineInterface,
  e: Args<'turn.start'>,
  next: NextFn<'turn.start'>,
): StepResult<'turn.start'> {
  const key = keyOf(e.agentId)
  const hub = new DiscussionHub(await read($, hubAtom))

  if (hub.has(key)) {
    const notice = await withHub($, current => current.notice(key))

    if (notice !== undefined) {
      await pushNotice($, e.agentId, notice)
    }
  }

  return next(e)
}

export async function discussAgentReport(
  $: EngineInterface,
  e: Args<'agent.report'>,
  next: NextFn<'agent.report'>,
): StepResult<'agent.report'> {
  const answer = await next(e)
  await withHub($, hub => hub.retire(e.agentId))

  return answer
}

export function registerDiscuss(on: On): void {
  on('tool.run', { tool: DISCUSS_TOOL }, async ($, e) => {
    const sender = keyOf(e.agentId)

    try {
      await ensureRegistered($, sender)

      return { result: await runAction($, sender, parseInput(asRecord(e))) }
    } catch (error) {
      if (error instanceof DiscussionError) {
        return { deny: error.message }
      }

      throw error
    }
  })
}

async function pushNotice($: EngineInterface, agentId: string | undefined, notice: string): Promise<void> {
  const text = `[jar_discuss] unread mail:\n${notice}`
  const appended = await $.session.append({ agentId, message: { type: 'user', content: [{ type: 'text', text }] } })

  if (appended.deny !== undefined) {
    $.ui.log(`jar discuss: turn-start notice refused (${appended.deny})`)
  }
}
