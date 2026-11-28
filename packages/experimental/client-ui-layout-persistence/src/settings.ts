/** Frame layout persistence preferences shared by the Host schema and the browser plugin. */

/** Settings namespace of the Host row `layout`. */
export const LAYOUT_SETTINGS_NAMESPACE = 'layout'

/** Where the frame geometry is kept: browser local storage, or nowhere. */
export const FRAME_PERSISTENCE_MODES = ['local', 'off'] as const

/** Frame geometry storage mode. */
export type FramePersistence = typeof FRAME_PERSISTENCE_MODES[number]

/** Persist to local storage when no mode is configured. */
export const DEFAULT_FRAME_PERSISTENCE: FramePersistence = 'local'

/** Smallest width in pixels a saved pane may restore to. */
export const DEFAULT_MIN_PANE_WIDTH = 264

/** Durable section behind the `layout` settings namespace. */
export interface LayoutPersistenceSettings {
  /** Storage mode; `off` neither restores nor saves. */
  framePersistence: FramePersistence
  /** Floor in pixels applied to a nonzero saved width before the layout's own clamps. */
  minPaneWidth: number
}
