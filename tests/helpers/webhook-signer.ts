import { createHmac } from 'node:crypto';
export const secret = 's'.repeat(32);
export const admin = 'a'.repeat(32);
export const sign = (raw: string, key = secret) =>
  'sha256=' + createHmac('sha256', key).update(raw).digest('hex');
