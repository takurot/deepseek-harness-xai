/**
 * Fixed-density heuristic token pricing shared by the meter service and the
 * pure context-breakdown projection, so both surfaces price identical content
 * to identical numbers.
 *
 * @module @deepseek-ai/dsh-token-meter/estimate
 */

import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type { EpochHeader } from '@deepseek-ai/dsh-session'

/**
 * Fixed per-script text densities used until exact tokenization is needed,
 * in quarter-token units per code point so the sum stays an exact integer:
 * ASCII is four characters per token, CJK is one token per character, and
 * other scripts are two characters per token.
 */
const ASCII_QUARTER_TOKENS = 1
const CJK_QUARTER_TOKENS = 4
const OTHER_QUARTER_TOKENS = 2

/**
 * Whether a code point is priced at the CJK density: CJK radicals through
 * unified ideographs (which include CJK punctuation and kana), Hangul
 * syllables, compatibility ideographs, fullwidth forms, and the
 * supplementary ideographic planes.
 * @param codePoint - Unicode code point to classify.
 * @returns true when the code point is CJK.
 */
function isCjk(codePoint: number): boolean {
  return (codePoint >= 0x2e80 && codePoint <= 0x9fff)
    || (codePoint >= 0xac00 && codePoint <= 0xd7af)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xff00 && codePoint <= 0xffef)
    || (codePoint >= 0x20000 && codePoint <= 0x2ffff)
}

/**
 * Price text by script class under the fixed heuristic. Counts code points,
 * so a surrogate pair is one character.
 * @param text - text to price without mutation.
 * @returns heuristic tokens; 0 for empty text.
 */
export function estimateText(text: string): number {
  let quarters = 0
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index)
    if (unit < 0x80) {
      quarters += ASCII_QUARTER_TOKENS
      continue
    }
    let codePoint = unit
    const next = text.charCodeAt(index + 1)
    if (unit >= 0xd800 && unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      codePoint = 0x10000 + ((unit - 0xd800) << 10) + (next - 0xdc00)
      index += 1
    }
    quarters += isCjk(codePoint) ? CJK_QUARTER_TOKENS : OTHER_QUARTER_TOKENS
  }
  return Math.ceil(quarters / 4)
}

/** Per-block structural overhead for JSON framing and type tags. */
const BLOCK_OVERHEAD = 4

/** Role-field framing overhead added to every priced message. */
export const ROLE_OVERHEAD = 4

/**
 * Structural JSON price of one block outside the typed pricing arms: the
 * fixed heuristic for merge-extended blocks and for image references, whose
 * request price is route-owned rather than fixed. Image offload marks do not
 * change this reference-only heuristic; route pricing owns their placeholders.
 * @param block - block to price without mutation.
 * @returns heuristic tokens for the block's JSON structure.
 */
export function estimateStructuralBlock(block: ContentBlock): number {
  if (block.type === 'image') {
    const { offloaded: _offloaded, ...reference } = block
    return BLOCK_OVERHEAD + estimateText(JSON.stringify(reference))
  }
  return BLOCK_OVERHEAD + estimateText(JSON.stringify(block))
}

/**
 * Price content blocks recursively under the fixed per-script density heuristic.
 * @param blocks - content blocks to price without mutation.
 * @returns heuristic tokens including per-block structural overhead.
 */
export function estimateContent(blocks: readonly ContentBlock[]): number {
  let tokens = 0
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        tokens += estimateText(block.text) + BLOCK_OVERHEAD
        break
      case 'tool-call':
        tokens += estimateText(block.name)
          + estimateText(block.arguments)
          + BLOCK_OVERHEAD
        break
      default:
        // ContentBlockMap is merge-extensible; unknown blocks (and image
        // references, whose request price is route-owned) retain a
        // conservative structural JSON price under the fixed heuristic.
        tokens += estimateStructuralBlock(block)
    }
  }
  return tokens
}

/**
 * Price the rendered system prompt: the `system/message` surface node's text.
 * Adapters serialize the prompt as a plain string — a system-role message or
 * the request's system field — not as a typed content block, so the price is
 * text density plus role framing with no per-block overhead.
 * @param message - system-role message to price without mutation.
 * @returns heuristic system-prompt tokens; 0 for empty content ("no system prompt").
 */
export function estimateSystemMessage(message: Message): number {
  if (message.content.length === 0) return 0
  let text = ''
  for (const block of message.content) {
    text += block.type === 'text' ? block.text : JSON.stringify(block)
  }
  return estimateText(text) + ROLE_OVERHEAD
}

/**
 * Heuristically price one model-visible message.
 * @param message - message to price without mutation.
 * @returns content and role-framing tokens under the fixed heuristic; a
 *   system-role message prices as {@link estimateSystemMessage}.
 */
export function estimateMessage(message: Message): number {
  if (message.role === 'system') return estimateSystemMessage(message)
  return estimateContent(message.content) + ROLE_OVERHEAD
}

/**
 * Price the tool-schema part of a canonical request envelope — the envelope's
 * only priced field, since the system prompt is a surface node.
 * @param header - canonical envelope, or undefined before any request.
 * @returns heuristic tool-schema tokens; 0 when absent or empty.
 */
export function estimateToolsTokens(header: EpochHeader | undefined): number {
  if (header?.tools === undefined || header.tools.length === 0) return 0
  return estimateText(JSON.stringify(header.tools)) + BLOCK_OVERHEAD
}
