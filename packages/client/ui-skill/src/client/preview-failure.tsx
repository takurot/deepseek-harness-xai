/**
 * Frame-wide retryable notice for a failed explicit skill preview. The host
 * lives in the root `shell.overlay` slot, so it outlives the Session panel
 * whose click produced it; the apply closure owns the notice state.
 */
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'

/** Full-opacity hold for the failure toast: long enough to read it and press Retry. */
export const PREVIEW_FAILURE_HOLD_MS = 8000

/** One failed explicit preview click, kept until it is retried or dismissed. */
export interface PreviewFailure {
  /** Session whose click failed; Retry re-runs the preview there. */
  readonly sessionId: SessionId
  /** The clicked reference (`/name`). */
  readonly ref: string
  /** Localized failure sentence. */
  readonly text: string
  /** Localized Retry action label. */
  readonly retryLabel: string
  /** Per-show identity so a repeated report restarts the toast lifetime. */
  readonly sequence: number
}

/** Registration-owned notice source plus its dismissal and retry callbacks. */
export interface PreviewFailureInjected {
  readonly hooks: { readonly failure: ObservableSnapshot<PreviewFailure | null> }
  readonly dismiss: () => void
  readonly retry: () => void
}

/**
 * Show the failure with a Retry action and dismiss it when its hold ends.
 * @param props - framework-bound notice source, dismissal, and retry callbacks.
 * @returns the current failure toast, or nothing.
 */
export function SkillPreviewFailureHost({ useFailure, dismiss, retry }: InjectFace<PreviewFailureInjected>) {
  const failure = useFailure(value => value)
  return failure === null ? null : (
    <Toast
      key={failure.sequence}
      text={failure.text}
      icon={<IconWarningOutlineRegular size={18} />}
      holdMs={PREVIEW_FAILURE_HOLD_MS}
      actions={[{ label: failure.retryLabel, onClick: retry }]}
      onDone={dismiss}
    />
  )
}
