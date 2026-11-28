/** Browser plugin restoring and saving the frame's sidebar and right-panel width preferences. */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: ctx.layout and its frame geometry face.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: ctx.configForms.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { LAYOUT_SETTINGS_NAMESPACE, type LayoutPersistenceSettings } from '../settings.ts'
import { FramePersistence } from './persistence.ts'

export { FRAME_LAYOUT_STORAGE_KEY, FRAME_LAYOUT_STORAGE_VERSION } from './storage.ts'

/** Required services: the layout frame geometry face and the settings forms. */
export const inject = ['layout', 'configForms']

/**
 * Restore the saved geometry once a ready settings snapshot arrives, then save later changes.
 * Without a ready snapshot the plugin neither restores nor saves.
 * @param ctx - plugin context; every subscription is disposed with it.
 */
export function apply(ctx: Context): void {
  const form = ctx.configForms.get<LayoutPersistenceSettings>(LAYOUT_SETTINGS_NAMESPACE)
  const persistence = new FramePersistence({
    layout: ctx.layout,
    storage: browserStorage,
    warn: (message) => { ctx.logger.warn(message) },
  })
  const sync = (): void => {
    const snapshot = form.getSnapshot()
    if (snapshot.status !== 'ready' || snapshot.value === undefined) return
    persistence.configure(snapshot.value)
  }
  ctx.effect(() => form.subscribe(sync))
  ctx.effect(() => () => { persistence.dispose() })
  sync()
}

/** @returns the browser's local storage, or undefined when it is missing or access throws. */
function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage
  } catch (_error: unknown) {
    // Blocked site data makes the property getter throw; the caller reports unavailable storage.
    return undefined
  }
}
