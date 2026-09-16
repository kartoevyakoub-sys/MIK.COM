/**
 * API: сессии и экзамены.
 *
 *   GET    /api/exams                 список всех материалов для подготовки
 *   POST   /api/exams                 создать (multipart: title, description,
 *                                    и file ИЛИ url; для картинки можно preview)
 *   DELETE /api/exams?id=<id>         удалить материал вместе с файлом
 *
 * Файлы хранятся в Vercel Blob, метаданные — рядом в json-блобах.
 */

import { put } from '@vercel/blob';
import { getAll, deleteMaterial, metaPath, guessKind, parseForm, CORS_HEADERS, BLOB_STORE_ID, assertSupabaseUser } from './_shared.js';

export const config = { runtime: 'nodejs', api: { bodyParser: false } };

const KIND = 'exams';

export default async function handler(req, res) {
  for (const [key, value] of Object.entries(CORS_HEADERS)) res.setHeader(key, value);

  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (req.method === 'GET') {
      return res.status(200).json(await getAll(KIND));
    }

    if (req.method === 'POST') {
      await assertSupabaseUser(req);
      const { fields, files } = await parseForm(req);
      const title = String(fields.title || '').trim();
      const description = String(fields.description || '').trim();
      const url = String(fields.url || '').trim();
      const file = files.find((f) => f.name === 'file') || files[0];
      const preview = files.find((f) => f.name === 'preview');

      if (!title) return res.status(400).json({ error: 'Обязательно укажите название материала.' });
      if (!file && !url) return res.status(400).json({ error: 'Выберите файл или вставьте ссылку.' });

      const id = crypto.randomUUID();
      const createdAt = Date.now();
      let fileName = '';
      let mime = '';
      let size = 0;
      let fileUrl = '';
      let previewUrl = '';
      let kind = 'link';
      let linkUrl = '';

      if (file) {
        fileName = file.filename;
        mime = file.mime || 'application/octet-stream';
        size = file.size;
        kind = guessKind(fileName, mime);
        const uploaded = await put(`${KIND}/${id}/${file.filename}`, file.buffer, {
          access: 'public',
          addRandomSuffix: true,
          contentType: mime,
          storeId: BLOB_STORE_ID,
        });
        fileUrl = uploaded.url;
        if (preview && preview.buffer.length) {
          const thumb = await put(`${KIND}/${id}/_preview`, preview.buffer, {
            access: 'public',
            addRandomSuffix: true,
            contentType: 'image/jpeg',
            storeId: BLOB_STORE_ID,
          });
          previewUrl = thumb.url;
        }
      } else if (url) {
        kind = 'link';
        fileName = 'Ссылка';
        linkUrl = url;
      }

      const meta = {
        id,
        title,
        description,
        fileName,
        mime,
        size,
        kind,
        url: linkUrl,
        fileUrl,
        previewUrl,
        createdAt,
        newForEveryone: true,
      };

      await put(metaPath(KIND, id), JSON.stringify(meta), {
        access: 'public',
        contentType: 'application/json',
        cacheControlMaxAge: 0,
        storeId: BLOB_STORE_ID,
      });

      return res.status(201).json(meta);
    }

    if (req.method === 'DELETE') {
      await assertSupabaseUser(req);
      const id = String(req.query.id || '');
      if (!id) return res.status(400).json({ error: 'Не указан id материала.' });
      await deleteMaterial(KIND, id);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Метод не поддерживается.' });
  } catch (error) {
    console.error('API exams error:', error);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера.' });
  }
}