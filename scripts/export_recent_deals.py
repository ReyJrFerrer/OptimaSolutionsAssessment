"""Export all recently created HubSpot deals; no third-party Python packages."""
import argparse
import csv
import json
import os
import random
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

URL = 'https://api.hubapi.com/crm/objects/2026-09/deals/search'
HEADERS = ['deal_id', 'deal_name', 'amount', 'currency', 'created_at_utc', 'close_date', 'pipeline', 'stage', 'external_order_id']
PROPERTIES = ['dealname', 'amount', 'deal_currency_code', 'createdate', 'closedate', 'pipeline', 'dealstage', 'external_order_id']


def fetch_json(token, body, sleep=time.sleep):
    request = urllib.request.Request(URL, data=json.dumps(body).encode(), headers={'Authorization': 'Bearer '+token, 'Content-Type': 'application/json'})
    for attempt in range(4):
        delay = 2**attempt + random.random()/4
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if error.code != 429 and error.code < 500:
                raise RuntimeError(f'HubSpot HTTP {error.code}; check credentials and scopes') from None
            if attempt == 3:
                raise RuntimeError(f'HubSpot HTTP {error.code}; retry exhausted') from None
            retry_after = error.headers.get('Retry-After', '')
            try:
                delay = max(delay, float(retry_after))
            except ValueError:
                from email.utils import parsedate_to_datetime
                try:
                    delay = max(delay, (parsedate_to_datetime(retry_after)-datetime.now(timezone.utc)).total_seconds())
                except (ValueError, TypeError, OverflowError):
                    pass
        except (OSError, ValueError):
            if attempt == 3:
                raise RuntimeError('HubSpot network or JSON error; retry exhausted') from None
        sleep(min(30, max(0, delay)))
    raise RuntimeError('HubSpot retry exhausted')


def instant(value):
    if isinstance(value, (int, float)) or (isinstance(value, str) and value.isdigit()):
        return datetime.fromtimestamp(int(value)/1000, timezone.utc)
    result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if result.tzinfo is None:
        raise ValueError('Timestamp must include UTC offset')
    return result.astimezone(timezone.utc)


def safe(value):
    value = '' if value is None else str(value)
    return "'"+value if value.lstrip().startswith(('=', '+', '-', '@')) or value.startswith(('\t', '\r', '\n')) else value


def export_deals(output, api, now=None):
    now = now or datetime.now(timezone.utc)
    cutoff = now-timedelta(days=7)
    output = Path(output)
    seen = set()
    cursor = None
    cursors = set()
    # Slice search windows when HubSpot's 10,000 result cap is reached.
    def rows(start, end):
        nonlocal cursor
        cursor = None
        cursors.clear()
        while True:
            body = {'filterGroups': [{'filters': [
                {'propertyName': 'createdate', 'operator': 'GTE', 'value': str(int(start.timestamp()*1000))},
                {'propertyName': 'createdate', 'operator': 'LTE', 'value': str(int(end.timestamp()*1000))}]}],
                'properties': PROPERTIES, 'sorts': ['createdate'], 'limit': 200}
            if cursor is not None:
                body['after'] = cursor
            page = api(body)
            if int(page.get('total', 0)) >= 10000:
                if (end-start).total_seconds() <= .001:
                    raise RuntimeError('Too many deals at one timestamp; use HubSpot bulk export')
                middle = start+(end-start)/2
                yield from rows(start, middle)
                yield from rows(middle, end)
                return
            for deal in page.get('results', []):
                props = deal.get('properties', {})
                created = instant(props.get('createdate', ''))
                identifier = str(deal['id'])
                if not cutoff <= created <= now or identifier in seen:
                    continue
                seen.add(identifier)
                values = [identifier, props.get('dealname'), props.get('amount'), props.get('deal_currency_code'), created.isoformat(), props.get('closedate'), props.get('pipeline'), props.get('dealstage'), props.get('external_order_id')]
                row = dict(zip(HEADERS, map(safe, values)))
                # Only validated numeric amounts may retain a leading minus sign.
                from decimal import Decimal, InvalidOperation
                amount = str(props.get('amount') or '')
                try:
                    if Decimal(amount).is_finite():
                        row['amount'] = amount
                except InvalidOperation:
                    pass
                yield row
            cursor = page.get('paging', {}).get('next', {}).get('after')
            if cursor is None:
                return
            if str(cursor) in cursors:
                raise RuntimeError('Repeated pagination cursor')
            cursors.add(str(cursor))
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8-sig', newline='', dir=output.parent, delete=False) as f:
            temporary = Path(f.name)
            writer = csv.DictWriter(f, fieldnames=HEADERS)
            writer.writeheader()
            for row in rows(cutoff, now):
                writer.writerow(row)
        os.replace(temporary, output)
    finally:
        if temporary and temporary.exists():
            temporary.unlink()
    return len(seen)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', default='deals_last_7_days.csv')
    args = parser.parse_args()
    # Load local .env without printing it; existing process variables take precedence.
    env = Path(__file__).resolve().parents[1]/'.env'
    if env.exists():
        for line in env.read_text().splitlines():
            key, sep, value = line.partition('=')
            if sep and key.strip() == 'HUBSPOT_ACCESS_TOKEN':
                os.environ.setdefault(key.strip(), value.strip().strip('\"\''))
    token = os.environ.get('HUBSPOT_ACCESS_TOKEN')
    if not token:
        print('HUBSPOT_ACCESS_TOKEN is required', file=sys.stderr)
        return 1
    try:
        count = export_deals(args.output, lambda body: fetch_json(token, body))
    except Exception:
        print('Export failed; check network, token scopes and Deal property setup. Existing output preserved.', file=sys.stderr)
        return 1
    print(f'{args.output}: {count} deals')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
