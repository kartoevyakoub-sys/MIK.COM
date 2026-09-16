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
    const profile = await assertSupabaseUser(req);

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8') || '{}';
    const body = JSON.parse(raw);

    const kind = (body && body.kind) || '';
    const id = (body && body.id) || '';
    if (!KIND_OK.has(kind) || !id) {
      return res.status(400).json({ error: 'Нужны kind (materials|exams) и id.' });
    }

    // Проверяем права так же, как RLS в БД: автор или админ удаляют,
    // экзамены — только админ. Чужие файлы трогать нельзя.
    // Folder-id блоба живёт внутри file_url (id=<uuid>), поэтому ищем
    // по вхождению в file_url, а не по первичному ключу записи.
    if (!profile || !profile.id) {
      return res.status(401).json({ error: 'Сессия недействительна. Войдите заново.' });
    }
    const urlBase = process.env.SUPABASE_URL;
    const anon = String(req.headers['apikey'] || '');
    const auth = String(req.headers['authorization'] || '');
    if (!urlBase || !anon) {
      return res.status(500).json({ error: 'SUPABASE_URL не задан на сервере.' });
    }
    const escaped = encodeURIComponent(String(id));
    const rowResp = await fetch(
      `${urlBase}/rest/v1/${kind}?select=author_id&file_url=like.*${escaped}*&limit=1`,
      { headers: { apikey: anon, Authorization: auth } }
    );
    if (!rowResp.ok) {
      return res.status(500).json({ error: 'Не удалось проверить права на запись.' });
    }
    const rows = await rowResp.json();
    const record = Array.isArray(rows) && rows.length ? rows[0] : null;
    if (!record) {
      return res.status(404).json({ error: 'Запись не найдена.' });
    }
    const isAdmin = profile.role === 'admin';
    const isAuthor = record.author_id === profile.id;
    const allowed = kind === 'materials' ? (isAuthor || isAdmin) : isAdmin;
    if (!allowed) {
      return res.status(403).json({ error: 'Удалять можно только свои материалы.' });
    }

    await deleteMaterial(kind, String(id));
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('API delete error:', error);
    const status = typeof error.status === 'number' ? error.status : 500;
    return res.status(status).json({ error: error.message || 'Внутренняя ошибка сервера.' });
  }
}