/**
 * Общие утилиты для API-функций MIK.COM.
 *
 * База данных — Cloudflare R2 (бесплатно 10 ГБ, трафик без лимита).
 * Каждый материал хранится как:
 *   - json-объект с метаданными:      materials/{id}.json или exams/{id}.json
 *   - файл (если загружен):           materials/{id}/{имя файла}
 *   - превью (для картинок):          materials/{id}/_preview.jpg
 *
 * Такой формат исключает конфликты параллельных записей: каждый материал —
 * отдельный объект, никакая общая «большая JSON» файл не перезаписывается.
 */

import Busboy from 'busboy';
import { r2PutObject, r2GetObject, r2DeleteObject, r2ListKeys, r2Ready } from './_r2.js';

export { r2PutObject, r2Ready } from './_r2.js';

if (!r2Ready()) {
  console.warn('R2 не настроен: задайте R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_URL.');
}

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

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
 * Возвращает все метаданные материалов нужного типа (materials | exams),
 * отсортированные по дате добавления (новые сверху).
 */
export async function getAll(kind) {
  const keys = await r2ListKeys(`${kind}/`);
  const meta = [];
  for (const key of keys) {
    if (!key.endsWith('.json')) continue;
    try {
      const raw = await r2GetObject(key);
      meta.push(JSON.parse(raw.toString('utf8')));
    } catch {
      // Повреждённый или отсутствующий объект пропускаем.
    }
  }
  meta.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return meta;
}

/**
 * Удаляет файл, превью и метаданные материала.
 */
export async function deleteMaterial(kind, id) {
  const keys = await r2ListKeys(`${kind}/${id}`);
  for (const key of keys) {
    try {
      await r2DeleteObject(key);
    } catch {
      // Объект мог быть удалён параллельно — пропускаем.
    }
  }
}

/**
 * Безопасное имя файла для ключа R2: без пути к каталогу, не длиннее 120
 * символов; небезопасные символы заменяются случайным именем.
 */
export function safeFileName(name) {
  const clean = String(name || '').replace(/^.*[\\/]/, '').slice(0, 120);
  if (/^[\w. -]+$/.test(clean)) return clean;
  const ext = (clean.match(/\.[\w]{1,10}$/) || [''])[0].toLowerCase();
  return `file-${crypto.randomUUID().slice(0, 8)}${ext}`;
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