/* MIK.COM — минимальный клиент Supabase без внешних зависимостей.
 * Интерфейс используется напрямую в script.js:
 *   SB.init(), await SB.restore(), SB.user,
 *   signUp/signIn/signOut,
 *   select(table, columns[, filter]), insert(table, row),
 *   update(table, id, patch), remove(table, id),
 *   upload(bucket, path, file), publicUrl(bucket, path), removeStorage(bucket, path).
 * Сессия живёт в localStorage; истёкшие токены обновляются автоматически.
 *
 * ВАЖНО: все запросы к Supabase идут ЧЕРЕЗ СВОЙ ДОМЕН (/api/db) — это прокси
 * на Vercel. Прямые обращения браузера к supabase.co из нашего региона рвутся,
 * из-за чего при обновлении страницы «пропадали» материалы и расписание.
 */
(function () {
  'use strict';

  const CFG = window.MIK_SUPABASE;
  if (!CFG || !CFG.url || !CFG.anonKey) {
    console.error('config.js не загружена: window.MIK_SUPABASE отсутствует.');
    return;
  }
  // На тот случай, если кто-то поднимет сайт на другом домене, всё равно
  // используем прокси своего приложения (он относительный).
  const API_PROXY = '/api/db';

  const SESSION_KEY = 'mik-sb-session';
  const DEFAULT_BUCKET = 'files';

  let currentUser = null;

  function jwtPayload(token) {
    try {
      const part = token.split('.')[1];
      const padded = part.replace(/-/g, '+').replace(/_/g, '/');
      const json = decodeURIComponent(
        atob(padded).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')
      );
      return JSON.parse(json);
    } catch (e) {
      return {};
    }
  }

  function loadSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function saveSession(session) {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
  }

  // Классификация ошибок — это прошлый friendlyError оставили в script.js;
  // здесь только бросаем ошибки с code/status, чтобы там дать точный текст.
  function httpError(message, status, code) {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    return error;
  }

  // Все запросы к Supabase идут через прокси своего домена (/api/db):
  // прямые обращения браузера к supabase.co из нашего региона обрываются.
  function proxyUrl(path) {
    return API_PROXY + '?path=' + encodeURIComponent(path);
  }

  async function request(path, options) {
    const session = loadSession();
    const headers = Object.assign({ apikey: CFG.anonKey }, options.headers || {});
    if (session && session.access_token) headers.Authorization = 'Bearer ' + session.access_token;
    const response = await fetch(proxyUrl(path), Object.assign({}, options, { headers }));
    if (!response.ok) {
      let detail = null;
      try { detail = await response.json(); } catch (e) { /* тело не JSON */ }
      throw httpError(
        (detail && (detail.message || detail.error_description)) || 'HTTP ' + response.status,
        response.status,
        detail && detail.code
      );
    }
    return response;
  }

  async function ensureFreshSession() {
    const session = loadSession();
    if (!session || !session.refresh_token || !session.access_token) {
      currentUser = null;
      return session;
    }
    const payload = jwtPayload(session.access_token);
    const exp = payload && payload.exp ? payload.exp * 1000 : 0;
    if (exp && Date.now() < exp - 60000) {
      currentUser = session.user || null;
      return session;
    }
    try {
      const response = await fetch(proxyUrl('/auth/v1/token?grant_type=refresh_token'), {
        method: 'POST',
        headers: { apikey: CFG.anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: session.refresh_token })
      });
      const data = await response.json();
      if (!response.ok || !data.access_token) throw new Error('refresh failed');
      const updated = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        user: data.user || session.user
      };
      saveSession(updated);
      currentUser = updated.user;
      return updated;
    } catch (e) {
      saveSession(null);
      currentUser = null;
      return null;
    }
  }

  const SB = {
    get user() { return currentUser; },

    init: function () {
      // Заглушка для совместимости с boot(): реальная сессия поднимается в restore().
    },

    restore: async function () {
      const session = await ensureFreshSession();
      if (!session || !session.access_token) { currentUser = null; return null; }
      currentUser = session.user || null;
      return currentUser;
    },

    signUp: async function (email, password, displayName) {
      const response = await fetch(proxyUrl('/auth/v1/signup'), {
        method: 'POST',
        headers: { apikey: CFG.anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          data: displayName ? { display_name: String(displayName).slice(0, 40) } : {}
        })
      });
      const data = await response.json();
      if (!response.ok) throw httpError(
        data.error_description || data.msg || 'Ошибка регистрации',
        response.status,
        data.code
      );
      if (data.access_token) {
        saveSession({
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          user: data.user
        });
        currentUser = data.user || null;
      }
      return data;
    },

    signIn: async function (email, password) {
      const response = await fetch(proxyUrl('/auth/v1/token?grant_type=password'), {
        method: 'POST',
        headers: { apikey: CFG.anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await response.json();
      if (!response.ok || !data.access_token) throw httpError(
        data.error_description || data.msg || 'Неверный email или пароль',
        response.status,
        data.code
      );
      saveSession({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        user: data.user
      });
      currentUser = data.user || null;
      return data;
    },

    signOut: async function () {
      const session = loadSession();
      try {
        await fetch(proxyUrl('/auth/v1/logout'), {
          method: 'POST',
          headers: { apikey: CFG.anonKey, Authorization: 'Bearer ' + (session ? session.access_token : ''), 'Content-Type': 'application/json' },
          body: '{}'
        });
      } catch (e) { /* локально выходим в любом случае */ }
      saveSession(null);
      currentUser = null;
    },

    // select('materials', '*,profiles(display_name)') или
    // select('profiles', 'email,display_name,role', '&id=eq.UUID')
    select: async function (table, columns, filter) {
      await ensureFreshSession();
      const response = await request(`/rest/v1/${table}?select=${columns}${filter || ''}`);
      return response.json();
    },

    insert: async function (table, row) {
      await ensureFreshSession();
      const response = await request(`/rest/v1/${table}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify(row)
      });
      return response.json();
    },

    update: async function (table, id, patch) {
      await ensureFreshSession();
      const response = await request(`/rest/v1/${table}?id=eq.${encodeURIComponent(String(id))}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify(patch)
      });
      return response.json();
    },

    remove: async function (table, id) {
      await ensureFreshSession();
      return request(`/rest/v1/${table}?id=eq.${encodeURIComponent(String(id))}`, { method: 'DELETE' });
    },

    upload: async function (bucket, path, file) {
      await ensureFreshSession();
      const segments = path.split('/').map(encodeURIComponent).join('/');
      return request(`/storage/v1/object/${bucket}/${segments}`, {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file
      });
    },

    // Загрузка файла через свой сервер (Vercel Blob): крупные файлы в наш
    // регион напрямую через supabase.co не доезжают, а свой домен работает.
    uploadExternal: async function (formData) {
      await ensureFreshSession();
      const session = loadSession();
      const headers = { apikey: CFG.anonKey };
      if (session && session.access_token) headers.Authorization = 'Bearer ' + session.access_token;
      const response = await fetch('/api/upload', { method: 'POST', headers, body: formData });
      if (!response.ok) {
        let detail = null;
        try { detail = await response.json(); } catch (e) { /* тело не JSON */ }
        throw httpError(
          (detail && (detail.error || detail.message)) || 'Ошибка загрузки файла.',
          response.status
        );
      }
      return response.json();
    },

    // Удаление файлов из Vercel Blob (kind: materials|exams, id — папка).
    removeExternal: async function (kind, id) {
      const session = loadSession();
      const response = await fetch('/api/delete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: CFG.anonKey,
          Authorization: 'Bearer ' + (session && session.access_token ? session.access_token : '')
        },
        body: JSON.stringify({ kind, id })
      });
      if (!response.ok) {
        let detail = null;
        try { detail = await response.json(); } catch (e) { /* тело не JSON */ }
        throw httpError(
          (detail && (detail.error || detail.message)) || 'Не удалось удалить файл.',
          response.status
        );
      }
      return response.json();
    },

    removeStorage: async function (bucket, path) {
      await ensureFreshSession();
      const segments = path.split('/').map(encodeURIComponent).join('/');
      return request(`/storage/v1/object/${bucket}/${segments}`, { method: 'DELETE' });
    },

    publicUrl: function (bucket, path) {
      return proxyUrl(`/storage/v1/object/public/${bucket}/${path.split('/').map(encodeURIComponent).join('/')}`);
    }
  };

  window.SB = SB;
})();