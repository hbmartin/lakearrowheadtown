import { HttpError } from './errors';

export class PublicationConflict extends HttpError {
  constructor() {
    super(503, 'The publication changed before this request could commit. Retry the unchanged request after the indicated time.',
      { 'Retry-After': '1' }, { code: 'publication_conflict', retryable: true, publication_status: 'not_committed', retry_at: new Date(Date.now() + 1000).toISOString() });
  }
}

export const indexCondition = (index: R2Object | null): R2Conditional => index ? { etagMatches: index.etag } : { etagDoesNotMatch: '*' };
