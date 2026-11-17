/** Typed PDF failures shared by the extraction engine, its Worker, and the bridge. */

/** A PDF.js rejection: the document itself could not be extracted. */
export class PdfDocumentError extends Error {}

/** This build does not include the PDF extraction engine. */
export class PdfExtractionUnavailableError extends Error {}

/** The engine is installed but failed to load for a reason other than absence. */
export class PdfEngineLoadError extends Error {}
