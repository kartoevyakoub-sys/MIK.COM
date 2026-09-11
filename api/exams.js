/**
 * API: сессии и экзамены.
 *
 *   GET    /api/exams                 список всех материалов для подготовки
 *   POST   /api/exams                 создать (multipart: title, description, file)
 *   DELETE /api/exams?id=<id>         удалить материал вместе с файлом
 */

import { put } from '@vercel/blob';
import { getAll, deleteMaterial, metaPath, guessKind, CORS_HEADERS } from './_shared.js';

export const config = { runtime: 'nodejs' };

const KIND = 'exams';

export default async function handler(req, res) {
  for (const [key, value] of Object.entries(CORS_HEADERS)) res.setHeader(key, value);

  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (req.method === 'GET') {
      return res.status(200).json(await getAll(KIND));
    }

    if (req.method === 'POST') {
      const form = await req.formData();
      const title = String(form.get('title') || '').trim();
      const description = String(form.get('description') || '').trim();
      const file = form.get('file');

      if (!title) return res.status(400).json({ error: 'Обязательно укажите название материала.' });
      if (!file) return res.status(400).json({ error: 'Выберите файл.' });

      const id = crypto.randomUUID();
      const createdAt = Date.now();
      const fileName = file.name;
      const mime = file.type || 'application/octet-stream';
      const size = file.size;
      const kind = guessKind(fileName, mime);

      const uploaded = await put(`${KIND}/${id}/${file.name}`, file.stream(), {
        access: 'public',
        addRandomSuffix: true,
        contentType: mime,
      });

      const meta = {
        id,
        title,
        description,
        fileName,
        mime,
        size,
        kind,
        url: '',
        fileUrl: uploaded.url,
        createdAt,
        newForEveryone: true,
      };

      await put(metaPath(KIND, id), JSON.stringify(meta), {
        access: 'public',
        contentType: 'application/json',
        cacheControlMaxAge: 0,
      });

      return res.status(201).json(meta);
    }

    if (req.method === 'DELETE') {
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