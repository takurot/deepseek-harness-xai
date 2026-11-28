/** Restore-once, save-on-change controller for the frame geometry. */
import type { FrameGeometry, ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { LayoutPersistenceSettings } from '../settings.ts'
import { FRAME_LAYOUT_STORAGE_KEY, readStoredGeometry, serializeGeometry } from './storage.ts'

/** Quiet period in milliseconds after the last geometry change before one write. */
const SAVE_DEBOUNCE_MS = 200

/** Services the controller needs. */
export interface FramePersistenceDeps {
  /** The layout face supplying `frameGeometry` and `restoreFrameGeometry`. */
  readonly layout: Pick<ILayout, 'frameGeometry' | 'restoreFrameGeometry'>
  /** @returns the storage, or undefined when unavailable. */
  readonly storage: () => Storage | undefined
  /** Report one diagnostic. */
  readonly warn: (message: string) => void
}

/**
 * Applies the saved geometry once, then writes each settled change. Mode `off`
 * stops both; geometry already in memory stays.
 */
export class FramePersistence {
  private mode: LayoutPersistenceSettings['framePersistence'] = 'off'
  private minPaneWidth = 0
  private configured = false
  private observing = false
  private unsubscribe: (() => void) | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private lastSerialized: string | undefined
  private writeFailureReported = false

  constructor(private readonly deps: FramePersistenceDeps) {}

  /**
   * Apply resolved settings. A `local` first configuration restores the saved
   * geometry; every `local` configuration starts saving, and `off` stops it.
   * @param settings - the accepted preferences.
   */
  configure(settings: LayoutPersistenceSettings): void {
    const startup = !this.configured
    this.configured = true
    this.mode = settings.framePersistence
    this.minPaneWidth = settings.minPaneWidth
    if (this.mode === 'off') {
      this.cancelPending()
      return
    }
    if (startup) this.restore()
    if (this.observing) return
    this.observing = true
    this.unsubscribe = this.deps.layout.frameGeometry.subscribe(() => { this.schedule() })
  }

  /** Cancel the pending write and stop observing the layout. */
  dispose(): void {
    this.cancelPending()
    this.unsubscribe?.()
    this.unsubscribe = undefined
  }

  private restore(): void {
    const storage = this.deps.storage()
    if (storage === undefined) {
      this.deps.warn('frame layout persistence: local storage is unavailable; using the default layout')
      return
    }
    let stored
    try {
      stored = readStoredGeometry(storage)
    } catch (error: unknown) {
      this.deps.warn(`frame layout persistence: reading ${FRAME_LAYOUT_STORAGE_KEY} failed: ${describe(error)}`)
      return
    }
    if (stored.kind === 'absent') return
    if (stored.kind === 'invalid') {
      const cleanup = this.removeKey(storage)
      this.deps.warn(`frame layout persistence: discarded ${FRAME_LAYOUT_STORAGE_KEY}: ${stored.reason}${cleanup}`)
      return
    }
    const { sidebar, rightbar } = stored.geometry
    const geometry: FrameGeometry = {
      sidebar: sidebar === 0 ? 0 : Math.max(sidebar, this.minPaneWidth),
      rightbar: rightbar === null ? null : Math.max(rightbar, this.minPaneWidth),
    }
    this.deps.layout.restoreFrameGeometry(geometry)
    this.lastSerialized = serializeGeometry(this.deps.layout.frameGeometry.getSnapshot())
  }

  /** @returns an empty string, or the diagnostic suffix naming why the record could not be removed. */
  private removeKey(storage: Storage): string {
    try {
      storage.removeItem(FRAME_LAYOUT_STORAGE_KEY)
      return ''
    } catch (error: unknown) {
      return `; cleanup failed: ${describe(error)}`
    }
  }

  private schedule(): void {
    if (this.mode === 'off') return
    this.cancelPending()
    this.timer = setTimeout(() => { this.save() }, SAVE_DEBOUNCE_MS)
  }

  private cancelPending(): void {
    if (this.timer === undefined) return
    clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Write the current geometry. A failed write is reported once; later changes still try again. */
  private save(): void {
    this.timer = undefined
    const serialized = serializeGeometry(this.deps.layout.frameGeometry.getSnapshot())
    if (serialized === this.lastSerialized) return
    const storage = this.deps.storage()
    if (storage === undefined) return
    try {
      storage.setItem(FRAME_LAYOUT_STORAGE_KEY, serialized)
    } catch (error: unknown) {
      if (!this.writeFailureReported) {
        this.writeFailureReported = true
        this.deps.warn(`frame layout persistence: saving ${FRAME_LAYOUT_STORAGE_KEY} failed: ${describe(error)}`)
      }
      return
    }
    this.lastSerialized = serialized
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
