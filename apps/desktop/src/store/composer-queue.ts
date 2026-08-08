import { atom } from 'nanostores'

import type { ComposerAttachment } from './composer'

export interface QueuedPromptEntry {
  id: string
  text: string
  attachments: ComposerAttachment[]
  queuedAt: number
  source?: 'typed' | 'voice'
}

type QueueState = Record<string, QueuedPromptEntry[]>

const STORAGE_KEY = 'hermes.desktop.composerQueue.v1'
const inFlightQueuedPromptIds = new Set<string>()

/**
 * Mark a queue entry as claimed by the drain loop. This state is deliberately
 * process-local: a restart must recover every persisted entry as pending.
 */
export const setQueuedPromptInFlight = (id: null | string | undefined, inFlight: boolean) => {
  if (!id) {
    return
  }

  if (inFlight) {
    inFlightQueuedPromptIds.add(id)

    return
  }

  inFlightQueuedPromptIds.delete(id)

  for (const [sid, queue] of Object.entries($queuedPromptsBySession.get())) {
    const releasedIndex = queue.findIndex(entry => entry.id === id)
    const released = queue[releasedIndex]

    if (releasedIndex < 0 || released?.source !== 'voice') {
      continue
    }

    let mergedText = released.text.trimEnd()

    const next = queue.filter((entry, index) => {
      if (
        index <= releasedIndex ||
        entry.source !== 'voice' ||
        inFlightQueuedPromptIds.has(entry.id)
      ) {
        return true
      }

      mergedText = `${mergedText} ${entry.text.trimStart()}`

      return false
    })

    if (next.length !== queue.length) {
      next[releasedIndex] = { ...released, text: mergedText }
      writeSession(sid, next)
    }

    return
  }
}

const load = (): QueueState => {
  if (typeof window === 'undefined') {
    return {}
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : null

    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as QueueState) : {}
  } catch {
    return {}
  }
}

const save = (state: QueueState) => {
  if (typeof window === 'undefined') {
    return
  }

  try {
    if (Object.keys(state).length === 0) {
      window.localStorage.removeItem(STORAGE_KEY)
    } else {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    }
  } catch {
    // best-effort: storage may be unavailable, queue still works in-memory
  }
}

export const $queuedPromptsBySession = atom<QueueState>(load())

const writeSession = (sid: string, queue: QueuedPromptEntry[]) => {
  const current = $queuedPromptsBySession.get()
  const next = { ...current }

  if (queue.length === 0) {
    delete next[sid]
  } else {
    next[sid] = queue
  }

  $queuedPromptsBySession.set(next)
  save(next)
}

const sidOf = (key: string | null | undefined): null | string => {
  const trimmed = key?.trim()

  return trimmed ? trimmed : null
}

const queueFor = (sid: string) => $queuedPromptsBySession.get()[sid] ?? []

const nextId = () => `queued-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

const cloneAttachments = (attachments: ComposerAttachment[]) => attachments.map(a => ({ ...a }))

export const getQueuedPrompts = (key: string | null | undefined): QueuedPromptEntry[] => {
  const sid = sidOf(key)

  return sid ? queueFor(sid) : []
}

export const enqueueQueuedPrompt = (
  key: string | null | undefined,
  payload: { text: string; attachments: ComposerAttachment[]; source?: 'typed' | 'voice' }
): null | QueuedPromptEntry => {
  const sid = sidOf(key)

  if (!sid) {
    return null
  }

  const queue = queueFor(sid)

  if (payload.source === 'voice') {
    const existingIndex = queue.findIndex(
      entry => entry.source === 'voice' && !inFlightQueuedPromptIds.has(entry.id)
    )

    if (existingIndex >= 0) {
      const existing = queue[existingIndex]

      if (!existing) {
        return null
      }

      const merged: QueuedPromptEntry = {
        ...existing,
        text: `${existing.text.trimEnd()} ${payload.text.trimStart()}`
      }

      const next = [...queue]
      next[existingIndex] = merged
      writeSession(sid, next)

      return merged
    }
  }

  const entry: QueuedPromptEntry = {
    id: nextId(),
    text: payload.text,
    attachments: cloneAttachments(payload.attachments),
    queuedAt: Date.now(),
    ...(payload.source ? { source: payload.source } : {})
  }

  writeSession(sid, [...queue, entry])

  return entry
}

export const dequeueQueuedPrompt = (key: string | null | undefined): null | QueuedPromptEntry => {
  const sid = sidOf(key)

  if (!sid) {
    return null
  }

  const [head, ...rest] = queueFor(sid)

  if (!head) {
    return null
  }

  writeSession(sid, rest)
  inFlightQueuedPromptIds.delete(head.id)

  return head
}

export const removeQueuedPrompt = (key: string | null | undefined, id: string): boolean => {
  const sid = sidOf(key)

  if (!sid) {
    return false
  }

  const queue = queueFor(sid)
  const next = queue.filter(e => e.id !== id)

  if (next.length === queue.length) {
    return false
  }

  writeSession(sid, next)
  inFlightQueuedPromptIds.delete(id)

  return true
}

export const promoteQueuedPrompt = (key: string | null | undefined, id: string): boolean => {
  const sid = sidOf(key)

  if (!sid) {
    return false
  }

  const queue = queueFor(sid)
  const index = queue.findIndex(e => e.id === id)

  if (index <= 0) {
    return false
  }

  const entry = queue[index]!
  writeSession(sid, [entry, ...queue.slice(0, index), ...queue.slice(index + 1)])

  return true
}

export const updateQueuedPrompt = (
  key: string | null | undefined,
  id: string,
  update: { text: string; attachments?: ComposerAttachment[] }
): boolean => {
  const sid = sidOf(key)

  if (!sid) {
    return false
  }

  const queue = queueFor(sid)
  let changed = false

  const next = queue.map(entry => {
    if (entry.id !== id) {
      return entry
    }

    const attachments = update.attachments ? cloneAttachments(update.attachments) : entry.attachments

    if (entry.text === update.text && !update.attachments) {
      return entry
    }

    changed = true

    return { ...entry, text: update.text, attachments }
  })

  if (!changed) {
    return false
  }

  writeSession(sid, next)

  return true
}

export const updateQueuedPromptText = (key: string | null | undefined, id: string, text: string): boolean =>
  updateQueuedPrompt(key, id, { text })

export const clearQueuedPrompts = (key: string | null | undefined) => {
  const sid = sidOf(key)

  if (!sid || !(sid in $queuedPromptsBySession.get())) {
    return
  }

  for (const entry of queueFor(sid)) {
    inFlightQueuedPromptIds.delete(entry.id)
  }

  writeSession(sid, [])
}

/**
 * Move pending entries from a dead session key onto a live one, preserving FIFO
 * (existing target entries first, migrated entries appended). A backend bounce /
 * resume can mint a fresh runtime session id for the *same* conversation; the
 * entries enqueued under the old id would otherwise be stranded under a key
 * nothing reads anymore. No-op unless both keys resolve and differ.
 */
export const migrateQueuedPrompts = (fromKey: string | null | undefined, toKey: string | null | undefined): boolean => {
  const from = sidOf(fromKey)
  const to = sidOf(toKey)

  if (!from || !to || from === to) {
    return false
  }

  const pending = queueFor(from)

  if (pending.length === 0) {
    return false
  }

  const next = { ...$queuedPromptsBySession.get() }
  delete next[from]
  next[to] = [...queueFor(to), ...pending]

  $queuedPromptsBySession.set(next)
  save(next)

  return true
}

/** Inputs to {@link shouldAutoDrain}. */
export interface AutoDrainInput {
  isBusy: boolean
  queueLength: number
}

/**
 * Decide whether the composer should auto-drain the next queued prompt.
 *
 * Edge-independent on purpose: the queue must advance whenever the session is
 * idle and has pending entries, NOT only on an observed busy true → false edge.
 * A backend bounce / websocket reconnect remounts the composer and resets the
 * busy ref to the current value, swallowing the settle edge — an edge-gated
 * drain would then strand the entry forever. The caller's drain lock
 * (`drainingQueueRef`) serializes sends so being edge-free can't double-submit.
 */
export const shouldAutoDrain = ({ isBusy, queueLength }: AutoDrainInput): boolean => !isBusy && queueLength > 0

/** Auto-drain attempts for one entry before we stop retrying and toast. The
 * entry stays queued for a manual send; a remount/reconnect resets the count. */
export const MAX_AUTO_DRAIN_ATTEMPTS = 4
