// Run ONLY inside a disposable n8n container; see n8n/README.md.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';
assert.equal(
  process.env.N8N_USER_FOLDER,
  '/tmp/optima-n8n-smoke',
  'Run only with the documented isolated user folder',
);
const base = '/work/n8n/';
function command(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('n8n', args, { env: process.env });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('exit', (code) =>
      code === 0
        ? resolve(out)
        : reject(Error('n8n CLI failed: ' + out.slice(-5000))),
    );
  });
}
let deals = 0,
  associations = 0,
  contacts = 0,
  forceFailure = false,
  notificationCount = 0,
  engine;
const smtp = net.createServer((socket) => {
  socket.write('220 isolated.test ESMTP\r\n');
  let buffer = '',
    data = false;
  socket.on('data', (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      if (data) {
        if (line === '.') {
          data = false;
          notificationCount++;
          socket.write('250 accepted\r\n');
        }
        continue;
      }
      if (/^EHLO|^HELO/i.test(line)) socket.write('250 isolated.test\r\n');
      else if (/^DATA/i.test(line)) {
        data = true;
        socket.write('354 end with dot\r\n');
      } else if (/^QUIT/i.test(line)) {
        socket.end('221 bye\r\n');
      } else socket.write('250 OK\r\n');
    }
  });
});
const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  const p = req.url,
    m = req.method;
  let status = 200,
    body = {};
  if (forceFailure) {
    status = 401;
  } else if (p.includes('/crm/properties/'))
    body = {
      name: 'external_order_id',
      type: 'string',
      fieldType: 'text',
      hasUniqueValue: true,
    };
  else if (p.includes('/crm/pipelines/'))
    body = { stages: [{ id: 'closedwon' }] };
  else if (p.endsWith('/deals/search'))
    body = { results: deals ? [{ id: 'synthetic-deal' }] : [] };
  else if (p.includes('/deals/') && m === 'GET') {
    status = deals ? 200 : 404;
    body = { id: 'synthetic-deal' };
  } else if (p.endsWith('/contacts/search'))
    body = { results: contacts ? [{ id: 'synthetic-contact' }] : [] };
  else if (p.includes('/contacts/') && m === 'GET') {
    status = contacts ? 200 : 404;
    body = { id: 'synthetic-contact' };
  } else if (p.endsWith('/contacts') && m === 'POST') {
    contacts++;
    body = { id: 'synthetic-contact' };
  } else if (m === 'PATCH') body = { id: 'synthetic-contact' };
  else if (p.endsWith('/deals') && m === 'POST') {
    deals++;
    if (!raw) {
      console.log('EMPTY_BODY', m, p, req.headers['content-type']);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    assert.equal(JSON.parse(raw).properties.amount, '900.00');
    body = { id: 'synthetic-deal' };
  } else if (m === 'PUT') {
    associations++;
  } else {
    status = 400;
  }
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(status === 404 ? 'Not Found' : JSON.stringify(body));
});
(async () => {
  await new Promise((r) => server.listen(8099, '127.0.0.1', r));
  const original = JSON.parse(fs.readFileSync(base + 'order-to-hubspot.json'));
  const error = JSON.parse(fs.readFileSync(base + 'error-notification.json'));
  original.id = 'optimaIsolatedMain';
  error.id = 'optimaIsolatedError';
  original.settings.errorWorkflow = error.id;
  fs.writeFileSync('/tmp/original.json', JSON.stringify(original));
  fs.writeFileSync('/tmp/error.json', JSON.stringify(error));
  await command(['import:workflow', '--input=/tmp/original.json']);
  await command(['import:workflow', '--input=/tmp/error.json']);
  console.log('PASS: both unchanged node graphs imported into isolated n8n');
  // Execute a test copy: synthetic trigger, local fake CRM, fake credential, PHP guard confirmed.
  const w = structuredClone(original);
  w.id = 'optimaIsolatedHarness';
  w.name += ' - ISOLATED TEST';
  const trigger = w.nodes.find((n) => n.name === 'Order Webhook');
  trigger.type = 'n8n-nodes-base.manualTrigger';
  trigger.typeVersion = 1;
  trigger.parameters = {};
  const fixture = JSON.parse(
    fs.readFileSync(base + 'fixtures/sample-order.json'),
  );
  const raw = JSON.stringify(fixture, null, 2),
    secret = 'synthetic-n8n-smoke-secret';
  const input = {
    headers: {
      'content-type': 'application/json',
      'x-order-signature':
        'sha256=' + createHmac('sha256', secret).update(raw).digest('hex'),
    },
  };
  const rawNode = w.nodes.find((n) => n.name === 'Read Raw Request');
  rawNode.parameters.jsCode = `return [{json:${JSON.stringify({ ...input, raw: Buffer.from(raw).toString('base64') })},binary:{data:{data:${JSON.stringify(Buffer.from(raw).toString('base64'))},mimeType:'application/json'}}}];`;
  const validation = w.nodes.find(
    (n) => n.name === 'Verify Signature and Validate Order',
  );
  validation.parameters.jsCode = validation.parameters.jsCode.replace(
    'phpConfirmed:false',
    'phpConfirmed:true',
  );
  const plan = w.nodes.find((n) => n.name === 'Plan HubSpot Request');
  plan.parameters.jsCode = plan.parameters.jsCode.replace(
    'https://api.hubapi.com',
    'http://127.0.0.1:8099',
  );
  const creds = [
    {
      id: 'CONFIGURE_CRYPTO_CREDENTIAL',
      name: 'Optima Order HMAC',
      type: 'crypto',
      data: { hmacSecret: secret },
    },
    {
      id: 'CONFIGURE_HUBSPOT_CREDENTIAL',
      name: 'Optima HubSpot Service Key',
      type: 'httpHeaderAuth',
      data: { name: 'Authorization', value: 'Bearer synthetic' },
    },
  ];
  fs.writeFileSync('/tmp/credentials.json', JSON.stringify(creds));
  await command(['import:credentials', '--input=/tmp/credentials.json']);
  fs.writeFileSync('/tmp/harness.json', JSON.stringify(w));
  await command(['import:workflow', '--input=/tmp/harness.json']);
  for (let i = 0; i < 2; i++) {
    const output = await command(['execute', '--id=' + w.id, '--rawOutput']);
    assert.match(
      output,
      /"success"\s*:\s*true/,
      'workflow must return success',
    );
    if (i) assert.match(output, /already_synced/);
  }
  assert.equal(deals, 1);
  assert.equal(contacts, 1);
  assert.equal(associations, 2);
  console.log(
    'PASS: real Crypto v2 + Code + HTTP + loop + response nodes; sequential duplicates yield one fake Deal and repair association twice',
  );
  // Round-trip real CLI exports and import again into a new workflow ID.
  await command([
    'export:workflow',
    '--id=' + original.id,
    '--output=/tmp/export-main.json',
  ]);
  await command([
    'export:workflow',
    '--id=' + error.id,
    '--output=/tmp/export-error.json',
  ]);
  for (const file of ['/tmp/export-main.json', '/tmp/export-error.json']) {
    const round = JSON.parse(fs.readFileSync(file));
    round[0].id += 'RoundTrip';
    fs.writeFileSync(file, JSON.stringify(round));
    await command(['import:workflow', '--input=' + file]);
  }
  console.log('PASS: both workflow exports re-imported under fresh IDs');
  // Actual published raw-body Webhook and automatic Error Trigger, against isolated CRM/SMTP sinks.
  await new Promise((r) => smtp.listen(2525, '127.0.0.1', r));
  creds.push({
    id: 'CONFIGURE_SMTP_CREDENTIAL',
    name: 'Optima Failure Notifications',
    type: 'smtp',
    data: {
      host: '127.0.0.1',
      port: 2525,
      secure: false,
      disableStartTls: true,
      user: '',
      password: '',
    },
  });
  fs.writeFileSync('/tmp/credentials.json', JSON.stringify(creds));
  await command(['import:credentials', '--input=/tmp/credentials.json']);
  original.active = true;
  original.nodes.find(
    (n) => n.name === 'Verify Signature and Validate Order',
  ).parameters.jsCode = validation.parameters.jsCode;
  original.nodes.find(
    (n) => n.name === 'Plan HubSpot Request',
  ).parameters.jsCode = plan.parameters.jsCode;
  fs.writeFileSync('/tmp/active.json', JSON.stringify(original));
  await command(['import:workflow', '--input=/tmp/active.json']);
  await command(['publish:workflow', '--id=' + error.id]);
  await command(['publish:workflow', '--id=' + original.id]);
  engine = spawn('n8n', ['start'], {
    env: { ...process.env, N8N_PORT: '5678' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let engineLog = '';
  engine.stdout.on('data', (d) => (engineLog += d));
  engine.stderr.on('data', (d) => (engineLog += d));
  let ready = false;
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const r = await fetch('http://127.0.0.1:5678/healthz/readiness');
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {
      /* Server is still starting. */
    }
  }
  assert.ok(ready, 'isolated n8n server readiness: ' + engineLog.slice(-2000));
  await new Promise((r) => setTimeout(r, 2000));
  const send = async (signature, body = raw) =>
    fetch('http://127.0.0.1:5678/webhook/optima-orders', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-order-signature': signature,
      },
      body,
    });
  const signature = input.headers['x-order-signature'];
  deals = 0;
  contacts = 0;
  associations = 0;
  for (let i = 0; i < 2; i++) {
    const r = await send(signature);
    const b = await r.json();
    assert.equal(
      r.status,
      200,
      JSON.stringify(b) + '; engine=' + engineLog.slice(-7000),
    );
    assert.equal(b.success, true);
    if (i) assert.equal(b.duplicate, true);
  }
  assert.equal(deals, 1);
  assert.equal(contacts, 1);
  assert.equal(associations, 2);
  const missing = await send('');
  assert.equal(missing.status, 401);
  const tampered = await send(signature, raw + ' ');
  assert.equal(tampered.status, 401);
  const invalid = JSON.stringify({ ...fixture, total: 1 });
  const invalidSignature =
    'sha256=' + createHmac('sha256', secret).update(invalid).digest('hex');
  const invalidResponse = await send(invalidSignature, invalid);
  assert.equal(invalidResponse.status, 400);
  assert.equal(deals, 1);
  const bad = await send('sha256=' + '0'.repeat(64));
  assert.equal(bad.status, 401);
  assert.equal(notificationCount, 0);
  forceFailure = true;
  const failed = await send(signature);
  assert.equal(failed.status, 502);
  for (let i = 0; i < 80 && !notificationCount; i++)
    await new Promise((r) => setTimeout(r, 250));
  assert.equal(
    notificationCount,
    1,
    'automatic Error Trigger must deliver exactly one SMTP notification; logs: ' +
      engineLog.slice(-15000),
  );
  console.log(
    'PASS: published raw-byte webhook, valid+duplicate 200, invalid HMAC 401 without alert, operational 502 automatically triggers error workflow and local SMTP delivery',
  );
})()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => {
    server.close();
    smtp.close();
    if (engine) engine.kill('SIGTERM');
  });
