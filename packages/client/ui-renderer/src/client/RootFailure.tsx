/**
 * Top-level render-failure fallback: the one screen the application can show
 * when the slot tree itself cannot render. It depends on no slot, store, app
 * frame, or Session data — only localized copy, the sanitized diagnostic
 * records, and the browser APIs behind its two actions.
 *
 * @module @deepseek-ai/dsh-client-ui-renderer/src/client/RootFailure
 */
import { useEffect, useRef, useState } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { RenderFailureRecord } from './render-failure-log.ts'
import s from './RootFailure.module.css'

/** Inputs of the fallback screen (the renderer supplies the injected actions). */
export interface RootFailureProps {
  /** Translate function over the `renderer` namespace. */
  readonly t: Translate
  /** Records shown in the diagnostic view, newest first. */
  readonly records: readonly RenderFailureRecord[]
  /** Reload action; defaults to `location.reload`. */
  readonly onReload?: (() => void) | undefined
  /** Clipboard action; defaults to `navigator.clipboard.writeText`. */
  readonly onCopy?: ((text: string) => Promise<void>) | undefined
}

/** Reload the page from this origin; the last-resort recovery action. */
function reloadPage(): void {
  globalThis.location.reload()
}

/**
 * Copy through the asynchronous Clipboard API. The call itself is the denial
 * path: a browser or test environment without a usable clipboard rejects the
 * returned promise, which the caller reports as a manual-copy instruction.
 */
async function writeClipboard(text: string): Promise<void> {
  await globalThis.navigator.clipboard.writeText(text)
}

/** Format every record as the text shown in the details block and copied. */
function formatDiagnosticText(records: readonly RenderFailureRecord[], t: Translate): string {
  const blocks = records.map((record) => {
    const lines = [
      t('diagnostics.time', { value: record.at }),
      t('diagnostics.slot', { value: record.slot }),
      t('diagnostics.error', { value: record.name }),
      t('diagnostics.message', { value: record.message }),
    ]
    if (record.stack !== '') lines.push(t('diagnostics.stack', { value: record.stack }))
    return lines.join('\n')
  })
  return [t('title'), ...blocks].join('\n\n')
}

/**
 * Render the explanation, reload control, and diagnostic details.
 * @param props - copy, captured failure, and injectable actions.
 * @returns the standalone failure screen.
 */
export function RootFailure(props: RootFailureProps) {
  const { t, records, onReload, onCopy } = props
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const heading = useRef<HTMLHeadingElement | null>(null)
  const diagnosticText = formatDiagnosticText(records, t)
  const reload = onReload ?? reloadPage

  // The crash removed the focused subtree; move focus to the recovery screen
  // so keyboard and screen-reader users land on its explanation.
  useEffect(() => { heading.current?.focus() }, [])

  const copy = (): void => {
    const write = onCopy ?? writeClipboard
    void write(diagnosticText).then(
      () => { setCopyState('copied') },
      (error: unknown) => {
        // Clipboard permission denial is expected; the selectable details
        // block stays the manual fallback.
        console.error('renderer: copying diagnostics failed:', error)
        setCopyState('failed')
      },
    )
  }

  return (
    <div className={s.root} role="alert" data-root-failure="">
      <section className={s.panel}>
        <h1 ref={heading} tabIndex={-1} className={s.title}>{t('title')}</h1>
        <p className={s.body}>{t('body')}</p>
        <p className={s.distinction}>{t('distinction')}</p>
        <div className={s.actions}>
          <button type="button" className={s.reload} onClick={reload}>{t('reload')}</button>
        </div>
        <details className={s.details}>
          <summary className={s.summary}>{t('diagnostics.summary')}</summary>
          <p className={s.note}>{t('diagnostics.description')}</p>
          {records.length === 0
            ? <p className={s.note}>{t('diagnostics.empty')}</p>
            : (
              <>
                <pre className={s.diagnostic}>{diagnosticText}</pre>
                <div className={s.diagnosticsFooter}>
                  <button type="button" className={s.copy} onClick={copy}>
                    {t('diagnostics.copy')}
                  </button>
                  <span className={s.status} role="status" aria-live="polite">
                    {copyState === 'copied' ? t('diagnostics.copied') : ''}
                    {copyState === 'failed' ? t('diagnostics.copyFailed') : ''}
                  </span>
                </div>
              </>
            )}
          <p className={s.note}>{t('diagnostics.retention')}</p>
          <p className={s.note}>{t('diagnostics.privacy')}</p>
        </details>
      </section>
    </div>
  )
}
