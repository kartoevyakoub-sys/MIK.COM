/**
 * Одноразовая миграция: перекачивает старые файлы из Supabase Storage в Vercel Blob.
 *
 * Запустить один раз: GET /api/migrate?secret=<SUPABASE_SERVICE_ROLE_KEY>
 * После миграции файлы будут доступны через /api/file proxy.
 */

import { put } from '@vercel/blob';
import { CORS_HEADERS, BLOB_STORE_ID } from './_shared.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).end();

  try {
    const url = new URL(req.url, 'http://x');
    const secret = url.searchParams.get('secret') || '';
    const urlBase = process.env.SUPABASE_URL;

    if (!urlBase) {
      return res.status(500).json({ error: 'SUPABASE_URL не задан.' });
    }

    if (!secret || !/^eyJ/.test(secret)) {
      return res.status(403).json({ error: 'Неверный ключ.' });
    }

    const headers = { apikey: secret, Authorization: 'Bearer ' + secret };

    // Загружаем все строки с файлами из Supabase Storage
    const [materialsRes, examsRes] = await Promise.all([
      fetch(`${urlBase}/rest/v1/materials?select=id,title,author_id,subject,description,file_url,preview_url,file_name,file_type,size&file_url=not.is.null`, { headers }),
      fetch(`${urlBase}/rest/v1/exams?select=id,title,author_id,description,file_url,file_name,file_type,size&file_url=not.is.null`, { headers })
    ]);

    const materials = await materialsRes.json();
    const exams = await examsRes.json();
    const results = [];

    for (const row of [...materials.map(r => ({ ...r, _table: 'materials' })), ...exams.map(r => ({ ...r, _table: 'exams' }))]) {
      if (!row.file_url || !row.file_url.includes('supabase.co/storage')) {
        results.push({ id: row.id, status: 'skipped', reason: 'not a supabase URL' });
        continue;
      }

      try {
        const kind = row._table;
        const id = row.id;

        // Скачиваем основной файл из Supabase Storage
        const fileResp = await fetch(row.file_url);
        if (!fileResp.ok) throw new Error('fetch file ' + fileResp.status);
        const fileBuf = Buffer.from(await fileResp.arrayBuffer());
        const safeName = (row.file_name || 'file').replace(/[^a-zA-Z0-9._\-а-яёА-ЯЁ]/g, '_').slice(0, 80) || 'file';

        // Закидываем в Blob
        const blobFile = await put(`${kind}/${id}/${safeName}`, fileBuf, {
          access: 'public',
          addRandomSuffix: true,
          contentType: row.file_type || 'application/octet-stream',
          storeId: BLOB_STORE_ID,
        });

        // Превью если было
        let previewUrl = '';
        if (row.preview_url && row.preview_url.includes('supabase.co/storage')) {
          try {
            const prevResp = await fetch(row.preview_url);
            if (prevResp.ok) {
              const prevBuf = Buffer.from(await prevResp.arrayBuffer());
              const thumb = await put(`${kind}/${id}/_preview.jpg`, prevBuf, {
                access: 'public',
                addRandomSuffix: true,
                contentType: 'image/jpeg',
                storeId: BLOB_STORE_ID,
              });
              previewUrl = `/api/file?kind=${kind}&id=${id}&preview=1`;
            }
          } catch (e) { /* превью не критично */ }
        }

        // Обновляем БД
        const newFileUrl = `/api/file?kind=${kind}&id=${id}`;
        const updateBody = { file_url: newFileUrl };
        if (kind === 'materials') updateBody.preview_url = previewUrl || null;

        await fetch(`${urlBase}/rest/v1/${row._table}?id=eq.${id}`, {
          method: 'PATCH',
          headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify(updateBody)
        });

        results.push({ id, title: row.title, status: 'ok', fileUrl: newFileUrl });
      } catch (e) {
        results.push({ id: row.id, title: row.title, status: 'error', error: e.message });
      }
    }

    return res.status(200).json({ migrated: results.length, results });
  } catch (error) {
    console.error('Migration error:', error);
    return res.status(500).json({ error: error.message });
  }
}