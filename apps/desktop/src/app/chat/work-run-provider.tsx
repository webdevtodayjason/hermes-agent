import { type ReactNode, useMemo } from 'react'

import { WorkRunClientProvider } from '@/components/assistant-ui/tool/work-run'
import { createWorkhorseClient, type WorkhorseRpcRequest } from '@/lib/workhorse-client'

interface ChatWorkRunProviderProps {
  profile: string
  request: WorkhorseRpcRequest
  children: ReactNode
}

/**
 * Composition boundary for inline work-run chips: binds the active gateway
 * profile to one memoized WorkhorseClient and provides it to the chat
 * subtree, so every `work_start` tool part in the thread renders live.
 */
export function ChatWorkRunProvider({ profile, request, children }: ChatWorkRunProviderProps) {
  const client = useMemo(() => createWorkhorseClient({ profile, request }), [profile, request])

  return <WorkRunClientProvider client={client}>{children}</WorkRunClientProvider>
}
