// Which role a subagent gets: a fixed map by type, and a one-word classifier for generic spawns.
import { ROUTED_ROLES } from './roles'

export type RoutedRole = (typeof ROUTED_ROLES)[number]

const CLASSIFY_PROMPT_CHARS = 1_500

export const CLASSIFIER_SYSTEM = [
  'You route a coding agent\'s delegated task to a role. Answer with exactly one word:',
  'scout    - read-only searching, exploring, locating code or facts',
  'worker   - writing or changing code, running builds, fixing bugs',
  'reviewer - reviewing, verifying, auditing or testing finished work',
  'plan     - designing an approach or architecture before any code is written',
].join('\n')

const TYPE_RULES: ReadonlyArray<readonly [RegExp, RoutedRole]> = [
  [/^explore$/i, 'scout'],
  [/^plan$/i, 'plan'],
  [/guide|scout|explore|search|finder|lookup/i, 'scout'],
  [/review|bagong|verif|audit|validat/i, 'reviewer'],
  [/petruk|implement|builder|worker|fixer/i, 'worker'],
  [/gareng|architect|planner/i, 'plan'],
]

/** The role a subagent type always gets; undefined leaves the spawn alone or to the classifier. */
export function roleForType(subagentType: string): RoutedRole | undefined {
  const rule = TYPE_RULES.find(([pattern]) => pattern.test(subagentType))

  if (rule === undefined) {
    return undefined
  }

  return rule[1]
}

/** Only the catch-all type is classified: any other agent keeps its own definition's model. */
export function isClassified(subagentType: string): boolean {
  return subagentType === 'general-purpose'
}

export function classifierPrompt(description: string, prompt: string): string {
  return `Task title: ${description}\n\nTask:\n${prompt.slice(0, CLASSIFY_PROMPT_CHARS)}`
}

export function parseClassifierAnswer(text: string): RoutedRole | undefined {
  const word = text.trim().toLowerCase().match(/[a-z]+/)

  if (word === null) {
    return undefined
  }

  return ROUTED_ROLES.find(role => role === word[0])
}
