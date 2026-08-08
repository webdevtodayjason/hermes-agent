import { describe, expect, it, vi } from 'vitest'

import {
  createBrowserRealtimeVoiceDependencies,
  createRealtimeTranscriptAppender,
  createRealtimeVoiceClient,
  type RealtimeCanonicalResult,
  type RealtimeCanonicalResultStage
} from './realtime-voice-client'

function eventChannel() {
  const listeners = new Map<string, Array<(event: { data: string }) => void>>()

  return {
    readyState: 'open',
    close: vi.fn(),
    send: vi.fn(),
    addEventListener: vi.fn((type: string, listener: (event: { data: string }) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener])
    }),
    emit(type: string, payload: unknown) {
      for (const listener of listeners.get(type) ?? []) {listener({ data: JSON.stringify(payload) })}
    },
    emitRaw(type: string, data: string) {
      for (const listener of listeners.get(type) ?? []) {listener({ data })}
    }
  }
}

describe('createRealtimeVoiceClient', () => {
  it('streams cumulative user caption deltas without changing finalized transcript delivery', async () => {
    const track = { enabled: true, stop: vi.fn() }
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] }
    const channel = eventChannel()
    const captions: Array<[string, string]> = []
    const finals: Array<[string, string]> = []

    const client = createRealtimeVoiceClient({
      sessionId: 'conversation-captions',
      onUserTranscriptDelta: (text, itemId) => {
        captions.push([text, itemId])

        if (text === 'Hello world.') {
          throw new Error('caption observer failed')
        }
      },
      onUserTranscript: (text, itemId) => finals.push([text, itemId]),
      dependencies: {
        createAudio: () => ({
          autoplay: false,
          srcObject: null,
          pause: vi.fn(),
          play: vi.fn(async () => undefined)
        }),
        createPeerConnection: () => ({
          addTrack: vi.fn(),
          close: vi.fn(),
          createDataChannel: () => channel,
          createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'offer' })),
          setLocalDescription: vi.fn(async () => undefined),
          setRemoteDescription: vi.fn(async () => undefined),
          ontrack: null
        }),
        exchangeSdp: vi.fn(async () => 'answer'),
        getUserMedia: vi.fn(async () => stream),
        mintSession: vi.fn(async () => ({
          clientSecret: 'ek_ephemeral',
          model: 'gpt-realtime-2.1',
          ownerSessionId: 'conversation-captions',
          sessionId: 'stored-captions'
        }))
      }
    })

    await client.start()
    channel.emit('message', {
      type: 'conversation.item.created',
      item: { id: 'user-caption-1', role: 'user' },
      previous_item_id: null
    })
    channel.emit('message', {
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'user-caption-1',
      delta: 'Hello'
    })
    channel.emit('message', {
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'user-caption-1',
      delta: ' world'
    })

    expect(captions).toEqual([
      ['Hello', 'user-caption-1'],
      ['Hello world', 'user-caption-1']
    ])
    expect(finals).toEqual([])

    channel.emit('message', {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'user-caption-1',
      transcript: 'Hello world.'
    })

    expect(captions.at(-1)).toEqual(['Hello world.', 'user-caption-1'])
    expect(finals).toEqual([['Hello world.', 'user-caption-1']])

    channel.emit('message', {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'user-caption-1',
      transcript: 'Duplicate final.'
    })
    expect(captions.at(-1)).toEqual(['Hello world.', 'user-caption-1'])
    expect(finals).toEqual([['Hello world.', 'user-caption-1']])

    channel.emit('message', {
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'user-caption-1',
      delta: 'Late fragment'
    })
    expect(captions.at(-1)).toEqual(['Hello world.', 'user-caption-1'])

    channel.emit('message', {
      type: 'conversation.item.created',
      item: { id: 'user-empty-final', role: 'user' },
      previous_item_id: 'user-caption-1'
    })
    channel.emit('message', {
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'user-empty-final',
      delta: 'Unconfirmed partial'
    })
    channel.emit('message', {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'user-empty-final',
      transcript: ''
    })
    expect(captions.at(-1)).toEqual(['', 'user-empty-final'])
    expect(finals).toEqual([['Hello world.', 'user-caption-1']])

    await client.end()
  })

  it('does not let an older transcription item overwrite captions for a newer turn', async () => {
    const track = { enabled: true, stop: vi.fn() }
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] }
    const channel = eventChannel()
    const captions: Array<[string, string]> = []
    const finals: Array<[string, string]> = []

    const client = createRealtimeVoiceClient({
      sessionId: 'conversation-caption-order',
      onUserTranscriptDelta: (text, itemId) => captions.push([text, itemId]),
      onUserTranscript: (text, itemId) => finals.push([text, itemId]),
      dependencies: {
        createAudio: () => ({ autoplay: false, srcObject: null, pause: vi.fn(), play: vi.fn(async () => undefined) }),
        createPeerConnection: () => ({
          addTrack: vi.fn(),
          close: vi.fn(),
          createDataChannel: () => channel,
          createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'offer' })),
          setLocalDescription: vi.fn(async () => undefined),
          setRemoteDescription: vi.fn(async () => undefined),
          ontrack: null
        }),
        exchangeSdp: vi.fn(async () => 'answer'),
        getUserMedia: vi.fn(async () => stream),
        mintSession: vi.fn(async () => ({
          clientSecret: 'ek_ephemeral',
          model: 'gpt-realtime-2.1',
          ownerSessionId: 'conversation-caption-order',
          sessionId: 'stored-caption-order'
        }))
      }
    })

    await client.start()
    channel.emit('message', {
      type: 'conversation.item.created',
      item: { id: 'user-old', role: 'user' },
      previous_item_id: null
    })
    channel.emit('message', {
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'user-old',
      delta: 'Old partial'
    })
    channel.emit('message', { type: 'input_audio_buffer.speech_started' })
    channel.emit('message', {
      type: 'conversation.item.created',
      item: { id: 'user-new', role: 'user' },
      previous_item_id: 'user-old'
    })
    channel.emit('message', {
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'user-new',
      delta: 'New partial'
    })
    channel.emit('message', {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'user-old',
      transcript: 'Old final.'
    })

    expect(captions.at(-1)).toEqual(['New partial', 'user-new'])
    expect(finals).toEqual([['Old final.', 'user-old']])

    channel.emit('message', {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'user-new',
      transcript: 'New final.'
    })
    expect(captions.at(-1)).toEqual(['New final.', 'user-new'])
    expect(finals).toEqual([
      ['Old final.', 'user-old'],
      ['New final.', 'user-new']
    ])

    channel.emit('message', {
      type: 'conversation.item.created',
      item: { id: 'user-no-caption', role: 'user' },
      previous_item_id: 'user-new'
    })
    channel.emit('message', { type: 'input_audio_buffer.speech_started' })
    channel.emit('message', {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'user-no-caption',
      transcript: 'Delayed prior final.'
    })
    expect(captions.at(-1)).toEqual(['New final.', 'user-new'])
    expect(finals.at(-1)).toEqual(['Delayed prior final.', 'user-no-caption'])

    await client.end()
  })

  it('stops canonical completion when a caption observer retires the active attempt', async () => {
    const track = { enabled: true, stop: vi.fn() }
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] }
    const channel = eventChannel()
    const onUserTranscript = vi.fn()
    let ending: Promise<void> | undefined
    let client!: ReturnType<typeof createRealtimeVoiceClient>

    client = createRealtimeVoiceClient({
      sessionId: 'conversation-caption-reentrancy',
      onUserTranscriptDelta: text => {
        if (text === 'Final caption.') {
          ending = client.end()
        }
      },
      onUserTranscript,
      dependencies: {
        createAudio: () => ({ autoplay: false, srcObject: null, pause: vi.fn(), play: vi.fn(async () => undefined) }),
        createPeerConnection: () => ({
          addTrack: vi.fn(),
          close: vi.fn(),
          createDataChannel: () => channel,
          createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'offer' })),
          setLocalDescription: vi.fn(async () => undefined),
          setRemoteDescription: vi.fn(async () => undefined),
          ontrack: null
        }),
        exchangeSdp: vi.fn(async () => 'answer'),
        getUserMedia: vi.fn(async () => stream),
        mintSession: vi.fn(async () => ({
          clientSecret: 'ek_ephemeral',
          model: 'gpt-realtime-2.1',
          ownerSessionId: 'conversation-caption-reentrancy',
          sessionId: 'stored-caption-reentrancy'
        }))
      }
    })

    await client.start()
    channel.emit('message', {
      type: 'conversation.item.created',
      item: { id: 'user-reentrant', role: 'user' },
      previous_item_id: null
    })
    channel.emit('message', {
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'user-reentrant',
      delta: 'Partial caption'
    })
    channel.emit('message', {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'user-reentrant',
      transcript: 'Final caption.'
    })

    await ending
    await Promise.resolve()
    expect(onUserTranscript).not.toHaveBeenCalled()
  })

  it('dispatches only the bounded Hermes function and holds the call open for its result', async () => {
    const track = { enabled: true, stop: vi.fn() }
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] }
    const channel = eventChannel()

    const onIntentDispatch = vi.fn(async () => ({
      correlationId: 'call-dispatch',
      status: 'queued' as const
    }))

    const client = createRealtimeVoiceClient({
      sessionId: 'conversation-dispatch',
      onIntentDispatch,
      dependencies: {
        createAudio: () => ({ autoplay: false, srcObject: null, pause: vi.fn(), play: vi.fn(async () => undefined) }),
        createPeerConnection: () => ({
          addTrack: vi.fn(),
          close: vi.fn(),
          createDataChannel: () => channel,
          createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'offer' })),
          setLocalDescription: vi.fn(async () => undefined),
          setRemoteDescription: vi.fn(async () => undefined),
          ontrack: null
        }),
        exchangeSdp: vi.fn(async () => 'answer'),
        getUserMedia: vi.fn(async () => stream),
        mintSession: vi.fn(async () => ({
          clientSecret: 'ek_ephemeral',
          model: 'gpt-realtime-2.1',
          ownerSessionId: 'conversation-dispatch',
          providerSessionId: 'provider-dispatch',
          sessionId: 'stored-dispatch'
        }))
      }
    })

    await client.start()
    channel.emit('message', {
      type: 'response.function_call_arguments.done',
      name: 'perform_internal_work',
      call_id: 'call-dispatch',
      item_id: 'item-dispatch',
      arguments: JSON.stringify({ intent: 'Run the focused verification suite' })
    })
    await vi.waitFor(() => expect(onIntentDispatch).toHaveBeenCalledOnce())

    expect(onIntentDispatch).toHaveBeenCalledWith(
      'Run the focused verification suite',
      'call-dispatch',
      'item-dispatch'
    )
    // A queued dispatch holds the tool call OPEN awaiting its canonical result;
    // no immediate settle and no acknowledgement response may be created.
    expect(channel.send).not.toHaveBeenCalledWith(expect.stringContaining('function_call_output'))
    expect(channel.send).not.toHaveBeenCalledWith(expect.stringContaining('hermes-dispatch-call-dispatch'))

    await client.end()
  })

  it('cancels and suppresses a stale dispatch acknowledgement when canonical work completes', async () => {
    const track = { enabled: true, stop: vi.fn() }
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] }
    const channel = eventChannel()
    const onAssistantTranscript = vi.fn()
    const client = createRealtimeVoiceClient({
      sessionId: 'conversation-stale-ack',
      dispatchResultTimeoutMs: 30,
      onAssistantTranscript,
      onIntentDispatch: vi.fn(async () => ({ correlationId: 'call-stale-ack', status: 'queued' as const })),
      dependencies: {
        createAudio: () => ({ autoplay: false, srcObject: null, pause: vi.fn(), play: vi.fn(async () => undefined) }),
        createPeerConnection: () => ({
          addTrack: vi.fn(), close: vi.fn(), createDataChannel: () => channel,
          createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'offer' })),
          setLocalDescription: vi.fn(async () => undefined),
          setRemoteDescription: vi.fn(async () => undefined), ontrack: null
        }),
        exchangeSdp: vi.fn(async () => 'answer'),
        getUserMedia: vi.fn(async () => stream),
        mintSession: vi.fn(async () => ({
          clientSecret: 'ek_ephemeral', model: 'gpt-realtime-2.1',
          ownerSessionId: 'conversation-stale-ack', providerSessionId: 'provider-stale-ack',
          sessionId: 'stored-stale-ack'
        }))
      }
    })

    await client.start()
    channel.emit('message', {
      type: 'response.function_call_arguments.done', name: 'perform_internal_work',
      call_id: 'call-stale-ack', item_id: 'item-stale-ack',
      arguments: JSON.stringify({ intent: 'Inspect the repository' })
    })
    await vi.waitFor(() => expect(channel.send).toHaveBeenCalledWith(expect.stringContaining('hermes-dispatch-call-stale-ack')))
    channel.emit('message', {
      type: 'response.created',
      response: {
        id: 'response-stale-ack',
        metadata: {
          hermes_voice_response_kind: 'dispatch',
          hermes_voice_response_key: 'call-stale-ack'
        }
      }
    })
    channel.send.mockClear()

    client.narrateCanonicalResult({
      correlationId: 'call-stale-ack', deliveryId: 'delivery-stale-ack',
      providerSessionId: 'provider-stale-ack', text: 'The repository is clean.'
    })

    expect(channel.send).toHaveBeenCalledWith(JSON.stringify({ type: 'response.cancel' }))
    expect(channel.send).toHaveBeenCalledWith(JSON.stringify({ type: 'output_audio_buffer.clear' }))

    channel.emit('message', {
      type: 'conversation.item.created',
      item: { id: 'assistant-stale-ack', role: 'assistant' }, previous_item_id: 'item-stale-ack'
    })
    channel.emit('message', {
      type: 'response.output_audio_transcript.done', item_id: 'assistant-stale-ack',
      transcript: 'I am still waiting.'
    })
    expect(onAssistantTranscript).not.toHaveBeenCalled()
    await client.end()
  })

  it('does not let a stale terminal drain a newer bound status response', async () => {
    const track = { enabled: true, stop: vi.fn() }
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] }
    const channel = eventChannel()
    const client = createRealtimeVoiceClient({
      sessionId: 'conversation-status-binding',
      dependencies: {
        createAudio: () => ({ autoplay: false, srcObject: null, pause: vi.fn(), play: vi.fn(async () => undefined) }),
        createPeerConnection: () => ({
          addTrack: vi.fn(), close: vi.fn(), createDataChannel: () => channel,
          createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'offer' })),
          setLocalDescription: vi.fn(async () => undefined),
          setRemoteDescription: vi.fn(async () => undefined), ontrack: null
        }),
        exchangeSdp: vi.fn(async () => 'answer'),
        getUserMedia: vi.fn(async () => stream),
        mintSession: vi.fn(async () => ({
          clientSecret: 'ek_ephemeral', model: 'gpt-realtime-2.1',
          ownerSessionId: 'conversation-status-binding', providerSessionId: 'provider-status-binding',
          sessionId: 'stored-status-binding'
        }))
      }
    })

    await client.start()
    expect(client.announceCanonicalProgress({
      correlationId: 'call-status-binding',
      status: 'approval_pending'
    })).toBe(true)
    channel.emit('message', {
      type: 'response.created',
      response: {
        id: 'response-status-current',
        metadata: {
          hermes_voice_response_kind: 'status',
          hermes_voice_response_key: 'progress-call-status-binding-approval-pending'
        }
      }
    })
    expect(client.narrateCanonicalResult({
      correlationId: 'call-after-status', deliveryId: 'delivery-after-status',
      providerSessionId: 'provider-status-binding', text: 'Verified after status.'
    })).toBe(true)

    channel.emit('message', {
      type: 'response.failed',
      response: { id: 'response-stale-failed' }
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(channel.send).not.toHaveBeenCalledWith(expect.stringContaining('evie-result-call-after-status'))

    channel.emit('message', {
      type: 'response.done',
      response: { id: 'response-stale-older', status: 'completed' }
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(channel.send).not.toHaveBeenCalledWith(expect.stringContaining('evie-result-call-after-status'))

    channel.emit('message', {
      type: 'response.done',
      response: { id: 'response-status-current', status: 'completed' }
    })
    await vi.waitFor(() => expect(channel.send).toHaveBeenCalledWith(expect.stringContaining('evie-result-call-after-status')))
    await client.end()
  })

  it('releases a queued canonical result only for the owning status create rejection', async () => {
    const track = { enabled: true, stop: vi.fn() }
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] }
    const channel = eventChannel()
    const client = createRealtimeVoiceClient({
      sessionId: 'conversation-status-rejection',
      dependencies: {
        createAudio: () => ({ autoplay: false, srcObject: null, pause: vi.fn(), play: vi.fn(async () => undefined) }),
        createPeerConnection: () => ({
          addTrack: vi.fn(), close: vi.fn(), createDataChannel: () => channel,
          createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'offer' })),
          setLocalDescription: vi.fn(async () => undefined),
          setRemoteDescription: vi.fn(async () => undefined), ontrack: null
        }),
        exchangeSdp: vi.fn(async () => 'answer'),
        getUserMedia: vi.fn(async () => stream),
        mintSession: vi.fn(async () => ({
          clientSecret: 'ek_ephemeral', model: 'gpt-realtime-2.1',
          ownerSessionId: 'conversation-status-rejection', providerSessionId: 'provider-status-rejection',
          sessionId: 'stored-status-rejection'
        }))
      }
    })

    await client.start()
    expect(client.announceCanonicalProgress({
      correlationId: 'call-status-rejection', status: 'approval_pending'
    })).toBe(true)
    expect(client.narrateCanonicalResult({
      correlationId: 'call-after-status-rejection', deliveryId: 'delivery-after-status-rejection',
      providerSessionId: 'provider-status-rejection', text: 'Verified after rejected status.'
    })).toBe(true)

    channel.emit('message', {
      type: 'error', error: { event_id: 'hermes-status-unrelated' }
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(channel.send).not.toHaveBeenCalledWith(expect.stringContaining('evie-result-call-after-status-rejection'))

    channel.emit('message', {
      type: 'error',
      error: { event_id: 'hermes-status-progress-call-status-rejection-approval-pending' }
    })
    await vi.waitFor(() => expect(channel.send).toHaveBeenCalledWith(
      expect.stringContaining('evie-result-call-after-status-rejection')
    ))
    await client.end()
  })

  it('serializes canonical terminal narration without recursive dispatch or transcript duplication', async () => {
    const track = { enabled: true, stop: vi.fn() }
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] }
    const channel = eventChannel()
    const onAssistantTranscript = vi.fn()
    const observedStages: Array<[RealtimeCanonicalResult, RealtimeCanonicalResultStage]> = []

    const onCanonicalResultStage = vi.fn(async (
      result: RealtimeCanonicalResult,
      stage: RealtimeCanonicalResultStage
    ) => {observedStages.push([result, stage])})

    const onIntentDispatch = vi.fn(async () => ({
      correlationId: 'recursive-call',
      status: 'queued' as const
    }))

    const client = createRealtimeVoiceClient({
      sessionId: 'conversation-terminal',
      onAssistantTranscript,
      onCanonicalResultStage,
      onIntentDispatch,
      dependencies: {
        createAudio: () => ({ autoplay: false, srcObject: null, pause: vi.fn(), play: vi.fn(async () => undefined) }),
        createPeerConnection: () => ({
          addTrack: vi.fn(),
          close: vi.fn(),
          createDataChannel: () => channel,
          createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'offer' })),
          setLocalDescription: vi.fn(async () => undefined),
          setRemoteDescription: vi.fn(async () => undefined),
          ontrack: null
        }),
        exchangeSdp: vi.fn(async () => 'answer'),
        getUserMedia: vi.fn(async () => stream),
        mintSession: vi.fn(async () => ({
          clientSecret: 'ek_ephemeral',
          model: 'gpt-realtime-2.1',
          ownerSessionId: 'conversation-terminal',
          providerSessionId: 'provider-terminal',
          sessionId: 'stored-terminal'
        }))
      }
    })

    await client.start()

    const firstResult = {
      correlationId: 'call-terminal',
      deliveryId: 'delivery-terminal',
      providerSessionId: 'provider-terminal',
      text: 'The verification passed.'
    }

    expect(client.narrateCanonicalResult(firstResult)).toBe(true)
    expect(client.narrateCanonicalResult({
      ...firstResult,
      text: 'Duplicate must not be spoken.'
    })).toBe(false)
    expect(client.narrateCanonicalResult({
      correlationId: 'call-second',
      deliveryId: 'delivery-second',
      providerSessionId: 'provider-terminal',
      text: 'The second verification passed.'
    })).toBe(true)

    await vi.waitFor(() => expect(onCanonicalResultStage).toHaveBeenCalledTimes(2))
    expect(observedStages.filter(([result]) => (
      result.correlationId === firstResult.correlationId
    )).map(([, stage]) => stage)).toEqual(['consumed'])
    expect(onCanonicalResultStage).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: 'call-second' }),
      'consumed'
    )

    expect(channel.send).toHaveBeenCalledTimes(2)
    expect(channel.send).toHaveBeenNthCalledWith(1, JSON.stringify({
      type: 'conversation.item.create',
      item: {
        id: 'evie-result-call-terminal-delivery-terminal',
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'Verified result from your internal work:\nThe verification passed.'
          }
        ]
      }
    }))
    expect(channel.send).toHaveBeenNthCalledWith(2, JSON.stringify({
      event_id: 'hermes-narration-delivery-terminal',
      type: 'response.create',
      response: {
        instructions: 'State this verified result once, faithfully and briefly, in your normal first-person voice as Evie. Do not call tools or start more work.',
        metadata: {
          hermes_voice_delivery_id: 'delivery-terminal'
        },
        tool_choice: 'none'
      }
    }))

    channel.emit('message', {
      type: 'response.created',
      response: {
        id: 'response-terminal',
        metadata: { hermes_voice_delivery_id: 'delivery-terminal' }
      }
    })
    channel.emit('message', {
      type: 'response.function_call_arguments.done',
      name: 'perform_internal_work',
      call_id: 'recursive-call',
      item_id: 'recursive-item',
      arguments: JSON.stringify({ intent: 'Do not recurse' })
    })
    channel.emit('message', {
      type: 'conversation.item.created',
      item: { id: 'assistant-terminal', role: 'assistant' },
      previous_item_id: null
    })
    channel.emit('message', {
      type: 'response.output_audio_transcript.done',
      item_id: 'assistant-terminal',
      transcript: 'The verification passed.'
    })
    channel.emit('message', { type: 'response.done', response: { id: 'response-terminal' } })

    await vi.waitFor(() => expect(onCanonicalResultStage).toHaveBeenCalledTimes(4))
    expect(observedStages.filter(([result]) => (
      result.correlationId === firstResult.correlationId
    )).map(([, stage]) => stage)).toEqual([
      'consumed',
      'narration_started',
      'narration_completed'
    ])
    expect(onCanonicalResultStage).not.toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: 'call-second' }),
      'narration_started'
    )

    expect(onIntentDispatch).not.toHaveBeenCalled()
    expect(onAssistantTranscript).not.toHaveBeenCalled()
    expect(channel.send).toHaveBeenCalledTimes(4)
    expect(channel.send).toHaveBeenNthCalledWith(3, JSON.stringify({
      type: 'conversation.item.create',
      item: {
        id: 'evie-result-call-second-delivery-second',
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'Verified result from your internal work:\nThe second verification passed.'
          }
        ]
      }
    }))

    channel.emit('message', { type: 'input_audio_buffer.speech_started' })
    channel.emit('message', {
      type: 'response.done',
      response: { id: 'response-second', status: 'cancelled' }
    })

    await vi.waitFor(() => expect(onCanonicalResultStage).toHaveBeenCalledTimes(5))
    expect(observedStages.filter(([result]) => (
      result.correlationId === 'call-second'
    )).map(([, stage]) => stage)).toEqual([
      'consumed',
      'narration_interrupted'
    ])

    await client.end()
  })

  it('completes canonical narration only for its bound provider response id', async () => {
    const track = { enabled: true, stop: vi.fn() }
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] }
    const channel = eventChannel()
    const observedStages: RealtimeCanonicalResultStage[] = []
    const client = createRealtimeVoiceClient({
      sessionId: 'conversation-response-binding',
      onCanonicalResultStage: async (_result, stage) => { observedStages.push(stage) },
      dependencies: {
        createAudio: () => ({ autoplay: false, srcObject: null, pause: vi.fn(), play: vi.fn(async () => undefined) }),
        createPeerConnection: () => ({
          addTrack: vi.fn(), close: vi.fn(), createDataChannel: () => channel,
          createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'offer' })),
          setLocalDescription: vi.fn(async () => undefined),
          setRemoteDescription: vi.fn(async () => undefined), ontrack: null
        }),
        exchangeSdp: vi.fn(async () => 'answer'),
        getUserMedia: vi.fn(async () => stream),
        mintSession: vi.fn(async () => ({
          clientSecret: 'ek_ephemeral', model: 'gpt-realtime-2.1',
          ownerSessionId: 'conversation-response-binding', providerSessionId: 'provider-binding',
          sessionId: 'stored-response-binding'
        }))
      }
    })

    await client.start()
    client.narrateCanonicalResult({
      correlationId: 'call-binding', deliveryId: 'delivery-binding',
      providerSessionId: 'provider-binding', text: 'The verified result.'
    })
    await vi.waitFor(() => expect(observedStages).toEqual(['consumed']))

    channel.emit('message', { type: 'response.done', response: { id: 'response-before-binding', status: 'completed' } })
    channel.emit('message', { type: 'response.failed', response: { id: 'response-failed-before-binding' } })
    channel.emit('message', { type: 'error', error: { message: 'unscoped stale provider error' } })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(observedStages).toEqual(['consumed'])

    channel.emit('message', {
      type: 'response.created',
      response: {
        id: 'response-stale-created-first',
        metadata: { hermes_voice_delivery_id: 'delivery-unrelated' }
      }
    })
    channel.emit('message', {
      type: 'response.done',
      response: { id: 'response-stale-created-first', status: 'completed' }
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(observedStages).toEqual(['consumed'])

    channel.emit('message', {
      type: 'response.created',
      response: {
        id: 'response-narration',
        metadata: { hermes_voice_delivery_id: 'delivery-binding' }
      }
    })
    await vi.waitFor(() => expect(observedStages).toEqual(['consumed', 'narration_started']))
    channel.emit('message', {
      type: 'response.created',
      response: {
        id: 'response-unrelated-later',
        metadata: { hermes_voice_delivery_id: 'delivery-unrelated-later' }
      }
    })

    channel.emit('message', { type: 'response.failed', response: { id: 'response-stale-failure' } })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(observedStages).toEqual(['consumed', 'narration_started'])

    channel.emit('message', { type: 'response.done', response: { id: 'response-stale-ack', status: 'completed' } })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(observedStages).not.toContain('narration_completed')

    channel.emit('message', { type: 'response.done', response: { id: 'response-narration', status: 'completed' } })
    await vi.waitFor(() => expect(observedStages).toContain('narration_completed'))
    await client.end()
  })

  it('fails and releases narration when its response create is rejected before binding', async () => {
    const track = { enabled: true, stop: vi.fn() }
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] }
    const channel = eventChannel()
    const observedStages: RealtimeCanonicalResultStage[] = []
    const onCanonicalResultStage = vi.fn(async (
      _result: RealtimeCanonicalResult,
      stage: RealtimeCanonicalResultStage
    ) => {
      observedStages.push(stage)
      return stage === 'narration_failed' ? [] : undefined
    })
    const client = createRealtimeVoiceClient({
      sessionId: 'conversation-create-rejected',
      onCanonicalResultStage,
      dependencies: {
        createAudio: () => ({ autoplay: false, srcObject: null, pause: vi.fn(), play: vi.fn(async () => undefined) }),
        createPeerConnection: () => ({
          addTrack: vi.fn(), close: vi.fn(), createDataChannel: () => channel,
          createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'offer' })),
          setLocalDescription: vi.fn(async () => undefined),
          setRemoteDescription: vi.fn(async () => undefined), ontrack: null
        }),
        exchangeSdp: vi.fn(async () => 'answer'),
        getUserMedia: vi.fn(async () => stream),
        mintSession: vi.fn(async () => ({
          clientSecret: 'ek_ephemeral', model: 'gpt-realtime-2.1',
          ownerSessionId: 'conversation-create-rejected', providerSessionId: 'provider-create-rejected',
          sessionId: 'stored-create-rejected'
        }))
      }
    })

    await client.start()
    expect(client.narrateCanonicalResult({
      correlationId: 'call-create-rejected', deliveryId: 'delivery-create-rejected',
      providerSessionId: 'provider-create-rejected', text: 'Verified result.'
    })).toBe(true)
    await vi.waitFor(() => expect(observedStages).toEqual(['consumed']))
    channel.emit('message', {
      type: 'error',
      error: {
        event_id: 'hermes-narration-delivery-create-rejected',
        message: 'A response is already active.'
      }
    })

    await vi.waitFor(() => expect(observedStages).toContain('narration_failed'))
    await vi.waitFor(() => expect(channel.send).toHaveBeenCalledWith(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        id: 'evie-status-narration-failed-call-create-rejected',
        type: 'message',
        role: 'user',
        content: [{
          type: 'input_text',
          text: 'Private status update: I could not read that result aloud. It is still in the chat.'
        }]
      }
    })))
    await client.end()
  })

  it('times out narration ownership when no matching response is ever created', async () => {
    vi.useFakeTimers()

    try {
      const track = { enabled: true, stop: vi.fn() }
      const stream = { getTracks: () => [track], getAudioTracks: () => [track] }
      const channel = eventChannel()
      const observedStages: RealtimeCanonicalResultStage[] = []
      const client = createRealtimeVoiceClient({
        sessionId: 'conversation-binding-timeout',
        onCanonicalResultStage: async (_result, stage) => {
          observedStages.push(stage)
          return stage === 'narration_failed' ? [] : undefined
        },
        dependencies: {
          createAudio: () => ({ autoplay: false, srcObject: null, pause: vi.fn(), play: vi.fn(async () => undefined) }),
          createPeerConnection: () => ({
            addTrack: vi.fn(), close: vi.fn(), createDataChannel: () => channel,
            createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'offer' })),
            setLocalDescription: vi.fn(async () => undefined),
            setRemoteDescription: vi.fn(async () => undefined), ontrack: null
          }),
          exchangeSdp: vi.fn(async () => 'answer'),
          getUserMedia: vi.fn(async () => stream),
          mintSession: vi.fn(async () => ({
            clientSecret: 'ek_ephemeral', model: 'gpt-realtime-2.1',
            ownerSessionId: 'conversation-binding-timeout', providerSessionId: 'provider-binding-timeout',
            sessionId: 'stored-binding-timeout'
          }))
        }
      })

      await client.start()
      expect(client.narrateCanonicalResult({
        correlationId: 'call-binding-timeout', deliveryId: 'delivery-binding-timeout',
        providerSessionId: 'provider-binding-timeout', text: 'Verified timeout result.'
      })).toBe(true)
      await vi.advanceTimersByTimeAsync(0)
      expect(observedStages).toEqual(['consumed'])

      channel.emit('message', {
        type: 'response.created',
        response: { id: 'response-missing-ownership', metadata: null }
      })
      await vi.advanceTimersByTimeAsync(10_000)
      expect(observedStages).toContain('narration_failed')
      expect(observedStages).not.toContain('narration_started')
      expect(channel.send).not.toHaveBeenCalledWith(expect.stringContaining('evie-status-narration-failed'))

      channel.emit('message', {
        type: 'response.done',
        response: { id: 'response-missing-ownership', status: 'completed' }
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(channel.send).toHaveBeenCalledWith(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          id: 'evie-status-narration-failed-call-binding-timeout',
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: 'Private status update: I could not read that result aloud. It is still in the chat.'
          }]
        }
      }))
      await client.end()
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries a failed narration in the same session without redispatching canonical work', async () => {
    const track = { enabled: true, stop: vi.fn() }
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] }
    const channel = eventChannel()
    const onIntentDispatch = vi.fn()

    const retried = {
      correlationId: 'call-retry',
      deliveryId: 'delivery-retry-2',
      providerSessionId: 'provider-retry',
      text: 'Verified result after retry.'
    }

    const observedStages: RealtimeCanonicalResultStage[] = []

    const onCanonicalResultStage = vi.fn(async (
      _result: RealtimeCanonicalResult,
      stage: RealtimeCanonicalResultStage
    ) => {
      observedStages.push(stage)

      return stage === 'narration_failed' ? [retried] : undefined
    })

    const client = createRealtimeVoiceClient({
      sessionId: 'conversation-retry',
      onCanonicalResultStage,
      onIntentDispatch,
      dependencies: {
        createAudio: () => ({ autoplay: false, srcObject: null, pause: vi.fn(), play: vi.fn(async () => undefined) }),
        createPeerConnection: () => ({
          addTrack: vi.fn(),
          close: vi.fn(),
          createDataChannel: () => channel,
          createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'offer' })),
          setLocalDescription: vi.fn(async () => undefined),
          setRemoteDescription: vi.fn(async () => undefined),
          ontrack: null
        }),
        exchangeSdp: vi.fn(async () => 'answer'),
        getUserMedia: vi.fn(async () => stream),
        mintSession: vi.fn(async () => ({
          clientSecret: 'ek_ephemeral',
          model: 'gpt-realtime-2.1',
          ownerSessionId: 'conversation-retry',
          providerSessionId: 'provider-retry',
          sessionId: 'stored-retry'
        }))
      }
    })

    await client.start()
    expect(client.narrateCanonicalResult({
      correlationId: 'call-retry',
      deliveryId: 'delivery-retry-1',
      providerSessionId: 'provider-retry',
      text: 'Initial verified result.'
    })).toBe(true)
    channel.emit('message', {
      type: 'response.created',
      response: {
        id: 'response-retry-1',
        metadata: { hermes_voice_delivery_id: 'delivery-retry-1' }
      }
    })
    channel.emit('message', { type: 'response.failed', response: { id: 'response-retry-1' } })

    await vi.waitFor(() => expect(channel.send).toHaveBeenCalledWith(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        id: 'evie-result-call-retry-delivery-retry-2',
        type: 'message',
        role: 'user',
        content: [{
          type: 'input_text',
          text: 'Verified result from your internal work:\nVerified result after retry.'
        }]
      }
    })))
    expect(observedStages).toEqual([
      'consumed',
      'narration_started',
      'narration_failed',
      'consumed'
    ])

    const resultItemIds = channel.send.mock.calls
      .map(([payload]) => JSON.parse(payload) as { item?: { id?: string }; type?: string })
      .filter(event => event.type === 'conversation.item.create' && event.item?.id?.startsWith('evie-result-'))
      .map(event => event.item?.id)

    expect(resultItemIds).toHaveLength(2)
    expect(new Set(resultItemIds)).toHaveLength(2)
    expect(onIntentDispatch).not.toHaveBeenCalled()

    channel.emit('message', {
      type: 'response.created',
      response: {
        id: 'response-retry-2',
        metadata: { hermes_voice_delivery_id: 'delivery-retry-2' }
      }
    })
    channel.emit('message', { type: 'response.failed', response: { id: 'response-retry-2' } })

    await vi.waitFor(() => expect(channel.send).toHaveBeenCalledWith(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        id: 'evie-status-narration-failed-call-retry',
        type: 'message',
        role: 'user',
        content: [{
          type: 'input_text',
          text: 'Private status update: I could not read that result aloud. It is still in the chat.'
        }]
      }
    })))

    const boundedResultItemIds = channel.send.mock.calls
      .map(([payload]) => JSON.parse(payload) as { item?: { id?: string }; type?: string })
      .filter(event => event.type === 'conversation.item.create' && event.item?.id?.startsWith('evie-result-'))
      .map(event => event.item?.id)

    expect(boundedResultItemIds).toHaveLength(2)
    expect(observedStages.filter(stage => stage === 'narration_failed')).toHaveLength(2)

    await client.end()
  })

  it('speaks one terse visible failure when narration cannot be redelivered', async () => {
    const track = { enabled: true, stop: vi.fn() }
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] }
    const channel = eventChannel()

    let failedAckAttempts = 0
    const onCanonicalResultStage = vi.fn(async (
      _result: RealtimeCanonicalResult,
      stage: RealtimeCanonicalResultStage
    ) => {
      if (stage === 'narration_failed') {
        failedAckAttempts += 1
        throw new Error('synthetic narration failure ACK outage')
      }

      return undefined
    })

    const client = createRealtimeVoiceClient({
      sessionId: 'conversation-no-retry',
      onCanonicalResultStage,
      onCanonicalResultStageError: () => {
        throw new Error('synthetic throwing stage-error observer')
      },
      dependencies: {
        createAudio: () => ({ autoplay: false, srcObject: null, pause: vi.fn(), play: vi.fn(async () => undefined) }),
        createPeerConnection: () => ({
          addTrack: vi.fn(),
          close: vi.fn(),
          createDataChannel: () => channel,
          createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'offer' })),
          setLocalDescription: vi.fn(async () => undefined),
          setRemoteDescription: vi.fn(async () => undefined),
          ontrack: null
        }),
        exchangeSdp: vi.fn(async () => 'answer'),
        getUserMedia: vi.fn(async () => stream),
        mintSession: vi.fn(async () => ({
          clientSecret: 'ek_ephemeral',
          model: 'gpt-realtime-2.1',
          ownerSessionId: 'conversation-no-retry',
          providerSessionId: 'provider-no-retry',
          sessionId: 'stored-no-retry'
        }))
      }
    })

    await client.start()
    expect(client.narrateCanonicalResult({
      correlationId: 'call-no-retry',
      deliveryId: 'delivery-no-retry',
      providerSessionId: 'provider-no-retry',
      text: 'Verified result that cannot be spoken.'
    })).toBe(true)
    channel.emit('message', {
      type: 'response.created',
      response: {
        id: 'response-no-retry',
        metadata: { hermes_voice_delivery_id: 'delivery-no-retry' }
      }
    })
    channel.emit('message', { type: 'response.failed', response: { id: 'response-no-retry' } })

    await vi.waitFor(() => expect(channel.send).toHaveBeenCalledWith(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        id: 'evie-status-narration-failed-call-no-retry',
        type: 'message',
        role: 'user',
        content: [{
          type: 'input_text',
          text: 'Private status update: I could not read that result aloud. It is still in the chat.'
        }]
      }
    })))
    expect(failedAckAttempts).toBe(2)

    await client.end()
  })

  it('announces approval pending once in the owning live voice session', async () => {
    const track = { enabled: true, stop: vi.fn() }
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] }
    const channel = eventChannel()

    const client = createRealtimeVoiceClient({
      sessionId: 'conversation-approval',
      dependencies: {
        createAudio: () => ({ autoplay: false, srcObject: null, pause: vi.fn(), play: vi.fn(async () => undefined) }),
        createPeerConnection: () => ({
          addTrack: vi.fn(),
          close: vi.fn(),
          createDataChannel: () => channel,
          createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'offer' })),
          setLocalDescription: vi.fn(async () => undefined),
          setRemoteDescription: vi.fn(async () => undefined),
          ontrack: null
        }),
        exchangeSdp: vi.fn(async () => 'answer'),
        getUserMedia: vi.fn(async () => stream),
        mintSession: vi.fn(async () => ({
          clientSecret: 'ek_ephemeral',
          model: 'gpt-realtime-2.1',
          ownerSessionId: 'conversation-approval',
          providerSessionId: 'provider-approval',
          sessionId: 'stored-approval'
        }))
      }
    })

    await client.start()
    expect(client.announceCanonicalProgress({
      correlationId: 'call-approval',
      status: 'approval_pending'
    })).toBe(true)
    expect(client.announceCanonicalProgress({
      correlationId: 'call-approval',
      status: 'approval_pending'
    })).toBe(false)
    expect(channel.send).toHaveBeenNthCalledWith(1, JSON.stringify({
      type: 'conversation.item.create',
      item: {
        id: 'evie-status-approval-pending-call-approval',
        type: 'message',
        role: 'user',
        content: [{
          type: 'input_text',
          text: 'Private status update: I need your approval before I can continue.'
        }]
      }
    }))
    expect(channel.send).toHaveBeenNthCalledWith(2, JSON.stringify({
      event_id: 'hermes-status-progress-call-approval-approval-pending',
      type: 'response.create',
      response: {
        instructions: 'Say exactly: "I need your approval before I can continue." Do not add explanation or call tools.',
        metadata: {
          hermes_voice_response_kind: 'status',
          hermes_voice_response_key: 'progress-call-approval-approval-pending'
        },
        tool_choice: 'none'
      }
    }))

    await client.end()
  })

  it('rehydrates progress and consumes a pending result after reconnect without redispatch', async () => {
    const track = { enabled: true, stop: vi.fn() }
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] }
    const channel = eventChannel()

    const onCanonicalResultStage = vi.fn(async (
      _result: RealtimeCanonicalResult,
      _stage: RealtimeCanonicalResultStage
    ) => undefined)

    const onCanonicalProgress = vi.fn()
    const onIntentDispatch = vi.fn()

    const recovered = {
      correlationId: 'call-recovered',
      deliveryId: 'delivery-recovered',
      providerSessionId: 'provider-recovered',
      text: 'Recovered verified result.'
    }

    const client = createRealtimeVoiceClient({
      sessionId: 'conversation-recovered',
      onCanonicalProgress,
      onCanonicalResultStage,
      onIntentDispatch,
      dependencies: {
        createAudio: () => ({ autoplay: false, srcObject: null, pause: vi.fn(), play: vi.fn(async () => undefined) }),
        createPeerConnection: () => ({
          addTrack: vi.fn(),
          close: vi.fn(),
          createDataChannel: () => channel,
          createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'offer' })),
          setLocalDescription: vi.fn(async () => undefined),
          setRemoteDescription: vi.fn(async () => undefined),
          ontrack: null
        }),
        exchangeSdp: vi.fn(async () => 'answer'),
        getUserMedia: vi.fn(async () => stream),
        mintSession: vi.fn(async () => ({
          clientSecret: 'ek_ephemeral',
          model: 'gpt-realtime-2.1',
          ownerSessionId: 'conversation-recovered',
          pendingProgress: [{
            correlationId: 'call-waiting',
            status: 'approval_pending' as const
          }],
          pendingResults: [recovered],
          providerSessionId: 'provider-recovered',
          sessionId: 'stored-recovered'
        }))
      }
    })

    await client.start()
    await vi.waitFor(() => expect(onCanonicalResultStage).toHaveBeenCalledTimes(1))
    channel.emit('message', {
      type: 'response.created',
      response: {
        id: 'response-recovered',
        metadata: { hermes_voice_delivery_id: 'delivery-recovered' }
      }
    })
    await vi.waitFor(() => expect(onCanonicalResultStage).toHaveBeenCalledTimes(2))

    expect(onCanonicalProgress).toHaveBeenCalledWith({
      correlationId: 'call-waiting',
      status: 'approval_pending'
    })
    expect(onCanonicalResultStage).toHaveBeenNthCalledWith(1, recovered, 'consumed')
    expect(onCanonicalResultStage).toHaveBeenNthCalledWith(2, recovered, 'narration_started')
    expect(onIntentDispatch).not.toHaveBeenCalled()
    expect(channel.send).toHaveBeenNthCalledWith(1, JSON.stringify({
      type: 'conversation.item.create',
      item: {
        id: 'evie-result-call-recovered-delivery-recovered',
        type: 'message',
        role: 'user',
        content: [{
          type: 'input_text',
          text: 'Verified result from your internal work:\nRecovered verified result.'
        }]
      }
    }))

    await client.end()
    await vi.waitFor(() => expect(onCanonicalResultStage).toHaveBeenCalledTimes(3))
    expect(onCanonicalResultStage).toHaveBeenNthCalledWith(3, recovered, 'narration_interrupted')
  })

  it('emits only normalized event identity diagnostics for valid provider events', async () => {
    const track = { enabled: true, stop: vi.fn() }
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] }
    const channel = eventChannel()
    const onDiagnostic = vi.fn()

    const client = createRealtimeVoiceClient({
      sessionId: 'conversation-diagnostics',
      onDiagnostic,
      dependencies: {
        createAudio: () => ({
          autoplay: false,
          srcObject: null,
          pause: vi.fn(),
          play: vi.fn(async () => undefined)
        }),
        createPeerConnection: () => ({
          addTrack: vi.fn(),
          close: vi.fn(),
          createDataChannel: () => channel,
          createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'offer' })),
          setLocalDescription: vi.fn(async () => undefined),
          setRemoteDescription: vi.fn(async () => undefined),
          ontrack: null
        }),
        exchangeSdp: vi.fn(async () => 'answer'),
        getUserMedia: vi.fn(async () => stream),
        mintSession: vi.fn(async () => ({
          clientSecret: 'minted-client-secret-sentinel',
          model: 'gpt-realtime-2.1',
          ownerSessionId: 'conversation-diagnostics',
          sessionId: 'stored-diagnostics'
        }))
      }
    })

    await client.start()
    channel.emit('message', {
      type: '  provider.experimental_event  ',
      item_id: 'item-1',
      response_id: 'response-1',
      call_id: 'call-1',
      transcript: 'transcript-sentinel',
      delta: 'delta-sentinel',
      client_secret: 'event-client-secret-sentinel',
      arguments: 'function-arguments-sentinel'
    })
    expect(onDiagnostic).toHaveBeenCalledOnce()
    expect(onDiagnostic).toHaveBeenCalledWith({
      type: 'provider.experimental_event',
      itemId: 'item-1',
      responseId: 'response-1',
      callId: 'call-1'
    })
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toMatch(
      /transcript-sentinel|delta-sentinel|client-secret-sentinel|function-arguments-sentinel/
    )

    channel.emit('message', null)
    channel.emitRaw('message', '{malformed')
    channel.emit('message', { type: 'x'.repeat(129) })
    expect(onDiagnostic).toHaveBeenCalledOnce()

    channel.emit('message', {
      type: 'provider.safe_event',
      item_id: 'i'.repeat(257),
      response_id: 'r'.repeat(257),
      call_id: 'c'.repeat(257)
    })
    expect(onDiagnostic).toHaveBeenCalledTimes(2)
    expect(onDiagnostic).toHaveBeenLastCalledWith({ type: 'provider.safe_event' })

    await client.end()
  })

  it('continues semantic handling when a diagnostic observer throws', async () => {
    const track = { enabled: true, stop: vi.fn() }
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] }
    const channel = eventChannel()
    const statuses: string[] = []

    const client = createRealtimeVoiceClient({
      sessionId: 'conversation-diagnostic-isolation',
      onDiagnostic: () => {throw new Error('diagnostic observer failed')},
      onStatus: status => statuses.push(status),
      dependencies: {
        createAudio: () => ({
          autoplay: false,
          srcObject: null,
          pause: vi.fn(),
          play: vi.fn(async () => undefined)
        }),
        createPeerConnection: () => ({
          addTrack: vi.fn(),
          close: vi.fn(),
          createDataChannel: () => channel,
          createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'offer' })),
          setLocalDescription: vi.fn(async () => undefined),
          setRemoteDescription: vi.fn(async () => undefined),
          ontrack: null
        }),
        exchangeSdp: vi.fn(async () => 'answer'),
        getUserMedia: vi.fn(async () => stream),
        mintSession: vi.fn(async () => ({
          clientSecret: 'ek_ephemeral',
          model: 'gpt-realtime-2.1',
          ownerSessionId: 'conversation-diagnostic-isolation',
          sessionId: 'stored-diagnostic-isolation'
        }))
      }
    })

    await client.start()

    expect(() => channel.emit('message', {
      type: 'response.created',
      response: { id: 'response-diagnostic-isolation' }
    })).not.toThrow()
    expect(statuses.at(-1)).toBe('assistant-speaking')

    await client.end()
  })

  it('stops semantic handling when a diagnostic observer ends the active attempt', async () => {
    const track = { enabled: true, stop: vi.fn() }
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] }
    const channel = eventChannel()
    const statuses: string[] = []
    const onAssistantTranscript = vi.fn()
    let ending: Promise<void> | undefined
    let client!: ReturnType<typeof createRealtimeVoiceClient>

    client = createRealtimeVoiceClient({
      sessionId: 'conversation-diagnostic-reentrancy',
      onAssistantTranscript,
      onDiagnostic: diagnostic => {
        if (diagnostic.type === 'response.created') {ending = client.end()}
      },
      onStatus: status => statuses.push(status),
      dependencies: {
        createAudio: () => ({
          autoplay: false,
          srcObject: null,
          pause: vi.fn(),
          play: vi.fn(async () => undefined)
        }),
        createPeerConnection: () => ({
          addTrack: vi.fn(),
          close: vi.fn(),
          createDataChannel: () => channel,
          createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'offer' })),
          setLocalDescription: vi.fn(async () => undefined),
          setRemoteDescription: vi.fn(async () => undefined),
          ontrack: null
        }),
        exchangeSdp: vi.fn(async () => 'answer'),
        getUserMedia: vi.fn(async () => stream),
        mintSession: vi.fn(async () => ({
          clientSecret: 'ek_ephemeral',
          model: 'gpt-realtime-2.1',
          ownerSessionId: 'conversation-diagnostic-reentrancy',
          sessionId: 'stored-diagnostic-reentrancy'
        }))
      }
    })

    await client.start()
    channel.emit('message', { type: 'response.created' })
    await ending

    channel.emit('message', {
      type: 'conversation.item.created',
      item: { id: 'stale-assistant', role: 'assistant' },
      previous_item_id: null
    })
    channel.emit('message', {
      type: 'response.output_audio_transcript.done',
      item_id: 'stale-assistant',
      transcript: 'must not publish'
    })

    expect(statuses).toEqual(['connecting', 'listening', 'idle'])
    expect(onAssistantTranscript).not.toHaveBeenCalled()
    expect(track.stop).toHaveBeenCalledOnce()
  })

  it('does not revive a canceled start after microphone permission resolves', async () => {
    const track = { enabled: true, stop: vi.fn() }
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] }
    let resolveMedia!: (value: typeof stream) => void
    const mediaPromise = new Promise<typeof stream>(resolve => {resolveMedia = resolve})
    const statuses: string[] = []
    const createPeerConnection = vi.fn()

    const client = createRealtimeVoiceClient({
      sessionId: 'conversation-race',
      onStatus: status => statuses.push(status),
      dependencies: {
        createAudio: vi.fn(),
        createPeerConnection,
        exchangeSdp: vi.fn(),
        getUserMedia: vi.fn(() => mediaPromise),
        mintSession: vi.fn(async () => ({
          clientSecret: 'ek_ephemeral',
          model: 'gpt-realtime-2.1',
          ownerSessionId: 'conversation-race',
          sessionId: 'stored-race'
        }))
      }
    })

    const starting = client.start()
    await Promise.resolve()
    await client.end()
    resolveMedia(stream)
    await starting

    expect(track.stop).toHaveBeenCalledOnce()
    expect(createPeerConnection).not.toHaveBeenCalled()
    expect(statuses).toEqual(['connecting', 'idle'])
  })

  it('does not let a superseded start overwrite the active attempt', async () => {
    const track = { enabled: true, stop: vi.fn() }
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] }
    const channel = eventChannel()

    const peer = {
      addTrack: vi.fn(),
      close: vi.fn(),
      createDataChannel: vi.fn(() => channel),
      createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'offer' })),
      setLocalDescription: vi.fn(async () => undefined),
      setRemoteDescription: vi.fn(async () => undefined),
      ontrack: null as null | ((event: { streams: unknown[] }) => void)
    }

    const audio = {
      autoplay: false,
      srcObject: null as unknown,
      pause: vi.fn(),
      play: vi.fn(async () => undefined)
    }

    let resolveFirstMint!: (grant: {
      clientSecret: string
      model: string
      ownerSessionId: string
      sessionId: string
    }) => void

    const firstMint = new Promise<{
      clientSecret: string
      model: string
      ownerSessionId: string
      sessionId: string
    }>(resolve => {resolveFirstMint = resolve})

    const grant = {
      clientSecret: 'ek_ephemeral',
      model: 'gpt-realtime-2.1',
      ownerSessionId: 'conversation-race',
      sessionId: 'stored-race'
    }

    const mintSession = vi.fn().mockImplementationOnce(() => firstMint).mockResolvedValue(grant)
    const getUserMedia = vi.fn(async () => stream)
    const createPeerConnection = vi.fn(() => peer)
    const statuses: string[] = []

    const client = createRealtimeVoiceClient({
      sessionId: 'conversation-race',
      onStatus: status => statuses.push(status),
      dependencies: {
        createAudio: () => audio,
        createPeerConnection,
        exchangeSdp: vi.fn(async () => 'answer'),
        getUserMedia,
        mintSession
      }
    })

    const firstStart = client.start()
    await Promise.resolve()
    const secondStart = client.start()
    await secondStart
    resolveFirstMint(grant)
    await firstStart

    expect(getUserMedia).toHaveBeenCalledOnce()
    expect(createPeerConnection).toHaveBeenCalledOnce()
    expect(statuses).toEqual(['connecting', 'connecting', 'listening'])
  })

  it('connects a continuous microphone track with an ephemeral session and cleans up', async () => {
    const track = { enabled: true, stop: vi.fn() }
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] }
    const channel = eventChannel()

    const peer = {
      addTrack: vi.fn(),
      close: vi.fn(),
      createDataChannel: vi.fn(() => channel),
      createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'local-offer' })),
      setLocalDescription: vi.fn(async () => undefined),
      setRemoteDescription: vi.fn(async () => undefined),
      ontrack: null as null | ((event: { streams: unknown[] }) => void)
    }

    const audio = {
      autoplay: false,
      srcObject: null as unknown,
      pause: vi.fn(),
      play: vi.fn(async () => undefined)
    }

    const statuses: string[] = []

    const mintSession = vi.fn(async () => ({
      clientSecret: 'ek_ephemeral',
      model: 'gpt-realtime-2.1',
      ownerSessionId: 'conversation-1',
      sessionId: 'stored-conversation-1'
    }))

    const exchangeSdp = vi.fn(async () => 'remote-answer')

    const client = createRealtimeVoiceClient({
      sessionId: 'conversation-1',
      onStatus: status => statuses.push(status),
      dependencies: {
        createAudio: () => audio,
        createPeerConnection: () => peer,
        exchangeSdp,
        getUserMedia: vi.fn(async () => stream),
        mintSession
      }
    })

    await client.start()

    expect(mintSession).toHaveBeenCalledWith('conversation-1')
    expect(peer.addTrack).toHaveBeenCalledWith(track, stream)
    expect(exchangeSdp).toHaveBeenCalledWith('local-offer', 'ek_ephemeral', 'gpt-realtime-2.1')
    expect(peer.setRemoteDescription).toHaveBeenCalledWith({ type: 'answer', sdp: 'remote-answer' })
    expect(statuses).toEqual(['connecting', 'listening'])

    client.setMuted(true)
    expect(track.enabled).toBe(false)

    await client.end()
    expect(track.stop).toHaveBeenCalledOnce()
    expect(channel.close).toHaveBeenCalledOnce()
    expect(peer.close).toHaveBeenCalledOnce()
    expect(audio.pause).toHaveBeenCalledOnce()
    expect(statuses.at(-1)).toBe('idle')
  })

  it('publishes added-item transcripts exactly once in provider order', async () => {
    const track = { enabled: true, stop: vi.fn() }
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] }
    const channel = eventChannel()
    const transcripts: Array<[string, string, string]> = []

    const client = createRealtimeVoiceClient({
      sessionId: 'conversation-added-items',
      onAssistantTranscript: (text, itemId) => transcripts.push(['assistant', text, itemId]),
      onUserTranscript: (text, itemId) => transcripts.push(['user', text, itemId]),
      dependencies: {
        createAudio: () => ({
          autoplay: false,
          srcObject: null,
          pause: vi.fn(),
          play: vi.fn(async () => undefined)
        }),
        createPeerConnection: () => ({
          addTrack: vi.fn(),
          close: vi.fn(),
          createDataChannel: () => channel,
          createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'offer' })),
          setLocalDescription: vi.fn(async () => undefined),
          setRemoteDescription: vi.fn(async () => undefined),
          ontrack: null
        }),
        exchangeSdp: vi.fn(async () => 'answer'),
        getUserMedia: vi.fn(async () => stream),
        mintSession: vi.fn(async () => ({
          clientSecret: 'ek_ephemeral',
          model: 'gpt-realtime-2.1',
          ownerSessionId: 'conversation-added-items',
          sessionId: 'stored-added-items'
        }))
      }
    })

    await client.start()
    channel.emit('message', { type: 'input_audio_buffer.speech_started', item_id: 'user-1' })
    channel.emit('message', { type: 'input_audio_buffer.speech_stopped', item_id: 'user-1' })
    channel.emit('message', { type: 'input_audio_buffer.committed', item_id: 'user-1' })
    channel.emit('message', {
      type: 'conversation.item.added',
      item: { id: 'user-1', role: 'user' },
      previous_item_id: null
    })
    channel.emit('message', {
      type: 'conversation.item.done',
      item: { id: 'user-1', role: 'user' }
    })
    channel.emit('message', { type: 'response.created', response: { id: 'response-1' } })
    channel.emit('message', {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'user-1',
      transcript: 'sentinel-user'
    })
    channel.emit('message', {
      type: 'response.output_item.added',
      item: { id: 'assistant-1', role: 'assistant' },
      response_id: 'response-1'
    })
    channel.emit('message', {
      type: 'conversation.item.added',
      item: { id: 'assistant-1', role: 'assistant' },
      previous_item_id: 'user-1'
    })
    channel.emit('message', { type: 'response.content_part.added' })
    channel.emit('message', {
      type: 'response.output_audio_transcript.done',
      item_id: 'assistant-1',
      response_id: 'response-1',
      transcript: 'sentinel-assistant'
    })
    channel.emit('message', {
      type: 'conversation.item.done',
      item: { id: 'assistant-1', role: 'assistant' }
    })
    channel.emit('message', { type: 'response.done', response: { id: 'response-1' } })

    expect(transcripts).toEqual([
      ['user', 'sentinel-user', 'user-1'],
      ['assistant', 'sentinel-assistant', 'assistant-1']
    ])

    await client.end()
  })

  it('publishes final transcripts and barges in without ending the live session', async () => {
    const track = { enabled: true, stop: vi.fn() }
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] }
    const channel = eventChannel()

    const peer = {
      addTrack: vi.fn(),
      close: vi.fn(),
      createDataChannel: vi.fn(() => channel),
      createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'offer' })),
      setLocalDescription: vi.fn(async () => undefined),
      setRemoteDescription: vi.fn(async () => undefined),
      ontrack: null as null | ((event: { streams: unknown[] }) => void)
    }

    const audio = {
      autoplay: false,
      srcObject: null as unknown,
      pause: vi.fn(),
      play: vi.fn(async () => undefined)
    }

    const statuses: string[] = []
    const userTranscripts: Array<[string, string]> = []
    const assistantTranscripts: Array<[string, string]> = []
    const transcriptOrder: string[] = []

    const client = createRealtimeVoiceClient({
      sessionId: 'conversation-1',
      onAssistantTranscript: (text, itemId) => {
        assistantTranscripts.push([text, itemId])
        transcriptOrder.push(`assistant:${itemId}`)
      },
      onStatus: status => statuses.push(status),
      onUserTranscript: (text, itemId) => {
        userTranscripts.push([text, itemId])
        transcriptOrder.push(`user:${itemId}`)
      },
      dependencies: {
        createAudio: () => audio,
        createPeerConnection: () => peer,
        exchangeSdp: vi.fn(async () => 'answer'),
        getUserMedia: vi.fn(async () => stream),
        mintSession: vi.fn(async () => ({
          clientSecret: 'ek_ephemeral',
          model: 'gpt-realtime-2.1',
          ownerSessionId: 'conversation-1',
          sessionId: 'stored-conversation-1'
        }))
      }
    })

    await client.start()

    channel.emit('message', { type: 'response.created', response: { id: 'response-interrupt-1' } })
    client.interrupt()

    expect(audio.pause).toHaveBeenCalledOnce()
    expect(channel.send).toHaveBeenCalledWith(JSON.stringify({ type: 'response.cancel' }))
    expect(channel.send).toHaveBeenCalledWith(JSON.stringify({ type: 'output_audio_buffer.clear' }))
    expect(track.stop).not.toHaveBeenCalled()
    audio.pause.mockClear()
    channel.send.mockClear()

    channel.emit('message', { type: 'response.created', response: { id: 'response-interrupt-2' } })
    channel.emit('message', { type: 'response.output_audio_transcript.delta', delta: 'Hello ' })
    channel.emit('message', { type: 'input_audio_buffer.speech_started' })

    expect(audio.pause).toHaveBeenCalledOnce()
    expect(channel.send).toHaveBeenCalledWith(JSON.stringify({ type: 'response.cancel' }))
    expect(channel.send).toHaveBeenCalledWith(JSON.stringify({ type: 'output_audio_buffer.clear' }))
    expect(track.stop).not.toHaveBeenCalled()
    expect(statuses.at(-1)).toBe('user-speaking')

    channel.emit('message', {
      type: 'conversation.item.created',
      item: { id: 'user-item-1', role: 'user' },
      previous_item_id: null
    })
    channel.emit('message', {
      type: 'conversation.item.created',
      item: { id: 'assistant-item-1', role: 'assistant' },
      previous_item_id: 'user-item-1'
    })
    channel.emit('message', {
      type: 'response.output_audio_transcript.done',
      item_id: 'assistant-item-1',
      transcript: 'Hello there'
    })
    expect(transcriptOrder).toEqual([])
    channel.emit('message', {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'user-item-1',
      transcript: 'Please continue'
    })
    channel.emit('message', { type: 'input_audio_buffer.speech_stopped' })

    expect(userTranscripts).toEqual([['Please continue', 'user-item-1']])
    expect(assistantTranscripts).toEqual([['Hello there', 'assistant-item-1']])
    expect(transcriptOrder).toEqual(['user:user-item-1', 'assistant:assistant-item-1'])

    channel.emit('message', {
      type: 'conversation.item.created',
      item: { id: 'user-item-2', role: 'user' },
      previous_item_id: 'assistant-item-1'
    })
    channel.emit('message', {
      type: 'conversation.item.created',
      item: { id: 'assistant-item-2', role: 'assistant' },
      previous_item_id: 'user-item-2'
    })
    channel.emit('message', {
      type: 'response.output_audio_transcript.done',
      item_id: 'assistant-item-2',
      transcript: 'I can still continue'
    })
    channel.emit('message', {
      type: 'conversation.item.input_audio_transcription.failed',
      item_id: 'user-item-2'
    })

    expect(assistantTranscripts).toEqual([
      ['Hello there', 'assistant-item-1'],
      ['I can still continue', 'assistant-item-2']
    ])
    expect(transcriptOrder).toEqual([
      'user:user-item-1',
      'assistant:assistant-item-1',
      'assistant:assistant-item-2'
    ])
    expect(audio.play).toHaveBeenCalledOnce()
    expect(statuses.at(-1)).toBe('listening')

    channel.emit('message', {
      type: 'conversation.item.created',
      item: { id: 'user-empty', role: 'user' },
      previous_item_id: 'assistant-item-2'
    })
    channel.emit('message', {
      type: 'conversation.item.created',
      item: { id: 'assistant-empty', role: 'assistant' },
      previous_item_id: 'user-empty'
    })
    channel.emit('message', {
      type: 'response.output_audio_transcript.done',
      item_id: 'assistant-empty',
      transcript: '   '
    })
    channel.emit('message', {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'user-empty',
      transcript: '\n'
    })
    channel.emit('message', {
      type: 'conversation.item.created',
      item: { id: 'user-after-empty', role: 'user' },
      previous_item_id: 'assistant-empty'
    })
    channel.emit('message', {
      type: 'conversation.item.created',
      item: { id: 'assistant-after-empty', role: 'assistant' },
      previous_item_id: 'user-after-empty'
    })
    channel.emit('message', {
      type: 'response.output_audio_transcript.done',
      item_id: 'assistant-after-empty',
      transcript: 'Released after empty items'
    })
    channel.emit('message', {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'user-after-empty',
      transcript: 'Continue after empty items'
    })

    expect(transcriptOrder.slice(-2)).toEqual([
      'user:user-after-empty',
      'assistant:assistant-after-empty'
    ])

    channel.emit('message', {
      type: 'conversation.item.created',
      item: { id: 'user-before-cancel', role: 'user' },
      previous_item_id: 'assistant-after-empty'
    })
    channel.emit('message', {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'user-before-cancel',
      transcript: 'Interrupt this response'
    })
    channel.emit('message', { type: 'response.created' })
    channel.emit('message', { type: 'input_audio_buffer.speech_started' })
    channel.emit('message', {
      type: 'conversation.item.created',
      item: { id: 'assistant-announced-after-cancel', role: 'assistant' },
      previous_item_id: 'user-before-cancel'
    })
    channel.emit('message', {
      type: 'response.output_audio_transcript.done',
      item_id: 'assistant-announced-after-cancel',
      transcript: 'Late canceled transcript'
    })
    channel.emit('message', { type: 'response.done' })
    channel.emit('message', { type: 'response.created' })
    channel.emit('message', {
      type: 'conversation.item.created',
      item: { id: 'user-after-cancel', role: 'user' },
      previous_item_id: 'assistant-announced-after-cancel'
    })
    channel.emit('message', {
      type: 'conversation.item.created',
      item: { id: 'assistant-after-cancel', role: 'assistant' },
      previous_item_id: 'user-after-cancel'
    })
    channel.emit('message', {
      type: 'response.output_audio_transcript.done',
      item_id: 'assistant-after-cancel',
      transcript: 'Released after cancellation'
    })
    channel.emit('message', {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'user-after-cancel',
      transcript: 'Continue after cancellation'
    })

    expect(transcriptOrder.slice(-3)).toEqual([
      'user:user-before-cancel',
      'user:user-after-cancel',
      'assistant:assistant-after-cancel'
    ])
    expect(transcriptOrder).not.toContain('assistant:assistant-announced-after-cancel')

    await client.end()
    channel.emit('message', { type: 'response.created' })
    expect(statuses.at(-1)).toBe('idle')
  })

  it('uses only the backend ephemeral secret for the provider SDP exchange', async () => {
    const mint = vi.fn(async () => ({
      ok: true,
      client_secret: 'ek_ephemeral',
      expires_at: 1_800_000_000,
      model: 'gpt-realtime-2.1',
      owner_session_id: 'conversation-1',
      session_id: 'conversation-1',
      provider_session_id: 'sess_provider'
    }))

    const fetchImpl = vi.fn(async () => ({
      ok: true,
      text: async () => 'provider-answer'
    }))

    const dependencies = createBrowserRealtimeVoiceDependencies({ fetchImpl, mint })

    await expect(dependencies.mintSession('conversation-1')).resolves.toEqual({
      clientSecret: 'ek_ephemeral',
      expiresAt: 1_800_000_000,
      model: 'gpt-realtime-2.1',
      ownerSessionId: 'conversation-1',
      pendingProgress: [],
      pendingResults: [],
      sessionId: 'conversation-1',
      providerSessionId: 'sess_provider'
    })
    await expect(
      dependencies.exchangeSdp('local-offer', 'ek_ephemeral', 'gpt-realtime-2.1')
    ).resolves.toBe('provider-answer')
    expect(fetchImpl).toHaveBeenCalledWith('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      body: 'local-offer',
      headers: {
        Authorization: 'Bearer ek_ephemeral',
        'Content-Type': 'application/sdp'
      }
    })
  })
})

describe('createRealtimeTranscriptAppender', () => {
  it('preserves provider order and retries before advancing the queue', async () => {
    vi.useFakeTimers()

    const calls: string[] = []

    const append = vi.fn(async ({ itemId }: { itemId: string }) => {

      calls.push(itemId)

      if (itemId === 'user-1' && calls.length === 1) {
        throw new Error('temporary gateway failure')
      }
    })

    const enqueue = createRealtimeTranscriptAppender({ append, retryDelayMs: 10 })

    const user = enqueue({ itemId: 'user-1', role: 'user', text: 'Hello' })
    const assistant = enqueue({ itemId: 'assistant-1', role: 'assistant', text: 'Hi' })

    await vi.runAllTimersAsync()

    await expect(user).resolves.toBeUndefined()
    await expect(assistant).resolves.toBeUndefined()
    expect(calls).toEqual(['user-1', 'user-1', 'assistant-1'])
    vi.useRealTimers()
  })

  it('reports terminal append failure after bounded retries', async () => {
    vi.useFakeTimers()

    const error = new Error('gateway unavailable')
    const onError = vi.fn()

    const enqueue = createRealtimeTranscriptAppender({
      append: vi.fn(async () => {
        throw error
      }),
      maxAttempts: 2,
      onError,
      retryDelayMs: 10
    })

    const result = enqueue({ itemId: 'user-1', role: 'user', text: 'Hello' })

    await vi.runAllTimersAsync()

    await expect(result).rejects.toThrow('gateway unavailable')
    expect(onError).toHaveBeenCalledWith(error)
    vi.useRealTimers()
  })

  it('returns the canonical result as the output of the original tool call, not a disconnected narration', async () => {
    const track = { enabled: true, stop: vi.fn() }
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] }
    const channel = eventChannel()
    const observedStages: Array<[RealtimeCanonicalResult, RealtimeCanonicalResultStage]> = []

    const onCanonicalResultStage = vi.fn(async (
      result: RealtimeCanonicalResult,
      stage: RealtimeCanonicalResultStage
    ) => {observedStages.push([result, stage])})

    const onIntentDispatch = vi.fn(async () => ({
      correlationId: 'call-toolreturn',
      status: 'queued' as const
    }))

    const client = createRealtimeVoiceClient({
      sessionId: 'conversation-toolreturn',
      onCanonicalResultStage,
      onIntentDispatch,
      dependencies: {
        createAudio: () => ({ autoplay: false, srcObject: null, pause: vi.fn(), play: vi.fn(async () => undefined) }),
        createPeerConnection: () => ({
          addTrack: vi.fn(),
          close: vi.fn(),
          createDataChannel: () => channel,
          createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'offer' })),
          setLocalDescription: vi.fn(async () => undefined),
          setRemoteDescription: vi.fn(async () => undefined),
          ontrack: null
        }),
        exchangeSdp: vi.fn(async () => 'answer'),
        getUserMedia: vi.fn(async () => stream),
        mintSession: vi.fn(async () => ({
          clientSecret: 'ek_ephemeral',
          model: 'gpt-realtime-2.1',
          ownerSessionId: 'conversation-toolreturn',
          providerSessionId: 'provider-toolreturn',
          sessionId: 'stored-toolreturn'
        }))
      }
    })

    await client.start()

    channel.emit('message', {
      type: 'response.function_call_arguments.done',
      name: 'perform_internal_work',
      call_id: 'fc-toolreturn',
      item_id: 'item-toolreturn',
      arguments: JSON.stringify({ intent: 'Check the system temperatures' })
    })
    await vi.waitFor(() => expect(onIntentDispatch).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    await Promise.resolve()

    const sentPayloads = () => channel.send.mock.calls.map(([raw]) => JSON.parse(raw as string) as {
      type?: string
      item?: { type?: string; id?: string; call_id?: string; output?: string }
      response?: { metadata?: Record<string, unknown> }
    })

    // The call must be HELD OPEN while canonical work runs: no immediate settle.
    expect(sentPayloads().filter(p => p.item?.type === 'function_call_output')).toHaveLength(0)

    expect(client.narrateCanonicalResult({
      correlationId: 'call-toolreturn',
      deliveryId: 'delivery-toolreturn',
      providerSessionId: 'provider-toolreturn',
      text: 'Battery is at 30C; no thermal warnings.'
    })).toBe(true)

    await vi.waitFor(() => {
      const outputs = sentPayloads().filter(p => p.item?.type === 'function_call_output')

      expect(outputs).toHaveLength(1)
      expect(outputs[0]?.item?.call_id).toBe('fc-toolreturn')
      expect(outputs[0]?.item?.output ?? '').toContain('Battery is at 30C; no thermal warnings.')
    })

    // The result is the tool's return value: no disconnected narration item may exist.
    expect(sentPayloads().filter(p => (p.item?.id ?? '').startsWith('evie-result-call-toolreturn'))).toHaveLength(0)

    const responseCreates = sentPayloads().filter(p => p.type === 'response.create')

    expect(responseCreates.at(-1)?.response?.metadata?.hermes_voice_delivery_id).toBe('delivery-toolreturn')

    channel.emit('message', {
      type: 'response.created',
      response: {
        id: 'response-toolreturn',
        metadata: { hermes_voice_delivery_id: 'delivery-toolreturn' }
      }
    })
    channel.emit('message', { type: 'response.done', response: { id: 'response-toolreturn' } })

    await vi.waitFor(() => expect(observedStages.filter(([result]) => (
      result.correlationId === 'call-toolreturn'
    )).map(([, stage]) => stage)).toEqual([
      'consumed',
      'narration_started',
      'narration_completed'
    ]))

    await client.end()
  })

  it('settles a long-running dispatch as working after the bounded await and delivers via narration without a second tool return', async () => {
    const track = { enabled: true, stop: vi.fn() }
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] }
    const channel = eventChannel()

    const onIntentDispatch = vi.fn(async () => ({
      correlationId: 'call-longtask',
      status: 'queued' as const
    }))

    const client = createRealtimeVoiceClient({
      sessionId: 'conversation-longtask',
      dispatchResultTimeoutMs: 40,
      onCanonicalResultStage: vi.fn(async () => undefined),
      onIntentDispatch,
      dependencies: {
        createAudio: () => ({ autoplay: false, srcObject: null, pause: vi.fn(), play: vi.fn(async () => undefined) }),
        createPeerConnection: () => ({
          addTrack: vi.fn(),
          close: vi.fn(),
          createDataChannel: () => channel,
          createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'offer' })),
          setLocalDescription: vi.fn(async () => undefined),
          setRemoteDescription: vi.fn(async () => undefined),
          ontrack: null
        }),
        exchangeSdp: vi.fn(async () => 'answer'),
        getUserMedia: vi.fn(async () => stream),
        mintSession: vi.fn(async () => ({
          clientSecret: 'ek_ephemeral',
          model: 'gpt-realtime-2.1',
          ownerSessionId: 'conversation-longtask',
          providerSessionId: 'provider-longtask',
          sessionId: 'stored-longtask'
        }))
      }
    })

    await client.start()

    channel.emit('message', {
      type: 'response.function_call_arguments.done',
      name: 'perform_internal_work',
      call_id: 'fc-longtask',
      item_id: 'item-longtask',
      arguments: JSON.stringify({ intent: 'Run the long audit' })
    })
    await vi.waitFor(() => expect(onIntentDispatch).toHaveBeenCalledTimes(1))

    const sentPayloads = () => channel.send.mock.calls.map(([raw]) => JSON.parse(raw as string) as {
      type?: string
      item?: { type?: string; id?: string; call_id?: string; output?: string }
    })

    await vi.waitFor(() => {
      const outputs = sentPayloads().filter(p => p.item?.type === 'function_call_output')

      expect(outputs).toHaveLength(1)
      expect(outputs[0]?.item?.output ?? '').toContain('working')
    })

    // Let the "working" acknowledgement response run to completion so the
    // channel is idle when the late canonical result arrives.
    channel.emit('message', {
      type: 'response.created',
      response: {
        id: 'response-longtask-ack',
        metadata: {
          hermes_voice_response_kind: 'dispatch',
          hermes_voice_response_key: 'fc-longtask'
        }
      }
    })
    channel.emit('message', { type: 'response.done', response: { id: 'response-longtask-ack', status: 'completed' } })

    expect(client.narrateCanonicalResult({
      correlationId: 'call-longtask',
      deliveryId: 'delivery-longtask',
      providerSessionId: 'provider-longtask',
      text: 'The audit finished clean.'
    })).toBe(true)

    await vi.waitFor(() => {
      expect(sentPayloads().filter(p => (p.item?.id ?? '').startsWith('evie-result-call-longtask'))).toHaveLength(1)
    })

    // The settled call must never receive a second, late tool return.
    const outputs = sentPayloads().filter(p => p.item?.type === 'function_call_output')

    expect(outputs).toHaveLength(1)
    expect(outputs[0]?.item?.output ?? '').not.toContain('The audit finished clean.')

    await client.end()
  })
})
