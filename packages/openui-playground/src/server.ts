/**
 * OpenUI playground server.
 *
 *   OPENROUTER_API_KEY=sk-... pnpm --filter @openrouter/openui-playground dev
 *
 * Routes:
 * - GET  /               → the playground UI (public/)
 * - GET  /api/library    → the demo library (names, prompt, dialect)
 * - POST /api/generate   → run one generation, streamed as SSE
 *     body: { prompt, model?, mode?: 'emulate' | 'native', system? }
 *
 * Plain node:http — no framework, nothing to build; the client is static.
 */
import { readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenRouter } from '@openrouter/agent';
import { demoLibrary } from './demo-library.js';
import type { GenerateRequest, PlaygroundEvent } from './generate.js';
import { generate } from './generate.js';
import { libraryPrompt } from './lang/prompt.js';

const PORT = Number(process.env['PORT'] ?? 5170);
const DEFAULT_MODEL = process.env['OPENUI_PLAYGROUND_MODEL'] ?? 'anthropic/claude-sonnet-5';
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const apiKey = process.env['OPENROUTER_API_KEY'];
if (!apiKey) {
  console.error('OPENROUTER_API_KEY is required');
  process.exit(1);
}
const client = new OpenRouter({
  apiKey,
});

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sseFrame(event: PlaygroundEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

async function readBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text.length > 0 ? JSON.parse(text) : {};
}

function parseGenerateRequest(body: unknown): GenerateRequest | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (typeof record['prompt'] !== 'string' || record['prompt'].length === 0) {
    return null;
  }
  const mode = record['mode'];
  if (mode !== undefined && mode !== 'emulate' && mode !== 'native') {
    return null;
  }
  const request: GenerateRequest = {
    prompt: record['prompt'],
    model: typeof record['model'] === 'string' && record['model'] ? record['model'] : DEFAULT_MODEL,
  };
  if (mode !== undefined) {
    request.mode = mode;
  }
  if (typeof record['system'] === 'string' && record['system']) {
    request.system = record['system'];
  }
  return request;
}

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const file = normalize(join(PUBLIC_DIR, rel));
  // Trailing separator so `public.bak`/`public-anything` siblings can't
  // satisfy a bare prefix check.
  if (!file.startsWith(PUBLIC_DIR + sep)) {
    sendJson(res, 404, {
      error: 'not found',
    });
    return;
  }
  try {
    const content = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    });
    res.end(content);
  } catch {
    sendJson(res, 404, {
      error: 'not found',
    });
  }
}

async function handleRequest(
  req: import('node:http').IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/api/library') {
    sendJson(res, 200, {
      dialect: demoLibrary.dialect,
      components: demoLibrary.componentNames,
      prompt: libraryPrompt(demoLibrary),
      defaultModel: DEFAULT_MODEL,
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/generate') {
    let request: GenerateRequest | null = null;
    try {
      request = parseGenerateRequest(await readBody(req));
    } catch {
      request = null;
    }
    if (!request) {
      sendJson(res, 400, {
        error: 'body must be { prompt, model?, mode?, system? }',
      });
      return;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    try {
      for await (const event of generate(client, demoLibrary, request)) {
        res.write(sseFrame(event));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.write(
        sseFrame({
          type: 'error',
          message,
        }),
      );
    }
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  if (req.method === 'GET') {
    await serveStatic(res, url.pathname);
    return;
  }

  sendJson(res, 405, {
    error: 'method not allowed',
  });
}

const server = createServer((req, res) => {
  handleRequest(req, res).catch((error: unknown) => {
    console.error(error);
    if (!res.headersSent) {
      sendJson(res, 500, {
        error: 'internal error',
      });
    } else {
      res.end();
    }
  });
});

// Local-only tool backed by the developer's API key — never expose it to the
// LAN by listening on all interfaces.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`OpenUI playground → http://localhost:${PORT} (default model: ${DEFAULT_MODEL})`);
});
