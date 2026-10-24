import { custom, strictObject, string } from 'zod';
import { validArchiveKey, validRssKey } from '../committed';

export const repairSchema = strictObject({
  // Keep the original UTF-16 length rule, including non-ASCII version strings.
  expected_version: string().refine(value => !!value && value.length <= 256),
  manifest: string().regex(/^publications\/[a-f0-9-]{36}\.json$/),
  rss: custom<string>(validRssKey),
  archives: custom<string>(validArchiveKey).nullable(),
});
export const repairControlSchema = strictObject({ expected_recovery_token: string(), expected_version: string() });
