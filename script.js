/*
 * MIK.COM — основной клиентский код.
 *
 * 1) расписание, материалы, экзамены и файлы хранятся в общей базе
 *    Supabase (Postgres + Storage). Клиент работает с ней напрямую
 *    через тонкий fetch-клиент supabase.js, без лишних серверных API;
 * 2) вход обязателен: открытая регистрация, имя автора показывается
 *    у материалов, роль admin определяется только сервером (RLS);
 * 3) настройки интерфейса хранятся локально в localStorage, IndexedDB
 *    осталась как офлайн-запасная копия материалов;
 * 4) списки обновляются каждые 20 секунд — изменения с любого
 *    устройства доходят до всех.
 */

const SUBJECTS = [
  'Физика', 'Математика', 'Программирование', 'Иностранный язык', 'Информатика', 'Другое'
];

// Обои из локальной папки проекта — грузятся с любого устройства,
// в отличие от внешних URL (Unsplash на ПК не открывался).
const WALLPAPERS = [
  'assets/backgrounds/ingush-mountains.jpg',
  'assets/backgrounds/dark-bg.jpg',
  'assets/backgrounds/light-bg.jpg',
  'assets/backgrounds/IMG_1492.jpeg',
  'images/dark-bg.jpg',
  'images/dark-bg1.jpg'
];

const state = {
  week: 1,
  selectedSubject: SUBJECTS[0],
  materials: [],
  exams: [],
  search: '',
  schedule: null,
  profile: null,
  admin: false,
  pollTimer: null
};

const els = {
  body: document.body,
  menuBtn: document.getElementById('menuBtn'),
  sidePanel: document.getElementById('sidePanel'),
  overlay: document.getElementById('menuOverlay'),
  closePanel: document.getElementById('closePanel'),
  menuDot: document.getElementById('menuNotification'),
  themeSwitch: document.getElementById('themeSwitch'),
  currentWeekLabel: document.getElementById('currentWeekLabel'),
  todayDate: document.getElementById('todayDate'),
  todayDay: document.getElementById('todayDay'),
  scheduleContainer: document.getElementById('scheduleContainer'),
  scheduleSubtitle: document.getElementById('scheduleSubtitle'),
  lectureSubjects: document.getElementById('lectureSubjects'),
  lecturesGrid: document.getElementById('lecturesGrid'),
  subjectsGrid: document.getElementById('subjectsGrid'),
  examsGrid: document.getElementById('examsGrid'),
  wallpaperGrid: document.getElementById('wallpaperGrid'),
  search: document.getElementById('lectureSearch'),
  addDialog: document.getElementById('addDialog'),
  examDialog: document.getElementById('examDialog'),
  addSubject: document.getElementById('addSubject'),
  fileInput: document.getElementById('fileInput'),
  fileTitle: document.getElementById('fileTitle'),
  fileDescription: document.getElementById('fileDescription'),
  linkInput: document.getElementById('linkInput'),
  uploadPreview: document.getElementById('uploadPreview'),
  examTitle: document.getElementById('examTitle'),
  examFile: document.getElementById('examFile'),
  examDescription: document.getElementById('examDescription'),
  examPreview: document.getElementById('examPreview'),
  wallpaperInput: document.getElementById('wallpaperInput'),
  authScreen: document.getElementById('authScreen'),
  authTabs: document.getElementById('authTabs'),
  authForm: document.getElementById('authForm'),
  authName: document.getElementById('authName'),
  authEmail: document.getElementById('authEmail'),
  authPassword: document.getElementById('authPassword'),
  authError: document.getElementById('authError'),
  authNote: document.getElementById('authNote'),
  authSubmit: document.getElementById('authSubmit'),
  nameField: document.getElementById('nameField'),
  userBlock: document.getElementById('userBlock'),
  userName: document.getElementById('userName'),
  userRole: document.getElementById('userRole'),
  userAvatar: document.getElementById('userAvatar'),
  logoutBtn: document.getElementById('logoutBtn'),
  editScheduleBtn: document.getElementById('editScheduleBtn'),
  scheduleDialog: document.getElementById('scheduleDialog'),
  scheduleForm: document.getElementById('scheduleForm'),
  scheduleJson: document.getElementById('scheduleJson'),
  scheduleError: document.getElementById('scheduleError')
};

const DB_NAME = 'mik-com-db';
const DB_VERSION = 1;
let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('materials')) database.createObjectStore('materials', { keyPath: 'id' });
      if (!database.objectStoreNames.contains('exams')) database.createObjectStore('exams', { keyPath: 'id' });
    };
    request.onsuccess = () => { db = request.result; resolve(db); };
    request.onerror = () => reject(request.error);
  });
}

function dbPut(storeName, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

function dbGetAll(storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Удаляет уже сохранённый материал из локального хранилища.
// Используется как офлайн-запасной путь, когда сервер Supabase недоступен.
function dbDelete(storeName, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

function saveLocalSettings() {
  localStorage.setItem('mik-theme', els.body.classList.contains('light') ? 'light' : 'dark');
  localStorage.setItem('mik-subject', state.selectedSubject);
  localStorage.setItem('mik-week', String(state.week));
}

// Быстрый локальный кэш последних данных с сервера: при новом открытии сайта
// списки рисуются из кэша мгновенно, а поверх тихо приезжает свежий ответ API.
// Так «первый экран» на любом устройстве появляется сразу, как на iPhone.
function cacheGet(key, fallback) {
  try {
    const raw = localStorage.getItem('mik-cache-' + key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

function cacheSet(key, value) {
  try {
    localStorage.setItem('mik-cache-' + key, JSON.stringify(value));
  } catch (e) {
    // Кэш переполнен или недоступен — просто пропускаем сохранение.
  }
}

function sanitizePathName(name) {
  return String(name).replace(/[^\w.\-а-яёА-ЯЁ]+/gi, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'file';
}

// Строка из БД (snake_case) превращается в то, что ждёт renderMaterialCard
// (camelCase). _source отличает материалы от экзаменов (у экзаменов правка/удаление
// только у админа, у материалов — у автора и админа).
function toClientRow(row, source) {
  return Object.assign({}, row, {
    _source: source,
    fileName: row.file_name,
    fileUrl: row.file_url,
    fileType: row.file_type,
    previewUrl: row.preview_url
  });
}

function stripStorageUrl(candidate) {
  if (!candidate) return '';
  const marker = '/object/public/files/';
  const i = candidate.indexOf(marker);
  return i >= 0 ? decodeURIComponent(candidate.slice(i + marker.length)) : '';
}

function friendlyError(error) {
  if (error instanceof TypeError) return 'Нет интернет-соединения. Проверьте сеть и попробуйте ещё раз.';
  const message = String((error && error.message) || error);
  if (/invalid login credentials|invalid_credentials|email not confirmed|email_not_confirmed/i.test(message)) return 'Неверный email/пароль или почта не подтверждена.';
  if (/already registered|user_already_exists|already an account/i.test(message)) return 'Такой адрес уже зарегистрирован. Войдите под ним или используйте другой email.';
  if (/email rate limit exceeded|over_email_send_rate_limit/i.test(message)) return 'Слишком много писем за последний час — это лимит хостинга. Подождите час или попробуйте позже.';
  if (/JWT|token.*(expired|invalid)|not authenticated/i.test(message)) return 'Сессия истекла. Войдите заново.';
  if (/row[- ]level security|permission denied|new row violates|violates|policy/i.test(message)) return 'Недостаточно прав: изменение разрешено только автору или администратору.';
  if (/storage/i.test(message)) return 'Не получилось сохранить файл. Попробуйте ещё раз.';
  return `Не удалось выполнить запрос: ${message}`;
}

let authMode = 'in';

function setAuthMode(mode) {
  authMode = mode;
  document.querySelectorAll('.auth-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.mode === mode));
  els.nameField.hidden = mode !== 'up';
  els.authSubmit.textContent = mode === 'up' ? 'Зарегистрироваться' : 'Войти';
  els.authPassword.autocomplete = mode === 'up' ? 'new-password' : 'current-password';
}

function showAuthNote(message) {
  els.authNote.textContent = message;
  els.authNote.hidden = false;
  els.authError.hidden = true;
}

function showAuthError(message) {
  els.authError.textContent = message;
  els.authError.hidden = false;
  els.authNote.hidden = true;
}

function showAuthScreen() { els.authScreen.hidden = false; }
function hideAuthScreen() { els.authScreen.hidden = true; }

async function handleAuthSubmit(event) {
  event.preventDefault();
  const email = els.authEmail.value.trim().toLowerCase();
  const password = els.authPassword.value;
  const name = (els.authName.value.trim() || email.split('@')[0]).slice(0, 40);
  if (authMode === 'up' && password.length < 6) return showAuthError('Пароль должен быть не короче 6 символов.');
  els.authSubmit.disabled = true;
  const original = els.authSubmit.textContent;
  els.authSubmit.textContent = 'Подождите…';
  try {
    if (authMode === 'up') {
      const data = await SB.signUp(email, password, name);
      if (!data.access_token) {
        // Включено подтверждение почты — ждём клика по ссылке из письма.
        showAuthNote('Регистрация принята. Подтвердите адрес по ссылке, которая ушла на почту, и войдите.');
        return;
      }
    } else {
      await SB.signIn(email, password);
    }
    hideAuthScreen();
    await onAuthed();
  } catch (error) {
    showAuthError(friendlyError(error));
  } finally {
    els.authSubmit.disabled = false;
    els.authSubmit.textContent = original;
  }
}

async function loadProfile() {
  const rows = await SB.select('profiles', 'email,display_name,role', `&id=eq.${SB.user.id}`);
  state.profile = (rows && rows[0]) || {
    email: SB.user.email,
    display_name: (SB.user.user_metadata && SB.user.user_metadata.display_name) || '',
    role: 'user'
  };
  state.admin = state.profile.role === 'admin';
  renderUserBlock();
}

function renderUserBlock() {
  if (!SB.user) { els.userBlock.hidden = true; return; }
  const name = (state.profile && state.profile.display_name) ||
    (SB.user.user_metadata && SB.user.user_metadata.display_name) || 'Пользователь';
  els.userName.textContent = name;
  els.userAvatar.textContent = name.trim().charAt(0).toUpperCase() || '👤';
  els.userRole.textContent = state.admin ? 'Администратор' : 'Ученик';
  els.userBlock.hidden = false;
  els.editScheduleBtn.hidden = !state.admin;
}

async function logout() {
  await SB.signOut();
  location.reload();
}

async function onAuthed() {
  state.materials = cacheGet('materials', []);
  state.exams = cacheGet('exams', []);
  const cachedSchedule = cacheGet('schedule', null);
  renderAll();
  if (cachedSchedule) renderSchedule(cachedSchedule);
  try { await loadProfile(); } catch (error) { console.error('Профиль не загружен:', error); }
  renderUserBlock();
  await loadData(false);
}

async function openScheduleEditor() {
  els.scheduleError.hidden = true;
  els.scheduleJson.value = '';
  try {
    const rows = await SB.select('schedule', 'data');
    const data = rows && rows[0] && rows[0].data;
    if (data) els.scheduleJson.value = JSON.stringify(data, null, 2);
  } catch (error) {
    els.scheduleError.textContent = friendlyError(error);
    els.scheduleError.hidden = false;
    return;
  }
  els.scheduleDialog.showModal();
}

async function saveSchedule(event) {
  event.preventDefault();
  els.scheduleError.hidden = true;
  let data;
  try {
    data = JSON.parse(els.scheduleJson.value);
  } catch (e) {
    els.scheduleError.textContent = 'Это не валидный JSON. Проверьте скобки и запятые.';
    els.scheduleError.hidden = false;
    return;
  }
  if (!data || !Array.isArray(data.weeks) || !data.weeks.length) {
    els.scheduleError.textContent = 'Формат такой же, как в schedule.json: {"weeks": [...]}.';
    els.scheduleError.hidden = false;
    return;
  }
  try {
    const rows = await SB.update('schedule', 1, { data, updated_by: SB.user.id });
    const saved = rows && rows[0];
    if (saved && saved.data) { cacheSet('schedule', saved.data); renderSchedule(saved.data); }
    els.scheduleDialog.close();
  } catch (error) {
    els.scheduleError.textContent = friendlyError(error);
    els.scheduleError.hidden = false;
  }
}

function formatBytes(bytes) {
  if (!bytes) return '';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let value = bytes; let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  return `${value.toFixed(index ? 1 : 0)} ${units[index]}`;
}

function shortenFileName(name, max = 30) {
  if (!name) return '';
  if (name.length <= max) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot) : '';
  const base = dot > 0 ? name.slice(0, dot) : name;
  return `${base.slice(0, Math.max(8, max - ext.length - 3))}...${ext}`;
}

function fileKind(fileOrName) {
  const name = typeof fileOrName === 'string' ? fileOrName : fileOrName?.name || '';
  const type = typeof fileOrName === 'object' ? fileOrName?.type || '' : '';
  if (type.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i.test(name)) return 'image';
  if (type.startsWith('audio/') || /\.(mp3|wav|m4a|ogg|aac|flac|opus)$/i.test(name)) return 'audio';
  if (type.startsWith('video/') || /\.(mp4|webm|mov|m4v|avi)$/i.test(name)) return 'video';
  if (type === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf';
  if (type.startsWith('text/') || /\.(txt|md|csv|log|json|xml|html|htm)$/i.test(name)) return 'text';
  if (/\.(doc|docx|xls|xlsx|ppt|pptx|odt|ods|odp|rtf)$/i.test(name) || /application\/(msword|vnd\.openxmlformats|vnd\.ms-excel|vnd\.ms-powerpoint)/i.test(type)) return 'document';
  if (typeof fileOrName === 'string' && /^https?:\/\//i.test(fileOrName)) return 'link';
  return 'file';
}

function iconForKind(kind) {
  return ({ image: '🖼️', audio: '🎧', video: '🎬', pdf: '📕', text: '📝', document: '📑', link: '🔗', file: '📄' })[kind] || '📄';
}

function objectUrl(data, type) {
  if (!data) return '';
  return URL.createObjectURL(new Blob([data], { type: type || 'application/octet-stream' }));
}

// Генерирует лёгкую миниатюру (макс. 900px, JPEG) прямо в браузере.
// Она сохраняется как previewUrl и используется для быстрого предпросмотра,
// а оригинал остаётся для скачивания.
function makeImageThumb(file) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const MAX = 900;
      const scale = Math.min(1, MAX / Math.max(img.width, img.height));
      const width = Math.max(1, Math.round(img.width * scale));
      const height = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      canvas.toBlob(blob => resolve(blob), 'image/jpeg', 0.78);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

// Уменьшает большое фото (напр. 8 МБ с телефона) до компактного JPEG
// (макс. 1600px по большей стороне, качество ~0.82). Так файл выходит
// ~150-500 КБ и уверенно доезжает через свой сервер, не упираясь в лимиты.
function makeImageFile(file, maxSide = 1600, quality = 0.82) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const width = Math.max(1, Math.round(img.width * scale));
      const height = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      canvas.toBlob(blob => resolve(blob), 'image/jpeg', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

function isNew(item) {
  return item.newForEveryone !== false && !JSON.parse(localStorage.getItem('mik-seen') || '[]').includes(item.id);
}

function markSeen(id) {
  const seen = JSON.parse(localStorage.getItem('mik-seen') || '[]');
  if (!seen.includes(id)) seen.push(id);
  localStorage.setItem('mik-seen', JSON.stringify(seen.slice(-500)));
  updateNotifications();
}

function updateNotifications() {
  const hasNewLectures = state.materials.some(isNew);
  const hasNewExams = state.exams.some(isNew);
  els.menuDot.hidden = !(hasNewLectures || hasNewExams);
  document.querySelector('[data-dot="lectures"]').hidden = !hasNewLectures;
  document.querySelector('[data-dot="subjects"]').hidden = !hasNewLectures;
  document.querySelector('[data-dot="exams"]').hidden = !hasNewExams;
}

function setWallpaper(url) {
  document.body.style.setProperty('--wallpaper', `url("${url}")`);
  localStorage.setItem('mik-wallpaper', url);
  renderWallpapers();
}

function chooseRandomWallpaper() {
  // Выбор происходит только один раз (или после «Сбросить обои»):
  // дальше setWallpaper сохраняет его, и он больше не меняется.
  if (localStorage.getItem('mik-custom-wallpaper')) return;
  const previous = localStorage.getItem('mik-last-random-wallpaper');
  const options = WALLPAPERS.filter(url => url !== previous);
  const url = options[Math.floor(Math.random() * options.length)];
  setWallpaper(url);
}

function loadWallpaper() {
  const custom = localStorage.getItem('mik-custom-wallpaper');
  if (custom) { setWallpaper(custom); return; }
  // Уже выбранные обои сохраняются: при каждом открытии сайта фон не меняется.
  const chosen = localStorage.getItem('mik-wallpaper');
  if (chosen && WALLPAPERS.includes(chosen)) { setWallpaper(chosen); return; }
  chooseRandomWallpaper();
}

function applyTheme() {
  const light = localStorage.getItem('mik-theme') === 'light';
  els.body.classList.toggle('light', light);
  els.body.classList.toggle('dark', !light);
  els.themeSwitch.classList.toggle('on', light);
  els.themeSwitch.setAttribute('aria-checked', String(light));
}

function renderWallpapers() {
  const current = localStorage.getItem('mik-wallpaper');
  els.wallpaperGrid.innerHTML = WALLPAPERS.map((url, i) => `
    <button class="wallpaper-card ${current === url ? 'active' : ''}" data-wallpaper="${url}">
      <img src="${url}" alt="Вариант обоев ${i + 1}" loading="lazy"><span>Обои ${i + 1}</span>
    </button>`).join('');
}

function setDateInfo() {
  const now = new Date();
  els.todayDate.textContent = now.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  els.todayDay.textContent = now.toLocaleDateString('ru-RU', { weekday: 'long' });
}

function renderWeekControls() {
  els.currentWeekLabel.textContent = `${state.week} неделя`;
  els.scheduleSubtitle.textContent = `${state.week} неделя • ${new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })}`;
}

function renderSchedule(data) {
  state.schedule = data;
  const week = data.weeks.find(w => Number(w.weekNumber) === Number(state.week)) || data.weeks[0];
  if (!week) return;
  state.week = Number(week.weekNumber);
  renderWeekControls();
  els.scheduleContainer.innerHTML = '';
  const weekTitle = document.createElement('div');
  weekTitle.className = 'week-title';
  weekTitle.textContent = `${week.weekNumber} НЕДЕЛЯ`;
  els.scheduleContainer.appendChild(weekTitle);

  week.days.forEach(day => {
    const card = document.createElement('article'); card.className = 'day-card';
    card.innerHTML = `<div class="day-header">${escapeHtml(day.name)}</div><div class="day-content"></div>`;
    const content = card.querySelector('.day-content');
    if (day.emptyMessage) content.innerHTML = `<div class="online">${escapeHtml(day.emptyMessage)}</div>`;
    else (day.lessons || []).forEach(lesson => {
      const row = document.createElement('div'); row.className = 'lesson';
      row.innerHTML = `<div class="lesson-info"><div class="lesson-number">${escapeHtml(String(lesson.number))}) ${escapeHtml(lesson.subject || '')}</div>${lesson.type ? `<div class="lesson-name">${escapeHtml(lesson.type)}</div>` : ''}<div class="teacher">${escapeHtml(lesson.teacher || '')}</div></div><div class="classroom">${escapeHtml(lesson.room || '—')}</div>`;
      content.appendChild(row);
    });
    els.scheduleContainer.appendChild(card);
  });
  requestAnimationFrame(() => {
    document.querySelectorAll('.week-title,.day-card').forEach((el, i) => setTimeout(() => el.classList.add('show'), i * 55));
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#039;', '"':'&quot;' }[char]));
}

function renderSubjects() {
  els.addSubject.innerHTML = SUBJECTS.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
  els.addSubject.value = state.selectedSubject;
  els.lectureSubjects.innerHTML = SUBJECTS.map(s => `<button class="pill ${s === state.selectedSubject ? 'active' : ''}" data-subject="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join('');
  els.subjectsGrid.innerHTML = SUBJECTS.map(subject => {
    const count = state.materials.filter(m => m.subject === subject).length;
    return `<button class="subject-card" data-subject-card="${escapeHtml(subject)}"><h3>${escapeHtml(subject)}</h3><p>${count} ${count === 1 ? 'материал' : 'материалов'}</p></button>`;
  }).join('');
}

function renderMaterialCard(item) {
  const kind = item.kind || fileKind(item.fileName);
  const fresh = isNew(item);
  const previewSrc = item.previewUrl || item.fileUrl || (item.data ? objectUrl(item.data, item.mime) : '');
  let preview = '';
  if (kind === 'image' && previewSrc) preview = `<div class="preview"><img src="${previewSrc}" alt="Предпросмотр" loading="lazy" decoding="async"></div>`;
  else if (kind === 'audio' && previewSrc) preview = `<div class="preview"><audio controls src="${previewSrc}"></audio></div>`;
  else if (kind === 'video' && previewSrc) preview = `<div class="preview"><video controls playsinline src="${previewSrc}"></video></div>`;
  else if (kind === 'pdf' && previewSrc) preview = `<div class="preview preview-document"><iframe title="Предпросмотр PDF" src="${previewSrc}"></iframe></div>`;
  else if (kind === 'text' && previewSrc) preview = `<div class="preview preview-file"><strong>Текстовый файл</strong><span>${escapeHtml(item.fileName || '')}</span><small>Откройте файл, чтобы посмотреть содержимое.</small></div>`;
  else if (kind === 'document') preview = `<div class="preview preview-file"><strong>Предпросмотр документа</strong><span>${escapeHtml(item.fileName || 'Документ')}</span><small>Формат документа будет открыт через приложение/браузер устройства.</small></div>`;
  else if (item.url) preview = `<div class="preview preview-link"><span>🔗</span><a target="_blank" rel="noopener noreferrer" href="${escapeHtml(item.url)}">${escapeHtml(item.url)}</a></div>`;
  else if (previewSrc) preview = `<div class="preview preview-file"><strong>Файл</strong><span>${escapeHtml(item.fileName || item.title)}</span><small>Этот формат хранится и доступен для скачивания.</small></div>`;
  const canDelete = state.admin || (item.author_id && SB.user && item._source === 'materials' && item.author_id === SB.user.id);
  const download = (item.data || item.fileUrl) ? `<button class="small-action" data-download="${item.id}">Скачать</button>` : '';
  const open = item.url ? `<a class="small-action" target="_blank" rel="noopener noreferrer" href="${escapeHtml(item.url)}">Открыть</a>` : '';
  const deleteAction = canDelete ? `<button class="small-action danger-action" data-delete="${item.id}">Удалить</button>` : '';
  const author = item.profiles && item.profiles.display_name ? ` • ${escapeHtml(item.profiles.display_name)}` : '';
  return `<article class="material-card ${fresh ? 'new' : ''}" data-id="${item.id}">
    <div class="material-head"><div class="file-icon">${iconForKind(kind)}</div><div><div class="material-name" title="${escapeHtml(item.fileName || item.title)}">${escapeHtml(item.title)}</div><div class="material-meta">${escapeHtml(item.subject || 'Сессии и экзамены')} • ${escapeHtml(shortenFileName(item.fileName || 'Ссылка'))}${item.size ? ` • ${formatBytes(item.size)}` : ''}${author}</div></div></div>
    ${item.description ? `<div class="material-desc">${escapeHtml(item.description)}</div>` : ''}${preview}<div class="material-actions">${download}${open}<button class="small-action" data-seen="${item.id}">${fresh ? 'Отметить' : 'Новое'}</button>${deleteAction}</div>
  </article>`;
}

function renderLectures() {
  const q = state.search.trim().toLowerCase();
  const items = state.materials.filter(m => m.subject === state.selectedSubject && (!q || `${m.title} ${m.description || ''} ${m.fileName || ''}`.toLowerCase().includes(q)));
  els.lecturesGrid.innerHTML = items.length ? items.map(renderMaterialCard).join('') : `<div class="empty-state">В этом предмете пока нет материалов.<br>Добавьте первый файл.</div>`;
  updateNotifications();
}

function renderExams() {
  els.examsGrid.innerHTML = state.exams.length ? state.exams.map(renderMaterialCard).join('') : `<div class="empty-state">Здесь пока ничего нет. Добавьте вопросы или материалы для подготовки.</div>`;
  updateNotifications();
}

function renderAll() { renderSubjects(); renderLectures(); renderExams(); renderWallpapers(); }

function openMenu() { els.sidePanel.classList.add('open'); els.overlay.classList.add('visible'); els.menuBtn.classList.add('open'); els.menuBtn.setAttribute('aria-expanded','true'); els.sidePanel.setAttribute('aria-hidden','false'); }
function closeMenu() { els.sidePanel.classList.remove('open'); els.overlay.classList.remove('visible'); els.menuBtn.classList.remove('open'); els.menuBtn.setAttribute('aria-expanded','false'); els.sidePanel.setAttribute('aria-hidden','true'); }

function showSection(name) {
  document.querySelectorAll('.app-section').forEach(section => section.classList.remove('active-section'));
  const section = document.getElementById(`${name}Section`);
  if (section) section.classList.add('active-section');
  document.querySelectorAll('.menu-item[data-section]').forEach(btn => btn.classList.toggle('active', btn.dataset.section === name));
  closeMenu();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function openAddDialog(subject = state.selectedSubject) {
  if (!SB.user) return alert('Сначала войдите в аккаунт.');
  state.selectedSubject = subject;
  els.addSubject.value = subject;
  els.fileInput.value = ''; els.linkInput.value = ''; els.fileTitle.value = ''; els.fileDescription.value = ''; els.uploadPreview.hidden = true; if (els.uploadPreview.dataset.objectUrl) URL.revokeObjectURL(els.uploadPreview.dataset.objectUrl); els.uploadPreview.innerHTML = ''; delete els.uploadPreview.dataset.objectUrl;
  els.addDialog.showModal();
}

function setupPreview(input, target, titleInput) {
  input.addEventListener('change', () => {
    const file = input.files[0];
    if (!file) {
      target.hidden = true;
      target.innerHTML = '';
      return;
    }

    // Поле названия остаётся обязательным. Автозаполнение только помогает пользователю,
    // но он всё равно может изменить подпись перед добавлением.
    if (!titleInput.value) titleInput.value = file.name.replace(/\.[^.]+$/, '').slice(0, 80);

    const kind = fileKind(file);
    const object = URL.createObjectURL(file);
    let content = `<div class="upload-preview-head"><strong>Предпросмотр</strong><button type="button" class="preview-remove" aria-label="Удалить выбранный файл">Удалить файл</button></div>`;
    content += `<div class="upload-file-name">${escapeHtml(shortenFileName(file.name, 58))}<span>${formatBytes(file.size)}</span></div>`;

    if (kind === 'image') content += `<img src="${object}" alt="Предпросмотр изображения">`;
    else if (kind === 'audio') content += `<audio controls src="${object}"></audio>`;
    else if (kind === 'video') content += `<video controls playsinline src="${object}"></video>`;
    else if (kind === 'pdf') content += `<iframe class="upload-pdf" title="Предпросмотр PDF" src="${object}"></iframe>`;
    else if (kind === 'text') {
      const reader = new FileReader();
      reader.onload = () => {
        const pre = target.querySelector('.upload-text-preview');
        if (pre) pre.textContent = String(reader.result).slice(0, 5000);
      };
      reader.readAsText(file);
      content += `<pre class="upload-text-preview">Загрузка текста…</pre>`;
    } else if (kind === 'document') {
      content += `<div class="upload-document-preview"><span class="file-icon">📑</span><strong>${escapeHtml(file.name)}</strong><small>Документ выбран. Для DOC/DOCX/XLS/XLSX/PPT/PPTX и других офисных форматов браузер покажет системный просмотрщик или приложение устройства.</small></div>`;
    } else {
      content += `<div class="upload-document-preview"><span class="file-icon">${iconForKind(kind)}</span><strong>${escapeHtml(file.name)}</strong><small>Файл выбран и будет доступен для скачивания после добавления.</small></div>`;
    }

    target.hidden = false;
    target.innerHTML = content;
    target.dataset.objectUrl = object;
    target.querySelector('.preview-remove').addEventListener('click', () => {
      input.value = '';
      target.hidden = true;
      target.innerHTML = '';
      if (target.dataset.objectUrl) URL.revokeObjectURL(target.dataset.objectUrl);
      delete target.dataset.objectUrl;
    });
  });
}

async function saveMaterial(event) {
  event.preventDefault();
  const file = els.fileInput.files[0];
  const url = els.linkInput.value.trim();
  const title = els.fileTitle.value.trim();
  const subject = els.addSubject.value;
  if (!title) return alert('Обязательно подпишите файл: что это и для чего.');
  if (!file && !url) return alert('Выберите файл или вставьте ссылку.');

  const button = els.addDialog.querySelector('.dialog-actions .primary-action');
  const original = button.textContent;
  button.disabled = true; button.textContent = 'Загружаем…';
  try {
    let fileUrl = '', fileType = '', fileName = '', previewUrl = '';
    if (file) {
      fileName = file.name;
      fileType = file.type || '';
      try {
        // Основной путь: файл (для картинок — компактная копия) уходит в Vercel Blob
        // через свой домен, метаданные потом пишем в Supabase. Так крупные файлы
        // доезжают даже с нестабильного канала: он режет прямые передачи supabase.co.
        const fd = new FormData();
        fd.append('kind', 'materials');
        if (fileKind(file) === 'image' && file.type !== 'image/svg+xml') {
          const web = await makeImageFile(file);
          if (web) {
            fd.append('file', web, (fileName.replace(/\.[^.]+$/, '') || 'image') + '.jpg');
            fileType = 'image/jpeg';
          } else {
            fd.append('file', file, fileName);
          }
          const thumb = await makeImageThumb(file);
          if (thumb) fd.append('preview', thumb, 'preview.jpg');
        } else {
          fd.append('file', file, fileName);
        }
        const res = await SB.uploadExternal(fd);
        fileUrl = res && res.fileUrl;
        if (!fileUrl) throw new Error('Сервер не вернул ссылку на файл.');
        previewUrl = (res && res.previewUrl) || '';
        if (res && res.fileType) fileType = res.fileType;
      } catch (uploadError) {
        // Только при реальном обрыве связи пробуем резервный прямой путь в Supabase.
        if (!(uploadError instanceof TypeError)) throw uploadError;
        console.error('Blob-загрузка не удалась, пробуем напрямую в Supabase:', uploadError);
        const folder = `materials/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const safeName = sanitizePathName(file.name);
        await SB.upload('files', folder + '/' + safeName, file);
        fileUrl = SB.publicUrl('files', folder + '/' + safeName);
        if (fileKind(file) === 'image' && file.type !== 'image/svg+xml') {
          const thumb = await makeImageThumb(file);
          if (thumb) {
            await SB.upload('files', folder + '/preview.jpg', thumb);
            previewUrl = SB.publicUrl('files', folder + '/preview.jpg');
          }
        }
      }
    }
    const inserted = await SB.insert('materials', {
      title,
      description: els.fileDescription.value.trim(),
      subject,
      file_url: fileUrl || null,
      file_name: fileName || null,
      file_type: fileType || null,
      preview_url: previewUrl || null,
      url: url || null,
      size: file ? file.size : null
    });
    const item = toClientRow(inserted && inserted[0], 'materials');
    state.materials.push(item);
    state.selectedSubject = subject;
    saveLocalSettings(); renderAll(); els.addDialog.close(); showSection('lectures');
  } catch (error) {
    console.error('Не удалось добавить материал:', error);
    alert(friendlyError(error));
  } finally {
    button.disabled = false; button.textContent = original;
  }
}

async function saveExam(event) {
  event.preventDefault();
  const file = els.examFile.files[0]; const title = els.examTitle.value.trim();
  if (!title) return alert('Обязательно укажите название материала.');
  if (!file) return alert('Выберите файл.');

  const button = els.examDialog.querySelector('.dialog-actions .primary-action');
  const original = button.textContent;
  button.disabled = true; button.textContent = 'Загружаем…';
  try {
    let fileUrl = '', fileType = file.type || null;
    try {
      const fd = new FormData();
      fd.append('kind', 'exams');
      if (fileKind(file) === 'image' && file.type !== 'image/svg+xml') {
        const web = await makeImageFile(file);
        if (web) {
          fd.append('file', web, (title.replace(/\.[^.]+$/, '') || 'image') + '.jpg');
          fileType = 'image/jpeg';
        } else {
          fd.append('file', file, file.name);
        }
      } else {
        fd.append('file', file, file.name);
      }
      const res = await SB.uploadExternal(fd);
      fileUrl = res && res.fileUrl;
      if (!fileUrl) throw new Error('Сервер не вернул ссылку на файл.');
      if (res && res.fileType) fileType = res.fileType;
    } catch (uploadError) {
      if (!(uploadError instanceof TypeError)) throw uploadError;
      console.error('Blob-загрузка не удалась, пробуем напрямую в Supabase:', uploadError);
      const folder = `exams/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const safeName = sanitizePathName(file.name);
      await SB.upload('files', folder + '/' + safeName, file);
      fileUrl = SB.publicUrl('files', folder + '/' + safeName);
    }
    const inserted = await SB.insert('exams', {
      title,
      description: els.examDescription.value.trim(),
      file_url: fileUrl,
      file_name: file.name,
      file_type: fileType,
      size: file.size
    });
    const item = toClientRow(inserted && inserted[0], 'exams');
    state.exams.push(item);
    renderExams(); els.examDialog.close(); showSection('exams');
  } catch (error) {
    console.error('Не удалось добавить материал:', error);
    alert(friendlyError(error));
  } finally {
    button.disabled = false; button.textContent = original;
  }
}

async function downloadMaterial(id) {
  const item = [...state.materials, ...state.exams].find(x => x.id === id); if (!item) return;
  const href = item.fileUrl || (item.data ? objectUrl(item.data, item.mime) : '');
  if (!href) return;
  const a = document.createElement('a');
  a.href = href;
  a.download = item.fileName || item.title;
  a.target = item.fileUrl ? '_blank' : '';
  a.rel = 'noopener noreferrer';
  a.click();
  if (!item.fileUrl) setTimeout(() => URL.revokeObjectURL(href), 1000);
}

function mailLink() {
  // mailto универсально открывает почтовый клиент на телефоне.
  // Если позже будет известен конкретный сервис, можно заменить на его webmail URL.
  window.location.href = 'mailto:';
}

function initEvents() {
  els.menuBtn.addEventListener('click', () => els.sidePanel.classList.contains('open') ? closeMenu() : openMenu());
  els.closePanel.addEventListener('click', closeMenu); els.overlay.addEventListener('click', closeMenu);
  document.getElementById('prevWeek').addEventListener('click', () => { if (state.schedule) { const weeks = state.schedule.weeks.map(w=>Number(w.weekNumber)); const i=weeks.indexOf(state.week); if(i>0){state.week=weeks[i-1];renderSchedule(state.schedule);saveLocalSettings();}} });
  document.getElementById('nextWeek').addEventListener('click', () => { if (state.schedule) { const weeks = state.schedule.weeks.map(w=>Number(w.weekNumber)); const i=weeks.indexOf(state.week); if(i<weeks.length-1){state.week=weeks[i+1];renderSchedule(state.schedule);saveLocalSettings();}} });
  els.themeSwitch.addEventListener('click', () => { els.body.classList.toggle('light'); els.body.classList.toggle('dark'); els.themeSwitch.classList.toggle('on'); els.themeSwitch.setAttribute('aria-checked', String(els.body.classList.contains('light'))); saveLocalSettings(); });
  document.querySelectorAll('[data-action="add"]').forEach(btn => btn.addEventListener('click', () => openAddDialog()));
  document.querySelector('[data-action="add-exam"]').addEventListener('click', () => { if (!SB.user) return alert('Сначала войдите в аккаунт.'); els.examDialog.showModal(); });
  document.querySelector('[data-action="mail"]').addEventListener('click', mailLink);
  document.querySelectorAll('[data-section]').forEach(btn => btn.addEventListener('click', () => showSection(btn.dataset.section)));
  els.lectureSubjects.addEventListener('click', e => { const btn=e.target.closest('[data-subject]'); if(!btn)return; state.selectedSubject=btn.dataset.subject; saveLocalSettings(); renderAll(); });
  els.subjectsGrid.addEventListener('click', e => { const card=e.target.closest('[data-subject-card]'); if(!card)return; state.selectedSubject=card.dataset.subjectCard; saveLocalSettings(); renderAll(); showSection('lectures'); });
  els.search.addEventListener('input', e => { state.search=e.target.value; renderLectures(); });
  els.lecturesGrid.addEventListener('click', handleMaterialClick); els.examsGrid.addEventListener('click', handleMaterialClick);
  els.wallpaperGrid.addEventListener('click', e => { const card=e.target.closest('[data-wallpaper]'); if(card){ localStorage.removeItem('mik-custom-wallpaper'); setWallpaper(card.dataset.wallpaper); } });
  document.getElementById('resetWallpaper').addEventListener('click', () => { localStorage.removeItem('mik-custom-wallpaper'); chooseRandomWallpaper(); });
  els.wallpaperInput.addEventListener('change', async e => { const file=e.target.files[0]; if(!file)return; const data=await file.arrayBuffer(); const blob=new Blob([data],{type:file.type}); const reader=new FileReader(); reader.onload=()=>{localStorage.setItem('mik-custom-wallpaper',reader.result);setWallpaper(reader.result)}; reader.readAsDataURL(blob); });
  els.addSubject.addEventListener('change', e => state.selectedSubject=e.target.value);
  document.getElementById('addForm').addEventListener('submit', saveMaterial); document.getElementById('examForm').addEventListener('submit', saveExam);

  // Кнопки отмены — обычные buttons, чтобы HTML5 required не блокировал закрытие диалога.
  // Это особенно важно на iPhone и на Android с жестовой навигацией: отмена не должна
  // зависеть от системной кнопки 'Назад'.
  document.querySelectorAll('[data-dialog-cancel]').forEach(btn => {
    btn.addEventListener('click', () => btn.closest('dialog')?.close('cancel'));
  });
  setupPreview(els.fileInput, els.uploadPreview, els.fileTitle); setupPreview(els.examFile, els.examPreview, els.examTitle);

  els.authTabs.addEventListener('click', e => { const tab = e.target.closest('.auth-tab'); if (tab) setAuthMode(tab.dataset.mode); });
  els.authForm.addEventListener('submit', handleAuthSubmit);
  els.logoutBtn.addEventListener('click', logout);
  els.editScheduleBtn.addEventListener('click', openScheduleEditor);
  els.scheduleForm.addEventListener('submit', saveSchedule);

  // Свайп влево по панели закрывает её — удобно на телефоне.
  let touchStartX = null;
  els.sidePanel.addEventListener('touchstart', e => touchStartX = e.touches[0].clientX, {passive:true});
  els.sidePanel.addEventListener('touchend', e => { if(touchStartX !== null && e.changedTouches[0].clientX - touchStartX < -60) closeMenu(); touchStartX=null; }, {passive:true});
}

async function deleteMaterial(id) {
  const materialIndex = state.materials.findIndex(item => item.id === id);
  const examIndex = state.exams.findIndex(item => item.id === id);
  const item = materialIndex >= 0 ? state.materials[materialIndex] : state.exams[examIndex];
  if (!item) return;

  const confirmed = window.confirm(`Удалить «${item.title}»?\n\nМатериал будет удалён для всех.`);
  if (!confirmed) return;

  const storeName = materialIndex >= 0 ? 'materials' : 'exams';
  try {
    // Файл лежит в Vercel Blob — удаляем и его. Ссылка может быть
    // прокси-формата (/api/file/<kind>/<id>) или прямой blob-ссылкой.
    const fileUrl = item.fileUrl || '';
    const proxyMatch = fileUrl.match(/\/api\/file\/(materials|exams)\/([0-9a-f-]{36})/i);
    const blobMatch = !proxyMatch && fileUrl.indexOf('.blob.vercel-storage.com') >= 0
      ? (new URL(fileUrl).pathname.split('/').filter(Boolean))
      : null;
    const blobKind = proxyMatch ? proxyMatch[1] : (blobMatch ? blobMatch[0] : null);
    const blobId = proxyMatch ? proxyMatch[2] : (blobMatch ? blobMatch[1] : null);
    if (blobKind && blobId) {
      try {
        await SB.removeExternal(blobKind, blobId);
      } catch (blobError) {
        console.error('Не удалось удалить файл из Blob:', blobError);
      }
    }
    const storagePaths = [item.fileUrl, item.previewUrl].map(stripStorageUrl).filter(Boolean);
    await Promise.all(storagePaths.map(path =>
      SB.removeStorage('files', path).catch(error => console.error('Не удалось удалить файл из хранилища:', error))));
    await SB.remove(storeName, id);
    if (materialIndex >= 0) state.materials.splice(materialIndex, 1);
    else state.exams.splice(examIndex, 1);
  } catch (error) {
    // Сервер недоступен — пытаемся удалить из локальной копии.
    console.error('API удаление не удалось, пробуем локальную базу:', error);
    if (error instanceof TypeError) {
      try {
        await openDB();
        await dbDelete(storeName, id);
        if (materialIndex >= 0) state.materials.splice(materialIndex, 1);
        else state.exams.splice(examIndex, 1);
      } catch (localError) {
        console.error('Не удалось удалить материал:', localError);
        alert('Не удалось удалить материал. Попробуйте ещё раз.');
        return;
      }
    } else {
      alert(friendlyError(error));
      return;
    }
  }

  // Если материал был отмечен как новый, убираем и его отметку.
  const seen = JSON.parse(localStorage.getItem('mik-seen') || '[]').filter(seenId => seenId !== id);
  localStorage.setItem('mik-seen', JSON.stringify(seen));
  renderAll();
}

function handleMaterialClick(e) {
  const download = e.target.closest('[data-download]'); if (download) { downloadMaterial(download.dataset.download); return; }
  const deleteButton = e.target.closest('[data-delete]'); if (deleteButton) { deleteMaterial(deleteButton.dataset.delete); return; }
  const seen = e.target.closest('[data-seen]'); if (seen) { markSeen(seen.dataset.seen); renderAll(); return; }
}

async function loadData(silent) {
  try {
    const [materials, exams, scheduleRows] = await Promise.all([
      SB.select('materials', '*,profiles(display_name,email)'),
      SB.select('exams', '*,profiles(display_name,email)'),
      SB.select('schedule', 'data')
    ]);
    state.materials = (materials || []).map(row => toClientRow(row, 'materials'));
    state.exams = (exams || []).map(row => toClientRow(row, 'exams'));
    cacheSet('materials', state.materials);
    cacheSet('exams', state.exams);
    const scheduleData = scheduleRows && scheduleRows[0] && scheduleRows[0].data;
    if (scheduleData && scheduleData.weeks) { cacheSet('schedule', scheduleData); renderSchedule(scheduleData); }
    renderAll();
  } catch (error) {
    // Сервер недоступен — показываем локальную копию из IndexedDB.
    console.error('API недоступна, пробуем локальную базу:', error);
    if (!silent) {
      try {
        await openDB();
        state.materials = await dbGetAll('materials');
        state.exams = await dbGetAll('exams');
        renderAll();
      } catch (localError) {
        console.error('IndexedDB недоступна:', localError);
      }
    }
  }
}

function startPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => loadData(true), 20000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadData(true); });
  window.addEventListener('focus', () => loadData(true));
}

async function boot() {
  applyTheme(); loadWallpaper(); setDateInfo();
  state.week = Number(localStorage.getItem('mik-week') || 1);
  state.selectedSubject = localStorage.getItem('mik-subject') || SUBJECTS[0];
  initEvents();
  SB.init();
  const user = await SB.restore();
  if (user) {
    hideAuthScreen();
    await onAuthed();
    startPolling();
  } else {
    showAuthScreen();
  }
}

boot();
