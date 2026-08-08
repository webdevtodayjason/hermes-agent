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
  pendingProgress?: RealtimeCanonicalProgress[]
  pendingResults?: RealtimeCanonicalResult[]
  providerSessionId?: string | null
}

export interface RealtimeCanonicalProgress {
  correlationId: string
  status: 'queued' | 'running' | 'approval_pending' | 'failed' | 'interrupted' | 'rejected'
}

export interface RealtimeCanonicalResult {
  correlationId: string
  deliveryId: string
  providerSessionId: string
  text: string
}

export type RealtimeCanonicalResultStage =
  | 'consumed'
  | 'narration_started'
  | 'narration_completed'
  | 'narration_interrupted'
  | 'narration_failed'

export type RealtimeCanonicalResultStageResponse = RealtimeCanonicalResult[] | void

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
  announceCanonicalProgress(progress: RealtimeCanonicalProgress): boolean
  start(): Promise<void>
  end(): Promise<void>
  interrupt(): void
  narrateCanonicalResult(result: RealtimeCanonicalResult): boolean
  setMuted(muted: boolean): void
}

export interface RealtimeVoiceDiagnostic {
  type: string
  itemId?: string
  responseId?: string
  callId?: string
}

export interface RealtimeIntentDispatchResult {
  correlationId: string
  status: 'queued'
}

export interface BackendRealtimeSessionGrant {
  client_secret: string
  expires_at?: number | null
  model: string
  owner_session_id: string
  pending_intents?: Array<{
    correlation_id: string
    status: RealtimeCanonicalProgress['status']
  }>
  pending_results?: Array<{
    correlation_id: string
    delivery_id: string
    provider_session_id: string
    status: 'completed'
    text: string
    truncated: boolean
  }>
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
        pendingProgress: (grant.pending_intents ?? []).map(progress => ({
          correlationId: progress.correlation_id,
          status: progress.status
        })),
        pendingResults: (grant.pending_results ?? []).map(result => ({
          correlationId: result.correlation_id,
          deliveryId: result.delivery_id,
          providerSessionId: result.provider_session_id,
          text: result.text
        })),
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
  dispatchResultTimeoutMs = 45_000,
  onAssistantTranscript,
  onCanonicalProgress,
  onCanonicalResultStage,
  onCanonicalResultStageError,
  onDiagnostic,
  onIntentDispatch,
  onStatus,
  onUserTranscriptDelta,
  onUserTranscript,
  sessionId
}: {
  dependencies: RealtimeVoiceDependencies
  /** How long a perform_internal_work call stays open awaiting its canonical
   *  result before settling as "working" and falling back to narration delivery. */
  dispatchResultTimeoutMs?: number
  onAssistantTranscript?: (text: string, itemId: string) => void
  onCanonicalProgress?: (progress: RealtimeCanonicalProgress) => void
  onCanonicalResultStage?: (
    result: RealtimeCanonicalResult,
    stage: RealtimeCanonicalResultStage
  ) => Promise<RealtimeCanonicalResultStageResponse> | RealtimeCanonicalResultStageResponse
  onCanonicalResultStageError?: (error: unknown) => void
  onDiagnostic?: (diagnostic: RealtimeVoiceDiagnostic) => void
  onIntentDispatch?: (
    intent: string,
    callId: string,
    itemId: string
  ) => Promise<RealtimeIntentDispatchResult>
  onStatus?: (status: RealtimeVoiceStatus) => void
  /** Ephemeral, renderer-only cumulative input transcription for live captions. */
  onUserTranscriptDelta?: (text: string, itemId: string) => void
  onUserTranscript?: (text: string, itemId: string) => void
  sessionId: string
}): RealtimeVoiceClient {
  interface Attempt {
    activeNonNarrationCreateEventId: string | null
    activeNonNarrationResponseId: string | null
    activeNonNarrationResponseKind: 'automatic' | 'dispatch' | 'status' | 'unknown' | null
    activeNarrationCreateEventId: string | null
    activeNarrationResult: RealtimeCanonicalResult | null
    activeNarrationResponseId: string | null
    activeStatusAnnouncement: string | null
    announcedStatusKeys: Set<string>
    assistantTranscriptBuffer: string
    audio: AudioLike | null
    channel: DataChannelLike | null
    closed: boolean
    injectedNarrationItemIds: Set<string>
    latestUserTranscriptItemId: string | null
    narratedCorrelationIds: Set<string>
    narrationAttemptsByCorrelation: Map<string, number>
    narrationActive: boolean
    narrationBindingTimeout: ReturnType<typeof setTimeout> | null
    narrationQueue: Array<RealtimeCanonicalResult & { toolReturnCallId?: string }>
    pendingDispatchCalls: Map<string, { callId: string; timer: ReturnType<typeof setTimeout> }>
    nonNarrationBindingTimeout: ReturnType<typeof setTimeout> | null
    expectedNonNarrationResponseKey: string | null
    expectedNonNarrationResponseKind: 'dispatch' | 'status' | null
    peer: PeerConnectionLike | null
    providerSessionId: string | null
    responseActive: boolean
    responseSupersededForNarration: boolean
    settledFunctionCallIds: Set<string>
    settledTranscriptIds: Set<string>
    stageAckChains: Map<string, Promise<unknown>>
    statusAnnouncementQueue: Array<{
      inputText: string
      instructions: string
      itemId: string
      key: string
    }>
    skipAssistantItemsUntilNextResponse: boolean
    stream: MediaStreamLike | null
    transcriptItems: Map<string, TranscriptItem>
    transcriptOrder: string[]
    userSpeaking: boolean
    userTranscriptBuffers: Map<string, string>
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

  const emitUserTranscriptDelta = (text: string, itemId: string) => {
    try {
      onUserTranscriptDelta?.(text, itemId)
    } catch {
      // Captions are an optional presentation observer. They must never block
      // authoritative finalized transcript delivery.
    }
  }

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

  const emitCanonicalResultStageError = (error: unknown) => {
    try {
      onCanonicalResultStageError?.(error)
    } catch {
      // Error observers are never allowed to suppress cleanup or fallback.
    }
  }

  const sendEvent = (attempt: Attempt, event: Record<string, unknown>) => {
    if (isCurrent(attempt) && attempt.channel?.readyState === 'open') {
      attempt.channel.send(JSON.stringify(event))
    }
  }

  const reportCanonicalResultStage = (
    attempt: Attempt,
    result: RealtimeCanonicalResult,
    stage: RealtimeCanonicalResultStage
  ) => {
    const previous = attempt.stageAckChains.get(result.deliveryId) ?? Promise.resolve()

    const next = previous.catch(() => undefined).then(async () => {
      let pendingResults: RealtimeCanonicalResultStageResponse = undefined

      try {
        let lastError: unknown

        for (let attemptNumber = 1; attemptNumber <= 2; attemptNumber += 1) {
          try {
            pendingResults = await onCanonicalResultStage?.(result, stage)
            lastError = undefined
            break
          } catch (error) {
            lastError = error
          }
        }

        if (lastError !== undefined) {throw lastError}
      } catch (error) {
        emitCanonicalResultStageError(error)

        if (isCurrent(attempt)) {
          if (attempt.activeNarrationResult?.deliveryId === result.deliveryId) {
            clearNarrationBindingTimeout(attempt)
            attempt.activeNarrationCreateEventId = null
            attempt.activeNarrationResult = null
            attempt.activeNarrationResponseId = null
            attempt.narrationActive = false
            attempt.responseActive = Boolean(attempt.activeNonNarrationResponseId)
            sendEvent(attempt, { type: 'response.cancel' })
            sendEvent(attempt, { type: 'output_audio_buffer.clear' })
          }

          const text = 'I could not read that result aloud. It is still in the chat.'

          queueStatusAnnouncement(attempt, {
            inputText: `Private status update: ${text}`,
            instructions: `Say exactly: "${text}" Do not add explanation or call tools.`,
            itemId: `evie-status-narration-failed-${result.correlationId}`,
            key: `narration-failed-${result.correlationId}`
          })
        }

        return
      }

      if (stage !== 'narration_failed' || !isCurrent(attempt)) {return}
      const attempts = attempt.narrationAttemptsByCorrelation.get(result.correlationId) ?? 1
      let retryAccepted = false

      if (attempts < 2) {
        attempt.narratedCorrelationIds.delete(result.correlationId)

        for (const pendingResult of pendingResults ?? []) {
          if (pendingResult.correlationId === result.correlationId) {
            retryAccepted = acceptCanonicalResult(attempt, pendingResult) || retryAccepted
          }
        }
      }

      if (!retryAccepted) {
        const text = 'I could not read that result aloud. It is still in the chat.'

        queueStatusAnnouncement(attempt, {
          inputText: `Private status update: ${text}`,
          instructions: `Say exactly: "${text}" Do not add explanation or call tools.`,
          itemId: `evie-status-narration-failed-${result.correlationId}`,
          key: `narration-failed-${result.correlationId}`
        })
      }
    })

    attempt.stageAckChains.set(result.deliveryId, next)
    void next.catch(emitCanonicalResultStageError)
  }

  const clearNarrationBindingTimeout = (attempt: Attempt) => {
    if (attempt.narrationBindingTimeout) {
      clearTimeout(attempt.narrationBindingTimeout)
      attempt.narrationBindingTimeout = null
    }
  }

  const clearNonNarrationBindingTimeout = (attempt: Attempt) => {
    if (attempt.nonNarrationBindingTimeout) {
      clearTimeout(attempt.nonNarrationBindingTimeout)
      attempt.nonNarrationBindingTimeout = null
    }
  }

  const releaseExpectedNonNarrationResponse = (attempt: Attempt) => {
    const wasStatus = attempt.expectedNonNarrationResponseKind === 'status'

    clearNonNarrationBindingTimeout(attempt)
    attempt.activeNonNarrationCreateEventId = null
    attempt.expectedNonNarrationResponseKey = null
    attempt.expectedNonNarrationResponseKind = null
    if (wasStatus) {attempt.activeStatusAnnouncement = null}
    attempt.responseActive = Boolean(
      attempt.activeNonNarrationResponseId
      || attempt.activeNarrationResult
    )
    emitStatus(attempt.responseActive ? 'assistant-speaking' : 'listening')
    maybeStartNarration(attempt)
  }

  const expectNonNarrationResponse = (
    attempt: Attempt,
    kind: 'dispatch' | 'status',
    key: string
  ) => {
    clearNonNarrationBindingTimeout(attempt)
    attempt.expectedNonNarrationResponseKind = kind
    attempt.expectedNonNarrationResponseKey = key
    attempt.activeNonNarrationCreateEventId = `hermes-${kind}-${key}`
    attempt.nonNarrationBindingTimeout = setTimeout(() => {
      if (
        isCurrent(attempt)
        && attempt.expectedNonNarrationResponseKind === kind
        && attempt.expectedNonNarrationResponseKey === key
      ) {
        releaseExpectedNonNarrationResponse(attempt)
      }
    }, 10_000)
  }

  const failActiveNarration = (attempt: Attempt) => {
    const failedNarration = attempt.activeNarrationResult

    if (!failedNarration) {return}
    clearNarrationBindingTimeout(attempt)
    attempt.activeNarrationCreateEventId = null
    attempt.activeNarrationResult = null
    attempt.activeNarrationResponseId = null
    attempt.activeStatusAnnouncement = null
    attempt.responseActive = Boolean(attempt.activeNonNarrationResponseId)
    attempt.responseSupersededForNarration = false
    attempt.narrationActive = false
    attempt.skipAssistantItemsUntilNextResponse = false
    reportCanonicalResultStage(attempt, failedNarration, 'narration_failed')
    emitStatus('listening')
    maybeStartNarration(attempt)
  }

  const maybeStartNarration = (attempt: Attempt) => {
    if (
      !isCurrent(attempt)
      || attempt.responseActive
      || attempt.narrationActive
      || attempt.userSpeaking
      || attempt.channel?.readyState !== 'open'
    ) {return}

    const next = attempt.narrationQueue.shift()

    if (!next) {
      const announcement = attempt.statusAnnouncementQueue.shift()

      if (!announcement) {return}
      attempt.activeStatusAnnouncement = announcement.key
      attempt.injectedNarrationItemIds.add(announcement.itemId)
      attempt.responseActive = true
      attempt.skipAssistantItemsUntilNextResponse = true
      expectNonNarrationResponse(attempt, 'status', announcement.key)
      sendEvent(attempt, {
        type: 'conversation.item.create',
        item: {
          id: announcement.itemId,
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: announcement.inputText
          }]
        }
      })
      sendEvent(attempt, {
        event_id: attempt.activeNonNarrationCreateEventId,
        type: 'response.create',
        response: {
          instructions: announcement.instructions,
          metadata: {
            hermes_voice_response_kind: 'status',
            hermes_voice_response_key: announcement.key
          },
          tool_choice: 'none'
        }
      })

      return
    }

    attempt.activeNarrationCreateEventId = `hermes-narration-${next.deliveryId}`
    attempt.activeNarrationResult = next
    attempt.narrationActive = true
    attempt.responseActive = true
    attempt.skipAssistantItemsUntilNextResponse = true

    if (!next.toolReturnCallId) {
      const itemId = `evie-result-${next.correlationId}-${next.deliveryId}`

      attempt.injectedNarrationItemIds.add(itemId)
      sendEvent(attempt, {
        type: 'conversation.item.create',
        item: {
          id: itemId,
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `Verified result from your internal work:\n${next.text}`
            }
          ]
        }
      })
    }

    sendEvent(attempt, {
      event_id: attempt.activeNarrationCreateEventId,
      type: 'response.create',
      response: {
        instructions: next.toolReturnCallId
          ? 'Your internal work has returned its verified result as the tool output. The task is complete; answer from that result once, briefly, in your normal first-person voice as Evie. Do not re-check it, call tools, or start more work.'
          : 'State this verified result once, faithfully and briefly, in your normal first-person voice as Evie. Do not call tools or start more work.',
        metadata: {
          hermes_voice_delivery_id: next.deliveryId
        },
        tool_choice: 'none'
      }
    })
    attempt.narrationBindingTimeout = setTimeout(() => {
      if (
        isCurrent(attempt)
        && attempt.activeNarrationResult?.deliveryId === next.deliveryId
        && !attempt.activeNarrationResponseId
      ) {
        failActiveNarration(attempt)
      }
    }, 10_000)
  }

  function acceptCanonicalResult(attempt: Attempt, result: RealtimeCanonicalResult) {
    const correlationId = boundedIdentifier(result.correlationId)
    const deliveryId = boundedIdentifier(result.deliveryId)
    const providerSessionId = boundedIdentifier(result.providerSessionId)
    const visibleText = result.text.trim()

    if (
      !isCurrent(attempt)
      || !correlationId
      || !deliveryId
      || !providerSessionId
      || providerSessionId !== attempt.providerSessionId
      || !visibleText
      || visibleText.length > 4_000
      || attempt.narratedCorrelationIds.has(correlationId)
      || (attempt.narrationAttemptsByCorrelation.get(correlationId) ?? 0) >= 2
    ) {return false}

    const pendingCall = attempt.pendingDispatchCalls.get(correlationId)
    const accepted: RealtimeCanonicalResult & { toolReturnCallId?: string } = {
      correlationId,
      deliveryId,
      providerSessionId,
      text: visibleText
    }

    if (pendingCall) {
      clearTimeout(pendingCall.timer)
      attempt.pendingDispatchCalls.delete(correlationId)
      accepted.toolReturnCallId = pendingCall.callId
      // The result becomes the open call's return value NOW, so the model's
      // context marks the task complete even before the spoken answer starts.
      sendEvent(attempt, {
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: pendingCall.callId,
          output: JSON.stringify({
            correlation_id: correlationId,
            status: 'complete',
            result: visibleText
          })
        }
      })
    }

    attempt.narratedCorrelationIds.add(correlationId)
    attempt.narrationAttemptsByCorrelation.set(
      correlationId,
      (attempt.narrationAttemptsByCorrelation.get(correlationId) ?? 0) + 1
    )
    attempt.narrationQueue.push(accepted)
    reportCanonicalResultStage(attempt, accepted, 'consumed')

    if (
      attempt.responseActive
      && !attempt.narrationActive
      && !attempt.responseSupersededForNarration
    ) {
      attempt.responseSupersededForNarration = true
      attempt.skipAssistantItemsUntilNextResponse = true
      attempt.audio?.pause()
      sendEvent(attempt, { type: 'response.cancel' })
      sendEvent(attempt, { type: 'output_audio_buffer.clear' })
    }

    maybeStartNarration(attempt)

    return true
  }

  function queueStatusAnnouncement(
    attempt: Attempt,
    announcement: { inputText: string; instructions: string; itemId: string; key: string }
  ) {
    if (!isCurrent(attempt) || attempt.announcedStatusKeys.has(announcement.key)) {return false}
    attempt.announcedStatusKeys.add(announcement.key)
    attempt.statusAnnouncementQueue.push(announcement)
    maybeStartNarration(attempt)

    return true
  }

  const handleIntentDispatch = async (attempt: Attempt, event: Record<string, unknown>) => {
    if (attempt.narrationActive || event.name !== 'perform_internal_work' || !onIntentDispatch) {return}
    const callId = boundedIdentifier(event.call_id)
    const itemId = boundedIdentifier(event.item_id)
    const rawArguments = event.arguments

    if (!callId || !itemId || typeof rawArguments !== 'string' || rawArguments.length > 8_192) {return}

    let parsedArguments: unknown

    try {
      parsedArguments = JSON.parse(rawArguments) as unknown
    } catch {
      return
    }

    if (!parsedArguments || typeof parsedArguments !== 'object' || Array.isArray(parsedArguments)) {return}
    const args = parsedArguments as Record<string, unknown>
    const intent = typeof args.intent === 'string' ? args.intent.trim() : ''

    if (Object.keys(args).length !== 1 || !intent || intent.length > 4_000 || intent.startsWith('/')) {return}

    if (attempt.settledFunctionCallIds.has(callId)) {return}
    attempt.settledFunctionCallIds.add(callId)

    let output: Record<string, unknown>
    let openCorrelationId: string | null = null

    try {
      const result = await onIntentDispatch(intent, callId, itemId)
      output = { correlation_id: result.correlationId, status: result.status }

      if (result.status === 'queued') {openCorrelationId = result.correlationId}
    } catch {
      output = { correlation_id: callId, status: 'rejected' }
    }

    if (!isCurrent(attempt)) {return}

    // Chat-supervisor convergence: a successfully queued dispatch holds the
    // tool call OPEN so the canonical result returns as THIS call's output and
    // lands in the model's own reasoning. Only rejected dispatches settle now;
    // the bounded-await timeout below settles long tasks as "working" and hands
    // delivery back to the narration fallback.
    if (openCorrelationId) {
      const correlationId = openCorrelationId
      const timer = setTimeout(() => {
        const pending = attempt.pendingDispatchCalls.get(correlationId)

        if (!pending || !isCurrent(attempt)) {return}
        attempt.pendingDispatchCalls.delete(correlationId)
        settleDispatchCall(attempt, pending.callId, {
          correlation_id: correlationId,
          status: 'working'
        })
      }, dispatchResultTimeoutMs)

      attempt.pendingDispatchCalls.set(correlationId, { callId, timer })

      return
    }

    settleDispatchCall(attempt, callId, output)
  }

  function settleDispatchCall(
    attempt: Attempt,
    callId: string,
    output: Record<string, unknown>
  ) {
    if (!isCurrent(attempt)) {return}
    sendEvent(attempt, {
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify(output)
      }
    })
    expectNonNarrationResponse(attempt, 'dispatch', callId)
    attempt.responseActive = true
    sendEvent(attempt, {
      event_id: attempt.activeNonNarrationCreateEventId,
      type: 'response.create',
      response: {
        metadata: {
          hermes_voice_response_kind: 'dispatch',
          hermes_voice_response_key: callId
        }
      }
    })
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

  const markNarrationInterrupted = (attempt: Attempt) => {
    const interruptedNarration = attempt.activeNarrationResult

    if (interruptedNarration) {
      clearNarrationBindingTimeout(attempt)
      attempt.activeNarrationCreateEventId = null
      attempt.activeNarrationResult = null
      attempt.activeNarrationResponseId = null
      attempt.narrationActive = false
      reportCanonicalResultStage(attempt, interruptedNarration, 'narration_interrupted')
    }
  }

  const interruptPlayback = (attempt: Attempt) => {
    if (!isCurrent(attempt)) {return}
    attempt.audio?.pause()
    markNarrationInterrupted(attempt)

    if (attempt.responseActive) {
      attempt.skipAssistantItemsUntilNextResponse = true
      sendEvent(attempt, { type: 'response.cancel' })
    }

    sendEvent(attempt, { type: 'output_audio_buffer.clear' })
    clearNonNarrationBindingTimeout(attempt)
    attempt.activeNonNarrationCreateEventId = null
    attempt.activeNonNarrationResponseId = null
    attempt.activeNonNarrationResponseKind = null
    attempt.expectedNonNarrationResponseKey = null
    attempt.expectedNonNarrationResponseKind = null
    attempt.activeStatusAnnouncement = null
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

    if (type === 'response.function_call_arguments.done') {
      void handleIntentDispatch(attempt, event)
    } else if (type === 'conversation.item.created' || type === 'conversation.item.added') {
      const item = event.item && typeof event.item === 'object'
        ? event.item as Record<string, unknown>
        : null

      const itemId = typeof item?.id === 'string' ? item.id : ''
      const role = item?.role

      const previousItemId = typeof event.previous_item_id === 'string'
        ? event.previous_item_id
        : null

      if (itemId && (role === 'assistant' || role === 'user')) {
        if (attempt.injectedNarrationItemIds.delete(itemId)) {
          attempt.settledTranscriptIds.add(itemId)

          return
        }

        registerTranscriptItem(attempt, itemId, role, previousItemId)

        if (role === 'user') {
          attempt.latestUserTranscriptItemId = itemId
        }

        if (role === 'assistant' && attempt.skipAssistantItemsUntilNextResponse) {
          skipTranscriptItem(attempt, itemId, role)
        }
      }
    } else if (type === 'response.created') {
      const response = event.response && typeof event.response === 'object'
        ? event.response as Record<string, unknown>
        : null
      const responseId = typeof response?.id === 'string' ? response.id : null
      const metadata = response?.metadata && typeof response.metadata === 'object'
        ? response.metadata as Record<string, unknown>
        : null
      const responseDeliveryId = typeof metadata?.hermes_voice_delivery_id === 'string'
        ? metadata.hermes_voice_delivery_id
        : null
      const responseKind = metadata?.hermes_voice_response_kind
      const responseKey = metadata?.hermes_voice_response_key
      let matchedOwnedResponse = false

      if (
        attempt.activeNarrationResult
        && attempt.narrationActive
        && !attempt.activeNarrationResponseId
        && responseId
        && responseDeliveryId === attempt.activeNarrationResult.deliveryId
      ) {
        attempt.activeNarrationResponseId = responseId
        clearNarrationBindingTimeout(attempt)
        attempt.activeNarrationCreateEventId = null
        reportCanonicalResultStage(attempt, attempt.activeNarrationResult, 'narration_started')
        matchedOwnedResponse = true
      } else if (responseId && !attempt.activeNonNarrationResponseId) {
        const expectedKind = attempt.expectedNonNarrationResponseKind
        const expectedKey = attempt.expectedNonNarrationResponseKey

        if (
          expectedKind
          && responseKind === expectedKind
          && responseKey === expectedKey
        ) {
          attempt.activeNonNarrationResponseId = responseId
          attempt.activeNonNarrationResponseKind = expectedKind
          clearNonNarrationBindingTimeout(attempt)
          attempt.activeNonNarrationCreateEventId = null
          attempt.expectedNonNarrationResponseKey = null
          attempt.expectedNonNarrationResponseKind = null
          matchedOwnedResponse = true
        } else if (!expectedKind) {
          attempt.activeNonNarrationResponseId = responseId
          attempt.activeNonNarrationResponseKind = 'automatic'
          matchedOwnedResponse = true
        } else {
          // An unrelated response is still a provider-side blocker, but it must
          // not inherit the expected response's transcript or lifecycle state.
          attempt.activeNonNarrationResponseId = responseId
          attempt.activeNonNarrationResponseKind = 'unknown'
          attempt.responseActive = true
        }
      }

      if (!matchedOwnedResponse) {return}
      attempt.skipAssistantItemsUntilNextResponse = attempt.narrationActive
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
      const narrationResult = attempt.activeNarrationResult
      const response = event.response && typeof event.response === 'object'
        ? event.response as Record<string, unknown>
        : null
      const responseStatus = typeof response?.status === 'string' ? response.status : 'completed'
      const responseId = typeof response?.id === 'string' ? response.id : null

      if (narrationResult && responseId === attempt.activeNarrationResponseId) {
        clearNarrationBindingTimeout(attempt)
        attempt.activeNarrationCreateEventId = null
        attempt.activeNarrationResult = null
        attempt.activeNarrationResponseId = null
        attempt.narrationActive = false
        attempt.skipAssistantItemsUntilNextResponse = false
        attempt.responseActive = Boolean(
          attempt.activeNonNarrationResponseId
          || attempt.expectedNonNarrationResponseKind
        )
        reportCanonicalResultStage(
          attempt,
          narrationResult,
          responseStatus === 'failed'
            ? 'narration_failed'
            : responseStatus === 'cancelled'
              ? 'narration_interrupted'
              : 'narration_completed'
        )
        emitStatus(attempt.responseActive ? 'assistant-speaking' : 'listening')
        maybeStartNarration(attempt)

        return
      }

      if (!responseId || responseId !== attempt.activeNonNarrationResponseId) {return}
      const completedKind = attempt.activeNonNarrationResponseKind

      attempt.activeNonNarrationResponseId = null
      attempt.activeNonNarrationResponseKind = null
      if (completedKind === 'status') {attempt.activeStatusAnnouncement = null}
      if (!attempt.expectedNonNarrationResponseKind) {
        attempt.responseSupersededForNarration = false
      }
      attempt.responseActive = Boolean(
        attempt.activeNarrationResult
        || attempt.expectedNonNarrationResponseKind
      )
      attempt.skipAssistantItemsUntilNextResponse = attempt.narrationActive
      emitStatus(attempt.responseActive ? 'assistant-speaking' : 'listening')
      maybeStartNarration(attempt)
    } else if (type === 'error') {
      const providerError = event.error && typeof event.error === 'object'
        ? event.error as Record<string, unknown>
        : null
      const failedEventId = typeof providerError?.event_id === 'string'
        ? providerError.event_id
        : null

      if (
        attempt.activeNarrationResult
        && !attempt.activeNarrationResponseId
        && failedEventId
        && failedEventId === attempt.activeNarrationCreateEventId
      ) {
        failActiveNarration(attempt)

        return
      }
      if (
        attempt.expectedNonNarrationResponseKind
        && failedEventId
        && failedEventId === attempt.activeNonNarrationCreateEventId
      ) {
        releaseExpectedNonNarrationResponse(attempt)

        return
      }
      emitStatus('error')

      return
    } else if (type === 'response.failed') {
      const failedResponse =
        typeof event.response === 'object' && event.response !== null
          ? event.response as Record<string, unknown>
          : null
      const failedResponseId =
        typeof failedResponse?.id === 'string'
          ? failedResponse.id
          : null
      const failedMetadata = failedResponse?.metadata && typeof failedResponse.metadata === 'object'
        ? failedResponse.metadata as Record<string, unknown>
        : null
      const failedDeliveryId = typeof failedMetadata?.hermes_voice_delivery_id === 'string'
        ? failedMetadata.hermes_voice_delivery_id
        : null

      const narrationResult = attempt.activeNarrationResult

      if (
        narrationResult
        && !attempt.activeNarrationResponseId
        && failedDeliveryId === narrationResult.deliveryId
      ) {
        failActiveNarration(attempt)

        return
      }

      if (narrationResult && failedResponseId === attempt.activeNarrationResponseId) {
        clearNarrationBindingTimeout(attempt)
        attempt.activeNarrationCreateEventId = null
        attempt.activeNarrationResult = null
        attempt.activeNarrationResponseId = null
        attempt.narrationActive = false
        attempt.responseActive = Boolean(
          attempt.activeNonNarrationResponseId
          || attempt.expectedNonNarrationResponseKind
        )
        reportCanonicalResultStage(attempt, narrationResult, 'narration_failed')
        emitStatus(attempt.responseActive ? 'assistant-speaking' : 'error')
        maybeStartNarration(attempt)

        return
      }

      if (!failedResponseId || failedResponseId !== attempt.activeNonNarrationResponseId) {
        return
      }
      const failedKind = attempt.activeNonNarrationResponseKind

      attempt.activeNonNarrationResponseId = null
      attempt.activeNonNarrationResponseKind = null
      if (failedKind === 'status') {attempt.activeStatusAnnouncement = null}
      if (!attempt.expectedNonNarrationResponseKind) {
        attempt.responseSupersededForNarration = false
      }
      attempt.responseActive = Boolean(
        attempt.activeNarrationResult
        || attempt.expectedNonNarrationResponseKind
      )
      emitStatus(attempt.responseActive ? 'assistant-speaking' : 'error')
      maybeStartNarration(attempt)
    } else if (type === 'input_audio_buffer.speech_started') {
      attempt.latestUserTranscriptItemId = null
      attempt.userSpeaking = true
      interruptPlayback(attempt)
      emitStatus('user-speaking')
    } else if (type === 'input_audio_buffer.speech_stopped') {
      attempt.userSpeaking = false
      void attempt.audio?.play().catch(() => undefined)
      emitStatus('listening')
      maybeStartNarration(attempt)
    } else if (type === 'conversation.item.input_audio_transcription.delta') {
      const itemId = typeof event.item_id === 'string' ? event.item_id : ''
      const delta = typeof event.delta === 'string' ? event.delta : ''

      if (itemId && delta && !attempt.settledTranscriptIds.has(itemId)) {
        const transcript = `${attempt.userTranscriptBuffers.get(itemId) ?? ''}${delta}`
        attempt.userTranscriptBuffers.set(itemId, transcript)

        if (attempt.latestUserTranscriptItemId === itemId) {
          emitUserTranscriptDelta(transcript, itemId)
        }
      }
    } else if (type === 'conversation.item.input_audio_transcription.completed') {
      const itemId = typeof event.item_id === 'string' ? event.item_id : ''

      if (attempt.settledTranscriptIds.has(itemId)) {return}
      const transcript = String(event.transcript || '').trim()
      attempt.userTranscriptBuffers.delete(itemId)

      if (itemId) {
        if (transcript) {
          if (attempt.latestUserTranscriptItemId === itemId) {
            emitUserTranscriptDelta(transcript, itemId)
          }

          if (!isCurrent(attempt)) {return}
          completeTranscriptItem(attempt, itemId, 'user', transcript)
        } else {
          if (attempt.latestUserTranscriptItemId === itemId) {
            emitUserTranscriptDelta('', itemId)
          }

          if (!isCurrent(attempt)) {return}
          skipTranscriptItem(attempt, itemId, 'user')
        }
      }
    } else if (type === 'conversation.item.input_audio_transcription.failed') {
      const itemId = typeof event.item_id === 'string' ? event.item_id : ''

      if (attempt.settledTranscriptIds.has(itemId)) {return}

      if (itemId) {
        attempt.userTranscriptBuffers.delete(itemId)

        if (attempt.latestUserTranscriptItemId === itemId) {
          emitUserTranscriptDelta('', itemId)
        }

        if (!isCurrent(attempt)) {return}
        skipTranscriptItem(attempt, itemId, 'user')
      }
    }
  }

  const cleanupAttempt = (attempt: Attempt) => {
    if (attempt.closed) {return}
    attempt.closed = true
    clearNarrationBindingTimeout(attempt)

    for (const pending of attempt.pendingDispatchCalls.values()) {clearTimeout(pending.timer)}
    attempt.pendingDispatchCalls.clear()

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

    if (attempt) {
      markNarrationInterrupted(attempt)
      activeAttempt = null
      cleanupAttempt(attempt)
    }

    emitStatus('idle')
  }

  return {
    announceCanonicalProgress(progress) {
      const attempt = activeAttempt
      const correlationId = boundedIdentifier(progress.correlationId)

      if (!attempt || !correlationId || progress.status !== 'approval_pending') {return false}

      const text = 'I need your approval before I can continue.'

      return queueStatusAnnouncement(attempt, {
        inputText: `Private status update: ${text}`,
        instructions: `Say exactly: "${text}" Do not add explanation or call tools.`,
        itemId: `evie-status-approval-pending-${correlationId}`,
        key: `progress-${correlationId}-approval-pending`
      })
    },
    async start() {
      const previous = activeAttempt

      if (previous) {
        markNarrationInterrupted(previous)
        activeAttempt = null
        cleanupAttempt(previous)
      }

      const attempt: Attempt = {
        activeNonNarrationCreateEventId: null,
        activeNonNarrationResponseId: null,
        activeNonNarrationResponseKind: null,
        activeNarrationCreateEventId: null,
        activeNarrationResult: null,
        activeNarrationResponseId: null,
        activeStatusAnnouncement: null,
        announcedStatusKeys: new Set(),
        assistantTranscriptBuffer: '',
        audio: null,
        channel: null,
        closed: false,
        injectedNarrationItemIds: new Set(),
        latestUserTranscriptItemId: null,
        narratedCorrelationIds: new Set(),
        narrationAttemptsByCorrelation: new Map(),
        narrationActive: false,
        narrationBindingTimeout: null,
        narrationQueue: [],
        pendingDispatchCalls: new Map(),
        nonNarrationBindingTimeout: null,
        expectedNonNarrationResponseKey: null,
        expectedNonNarrationResponseKind: null,
        peer: null,
        providerSessionId: null,
        responseActive: false,
        responseSupersededForNarration: false,
        settledFunctionCallIds: new Set(),
        settledTranscriptIds: new Set(),
        stageAckChains: new Map(),
        statusAnnouncementQueue: [],
        skipAssistantItemsUntilNextResponse: false,
        stream: null,
        transcriptItems: new Map(),
        transcriptOrder: [],
        userSpeaking: false,
        userTranscriptBuffers: new Map()
      }

      activeAttempt = attempt
      emitStatus('connecting')

      try {
        const grant = await dependencies.mintSession(sessionId)

        if (!isCurrent(attempt)) {return}

        if (!grant.clientSecret || grant.ownerSessionId !== sessionId) {
          throw new Error('Realtime session was not bound to the active conversation')
        }

        attempt.providerSessionId = grant.providerSessionId ?? null

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

        for (const progress of grant.pendingProgress ?? []) {
          onCanonicalProgress?.(progress)
        }

        for (const result of grant.pendingResults ?? []) {
          acceptCanonicalResult(attempt, result)
        }

        maybeStartNarration(attempt)
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
    narrateCanonicalResult(result) {
      const attempt = activeAttempt

      return attempt ? acceptCanonicalResult(attempt, result) : false
    },
    setMuted(mutedValue) {
      const shouldMute = mutedValue
      muted = shouldMute

      for (const track of activeAttempt?.stream?.getAudioTracks() ?? []) {track.enabled = !shouldMute}
    }
  }
}
