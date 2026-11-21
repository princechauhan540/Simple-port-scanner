import http from 'node:http';
import net from 'node:net';
import { lookup } from 'node:dns/promises';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const publicDirectory = fileURLToPath(new URL('./', import.meta.url));
const maximumPorts = 256;
const concurrency = 24;
const services = {
  21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP', 53: 'DNS', 80: 'HTTP',
  110: 'POP3', 143: 'IMAP', 443: 'HTTPS', 445: 'SMB', 465: 'SMTPS',
  587: 'SMTP submission', 993: 'IMAPS', 995: 'POP3S', 1433: 'SQL Server',
  3000: 'Development server', 3306: 'MySQL', 3389: 'RDP', 5432: 'PostgreSQL',
  5900: 'VNC', 6379: 'Redis', 8000: 'HTTP alternate', 8080: 'HTTP alternate',
  8443: 'HTTPS alternate', 27017: 'MongoDB',
};
const staticFiles = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
};

export function parsePorts(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 4096) {
    throw new Error('Enter ports such as 22,80,443 or a range such as 8000-8010.');
  }
  const ports = new Set();
  for (const item of input.split(',')) {
    const match = item.trim().match(/^(\d{1,5})(?:\s*-\s*(\d{1,5}))?$/);
    if (!match) throw new Error('Use comma-separated port numbers or ranges.');
    const first = Number(match[1]);
    const last = Number(match[2] ?? match[1]);
    if (first < 1 || last > 65535 || first > last) {
      throw new Error('Ports must be between 1 and 65535, with ranges in ascending order.');
    }
    if (last - first + 1 > maximumPorts) {
      throw new Error(`Scan up to ${maximumPorts} ports at a time.`);
    }
    for (let port = first; port <= last; port += 1) ports.add(port);
    if (ports.size > maximumPorts) throw new Error(`Scan up to ${maximumPorts} ports at a time.`);
  }
  return [...ports].sort((a, b) => a - b);
}

function parseHost(value) {
  if (typeof value !== 'string') throw new Error('Enter a hostname or IP address.');
  const host = value.trim().replace(/^\[([\da-f:]+)\]$/i, '$1');
  if (net.isIP(host)) return host;
  const labels = host.split('.');
  const valid = host.length > 0 && host.length <= 253 && labels.every(label =>
    /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label));
  if (!valid) throw new Error('Enter one hostname or IP address, without a URL or port.');
  return host;
}

export function probePort(address, port, timeoutMs, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve(null);
    const startedAt = performance.now();
    const socket = new net.Socket();
    let settled = false;
    function finish(status, detail) {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', cancel);
      socket.destroy();
      resolve(status ? {
        type: 'result', port, service: services[port] || 'Unassigned', status,
        durationMs: Math.round((performance.now() - startedAt) * 10) / 10, detail,
      } : null);
    }
    function cancel() { finish(null); }
    signal?.addEventListener('abort', cancel, { once: true });
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish('open', 'TCP connection established'));
    socket.once('timeout', () => finish('timeout', 'No response within the timeout'));
    socket.once('error', error => {
      if (error.code === 'ECONNREFUSED') return finish('closed', 'Connection refused');
      if (error.code === 'ETIMEDOUT') return finish('timeout', 'Connection timed out');
      finish('error', error.code || 'Connection failed');
    });
    try { socket.connect({ host: address, port }); }
    catch (error) { finish('error', error.code || 'Connection failed'); }
  });
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function readRequest(request) {
  let body = '';
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8192) throw new Error('The request is too large.');
    body += chunk.toString();
  }
  try { return JSON.parse(body); }
  catch { throw new Error('Send a valid JSON scan request.'); }
}

function isLocalRequest(request) {
  try {
    const destination = new URL(`http://${request.headers.host}`);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(destination.hostname)) return false;
    if (!request.headers.origin) return true;
    const origin = new URL(request.headers.origin);
    return origin.protocol === 'http:' && origin.host === destination.host;
  } catch { return false; }
}

export function createScannerServer() {
  let activeScan = false;
  return http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (!isLocalRequest(request)) return sendJson(response, 403, { error: 'Open this app through its localhost address.' });

    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (request.method === 'GET' && pathname === '/api/health') {
      return sendJson(response, 200, { ok: true });
    }
    if (request.method === 'GET' && staticFiles[pathname]) {
      const [filename, contentType] = staticFiles[pathname];
      try {
        const contents = await readFile(path.join(publicDirectory, filename));
        response.writeHead(200, { 'Content-Type': contentType });
        return response.end(contents);
      } catch { return sendJson(response, 500, { error: 'An application file could not be loaded.' }); }
    }
    if (request.method !== 'POST' || pathname !== '/api/scan') {
      return sendJson(response, 404, { error: 'Page not found.' });
    }
    if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
      return sendJson(response, 415, { error: 'Use application/json for scan requests.' });
    }
    if (activeScan) return sendJson(response, 429, { error: 'A scan is already running. Stop it or wait for it to finish.' });
    activeScan = true;
    const controller = new AbortController();
    response.once('close', () => controller.abort());
    try {
      const settings = await readRequest(request);
      const host = parseHost(settings?.host);
      const ports = parsePorts(settings?.ports);
      const timeoutMs = settings?.timeoutMs ?? 1000;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 5000) {
        throw new Error('Choose a timeout between 500 and 5000 milliseconds.');
      }
      let address;
      try { ({ address } = await lookup(host)); }
      catch { throw new Error('The hostname could not be resolved. Check the target and try again.'); }
      if (controller.signal.aborted) return;
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
      const emit = event => {
        if (!response.destroyed) response.write(`${JSON.stringify(event)}\n`);
      };
      emit({ type: 'start', host, total: ports.length });
      const startedAt = performance.now();
      let nextPort = 0;
      let completed = 0;
      async function worker() {
        while (nextPort < ports.length && !controller.signal.aborted) {
          const port = ports[nextPort++];
          const result = await probePort(address, port, timeoutMs, controller.signal);
          if (result) {
            completed += 1;
            emit(result);
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, ports.length) }, worker));
      if (!controller.signal.aborted) {
        emit({ type: 'done', total: ports.length, completed, elapsedMs: Math.round(performance.now() - startedAt) });
        response.end();
      }
    } catch (error) {
      if (!response.destroyed && !response.headersSent) {
        sendJson(response, 400, { error: error.message || 'The scan could not be completed.' });
      }
    } finally {
      controller.abort();
      activeScan = false;
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('PORT must be an integer between 1 and 65535.');
    process.exit(1);
  }
  const server = createScannerServer();
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${port} is in use. Set PORT to another port and try again.` : error.message);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => console.log(`Port Scanner is ready at http://127.0.0.1:${port}`));
}
