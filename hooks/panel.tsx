// The jar panel: a focusable pane with three tabs. Agents (live list and a detail view per subagent),
// Cost (session total, subagent split, plan limits) and Roles (view and edit model roles).
import { atom, read, update } from 'claude-code'
import type { AgentInfo, Args, ElementTable, EngineInterface, On } from 'claude-code'

import type { PanelState, PanelTab } from '../types'
import type { NextFn, StepResult } from './chain'
import {
  agentRows,
  agentTotals,
  costSplit,
  draftOf,
  type AgentRow,
  modelChoices,
  money,
  resetsIn,
  roleRows,
  type RoleRow,
  sparkline,
  specOf,
  TABS,
  tokens,
  totalTokens,
  windowLabel,
} from './panel-core'
import { readRoleFile, type RoleScope, writeRoleFile } from './role-files'
import { DEFAULT_ROLES, isEffort, mergeRoles, normalizeSpec, ROUTED_ROLES } from './roles'
import { INITIAL_PANEL } from './state'

const panelAtom = atom({ plugin: 'jar', key: 'panel' } as const, INITIAL_PANEL, { shape: 'panel-1' })

const PANE = 'jar'
const REFRESH_MS = 3_000
const SPARK_WIDTH = 24
const NO_EFFORT = 'none'

const TAB_LABELS: Record<PanelTab, string> = { agents: 'Agents', cost: 'Cost', roles: 'Roles' }
const EFFORT_OPTIONS = [NO_EFFORT, 'low', 'medium', 'high', 'xhigh', 'max']
const SCOPE_OPTIONS = ['global', 'project']

type PaneEvent = Parameters<EngineInterface['ui']['resolve']>[0]
type Ui = ElementTable

type RoleView = {
  merged: Record<string, string>
  global: Record<string, string>
  project: Record<string, string>
}

export async function panelSessionStart(
  $: EngineInterface,
  e: Args<'session.start'>,
  next: NextFn<'session.start'>,
): StepResult<'session.start'> {
  $.clock.every(REFRESH_MS, () => {
    $.ui.invalidate('ui.render')
  })

  return next(e)
}

export function registerPanel(on: On): void {
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawPanel($, e))
}

/** Opens (or refocuses) the pane, on `tab` when one is given. */
export async function openPanel($: EngineInterface, tab?: PanelTab): Promise<string> {
  if (tab !== undefined) {
    await update($, panelAtom, state => ({ ...state, tab, agentId: undefined, editRole: undefined }))
  }

  const opened = await $.ui.open({ id: PANE, title: 'jar', focus: true, closeOnEscape: true })

  if (opened.isPlaced) {
    return 'jar panel opened. 1 Agents · 2 Cost · 3 Roles · Esc closes.'
  }

  return 'jar panel is open but not drawn here: widen the terminal or use fullscreen.'
}

export function tabFromWord(word: string): PanelTab | undefined {
  return TABS.find(tab => tab === word)
}

async function drawPanel($: EngineInterface, e: PaneEvent) {
  const ui = $.ui.resolve(e)
  const { Box, Text } = ui
  const state = await read($, panelAtom)
  const agents = await $.agent.list()
  const now = await $.clock.now()
  const usage = await $.session.usage()
  const split = costSplit(usage.cost?.usd ?? 0, usage.cost?.hasUnknownPrice === true, agents, now)
  const liveCount = agentRows(agents, now).filter(row => row.isLive).length

  return (
    <Box flexDirection="column" paddingX={1}>
      {drawTabs($, ui, state.tab, liveCount, split.totalUsd)}
      <Box flexDirection="column" marginTop={1}>
        {state.tab === 'agents' && drawAgents($, ui, state, agents, now)}
        {state.tab === 'cost' && drawCost(ui, split, usage, now)}
        {state.tab === 'roles' && (await drawRoles($, ui, state))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Esc closes · Tab and arrows move · Enter picks · 1 2 3 switch tabs</Text>
      </Box>
    </Box>
  )
}

function drawTabs($: EngineInterface, ui: Ui, current: PanelTab, liveCount: number, totalUsd: number) {
  const { Box, Button, Text } = ui
  const notes: Record<PanelTab, string> = {
    agents: `${liveCount} live`,
    cost: money(totalUsd),
    roles: '',
  }

  return (
    <Box flexDirection="row" gap={1}>
      <Text bold>jar</Text>
      {TABS.map((tab, index) => {
        let variant: 'primary' | 'secondary' = 'secondary'

        if (tab === current) {
          variant = 'primary'
        }

        return (
          <Button
            key={`tab-${tab}`}
            hotkey={String(index + 1)}
            variant={variant}
            onPress={() => selectTab($, tab)}
          >
            {`${TAB_LABELS[tab]} ${notes[tab]}`.trim()}
          </Button>
        )
      })}
    </Box>
  )
}

async function selectTab($: EngineInterface, tab: PanelTab): Promise<void> {
  await update($, panelAtom, state => ({ ...state, tab, agentId: undefined, editRole: undefined, notice: undefined }))
}

// ---- Agents ----

function drawAgents($: EngineInterface, ui: Ui, state: PanelState, agents: readonly AgentInfo[], now: number) {
  const { Box, Text } = ui
  const rows = agentRows(agents, now)
  const chosen = agents.find(agent => agent.id === state.agentId)

  if (chosen !== undefined) {
    return drawAgentDetail($, ui, chosen, now)
  }

  if (rows.length === 0) {
    return <Text dimColor>No subagents yet. They appear here as the model spawns them.</Text>
  }

  return (
    <Box flexDirection="column">
      {rows.map(row => drawAgentRow($, ui, row))}
    </Box>
  )
}

function statusGlyph(status: string): string {
  if (status === 'running') {
    return '●'
  }

  if (status === 'waiting' || status === 'pending') {
    return '◌'
  }

  if (status === 'failed' || status === 'killed') {
    return '✖'
  }

  return '○'
}

function drawAgentRow($: EngineInterface, ui: Ui, row: AgentRow) {
  const { Button, Text } = ui
  const cost = rowCost(row)

  return (
    <Button key={`agent-${row.id}`} plain onPress={() => openAgent($, row.id)}>
      {`${statusGlyph(row.status)} ${row.title}`}
      <Text dimColor>{`  ${row.type} · ${row.model} · ${row.elapsed} · ${tokens(row.tokenCount)} tok${cost}`}</Text>
    </Button>
  )
}

function rowCost(row: AgentRow): string {
  if (row.usd === undefined) {
    return ''
  }

  return ` · ${money(row.usd)}`
}

async function openAgent($: EngineInterface, id: string): Promise<void> {
  await update($, panelAtom, state => ({ ...state, agentId: id }))
}

async function closeAgent($: EngineInterface): Promise<void> {
  await update($, panelAtom, state => ({ ...state, agentId: undefined }))
}

function detailLine(ui: Ui, label: string, value: string) {
  const { Box, Text } = ui

  return (
    <Box flexDirection="row" gap={1}>
      <Text dimColor>{label.padEnd(9)}</Text>
      <Text>{value}</Text>
    </Box>
  )
}

function drawAgentDetail($: EngineInterface, ui: Ui, agent: AgentInfo, now: number) {
  const { Box, Button, Progress, Text } = ui
  const row = agentRows([agent], now)[0]
  const totals = agentTotals(agent)
  const trend = sparkline(agent.tokenSamples, SPARK_WIDTH)
  let effort = ''

  if (agent.effort !== undefined) {
    effort = ` · effort ${String(agent.effort)}`
  }

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={2}>
        <Button key="agents-back" hotkey="b" onPress={() => closeAgent($)}>
          Back
        </Button>
        <Text bold>{`${statusGlyph(agent.status)} ${row?.title ?? agent.id}`}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {detailLine(ui, 'type', agent.type)}
        {detailLine(ui, 'status', `${agent.status} · ${row?.elapsed ?? ''}`)}
        {detailLine(ui, 'model', `${agent.model ?? 'inherit'}${effort}`)}
        {detailLine(ui, 'cwd', agent.cwd)}
        {detailLine(ui, 'task', agent.description)}
        {agent.parentId !== undefined && detailLine(ui, 'parent', agent.parentId)}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {row?.contextPercent !== undefined && (
          <Progress
            label="context"
            value={row.contextPercent / 100}
            valueText={`${tokens(agent.tokenCount)} of ${tokens(agent.contextWindowSize ?? 0)}`}
          />
        )}
        {trend !== '' && <Text>{`context growth ${trend}`}</Text>}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Tokens</Text>
        <Text>{`input ${tokens(totals.input)} · output ${tokens(totals.output)} · cache read ${tokens(totals.cacheRead)} · cache write ${tokens(totals.cacheWrite)}`}</Text>
        <Text dimColor>{`${tokens(totalTokens(totals))} total${agentCostText(agent)}`}</Text>
      </Box>
      {drawLastRequest(ui, agent)}
    </Box>
  )
}

function agentCostText(agent: AgentInfo): string {
  if (agent.cost === undefined) {
    return ' · cost not tracked for this agent'
  }

  return ` · ${money(agent.cost.usd)}`
}

function drawLastRequest(ui: Ui, agent: AgentInfo) {
  const { Box, Text } = ui

  if (agent.lastRequest === undefined) {
    return <Box />
  }

  const request = agent.lastRequest
  const cache = request.cacheTtl ?? 'default'

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Last request</Text>
      <Text dimColor>{`${request.model} · effort ${String(request.effort ?? 'default')} · cache ${cache}`}</Text>
    </Box>
  )
}

// ---- Cost ----

type Usage = Awaited<ReturnType<EngineInterface['session']['usage']>>
type Split = ReturnType<typeof costSplit>

function drawCost(ui: Ui, split: Split, usage: Usage, now: number) {
  const { Box, Progress, Text } = ui
  let unknownNote = ''

  if (split.hasUnknownPrice) {
    unknownNote = ' (some models have no known price)'
  }

  return (
    <Box flexDirection="column">
      <Text bold>{`Session ${money(split.totalUsd)}${unknownNote}`}</Text>
      <Text>{`main thread ${money(split.mainUsd)} (incl. advisor and classifier calls) · subagents ${money(split.subagentsUsd)}`}</Text>
      <Box flexDirection="column" marginTop={1}>
        {usage.context.percent !== undefined && (
          <Progress
            label="context"
            value={usage.context.percent / 100}
            valueText={`${Math.round(usage.context.percent)}% of ${tokens(usage.context.window)}`}
          />
        )}
        {usage.rateLimits.map(limit => (
          <Progress
            label={windowLabel(limit.kind)}
            value={Math.min(1, limit.percentUsed / 100)}
            valueText={`${Math.round(limit.percentUsed)}% ${resetsIn(limit.resetsAt, now)}`.trim()}
          />
        ))}
      </Box>
      {drawTopAgents(ui, split)}
      {drawByModel(ui, split)}
    </Box>
  )
}

function drawTopAgents(ui: Ui, split: Split) {
  const { Box, Text } = ui

  if (split.topAgents.length === 0) {
    return <Box />
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Costliest subagents</Text>
      {split.topAgents.map(row => (
        <Text>{`${money(row.usd ?? 0).padStart(7)}  ${row.title} · ${row.type} · ${row.model}`}</Text>
      ))}
    </Box>
  )
}

function drawByModel(ui: Ui, split: Split) {
  const { Box, Text } = ui

  if (split.byModel.length === 0) {
    return <Box />
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Subagent tokens by model</Text>
      {split.byModel.map(entry => (
        <Text>{`${entry.model}  in ${tokens(entry.totals.input)} · out ${tokens(entry.totals.output)} · cache ${tokens(entry.totals.cacheRead + entry.totals.cacheWrite)}`}</Text>
      ))}
    </Box>
  )
}

// ---- Roles ----

async function loadRoleView($: EngineInterface): Promise<RoleView> {
  const global = (await readRoleFile($, 'global')).roles
  const project = (await readRoleFile($, 'project')).roles

  return { merged: mergeRoles(global, project), global, project }
}

async function drawRoles($: EngineInterface, ui: Ui, state: PanelState) {
  const { Box, Text } = ui
  const view = await loadRoleView($)
  const rows = roleRows(view.merged, view.global, view.project, ROUTED_ROLES)
  const editing = rows.find(row => row.role === state.editRole)

  if (editing !== undefined) {
    return drawRoleEditor($, ui, state, view, editing)
  }

  return (
    <Box flexDirection="column">
      {state.notice !== undefined && <Text color="success">{state.notice}</Text>}
      <Text dimColor>Pick a role to change its model. Subagents use these on their next spawn.</Text>
      <Box flexDirection="column" marginTop={1}>
        {rows.map(row => drawRoleRow($, ui, row))}
      </Box>
    </Box>
  )
}

function drawRoleRow($: EngineInterface, ui: Ui, row: RoleRow) {
  const { Button, Text } = ui
  const summary = `${row.spec}  →  ${row.resolved}  [${row.source}]`
  let color: 'error' | undefined

  if (row.isBroken) {
    color = 'error'
  }

  return (
    <Button key={`role-${row.role}`} plain onPress={() => startEdit($, row)}>
      {row.role.padEnd(11)}
      <Text color={color} dimColor={!row.isBroken}>
        {summary}
      </Text>
    </Button>
  )
}

async function startEdit($: EngineInterface, row: RoleRow): Promise<void> {
  const draft = draftOf(row.spec)
  let scope: RoleScope = 'global'

  if (row.source === 'project') {
    scope = 'project'
  }

  await update($, panelAtom, state => ({
    ...state,
    editRole: row.role,
    draftHead: draft.head,
    draftEffort: draft.effort,
    draftScope: scope,
    notice: undefined,
  }))
}

function toEffortValue(effort: string): string {
  if (effort === '') {
    return NO_EFFORT
  }

  return effort
}

function drawRoleEditor($: EngineInterface, ui: Ui, state: PanelState, view: RoleView, row: RoleRow) {
  const { Box, Button, Input, Select, Text } = ui
  const choices = modelChoices(row.role, Object.keys(view.merged), state.draftHead)
  const preview = specOf({ head: state.draftHead, effort: asEffort(state.draftEffort) })
  const hasFileEntry = view.global[row.role] !== undefined || view.project[row.role] !== undefined
  const fallback = DEFAULT_ROLES[row.role]
  let resetNote = 'removes this role from the file'

  if (fallback !== undefined) {
    resetNote = `back to the default (${fallback})`
  }

  return (
    <Box flexDirection="column">
      <Text bold>{`Editing ${row.role}`}</Text>
      <Text dimColor>{`now ${row.spec} → ${row.resolved} [${row.source}]`}</Text>
      <Box flexDirection="column" marginTop={1}>
        <Select
          key="edit-model"
          label="model"
          options={choices.map(choice => ({ value: choice, label: modelLabel(choice) }))}
          value={state.draftHead}
          onSelect={value => setDraft($, { draftHead: value })}
        />
        <Select
          key="edit-effort"
          label="effort"
          options={EFFORT_OPTIONS.map(value => ({ value }))}
          value={toEffortValue(state.draftEffort)}
          onSelect={value => setDraft($, { draftEffort: fromEffortValue(value) })}
        />
        <Select
          key="edit-scope"
          label="save to"
          options={SCOPE_OPTIONS.map(value => ({ value }))}
          value={state.draftScope}
          onSelect={value => setDraft($, { draftScope: asScope(value) })}
        />
        <Input
          key="edit-custom"
          label="or type a model"
          placeholder="claude-opus-5-5:high"
          submitLabel="use"
          onSubmit={value => useTypedSpec($, value)}
        />
      </Box>
      <Box marginTop={1}>
        <Text>{`will save: ${row.role} → ${preview} (${state.draftScope})`}</Text>
      </Box>
      <Box flexDirection="row" gap={1} marginTop={1}>
        <Button key="edit-save" hotkey="s" variant="primary" onPress={() => saveRole($, row.role)}>
          Save
        </Button>
        {hasFileEntry && (
          <Button key="edit-reset" hotkey="x" onPress={() => resetRole($, row.role)}>
            Reset
          </Button>
        )}
        <Button key="edit-cancel" hotkey="c" onPress={() => cancelEdit($)}>
          Cancel
        </Button>
      </Box>
      {hasFileEntry && <Text dimColor>{`Reset ${resetNote}.`}</Text>}
      {state.notice !== undefined && <Text color="error">{state.notice}</Text>}
    </Box>
  )
}

function modelLabel(choice: string): string {
  if (choice === '*') {
    return 'inherit (session model)'
  }

  return choice
}

function fromEffortValue(value: string): string {
  if (value === NO_EFFORT) {
    return ''
  }

  return value
}

function asEffort(value: string): '' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' {
  if (isEffort(value)) {
    return value
  }

  return ''
}

function asScope(value: string): RoleScope {
  if (value === 'project') {
    return 'project'
  }

  return 'global'
}

async function setDraft(
  $: EngineInterface,
  change: Partial<Pick<PanelState, 'draftHead' | 'draftEffort' | 'draftScope'>>,
): Promise<void> {
  await update($, panelAtom, state => ({ ...state, ...change, notice: undefined }))
}

async function useTypedSpec($: EngineInterface, text: string): Promise<void> {
  const spec = normalizeSpec(text)

  if (spec === undefined) {
    await update($, panelAtom, state => ({ ...state, notice: `Not a model spec: ${text}` }))

    return
  }

  const draft = draftOf(spec)
  await setDraft($, { draftHead: draft.head, draftEffort: draft.effort })
}

async function cancelEdit($: EngineInterface): Promise<void> {
  await update($, panelAtom, state => ({ ...state, editRole: undefined, notice: undefined }))
}

async function saveRole($: EngineInterface, role: string): Promise<void> {
  const state = await read($, panelAtom)
  const spec = normalizeSpec(specOf({ head: state.draftHead, effort: asEffort(state.draftEffort) }))

  if (spec === undefined) {
    await update($, panelAtom, current => ({ ...current, notice: 'That is not a valid model spec.' }))

    return
  }

  try {
    const config = await readRoleFile($, state.draftScope)
    const path = await writeRoleFile($, state.draftScope, { ...config, roles: { ...config.roles, [role]: spec } })
    $.ui.log(`jar panel: ${role} → ${spec} (${path})`)
    await update($, panelAtom, current => ({
      ...current,
      editRole: undefined,
      notice: `${role} → ${spec} saved to ${state.draftScope} roles.`,
    }))
  } catch (error) {
    $.ui.log(`jar panel: saving ${role} failed (${String(error)})`)
    await update($, panelAtom, current => ({ ...current, notice: `Could not save: ${String(error)}` }))
  }
}

/** Removes the role from both files, so the default applies again. */
async function resetRole($: EngineInterface, role: string): Promise<void> {
  try {
    for (const scope of ['global', 'project'] as const) {
      const config = await readRoleFile($, scope)

      if (config.roles[role] === undefined) {
        continue
      }

      const kept = Object.entries(config.roles).filter(([name]) => name !== role)
      await writeRoleFile($, scope, { ...config, roles: Object.fromEntries(kept) })
      $.ui.log(`jar panel: ${role} removed from ${scope} roles`)
    }

    await update($, panelAtom, current => ({ ...current, editRole: undefined, notice: `${role} reset.` }))
  } catch (error) {
    $.ui.log(`jar panel: resetting ${role} failed (${String(error)})`)
    await update($, panelAtom, current => ({ ...current, notice: `Could not reset: ${String(error)}` }))
  }
}
