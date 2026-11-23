import { describe, expect, test } from 'claude-code/testing'

import {
  DiscussionError,
  DiscussionHub,
  emptyHub,
  MAX_DISCUSSION_TEXT,
  messageLine,
  MODERATOR,
  parseDiscussionId,
} from '../hooks/discuss-hub'

function hubWithAgents(): DiscussionHub {
  const hub = new DiscussionHub(emptyHub())
  hub.register('a1', 'scout')
  hub.register('a2', 'worker')

  return hub
}

describe('discussion hub', () => {
  test('a targeted question reaches only its target, and the answer only the asker', () => {
    const hub = hubWithAgents()
    const asked = hub.ask('a1', 'Which file holds the router?', 'moderator')

    expect(asked.toKey).toBe(MODERATOR)
    expect(hub.pending('a2').unread).toBe(0)
    expect(hub.list(MODERATOR).messages.map(messageLine)).toEqual([
      '[d1] Q · scout → moderator: Which file holds the router?',
    ])

    const answered = hub.answer(MODERATOR, asked.id, 'hooks/route.ts')

    expect(answered.askerKey).toBe('a1')
    expect(hub.list('a1').messages.map(messageLine)).toEqual(['[d2] A · moderator → d1: hooks/route.ts'])
    expect(hub.pending('a2').unread).toBe(0)
  })

  test('a broadcast reaches everyone but its sender', () => {
    const hub = hubWithAgents()
    hub.ask(MODERATOR, 'Stop editing shared files.')

    expect(hub.recipients(MODERATOR)).toEqual(['a1', 'a2'])
    expect(hub.pending('a1').unread).toBe(1)
    expect(hub.pending('a2').unread).toBe(1)
    expect(hub.pending(MODERATOR).unread).toBe(0)
  })

  test('a new agent never reads earlier chatter', () => {
    const hub = hubWithAgents()
    hub.ask(MODERATOR, 'Old news.')
    hub.register('a3', 'late')

    expect(hub.pending('a3').unread).toBe(0)
  })

  test('unread mail rides on a reply when it fits, then counts as read', () => {
    const hub = hubWithAgents()
    hub.ask(MODERATOR, 'Status?', 'a1')
    const reply = hub.ask('a1', 'Need the schema.', 'a2')

    expect(reply.delivered.map(view => view.text)).toEqual(['Status?'])
    expect(hub.pending('a1').unread).toBe(0)
  })

  test('acknowledge marks pushed mail read', () => {
    const hub = hubWithAgents()
    const asked = hub.ask(MODERATOR, 'Ping', 'a2')
    hub.acknowledge('a2', [asked.id])

    expect(hub.pending('a2').unread).toBe(0)
    expect(hub.notice('a2')).toBeUndefined()
  })

  test('long text is clipped and the data survives a round trip through plain JSON', () => {
    const hub = hubWithAgents()
    const asked = hub.ask('a1', 'x'.repeat(MAX_DISCUSSION_TEXT + 50))
    const reloaded = new DiscussionHub(JSON.parse(JSON.stringify(hub.data)))

    expect(asked.clipped).toBe(true)
    expect(reloaded.thread('a2', asked.id).question?.text.length).toBe(MAX_DISCUSSION_TEXT)
  })

  const refusals: ReadonlyArray<readonly [string, (hub: DiscussionHub) => unknown, RegExp]> = [
    ['an empty question', hub => hub.ask('a1', '   '), /text is required/],
    ['an unknown target', hub => hub.ask('a1', 'hi', 'nobody'), /Unknown discussion target/],
    ['asking yourself', hub => hub.ask('a1', 'hi', 'a1'), /cannot target its sender/],
    ['an unknown question', hub => hub.answer('a1', 99, 'hi'), /Unknown discussion question d99/],
    ['an unknown agent', hub => hub.ask('ghost', 'hi'), /Unknown discussion agent/],
  ]

  for (const [name, act, message] of refusals) {
    test(`refuses ${name}`, () => {
      const hub = hubWithAgents()

      expect(() => act(hub)).toThrow(message)
      expect(() => act(hub)).toThrow(DiscussionError)
    })
  }

  test('answering an answer points at its question', () => {
    const hub = hubWithAgents()
    const asked = hub.ask('a1', 'Q?')
    const answered = hub.answer('a2', asked.id, 'A.')

    expect(() => hub.answer('a1', answered.id, 'again')).toThrow(`answer its question d${asked.id}`)
  })

  test('evicts answered and read groups when full, never unread questions', () => {
    const hub = hubWithAgents()

    for (let index = 0; index < 200; index++) {
      const asked = hub.ask('a1', `question ${index}`, 'a2')
      hub.answer('a2', asked.id, `answer ${index}`)
      hub.list('a1')
    }

    expect(hub.data.messages.length).toBeLessThanOrEqual(128)
  })

  test('says it is full when every message is unread', () => {
    const hub = hubWithAgents()
    let error: unknown

    try {
      for (let index = 0; index < 200; index++) {
        hub.ask('a1', `question ${index}`, 'a2')
      }
    } catch (caught) {
      error = caught
    }

    expect(String(error)).toContain('Discussion is full')
  })
})

describe('parseDiscussionId', () => {
  const cases: ReadonlyArray<readonly [unknown, number | undefined]> = [
    [12, 12],
    ['12', 12],
    ['d12', 12],
    ['#D12', 12],
    ['x12', undefined],
    [-1, undefined],
    [undefined, undefined],
  ]

  for (const [value, expected] of cases) {
    test(`${String(value)} → ${String(expected)}`, () => {
      expect(parseDiscussionId(value)).toBe(expected)
    })
  }
})
