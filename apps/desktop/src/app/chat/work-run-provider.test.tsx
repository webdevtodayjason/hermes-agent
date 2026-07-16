import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useWorkRunClient } from '@/components/assistant-ui/tool/work-run'
import type { WorkhorseRpcRequest } from '@/lib/workhorse-client'

import { ChatWorkRunProvider } from './work-run-provider'

afterEach(cleanup)

function Probe() {
  const client = useWorkRunClient()

  if (!client) {return <span data-testid="no-client" />}

  void client.startWork('probe job')

  return <span data-testid="has-client" />
}

describe('ChatWorkRunProvider', () => {
  it('provides a profile-bound WorkhorseClient to descendants', () => {
    const request = vi.fn(async () => ({ run_id: 'run_p', status: 'running' })) as unknown as WorkhorseRpcRequest

    render(
      <ChatWorkRunProvider profile="default" request={request}>
        <Probe />
      </ChatWorkRunProvider>
    )

    expect(screen.getByTestId('has-client')).toBeTruthy()
    expect(request).toHaveBeenCalledWith('work.start', {
      input: 'probe job',
      session_id: 'desktop-workhorse:default'
    })
  })

  it('is replay-safe: consumers see null without a provider', () => {
    render(<Probe />)
    expect(screen.getByTestId('no-client')).toBeTruthy()
  })
})
