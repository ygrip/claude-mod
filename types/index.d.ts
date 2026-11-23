// jar's $.state contract: every value the mod keeps for the session.

export type Phase = 'idle' | 'generating' | 'tool' | 'waiting'

export type FlashMood = 'error' | 'complete'

export type MoodState = {
  phase: Phase
  lastActive: number
  flash?: { mood: FlashMood; until: number }
}

export type TaskStatus = 'pending' | 'in_progress' | 'completed'

export type TaskItem = { id: string; title: string; status: TaskStatus }

export type TaskBoard = { items: TaskItem[]; isExpanded: boolean }

export type RouteNote = { role: string; model: string; type: string }

export type HubMessage = {
  id: number
  kind: 'question' | 'answer'
  from: string
  fromName: string
  text: string
  bytes: number
  to?: string
  toName?: string
  answerers?: string[]
  replyTo?: number
  asker?: string
}

export type HubAgent = { key: string; name: string; cursor: number; seen: number[] }

export type HubData = {
  lastId: number
  size: number
  agents: Record<string, HubAgent>
  messages: HubMessage[]
}

export type AdvisorStatus = 'running' | 'done' | 'failed' | 'cancelled'

export type AdvisorRecord = {
  id: string
  status: AdvisorStatus
  startedAt: number
  trigger?: string
  question?: string
  text?: string
}

export type AdvisorData = { next: number; records: AdvisorRecord[] }

export type PanelTab = 'agents' | 'cost' | 'roles'

/** What the jar panel remembers between draws: the tab, the open agent, the role being edited. */
export type PanelState = {
  tab: PanelTab
  agentId?: string
  editRole?: string
  draftHead: string
  draftEffort: string
  draftScope: 'global' | 'project'
  notice?: string
}

declare module 'claude-code' {
  interface PluginState {
    'jar': {
      mood: Shaped<MoodState>
      board: Shaped<TaskBoard>
      route: RouteNote | null
      discussion: Shaped<HubData>
      advisor: Shaped<AdvisorData>
      panel: Shaped<PanelState>
    }
  }
}
