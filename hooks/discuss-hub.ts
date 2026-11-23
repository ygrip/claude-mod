// jar_discuss mailbox, ported from pi-jar src/discussion-hub.ts onto plain data that $.state can keep.
// A hub is loaded from HubData, changed by one call, and its `data` written back.
import type { HubAgent, HubData, HubMessage } from '../types'

export const MODERATOR = 'moderator'
export const MAX_DISCUSSION_MESSAGES = 128
export const MAX_DISCUSSION_TEXT = 1600
export const MAX_DISCUSSION_BYTES = 128 * 1024
const ANSWER_RESERVE_MESSAGES = 16
const ANSWER_RESERVE_BYTES = 16 * 1024
const MAX_DISCUSSION_AGENTS = 64
export const MAX_LIST_CHARS = 4000
export const MAX_LISTED_TEXT = 400
export const MAX_NOTICE_CHARS = 2000
const MAX_PIGGYBACK_CHARS = 1000
const PENDING_LIMIT = 16
const BROADCAST = new Set(['all', '*', 'everyone', 'broadcast'])

/** A rejected operation; its message is terse, safe to show the model, and never echoes text. */
export class DiscussionError extends Error {}

export type MessageView = {
  id: number
  kind: 'question' | 'answer'
  from: string
  to?: string
  replyTo?: number
  text: string
}

export type PostResult = {
  id: number
  to?: string
  toKey?: string
  replyTo?: number
  askerKey?: string
  clipped: boolean
  delivered: MessageView[]
  unread: number
}

export type ListResult = { messages: MessageView[]; more: number; latest?: number; unread: number }

export type ThreadResult = { id: number; missing: boolean; question?: MessageView; answers: MessageView[]; more: number }

export type PendingResult = {
  unread: number
  waiting: number[]
  open: number[]
  messages: number
  bytes: number
  agents?: Array<{ label: string; unread: number }>
  unanswered?: { total: number; questions: Array<{ id: number; from: string; to?: string }> }
}

export function emptyHub(): HubData {
  return { lastId: 0, size: 0, agents: {}, messages: [] }
}

/** Accepts 12, "12", "d12" and "#d12". */
export function parseDiscussionId(value: unknown): number | undefined {
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && value >= 0) {
      return value
    }

    return undefined
  }

  if (typeof value !== 'string') {
    return undefined
  }

  const match = /^\s*#?d?(\d{1,15})\s*$/i.exec(value)

  if (match === null) {
    return undefined
  }

  return Number(match[1])
}

export function messageLine(view: MessageView): string {
  if (view.kind === 'answer') {
    return `[d${view.id}] A · ${view.from} → d${view.replyTo}: ${view.text}`
  }

  let target = ''

  if (view.to !== undefined) {
    target = ` → ${view.to}`
  }

  return `[d${view.id}] Q · ${view.from}${target}: ${view.text}`
}

function utf8(value: string | undefined): number {
  if (value === undefined) {
    return 0
  }

  return new TextEncoder().encode(value).length
}

function encodedSize(message: HubMessage): number {
  return (
    64 +
    utf8(message.text) +
    utf8(message.from) +
    utf8(message.fromName) +
    utf8(message.to) +
    utf8(message.toName) +
    utf8(message.asker)
  )
}

function cleanText(value: string, limit: number): string {
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, limit)
}

function answerers(message: HubMessage): string[] {
  return message.answerers ?? []
}

function isOpenQuestion(message: HubMessage): boolean {
  return message.kind === 'question' && answerers(message).length === 0
}

export class DiscussionHub {
  readonly data: HubData

  constructor(data: HubData) {
    this.data = JSON.parse(JSON.stringify(data)) as HubData

    if (this.data.agents[MODERATOR] === undefined) {
      this.data.agents[MODERATOR] = { key: MODERATOR, name: MODERATOR, cursor: this.data.lastId, seen: [] }
    }
  }

  has(key: string): boolean {
    return this.data.agents[key] !== undefined
  }

  /** Idempotent; a new agent starts at the newest id, so it never ingests earlier chatter. */
  register(key: string, name: string): void {
    const label = cleanText(name, 48) || key
    const agent = this.data.agents[key]

    if (agent !== undefined) {
      agent.name = label

      return
    }

    if (Object.keys(this.data.agents).length > MAX_DISCUSSION_AGENTS) {
      throw new DiscussionError('Discussion agent limit reached.')
    }

    this.data.agents[key] = { key, name: label, cursor: this.data.lastId, seen: [] }
  }

  retire(key: string): void {
    if (key === MODERATOR) {
      return
    }

    delete this.data.agents[key]
  }

  ask(from: string, text: string, to?: string): PostResult {
    const sender = this.agent(from)
    const body = this.body(text)
    const target = this.target(sender, to)
    const message: HubMessage = {
      id: this.data.lastId + 1,
      kind: 'question',
      from: sender.key,
      fromName: sender.name,
      text: body.text,
      bytes: 0,
      answerers: [],
    }

    if (target !== undefined) {
      message.to = target.key
      message.toName = target.name
    }

    this.append(message)
    const result: PostResult = { id: message.id, clipped: body.clipped, ...this.deliver(sender) }

    if (target !== undefined) {
      result.to = this.label(target.key, target.name)
      result.toKey = target.key
    }

    return result
  }

  answer(from: string, questionId: number, text: string): PostResult {
    const sender = this.agent(from)
    const body = this.body(text)
    const question = this.find(questionId)

    if (question?.kind === 'answer') {
      throw new DiscussionError(`d${questionId} is an answer; answer its question d${question.replyTo}.`)
    }

    if (question === undefined) {
      throw new DiscussionError(`Unknown discussion question d${questionId}.`)
    }

    const message: HubMessage = {
      id: this.data.lastId + 1,
      kind: 'answer',
      from: sender.key,
      fromName: sender.name,
      text: body.text,
      bytes: 0,
      replyTo: question.id,
      asker: question.from,
    }

    this.append(message, question.id)
    const stored = this.find(question.id)

    if (stored !== undefined && !answerers(stored).includes(sender.key)) {
      stored.answerers = [...answerers(stored), sender.key]
    }

    return {
      id: message.id,
      replyTo: question.id,
      askerKey: question.from,
      clipped: body.clipped,
      ...this.deliver(sender),
    }
  }

  list(key: string, since?: number, budget = MAX_LIST_CHARS): ListResult {
    const agent = this.agent(key)
    const items = this.data.messages.filter(message => {
      if (!this.relevant(agent, message)) {
        return false
      }

      if (since === undefined) {
        return !this.read(agent, message)
      }

      return message.id > since
    })
    const { views, shown } = this.select(items, MAX_LISTED_TEXT, budget)
    this.markRead(agent, shown)
    const result: ListResult = { messages: views, more: items.length - views.length, unread: this.unreadOf(agent).length }
    const latest = this.data.messages.at(-1)

    if (latest !== undefined) {
      result.latest = latest.id
    }

    return result
  }

  thread(key: string, questionId: number, since?: number): ThreadResult {
    const agent = this.agent(key)
    const named = this.find(questionId)
    let root = questionId

    if (named?.kind === 'answer' && named.replyTo !== undefined) {
      root = named.replyTo
    }

    const question = this.find(root)
    const answers = this.data.messages.filter(message => message.replyTo === root)

    if (question === undefined && answers.length === 0) {
      throw new DiscussionError(`Unknown discussion question d${questionId}.`)
    }

    const all: HubMessage[] = []

    if (question !== undefined) {
      all.push(question)
    }

    all.push(...answers)
    const items = all.filter(message => since === undefined || message.id > since)
    const { views, shown } = this.select(items, MAX_DISCUSSION_TEXT)
    this.markRead(agent, shown.filter(message => this.relevant(agent, message)))
    const hasHead = question !== undefined && shown[0] === question
    const result: ThreadResult = { id: root, missing: question === undefined, answers: views, more: items.length - views.length }

    if (hasHead) {
      result.question = views[0]
      result.answers = views.slice(1)
    }

    return result
  }

  pending(key: string): PendingResult {
    const agent = this.agent(key)
    const open = this.data.messages.filter(isOpenQuestion)
    const result: PendingResult = {
      unread: this.unreadOf(agent).length,
      waiting: open.filter(message => this.relevant(agent, message)).map(message => message.id),
      open: open.filter(message => message.from === agent.key).map(message => message.id),
      messages: this.data.messages.length,
      bytes: this.data.size,
    }

    if (agent.key !== MODERATOR) {
      return result
    }

    result.agents = Object.values(this.data.agents)
      .filter(other => other.key !== MODERATOR)
      .map(other => ({ label: this.label(other.key, other.name), unread: this.unreadOf(other).length }))
      .filter(entry => entry.unread > 0)
      .slice(0, PENDING_LIMIT)
    result.unanswered = {
      total: open.length,
      questions: open.slice(0, PENDING_LIMIT).map(message => this.questionSummary(message)),
    }

    return result
  }

  /** Marks messages pushed straight to an agent as read for it, so they are not delivered twice. */
  acknowledge(key: string, ids: readonly number[]): void {
    if (!this.has(key)) {
      return
    }

    const messages = this.data.messages.filter(message => ids.includes(message.id))
    this.markRead(this.agent(key), messages)
  }

  /** A message as `key` is shown it, for a direct push. */
  viewFor(id: number): MessageView | undefined {
    const message = this.find(id)

    if (message === undefined) {
      return undefined
    }

    return this.view(message, MAX_DISCUSSION_TEXT)
  }

  /** Live agents a broadcast from `from` reaches. */
  recipients(from: string): string[] {
    return Object.keys(this.data.agents).filter(key => key !== from)
  }

  /** Unread mail for a turn-start or report notice, marked read; undefined when there is none. */
  notice(key: string): string | undefined {
    if (!this.has(key)) {
      return undefined
    }

    const listed = this.list(key, undefined, MAX_NOTICE_CHARS)

    if (listed.messages.length === 0) {
      return undefined
    }

    const lines = listed.messages.map(messageLine)

    if (listed.more > 0) {
      lines.push(`+${listed.more} more: jar_discuss list`)
    }

    return lines.join('\n')
  }

  private questionSummary(message: HubMessage): { id: number; from: string; to?: string } {
    const summary: { id: number; from: string; to?: string } = {
      id: message.id,
      from: this.label(message.from, message.fromName),
    }

    if (message.to !== undefined) {
      summary.to = this.label(message.to, message.toName ?? message.to)
    }

    return summary
  }

  private find(id: number): HubMessage | undefined {
    return this.data.messages.find(message => message.id === id)
  }

  private agent(key: string): HubAgent {
    const agent = this.data.agents[key]

    if (agent === undefined) {
      throw new DiscussionError('Unknown discussion agent.')
    }

    return agent
  }

  private body(text: string): { text: string; clipped: boolean } {
    const full = cleanText(text, MAX_DISCUSSION_TEXT + 1)

    if (full === '') {
      throw new DiscussionError('Discussion text is required.')
    }

    return { text: full.slice(0, MAX_DISCUSSION_TEXT).trimEnd(), clipped: full.length > MAX_DISCUSSION_TEXT }
  }

  /** A key, `moderator`, or a unique case-insensitive name; empty or `all` broadcasts. */
  private target(sender: HubAgent, ref: string | undefined): HubAgent | undefined {
    const value = cleanText(ref ?? '', 64)
    const lower = value.toLowerCase()

    if (value === '' || BROADCAST.has(lower)) {
      return undefined
    }

    let target = this.data.agents[value] ?? this.data.agents[lower]

    if (target === undefined) {
      const matches = Object.values(this.data.agents).filter(agent => agent.name.toLowerCase() === lower)

      if (matches.length > 1) {
        const keys = matches.slice(0, 8).map(agent => agent.key).join(', ')
        throw new DiscussionError(`Ambiguous discussion target; use one of: ${keys}.`)
      }

      target = matches[0]
    }

    if (target === undefined) {
      throw new DiscussionError(`Unknown discussion target. Known: ${this.known(sender)}; omit to broadcast.`)
    }

    if (target.key === sender.key) {
      throw new DiscussionError('A question cannot target its sender.')
    }

    return target
  }

  private known(sender: HubAgent): string {
    const others = Object.values(this.data.agents).filter(agent => agent.key !== sender.key)
    const shown = others.slice(0, 8).map(agent => {
      if (agent.key === MODERATOR) {
        return MODERATOR
      }

      return `${agent.key} (${agent.name})`
    })
    let extra = ''

    if (others.length > shown.length) {
      extra = `, +${others.length - shown.length} more`
    }

    return (shown.join(', ') || 'none') + extra
  }

  /** A live agent's name, with its key when the name alone could not address it. */
  private label(key: string, name: string): string {
    const agent = this.data.agents[key]

    if (agent === undefined) {
      return name
    }

    if (key === MODERATOR) {
      return agent.name
    }

    const lower = agent.name.toLowerCase()
    const sameName = Object.values(this.data.agents).filter(other => other.name.toLowerCase() === lower).length
    const isAmbiguous = sameName > 1 || lower === MODERATOR || BROADCAST.has(lower)

    if (isAmbiguous) {
      return `${agent.name} (${key})`
    }

    return agent.name
  }

  private relevant(agent: HubAgent, message: HubMessage): boolean {
    if (message.from === agent.key) {
      return false
    }

    if (message.kind === 'answer') {
      return message.asker === agent.key
    }

    const isAddressed = message.to === undefined || message.to === agent.key

    return isAddressed && !answerers(message).includes(agent.key)
  }

  private read(agent: HubAgent, message: HubMessage): boolean {
    return message.id <= agent.cursor || agent.seen.includes(message.id)
  }

  private unreadOf(agent: HubAgent): HubMessage[] {
    return this.data.messages.filter(message => !this.read(agent, message) && this.relevant(agent, message))
  }

  private acknowledged(message: HubMessage): boolean {
    return Object.values(this.data.agents).every(agent => !this.relevant(agent, message) || this.read(agent, message))
  }

  private markRead(agent: HubAgent, messages: readonly HubMessage[]): void {
    if (messages.length === 0) {
      return
    }

    for (const message of messages) {
      if (message.id > agent.cursor && !agent.seen.includes(message.id)) {
        agent.seen.push(message.id)
      }
    }

    this.settle(agent)
  }

  /** Move the cursor up to the first unread relevant message (or the newest id), shrinking `seen`. */
  private settle(agent: HubAgent): void {
    const blocked = this.data.messages.find(
      message => message.id > agent.cursor && !agent.seen.includes(message.id) && this.relevant(agent, message),
    )
    let cursor = this.data.lastId

    if (blocked !== undefined) {
      cursor = blocked.id - 1
    }

    agent.cursor = Math.max(agent.cursor, cursor)
    agent.seen = agent.seen.filter(id => id > agent.cursor)
  }

  /** Unread mail rides on an ask/answer reply only when all of it fits; otherwise only its count does. */
  private deliver(agent: HubAgent): { delivered: MessageView[]; unread: number } {
    const unread = this.unreadOf(agent)
    const views = unread.map(message => this.view(message, MAX_LISTED_TEXT))
    const size = views.reduce((total, view) => total + messageLine(view).length + 1, 0)

    if (views.length === 0 || size > MAX_PIGGYBACK_CHARS) {
      this.settle(agent)

      return { delivered: [], unread: unread.length }
    }

    this.markRead(agent, unread)

    return { delivered: views, unread: 0 }
  }

  private view(message: HubMessage, limit: number): MessageView {
    let text = message.text

    if (text.length > limit) {
      text = text.slice(0, limit) + '…'
    }

    const from = this.label(message.from, message.fromName)

    if (message.kind === 'answer') {
      return { id: message.id, kind: 'answer', from, replyTo: message.replyTo, text }
    }

    const view: MessageView = { id: message.id, kind: 'question', from, text }

    if (message.to !== undefined) {
      view.to = this.label(message.to, message.toName ?? message.to)
    }

    return view
  }

  /** Oldest first into the budget; at least one message, so paging always progresses. */
  private select(
    items: readonly HubMessage[],
    limit: number,
    budget = MAX_LIST_CHARS,
  ): { views: MessageView[]; shown: HubMessage[] } {
    const views: MessageView[] = []
    let used = 0

    for (const message of items) {
      const view = this.view(message, limit)
      const size = messageLine(view).length + 1

      if (views.length > 0 && used + size > budget) {
        break
      }

      views.push(view)
      used += size
    }

    return { views, shown: items.slice(0, views.length) }
  }

  private append(message: HubMessage, replyTarget?: number): void {
    message.bytes = encodedSize(message)
    const isQuestion = message.kind === 'question'
    let maxMessages = MAX_DISCUSSION_MESSAGES
    let maxBytes = MAX_DISCUSSION_BYTES

    if (isQuestion) {
      maxMessages -= ANSWER_RESERVE_MESSAGES
      maxBytes -= ANSWER_RESERVE_BYTES
    }

    const evicted = this.eviction(message.bytes, maxMessages, maxBytes, replyTarget)

    if (evicted === undefined) {
      const size = (this.data.size / 1024).toFixed(1)
      let action = 'answering'

      if (isQuestion) {
        action = 'asking'
      }

      throw new DiscussionError(
        `Discussion is full: ${this.data.messages.length} retained messages (${size} KiB) are unread or awaiting answers. ` +
          `Answer or list pending messages (jar_discuss pending) before ${action} more.`,
      )
    }

    if (evicted.length > 0) {
      this.remove(new Set(evicted.map(item => item.id)))
    }

    this.data.lastId = message.id
    this.data.messages.push(message)
    this.data.size += message.bytes
  }

  /**
   * What to evict so one more message fits, by priority: answered groups everyone relevant has read,
   * then read broadcasts, then any other read message, oldest first. Unread mail, a question awaiting
   * a live target and the question being answered are never evicted; undefined means only they remain.
   */
  private eviction(bytes: number, maxMessages: number, maxBytes: number, replyTarget?: number): HubMessage[] | undefined {
    let count = this.data.messages.length + 1
    let size = this.data.size + bytes
    const fits = () => count <= maxMessages && size <= maxBytes
    const chosen: HubMessage[] = []

    if (fits()) {
      return chosen
    }

    const taken = new Set<number>()
    const take = (items: readonly HubMessage[]) => {
      for (const item of items) {
        taken.add(item.id)
        chosen.push(item)
        count -= 1
        size -= item.bytes
      }
    }
    const groups = new Map<number, HubMessage[]>()

    for (const message of this.data.messages) {
      const root = message.replyTo ?? message.id
      const group = groups.get(root) ?? []
      group.push(message)
      groups.set(root, group)
    }

    const disposable = (message: HubMessage) => message.id !== replyTarget && this.acknowledged(message)

    for (const [root, group] of groups) {
      if (fits()) {
        return chosen
      }

      const question = this.find(root)
      const isAnswered = question === undefined || answerers(question).length > 0

      if (isAnswered && group.every(disposable)) {
        take(group)
      }
    }

    for (const [root, group] of groups) {
      if (fits()) {
        return chosen
      }

      const question = this.find(root)
      const isOpenBroadcast = question !== undefined && question.to === undefined && isOpenQuestion(question)

      if (isOpenBroadcast && !taken.has(root) && group.every(disposable)) {
        take(group)
      }
    }

    for (const message of this.data.messages) {
      if (fits()) {
        return chosen
      }

      const isAwaiting = isOpenQuestion(message) && message.to !== undefined && this.has(message.to)

      if (!taken.has(message.id) && !isAwaiting && disposable(message)) {
        take([message])
      }
    }

    if (fits()) {
      return chosen
    }

    return undefined
  }

  private remove(ids: ReadonlySet<number>): void {
    for (const message of this.data.messages) {
      if (ids.has(message.id)) {
        this.data.size -= message.bytes
      }
    }

    this.data.messages = this.data.messages.filter(message => !ids.has(message.id))

    for (const agent of Object.values(this.data.agents)) {
      agent.seen = agent.seen.filter(id => !ids.has(id))
    }
  }
}
