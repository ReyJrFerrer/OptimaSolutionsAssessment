"""Opt-in Docker check: synthetic credentials, isolated volume, no HubSpot calls.

Run from the repository root: python3 tests/manual/docker-smoke.py
Uses alternate host ports 33001/35173/35678; builds images before starting.
Retains its isolated app/n8n volumes; normal down never removes them.
"""
import hashlib
import hmac
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.error
import urllib.request


def main():
    with tempfile.TemporaryDirectory() as temporary:
        envfile = Path(temporary) / 'smoke.env'
        secret, admin = 's' * 32, 'a' * 32
        envfile.write_text(f'HUBSPOT_ACCESS_TOKEN=synthetic-not-a-token\nWEBHOOK_SECRET={secret}\nDASHBOARD_ADMIN_TOKEN={admin}\nHUBSPOT_PHP_CONFIRMED=false\nAPI_HOST_PORT=33001\nWEB_HOST_PORT=35173\nN8N_HOST_PORT=35678\nN8N_DATA_EXTERNAL=false\nN8N_DATA_VOLUME=optima-docker-smoke_n8n-data\n')
        environment = {k: v for k, v in os.environ.items() if not k.startswith(('HUBSPOT_', 'WEBHOOK_', 'DASHBOARD_', 'COMPOSE_', 'API_HOST_PORT', 'WEB_HOST_PORT', 'N8N_', 'NODE_FUNCTION_'))}
        command = ['docker', 'compose', '--env-file', str(envfile), '-p', 'optima-docker-smoke', '--profile', 'automation']

        def compose(*args):
            subprocess.run(command + list(args), env=environment, check=True)

        def request(path, body=None, headers=None):
            try:
                with urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:35173' + path, data=body, headers=headers or {}), timeout=5) as response:
                    return response.status, response.read()
            except urllib.error.HTTPError as error:
                return error.code, error.read()

        def history(count):
            for _ in range(30):
                status, data = request('/api/sync-attempts', headers={'Authorization': 'Bearer ' + admin})
                rows = json.loads(data)
                if status == 200 and len(rows) == count and rows[0]['current_order_state'] == 'failed':
                    return rows
                time.sleep(1)
            raise AssertionError('Expected failed attempts were not visible')

        try:
            compose('config', '--quiet')
            compose('up', '--build', '-d', '--wait')
            compose('ps')
            with urllib.request.urlopen('http://127.0.0.1:35678/healthz/readiness', timeout=5) as response:
                assert response.status == 200
            compose('exec', '-T', 'n8n', 'node', '-e', "const fs=require('node:fs');if(process.getuid()!==1000||process.env.NODE_FUNCTION_ALLOW_BUILTIN!=='crypto'||process.env.N8N_RUNNERS_MODE!=='internal'||process.env.WEBHOOK_URL!=='http://localhost:35678/'||process.env.HUBSPOT_ACCESS_TOKEN||process.env.WEBHOOK_SECRET||process.env.DASHBOARD_ADMIN_TOKEN)process.exit(1);for(const file of ['order-to-hubspot.json','error-notification.json'])JSON.parse(fs.readFileSync('/workflows/'+file));const config=JSON.parse(fs.readFileSync('/home/node/.n8n/config'));if(!config.encryptionKey)process.exit(1);fs.writeFileSync('/home/node/.n8n/optima-smoke-key-hash',require('node:crypto').createHash('sha256').update(config.encryptionKey).digest('hex'));")
            assert request('/health')[0] == 200
            with urllib.request.urlopen('http://127.0.0.1:33001/health', timeout=5) as response:
                assert response.status == 200
            compose('exec', '-T', 'api', 'node', '-e', "const fs=require('node:fs');const db=require('better-sqlite3')('/data/orders.sqlite');if(process.getuid()===0||db.pragma('journal_mode',{simple:true})!=='wal'||fs.existsSync('/app/node_modules/typescript')||fs.existsSync('/app/node_modules/vite'))process.exit(1);db.close()")
            assert b'<div id="root">' in request('/')[1]
            assert request('/reviewer/deep/link')[0] == 200
            assert request('/api/sync-attempts')[0] == 401
            body = json.loads(Path('tests/fixtures/sample-order.json').read_text())
            body['order_id'] = 'DOCKER-' + str(time.time_ns())
            payload = json.dumps(body).encode()
            headers = {'Content-Type': 'application/json', 'X-Order-Signature': 'sha256=' + hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()}
            assert request('/api/webhooks/orders', payload, {'Content-Type': 'application/json'})[0] == 401
            assert request('/api/webhooks/orders', payload, headers)[0] == 202
            assert json.loads(request('/api/webhooks/orders', payload, headers)[1])['duplicate']
            # Prior smoke runs remain in this isolated volume.
            for _ in range(30):
                rows = json.loads(request('/api/sync-attempts', headers={'Authorization': 'Bearer ' + admin})[1])
                if rows and rows[0]['order_id'] == body['order_id'] and rows[0]['current_order_state'] == 'failed':
                    break
                time.sleep(1)
            assert rows[0]['error_code'] == 'PHP_CURRENCY_NOT_CONFIRMED'
            before = history(len(rows))
            compose('down')
            compose('up', '-d', '--wait')
            with urllib.request.urlopen('http://127.0.0.1:35678/healthz/readiness', timeout=5) as response:
                assert response.status == 200
            compose('exec', '-T', 'n8n', 'node', '-e', "const fs=require('node:fs');const key=JSON.parse(fs.readFileSync('/home/node/.n8n/config')).encryptionKey;if(require('node:crypto').createHash('sha256').update(key).digest('hex')!==fs.readFileSync('/home/node/.n8n/optima-smoke-key-hash','utf8'))process.exit(1)")
            assert history(len(before)) == before
            retry = '/api/orders/' + body['order_id'] + '/retry'
            assert request(retry, b'', {'Authorization': 'Bearer ' + admin})[0] == 202
            after = history(min(50, len(before) + 1))
            assert after[0]['attempt_number'] == 2
            assert after[1] == before[0]
            compose('logs', '--tail', '15')
            print('PASS: routing, health, auth, HMAC, duplicate, failed history, recreation persistence, manual retry; n8n health, crypto configuration, non-root UID, workflow mounts, secret isolation and persistent encryption key')
        finally:
            compose('down')


if __name__ == '__main__':
    main()
