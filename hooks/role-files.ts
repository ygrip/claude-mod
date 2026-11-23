// Where role configs live: ~/.claude/jar/roles.json (global) and <cwd>/.claude/jar-roles.json (project).
import type { EngineInterface } from 'claude-code'

import { mergeRoles, parseRoleConfig, type RoleConfig } from './roles'

export type RoleScope = 'global' | 'project'

export async function roleFilePath($: EngineInterface, scope: RoleScope): Promise<string> {
  if (scope === 'project') {
    return `${await $.session.cwd()}/.claude/jar-roles.json`
  }

  const home = (await $.env.get('HOME')) ?? ''

  return `${home}/.claude/jar/roles.json`
}

const EMPTY: RoleConfig = { version: 2, roles: {} }

export async function readRoleFile($: EngineInterface, scope: RoleScope): Promise<RoleConfig> {
  const path = await roleFilePath($, scope)

  if (!(await $.fs.exists(path))) {
    return EMPTY
  }

  try {
    return parseRoleConfig(JSON.parse(await $.fs.read(path)))
  } catch (error) {
    $.ui.log(`jar roles: ${path} ignored (${String(error)})`)

    return EMPTY
  }
}

export async function writeRoleFile($: EngineInterface, scope: RoleScope, config: RoleConfig): Promise<string> {
  const path = await roleFilePath($, scope)
  const folder = path.slice(0, path.lastIndexOf('/'))
  const made = await $.process.run(['mkdir', '-p', folder])

  if (made.exitCode !== 0) {
    throw new Error(`cannot create ${folder}: ${made.stderr.trim()}`)
  }

  await $.fs.write(path, JSON.stringify(config, null, 2) + '\n')

  return path
}

/** Defaults, global and project roles, merged; read on each use so edits apply at once. */
export async function loadRoles($: EngineInterface): Promise<Record<string, string>> {
  const global = await readRoleFile($, 'global')
  const project = await readRoleFile($, 'project')

  return mergeRoles(global.roles, project.roles)
}
