export type RealtimeVoiceStatus =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'user-speaking'
  | 'assistant-speaking'
  | 'reconnecting'
  | 'error'

export interface RealtimeSessionGrant {
  clientSecret: string
  model: string
  ownerSessionId: string
  sessionId: string
  expiresAt?: number | null
  providerSessionId?: string | null
}

interface MediaTrackLike {
  enabled: boolean
  stop(): void
}

interface MediaStreamLike {
  getTracks(): MediaTrackLike[]
  getAudioTracks(): MediaTrackLike[]
}

interface DataChannelLike {
  readonly readyState: string
  addEventListener(type: 'message', listener: (event: { data: string }) => void): void
  close(): void
  send(data: string): void
}

interface PeerConnectionLike {
  ontrack: null | ((event: { streams: unknown[] }) => void)
  addTrack(track: MediaTrackLike, stream: MediaStreamLike): unknown
  close(): void
  createDataChannel(label: string): DataChannelLike
  createOffer(): Promise<{ type: string; sdp?: string }>
  setLocalDescription(description: { type: string; sdp?: string }): Promise<void>
  setRemoteDescription(description: { type: 'answer'; sdp: string }): Promise<void>
}

interface AudioLike {
  autoplay: boolean
  srcObject: unknown
  pause(): void
  play(): Promise<void>
}

export interface RealtimeVoiceDependencies {
  createAudio(): AudioLike
  createPeerConnection(): PeerConnectionLike
  exchangeSdp(offerSdp: string, clientSecret: string, model: string): Promise<string>
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStreamLike>
  mintSession(sessionId: string): Promise<RealtimeSessionGrant>
}

export interface RealtimeVoiceClient {
  start(): Promise<void>
  end(): Promise<void>
  interrupt(): void
  setMuted(muted: boolean): void
}

export interface RealtimeVoiceDiagnostic {
  type: string
  itemId?: string
  responseId?: string
  callId?: string
}

export interface BackendRealtimeSessionGrant {
  client_secret: string
  expires_at?: number | null
  model: string
  owner_session_id: string
  provider_session_id?: string | null
  session_id: string
}

export function createBrowserRealtimeVoiceDependencies({
  fetchImpl = globalThis.fetch,
  mint
}: {
  fetchImpl?: (
    input: string,
    init: { method: string; body: string; headers: Record<string, string> }
  ) => Promise<{ ok: boolean; status?: number; text(): Promise<string> }>
  mint: (sessionId: string) => Promise<BackendRealtimeSessionGrant>
}): RealtimeVoiceDependencies {
  return {
    createAudio: () => new Audio() as unknown as AudioLike,
    createPeerConnection: () => new RTCPeerConnection() as unknown as PeerConnectionLike,
    getUserMedia: async constraints =>
      (await navigator.mediaDevices.getUserMedia(constraints)) as unknown as MediaStreamLike,
    async mintSession(sessionId) {
      const grant = await mint(sessionId)

      return {
        clientSecret: grant.client_secret,
        expiresAt: grant.expires_at,
        model: grant.model,
        ownerSessionId: grant.owner_session_id,
        providerSessionId: grant.provider_session_id,
        sessionId: grant.session_id
      }
    },
    async exchangeSdp(offerSdp, clientSecret, _model) {
      const response = await fetchImpl('https://api.openai.com/v1/realtime/calls', {
        method: 'POST',
        body: offerSdp,
        headers: {
          Authorization: `Bearer ${clientSecret}`,
          'Content-Type': 'application/sdp'
        }
      })

      if (!response.ok) {throw new Error(`Realtime provider connection failed (${response.status ?? 'unknown'})`)}

      return response.text()
    }
  }
}

export interface RealtimeTranscriptAppend {
  itemId: string
  role: 'assistant' | 'user'
  text: string
}

export function createRealtimeTranscriptAppender({
  append,
  maxAttempts = 3,
  onError,
  retryDelayMs = 250
}: {
  append: (transcript: RealtimeTranscriptAppend) => Promise<unknown>
  maxAttempts?: number
  onError?: (error: unknown) => void
  retryDelayMs?: number
}): (transcript: RealtimeTranscriptAppend) => Promise<void> {
  let queue: Promise<void> = Promise.resolve()

  return transcript => {
    const appendWithRetry = async () => {
      let lastError: unknown

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          await append(transcript)

          return
        } catch (error) {
          lastError = error

          if (attempt < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, retryDelayMs))
          }
        }
      }

      onError?.(lastError)
      throw lastError
    }

    const result = queue.then(appendWithRetry)
    queue = result.catch(() => undefined)

    return result
  }
}

export function createRealtimeVoiceClient({
  dependencies,
  onAssistantTranscript,
  onDiagnostic,
  onStatus,
  onUserTranscript,
  sessionId
}: {
  dependencies: RealtimeVoiceDependencies
  onAssistantTranscript?: (text: string, itemId: string) => void
  onDiagnostic?: (diagnostic: RealtimeVoiceDiagnostic) => void
  onStatus?: (status: RealtimeVoiceStatus) => void
  onUserTranscript?: (text: string, itemId: string) => void
  sessionId: string
}): RealtimeVoiceClient {
  interface Attempt {
    assistantTranscriptBuffer: string
    audio: AudioLike | null
    channel: DataChannelLike | null
    closed: boolean
    peer: PeerConnectionLike | null
    responseActive: boolean
    settledTranscriptIds: Set<string>
    skipAssistantItemsUntilNextResponse: boolean
    stream: MediaStreamLike | null
    transcriptItems: Map<string, TranscriptItem>
    transcriptOrder: string[]
  }

  interface TranscriptItem {
    created: boolean
    previousItemId: string | null
    role: 'assistant' | 'user'
    state: 'pending' | 'ready' | 'skipped'
    text: string
  }

  let activeAttempt: Attempt | null = null
  let muted = false

  const emitStatus = (status: RealtimeVoiceStatus) => onStatus?.(status)

  const boundedIdentifier = (value: unknown) => {
    if (typeof value !== 'string') {return undefined}
    const identifier = value.trim()

    return identifier && identifier.length <= 256 ? identifier : undefined
  }

  const emitDiagnostic = (event: Record<string, unknown>) => {
    const type = typeof event.type === 'string' ? event.type.trim() : ''

    if (!type || type.length > 128) {return}

    const diagnostic: RealtimeVoiceDiagnostic = { type }
    const itemId = boundedIdentifier(event.item_id ?? event.itemId)
    const responseId = boundedIdentifier(event.response_id ?? event.responseId)
    const callId = boundedIdentifier(event.call_id ?? event.callId)

    if (itemId) {diagnostic.itemId = itemId}

    if (responseId) {diagnostic.responseId = responseId}

    if (callId) {diagnostic.callId = callId}

    try {
      onDiagnostic?.(diagnostic)
    } catch {
      // Diagnostics are optional observers and must not affect event handling.
    }
  }

  const isCurrent = (attempt: Attempt) => activeAttempt === attempt && !attempt.closed

  const sendEvent = (attempt: Attempt, event: Record<string, unknown>) => {
    if (isCurrent(attempt) && attempt.channel?.readyState === 'open') {
      attempt.channel.send(JSON.stringify(event))
    }
  }

  const flushTranscriptItems = (attempt: Attempt) => {
    while (attempt.transcriptOrder.length > 0) {
      const itemId = attempt.transcriptOrder[0]
      const item = attempt.transcriptItems.get(itemId)

      if (!item?.created || item.state === 'pending') {return}

      attempt.transcriptOrder.shift()
      attempt.transcriptItems.delete(itemId)
      attempt.settledTranscriptIds.add(itemId)

      if (item.state === 'ready') {
        if (item.role === 'assistant') {
          onAssistantTranscript?.(item.text, itemId)
        } else {
          onUserTranscript?.(item.text, itemId)
        }
      }
    }
  }

  const positionTranscriptItem = (attempt: Attempt, itemId: string) => {
    const item = attempt.transcriptItems.get(itemId)

    if (!item) {return}

    const currentIndex = attempt.transcriptOrder.indexOf(itemId)

    if (currentIndex >= 0) {attempt.transcriptOrder.splice(currentIndex, 1)}

    const previousIndex = item.previousItemId
      ? attempt.transcriptOrder.indexOf(item.previousItemId)
      : -1

    if (previousIndex >= 0) {
      attempt.transcriptOrder.splice(previousIndex + 1, 0, itemId)

      return
    }

    const childIndex = attempt.transcriptOrder.findIndex(id =>
      attempt.transcriptItems.get(id)?.previousItemId === itemId
    )

    if (childIndex >= 0) {
      attempt.transcriptOrder.splice(childIndex, 0, itemId)
    } else {
      attempt.transcriptOrder.push(itemId)
    }
  }

  const registerTranscriptItem = (
    attempt: Attempt,
    itemId: string,
    role: 'assistant' | 'user',
    previousItemId: string | null
  ) => {
    if (attempt.settledTranscriptIds.has(itemId)) {return}

    const existing = attempt.transcriptItems.get(itemId)

    attempt.transcriptItems.set(itemId, {
      created: true,
      previousItemId,
      role,
      state: existing?.state ?? 'pending',
      text: existing?.text ?? ''
    })
    positionTranscriptItem(attempt, itemId)
    flushTranscriptItems(attempt)
  }

  const completeTranscriptItem = (
    attempt: Attempt,
    itemId: string,
    role: 'assistant' | 'user',
    text: string
  ) => {
    if (attempt.settledTranscriptIds.has(itemId)) {return}

    const existing = attempt.transcriptItems.get(itemId)

    attempt.transcriptItems.set(itemId, {
      created: existing?.created ?? false,
      previousItemId: existing?.previousItemId ?? null,
      role,
      state: 'ready',
      text
    })

    if (!attempt.transcriptOrder.includes(itemId)) {attempt.transcriptOrder.push(itemId)}

    flushTranscriptItems(attempt)
  }

  const skipTranscriptItem = (attempt: Attempt, itemId: string, role: 'assistant' | 'user') => {
    if (attempt.settledTranscriptIds.has(itemId)) {return}

    const existing = attempt.transcriptItems.get(itemId)

    attempt.transcriptItems.set(itemId, {
      created: existing?.created ?? false,
      previousItemId: existing?.previousItemId ?? null,
      role,
      state: 'skipped',
      text: ''
    })

    if (!attempt.transcriptOrder.includes(itemId)) {attempt.transcriptOrder.push(itemId)}

    flushTranscriptItems(attempt)
  }

  const interruptPlayback = (attempt: Attempt) => {
    if (!isCurrent(attempt)) {return}
    attempt.audio?.pause()

    if (attempt.responseActive) {
      attempt.skipAssistantItemsUntilNextResponse = true
      sendEvent(attempt, { type: 'response.cancel' })
    }

    sendEvent(attempt, { type: 'output_audio_buffer.clear' })
    attempt.responseActive = false
    attempt.assistantTranscriptBuffer = ''

    for (const itemId of [...attempt.transcriptOrder]) {
      const item = attempt.transcriptItems.get(itemId)

      if (item?.role === 'assistant' && item.state === 'pending') {
        skipTranscriptItem(attempt, itemId, 'assistant')
      }
    }
  }

  const handleServerEvent = (attempt: Attempt, raw: string) => {
    if (!isCurrent(attempt)) {return}
    let parsed: unknown

    try {
      parsed = JSON.parse(raw) as unknown
    } catch {
      return
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {return}

    const event = parsed as Record<string, unknown>
    emitDiagnostic(event)

    if (!isCurrent(attempt)) {return}

    const type = typeof event.type === 'string' ? event.type.trim() : ''

    if (type === 'conversation.item.created' || type === 'conversation.item.added') {
      const item = event.item && typeof event.item === 'object'
        ? event.item as Record<string, unknown>
        : null

      const itemId = typeof item?.id === 'string' ? item.id : ''
      const role = item?.role

      const previousItemId = typeof event.previous_item_id === 'string'
        ? event.previous_item_id
        : null

      if (itemId && (role === 'assistant' || role === 'user')) {
        registerTranscriptItem(attempt, itemId, role, previousItemId)

        if (role === 'assistant' && attempt.skipAssistantItemsUntilNextResponse) {
          skipTranscriptItem(attempt, itemId, role)
        }
      }
    } else if (type === 'response.created') {
      attempt.skipAssistantItemsUntilNextResponse = false
      attempt.responseActive = true
      attempt.assistantTranscriptBuffer = ''
      emitStatus('assistant-speaking')
    } else if (type === 'response.output_audio_transcript.delta') {
      attempt.assistantTranscriptBuffer += typeof event.delta === 'string' ? event.delta : ''
    } else if (type === 'response.output_audio_transcript.done') {
      const transcript = String(event.transcript || attempt.assistantTranscriptBuffer).trim()
      attempt.assistantTranscriptBuffer = ''
      const itemId = typeof event.item_id === 'string' ? event.item_id : ''

      if (itemId) {
        if (transcript) {
          completeTranscriptItem(attempt, itemId, 'assistant', transcript)
        } else {
          skipTranscriptItem(attempt, itemId, 'assistant')
        }
      }
    } else if (type === 'response.done') {
      attempt.responseActive = false
      emitStatus('listening')
    } else if (type === 'input_audio_buffer.speech_started') {
      interruptPlayback(attempt)
      emitStatus('user-speaking')
    } else if (type === 'input_audio_buffer.speech_stopped') {
      void attempt.audio?.play().catch(() => undefined)
      emitStatus('listening')
    } else if (type === 'conversation.item.input_audio_transcription.completed') {
      const transcript = String(event.transcript || '').trim()
      const itemId = typeof event.item_id === 'string' ? event.item_id : ''

      if (itemId) {
        if (transcript) {
          completeTranscriptItem(attempt, itemId, 'user', transcript)
        } else {
          skipTranscriptItem(attempt, itemId, 'user')
        }
      }
    } else if (type === 'conversation.item.input_audio_transcription.failed') {
      const itemId = typeof event.item_id === 'string' ? event.item_id : ''

      if (itemId) {skipTranscriptItem(attempt, itemId, 'user')}
    }
  }

  const cleanupAttempt = (attempt: Attempt) => {
    if (attempt.closed) {return}
    attempt.closed = true

    for (const track of attempt.stream?.getTracks() ?? []) {track.stop()}
    attempt.stream = null
    attempt.channel?.close()
    attempt.channel = null
    attempt.peer?.close()
    attempt.peer = null
    attempt.audio?.pause()

    if (attempt.audio) {attempt.audio.srcObject = null}
    attempt.audio = null
  }

  const end = async () => {
    const attempt = activeAttempt
    activeAttempt = null

    if (attempt) {cleanupAttempt(attempt)}
    emitStatus('idle')
  }

  return {
    async start() {
      const previous = activeAttempt
      activeAttempt = null

      if (previous) {cleanupAttempt(previous)}

      const attempt: Attempt = {
        assistantTranscriptBuffer: '',
        audio: null,
        channel: null,
        closed: false,
        peer: null,
        responseActive: false,
        settledTranscriptIds: new Set(),
        skipAssistantItemsUntilNextResponse: false,
        stream: null,
        transcriptItems: new Map(),
        transcriptOrder: []
      }

      activeAttempt = attempt
      emitStatus('connecting')

      try {
        const grant = await dependencies.mintSession(sessionId)

        if (!isCurrent(attempt)) {return}

        if (!grant.clientSecret || grant.ownerSessionId !== sessionId) {
          throw new Error('Realtime session was not bound to the active conversation')
        }

        const acquiredStream = await dependencies.getUserMedia({
          audio: {
            autoGainControl: true,
            echoCancellation: true,
            noiseSuppression: true
          }
        })

        if (!isCurrent(attempt)) {
          for (const track of acquiredStream.getTracks()) {track.stop()}

          return
        }

        attempt.stream = acquiredStream

        for (const track of attempt.stream.getAudioTracks()) {track.enabled = !muted}
        attempt.peer = dependencies.createPeerConnection()
        attempt.audio = dependencies.createAudio()
        attempt.audio.autoplay = true

        attempt.peer.ontrack = event => {
          if (isCurrent(attempt) && attempt.audio) {
            attempt.audio.srcObject = event.streams[0] ?? null
          }
        }

        attempt.channel = attempt.peer.createDataChannel('oai-events')
        attempt.channel.addEventListener('message', event => handleServerEvent(attempt, event.data))

        const audioTrack = attempt.stream.getAudioTracks()[0]

        if (!audioTrack) {throw new Error('Microphone did not provide an audio track')}
        attempt.peer.addTrack(audioTrack, attempt.stream)

        const offer = await attempt.peer.createOffer()

        if (!isCurrent(attempt)) {return}
        await attempt.peer.setLocalDescription(offer)

        if (!isCurrent(attempt)) {return}
        const answerSdp = await dependencies.exchangeSdp(offer.sdp ?? '', grant.clientSecret, grant.model)

        if (!isCurrent(attempt)) {return}
        await attempt.peer.setRemoteDescription({ type: 'answer', sdp: answerSdp })

        if (!isCurrent(attempt)) {return}
        emitStatus('listening')
      } catch (error) {
        if (!isCurrent(attempt)) {
          cleanupAttempt(attempt)

          return
        }

        activeAttempt = null
        cleanupAttempt(attempt)
        emitStatus('error')
        throw error
      }
    },
    end,
    interrupt() {
      const attempt = activeAttempt

      if (attempt) {
        interruptPlayback(attempt)
        emitStatus('listening')
      }
    },
    setMuted(mutedValue) {
      const shouldMute = mutedValue
      muted = shouldMute

      for (const track of activeAttempt?.stream?.getAudioTracks() ?? []) {track.enabled = !shouldMute}
    }
  }
}
