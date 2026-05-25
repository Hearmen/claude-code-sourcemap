import { isPolicyAllowed } from '../../services/policyLimits/index.js'
import { logEvent } from '../../services/analytics/index.js'
import { checkRemoteAgentEligibility } from '../../tasks/RemoteAgentTask/RemoteAgentTask.js'

interface UltrareviewOptions {
  json?: boolean
  timeout?: string
}

export async function ultrareviewHandler(
  target: string,
  options: UltrareviewOptions,
): Promise<void> {
  // SIGINT guard
  const sigintHandler = () => process.exit(130)
  process.once('SIGINT', sigintHandler)

  try {
    if (!isPolicyAllowed('allow_remote_sessions')) {
      logEvent('cli_ultrareview', { detail: 'cli_ultrareview_policy_disallowed' })
      console.error('Remote sessions are disabled by your organization\'s policy.')
      process.exit(1)
    }

    // Check basic eligibility (git repo, auth, etc.)
    const eligibility = await checkRemoteAgentEligibility()
    if (!eligibility.eligible) {
      const blockers = eligibility.errors.filter(
        e => e.type !== 'no_remote_environment',
      )
      if (blockers.length > 0) {
        logEvent('cli_ultrareview', { detail: 'cli_ultrareview_launch_failed' })
        console.error('Ultrareview cannot launch:')
        for (const err of blockers) {
          console.error(`  - ${err.type}`)
        }
        process.exit(1)
      }
    }

    // Full ultrareview launch + poll requires interactive session
    // infrastructure (TaskContext, AppState, RemoteAgentTask polling).
    // The standalone CLI path is not yet fully implemented in the
    // extracted source — users should run /ultrareview inside an
    // interactive Claude Code session instead.
    console.error(
      'Ultrareview is not yet available via the standalone CLI in the extracted source.',
    )
    console.error('Run `claude` to start an interactive session, then type `/ultrareview`.')
    process.exit(1)
  } finally {
    process.removeListener('SIGINT', sigintHandler)
  }
}
