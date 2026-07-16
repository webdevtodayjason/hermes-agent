import { describe, expect, expectTypeOf, it, vi } from 'vitest'

import { handoffFinalizedVoiceTranscript } from './voice-transcript-handoff'

function setup(overrides: Partial<Parameters<typeof handoffFinalizedVoiceTranscript>[0]> = {}) {
  const enqueue = vi.fn(() => ({ id: 'queued-1' }))
  const onSubmit = vi.fn(async () => true)

  return {
    args: {
      activeQueueSessionKey: 'queue-session',
      busy: false,
      enqueue,
      onSubmit,
      text: '  hello Hermes  ',
      ...overrides
    },
    enqueue,
    onSubmit
  }
}

describe('handoffFinalizedVoiceTranscript', () => {
  it('has no cancellation capability in its production input contract', () => {
    type HandoffArgs = Parameters<typeof handoffFinalizedVoiceTranscript>[0]

    expectTypeOf<HandoffArgs>().not.toHaveProperty('onCancel')
  })

  it('submits one trimmed attachment-free canonical turn while idle', async () => {
    const { args, enqueue, onSubmit } = setup()

    await expect(handoffFinalizedVoiceTranscript(args)).resolves.toBe('submitted')

    expect(onSubmit).toHaveBeenCalledOnce()
    expect(onSubmit).toHaveBeenCalledWith('hello Hermes', { attachments: [] })
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('queues one trimmed attachment-free turn while busy without submitting', async () => {
    const { args, enqueue, onSubmit } = setup({ busy: true })

    await expect(handoffFinalizedVoiceTranscript(args)).resolves.toBe('queued')

    expect(enqueue).toHaveBeenCalledOnce()
    expect(enqueue).toHaveBeenCalledWith('queue-session', { text: 'hello Hermes', attachments: [] })
    expect(onSubmit).not.toHaveBeenCalled()

  })

  it.each(['', '   ', '\n\t'])('ignores a blank final %#', async text => {
    const { args, enqueue, onSubmit } = setup({ text })

    await expect(handoffFinalizedVoiceTranscript(args)).resolves.toBe('ignored')

    expect(enqueue).not.toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('fails visibly through its caller when a busy turn has no queue key', async () => {
    const { args, enqueue, onSubmit } = setup({ activeQueueSessionKey: null, busy: true })

    await expect(handoffFinalizedVoiceTranscript(args)).rejects.toThrow(/queue.*session/i)
    expect(enqueue).not.toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('does not fall back to submit when enqueue rejects the turn', async () => {
    const rejectedEnqueue = vi.fn(() => null)
    const { args, onSubmit } = setup({ busy: true, enqueue: rejectedEnqueue })

    await expect(handoffFinalizedVoiceTranscript(args)).rejects.toThrow(/queue/i)
    expect(rejectedEnqueue).toHaveBeenCalledOnce()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('preserves a turn in the canonical queue when idle submit declines during a busy transition', async () => {
    const declinedSubmit = vi.fn(async () => false)
    const { args, enqueue } = setup({ onSubmit: declinedSubmit })

    await expect(handoffFinalizedVoiceTranscript(args)).resolves.toBe('queued')
    expect(declinedSubmit).toHaveBeenCalledOnce()
    expect(enqueue).toHaveBeenCalledWith('queue-session', {
      text: 'hello Hermes',
      attachments: []
    })
  })

  it('preserves the second of two rapid finals when canonical busy state wins the race', async () => {
    const onSubmit = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const { args, enqueue } = setup({ onSubmit })

    await expect(handoffFinalizedVoiceTranscript({ ...args, text: 'first' })).resolves.toBe(
      'submitted'
    )
    await expect(handoffFinalizedVoiceTranscript({ ...args, text: 'second' })).resolves.toBe(
      'queued'
    )

    expect(onSubmit).toHaveBeenNthCalledWith(1, 'first', { attachments: [] })
    expect(onSubmit).toHaveBeenNthCalledWith(2, 'second', { attachments: [] })
    expect(enqueue).toHaveBeenCalledOnce()
    expect(enqueue).toHaveBeenCalledWith('queue-session', { text: 'second', attachments: [] })
  })
})
