import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniverse-office-check-'));
const port = 4400 + crypto.randomInt(500);
const salt = crypto.randomBytes(16).toString('hex');
const password = 'check-only-password';
const passwordHash = salt + ':' + crypto.scryptSync(password, salt, 64).toString('hex');
const stateFile = path.join(tempDir, 'state.json');
const sessionsFile = path.join(tempDir, 'sessions.json');
fs.writeFileSync(stateFile, JSON.stringify({ agents: [] }), 'utf8');

const child = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    DATA_FILE: stateFile,
    SESSIONS_FILE: sessionsFile,
    ADMIN_EMAIL: 'check@example.invalid',
    ADMIN_PASSWORD_HASH: passwordHash,
    CEO_PANEL_TOKEN: 'check-ceo-token',
    HEARTBEAT_TOKEN: 'check-heartbeat-token',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let serverOutput = '';
child.stdout.on('data', (chunk) => { serverOutput += chunk; });
child.stderr.on('data', (chunk) => { serverOutput += chunk; });

async function waitUntilReady() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) return;
    } catch { /* el proceso todavia esta arrancando */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('El servidor de prueba no arranco:\n' + serverOutput);
}

function validateScripts(pathname, html) {
  const scripts = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g), (match) => match[1]);
  for (const [index, script] of scripts.entries()) {
    new vm.Script(script, { filename: `${pathname.replace(/\W+/g, '_')}-inline-${index + 1}.js` });
  }
  return scripts.length;
}

try {
  await waitUntilReady();
  const login = await fetch(`http://127.0.0.1:${port}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'check@example.invalid', password }),
  });
  if (login.status !== 302) throw new Error(`Login de prueba devolvio HTTP ${login.status}`);
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie) throw new Error('El login de prueba no entrego cookie');

  const heartbeat = await fetch(`http://127.0.0.1:${port}/api/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-heartbeat-token': 'check-heartbeat-token' },
    body: JSON.stringify({ agent: 'check_agent', name: '<img src=x onerror=alert(1)>', state: 'working', task: '<script>alert(1)</script>' }),
  });
  if (!heartbeat.ok) throw new Error(`/api/heartbeat devolvio HTTP ${heartbeat.status}`);

  const report = await fetch(`http://127.0.0.1:${port}/api/reportes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-heartbeat-token': 'check-heartbeat-token' },
    body: JSON.stringify({ fecha: '2026-08-19', html: '<script>document.body.textContent="no debe ejecutarse"</script>', resumen: 'prueba' }),
  });
  if (!report.ok) throw new Error(`/api/reportes devolvio HTTP ${report.status}`);
  const reportData = await report.json();
  const reportView = await fetch(`http://127.0.0.1:${port}/reportes/${reportData.reporte.id}.html`, { headers: { Cookie: cookie } });
  if (!reportView.ok || !(reportView.headers.get('content-security-policy') || '').includes('sandbox')) {
    throw new Error('El informe HTML no esta aislado con CSP sandbox');
  }

  let scriptCount = 0;
  for (const pathname of ['/office', '/ceo', '/operations', '/manual', '/inbox']) {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers: { Cookie: cookie } });
    if (!response.ok) throw new Error(`${pathname} devolvio HTTP ${response.status}`);
    const html = await response.text();
    if ((pathname === '/office' || pathname === '/ceo') && html.includes('<img src=x onerror=alert(1)>')) {
      throw new Error(`${pathname} no escapo el nombre malicioso del agente`);
    }
    scriptCount += validateScripts(pathname, html);
  }

  for (const pathname of ['/api/social-executions', '/api/work-executions']) {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers: { 'x-ceo-token': 'check-ceo-token' } });
    if (!response.ok) throw new Error(`${pathname} devolvio HTTP ${response.status}`);
    await response.json();
  }
  const inbox = await fetch(`http://127.0.0.1:${port}/api/inbox`, { headers: { Cookie: cookie } });
  if (!inbox.ok) throw new Error(`/api/inbox devolvio HTTP ${inbox.status}`);
  await inbox.json();

  const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  if (!persisted.agents.some((agent) => agent.agent === 'check_agent')) throw new Error('El heartbeat no quedo persistido');
  console.log(`OK: 5 paginas, ${scriptCount} scripts, 5 APIs, XSS, informe aislado y persistencia validados`);
} finally {
  child.kill();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
