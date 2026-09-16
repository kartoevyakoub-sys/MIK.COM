/**
 * API: загрузка файлов в Vercel Blob через свой домен.
 *
 * Прямая отправка в Supabase Storage из нашего региона рвётся на больших
 * объёмах (загрузка и скачивание ~>100 КБ), а свой Vercel-домен работает
 * стабильно. Поэтому файлы кладём в Blob здесь, а метаданные о материале
 * клиент записывает в Supabase как раньше (RLS и автор сохраняются).
 *
 *   POST /api/upload   multipart: kind=materials|exams, file=..., [preview=...]
 *                      Authorization: Bearer <supabase access_token>
 *                      -> 201 { kind, id, fileUrl, previewUrl, fileName, fileType, size }
 */

import { put } from '@vercel/blob';
import { parseForm, CORS_HEADERS, BLOB_STORE_ID, assertSupabaseUser } from './_shared.js';

export const config = { runtime: 'nodejs', api: { bodyParser: false } };

const KIND_OK = new Set(['materials', 'exams']);

export default async function handler(req, res) {
  for (const [key, value] of Object.entries(CORS_HEADERS)) res.setHeader(key, value);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Метод не поддерживается.' });

  try {
    await assertSupabaseUser(req);

    const { fields, files } = await parseForm(req);
    const kind = KIND_OK.has(fields.kind) ? fields.kind : 'materials';
    const file = files.find((f) => f.name === 'file') || files[0];
    const preview = files.find((f) => f.name === 'preview');

    if (!file || !file.buffer || !file.buffer.length) {
      return res.status(400).json({ error: 'Файл не выбран.' });
    }

    const id = crypto.randomUUID();
    const safeName = String(file.filename || 'file')
      .replace(/[^a-z0-9.\-_а-яёА-ЯЁ]+/gi, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80) || 'file';
    const pathBase = `${kind}/${id}`;

    const uploaded = await put(`${pathBase}/${safeName}`, file.buffer, {
      access: 'public',
      addRandomSuffix: true,
      contentType: file.mime || 'application/octet-stream',
      storeId: BLOB_STORE_ID,
    });

    let previewUrl = '';
    if (preview && preview.buffer && preview.buffer.length) {
      const thumb = await put(`${pathBase}/_preview.jpg`, preview.buffer, {
        access: 'public',
        addRandomSuffix: true,
        contentType: 'image/jpeg',
        storeId: BLOB_STORE_ID,
      });
      previewUrl = thumb.url;
    }

    return res.status(201).json({
      kind,
      id,
      fileUrl: uploaded.url,
      previewUrl,
      fileName: file.filename,
      fileType: file.mime || '',
      size: file.size,
    });
  } catch (error) {
    console.error('API upload error:', error);
    const status = typeof error.status === 'number' ? error.status : 500;
    return res.status(status).json({ error: error.message || 'Внутренняя ошибка сервера.' });
  }
}