import { describe, expect, it, vi } from 'vitest'

import {
  createBrowserRealtimeVoiceDependencies,
  createRealtimeTranscriptAppender,
  createRealtimeVoiceClient
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
    }
  }
}

describe('createRealtimeVoiceClient', () => {
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

    channel.emit('message', { type: 'response.created' })
    client.interrupt()

    expect(audio.pause).toHaveBeenCalledOnce()
    expect(channel.send).toHaveBeenCalledWith(JSON.stringify({ type: 'response.cancel' }))
    expect(channel.send).toHaveBeenCalledWith(JSON.stringify({ type: 'output_audio_buffer.clear' }))
    expect(track.stop).not.toHaveBeenCalled()
    audio.pause.mockClear()
    channel.send.mockClear()

    channel.emit('message', { type: 'response.created' })
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
})
