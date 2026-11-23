// Auto route: each subagent spawn runs on its role's model unless the caller named one.
import { atom, update } from 'claude-code'
import type { AgentSpawnInput, Args, EngineInterface, PluginOptions } from 'claude-code'

import type { NextFn, StepResult } from './chain'
import { loadRoles } from './role-files'
import { isResolved, resolveRole } from './roles'
import {
  CLASSIFIER_SYSTEM,
  classifierPrompt,
  isClassified,
  parseClassifierAnswer,
  roleForType,
  type RoutedRole,
} from './route-rules'
import { INITIAL_ROUTE } from './state'

const routeAtom = atom({ plugin: 'jar', key: 'route' } as const, INITIAL_ROUTE)

const CLASSIFY_TIMEOUT_MS = 4_000
const FALLBACK_ROLE = 'task'

function isRoutable(e: AgentSpawnInput): boolean {
  const isPinned = e.model !== undefined || e.fork || e.resume !== undefined
  const isSpecial = e.isTeammate === true || e.workflow !== undefined

  return !isPinned && !isSpecial
}

async function classify($: EngineInterface, roles: Record<string, string>, e: AgentSpawnInput): Promise<string> {
  const classifier = resolveRole(roles, 'classifier')

  if (!isResolved(classifier) || classifier.model === undefined) {
    return FALLBACK_ROLE
  }

  const controller = new AbortController()
  const timer = $.clock.after(CLASSIFY_TIMEOUT_MS, () => controller.abort())

  try {
    const reply = await $.model.complete(
      {
        model: classifier.model,
        effort: classifier.effort,
        maxTokens: 8,
        system: CLASSIFIER_SYSTEM,
        prompt: classifierPrompt(e.description, e.prompt),
      },
      { signal: controller.signal },
    )

    if (!reply.isAnswered) {
      return FALLBACK_ROLE
    }

    return parseClassifierAnswer(reply.text) ?? FALLBACK_ROLE
  } finally {
    timer.cancel()
  }
}

async function chooseRole(
  $: EngineInterface,
  roles: Record<string, string>,
  e: AgentSpawnInput,
): Promise<RoutedRole | string | undefined> {
  const fixed = roleForType(e.subagentType)

  if (fixed !== undefined) {
    return fixed
  }

  if (isClassified(e.subagentType)) {
    return classify($, roles, e)
  }

  return undefined
}

/** Set at register from the mod's options. */
let isAutoRouteOn = true

export function configureRoute(options: PluginOptions): void {
  isAutoRouteOn = options.autoRoute !== false
}

export async function routeAgentSpawn(
  $: EngineInterface,
  e: Args<'agent.spawn'>,
  next: NextFn<'agent.spawn'>,
): StepResult<'agent.spawn'> {
  if (!isAutoRouteOn || !isRoutable(e)) {
    return next(e)
  }

  const roles = await loadRoles($)
  const role = await chooseRole($, roles, e)

  if (role === undefined) {
    return next(e)
  }

  const resolution = resolveRole(roles, role)

  if (!isResolved(resolution)) {
    $.ui.log(`jar route: role ${role} skipped (${resolution.error})`)

    return next(e)
  }

  if (resolution.model === undefined) {
    return next(e)
  }

  const model = resolution.model
  const answer = await next({ ...e, model })

  if (answer.deny === undefined) {
    await update($, routeAtom, () => ({ role, model, type: e.subagentType }))
    noteRoute($, e, role, model)
  }

  return answer
}

function noteRoute($: EngineInterface, e: AgentSpawnInput, role: string, model: string): void {
  if (e.tool_use_id === '') {
    return
  }

  $.ui.notice(e.tool_use_id, `◇ role ${role} · ${model}`)
}
