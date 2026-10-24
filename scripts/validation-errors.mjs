import { AssertionError } from 'node:assert';

export class ValidationError extends Error {
  constructor(code, message, options) {
    super(message, options); this.name = 'ValidationError'; this.code = code; this.safeMessage = options?.safeMessage ?? message;
  }
}
export class TransportError extends Error {
  constructor(message, cause) {
    super(message, { cause }); this.name = 'TransportError'; this.code = 'transport_error'; this.transport = true;
  }
}
export const terminalValidation = error => error instanceof ValidationError || error instanceof AssertionError;

// Parsers, child processes and generated assertion diffs can echo whole inputs.
// Only fixed reasons and explicit assertion messages are eligible for display.
export function safeFailure(error, secrets = [], seen = new Set()) {
  if (seen.has(error) || seen.size >= 8) return { code: 'truncated', message: 'Additional failure details omitted' };
  seen.add(error);
  const clean = value => {
    let text = String(value);
    for (const secret of secrets.filter(value => typeof value === 'string' && value.length)) text = text.replaceAll(secret, '[redacted]');
    return text.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 300);
  };
  const safeMessage = error instanceof ValidationError || error instanceof TransportError
    || error instanceof AssertionError && !error.generatedMessage;
  const frames = (error instanceof Error ? error.stack ?? '' : '').split('\n').filter(line => /^\s+at /.test(line))
    .map(line => /(?:\(|at )([\w./@:-]+):(\d+):(\d+)\)?$/.exec(line)).filter(Boolean).slice(0, 12)
    .map(match => clean(`${match[1]}:${match[2]}:${match[3]}`));
  const result = { code: error instanceof ValidationError || error instanceof TransportError ? error.code : error instanceof AssertionError ? 'assertion_failed' : error instanceof AggregateError ? 'multiple_failures' : 'operation_failed',
    message: safeMessage ? clean(error.safeMessage ?? error.message) : error instanceof AggregateError ? 'Multiple operation or cleanup failures' : 'Operation failed; inspect frames and causes', stack_frames: frames };
  if (Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599) result.http_status = error.status;
  if (error instanceof AggregateError) result.errors = error.errors.slice(0, 8).map(value => safeFailure(value, secrets, seen));
  if (error?.cause !== undefined) result.cause = safeFailure(error.cause, secrets, seen);
  return result;
}

export function reportFailure(label, error) {
  console.error(`${label}: ${JSON.stringify(safeFailure(error))}`);
}
