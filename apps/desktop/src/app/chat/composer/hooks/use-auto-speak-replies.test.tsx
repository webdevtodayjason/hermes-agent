import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $messages } from '@/store/session'
import { setVoicePlaybackState } from '@/store/voice-playback'
import { $autoSpeakReplies } from '@/store/voice-prefs'

import { useAutoSpeakReplies } from './use-auto-speak-replies'

const { playSpeechText } = vi.hoisted(() => ({
  playSpeechText: vi.fn(async () => true)
}))

vi.mock('@/lib/voice-playback', () => ({ playSpeechText }))

beforeEach(() => {
  $autoSpeakReplies.set(false)
  $messages.set([])
  setVoicePlaybackState({
    audioElement: null,
    messageId: null,
    sequence: 0,
    source: null,
    status: 'idle'
  })
  playSpeechText.mockClear()
})

afterEach(cleanup)

describe('useAutoSpeakReplies', () => {
  it('never invokes generic TTS during active Spoke', () => {
    let reply: { id: string; pending: boolean; text: string } | null = {
      id: 'old-reply',
      pending: false,
      text: 'Old history'
    }

    const markSpoken = vi.fn(() => {
      reply = null
    })

    renderHook(() =>
      useAutoSpeakReplies({
        conversationActive: true,
        failureLabel: 'Speech failed',
        markSpoken,
        pendingReply: () => reply,
        sessionId: 's1'
      })
    )

    expect(markSpoken).not.toHaveBeenCalled()
    reply = { id: 'realtime:provider-assistant', pending: false, text: 'Provider already spoke this' }
    act(() => $messages.set([]))

    expect(playSpeechText).not.toHaveBeenCalled()
  })

  it('keeps generic TTS off during active Spoke even when standalone auto-speak is enabled', () => {
    $autoSpeakReplies.set(true)
    let reply: { id: string; pending: boolean; text: string } | null = null

    const markSpoken = vi.fn(() => {
      reply = null
    })

    renderHook(() =>
      useAutoSpeakReplies({
        conversationActive: true,
        failureLabel: 'Speech failed',
        markSpoken,
        pendingReply: () => reply,
        sessionId: 's1'
      })
    )

    reply = { id: 'canonical-or-provider', pending: false, text: 'Dedicated Spoke channel owns narration' }
    act(() => $messages.set([]))

    expect(markSpoken).not.toHaveBeenCalled()
    expect(playSpeechText).not.toHaveBeenCalled()
  })

  it('uses read-aloud for new standalone replies without replaying existing history', async () => {
    $autoSpeakReplies.set(true)

    let reply: { id: string; pending: boolean; text: string } | null = {
      id: 'history',
      pending: false,
      text: 'Existing history'
    }

    const markSpoken = vi.fn(() => {
      reply = null
    })

    renderHook(() =>
      useAutoSpeakReplies({
        conversationActive: false,
        failureLabel: 'Speech failed',
        markSpoken,
        pendingReply: () => reply,
        sessionId: 's1'
      })
    )

    expect(markSpoken).toHaveBeenCalledTimes(1)
    expect(playSpeechText).not.toHaveBeenCalled()

    reply = { id: 'reply-1', pending: false, text: 'Standalone answer' }
    act(() => $messages.set([]))

    await waitFor(() =>
      expect(playSpeechText).toHaveBeenCalledWith('Standalone answer', {
        messageId: 'reply-1',
        source: 'read-aloud'
      })
    )
  })

  it('waits for a standalone reply to become terminal and speaks its ID at most once', async () => {
    $autoSpeakReplies.set(true)
    let reply: { id: string; pending: boolean; text: string } | null = null
    const spokenIds = new Set<string>()

    const markSpoken = vi.fn(() => {
      if (reply) {
        spokenIds.add(reply.id)
      }
    })

    const pendingReply = () => (reply && !spokenIds.has(reply.id) ? reply : null)

    renderHook(() =>
      useAutoSpeakReplies({
        conversationActive: false,
        failureLabel: 'Speech failed',
        markSpoken,
        pendingReply,
        sessionId: 's1'
      })
    )

    reply = { id: 'streaming-1', pending: true, text: 'Partial' }
    act(() => $messages.set([]))
    expect(playSpeechText).not.toHaveBeenCalled()

    reply = { id: 'streaming-1', pending: false, text: 'Complete answer' }
    act(() => $messages.set([]))
    await waitFor(() => expect(playSpeechText).toHaveBeenCalledTimes(1))

    act(() => $messages.set([]))
    expect(playSpeechText).toHaveBeenCalledTimes(1)
  })

  it('collapses a standalone backlog to the latest terminal reply', async () => {
    $autoSpeakReplies.set(true)
    let reply: { id: string; pending: boolean; text: string } | null = null

    const markSpoken = vi.fn(() => {
      reply = null
    })

    renderHook(() =>
      useAutoSpeakReplies({
        conversationActive: false,
        failureLabel: 'Speech failed',
        markSpoken,
        pendingReply: () => reply,
        sessionId: 's1'
      })
    )

    setVoicePlaybackState({
      audioElement: null,
      messageId: 'playing',
      sequence: 1,
      source: 'read-aloud',
      status: 'speaking'
    })
    reply = { id: 'held-1', pending: false, text: 'Superseded answer' }
    act(() => $messages.set([]))
    reply = { id: 'held-2', pending: false, text: 'Latest answer' }
    act(() => $messages.set([]))
    expect(playSpeechText).not.toHaveBeenCalled()

    act(() =>
      setVoicePlaybackState({
        audioElement: null,
        messageId: null,
        sequence: 2,
        source: null,
        status: 'idle'
      })
    )

    await waitFor(() =>
      expect(playSpeechText).toHaveBeenCalledWith('Latest answer', {
        messageId: 'held-2',
        source: 'read-aloud'
      })
    )
  })

  it('consumes existing history again when the standalone session changes', () => {
    $autoSpeakReplies.set(true)

    let reply: { id: string; pending: boolean; text: string } | null = {
      id: 'history-s1',
      pending: false,
      text: 'First session history'
    }

    const markSpoken = vi.fn(() => {
      reply = null
    })

    const { rerender } = renderHook(
      ({ sessionId }) =>
        useAutoSpeakReplies({
          conversationActive: false,
          failureLabel: 'Speech failed',
          markSpoken,
          pendingReply: () => reply,
          sessionId
        }),
      { initialProps: { sessionId: 's1' } }
    )

    expect(markSpoken).toHaveBeenCalledTimes(1)
    reply = { id: 'history-s2', pending: false, text: 'Second session history' }
    rerender({ sessionId: 's2' })

    expect(markSpoken).toHaveBeenCalledTimes(2)
    expect(playSpeechText).not.toHaveBeenCalled()
  })

  it('tears down standalone auto-speak when Spoke activates', () => {
    $autoSpeakReplies.set(true)
    let reply: { id: string; pending: boolean; text: string } | null = null

    const markSpoken = vi.fn(() => {
      reply = null
    })

    const { rerender } = renderHook(
      ({ conversationActive }) =>
        useAutoSpeakReplies({
          conversationActive,
          failureLabel: 'Speech failed',
          markSpoken,
          pendingReply: () => reply,
          sessionId: 's1'
        }),
      { initialProps: { conversationActive: false } }
    )

    reply = { id: 'provider-reply', pending: false, text: 'Provider owns this audio' }
    rerender({ conversationActive: true })
    act(() => $messages.set([]))

    expect(playSpeechText).not.toHaveBeenCalled()
  })
})
