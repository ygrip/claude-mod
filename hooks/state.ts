// Initial values of the mod's $.state keys. Validate wants each file to declare the atoms it reads
// or writes in a const of its own, so every file writes
//   const moodAtom = atom({ plugin: 'jar', key: 'mood' } as const, INITIAL_MOOD, { shape: 'mood-1' })
// with the same key, initial value and shape tag. Change a shape tag everywhere when its value's fields change.
import type { AdvisorData, HubData, MoodState, RouteNote, TaskBoard } from '../types'

export const INITIAL_MOOD: MoodState = { phase: 'idle', lastActive: 0 }
export const INITIAL_BOARD: TaskBoard = { items: [], isExpanded: false }
export const INITIAL_ROUTE: RouteNote | null = null
export const INITIAL_HUB: HubData = { lastId: 0, size: 0, agents: {}, messages: [] }
export const INITIAL_ADVISOR: AdvisorData = { next: 1, records: [] }
