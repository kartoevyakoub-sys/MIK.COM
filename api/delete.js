/**
 * API: удаление файлов из Vercel Blob.
 *
 *   POST /api/delete   { kind: 'materials'|'exams', id: '<folder id>' }
 *                      Authorization: Bearer <supabase access_token>
 *
 * Удаляет файл, превью и обвязку из Blob. Сама запись в Supabase
 * удаляется клиентом отдельно (через свой токен, RLS остаётся в силе).
 */

import { deleteMaterial, CORS_HEADERS, assertSupabaseUser } from './_shared.js';

export const config = { runtime: 'nodejs', api: { bodyParser: false } };

const KIND_OK = new Set(['materials', 'exams']);

export default async function handler(req, res) {
  for (const [key, value] of Object.entries(CORS_HEADERS)) res.setHeader(key, value);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Метод не поддерживается.' });

  try {
    await assertSupabaseUser(req);

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8') || '{}';
    const body = JSON.parse(raw);

    const kind = (body && body.kind) || '';
    const id = (body && body.id) || '';
    if (!KIND_OK.has(kind) || !id) {
      return res.status(400).json({ error: 'Нужны kind (materials|exams) и id.' });
    }

    await deleteMaterial(kind, String(id));
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('API delete error:', error);
    const status = typeof error.status === 'number' ? error.status : 500;
    return res.status(status).json({ error: error.message || 'Внутренняя ошибка сервера.' });
  }
}