/**
 * API: сессии и экзамены.
 *
 *   GET    /api/exams                 список всех материалов для подготовки
 *   POST   /api/exams                 создать (multipart: title, description,
 *                                    и file ИЛИ url; для картинки можно preview)
 *   DELETE /api/exams?id=<id>         удалить материал вместе с файлом
 *
 * Файлы хранятся в Cloudflare R2, метаданные — рядом в json-объектах.
 */

import { getAll, deleteMaterial, metaPath, safeFileName, guessKind, parseForm, CORS_HEADERS, r2PutObject, r2Ready } from './_shared.js';

export const config = { runtime: 'nodejs', api: { bodyParser: false } };

const KIND = 'exams';

export default async function handler(req, res) {
  for (const [key, value] of Object.entries(CORS_HEADERS)) res.setHeader(key, value);

  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (req.method === 'GET') {
      if (!r2Ready()) return res.status(500).json({ error: 'Хранилище R2 ещё не настроено.' });
      return res.status(200).json(await getAll(KIND));
    }

    if (req.method === 'POST') {
      if (!r2Ready()) return res.status(500).json({ error: 'Хранилище R2 ещё не настроено.' });
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
        const key = `${KIND}/${id}/${safeFileName(file.filename)}`;
        fileUrl = await r2PutObject(key, file.buffer, mime);
        if (preview && preview.buffer.length) {
          previewUrl = await r2PutObject(`${KIND}/${id}/_preview.jpg`, preview.buffer, 'image/jpeg');
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

      await r2PutObject(metaPath(KIND, id), Buffer.from(JSON.stringify(meta)), 'application/json');

      return res.status(201).json(meta);
    }

    if (req.method === 'DELETE') {
      if (!r2Ready()) return res.status(500).json({ error: 'Хранилище R2 ещё не настроено.' });
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