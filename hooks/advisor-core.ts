// Advisor logic ported from pi-jar src/advisor.ts: loop and failure gates, prompt and transcript builders.
import type { SessionMessage } from 'claude-code'

export const LOOP_REPEATS = 4
export const FAILURE_STREAK = 3
export const GATES_PER_PROMPT = 2
const WINDOW = 8
const KEY_INPUT_CHARS = 1024
export const TRANSCRIPT_LIMIT = 12_000
const TOOL_RESULT_CHARS = 1_200
const MESSAGE_CHARS = 4_000

export const ADVISOR_SYSTEM = [
  'You are the advisor: a senior engineer giving a second opinion to a coding agent (the executor) mid-task.',
  'You see a transcript excerpt and the repository state; you cannot run tools.',
  'Be direct and specific. Lead with your verdict (proceed / revise / stop and ask the user), then the reasons,',
  'then concrete next steps. Point out wrong assumptions, missed edge cases, simpler approaches and risks.',
  'Keep it under 250 words. Do not restate the transcript.',
].join('\n')

export type AdvisorRequest = { question?: string; draft?: string; trigger?: string }

/** FNV-1a, enough to tell long inputs apart in a loop key. */
function digest(text: string): string {
  let hash = 0x811c9dc5

  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }

  return hash.toString(16)
}

/** A stable key per tool and input; a large input keeps a prefix and a digest. */
export function callKey(tool: string, input: unknown): string {
  const json = String(JSON.stringify(input ?? {}))

  if (json.length <= KEY_INPUT_CHARS) {
    return `${tool} ${json}`
  }

  return `${tool} ${json.slice(0, 200)}…#${digest(json)}`
}

const TEST_COMMAND =
  /(?:^|[\s;&|(])(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::\S+)?|node\s+(?:\S+\s+)*--test|(?:npx\s+)?(?:pytest|vitest|jest|mocha|phpunit|rspec|playwright\s+test)|(?:go|cargo|dotnet|deno|swift|mix)\s+test|python3?\s+-m\s+(?:pytest|unittest)|(?:\.\/)?(?:gradlew|gradle|mvnw|mvn)\s+(?:\S+\s+)*test|make\s+(?:\S+\s+)*test|claude\s+plugin\s+test)(?=$|[\s;&|)])/

const READ_ONLY_REPEATS = new Set(['Read', 'Grep', 'Glob', 'BashOutput', 'TaskOutput', 'TaskGet', 'TaskList'])

/** Calls that repeat identically during normal work: re-reads, output polls and test reruns. */
export function loopExempt(tool: string, input: Record<string, unknown>): boolean {
  if (READ_ONLY_REPEATS.has(tool)) {
    return true
  }

  return tool === 'Bash' && typeof input.command === 'string' && TEST_COMMAND.test(input.command)
}

/** Repeated calls and failure streaks within one user prompt. */
export class StuckDetector {
  private recent: string[] = []
  private failures = 0
  private gates = 0

  reset(): void {
    this.recent = []
    this.failures = 0
    this.gates = 0
  }

  /** A trigger description when this call completes a loop. */
  call(key: string): string | undefined {
    this.recent.push(key)

    if (this.recent.length > WINDOW) {
      this.recent.shift()
    }

    const count = this.recent.filter(item => item === key).length

    if (count < LOOP_REPEATS || !this.take()) {
      return undefined
    }

    this.recent = []

    return `the executor has made the same tool call ${count} times: ${key.slice(0, 200)}`
  }

  /** A trigger description when a failure streak is reached. */
  result(isError: boolean, tool: string): string | undefined {
    if (isError) {
      this.failures += 1
    } else {
      this.failures = 0
    }

    if (this.failures < FAILURE_STREAK || !this.take()) {
      return undefined
    }

    this.failures = 0

    return `${FAILURE_STREAK} tool calls in a row failed (last: ${tool})`
  }

  private take(): boolean {
    if (this.gates >= GATES_PER_PROMPT) {
      return false
    }

    this.gates += 1

    return true
  }
}

export function advisorPrompt(request: AdvisorRequest, conversation: string, git: string): string {
  const parts: string[] = []

  if (request.trigger !== undefined) {
    parts.push(`Automatic consultation: ${request.trigger}`)
  }

  if (request.question !== undefined) {
    parts.push(`Executor's question: ${request.question}`)
  } else {
    parts.push("Executor asks for a general review of its current direction.")
  }

  if (request.draft !== undefined) {
    parts.push(`Executor's draft / candidate approach:\n${request.draft}`)
  }

  if (git !== '') {
    parts.push(`Repository state:\n${git}`)
  }

  parts.push(`Recent conversation:\n${conversation || '(empty)'}`)

  return parts.join('\n\n')
}

function toolHint(input: Record<string, unknown>): string {
  for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'prompt']) {
    const value = input[key]

    if (typeof value === 'string' && value !== '') {
      return ` ${key}=${value.slice(0, 240)}`
    }
  }

  return ''
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) {
    return text
  }

  return text.slice(0, limit) + ' …'
}

function messageBody(message: SessionMessage): string {
  const lines: string[] = []

  if (message.text.trim() !== '') {
    lines.push(clip(message.text.trim(), MESSAGE_CHARS))
  }

  for (const use of message.toolUses) {
    lines.push(`[tool ${use.tool}${toolHint(use.input)}]`)

    if (use.text !== undefined && use.text !== '') {
      let label = 'result'

      if (use.isError === true) {
        label = 'error'
      }

      lines.push(`${label}: ${clip(use.text, TOOL_RESULT_CHARS)}`)
    }
  }

  return lines.join('\n')
}

/** The newest conversation, oldest first, within `limit` characters. */
export function transcript(messages: readonly SessionMessage[], limit = TRANSCRIPT_LIMIT): string {
  const parts: string[] = []
  let size = 0

  for (let index = messages.length - 1; index >= 0 && size < limit; index--) {
    const message = messages[index]

    if (message === undefined) {
      continue
    }

    const body = messageBody(message)

    if (body === '') {
      continue
    }

    const part = `### ${message.role}\n${body}`.slice(0, limit - size)
    parts.unshift(part)
    size += part.length
  }

  return parts.join('\n\n')
}
