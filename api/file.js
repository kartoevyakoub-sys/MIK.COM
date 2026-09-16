/**
 * API: скачивание файлов из Vercel Blob через свой домен.
 *
 * Прямые ссылки на *.public.blob.vercel-storage.com в нашем регионе рвутся
 * на объёмах >~100 КБ (так же, как и supabase.co). Функция серверно
 * забирает файл из Blob и по-байтово отдаёт клиенту через mik-com.vercel.app,
 * который в этом регионе работает стабильно.
 *
 *   GET /api/file/materials/<uuid>            — основной файл
 *   GET /api/file/materials/<uuid>?preview=1  — превью (если есть)
 *
 * Доступ публичный: сам блоб уже публичный (access: 'public'), URL
 * файлов содержит случайный UUID — как и у обычных blob-ссылок.
 */

import { list } from '@vercel/blob';
import { CORS_HEADERS, BLOB_STORE_ID } from './_shared.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  for (const [key, value] of Object.entries(CORS_HEADERS)) res.setHeader(key, value);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Метод не поддерживается.' });

  try {
    // Ожидаемый путь: /api/file/<kind>/<id>?preview=1
    const parts = new URL(req.url, 'http://x').pathname.split('/').filter(Boolean);
    if (parts.length < 3 || parts[0] !== 'api' || parts[1] !== 'file') {
      return res.status(400).json({ error: 'Некорректный путь.' });
    }
    const [kind, id] = [parts[2], parts[3]];
    if (!/^(materials|exams)$/.test(kind) || !/^[0-9a-f-]{36}$/i.test(id)) {
      return res.status(400).json({ error: 'Некорректный идентификатор.' });
    }

    const preview = new URL(req.url, 'http://x').searchParams.get('preview') === '1';
    const blobs = await list({ prefix: `${kind}/${id}/`, storeId: BLOB_STORE_ID });
    const names = blobs.map((b) => b.pathname);
    // Препятствие двойному совпадению: у превью имя имеет суффикс _preview.
    const target = names.find((name) => preview === name.includes('_preview'));
    if (!target) return res.status(404).json({ error: 'Файл не найден.' });

    const blob = blobs.find((b) => b.pathname === target);
    const upstream = await fetch(blob.url);
    if (!upstream.ok || !upstream.body) {
      return res.status(502).json({ error: 'Не удалось получить файл из хранилища.' });
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Length', buffer.length);
    res.end(buffer);
  } catch (error) {
    console.error('API file error:', error);
    if (!res.headersSent) {
      const status = typeof error.status === 'number' ? error.status : 500;
      return res.status(status).json({ error: error.message || 'Внутренняя ошибка сервера.' });
    }
    res.end();
  }
}