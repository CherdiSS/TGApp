import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from './config.js';
import { AppError, addTracking, listItems, manualRefresh, removeTracking, setTarget, upsertUser } from './monitor.js';
import { validateInitData } from './telegram.js';

const WEB_ROOT = fileURLToPath(new URL('../web/', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};
const CSP =
  "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src https: data:; connect-src 'self'; base-uri 'none'; form-action 'none'";
const MAX_BODY = 10 * 1024;
const MAX_TARGET = 100_000_000;

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new AppError(413, 'too_large', 'Слишком большой запрос');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch {
    /* fallthrough */
  }
  throw new AppError(400, 'bad_json', 'Некорректный запрос');
}

function authenticate(req) {
  const header = req.headers.authorization ?? '';
  if (header.startsWith('tma ')) {
    const user = validateInitData(header.slice(4), config.botToken);
    if (user) return user;
  }
  if (config.devUserId) return { id: config.devUserId, first_name: 'Dev' };
  throw new AppError(401, 'unauthorized', 'Откройте приложение через Telegram');
}

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = normalize(join(WEB_ROOT, rel));
  if (!file.startsWith(WEB_ROOT) || file.includes(`${sep}.`)) return false;
  const type = MIME[extname(file)];
  if (!type) return false;
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

function parseTarget(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_TARGET) {
    throw new AppError(400, 'bad_target', 'Желаемая цена должна быть целым числом рублей');
  }
  return n;
}

async function handleApi(ctx, req, res, pathname) {
  const { db } = ctx;
  const user = authenticate(req);
  upsertUser(db, user);

  const itemMatch = pathname.match(/^\/api\/items\/(\d{5,15})(\/refresh)?$/);

  if (pathname === '/api/items' && req.method === 'GET') {
    return sendJson(res, 200, {
      items: listItems(db, user.id),
      maxItems: config.maxItemsPerUser,
      checkIntervalMin: config.checkIntervalMin,
    });
  }
  if (pathname === '/api/items' && req.method === 'POST') {
    const body = await readJson(req);
    if (typeof body.url !== 'string' || body.url.length > 2048) {
      throw new AppError(400, 'bad_link', 'Пришлите ссылку на товар Ozon или артикул');
    }
    return sendJson(res, 201, await addTracking(ctx, user.id, body.url));
  }
  if (itemMatch) {
    const [, sku, refresh] = itemMatch;
    if (refresh && req.method === 'POST') return sendJson(res, 200, await manualRefresh(ctx, user.id, sku));
    if (!refresh && req.method === 'PATCH') {
      const body = await readJson(req);
      return sendJson(res, 200, { item: setTarget(db, user.id, sku, parseTarget(body.targetPrice)) });
    }
    if (!refresh && req.method === 'DELETE') {
      removeTracking(db, user.id, sku);
      return sendJson(res, 200, { ok: true });
    }
  }
  throw new AppError(404, 'not_found', 'Нет такого метода');
}

export function createApp(ctx) {
  return createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      if (pathname === '/healthz') return sendJson(res, 200, { ok: true });
      if (pathname.startsWith('/api/')) return await handleApi(ctx, req, res, pathname);
      if ((req.method === 'GET' || req.method === 'HEAD') && (await serveStatic(res, pathname))) return;
      sendJson(res, 404, { error: { code: 'not_found', message: 'Not found' } });
    } catch (err) {
      if (err instanceof AppError) {
        return sendJson(res, err.status, { error: { code: err.code, message: err.message } });
      }
      console.error('[http]', err);
      if (!res.headersSent) sendJson(res, 500, { error: { code: 'internal', message: 'Внутренняя ошибка' } });
      else res.end();
    }
  });
}
