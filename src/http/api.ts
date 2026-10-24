import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { HttpError } from '../errors';
import { alerts } from './alerts';
import { changes } from './changes';
import { digests } from './digests';
import { events } from './events';
import { images } from './images';
import { beginRequest, errorResponse, finishRequest } from './lifecycle';
import { maintenance } from './maintenance';
import { posts } from './posts';
import { buildServices, type AppEnv } from './services';

const lifecycle = createMiddleware<AppEnv>(async (c, next) => {
  const state = beginRequest(c.req.raw, c.env);
  c.set('state', state);
  c.set('services', buildServices(c.req.raw, c.env, state));
  try { await next(); }
  // Hono v4 sends Error instances to onError, but non-Error throws escape next().
  catch (error) { c.res = errorResponse(error, c.req.raw, state); }
  c.res = await finishRequest(c.req.raw, c.env, state, c.res);
});

// Feature routes deliberately check methods themselves where API v3 requires
// authentication before 405, or rejects Hono's automatic HEAD-to-GET dispatch.
export const api = new Hono<AppEnv>({ strict: true, getPath: request => new URL(request.url).pathname })
  .use('*', lifecycle)
  .route('/api', changes)
  .route('/api', alerts)
  .route('/api', digests)
  .route('/api', events)
  .route('/api', posts)
  .route('/api', images)
  .route('/api', maintenance);

api.onError((error, c) => errorResponse(error, c.req.raw, c.var.state));
api.notFound(async c => {
  if (!['GET', 'HEAD'].includes(c.req.raw.method)) throw new HttpError(405, 'Method not allowed', { Allow: 'GET, HEAD' });
  // Preserve the diagnostic stage of the former public-route fallback.
  return c.var.state.trace.run('public_read', () => { throw new HttpError(404, 'Not found'); });
});
