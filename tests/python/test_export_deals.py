import csv
import io
import tempfile
import unittest
from datetime import datetime, timezone, timedelta
from pathlib import Path
from unittest.mock import patch
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from export_recent_deals import export_deals, fetch_json, HEADERS

class ExportTests(unittest.TestCase):
    def setUp(self):
        offline = patch("urllib.request.urlopen", side_effect=AssertionError("Real network forbidden in tests"))
        offline.start()
        self.addCleanup(offline.stop)

    def test_pages_boundary_dedup_and_csv_safety(self):
        now = datetime(2026, 10, 27, tzinfo=timezone.utc)
        cutoff = now - timedelta(days=7)
        calls = []
        def api(body):
            calls.append(body)
            if 'after' not in body:
                return {'results': [{'id': '1', 'properties': {'createdate': cutoff.isoformat(), 'dealname': '=danger', 'amount': '-10.00'}}, {'id': 'old', 'properties': {'createdate': (cutoff-timedelta(seconds=1)).isoformat()}}], 'paging': {'next': {'after': 'page2'}}}
            return {'results': [{'id': '1', 'properties': {'createdate': cutoff.isoformat()}}, {'id': '2', 'properties': {'createdate': now.isoformat()}}]}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'out.csv'
            self.assertEqual(export_deals(path, api, now), 2)
            with path.open(encoding='utf-8-sig', newline='') as f:
                reader=csv.DictReader(f); rows=list(reader)
                self.assertEqual(reader.fieldnames, HEADERS)
            self.assertEqual(rows[0]['deal_name'], "'=danger")
            self.assertEqual(rows[0]['amount'], '-10.00')
        self.assertEqual(calls[1]['after'], 'page2')
        self.assertEqual(calls[0]['filterGroups'][0]['filters'][0]['propertyName'], 'createdate')
    def test_empty(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'out.csv'
            self.assertEqual(export_deals(path, lambda body: {'results': []}), 0)
            self.assertEqual(path.read_text(encoding='utf-8-sig').strip(), ','.join(HEADERS))
    def test_failure_does_not_replace_existing_output(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'out.csv';path.write_text('original')
            def fail(body): raise RuntimeError('network')
            with self.assertRaises(RuntimeError): export_deals(path, fail)
            self.assertEqual(path.read_text(), 'original')
    def test_network_failure(self):
        with patch('urllib.request.urlopen', side_effect=OSError('private')):
            with self.assertRaisesRegex(RuntimeError, 'network'):
                fetch_json('fake', {}, sleep=lambda _:None)
    def test_rate_limit(self):
        import urllib.error
        from email.message import Message
        headers=Message();headers['Retry-After']='3'
        error=urllib.error.HTTPError('https://example.invalid',429,'rate',headers,io.BytesIO(b''))
        self.addCleanup(error.close)
        with patch('urllib.request.urlopen',side_effect=[error,io.BytesIO(b'{"results":[]}')]):
            waits=[]
            self.assertEqual(fetch_json('fake',{},sleep=waits.append),{'results':[]})
            self.assertGreaterEqual(waits[0],3)

    def test_splits_search_windows_at_hubspot_result_cap(self):
        now=datetime(2026,10,27,tzinfo=timezone.utc)
        calls=[]
        def api(body):
            calls.append(body)
            if len(calls)==1:
                return {'total':10000,'results':[]}
            return {'results':[{'id':'same','properties':{'createdate':now.isoformat()}}]}
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(export_deals(Path(directory)/'out.csv',api,now),1)
        self.assertEqual(len(calls),3)

    def test_repeated_cursor_fails_without_replacing_output(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'out.csv';path.write_text('original')
            with self.assertRaisesRegex(RuntimeError,'Repeated'):
                export_deals(path,lambda body:{'results':[],'paging':{'next':{'after':'same'}}})
            self.assertEqual(path.read_text(),'original')

    def test_future_dates_offsets_milliseconds_and_all_mappings(self):
        now = datetime(2026, 10, 27, tzinfo=timezone.utc)
        deals = [
            {'id': 'offset', 'properties': {'createdate': '2026-10-20T08:00:00+08:00', 'dealname': 'Sample', 'amount': '900.00', 'deal_currency_code': 'PHP', 'closedate': '2026-09-20T12:00:00Z', 'pipeline': 'default', 'dealstage': 'closedwon', 'external_order_id': 'ORD-10482'}},
            {'id': 'millis', 'properties': {'createdate': str(int(now.timestamp()*1000))}},
            {'id': 'future', 'properties': {'createdate': (now+timedelta(milliseconds=1)).isoformat()}},
            {'id': 'old', 'properties': {'createdate': (now-timedelta(days=7,milliseconds=1)).isoformat()}}
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'out.csv'
            self.assertEqual(export_deals(path, lambda _: {'results': deals}, now), 2)
            with path.open(encoding='utf-8-sig', newline='') as f:
                rows = list(csv.DictReader(f))
            self.assertEqual(rows[0], dict(zip(HEADERS, ['offset', 'Sample', '900.00', 'PHP', '2026-10-20T00:00:00+00:00', '2026-09-20T12:00:00Z', 'default', 'closedwon', 'ORD-10482'])))
            self.assertEqual(rows[1]['currency'], '')

    def test_http_status_policy_and_exhaustion(self):
        import urllib.error
        from email.message import Message
        for status in [400, 401, 403, 429, 500, 502, 503, 504]:
            with self.subTest(status=status):
                error = urllib.error.HTTPError('https://example.invalid', status, 'private', Message(), io.BytesIO(b''))
                self.addCleanup(error.close)
                with patch('urllib.request.urlopen', side_effect=error) as http:
                    waits = []
                    with self.assertRaisesRegex(RuntimeError, f'HTTP {status}'):
                        fetch_json('fake', {}, sleep=waits.append)
                    self.assertEqual(http.call_count, 1 if status < 429 else 4)
                    self.assertEqual(len(waits), 0 if status < 429 else 3)

    def test_transient_server_failure_recovers(self):
        import urllib.error
        from email.message import Message
        error = urllib.error.HTTPError('https://example.invalid', 503, 'private', Message(), io.BytesIO(b''))
        self.addCleanup(error.close)
        with patch('urllib.request.urlopen', side_effect=[error, io.BytesIO(b'{"results":[]}')]) as http:
            waits = []
            self.assertEqual(fetch_json('fake', {}, sleep=waits.append), {'results': []})
            self.assertEqual(http.call_count, 2)
            self.assertEqual(len(waits), 1)
