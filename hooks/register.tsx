// jar: a pi-jar flavored Claude Code mod.
// The engine takes one unmatched hook per event, so each event below nests the features' named
// steps, outermost first; matched hooks (renders, own tools, commands) register in each feature.
import type { Register } from 'claude-code'

import { activityPromptSubmit, activityToolCall, activityTurnComplete, activityTurnStart } from './activity'
import { advisorPromptSubmit, advisorSessionStart, advisorToolCall, registerAdvisor } from './advisor'
import { commandsSessionStart, registerCommands } from './commands'
import {
  discussAgentReport,
  discussAgentSpawn,
  discussSessionStart,
  discussTurnStart,
  registerDiscuss,
} from './discuss'
import { panelSessionStart, registerPanel } from './panel'
import { perchSessionStart, registerPerch } from './perch'
import { configureRoute, routeAgentSpawn } from './route'
import { registerSpinner, spinnerToolCall, spinnerTurnStart } from './spinner'
import { themeSessionStart } from './theme'

export const register: Register = (on, options) => {
  configureRoute(options)
  registerAdvisor(on, options)
  registerPerch(on, options)
  registerPanel(on)
  registerSpinner(on)
  registerDiscuss(on)
  registerCommands(on, options)

  on('session.start', async ($, e, next) =>
    themeSessionStart($, e, e1 =>
      perchSessionStart($, e1, e2 =>
        panelSessionStart($, e2, e3 =>
          discussSessionStart($, e3, e4 =>
            advisorSessionStart($, e4, e5 => commandsSessionStart($, e5, next)),
          ),
        ),
      ),
    ),
  ).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) =>
    advisorPromptSubmit($, e, e1 => activityPromptSubmit($, e1, next)),
  ).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) =>
    activityTurnStart($, e, e1 => spinnerTurnStart($, e1, e2 => discussTurnStart($, e2, next))),
  ).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) =>
    activityTurnComplete($, e, next),
  ).catch(($, e, next) => next(e))

  // The advisor's loop gate is outermost, so a call it refuses moves nothing else.
  on('tool.call', async ($, e, next) =>
    advisorToolCall($, e, e1 => spinnerToolCall($, e1, e2 => activityToolCall($, e2, next))),
  ).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) =>
    routeAgentSpawn($, e, e1 => discussAgentSpawn($, e1, next)),
  ).catch(($, e, next) => next(e))

  on('agent.report', async ($, e, next) => discussAgentReport($, e, next)).catch(($, e, next) => next(e))
}
