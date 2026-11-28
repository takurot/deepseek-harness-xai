/** Host registration for the frame layout persistence settings. */
import type {} from '@deepseek-ai/dsh-settings'

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_FRAME_PERSISTENCE, DEFAULT_MIN_PANE_WIDTH, FRAME_PERSISTENCE_MODES,
  type LayoutPersistenceSettings,
} from './settings.ts'

export {
  DEFAULT_FRAME_PERSISTENCE, DEFAULT_MIN_PANE_WIDTH, FRAME_PERSISTENCE_MODES, LAYOUT_SETTINGS_NAMESPACE,
  type FramePersistence, type LayoutPersistenceSettings,
} from './settings.ts'

/** Runtime preferences projected to the browser. */
export interface Config {
  /** Where the sidebar and right-panel widths are kept. */
  framePersistence: Volatile<LayoutPersistenceSettings['framePersistence']>
  /** Floor in pixels for a nonzero saved width. */
  minPaneWidth: Volatile<LayoutPersistenceSettings['minPaneWidth']>
}

/** Live preferences projected to the browser. */
export const Config = z.object({
  framePersistence: z.union([...FRAME_PERSISTENCE_MODES]).default(DEFAULT_FRAME_PERSISTENCE).volatile(),
  minPaneWidth: z.number().min(0).default(DEFAULT_MIN_PANE_WIDTH).volatile(),
})

/** Expose the fields through the configuration form projection.
 * @param ctx Plugin context used for optional settings presentation.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
}
