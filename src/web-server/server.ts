import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as url from 'url';
import { handleSprintApi } from './api/sprint';
import { handleSessionsApi, handleSessionApi } from './api/sessions';
import { handleAuditApi } from './api/audit';
import { handleStreamApi, broadcastEvent } from './api/stream';

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const WEB_DIST = path.join(__dirname, '../../dist/web');

function cors(res: http.ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
}

function jsonResponse(res: http.ServerResponse, data: unknown, status = 200): void {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function requestHandler(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const parsed = url.parse(req.url ?? '/', true);
  const pathname = parsed.pathname ?? '/';
  const method = req.method ?? 'GET';

  if (method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }

  // API routes
  if (pathname.startsWith('/api/')) {
    cors(res);
    try {
      const body = method === 'POST' ? await readBody(req) : '';
      const bodyJson = body ? JSON.parse(body) : {};

      // GET /api/sprint
      if (pathname === '/api/sprint' && method === 'GET') {
        const result = await handleSprintApi(parsed.query as Record<string, string>);
        return jsonResponse(res, result);
      }

      // GET/POST /api/sessions
      if (pathname === '/api/sessions') {
        const result = await handleSessionsApi(method, bodyJson);
        return jsonResponse(res, result);
      }

      // GET /api/sessions/:id
      const sessionMatch = pathname.match(/^\/api\/sessions\/(\d+)$/);
      if (sessionMatch && method === 'GET') {
        const result = await handleSessionApi(parseInt(sessionMatch[1]));
        return jsonResponse(res, result ?? {}, result ? 200 : 404);
      }

      // GET /api/sessions/:id/audit
      const auditMatch = pathname.match(/^\/api\/sessions\/(\d+)\/audit$/);
      if (auditMatch && method === 'GET') {
        const result = await handleAuditApi(parseInt(auditMatch[1]), parsed.query as Record<string, string>);
        return jsonResponse(res, result);
      }

      // GET /api/sessions/:id/stream  (SSE)
      const streamMatch = pathname.match(/^\/api\/sessions\/(\d+)\/stream$/);
      if (streamMatch && method === 'GET') {
        return handleStreamApi(req, res, parseInt(streamMatch[1]));
      }

      jsonResponse(res, { error: 'Not found' }, 404);
    } catch (err: any) {
      jsonResponse(res, { error: err.message }, 500);
    }
    return;
  }

  // Serve static web files from dist/web
  if (fs.existsSync(WEB_DIST)) {
    let filePath = path.join(WEB_DIST, pathname === '/' ? 'index.html' : pathname);
    if (!fs.existsSync(filePath)) filePath = path.join(WEB_DIST, 'index.html'); // SPA fallback
    const ext = path.extname(filePath);
    const mime = MIME[ext] ?? 'text/plain';
    cors(res);
    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(filePath).pipe(res);
  } else {
    // Web not built yet — show placeholder
    cors(res);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px">
<h1>myworkbuddy</h1>
<p>Web UI not built yet. Run: <code>npm run build:web</code></p>
<p>API is available at <a href="/api/sessions">/api/sessions</a></p>
</body></html>`);
  }
}

export async function startWebServer(port: number, autoOpen: boolean): Promise<void> {
  const server = http.createServer((req, res) => {
    requestHandler(req, res).catch((err) => {
      res.writeHead(500); res.end(String(err));
    });
  });

  await new Promise<void>((resolve) => server.listen(port, resolve));

  if (autoOpen) {
    const { exec } = await import('child_process');
    const openCmd = process.platform === 'win32' ? `start http://localhost:${port}`
      : process.platform === 'darwin' ? `open http://localhost:${port}`
      : `xdg-open http://localhost:${port}`;
    exec(openCmd);
  }

  process.on('SIGINT', () => { server.close(); process.exit(0); });
}

export { broadcastEvent };
