// Types for feature steps. The engine allows one unmatched hook per event, so register.tsx nests
// each feature's named step function inside that one hook; `next` is the rest of the nest.
import type { Args, EventName, NextResult } from 'claude-code'

export type NextFn<N extends EventName> = (e: Args<N>) => Promise<NextResult<N>>

export type StepResult<N extends EventName> = Promise<NextResult<N>>
