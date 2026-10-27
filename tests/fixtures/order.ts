export const sample = {
  event: 'order.created',
  order_id: 'TEST-1',
  created_at: '2026-09-20T12:00:00Z',
  customer: {
    email: '  TEST@example.invalid ',
    first_name: 'Test',
    last_name: 'Buyer',
  },
  items: [{ name: 'Item', quantity: 2, price: 10.25 }],
  total: 20.5,
  currency: 'PHP',
};
