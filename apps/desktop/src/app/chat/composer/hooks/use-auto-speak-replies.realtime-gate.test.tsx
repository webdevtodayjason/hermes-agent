import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $realtimeAudioSessions, acquireRealtimeAudio } from '@/store/realtime-audio'
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
  $realtimeAudioSessions.set(0)
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

/**
 * RED-4: the composer's local conversation flag is not the only way a
 * Realtime session goes live. When any session holds global Realtime audio
 * ownership, standalone auto-speak must stay silent even though this
 * composer believes no conversation is active.
 */
describe('useAutoSpeakReplies under global Realtime audio ownership', () => {
  it('does not fire generic TTS while a non-composer Realtime session owns audio', async () => {
    $autoSpeakReplies.set(true)
    const release = acquireRealtimeAudio()

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

    reply = { id: 'canonical-reply', pending: false, text: 'Provider already spoke this' }
    act(() => $messages.set([]))

    await act(async () => {
      await Promise.resolve()
    })

    expect(playSpeechText).not.toHaveBeenCalled()

    release()
  })

  it('consumes provider-era replies on release, then narrates only new ones', async () => {
    $autoSpeakReplies.set(true)
    const release = acquireRealtimeAudio()

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

    // The provider already spoke this reply; it must never replay via TTS,
    // not even after the session releases ownership (same re-arm semantic
    // as Spoke deactivation: consume, don't read history).
    reply = { id: 'provider-era-reply', pending: false, text: 'Provider already spoke this' }
    act(() => $messages.set([]))
    expect(playSpeechText).not.toHaveBeenCalled()

    act(() => release())
    expect(playSpeechText).not.toHaveBeenCalled()

    reply = { id: 'post-release-reply', pending: false, text: 'Fresh standalone answer' }
    act(() => $messages.set([]))

    await waitFor(() =>
      expect(playSpeechText).toHaveBeenCalledWith('Fresh standalone answer', {
        messageId: 'post-release-reply',
        source: 'read-aloud'
      })
    )
  })

  it('blocks a playback-idle wakeup that races ownership acquisition', () => {
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

    reply = { id: 'race-reply', pending: false, text: 'Raced by a session start' }

    // Ownership lands and a store event fires before React re-renders the
    // hook: the synchronous guard inside the subscriber must hold the line.
    acquireRealtimeAudio()
    $messages.set([])

    expect(playSpeechText).not.toHaveBeenCalled()
  })
})
