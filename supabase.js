/* MIK.COM — минимальный клиент Supabase без внешних зависимостей.
 * Интерфейс используется напрямую в script.js:
 *   SB.init(), await SB.restore(), SB.user,
 *   signUp/signIn/signOut,
 *   select(table, columns[, filter]), insert(table, row),
 *   update(table, id, patch), remove(table, id),
 *   upload(bucket, path, file), publicUrl(bucket, path), removeStorage(bucket, path).
 * Сессия живёт в localStorage; истёкшие токены обновляются автоматически. */
(function () {
  'use strict';

  const CFG = window.MIK_SUPABASE;
  if (!CFG || !CFG.url || !CFG.anonKey) {
    console.error('config.js не загружена: window.MIK_SUPABASE отсутствует.');
    return;
  }

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

  async function request(path, options) {
    const session = loadSession();
    const headers = Object.assign({ apikey: CFG.anonKey }, options.headers || {});
    if (session && session.access_token) headers.Authorization = 'Bearer ' + session.access_token;
    const response = await fetch(CFG.url + path, Object.assign({}, options, { headers }));
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
      const form = new URLSearchParams();
      form.set('grant_type', 'refresh_token');
      form.set('refresh_token', session.refresh_token);
      const response = await fetch(CFG.url + '/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        headers: { apikey: CFG.anonKey, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString()
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
      const response = await fetch(CFG.url + '/auth/v1/signup', {
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
      const form = new URLSearchParams();
      form.set('grant_type', 'password');
      form.set('email', email);
      form.set('password', password);
      const response = await fetch(CFG.url + '/auth/v1/token?grant_type=password', {
        method: 'POST',
        headers: { apikey: CFG.anonKey, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString()
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
        await fetch(CFG.url + '/auth/v1/logout', {
          method: 'POST',
          headers: { apikey: CFG.anonKey, Authorization: 'Bearer ' + (session ? session.access_token : '') }
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

    removeStorage: async function (bucket, path) {
      await ensureFreshSession();
      const segments = path.split('/').map(encodeURIComponent).join('/');
      return request(`/storage/v1/object/${bucket}/${segments}`, { method: 'DELETE' });
    },

    publicUrl: function (bucket, path) {
      return `${CFG.url}/storage/v1/object/public/${bucket}/${path.split('/').map(encodeURIComponent).join('/')}`;
    }
  };

  window.SB = SB;
})();