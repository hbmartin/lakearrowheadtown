import { timingSafeEqual } from 'node:crypto';
import { fingerprint, type OperationTrace } from '../diagnostics';
import { boundary, declaredBodyBytes } from '../errors';
import type { Env } from '../types';
import { HttpError, readLimited } from '../validation';
import { json, originFor, type RequestState } from './lifecycle';
async function authenticate(request: Request, secret?: string): Promise<void> {
  if (!secret || secret.length < 32) throw new HttpError(503, 'Publishing secret is not configured', {}, { code: 'configuration_error' });
  const token = /^Bearer +([^\s]+)$/i.exec(request.headers.get('authorization') ?? '')?.[1] ?? '';
  const [provided, expected] = await Promise.all([token, secret].map(async value => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))));
  if (!timingSafeEqual(provided, expected)) throw new HttpError(401, 'Unauthorized');
}

async function publisherFor(env: Env, trace: OperationTrace) {
  return trace.run('publisher_lookup', async () => {
    const unavailableBinding = () => new HttpError(503, 'Publisher binding is not configured correctly', {}, { code: 'configuration_error', retryable: false });
    if (!env.PUBLISHER || typeof env.PUBLISHER.getByName !== 'function') {
      throw unavailableBinding();
    }
    const publisher = await boundary('rpc', () => env.PUBLISHER.getByName('site'));
    if (!publisher || !['object', 'function'].includes(typeof publisher)) throw unavailableBinding();
    return publisher;
  });
}

export async function jsonBytes(request: Request, state: RequestState, limit = 1024 * 1024): Promise<ArrayBuffer> {
  await state.trace.run('content_type', () => {
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new HttpError(415, 'Expected application/json');
  });
  state.bytes_received = 0; state.body_complete = false; state.declared_body_bytes = declaredBodyBytes(request);
  const bytes = await state.trace.run('body_reading', () => readLimited(request, limit, size => { state.bytes_received = size; }));
  state.bytes_received = bytes.byteLength; state.body_complete = true; state.body_sha256 = fingerprint(new Uint8Array(bytes));
  return bytes;
}

export function buildServices(request: Request, env: Env, state: RequestState) {
  const { context, trace } = state;
  return {
    request, env, state, context, trace, query: new URL(request.url).searchParams,
    authenticate: () => trace.run('authentication', () => authenticate(request, env.API_SECRET)),
    origin: () => trace.run('configuration', () => originFor(request, env)),
    publisher: () => publisherFor(env, trace),
    reply: (value: Record<string, unknown>, status = 200, headers: HeadersInit = {}) => json({ ...value, request_id: context.request_id }, status, headers),
  };
}
export type ApiServices = ReturnType<typeof buildServices>;
export type AppEnv = { Bindings: Env; Variables: { state: RequestState; services: ApiServices } };
