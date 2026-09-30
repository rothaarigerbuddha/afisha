/* Тема глазами редактора. THEME — нормализованный манифест (/api/state.theme): виды блоков (kinds: match →
   флаги), кнопки палитры (blocks), эффекты, проявка, палитра текста, экранные слои. Вместо констант:
   kind(el) — первый подходящий kinds[i].match; spec(k) — флаги вида с дефолтами. Загружается до editor.js. */
'use strict';

let THEME = null;
// подпись из манифеста {ru, en}: пока только русский, i18n — следующий шаг (L переопределяется в i18n.js)
const L = o => (o && typeof o === 'object') ? (o.ru ?? o.en ?? '') : (o ?? '');
const KIND_DEFAULTS = { layer: 'stage', edit: 'body', overlap: false, fullw: false, pixelw: false, bottom: false, tiltable: false, reveal: true,
  dev: true, hide: true, shared: true, blends: 'soft', blend_default: 'normal', flip: false, align: false, list: false, generated: false, single: false };

function normalizeTheme(t) {
  t = JSON.parse(JSON.stringify(t || {}));
  const d = Object.assign({}, KIND_DEFAULTS, t.defaults || {});
  t.kinds = (t.kinds || []).map(k => Object.assign({}, d, k));
  if (!t.kinds.some(k => k.match === '*')) t.kinds.push(Object.assign({}, d, { kind: 'block', match: '*', label: { ru: 'блок', en: 'block' } }));
  t.blocks = t.blocks || []; t.effects = t.effects || []; t.colors = t.colors || [];
  t.text = Object.assign({ palette: [], keep_span: [] }, t.text || {});
  t.blends = Object.assign({ all: [{ v: 'normal', label: { ru: 'обычное', en: 'normal' } }], soft: ['normal'] }, t.blends || {});
  t.dev = t.dev || {}; t.images = t.images || {}; t.screen = t.screen || []; t.fonts = Object.assign({ stacks: {}, labels: {}, local: [], system: [] }, t.fonts || {});
  t.edit = Object.assign({ silence: [], css: '' }, t.edit || {});
  t.layout = Object.assign({ step: 8, snap: 6, gap: 8 }, t.layout || {});
  t.embed = Object.assign({ var: '--h', min: 120, max: 800, step: 10, def: 300 }, t.embed || {});
  t.background = t.background || {};
  // html кнопки палитры обязан распознаваться как свой же вид (порядок kinds); иначе панель свойств будет не та
  t.warnings = [];
  for (const b of t.blocks) {
    const tpl = document.createElement('template'); tpl.innerHTML = (b.html || '').replace(/\{img\}/g, 'x').trim();
    const root = tpl.content.firstElementChild; if (!root) { t.warnings.push(`блок «${b.id}»: пустой html`); continue; }
    const k = kindOf(root, t); if (k !== b.kind) t.warnings.push(`блок «${b.id}»: html распознаётся как ${k}, а не ${b.kind}`);
  }
  if (!t.text.palette.length) t.warnings.push('в теме нет палитры текста (text.palette): цвет фрагментов недоступен, чужие span.c-* будут сняты');
  return t;
}
function kindOf(el, t = THEME) {
  for (const k of t.kinds) { try { if (k.match === '*' || el.matches(k.match)) return k.kind; } catch (e) { /* плохой селектор — мимо */ } }
  return 'block';
}
function kind(el) { return kindOf(el); }
function spec(k) { return THEME.kinds.find(x => x.kind === k) || THEME.kinds[THEME.kinds.length - 1]; }
const specOf = el => spec(kind(el));
const isTextField = el => !!specOf(el).overlap;                 // правило 1 — только у видов с overlap
const isGhost = el => specOf(el).layer === 'ghosts';
const isBottom = el => !!specOf(el).bottom;
function fxFor(k) { return THEME.effects.filter(f => f.kinds.includes(k)); }
function imgRe(type) { const p = THEME.images[type]; return p && p.match ? new RegExp(p.match) : null; }
function pickImage(type) { const re = imgRe(type); return re ? state.images.find(n => re.test(n) && !/^(cursor|hand)/.test(n)) : null; }
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function keepSpanRe() {                                           // разрешённые span: цвета палитры + keep_span темы
  const parts = []; if (THEME.text.palette.length) parts.push('c-(' + THEME.text.palette.map(escRe).join('|') + ')');
  parts.push(...THEME.text.keep_span.map(escRe));
  return parts.length ? new RegExp('^(' + parts.join('|') + ')$') : /^$/;
}
function colorOf(id) { const c = THEME.colors.find(c => c.id === id); return c ? c.value : '#888'; }
// блок палитры по id кнопки или по типу картинки (библиотека/загрузка передают тип: pic, cutout, stamp, ghost)
function blockFor(id) { return THEME.blocks.find(b => b.id === id) || THEME.blocks.find(b => b.pick === id); }
function blockHtml(b, img) { return b.html.replace(/\{img\}/g, img || '').trim(); }
// стили, которые тема просит для режима правки: спрятать экранные слои, заглушить анимации, свои правила
function themeEditCss() {
  const sels = THEME.screen.map(s => s.sel).filter(Boolean);
  return (sels.length ? sels.join(',') + '{display:none!important}\n' : '') +
    (THEME.edit.silence.length ? THEME.edit.silence.join(',') + '{animation:none!important}\n' : '') + (THEME.edit.css || '');
}
// кнопки «добавить блок», типы загрузки и цвета textbar — из манифеста
function buildPalette() {
  const H = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const add = document.getElementById('palette-add');
  add.innerHTML = THEME.blocks.map(b => `<button data-add="${b.id}" title="${H(b.kind)}">${H(L(b.label))}</button>`).join('');
  const up = document.getElementById('uptype'), cur = up.value;
  up.innerHTML = Object.entries(THEME.images).filter(([, p]) => p.upload).map(([t, p]) => `<option value="${t}">${H(L(p.label) || t)}</option>`).join('');
  if ([...up.options].some(o => o.value === cur)) up.value = cur;
  const sw = document.querySelector('#textbar .sw');
  sw.innerHTML = THEME.text.palette.map(id => `<button data-color="${id}" title="${H(L((THEME.colors.find(c => c.id === id) || {}).label) || id)}" style="background:${colorOf(id)}"></button>`).join('') +
    '<button data-color="" title="без цвета">∅</button>';
  sw.hidden = !THEME.text.palette.length;
  updateSingles();
}
// вид single (подвал, слот названия): кнопка «добавить» недоступна, если такой блок уже есть
function updateSingles() {
  if (!THEME || typeof stage === 'undefined' || !stage) return;
  document.querySelectorAll('#palette-add [data-add]').forEach(b => {
    const def = blockFor(b.dataset.add); const s = def && spec(def.kind);
    b.disabled = !!(s && s.single && [...stage.children].some(el => !el.dataset.ed && kind(el) === def.kind));
  });
}
