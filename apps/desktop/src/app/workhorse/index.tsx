import { useMemo } from 'react'

import { createWorkhorseClient, type WorkhorseRpcRequest } from '@/lib/workhorse-client'

import { WorkhorsePanel } from './workhorse-panel'

interface WorkhorseSectionProps {
  profile: string
  request: WorkhorseRpcRequest
}

/** App-section composition boundary for the visual workhorse run loop. */
export function WorkhorseSection({ profile, request }: WorkhorseSectionProps) {
  const client = useMemo(() => createWorkhorseClient({ profile, request }), [profile, request])

  return (
    <main className="h-full overflow-y-auto pt-(--titlebar-height)">
      <header className="border-b border-(--ui-stroke-secondary) px-3 py-2 text-sm font-semibold">Workhorse</header>
      <WorkhorsePanel client={client} />
    </main>
  )
}
