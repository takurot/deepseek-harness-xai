import clsx from 'clsx'
import { MarkdownText, type MarkdownLabels } from './markdown/MarkdownText.tsx'
import { LinkIconMedium } from './LinkIcon.tsx'
import css from './WebBlock.module.css'

/**
 * One citeable source drawn in a search card: the projection of the contract's
 * `WebSource`, with the optional fields kept optional so a provider that
 * returned only a URL still renders (its hostname becomes the label).
 */
export interface WebSourceView {
  /** The source URL; becomes a safe external link when it is http(s). */
  url: string
  /** The source title; when absent the URL's hostname labels the link. */
  title?: string | undefined
  /** A short excerpt or summary shown under the link. */
  snippet?: string | undefined
  /** Publication/crawl timestamp, a provider-supplied string shown under the link. */
  publishedAt?: string | undefined
}

/**
 * One query that failed inside an otherwise completed multi-query search, the
 * projection of the contract's recorded failure entry.
 */
export interface WebSearchQueryFailureView {
  /** The exact query string whose search failed. */
  query: string
  /** The failure's typed code, shown verbatim as the retrieval status it is. */
  code: string
}

/** A `web_search` card: an optional answer over a capped citation list. */
export interface WebSearchBlockProps {
  kind: 'search'
  /** Localized chrome supplied by the owning render site. */
  labels: WebBlockLabels
  /** The provider-generated answer, rendered as markdown above the sources. */
  answer?: string | undefined
  /** The cited sources, in provider order. */
  sources: WebSourceView[]
  /** True when the tool cut the source list to its result cap. */
  truncated: boolean
  /** Queries that failed while the call succeeded through its siblings, in query order. */
  failedQueries?: WebSearchQueryFailureView[] | undefined
  /** Extra class merged onto the wrapper (callers position; this component draws). */
  className?: string | undefined
}

/** PDF page accounting shown on a fetch card, matching the persisted fetch meta. */
export interface WebFetchPdfInfo {
  /** Total pages in the document. */
  pageCount: number
  /** Pages whose text the extraction represented. */
  pagesExtracted: number
}

/** A `web_fetch` card: the retrieval summary for one fetched URL. */
export interface WebFetchBlockProps {
  kind: 'fetch'
  /** Localized chrome supplied by the owning render site. */
  labels: WebBlockLabels
  /** The final URL after allowed redirects; becomes a safe external link when http(s). */
  url: string
  /** HTTP status code of the fetched response. */
  statusCode: number
  /** True when the provider or the output cap cut the fetched content. */
  truncated: boolean
  /** Extracted PDF page accounting; absent for an HTML or text body. */
  pdf?: WebFetchPdfInfo | undefined
  /** Extra class merged onto the wrapper (callers position; this component draws). */
  className?: string | undefined
}

/** A completed web retrieval card, discriminated by `kind`. */
export type WebBlockProps = WebSearchBlockProps | WebFetchBlockProps

/** Localized chrome for {@link WebBlock}. */
export interface WebBlockLabels {
  noResults: string
  sourcesTruncated: string
  failedQueries: string
  http: string
  contentTruncated: string
  /** PDF page summary; receives the extracted page count and the document total. */
  pdfPages: (extracted: number, total: number) => string
  markdown: MarkdownLabels
}

/**
 * The URL to link to, or undefined when the URL must render as plain text. Only
 * http(s) becomes a navigable external anchor, so a `javascript:`/`data:`/`file:`
 * URL or an unparseable string never reaches the DOM as an href. This is the
 * http(s) subset of the allowlist MarkdownText applies to untrusted links —
 * MarkdownText also permits `mailto:`, deliberately excluded here since a
 * retrieval URL is never a mail address.
 * @param url - the source or fetch URL, from tool result content.
 * @returns the href to use, or undefined for plain text.
 */
function safeHref(url: string): string | undefined {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:' ? url : undefined
  } catch {
    return undefined
  }
}

/**
 * The link's visible label: the title when the provider gave one, otherwise the
 * URL's hostname, falling back to the raw URL when it does not parse OR parses
 * to an empty hostname (a `file:`/`data:`/`javascript:` URL), so a label is
 * never blank.
 * @param url - the source URL.
 * @param title - the provider title, if any.
 * @returns the label text.
 */
function linkLabel(url: string, title: string | undefined): string {
  if (title !== undefined && title !== '') return title
  try {
    const { hostname } = new URL(url)
    return hostname === '' ? url : hostname
  } catch {
    return url
  }
}

/**
 * A single URL rendered as a safe external anchor, or as plain text when the
 * URL is not an http(s) link.
 * @param props.url - the URL to render.
 * @param props.label - the visible label.
 * @param props.className - class for the anchor or the plain span.
 * @returns the anchor or span element.
 */
function SafeLink({ url, label, className }: { url: string; label: string; className?: string | undefined }) {
  const href = safeHref(url)
  if (href === undefined) return <span className={className}>{label}</span>
  return (
    <a className={className} href={href} target="_blank" rel="noopener noreferrer">
      <LinkIconMedium kind="url" href={href} className={css.linkIcon} />
      {label}
    </a>
  )
}

/**
 * One source row in a search card: the safe link plus its snippet and date. The
 * `<li value>` pins the source's 1-based citation index explicitly rather than
 * relying on the `<ol>`'s implicit numbering, so a row reads by its real index
 * even inside the scroll container.
 * @param props.source - the source to render.
 * @param props.ordinal - the source's 1-based position in the full list.
 * @returns the source list item.
 */
function SourceItem({ source, ordinal }: { source: WebSourceView; ordinal: number }) {
  return (
    <li className={css.source} value={ordinal}>
      <SafeLink url={source.url} label={linkLabel(source.url, source.title)} className={css.sourceLink} />
      {source.snippet !== undefined && source.snippet !== '' && (
        <div className={css.snippet}>{source.snippet}</div>
      )}
      {source.publishedAt !== undefined && source.publishedAt !== '' && (
        <div className={css.published}>{source.publishedAt}</div>
      )}
    </li>
  )
}

/**
 * One failed query in a search card: the query text and its failure code, which
 * is shown verbatim because it is the retrieval status the tool recorded, not
 * product copy.
 * @param props.failure - the failed query to render.
 * @returns the failure list item.
 */
function FailedQueryItem({ failure }: { failure: WebSearchQueryFailureView }) {
  return (
    <li className={css.failedQuery}>
      <span className={css.failedQueryText}>{failure.query}</span>
      <code className={css.failedQueryCode}>{failure.code}</code>
    </li>
  )
}

/**
 * The search card body: the answer over the full source list, which scrolls in
 * place once it exceeds the `.sources` container height, plus the queries that
 * failed without failing the call.
 * @param props - see {@link WebSearchBlockProps}.
 * @returns the search card element.
 */
function WebSearchBlock({ answer, sources, truncated, failedQueries, labels, className }: WebSearchBlockProps) {
  // A provider may legitimately return no answer and no sources; the chat WebRow
  // does not show the raw result content, so without this the user would see an
  // empty card. Mirror the backend's `No results found.` render text.
  const empty = (answer === undefined || answer === '') && sources.length === 0
  return (
    <div className={clsx(css.block, className)} data-web="search">
      {answer !== undefined && answer !== '' && (
        <div className={css.answer}><MarkdownText text={answer} labels={labels.markdown} /></div>
      )}
      {empty ? (
        <div className={css.empty}>{labels.noResults}</div>
      ) : (
        <ol className={css.sources}>
          {sources.map((source, index) => <SourceItem key={index} source={source} ordinal={index + 1} />)}
        </ol>
      )}
      {truncated && <div className={css.truncated}>{labels.sourcesTruncated}</div>}
      {failedQueries !== undefined && failedQueries.length > 0 && (
        <div className={css.failedQueries}>
          <div className={css.failedQueriesHeading}>{labels.failedQueries}</div>
          <ul className={css.failedQueryList}>
            {failedQueries.map((failure, index) => <FailedQueryItem key={index} failure={failure} />)}
          </ul>
        </div>
      )}
    </div>
  )
}

/**
 * The fetch card body: the linked URL and its HTTP status.
 * @param props - see {@link WebFetchBlockProps}.
 * @returns the fetch card element.
 */
function WebFetchBlock({ url, statusCode, truncated, pdf, labels, className }: WebFetchBlockProps) {
  return (
    <div className={clsx(css.block, css.fetch, className)} data-web="fetch">
      <SafeLink url={url} label={url} className={css.fetchUrl} />
      <div className={css.fetchMeta}>
        <span className={css.status}>{labels.http} {statusCode}</span>
        {pdf !== undefined && <span className={css.pdf}>{labels.pdfPages(pdf.pagesExtracted, pdf.pageCount)}</span>}
        {truncated && <span className={css.truncated}>{labels.contentTruncated}</span>}
      </div>
    </div>
  )
}

/**
 * Render a completed web retrieval as a structured card.
 * @param props - see {@link WebBlockProps}; `kind` selects the search or fetch body.
 * @returns the web card element.
 */
export function WebBlock(props: WebBlockProps) {
  return props.kind === 'search' ? <WebSearchBlock {...props} /> : <WebFetchBlock {...props} />
}
