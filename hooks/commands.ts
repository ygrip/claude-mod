// Slash commands: /jar (status and toggles), /jar-roles (role config), /advisor (ask for a second opinion).
import { atom, read, update } from 'claude-code'
import type { Args, CommandRunResult, EngineInterface, On, PluginOptions } from 'claude-code'

import { advisorSummary, startAdvisor } from './advisor'
import type { NextFn, StepResult } from './chain'
import { discussionSummary } from './discuss'
import { loadRoles, readRoleFile, type RoleScope, writeRoleFile } from './role-files'
import { describeRoles, isRoleName, normalizeSpec } from './roles'
import { INITIAL_BOARD, INITIAL_ROUTE } from './state'

const boardAtom = atom({ plugin: 'jar', key: 'board' } as const, INITIAL_BOARD, { shape: 'board-1' })
const routeAtom = atom({ plugin: 'jar', key: 'route' } as const, INITIAL_ROUTE)

const ROLES_USAGE = [
  'Usage:',
  '  /jar-roles list',
  '  /jar-roles set ROLE SPEC [--project]   SPEC: haiku | sonnet:high | claude-opus-5-5 | @role[:effort] | *',
  '  /jar-roles clear ROLE [--project]',
  'Routed roles: scout, worker, reviewer, plan. Also: advisor, classifier, task, default.',
].join('\n')

function shown(text: string): CommandRunResult {
  return { text, isTextDisplayOnly: true }
}

function scopeOf(words: readonly string[]): RoleScope {
  if (words.includes('--project')) {
    return 'project'
  }

  return 'global'
}

async function rolesList($: EngineInterface): Promise<string> {
  const lines = describeRoles(await loadRoles($))

  return ['Roles (defaults < ~/.claude/jar/roles.json < .claude/jar-roles.json):', ...lines].join('\n')
}

async function rolesSet($: EngineInterface, words: readonly string[]): Promise<string> {
  const [, role, rawSpec] = words

  if (role === undefined || rawSpec === undefined || !isRoleName(role)) {
    return ROLES_USAGE
  }

  const spec = normalizeSpec(rawSpec)

  if (spec === undefined) {
    return `Not a role spec: ${rawSpec}\n${ROLES_USAGE}`
  }

  const scope = scopeOf(words)
  const config = await readRoleFile($, scope)
  config.roles[role] = spec
  const path = await writeRoleFile($, scope, config)

  return `${role} → ${spec} (${scope}: ${path})`
}

async function rolesClear($: EngineInterface, words: readonly string[]): Promise<string> {
  const role = words[1]

  if (role === undefined) {
    return ROLES_USAGE
  }

  const scope = scopeOf(words)
  const config = await readRoleFile($, scope)
  delete config.roles[role]
  const path = await writeRoleFile($, scope, config)

  return `${role} cleared (${scope}: ${path}); the default applies.`
}

async function runRoles($: EngineInterface, args: string): Promise<string> {
  const words = args.trim().split(/\s+/).filter(word => word !== '')
  const action = words[0] ?? 'list'

  if (action === 'list') {
    return rolesList($)
  }

  if (action === 'set') {
    return rolesSet($, words)
  }

  if (action === 'clear') {
    return rolesClear($, words)
  }

  return ROLES_USAGE
}

async function jarStatus($: EngineInterface, options: PluginOptions): Promise<string> {
  const route = await read($, routeAtom)
  let routeLine = 'route: no subagent routed yet'

  if (route !== null) {
    routeLine = `route: last ${route.type} → ${route.role} · ${route.model}`
  }

  return [
    'jar',
    `auto route ${String(options.autoRoute !== false)} · advisor gates ${String(options.advisorGates !== false)} · Ember ${String(options.mascot !== false)}  (toggle in /config)`,
    routeLine,
    await advisorSummary($),
    await discussionSummary($),
    'commands: /jar tasks (expand/collapse the task perch), /jar-roles, /jar-advisor [focus]',
    "note: Claude Code's own task list may still show beside the perch.",
  ].join('\n')
}

async function runJar($: EngineInterface, args: string, options: PluginOptions): Promise<string> {
  const action = args.trim()

  if (action === 'tasks') {
    await update($, boardAtom, board => ({ ...board, isExpanded: !board.isExpanded }))

    return 'Task perch toggled.'
  }

  if (action === 'discuss') {
    return discussionSummary($)
  }

  if (action === 'advisor') {
    return advisorSummary($)
  }

  return jarStatus($, options)
}

export async function commandsSessionStart(
  $: EngineInterface,
  e: Args<'session.start'>,
  next: NextFn<'session.start'>,
): StepResult<'session.start'> {
  const answer = await next(e)
  await $.command.register({
    name: 'jar',
    description: 'jar status and toggles',
    argumentHint: '[tasks|discuss|advisor]',
    immediate: true,
  })
  await $.command.register({
    name: 'jar-roles',
    description: 'List or set jar model roles',
    argumentHint: '[list|set ROLE SPEC|clear ROLE] [--project]',
  })
  await $.command.register({
    name: 'jar-advisor',
    description: 'Ask the advisor role for a second opinion',
    argumentHint: '[focus]',
  })

  return answer
}

export function registerCommands(on: On, options: PluginOptions): void {
  on('command.run', { command: 'jar' }, async ($, e) => shown(await runJar($, e.args, options)))

  on('command.run', { command: 'jar-roles' }, async ($, e) => {
    try {
      return shown(await runRoles($, e.args))
    } catch (error) {
      return shown(`jar roles: ${String(error)}`)
    }
  })

  on('command.run', { command: 'jar-advisor' }, async ($, e) => {
    try {
      const focus = e.args.trim()
      let question: string | undefined

      if (focus !== '') {
        question = focus
      }

      const id = await startAdvisor($, { question })

      return shown(`Advisor ${id} started; its advice joins the conversation when ready.`)
    } catch (error) {
      return shown(`jar advisor: ${String(error)}`)
    }
  })
}
