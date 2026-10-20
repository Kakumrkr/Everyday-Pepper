import { RETRYABLE_LLM_ERRORS, type LlmErrorCode, type LlmUsage } from '@pepper/contracts';

/**
 * A failed model call, provider-neutral (ADR-0027). The message never carries prompt or answer
 * text. `usage` is set when the provider may bill a call that failed after it started, so
 * metering still counts it.
 */
export class LlmError extends Error {
  override readonly name = 'LlmError';
  readonly retryable: boolean;

  constructor(
    readonly code: LlmErrorCode,
    message: string,
    readonly usage?: LlmUsage,
  ) {
    super(message);
    this.retryable = RETRYABLE_LLM_ERRORS.has(code);
  }
}

export function isLlmError(error: unknown): error is LlmError {
  return error instanceof LlmError;
}
