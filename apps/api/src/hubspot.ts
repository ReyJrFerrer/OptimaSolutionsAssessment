import type { Order } from './order.js';
const ROOT = '/crm/objects/2026-09';
export const endpoints = {
  contacts: `${ROOT}/contacts`,
  deals: `${ROOT}/deals`,
  property: '/crm/properties/2026-09/deals/external_order_id',
  pipeline: '/crm/pipelines/2026-09/deals',
};
export class HubSpotError extends Error {
  constructor(
    public code: string,
    public status = 0,
    correlation?: string,
    detail?: string,
  ) {
    super(
      `${code}${detail ? ` (${detail})` : ''}${correlation && /^[a-zA-Z0-9-]{1,100}$/.test(correlation) ? `; correlation ${correlation}` : ''}. Check token scopes, pipeline/stage, currency and unique property setup.`,
    );
  }
}
type Settings = {
  token: string;
  pipeline: string;
  stage: string;
  phpConfirmed: boolean;
};
type RecordResult = { id: string };
export class HubSpotClient {
  constructor(
    private settings: Settings,
    private transport: typeof fetch = fetch,
    private sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}
  async request<T>(
    path: string,
    method = 'GET',
    body?: unknown,
    beforeRetry?: () => Promise<T | undefined>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt++) {
      let response: Response;
      try {
        response = await this.transport('https://api.hubapi.com' + path, {
          method,
          headers: {
            Authorization: `Bearer ${this.settings.token}`,
            'Content-Type': 'application/json',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(10000),
        });
      } catch {
        if (attempt === 3) throw new HubSpotError('HUBSPOT_NETWORK');
        await this.sleep(
          Math.min(30000, 1000 * 2 ** attempt + Math.random() * 250),
        );
        if (beforeRetry) {
          const found = await beforeRetry();
          if (found) return found;
        }
        continue;
      }
      if (response.ok) {
        if (response.status === 204) return undefined as T;
        try {
          return (await response.json()) as T;
        } catch {
          throw new HubSpotError('HUBSPOT_INVALID_RESPONSE', response.status);
        }
      }
      let correlation: string | undefined;
      let detail: string | undefined;
      try {
        const data = (await response.json()) as {
          correlationId?: string;
          errors?: { code?: string }[];
        };
        const safeCodes = new Set([
          'INVALID_EMAIL',
          'INVALID_OPTION',
          'PROPERTY_DOESNT_EXIST',
          'INVALID_INTEGER',
          'INVALID_NUMBER',
          'INVALID_DATE',
          'INVALID_CURRENCY',
          'MISSING_SCOPES',
        ]);
        detail = data.errors
          ?.map((e) => e.code)
          .find((code) => code !== undefined && safeCodes.has(code));
        correlation = data.correlationId;
      } catch {
        /* Response body is never logged. */
      }
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === 3)
        throw new HubSpotError(
          `HUBSPOT_HTTP_${response.status}`,
          response.status,
          correlation,
          detail,
        );
      const header = response.headers.get('retry-after');
      const wait = header
        ? Number.isFinite(Number(header))
          ? Number(header) * 1000
          : Date.parse(header) - Date.now()
        : 0;
      await this.sleep(
        Math.min(
          30000,
          Math.max(
            1000 * 2 ** attempt + Math.random() * 250,
            Number.isFinite(wait) ? wait : 0,
          ),
        ),
      );
      if (beforeRetry) {
        const found = await beforeRetry();
        if (found) return found;
      }
    }
    throw new HubSpotError('HUBSPOT_RETRY_EXHAUSTED');
  }
  async findDeal(orderId: string) {
    try {
      return await this.request<RecordResult>(
        `${endpoints.deals}/${encodeURIComponent(orderId)}?idProperty=external_order_id`,
      );
    } catch (e) {
      if (e instanceof HubSpotError && e.status === 404) return undefined;
      throw e;
    }
  }
  async sync(o: Order, save: (contact: string, deal?: string) => void) {
    if (!this.settings.phpConfirmed)
      throw new HubSpotError('PHP_CURRENCY_NOT_CONFIRMED');
    await this.verifySetup();
    const properties = {
      email: o.customer.email,
      firstname: o.customer.first_name,
      lastname: o.customer.last_name,
      ...(o.customer.phone ? { phone: o.customer.phone } : {}),
    };
    const search = await this.request<{ results: RecordResult[] }>(
      `${endpoints.contacts}/search`,
      'POST',
      {
        filterGroups: [
          {
            filters: [
              {
                propertyName: 'email',
                operator: 'EQ',
                value: o.customer.email,
              },
            ],
          },
        ],
        limit: 1,
      },
    );
    let contact: RecordResult | undefined = search.results[0];
    const rereadContact = async () => {
      try {
        return await this.request<RecordResult>(
          `${endpoints.contacts}/${encodeURIComponent(o.customer.email)}?idProperty=email`,
        );
      } catch (e) {
        if (e instanceof HubSpotError && e.status === 404) return undefined;
        throw e;
      }
    };
    if (!contact) {
      try {
        contact = await this.request<RecordResult>(
          endpoints.contacts,
          'POST',
          { properties },
          rereadContact,
        );
      } catch (e) {
        if (e instanceof HubSpotError && e.status === 409)
          contact = await rereadContact();
        else throw e;
      }
      if (!contact) throw new HubSpotError('CONTACT_CONFLICT_UNRESOLVED');
    }
    save(contact.id);
    await this.request(
      `${endpoints.contacts}/${encodeURIComponent(contact.id)}`,
      'PATCH',
      { properties },
    );
    let deal = await this.findDeal(o.order_id);
    if (!deal) {
      try {
        deal = await this.request<RecordResult>(
          endpoints.deals,
          'POST',
          {
            properties: {
              dealname: `Order ${o.order_id} — ${o.customer.first_name} ${o.customer.last_name}`,
              amount: o.total.toFixed(2),
              closedate: new Date(o.created_at).toISOString(),
              pipeline: this.settings.pipeline,
              dealstage: this.settings.stage,
              deal_currency_code: o.currency,
              external_order_id: o.order_id,
              description: o.items
                .map((i) => `${i.quantity} × ${i.name}`)
                .join('; ')
                .slice(0, 2000),
            },
            associations: [
              {
                to: { id: contact.id },
                types: [
                  {
                    associationCategory: 'HUBSPOT_DEFINED',
                    associationTypeId: 3,
                  },
                ],
              },
            ],
          },
          () => this.findDeal(o.order_id),
        );
      } catch (e) {
        if (
          e instanceof HubSpotError &&
          (e.status === 409 || e.status === 400)
        ) {
          deal = await this.findDeal(o.order_id);
          if (!deal) throw e;
        } else throw e;
      }
    }
    save(contact.id, deal.id);
    // PUT is idempotent and repairs a partial previous attempt.
    await this.request(
      `${endpoints.deals}/${encodeURIComponent(deal.id)}/associations/default/contacts/${encodeURIComponent(contact.id)}`,
      'PUT',
    );
  }
  async verifySetup() {
    const p = await this.request<{
      name: string;
      type: string;
      fieldType: string;
      hasUniqueValue: boolean;
    }>(endpoints.property);
    if (
      p.name !== 'external_order_id' ||
      p.type !== 'string' ||
      p.fieldType !== 'text' ||
      !p.hasUniqueValue
    )
      throw new HubSpotError('UNIQUE_PROPERTY_REQUIRED');
    const pipeline = await this.request<{ stages: { id: string }[] }>(
      `${endpoints.pipeline}/${encodeURIComponent(this.settings.pipeline)}`,
    );
    if (!pipeline.stages.some((s) => s.id === this.settings.stage))
      throw new HubSpotError('INVALID_PIPELINE_STAGE');
  }
}
