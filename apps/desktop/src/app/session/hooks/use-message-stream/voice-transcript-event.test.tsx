import { QueryClient } from '@tanstack/react-query'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ClientSessionState } from '@/app/types'
import { chatMessageText } from '@/lib/chat-messages'
import { createClientSessionState } from '@/lib/chat-runtime'
import type { RpcEvent } from '@/types/hermes'

import { useMessageStream } from './index'

const SID = 'voice-session-1'
let handleEvent: ((event: RpcEvent) => void) | null = null

let onVoiceIntentTerminal = vi.fn<(result: {
  correlationId: string
  deliveryId: string
  providerSessionId: string
  sessionId: string
  text: string
}) => void>()
let onVoiceIntentProgress = vi.fn<(progress: {
  correlationId: string
  sessionId: string
  status: 'queued' | 'running' | 'approval_pending' | 'completed' | 'failed' | 'interrupted' | 'rejected'
}) => void>()

let states: Map<string, ClientSessionState>

function Harness() {
  const activeSessionIdRef = useRef<string | null>(SID)
  const sessionStateByRuntimeIdRef = useRef(states)
  const queryClientRef = useRef(new QueryClient())

  const stream = useMessageStream({
    activeSessionIdRef,
    hydrateFromStoredSession: vi.fn(async () => undefined),
    onVoiceIntentProgress,
    onVoiceIntentTerminal,
    queryClient: queryClientRef.current,
    refreshHermesConfig: vi.fn(async () => undefined),
    refreshSessions: vi.fn(async () => undefined),
    sessionStateByRuntimeIdRef,
    updateSessionState: (sessionId, updater) => {
      const current = states.get(sessionId) ?? createClientSessionState()
      const next = updater(current)
      states.set(sessionId, next)

      return next
    }
  })

  useEffect(() => {
    handleEvent = stream.handleGatewayEvent
  }, [stream.handleGatewayEvent])

  return null
}

function emit(payload: RpcEvent['payload']) {
  act(() => handleEvent!({ payload, session_id: SID, type: 'voice.transcript.final' }))
}

function emitTerminal(payload: RpcEvent['payload'], sessionId = SID) {
  act(() => handleEvent!({ payload, session_id: sessionId, type: 'voice.intent.terminal' }))
}

function emitProgress(payload: RpcEvent['payload'], sessionId = SID) {
  act(() => handleEvent!({ payload, session_id: sessionId, type: 'voice.intent.progress' }))
}

describe('Realtime voice transcript events', () => {
  beforeEach(() => {
    handleEvent = null
    onVoiceIntentProgress = vi.fn()
    onVoiceIntentTerminal = vi.fn()
    states = new Map([
      [
        SID,
        {
          ...createClientSessionState(),
          awaitingResponse: true,
          busy: true
        }
      ]
    ])
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('appends stable-ID transcript bubbles without settling an in-flight durable turn', async () => {
    render(<Harness />)
    await waitFor(() => expect(handleEvent).not.toBeNull())

    emit({ message_id: 'realtime:user-item-1:user', role: 'user', text: 'Keep working' })
    emit({ message_id: 'realtime:assistant-item-1:assistant', role: 'assistant', text: 'I am listening' })
    emit({ message_id: 'realtime:assistant-item-1:assistant', role: 'assistant', text: 'I am listening' })

    const state = states.get(SID)!
    expect(state.messages.map(message => [message.id, message.role, chatMessageText(message)])).toEqual([
      ['realtime:user-item-1:user', 'user', 'Keep working'],
      ['realtime:assistant-item-1:assistant', 'assistant', 'I am listening']
    ])
    expect(state.busy).toBe(true)
    expect(state.awaitingResponse).toBe(true)
  })

  it('routes only bounded correlation-scoped terminal narration payloads', async () => {
    render(<Harness />)
    await waitFor(() => expect(handleEvent).not.toBeNull())

    emitTerminal({
      correlation_id: 'call-terminal',
      delivery_id: 'delivery-terminal',
      provider_session_id: 'provider-terminal',
      status: 'completed',
      text: 'Canonical result'
    })
    emitTerminal({
      correlation_id: 'call-terminal',
      delivery_id: 'delivery-terminal',
      provider_session_id: 'provider-terminal',
      status: 'running',
      text: 'Premature'
    })
    emitTerminal({
      correlation_id: 'call-extra',
      delivery_id: 'delivery-extra',
      provider_session_id: 'provider-terminal',
      status: 'completed',
      text: 'x',
      history: ['secret']
    })

    expect(onVoiceIntentTerminal).toHaveBeenCalledOnce()
    expect(onVoiceIntentTerminal).toHaveBeenCalledWith({
      correlationId: 'call-terminal',
      deliveryId: 'delivery-terminal',
      providerSessionId: 'provider-terminal',
      sessionId: SID,
      text: 'Canonical result'
    })
  })

  it('routes only state-only bounded voice progress payloads', async () => {
    render(<Harness />)
    await waitFor(() => expect(handleEvent).not.toBeNull())

    emitProgress({ correlation_id: 'call-progress', status: 'queued' })
    emitProgress({ correlation_id: 'call-progress', status: 'running' })
    emitProgress({ correlation_id: 'call-progress', status: 'approval_pending' })
    emitProgress({
      correlation_id: 'call-leak',
      status: 'running',
      tool_arguments: { path: '/secret' }
    })
    emitProgress({ correlation_id: 'call-invalid', status: 'approving' })

    expect(onVoiceIntentProgress.mock.calls).toEqual([
      [{ correlationId: 'call-progress', sessionId: SID, status: 'queued' }],
      [{ correlationId: 'call-progress', sessionId: SID, status: 'running' }],
      [{ correlationId: 'call-progress', sessionId: SID, status: 'approval_pending' }]
    ])
  })
})
