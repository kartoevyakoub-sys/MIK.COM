/**
 * Минимальный S3-совместимый клиент для Cloudflare R2 (без внешних пакетов).
 *
 * Использует AWS Signature V4 (регион auto, сервис s3) и глобальный fetch.
 * Нужные переменные окружения (задаются в Vercel):
 *   R2_ACCOUNT_ID         — Cloudflare account id (поддомен r2)
 *   R2_ACCESS_KEY_ID      — Access Key ID R2-токена
 *   R2_SECRET_ACCESS_KEY  — Secret Access Key R2-токена
 *   R2_BUCKET             — имя бакета, например mik-com
 *   R2_PUBLIC_URL         — публичный r2.dev URL, например https://pub-xxxx.r2.dev
 */

import crypto from 'node:crypto';

const REGION = 'auto';
const SERVICE = 's3';

function env(name) {
  return process.env[name] || '';
}

export function r2Ready() {
  return Boolean(env('R2_ACCOUNT_ID') && env('R2_ACCESS_KEY_ID') && env('R2_SECRET_ACCESS_KEY') && env('R2_BUCKET') && env('R2_PUBLIC_URL'));
}

function configError() {
  return new Error('R2 не настроен: проверьте R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_URL.');
}

const EMPTY_SHA = crypto.createHash('sha256').update('').digest('hex');
const HOST = () => `${env('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`;

function enc(value) {
  return encodeURIComponent(String(value));
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function hex(value) {
  return value.toString('hex');
}

/** Кодирует ключ объекта в segment-wise URI, чтобы канонический запрос совпадал с URL. */
export function encodeKey(key) {
  return String(key).split('/').map(enc).join('/');
}

/** Публичный URL объекта (отдаётся браузеру напрямую). */
export function publicUrl(key) {
  const base = env('R2_PUBLIC_URL').replace(/\/+$/, '');
  return `${base}/${encodeKey(key)}`;
}

function canonicalQuery(params) {
  return Object.keys(params).sort().map(name => `${enc(name)}=${enc(params[name])}`).join('&');
}

async function r2Fetch({ method, key, params, body, contentType }) {
  if (!r2Ready()) throw configError();

  const query = params ? canonicalQuery(params) : '';
  const resource = `/${env('R2_BUCKET')}${key ? '/' + encodeKey(key) : ''}`;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').split('.')[0];
  const dateStamp = amzDate.slice(0, 8);

  const host = HOST();
  const payloadHash = body ? sha256(body) : EMPTY_SHA;

  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';

  const canonicalRequest = [
    method,
    resource,
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    `${dateStamp}/${REGION}/${SERVICE}/aws4_request`,
    sha256(canonicalRequest)
  ].join('\n');

  const kDate = hmac(`AWS4${env('R2_SECRET_ACCESS_KEY')}`, dateStamp);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hex(hmac(kSigning, stringToSign));

  const authorization = [
    `AWS4-HMAC-SHA256 Credential=${env('R2_ACCESS_KEY_ID')}/${dateStamp}/${REGION}/${SERVICE}/aws4_request`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`
  ].join(', ');

  const requestUrl = `https://${host}${resource}`;
  const headers = {
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    'Authorization': authorization
  };
  if (contentType) headers['Content-Type'] = contentType;

  const response = await fetch(requestUrl + (query ? `?${query}` : ''), {
    method,
    headers,
    body: body || undefined
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`R2 ${method} ${resource} failed: HTTP ${response.status} ${text.slice(0, 200)}`);
  }
  return response;
}

/** Загружает объект (байты или строка) в бакет и возвращает публичный URL. */
export async function r2PutObject(key, data, contentType) {
  await r2Fetch({ method: 'PUT', key, body: Buffer.from(data), contentType });
  return publicUrl(key);
}

/** Возвращает содержимое объекта как Buffer или null, если его нет. */
export async function r2GetObject(key) {
  const response = await r2Fetch({ method: 'GET', key });
  return Buffer.from(await response.arrayBuffer());
}

/** Удаляет объект. */
export async function r2DeleteObject(key) {
  await r2Fetch({ method: 'DELETE', key });
}

/** Список всех ключей с заданным префиксом (ListObjectsV2 с пагинацией). */
export async function r2ListKeys(prefix) {
  const keys = [];
  let token = '';
  for (;;) {
    const params = { 'list-type': '2', prefix };
    if (token) params['continuation-token'] = token;
    const response = await r2Fetch({ method: 'GET', params });
    const xml = await response.text();
    keys.push(...parseListKeys(xml));
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    const match = xml.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/);
    if (!truncated || !match) break;
    token = decodeEntities(match[1]);
  }
  return keys;
}

function parseListKeys(xml) {
  const keys = [];
  for (const contents of xml.matchAll(/<Contents>[\s\S]*?<\/Contents>/g)) {
    const match = contents[0].match(/<Key>([\s\S]*?)<\/Key>/);
    if (match) keys.push(decodeEntities(match[1]));
  }
  return keys;
}

function decodeEntities(value) {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}