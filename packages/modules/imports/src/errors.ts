// The import module's domain errors (S48, ADR-0049); the api maps them to its error codes.

/** No such import in the business (or not one the member may see: staff see none). */
export class ImportNotFoundError extends Error {
  override readonly name = 'ImportNotFoundError';
  constructor() {
    super('No such import in this business');
  }
}

/** The import is no longer staged: its mapping can't change, and it can't be committed again. */
export class ImportNotStagedError extends Error {
  override readonly name = 'ImportNotStagedError';
  constructor() {
    super('That import has already been started');
  }
}

/** The import can't be committed yet; the message says why, for the owner. */
export class ImportNotReadyError extends Error {
  override readonly name = 'ImportNotReadyError';
}

/** A mapping that names a column the file doesn't have. */
export class ImportMappingInvalidError extends Error {
  override readonly name = 'ImportMappingInvalidError';
}

/** The import can't be undone (not finished, already undone, or its 7 days are over). */
export class ImportNotUndoableError extends Error {
  override readonly name = 'ImportNotUndoableError';
}
