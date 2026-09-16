/**
 * API: универсальный прокси клиентских запросов к Supabase через свой домен.
 *
 * Прямые обращения браузера к supabase.co из нашего региона рвутся
 * (вход, списки и расписание «пропадали» при каждом обновлении, на втором
 * устройстве ничего не показывалось). Этот прокси пересылает запрос от
 * клиента на Supabase серверно, а ответ отдаёт через mik-com.vercel.app,
 * который в регионе работает стабильно.
 *
 *   GET|POST|PATCH|DELETE /api/db?path=<urlencoded путь к Supabase>
 *     body/headers клиента пробрасываются как есть; RLS Supabase остаётся
 *     в силе (прокси не добавляет service_role).
 *
 * Разрешены только пути внутри /auth/v1, /rest/v1, /storage/v1.
 */

import { CORS_HEADERS } from './_shared.js';

export const config = { runtime: 'nodejs', api: { bodyParser: false } };

const ALLOWED_PREFIX = /^\/(auth\/v1|rest\/v1|storage\/v1)(\/|$|\?)/;

// Проксируем только «свои» заголовки клиента — не тащим лишнее.
const PASS_HEADERS = ['apikey', 'authorization', 'content-type', 'prefer', 'accept', 'x-client-info', 'if-match'];

function pickHeaders(header) {
  const out = {};
  for (const name of PASS_HEADERS) {
    const value = header[name];
    if (typeof value === 'string' && value) out[name] = value;
  }
  return out;
}

export default async function handler(req, res) {
  for (const [key, value] of Object.entries(CORS_HEADERS)) res.setHeader(key, value);
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const parsed = new URL(req.url, 'http://x');
    const path = parsed.searchParams.get('path') || '';
    if (!path || !ALLOWED_PREFIX.test(path)) {
      return res.status(400).json({ error: 'Недопустимый путь.' });
    }
    const urlBase = process.env.SUPABASE_URL;
    if (!urlBase) {
      return res.status(500).json({ error: 'SUPABASE_URL не задан на сервере.' });
    }

    // Читаем тело запроса клиента как есть (JSON, форма, бинарные данные).
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    const target = urlBase + path;
    const upstream = await fetch(target, {
      method: req.method,
      headers: pickHeaders(req.headers),
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
    });

    const data = Buffer.from(await upstream.arrayBuffer());
    res.statusCode = upstream.status;
    const contentType = upstream.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', data.length);
    res.end(data);
  } catch (error) {
    console.error('API db proxy error:', error);
    if (!res.headersSent) {
      return res.status(502).json({ error: 'Не удалось соединиться с базой.' });
    }
    res.end();
  }
}