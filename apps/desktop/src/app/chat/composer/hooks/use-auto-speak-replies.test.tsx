import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react'
import { startTransition, Suspense, useLayoutEffect } from 'react'
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
  it('keeps the committed subscriber active when a replacement render suspends', async () => {
    let firstReply: { id: string; pending: boolean; text: string } | null = null
    const replacementReply = { id: 'uncommitted', pending: false, text: 'Do not speak this' }
    const suspended = new Promise<void>(() => undefined)

    const markSpoken = vi.fn(() => {
      firstReply = null
    })

    const firstPendingReply = () => firstReply
    const replacementPendingReply = () => replacementReply

    function Harness({
      pendingReply,
      sessionId,
      shouldSuspend
    }: {
      pendingReply: () => { id: string; pending: boolean; text: string } | null
      sessionId: string
      shouldSuspend: boolean
    }) {
      useAutoSpeakReplies({
        conversationActive: true,
        failureLabel: 'Speech failed',
        markSpoken,
        pendingReply,
        sessionId
      })

      if (shouldSuspend) {
        throw suspended
      }

      return null
    }

    const view = render(
      <Suspense fallback={null}>
        <Harness
          pendingReply={firstPendingReply}
          sessionId="s1"
          shouldSuspend={false}
        />
      </Suspense>
    )

    firstReply = { id: 'committed', pending: false, text: 'Still committed' }
    act(() => {
      startTransition(() => {
        view.rerender(
          <Suspense fallback={null}>
            <Harness
              pendingReply={replacementPendingReply}
              sessionId="s2"
              shouldSuspend={true}
            />
          </Suspense>
        )
      })
    })
    act(() => $messages.set([]))

    await waitFor(() =>
      expect(playSpeechText).toHaveBeenCalledWith('Still committed', {
        messageId: 'committed',
        source: 'voice-conversation'
      })
    )
    expect(playSpeechText).not.toHaveBeenCalledWith(
      'Do not speak this',
      expect.anything()
    )
  })

  it('narrates a completed canonical reply during active Spoke even when standalone auto-speak is off', async () => {
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

    expect(markSpoken).toHaveBeenCalledTimes(1)
    expect(playSpeechText).not.toHaveBeenCalled()

    reply = { id: 'reply-1', pending: false, text: 'Canonical answer' }
    act(() => $messages.set([]))

    await waitFor(() =>
      expect(playSpeechText).toHaveBeenCalledWith('Canonical answer', {
        messageId: 'reply-1',
        source: 'voice-conversation'
      })
    )
    expect($autoSpeakReplies.get()).toBe(false)
  })

  it('uses read-aloud only for standalone auto-speak', async () => {
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

    reply = { id: 'reply-2', pending: false, text: 'Standalone answer' }
    act(() => $messages.set([]))

    await waitFor(() =>
      expect(playSpeechText).toHaveBeenCalledWith('Standalone answer', {
        messageId: 'reply-2',
        source: 'read-aloud'
      })
    )
  })

  it('waits for a canonical message to become terminal and speaks its ID at most once', async () => {
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
        conversationActive: true,
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

  it('holds only the latest terminal reply while playback is busy', async () => {
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

    setVoicePlaybackState({
      audioElement: null,
      messageId: 'playing',
      sequence: 1,
      source: 'voice-conversation',
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
        source: 'voice-conversation'
      })
    )
  })

  it('holds a terminal reply until active user speech stops', async () => {
    let reply: { id: string; pending: boolean; text: string } | null = null

    const markSpoken = vi.fn(() => {
      reply = null
    })

    const { rerender } = renderHook(
      ({ userSpeaking }) =>
        useAutoSpeakReplies({
          conversationActive: true,
          failureLabel: 'Speech failed',
          markSpoken,
          pendingReply: () => reply,
          sessionId: 's1',
          userSpeaking
        }),
      { initialProps: { userSpeaking: true } }
    )

    reply = { id: 'held-for-user', pending: false, text: 'Wait for the user' }
    act(() => $messages.set([]))
    expect(playSpeechText).not.toHaveBeenCalled()

    rerender({ userSpeaking: false })

    await waitFor(() =>
      expect(playSpeechText).toHaveBeenCalledWith('Wait for the user', {
        messageId: 'held-for-user',
        source: 'voice-conversation'
      })
    )
  })

  it('blocks a held reply on a synchronous playback-idle edge during manual or close teardown', () => {
    let reply: { id: string; pending: boolean; text: string } | null = null
    let narrationBlocked = false

    const markSpoken = vi.fn(() => {
      reply = null
    })

    renderHook(() =>
      useAutoSpeakReplies({
        conversationActive: true,
        failureLabel: 'Speech failed',
        isNarrationBlocked: () => narrationBlocked,
        markSpoken,
        pendingReply: () => reply,
        sessionId: 's1'
      })
    )
    markSpoken.mockClear()

    reply = { id: 'held-during-stop', pending: false, text: 'Do not restart output' }
    act(() => {
      setVoicePlaybackState({
        audioElement: null,
        messageId: 'playing',
        sequence: 1,
        source: 'voice-conversation',
        status: 'speaking'
      })
      $messages.set([])
    })

    act(() => {
      narrationBlocked = true
      setVoicePlaybackState({
        audioElement: null,
        messageId: null,
        sequence: 2,
        source: null,
        status: 'idle'
      })
    })

    expect(playSpeechText).not.toHaveBeenCalled()
    expect(markSpoken).not.toHaveBeenCalled()
  })

  it('does not start a held reply on the synchronous playback-idle edge of VAD barge-in', () => {
    let reply: { id: string; pending: boolean; text: string } | null = null
    let speakingNow = false

    const markSpoken = vi.fn(() => {
      reply = null
    })

    renderHook(() =>
      useAutoSpeakReplies({
        conversationActive: true,
        failureLabel: 'Speech failed',
        isUserSpeaking: () => speakingNow,
        markSpoken,
        pendingReply: () => reply,
        sessionId: 's1',
        userSpeaking: false
      })
    )
    markSpoken.mockClear()

    reply = { id: 'held-behind-clip', pending: false, text: 'Do not start yet' }
    act(() => {
      setVoicePlaybackState({
        audioElement: null,
        messageId: 'playing',
        sequence: 1,
        source: 'voice-conversation',
        status: 'speaking'
      })
      $messages.set([])
    })
    expect(playSpeechText).not.toHaveBeenCalled()

    act(() => {
      speakingNow = true
      setVoicePlaybackState({
        audioElement: null,
        messageId: null,
        sequence: 2,
        source: null,
        status: 'idle'
      })
    })

    expect(playSpeechText).not.toHaveBeenCalled()
    expect(markSpoken).not.toHaveBeenCalled()
  })

  it('does not consume a held Spoke reply when standalone auto-speak preference changes', async () => {
    let reply: { id: string; pending: boolean; text: string } | null = null

    const markSpoken = vi.fn(() => {
      reply = null
    })

    const { rerender } = renderHook(
      ({ userSpeaking }) =>
        useAutoSpeakReplies({
          conversationActive: true,
          failureLabel: 'Speech failed',
          markSpoken,
          pendingReply: () => reply,
          sessionId: 's1',
          userSpeaking
        }),
      { initialProps: { userSpeaking: true } }
    )

    markSpoken.mockClear()

    reply = { id: 'held-across-preference', pending: false, text: 'Keep this reply' }
    act(() => $messages.set([]))
    expect(playSpeechText).not.toHaveBeenCalled()

    act(() => $autoSpeakReplies.set(true))
    act(() => $autoSpeakReplies.set(false))

    expect(markSpoken).not.toHaveBeenCalled()
    rerender({ userSpeaking: false })

    await waitFor(() =>
      expect(playSpeechText).toHaveBeenCalledWith('Keep this reply', {
        messageId: 'held-across-preference',
        source: 'voice-conversation'
      })
    )
  })

  it('does not replay a marked reply after its clip is stopped', async () => {
    let reply: { id: string; pending: boolean; text: string } | null = null
    const spokenIds = new Set<string>()

    const markSpoken = vi.fn(() => {
      if (reply) {
        spokenIds.add(reply.id)
      }
    })

    renderHook(() =>
      useAutoSpeakReplies({
        conversationActive: true,
        failureLabel: 'Speech failed',
        markSpoken,
        pendingReply: () => (reply && !spokenIds.has(reply.id) ? reply : null),
        sessionId: 's1'
      })
    )

    reply = { id: 'cancelled-1', pending: false, text: 'Stop me' }
    act(() => $messages.set([]))
    await waitFor(() => expect(playSpeechText).toHaveBeenCalledTimes(1))

    act(() =>
      setVoicePlaybackState({
        audioElement: null,
        messageId: null,
        sequence: 4,
        source: null,
        status: 'idle'
      })
    )
    expect(playSpeechText).toHaveBeenCalledTimes(1)
  })

  it('blocks an old subscriber during the commit-to-cleanup window of a session switch', () => {
    let reply: { id: string; pending: boolean; text: string } | null = {
      id: 'history-s1',
      pending: false,
      text: 'First session history'
    }

    let transitionEmitted = false

    const markSpoken = vi.fn(() => {
      reply = null
    })

    const { rerender } = renderHook(
      ({ sessionId }) => {
        useAutoSpeakReplies({
          conversationActive: true,
          failureLabel: 'Speech failed',
          markSpoken,
          pendingReply: () => reply,
          sessionId
        })

        useLayoutEffect(() => {
          if (sessionId === 's2' && !transitionEmitted) {
            transitionEmitted = true
            $messages.set([])
          }
        }, [sessionId])
      },
      { initialProps: { sessionId: 's1' } }
    )

    reply = { id: 'history-s2', pending: false, text: 'Second session history' }
    rerender({ sessionId: 's2' })

    expect(playSpeechText).not.toHaveBeenCalled()
    expect(markSpoken).toHaveBeenCalledTimes(2)
  })

  it('blocks a standalone subscriber while Spoke activation consumes existing history', () => {
    $autoSpeakReplies.set(true)

    let reply: { id: string; pending: boolean; text: string } | null = {
      id: 'standalone-history',
      pending: false,
      text: 'Existing standalone history'
    }

    let transitionEmitted = false

    const markSpoken = vi.fn(() => {
      reply = null
    })

    const { rerender } = renderHook(
      ({ conversationActive }) => {
        useAutoSpeakReplies({
          conversationActive,
          failureLabel: 'Speech failed',
          markSpoken,
          pendingReply: () => reply,
          sessionId: 's1'
        })

        useLayoutEffect(() => {
          if (conversationActive && !transitionEmitted) {
            transitionEmitted = true
            $messages.set([])
          }
        }, [conversationActive])
      },
      { initialProps: { conversationActive: false } }
    )

    reply = { id: 'spoke-history', pending: false, text: 'Existing Spoke history' }
    rerender({ conversationActive: true })

    expect(playSpeechText).not.toHaveBeenCalled()
    expect(markSpoken).toHaveBeenCalledTimes(2)
  })

  it('consumes existing history when Spoke activates and when the session switches', () => {
    let reply: { id: string; pending: boolean; text: string } | null = {
      id: 'history-1',
      pending: false,
      text: 'Existing history'
    }

    const markSpoken = vi.fn(() => {
      reply = null
    })

    const { rerender } = renderHook(
      ({ conversationActive, sessionId }) =>
        useAutoSpeakReplies({
          conversationActive,
          failureLabel: 'Speech failed',
          markSpoken,
          pendingReply: () => reply,
          sessionId
        }),
      { initialProps: { conversationActive: false, sessionId: 's1' } }
    )

    rerender({ conversationActive: true, sessionId: 's1' })
    expect(markSpoken).toHaveBeenCalledTimes(1)
    expect(playSpeechText).not.toHaveBeenCalled()

    reply = { id: 'history-2', pending: false, text: 'Other chat history' }
    rerender({ conversationActive: true, sessionId: 's2' })
    expect(markSpoken).toHaveBeenCalledTimes(2)
    expect(playSpeechText).not.toHaveBeenCalled()
  })
})
