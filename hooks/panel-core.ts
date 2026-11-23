// Pure parts of the jar panel: formatting, agent rows, cost split, role rows and spec editing.
// Nothing here touches `$`, so tests/panel-core.test.ts covers it directly.
import type { AgentInfo, TurnUsage } from 'claude-code'

import { isEffort, isResolved, resolveRole, type Effort } from './roles'

export type PanelTab = 'agents' | 'cost' | 'roles'

export const TABS: readonly PanelTab[] = ['agents', 'cost', 'roles']

const SPARK_BARS = '▁▂▃▄▅▆▇█'
const THOUSAND = 1_000
const MILLION = 1_000_000
const SECOND_MS = 1_000
const MINUTE_S = 60
const HOUR_S = 3_600
const TOP_AGENTS = 8

export function money(usd: number): string {
  if (usd > 0 && usd < 0.01) {
    return '<$0.01'
  }

  return `$${usd.toFixed(2)}`
}

export function tokens(count: number): string {
  if (count < THOUSAND) {
    return String(Math.round(count))
  }

  if (count < MILLION) {
    return `${(count / THOUSAND).toFixed(1)}k`
  }

  return `${(count / MILLION).toFixed(2)}M`
}

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / SECOND_MS))

  if (seconds < MINUTE_S) {
    return `${seconds}s`
  }

  const minutes = Math.floor(seconds / MINUTE_S)

  if (seconds < HOUR_S) {
    return `${minutes}m ${String(seconds % MINUTE_S).padStart(2, '0')}s`
  }

  const hours = Math.floor(seconds / HOUR_S)

  return `${hours}h ${String(minutes % MINUTE_S).padStart(2, '0')}m`
}

/** `▁▂▅█` for a series of samples, scaled to its own maximum; '' for fewer than two. */
export function sparkline(samples: readonly number[], width: number): string {
  const recent = samples.slice(-width)

  if (recent.length < 2) {
    return ''
  }

  const peak = Math.max(...recent)

  if (peak <= 0) {
    return SPARK_BARS.charAt(0).repeat(recent.length)
  }

  return recent
    .map(sample => SPARK_BARS.charAt(Math.min(SPARK_BARS.length - 1, Math.floor((sample / peak) * SPARK_BARS.length))))
    .join('')
}

export type TokenTotals = { input: number; output: number; cacheRead: number; cacheWrite: number }

const NO_TOKENS: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

export function addUsage(totals: TokenTotals, usage: TurnUsage): TokenTotals {
  return {
    input: totals.input + usage.input_tokens,
    output: totals.output + usage.output_tokens,
    cacheRead: totals.cacheRead + usage.cache_read_input_tokens,
    cacheWrite: totals.cacheWrite + usage.cache_creation_input_tokens,
  }
}

export function totalTokens(totals: TokenTotals): number {
  return totals.input + totals.output + totals.cacheRead + totals.cacheWrite
}

export function agentTotals(agent: AgentInfo): TokenTotals {
  return (agent.usage ?? []).reduce(addUsage, NO_TOKENS)
}

export type AgentRow = {
  id: string
  title: string
  type: string
  status: string
  isLive: boolean
  model: string
  effort: string
  elapsed: string
  tokenCount: number
  contextPercent?: number
  usd?: number
  startTime: number
}

const LIVE_STATUSES = new Set(['pending', 'running', 'waiting'])

function titleOf(agent: AgentInfo): string {
  if (agent.name !== undefined && agent.name !== '') {
    return agent.name
  }

  if (agent.description !== '') {
    return agent.description
  }

  return agent.id
}

function contextPercentOf(agent: AgentInfo): number | undefined {
  if (agent.contextWindowSize === undefined || agent.contextWindowSize <= 0) {
    return undefined
  }

  return Math.min(100, (agent.tokenCount / agent.contextWindowSize) * 100)
}

function elapsedOf(agent: AgentInfo, isLive: boolean, now: number): string {
  if (!isLive) {
    return agent.status
  }

  return duration(now - agent.startTime)
}

export function agentRow(agent: AgentInfo, now: number): AgentRow {
  const isLive = LIVE_STATUSES.has(agent.status)

  return {
    id: agent.id,
    title: titleOf(agent),
    type: agent.type,
    status: agent.status,
    isLive,
    model: agent.model ?? 'inherit',
    effort: String(agent.effort ?? ''),
    elapsed: elapsedOf(agent, isLive, now),
    tokenCount: agent.tokenCount,
    contextPercent: contextPercentOf(agent),
    usd: agent.cost?.usd,
    startTime: agent.startTime,
  }
}

/** Live agents first, then the newest. */
export function agentRows(agents: readonly AgentInfo[], now: number): AgentRow[] {
  return agents
    .map(agent => agentRow(agent, now))
    .sort((left, right) => {
      if (left.isLive !== right.isLive) {
        return Number(right.isLive) - Number(left.isLive)
      }

      return right.startTime - left.startTime
    })
}

export type ModelTokens = { model: string; totals: TokenTotals }

export type CostSplit = {
  totalUsd: number
  hasUnknownPrice: boolean
  subagentsUsd: number
  mainUsd: number
  topAgents: AgentRow[]
  byModel: ModelTokens[]
}

function byModelOf(agents: readonly AgentInfo[]): ModelTokens[] {
  const sums = new Map<string, TokenTotals>()

  for (const agent of agents) {
    for (const usage of agent.usage ?? []) {
      sums.set(usage.model, addUsage(sums.get(usage.model) ?? NO_TOKENS, usage))
    }
  }

  return [...sums.entries()]
    .map(([model, totals]) => ({ model, totals }))
    .sort((left, right) => totalTokens(right.totals) - totalTokens(left.totals))
}

/**
 * The session total comes from the engine; subagents add up their own ledgers, so the main
 * thread (with advisor and classifier calls) is what is left over.
 */
export function costSplit(
  totalUsd: number,
  hasUnknownPrice: boolean,
  agents: readonly AgentInfo[],
  now: number,
): CostSplit {
  const subagentsUsd = agents.reduce((sum, agent) => sum + (agent.cost?.usd ?? 0), 0)
  const topAgents = agentRows(agents, now)
    .filter(row => (row.usd ?? 0) > 0)
    .sort((left, right) => (right.usd ?? 0) - (left.usd ?? 0))
    .slice(0, TOP_AGENTS)

  return {
    totalUsd,
    hasUnknownPrice,
    subagentsUsd,
    mainUsd: Math.max(0, totalUsd - subagentsUsd),
    topAgents,
    byModel: byModelOf(agents),
  }
}

const WINDOW_LABELS: Record<string, string> = { five_hour: '5-hour', seven_day: 'weekly', spend_limit: 'spend' }

export function windowLabel(kind: string): string {
  return WINDOW_LABELS[kind] ?? kind
}

/** `resets in 2h 05m`, or '' when the stamp is missing or already past. */
export function resetsIn(resetsAt: string | undefined, now: number): string {
  if (resetsAt === undefined) {
    return ''
  }

  const at = Date.parse(resetsAt)

  if (Number.isNaN(at) || at <= now) {
    return ''
  }

  return `resets in ${duration(at - now)}`
}

export type RoleSource = 'default' | 'global' | 'project'

export type RoleRow = {
  role: string
  spec: string
  source: RoleSource
  resolved: string
  isBroken: boolean
}

function sourceOf(role: string, global: Readonly<Record<string, string>>, project: Readonly<Record<string, string>>): RoleSource {
  if (project[role] !== undefined) {
    return 'project'
  }

  if (global[role] !== undefined) {
    return 'global'
  }

  return 'default'
}

function resolvedText(merged: Readonly<Record<string, string>>, role: string): { text: string; isBroken: boolean } {
  const resolution = resolveRole(merged, role)

  if (!isResolved(resolution)) {
    return { text: resolution.error, isBroken: true }
  }

  const model = resolution.model ?? 'inherit'

  if (resolution.effort === undefined) {
    return { text: model, isBroken: false }
  }

  return { text: `${model} · ${resolution.effort}`, isBroken: false }
}

/** The routed roles first, then the rest by name. */
export function roleRows(
  merged: Readonly<Record<string, string>>,
  global: Readonly<Record<string, string>>,
  project: Readonly<Record<string, string>>,
  routed: readonly string[],
): RoleRow[] {
  const names = Object.keys(merged)
  const rest = names.filter(name => !routed.includes(name)).sort()
  const first = routed.filter(name => names.includes(name))

  return [...first, ...rest].map(role => {
    const resolved = resolvedText(merged, role)

    return {
      role,
      spec: merged[role] ?? '*',
      source: sourceOf(role, global, project),
      resolved: resolved.text,
      isBroken: resolved.isBroken,
    }
  })
}

export type SpecDraft = { head: string; effort: Effort | '' }

/** `opus:high` → `{ head: 'opus', effort: 'high' }`; `*` stays `*`. */
export function draftOf(spec: string): SpecDraft {
  const colon = spec.lastIndexOf(':')

  if (colon <= 0) {
    return { head: spec, effort: '' }
  }

  const suffix = spec.slice(colon + 1)

  if (!isEffort(suffix)) {
    return { head: spec, effort: '' }
  }

  return { head: spec.slice(0, colon), effort: suffix }
}

export function specOf(draft: SpecDraft): string {
  if (draft.effort === '' || draft.head === '*') {
    return draft.head
  }

  return `${draft.head}:${draft.effort}`
}

const BASE_CHOICES: readonly string[] = ['*', 'haiku', 'sonnet', 'opus']

/** What the model Select offers: inherit, the aliases, `@other-role` for the rest, and the current value. */
export function modelChoices(role: string, roleNames: readonly string[], current: string): string[] {
  const aliases = roleNames.filter(name => name !== role).map(name => `@${name}`)
  const choices = [...BASE_CHOICES, ...aliases]

  if (choices.includes(current)) {
    return choices
  }

  return [current, ...choices]
}
