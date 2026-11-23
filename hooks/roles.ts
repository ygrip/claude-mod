// Model roles, ported from pi-jar src/model-roles.ts for Claude model names.
// A spec is `<model>[:effort]` (an alias such as `haiku` or a full id), `@role[:effort]`, or `*` (inherit).

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type RoleConfig = { version: 2; roles: Record<string, string> }

export type ResolvedRole = { model?: string; effort?: Effort; via: string[] }

export type RoleResolution = ResolvedRole | { error: string }

export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

const MAX_ALIAS_DEPTH = 5
const INHERIT = '*'
const MODEL_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._\-[\]/]{0,159}$/

/** Works out of the box; any file entry replaces the role's default. */
export const DEFAULT_ROLES: Readonly<Record<string, string>> = {
  default: INHERIT,
  task: '@default',
  scout: 'haiku',
  worker: 'sonnet',
  reviewer: 'sonnet',
  plan: 'opus',
  advisor: 'opus:high',
  classifier: 'haiku:low',
}

export const ROUTED_ROLES = ['scout', 'worker', 'reviewer', 'plan'] as const

export function isRoleName(value: string): boolean {
  return /^[a-z][a-z0-9-]{0,31}$/.test(value)
}

export function isEffort(value: string): value is Effort {
  return EFFORTS.some(effort => effort === value)
}

type SpecParts = { head: string; effort?: Effort }

function splitEffort(spec: string): SpecParts {
  const colon = spec.lastIndexOf(':')

  if (colon <= 0) {
    return { head: spec }
  }

  const suffix = spec.slice(colon + 1)

  if (!isEffort(suffix)) {
    return { head: spec }
  }

  return { head: spec.slice(0, colon), effort: suffix }
}

/** A canonical spec, or undefined when the text is not one. */
export function normalizeSpec(raw: string): string | undefined {
  const value = raw.trim()

  if (value === INHERIT || value === 'inherit') {
    return INHERIT
  }

  const { head, effort } = splitEffort(value)
  let suffix = ''

  if (effort !== undefined) {
    suffix = ':' + effort
  }

  if (head.startsWith('@')) {
    if (isRoleName(head.slice(1))) {
      return head + suffix
    }

    return undefined
  }

  if (MODEL_TOKEN.test(head)) {
    return head + suffix
  }

  return undefined
}

export function parseRoleConfig(raw: unknown): RoleConfig {
  const config: RoleConfig = { version: 2, roles: {} }

  if (raw === null || typeof raw !== 'object') {
    return config
  }

  const roles = (raw as Record<string, unknown>).roles

  if (roles === null || typeof roles !== 'object') {
    return config
  }

  for (const [role, entry] of Object.entries(roles as Record<string, unknown>)) {
    if (!isRoleName(role) || typeof entry !== 'string') {
      continue
    }

    const spec = normalizeSpec(entry)

    if (spec !== undefined) {
      config.roles[role] = spec
    }
  }

  return config
}

/** Defaults, then the global file, then the project file: the later wins per role. */
export function mergeRoles(...layers: ReadonlyArray<Readonly<Record<string, string>>>): Record<string, string> {
  return Object.assign({}, DEFAULT_ROLES, ...layers)
}

/** Follow `@alias` chains; an effort written on the referring role wins over the target's. */
export function resolveRole(roles: Readonly<Record<string, string>>, role: string): RoleResolution {
  const via: string[] = []
  let current = role
  let effort: Effort | undefined

  for (let depth = 0; depth <= MAX_ALIAS_DEPTH; depth++) {
    if (via.includes(current)) {
      return { error: `alias cycle: ${[...via, current].join(' → ')}` }
    }

    via.push(current)
    const spec = roles[current]

    if (spec === undefined) {
      return { error: `@${current} is not assigned` }
    }

    const parts = splitEffort(spec)
    effort = effort ?? parts.effort

    if (parts.head === INHERIT) {
      return { effort, via }
    }

    if (!parts.head.startsWith('@')) {
      return { model: parts.head, effort, via }
    }

    current = parts.head.slice(1)
  }

  return { error: `alias chain deeper than ${MAX_ALIAS_DEPTH}` }
}

export function isResolved(resolution: RoleResolution): resolution is ResolvedRole {
  return !('error' in resolution)
}

/** One line per role for `/jar-roles list`. */
export function describeRoles(roles: Readonly<Record<string, string>>): string[] {
  return Object.keys(roles)
    .sort()
    .map(role => {
      const resolution = resolveRole(roles, role)

      if (!isResolved(resolution)) {
        return `${role}  ${roles[role]}  ✖ ${resolution.error}`
      }

      const model = resolution.model ?? 'inherit'
      let effort = ''

      if (resolution.effort !== undefined) {
        effort = ` · ${resolution.effort}`
      }

      return `${role}  ${roles[role]}  → ${model}${effort}`
    })
}
