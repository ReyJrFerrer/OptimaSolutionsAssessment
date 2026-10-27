import express, { type ErrorRequestHandler } from 'express';
import { createHmac, timingSafeEqual, createHash } from 'node:crypto';
import { ZodError } from 'zod';
import { parseOrder } from './order.js';
import type { Store } from './db/store.js';
export function createApp(store: Store, secret: string, adminToken: string) {
  const app = express();
  app.disable('x-powered-by');
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.post(
    '/api/webhooks/orders',
    express.raw({ type: 'application/json', limit: '256kb', inflate: false }),
    (req, res) => {
      const signature = req.get('X-Order-Signature');
      if (
        !Buffer.isBuffer(req.body) ||
        !signature ||
        !/^sha256=[a-f0-9]{64}$/.test(signature) ||
        !timingSafeEqual(
          createHmac('sha256', secret).update(req.body).digest(),
          Buffer.from(signature.slice(7), 'hex'),
        )
      ) {
        res.status(401).json({ error: 'INVALID_SIGNATURE' });
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(req.body.toString('utf8'));
      } catch {
        res.status(400).json({ error: 'INVALID_JSON' });
        return;
      }
      const result = store.reserve(parseOrder(payload));
      if (result.conflict) {
        res.status(409).json({ error: 'ORDER_CONFLICT' });
        return;
      }
      res.status(result.duplicate ? 200 : 202).json({
        orderId: result.row.order_id,
        status: result.row.status,
        ...(result.duplicate ? { duplicate: true } : {}),
      });
    },
  );
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const supplied = req.get('Authorization') ?? '';
    const hash = (s: string) => createHash('sha256').update(s).digest();
    if (!timingSafeEqual(hash(supplied), hash('Bearer ' + adminToken))) {
      res.status(401).json({ error: 'UNAUTHORIZED' });
      return;
    }
    next();
  });
  app.get('/api/sync-attempts', (req, res) => {
    const n = Number(req.query.limit ?? 50);
    if (!Number.isInteger(n) || n < 1) {
      res.status(400).json({ error: 'INVALID_LIMIT' });
      return;
    }
    res.json(store.attempts(n));
  });
  app.post('/api/orders/:orderId/retry', (req, res) => {
    if (!store.retry(req.params.orderId)) {
      res.status(409).json({ error: 'ORDER_NOT_FAILED' });
      return;
    }
    res.status(202).json({ orderId: req.params.orderId, status: 'queued' });
  });
  const errors: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof ZodError) {
      res.status(400).json({
        error: 'INVALID_ORDER',
        fields: err.issues.map((i) => i.path.join('.')),
      });
      return;
    }
    if (err?.type === 'encoding.unsupported') {
      res.status(415).json({ error: 'UNSUPPORTED_CONTENT_ENCODING' });
      return;
    }
    if (err?.type === 'entity.too.large') {
      res.status(413).json({ error: 'BODY_TOO_LARGE' });
      return;
    }
    console.error(JSON.stringify({ code: 'REQUEST_FAILED' }));
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  };
  app.use(errors);
  return app;
}
