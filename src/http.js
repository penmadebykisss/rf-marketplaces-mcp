// Общий HTTP-клиент: таймауты, повтор при сетевых сбоях, распаковка gzip, понятные ошибки.
//
// Используем node:https, а не встроенный fetch: витрина Wildberries отклоняет (403) TLS-отпечаток
// встроенного клиента Node, но принимает стандартный набор шифров OpenSSL — его и задаём.

import https from 'node:https';
import zlib from 'node:zlib';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const CIPHERS = [
  'TLS_AES_256_GCM_SHA384', 'TLS_CHACHA20_POLY1305_SHA256', 'TLS_AES_128_GCM_SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384', 'ECDHE-RSA-AES256-GCM-SHA384', 'ECDHE-ECDSA-AES128-GCM-SHA256', 'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-CHACHA20-POLY1305', 'ECDHE-RSA-CHACHA20-POLY1305', 'ECDHE-ECDSA-AES256-SHA384', 'ECDHE-RSA-AES256-SHA384',
  'ECDHE-ECDSA-AES128-SHA256', 'ECDHE-RSA-AES128-SHA256', 'DHE-RSA-AES256-GCM-SHA384', 'DHE-RSA-AES128-GCM-SHA256',
  'DHE-RSA-AES256-SHA256', 'DHE-RSA-AES128-SHA256',
].join(':');
const agent = new https.Agent({ keepAlive: true, maxSockets: 16, ciphers: CIPHERS });

export class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} для ${new URL(url).host}${body ? ': ' + body.slice(0, 300) : ''}`);
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

function decode(buf, encoding) {
  if (encoding === 'gzip' || (buf[0] === 0x1f && buf[1] === 0x8b)) return zlib.gunzipSync(buf);
  if (encoding === 'deflate') return zlib.inflateSync(buf);
  if (encoding === 'br') return zlib.brotliDecompressSync(buf);
  return buf;
}

function once(url, { method, headers, body, timeout }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = https.request(url, {
      method, agent,
      headers: {
        'User-Agent': UA, Accept: 'application/json, */*', 'Accept-Encoding': 'gzip, deflate',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers,
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let text;
        try { text = decode(Buffer.concat(chunks), res.headers['content-encoding']).toString('utf8'); }
        catch (e) { return reject(e); }
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new HttpError(res.statusCode, url, text));
        try { resolve(text ? JSON.parse(text) : null); } catch { reject(new Error(`Некорректный JSON от ${new URL(url).host}`)); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error(`Таймаут ${timeout / 1000} с: ${new URL(url).host}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

export async function request(url, { method = 'GET', headers = {}, body, timeout = 15000, retries = 1 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await once(url, { method, headers, body, timeout });
    } catch (e) {
      lastErr = e;
      // повторяем только сетевые сбои и 5xx/429
      const retriable = !(e instanceof HttpError) || e.status >= 500 || e.status === 429;
      if (!retriable || attempt === retries) break;
      await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/** Быстрая проверка существования ресурса (для поиска нужного CDN-сервера). */
export function exists(url, headers = {}, timeout = 8000) {
  return new Promise(resolve => {
    const req = https.request(url, { method: 'GET', agent, headers: { 'User-Agent': UA, Accept: '*/*', ...headers } }, res => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 300);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(timeout, () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// Кэш с временем жизни — чтобы не упираться в лимиты API при повторных вопросах агента.
const cache = new Map();
export async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  const value = await fn();
  cache.set(key, { value, until: Date.now() + ttlMs });
  return value;
}
