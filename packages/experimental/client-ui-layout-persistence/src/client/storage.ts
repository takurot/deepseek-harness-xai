/** Versioned local-storage record of the frame geometry. */
import type { FrameGeometry } from '@deepseek-ai/dsh-client-ui-layout/client'

/** Local-storage key holding the saved frame geometry. */
export const FRAME_LAYOUT_STORAGE_KEY = 'dsh.frame-layout.v1'

/** Version written to and required from the stored record. */
export const FRAME_LAYOUT_STORAGE_VERSION = 1

/** Outcome of reading the stored record. */
export type StoredGeometry =
  | { readonly kind: 'absent' }
  | { readonly kind: 'valid'; readonly geometry: FrameGeometry }
  | { readonly kind: 'invalid'; readonly reason: string }

function isWidth(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/**
 * Validate parsed JSON as a version 1 record.
 * @param value - parsed storage content.
 * @returns the geometry, or the reason the record is rejected.
 */
function parseRecord(value: unknown): StoredGeometry {
  if (typeof value !== 'object' || value === null) return { kind: 'invalid', reason: 'not an object' }
  const record = value as Record<string, unknown>
  if (record['version'] !== FRAME_LAYOUT_STORAGE_VERSION) {
    return { kind: 'invalid', reason: `unsupported version ${JSON.stringify(record['version'])}` }
  }
  const { sidebar, rightbar } = record
  if (!isWidth(sidebar)) return { kind: 'invalid', reason: 'sidebar is not a finite non-negative number' }
  if (rightbar !== null && !isWidth(rightbar)) {
    return { kind: 'invalid', reason: 'rightbar is neither null nor a finite non-negative number' }
  }
  return { kind: 'valid', geometry: { sidebar, rightbar } }
}

/**
 * Read and validate the stored record.
 * @param storage - the storage to read.
 * @returns absent, a valid geometry, or the rejection reason. Never throws on stored content.
 */
export function readStoredGeometry(storage: Storage): StoredGeometry {
  const raw = storage.getItem(FRAME_LAYOUT_STORAGE_KEY)
  if (raw === null) return { kind: 'absent' }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error: unknown) {
    // JSON.parse only throws SyntaxError.
    return { kind: 'invalid', reason: `not JSON: ${(error as SyntaxError).message}` }
  }
  return parseRecord(parsed)
}

/**
 * Serialize a geometry as a version 1 record.
 * @param geometry - the widths to save.
 * @returns the JSON text stored under {@link FRAME_LAYOUT_STORAGE_KEY}.
 */
export function serializeGeometry(geometry: FrameGeometry): string {
  return JSON.stringify({
    version: FRAME_LAYOUT_STORAGE_VERSION,
    sidebar: geometry.sidebar,
    rightbar: geometry.rightbar,
  })
}
