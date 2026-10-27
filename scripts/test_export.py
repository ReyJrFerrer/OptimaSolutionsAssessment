import csv
import io
import tempfile
import unittest
from datetime import datetime, timezone, timedelta
from pathlib import Path
from unittest.mock import patch
from export_recent_deals import export_deals, fetch_json, HEADERS

class ExportTests(unittest.TestCase):
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
