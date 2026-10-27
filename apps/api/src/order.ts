import { z } from 'zod';
const money = z
  .number()
  .finite()
  .nonnegative()
  .max(1_000_000_000)
  .refine(
    (n) => Math.abs(n * 100 - Math.round(n * 100)) < 0.00001,
    'Use two decimal places',
  );
const text = z.string().trim().min(1).max(200);
export const orderSchema = z
  .object({
    event: z.literal('order.created'),
    order_id: text.regex(/^[A-Za-z0-9_-]+$/),
    created_at: z.iso.datetime({ offset: true }),
    customer: z.object({
      email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
      first_name: text,
      last_name: text,
      phone: z.string().trim().min(1).max(50).optional(),
    }),
    items: z
      .array(
        z.object({
          name: text,
          quantity: z.number().int().positive().max(100000),
          price: money,
        }),
      )
      .min(1)
      .max(500),
    total: money,
    currency: z.literal('PHP'),
  })
  .superRefine((o, ctx) => {
    const total = o.items.reduce(
      (sum, i) => sum + i.quantity * Math.round(i.price * 100),
      0,
    );
    if (!Number.isSafeInteger(total) || total !== Math.round(o.total * 100))
      ctx.addIssue({
        code: 'custom',
        path: ['total'],
        message: 'Total does not match items',
      });
  });
export type Order = z.infer<typeof orderSchema>;
export const parseOrder = (value: unknown): Order => orderSchema.parse(value);
// Explicit field order makes hashes independent of incoming JSON key order.
export const canonical = (o: Order) => JSON.stringify(o);
