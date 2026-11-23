import type { Args, EngineInterface, ThemeSetArgs } from 'claude-code'

import type { NextFn, StepResult } from './chain'
import { makeColors } from './make-colors.js'
import { AMBER, DARK_SURFACES, LIGHT_SURFACES } from './palette'

const UNPAINTED = "Desktop won't paint"

const { theme, problems } = makeColors({
  label: 'Jar Amber',
  roles: {
    accent: AMBER.accent,
    danger: AMBER.red,
    success: AMBER.green,
    warning: AMBER.amber,
    pro: AMBER.violet,
  },
  light: {
    gray: {
      anchors: {
        'surface-0': LIGHT_SURFACES.page,
        'surface-1': LIGHT_SURFACES.card,
        'surface-2': LIGHT_SURFACES.panel,
        'text-primary': LIGHT_SURFACES.text,
        'text-secondary': LIGHT_SURFACES.secondary,
        'text-muted': LIGHT_SURFACES.muted,
      },
    },
  },
  dark: {
    gray: {
      anchors: {
        'surface-0': DARK_SURFACES.page,
        'surface-1': DARK_SURFACES.card,
        'surface-2': DARK_SURFACES.user,
        'surface-3': DARK_SURFACES.custom,
        'text-primary': AMBER.text,
        'text-secondary': AMBER.muted,
        'text-muted': AMBER.dim,
      },
    },
  },
})

const LOOK: ThemeSetArgs = { colors: theme }

/** The amber look for the desktop and mobile apps; the terminal draws the mod's own trees in amber. */
export async function themeSessionStart(
  $: EngineInterface,
  e: Args<'session.start'>,
  next: NextFn<'session.start'>,
): StepResult<'session.start'> {
  const unpainted = problems.find(line => line.startsWith(UNPAINTED))

  if (unpainted !== undefined) {
    $.ui.log(`jar theme: ${unpainted}`)
  }

  try {
    await $.theme.set(LOOK)
  } catch (error) {
    $.ui.log(`jar theme: ${String(error)}`)
  }

  return next(e)
}
