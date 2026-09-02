import { randomBytes } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const proxyPort = Number.parseInt(process.env.INDY_E2E_PROXY_PORT ?? '17691', 10);
const backendPort = Number.parseInt(process.env.INDY_E2E_BACKEND_PORT ?? '17692', 10);
const publicOrigin = 'https://indy.e2e.test';
const publicHost = new URL(publicOrigin).host;
const sessionRoot = mkdtempSync(join(tmpdir(), 'indy-e2e-'));
const minionsHome = join(sessionRoot, 'indy');
const hermesHome = join(sessionRoot, 'hermes');
const workspace = join(minionsHome, 'workspace');
const runtimeFile = join(sessionRoot, 'runtime.json');
const workerStateFile = join(sessionRoot, 'worker-state.json');
const secretFile = join(sessionRoot, 'proxy-secret');
const secret = randomBytes(32).toString('base64url');
let backend = null;
let stopping = false;

function resetFiles() {
  rmSync(minionsHome, { recursive: true, force: true });
  rmSync(hermesHome, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
  mkdirSync(hermesHome, { recursive: true });
  writeFileSync(runtimeFile, JSON.stringify({ authState: 'connected' }), { mode: 0o600 });
  writeFileSync(workerStateFile, JSON.stringify({ chats: [], messages: {} }), { mode: 0o600 });
  writeFileSync(secretFile, `${secret}\n`, { mode: 0o600 });
}

function pythonCommand() {
  return process.env.INDY_E2E_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
}

function startBackend() {
  if (!existsSync(join(root, 'dist', 'server', 'server', 'index.js'))) {
    throw new Error('E2E backend build is missing; run pnpm build first');
  }
  backend = spawn(process.execPath, ['dist/server/server/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(backendPort),
      MINIONS_HOME: minionsHome,
      DB_PATH: join(minionsHome, 'data', 'indy.db'),
      HERMES_HOME: hermesHome,
      HERMES_PYTHON: pythonCommand(),
      HERMES_WORKER_SCRIPT: join(root, 'e2e', 'fake-hermes-worker.py'),
      INDY_E2E_WORKER_STATE: workerStateFile,
      INDY_E2E_RUNTIME_FILE: runtimeFile,
      INDY_E2E_WORKSPACE: workspace,
      INDY_PUBLIC_ORIGIN: publicOrigin,
      INDY_PROXY_SECRET_FILE: secretFile,
      INDY_TRUSTED_PROXY_CIDRS: '127.0.0.0/8,::1/128',
      INDY_SCHEDULED_WORKDIRS: workspace,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  backend.stdout.on('data', (chunk) => process.stdout.write(`[e2e-backend] ${chunk}`));
  backend.stderr.on('data', (chunk) => process.stderr.write(`[e2e-backend] ${chunk}`));
  backend.once('exit', (code, signal) => {
    if (!stopping && code !== 0) process.stderr.write(`[e2e-backend] exited ${signal ?? code}\n`);
  });
}

function internalHeaders() {
  return {
    Host: publicHost,
    'X-Indy-User': 'etienne',
    'X-Indy-Proxy-Secret': secret,
  };
}

function backendStatus(path) {
  return new Promise((resolveStatus, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port: backendPort, path, headers: internalHeaders() }, (response) => {
      response.resume();
      response.once('end', () => resolveStatus(response.statusCode ?? 0));
    });
    request.once('error', reject);
    request.end();
  });
}

async function waitUntilReady() {
  const deadline = Date.now() + 20_000;
  let lastError = null;
  while (Date.now() < deadline) {
    if (backend?.exitCode !== null) throw new Error(`backend exited before readiness (${backend?.exitCode})`);
    try {
      if (await backendStatus('/api/health/ready') === 200) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`backend did not become ready${lastError ? `: ${lastError.message}` : ''}`);
}

async function stopBackend() {
  const child = backend;
  backend = null;
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
  child.kill('SIGTERM');
  await Promise.race([
    exited,
    new Promise((resolveWait) => setTimeout(resolveWait, 5_000)).then(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }),
  ]);
}

async function restartBackend({ preserve }) {
  await stopBackend();
  if (!preserve) resetFiles();
  startBackend();
  await waitUntilReady();
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const value = Buffer.concat(chunks).toString('utf8');
  return value ? JSON.parse(value) : {};
}

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function handleControl(request, response) {
  if (request.method === 'POST' && request.url === '/__e2e/reset') {
    await restartBackend({ preserve: false });
    json(response, 200, { ok: true });
    return true;
  }
  if (request.method === 'POST' && request.url === '/__e2e/restart') {
    await restartBackend({ preserve: true });
    json(response, 200, { ok: true });
    return true;
  }
  if (request.method === 'POST' && request.url === '/__e2e/runtime') {
    writeFileSync(runtimeFile, JSON.stringify(await readBody(request)), { mode: 0o600 });
    json(response, 200, { ok: true });
    return true;
  }
  if (request.method === 'GET' && request.url === '/__e2e/state') {
    json(response, 200, {
      ...JSON.parse(readFileSync(workerStateFile, 'utf8')),
      configuredWorkspace: workspace,
    });
    return true;
  }
  return false;
}

function proxyRequest(clientRequest, clientResponse) {
  const headers = {};
  for (const [name, value] of Object.entries(clientRequest.headers)) {
    if (!name.toLowerCase().startsWith('x-indy-') && name.toLowerCase() !== 'host') headers[name] = value;
  }
  headers.host = publicHost;
  headers['x-indy-user'] = 'etienne';
  headers['x-indy-proxy-secret'] = secret;
  const localOrigin = `http://127.0.0.1:${proxyPort}`;
  if (headers.origin === localOrigin) headers.origin = publicOrigin;

  const upstream = httpRequest({
    host: '127.0.0.1', port: backendPort, method: clientRequest.method,
    path: clientRequest.url, headers,
  }, (upstreamResponse) => {
    clientResponse.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(clientResponse);
  });
  upstream.once('error', () => {
    if (!clientResponse.headersSent) json(clientResponse, 502, { error: 'Backend unavailable' });
    else clientResponse.destroy();
  });
  clientRequest.pipe(upstream);
}

resetFiles();
startBackend();
await waitUntilReady();

const proxy = createServer((request, response) => {
  void handleControl(request, response)
    .then((handled) => { if (!handled) proxyRequest(request, response); })
    .catch(() => json(response, 500, { error: 'E2E control failed' }));
});
await new Promise((resolveListen, reject) => {
  proxy.once('error', reject);
  proxy.listen(proxyPort, '127.0.0.1', resolveListen);
});
process.stdout.write(`E2E trusted proxy listening on http://127.0.0.1:${proxyPort}\n`);

async function shutdown() {
  if (stopping) return;
  stopping = true;
  await new Promise((resolveClose) => proxy.close(resolveClose));
  await stopBackend();
  rmSync(sessionRoot, { recursive: true, force: true });
}

process.on('SIGINT', () => void shutdown().then(() => process.exit(0)));
process.on('SIGTERM', () => void shutdown().then(() => process.exit(0)));
