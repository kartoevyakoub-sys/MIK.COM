/**
 * Общие утилиты для API-функций MIK.COM.
 *
 * База данных — Vercel Blob (входит в бесплатный Hobby-план, без карты).
 * Каждый материал хранится как:
 *   - json-блоб с метаданными:      materials/{id}.json или exams/{id}.json
 *   - файл (если загружен):         materials/{id}/{имя файла}
 *   - превью (для картинок):        materials/{id}/_preview.jpg
 *
 * Такой формат исключает конфликты параллельных записей: каждый материал —
 * отдельный объект, никакая общая «большая JSON» файл не перезаписывается.
 */

import { list, del } from '@vercel/blob';
import Busboy from 'busboy';

const TOKEN = process.env.BLOB_READ_WRITE_TOKEN;

// Если классический токен не задан — работаем через OIDC (storeId из env).
export const BLOB_STORE_ID = TOKEN ? undefined : (process.env.BLOB_STORE_ID || process.env.ING_STORE_ID);

if (!TOKEN && !BLOB_STORE_ID) {
  console.warn('Blob не настроен: задайте BLOB_READ_WRITE_TOKEN или BLOB_STORE_ID/ING_STORE_ID.');
}

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey'
};

export function jwtSub(token) {
  try {
    const part = String(token).split('.')[1];
    const pad = part.length % 4 === 0 ? '' : '='.repeat(4 - part.length % 4);
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8');
    return JSON.parse(json).sub || '';
  } catch {
    return '';
  }
}

/**
 * Проверяет, что запрос пришёл от залогиненного пользователя сайта.
 * Делает служебный запрос к Supabase с токеном клиента; если токен
 * недействителен — 401. Возвращает профиль САМОГО пользователя.
 * Нужно, чтобы Blob-загрузки не превратились в публичную свалку для всех.
 */
export async function assertSupabaseUser(req) {
  const auth = String(req.headers['authorization'] || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) {
    const error = new Error('Требуется вход в аккаунт.');
    error.status = 401;
    throw error;
  }
  // anon-ключ публичный и приходит от клиента в заголовке apikey;
  // URL проекта задан в Vercel env (SUPABASE_URL).
  const url = process.env.SUPABASE_URL;
  const anon = String(req.headers['apikey'] || '');
  if (!url || !anon) {
    const error = new Error('SUPABASE_URL не задан на сервере.');
    error.status = 500;
    throw error;
  }
  const sub = jwtSub(token);
  if (!sub) {
    const error = new Error('Сессия недействительна. Войдите заново.');
    error.status = 401;
    throw error;
  }
  let response;
  try {
    response = await fetch(`${url}/rest/v1/profiles?select=id,role&id=eq.${encodeURIComponent(sub)}&limit=1`, {
      headers: { apikey: anon, Authorization: auth }
    });
  } catch (networkError) {
    const error = new Error('Не удалось проверить сессию.');
    error.status = 502;
    throw error;
  }
  if (!response.ok) {
    const error = new Error('Сессия недействительна. Войдите заново.');
    error.status = 401;
    throw error;
  }
  const rows = await response.json();
  return Array.isArray(rows) && rows.length ? rows[0] : { id: sub, role: 'user' };
}

export function metaPath(kind, id) {
  return `${kind}/${id}.json`;
}

/**
 * Парсит multipart/form-data из Node-запроса Vercel
 * (req.formData() там недоступен). Возвращает { fields, files }.
 */
export function parseForm(req) {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers });
    const fields = {};
    const files = [];
    busboy.on('field', (name, value) => { fields[name] = value; });
    busboy.on('file', (name, stream, info) => {
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => {
        files.push({
          name,
          filename: info.filename,
          mime: info.mimeType,
          buffer: Buffer.concat(chunks),
          size: info.size
        });
      });
    });
    busboy.on('error', (error) => reject(error));
    busboy.on('close', () => resolve({ fields, files }));
    req.pipe(busboy);
  });
}

/**
 * Выполняет list() по префиксу, проходя пагинацию до конца.
 */
async function listAll(prefix) {
  let blobs = [];
  let cursor;
  do {
    const page = await list({ prefix, cursor, limit: 1000, storeId: BLOB_STORE_ID });
    blobs = blobs.concat(page.blobs);
    cursor = page.cursor;
  } while (cursor);
  return blobs;
}

/**
 * Возвращает все метаданные материалов нужного типа (materials | exams),
 * отсортированные по дате добавления (новые сверху).
 */
export async function getAll(kind) {
  const blobs = await listAll(`${kind}/`);
  const meta = [];
  for (const blob of blobs) {
    if (!blob.pathname.endsWith('.json')) continue;
    try {
      const response = await fetch(blob.url);
      if (!response.ok) continue;
      meta.push(await response.json());
    } catch {
      // Повреждённый блоб пропускаем.
    }
  }
  meta.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return meta;
}

/**
 * Удаляет файл, превью и метаданные материала.
 */
export async function deleteMaterial(kind, id) {
  const blobs = await listAll(`${kind}/${id}`);
  for (const blob of blobs) {
    await del(blob.url, { storeId: BLOB_STORE_ID });
  }
}

export function guessKind(name, type) {
  const t = type || '';
  if (t.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i.test(name)) return 'image';
  if (t.startsWith('audio/') || /\.(mp3|wav|m4a|ogg|aac|flac|opus)$/i.test(name)) return 'audio';
  if (t.startsWith('video/') || /\.(mp4|webm|mov|m4v|avi)$/i.test(name)) return 'video';
  if (t === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf';
  if (t.startsWith('text/') || /\.(txt|md|csv|log|json|xml|html|htm)$/i.test(name)) return 'text';
  if (/\.(doc|docx|xls|xlsx|ppt|pptx|odt|ods|odp|rtf)$/i.test(name) || /application\/(msword|vnd\.openxmlformats|vnd\.ms-excel|vnd\.ms-powerpoint)/i.test(t)) return 'document';
  return 'file';
}