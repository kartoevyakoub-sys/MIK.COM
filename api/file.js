/**
 * API: скачивание файлов из Vercel Blob через свой домен.
 *
 * Прямые ссылки на *.public.blob.vercel-storage.com в нашем регионе рвутся
 * на объёмах >~100 КБ (так же, как и supabase.co). Функция серверно
 * забирает файл из Blob и отдаёт клиенту через mik-com.vercel.app,
 * который в этом регионе работает стабильно.
 *
 *   GET /api/file?kind=materials&id=<uuid>            — основной файл
 *   GET /api/file?kind=materials&id=<uuid>&preview=1  — превью (если есть)
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
    const url = new URL(req.url, 'http://x');
    const kind = url.searchParams.get('kind') || '';
    const id = url.searchParams.get('id') || '';
    const preview = url.searchParams.get('preview') === '1';

    if (!/^(materials|exams)$/.test(kind) || !/^[0-9a-f-]{36}$/i.test(id)) {
      return res.status(400).json({ error: 'Некорректный идентификатор.' });
    }

    const blobs = await list({ prefix: `${kind}/${id}/`, storeId: BLOB_STORE_ID });
    // У превью имя содержит суффикс _preview — так отличаем файлы друг от друга.
    const target = blobs.find((b) => preview === b.pathname.includes('_preview'));
    if (!target) return res.status(404).json({ error: 'Файл не найден.' });

    const upstream = await fetch(target.url);
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