/* Редактор коллажа. Холст = страница в iframe с настоящими style.css + layout.css.
   Пишет ТОЛЬКО: --x --y --w (px, афиша) --m (порядок в колонке) --tilt --delay, классы reveal, glitch, fx-…,
   fade, dev, hide-m, hide-d, shared; у призраков --x --y --w --o (%); проявку (--blend --op --gray --sepia
   --hue --con --blur --inv --flip), текст, src/alt картинок, порядок в DOM (= слои). Сохранение заменяет
   внутренности .stage и .ghosts текущей страницы. Ширина афиши/телефона — /api/settings → layout.css. */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const ifr = $('#page'), statusEl = $('#status'), propsEl = $('#props'), canvas = $('#canvas');
let win, doc, page, stage, ghosts, overlay, selbox;
let sel = null;                       // выбранный элемент (блок сетки или призрак)
let state = { images: [], backgrounds: [], background: null };
const hist = { undo: [], redo: [] };
let settings = { poster: 1400, phone: 400, screen: 1920, screenh: 1080 };   // с сервера (tools/site.json)
let zoom = Math.min(3, Math.max(.1, parseFloat(localStorage.getItem('ed-zoom')) || 1));   // масштаб стола
const sheet = $('#sheet');
let magnet = true;                              // шаг 8 px + направляющие к соседям; Shift отключает
const STEP = 8, SNAP = 6, GAPMIN = 8;           // шаг магнита, радиус прилипания, запас между текстовыми полями (с каждой стороны; 16 = промежуток старой сетки)
const FULLW = ['ticker', 'masthead', 'footer']; // всегда во всю ширину: --x/--w не пишутся
const PIXELW = ['cutout', 'stamp'];             // --w = ширина файла, при масштабировании не трогается

const TEXTLESS = ['pic', 'cutout', 'stamp', 'ghost', 'masthead', 'embed'];   // dblclick правит только подпись
// проявка: переменные блока (см. .dev в style.css); значение по умолчанию не пишется в HTML
const DEV = {
  op:    { label: 'прозрачность', min: 0, max: 1, step: .05, unit: '', def: 1 },
  gray:  { label: 'обесцветить', min: 0, max: 1, step: .05, unit: '', def: 0 },
  sepia: { label: 'сепия', min: 0, max: 1, step: .05, unit: '', def: 0 },
  hue:   { label: 'сдвиг тона, °', min: 0, max: 360, step: 5, unit: 'deg', def: 0 },
  con:   { label: 'контраст', min: .5, max: 2, step: .05, unit: '', def: 1 },
  blur:  { label: 'размытие, px', min: 0, max: 6, step: .5, unit: 'px', def: 0 },
};
const BLENDS = [['normal', 'обычное'], ['screen', 'screen — растворить тёмное'], ['multiply', 'multiply — вжечь в фон'], ['overlay', 'overlay — проявка'],
  ['soft-light', 'soft-light — мягкая проявка'], ['luminosity', 'luminosity — в тон фона'], ['difference', 'difference — негатив']];
const TILTABLE = ['pic', 'cutout', 'scrawl', 'stamp'];
// эффекты по типам блока: статичные (см. .fx-* в style.css), наведение, живые (слоты анимаций).
// where: 'frame' — класс ставится на .frame внутри фото. float для .pic не предлагается: рамка режет.
const FX = [
  { cls: 'fx-stretch', label: 'stretch — растяжение', kinds: ['pic', 'cutout', 'stamp'] },
  { cls: 'fx-channel', label: 'channel — смена каналов', kinds: ['pic', 'cutout', 'stamp', 'ghost'] },
  { cls: 'fx-crt', label: 'crt — расщепление', kinds: ['pic', 'cutout', 'stamp', 'ghost'] },
  { cls: 'fx-dither', label: 'dither — сетка', kinds: ['pic'], where: 'frame' },
  { cls: 'glitch', label: 'glitch при наведении', kinds: ['pic'], where: 'frame' },
  { cls: 'glitch', label: 'glitch при наведении', kinds: ['cutout', 'stamp'] },
  { cls: 'fade', label: 'растворение книзу', kinds: ['cutout'] },
  { cls: 'fx-float', label: 'покачивание', kinds: ['cutout', 'stamp', 'ghost'] },
  { cls: 'fx-flicker', label: 'мерцание', kinds: ['pic', 'cutout', 'stamp', 'ghost'] },
  { cls: 'fx-shake', label: 'дрожь (время от времени)', kinds: ['pic', 'cutout', 'stamp', 'ghost'] },
  { cls: 'fx-glitch', label: 'глитч сам по себе', kinds: ['pic', 'cutout', 'stamp', 'ghost'] },
];

/* ── статус и API ───────────────────────────────────────────────────── */
function say(msg, err) { statusEl.textContent = msg; statusEl.classList.toggle('err', !!err); }
let PAGE = 'index';                    // slug текущей страницы (<slug>.html)
// все запросы к серверу идут здесь: заголовок X-Editor обязателен для POST (защита от чужих вкладок)
async function api(path, opts = {}) {
  const headers = Object.assign({ 'X-Editor': '1' }, opts.headers || {});
  const sep = path.includes('?') ? '&' : '?';
  const r = await fetch(path + (opts.nopage ? '' : sep + 'page=' + PAGE), Object.assign({}, opts, { headers }));
  return r.json();
}

/* ── загрузка страницы ──────────────────────────────────────────────── */
ifr.addEventListener('load', async () => {
  win = ifr.contentWindow; doc = win.document;
  page = doc.querySelector('.page'); stage = doc.querySelector('.stage'); ghosts = doc.querySelector('.ghosts');
  if (!stage || !page) return say('в index.html нет .stage / .page', true);
  if (!ghosts) { ghosts = doc.createElement('div'); ghosts.className = 'ghosts'; ghosts.setAttribute('aria-hidden', 'true'); page.prepend(ghosts); }
  injectStyle();
  try { doc.execCommand('defaultParagraphSeparator', false, 'p'); } catch (e) {}
  overlay = doc.createElement('div'); overlay.className = 'ed-overlay'; overlay.dataset.ed = '1'; page.appendChild(overlay);
  selbox = doc.createElement('div'); selbox.className = 'ed-selbox'; selbox.dataset.ed = '1'; selbox.hidden = true; page.appendChild(selbox);
  bindCanvas();
  doc.documentElement.classList.add(isPhone() ? 'ed-phone' : 'ed-desk');
  refresh();                          // лист и пометки сразу, с настройками по умолчанию; после ответа сервера — ещё раз
  if (localStorage.getItem('ed-zoom') === null) zoomFit();   // первый запуск: вся страница на столе
  await loadState();
  normalizeOrder();
  refresh(); select(null);
  say('готово');
});
const isPhone = () => canvas.classList.contains('phone');

function injectStyle() {
  const s = doc.createElement('style'); s.dataset.ed = '1';
  s.textContent = `
    .grain,.scanlines,.tracking,.vignette{display:none!important}
    .bg{position:absolute!important;inset:0;background-size:100% auto!important;background-repeat:repeat-y!important;background-position:center top!important}
    .ed-margin{position:absolute;top:0;bottom:0;background:rgba(0,0,0,.32);pointer-events:none;z-index:1}
    .ed-margin.l{left:0;border-right:1px dashed rgba(232,223,201,.55)} .ed-margin.r{right:0;border-left:1px dashed rgba(232,223,201,.55)}
    .ed-fold{position:absolute;left:0;right:0;border-top:1px dashed rgba(155,58,42,.75);pointer-events:none;z-index:1}
    .ed-fold i,.ed-label{position:absolute;font:11px/1 monospace;font-style:normal;color:#e8dfc9;background:rgba(11,20,16,.85);padding:2px 6px;pointer-events:none}
    .ed-fold i{right:8px;top:-17px} .ed-label{left:0;top:4px;z-index:1}
    .reveal,.ticker span,.blink{animation:none!important}
    .ticker span{padding-left:0!important}
    .stage{pointer-events:none} .stage>*{pointer-events:auto;cursor:move}
    .ghosts{pointer-events:none;overflow:visible} .ghost{pointer-events:auto;cursor:move}
    .ghost img{pointer-events:none}
    .page{zoom:1!important}
    .ed-overlay{position:absolute;pointer-events:none;overflow:visible}
    .ed-guide{position:absolute;background:rgba(155,58,42,.85)}
    .ed-guide.v{top:-40px;bottom:-40px;width:1px} .ed-guide.h{left:-40px;right:-40px;height:1px}
    html.ed-phone .stage>*{cursor:grab}
    html.ed-desk .hide-d,html.ed-phone .hide-m{display:block!important;opacity:.35!important;outline:2px dashed #9b3a2a;outline-offset:2px}
    html.ed-desk .buttons.hide-d,html.ed-phone .buttons.hide-m{display:flex!important}
    .ed-hover{outline:1px dashed rgba(232,223,201,.7)!important;outline-offset:2px}
    .ed-selbox{position:absolute;pointer-events:none;outline:2px solid #e8dfc9;outline-offset:2px;box-shadow:0 0 0 5px rgba(155,58,42,.55)}
    .ed-bad{outline:2px solid #9b3a2a!important;outline-offset:2px}
    [contenteditable="true"]{outline:1px solid #9b3a2a!important;cursor:text!important}
    a{pointer-events:none}
    .embed iframe{pointer-events:none}
  `;
  doc.head.appendChild(s);
}

async function loadState() {
  try {
    state = await api('/api/state');
    if (state.settings) settings = state.settings;
    applyCanvas();
    const bg = $('#bg'); bg.innerHTML = state.backgrounds.map(b => `<option value="${b}" ${b === state.background ? 'selected' : ''}>${b}</option>`).join('');
    $('#pages').innerHTML = (state.pages || ['index']).map(pg => `<option value="${pg}" ${pg === PAGE ? 'selected' : ''}>${pg}.html</option>`).join('');
  } catch (e) { say('сервер недоступен: запусти tools/edit.sh', true); }
}

/* ── геометрия афиши ────────────────────────────────────────────────── */
// холст = iframe шириной poster+16: медиазапросы считают ширину вместе с полосой прокрутки,
// иначе layout.css включил бы ступень zoom прямо в редакторе
function applyCanvas() { layoutSheet(); }
// лист: ширина = экран посетителя (не уже афиши + 16 — иначе layout.css включил бы ступень zoom), высота = вся страница
function layoutSheet() {
  const W = isPhone() ? settings.phone : Math.max(settings.screen, settings.poster + 16);
  const H = Math.max(page ? page.offsetTop + page.offsetHeight : 0, isPhone() ? 700 : settings.screenh);
  ifr.style.width = W + 'px'; ifr.style.height = H + 'px'; ifr.style.transform = `scale(${zoom})`;
  sheet.style.width = Math.round(W * zoom) + 'px'; sheet.style.height = Math.round(H * zoom) + 'px';
  $('#zoom100').textContent = Math.round(zoom * 100) + '%';
}
// пометки посетительского вида: поля вне афиши затемнены, подпись ширины, пунктир «первый экран»
function drawMarks() {
  let L = doc.querySelector('.ed-margin.l');
  if (!L) {
    const mk = (cls, parent, html = '') => { const d = doc.createElement('div'); d.className = cls; d.dataset.ed = '1'; d.innerHTML = html; parent.appendChild(d); return d; };
    L = mk('ed-margin l', doc.body); mk('ed-margin r', doc.body); mk('ed-fold', doc.body, '<i></i>'); mk('ed-label', page);
  }
  const R = doc.querySelector('.ed-margin.r'), F = doc.querySelector('.ed-fold'), lab = doc.querySelector('.ed-label'), phone = isPhone();
  const ml = page.offsetLeft, mr = doc.documentElement.clientWidth - ml - page.offsetWidth;
  L.hidden = R.hidden = F.hidden = phone;
  L.style.width = ml + 'px'; R.style.width = mr + 'px'; F.style.top = settings.screenh + 'px';
  F.querySelector('i').textContent = `первый экран · ${settings.screen}×${settings.screenh}`;
  lab.textContent = phone ? `колонка ${settings.phone} px` : `афиша ${settings.poster} px · поля по ${ml} px`;
}
// зум стола: transform на iframe; события внутри него приходят уже в его координатах
function setZoom(z, anchor) {
  z = Math.min(3, Math.max(.1, z));
  const cr = canvas.getBoundingClientRect();
  const ax = anchor ? anchor.cx - cr.left : canvas.clientWidth / 2, ay = anchor ? anchor.cy - cr.top : canvas.clientHeight / 2;
  const px = (canvas.scrollLeft + ax - sheet.offsetLeft) / zoom, py = (canvas.scrollTop + ay - sheet.offsetTop) / zoom;   // точка листа под якорем
  zoom = z; localStorage.setItem('ed-zoom', zoom); layoutSheet();
  canvas.scrollLeft = px * zoom + sheet.offsetLeft - ax; canvas.scrollTop = py * zoom + sheet.offsetTop - ay;
  placeTextbar();
}
function zoomFit() {
  const W = parseFloat(ifr.style.width) || settings.screen, H = parseFloat(ifr.style.height) || settings.screenh;
  // offset*, а не client*: пока лист велик, полосы прокрутки съедают client-размер и вписывание выходит с лишним запасом
  setZoom(Math.min((canvas.offsetWidth - 80) / W, (canvas.offsetHeight - 80) / H, 1)); canvas.scrollTop = 0;
}
// стол двигается пробелом+мышью или средней кнопкой (screenX/Y — общие для окна и iframe)
let pan = null, spaceDown = false;
function startPan(e) { pan = { sx: e.screenX, sy: e.screenY, sl: canvas.scrollLeft, st: canvas.scrollTop }; canvas.classList.add('panning'); e.preventDefault(); }
function movePan(e) { if (!pan) return; canvas.scrollLeft = pan.sl - (e.screenX - pan.sx); canvas.scrollTop = pan.st - (e.screenY - pan.sy); }
function endPan() { if (pan) { pan = null; canvas.classList.remove('panning'); } }
function onWheel(e) {               // Ctrl+колесо — зум к курсору; из iframe координаты переводятся в окно редактора
  if (!e.ctrlKey) return; e.preventDefault();
  let cx = e.clientX, cy = e.clientY;
  if (e.target.ownerDocument !== document) { const fr = ifr.getBoundingClientRect(); cx = fr.left + e.clientX * zoom; cy = fr.top + e.clientY * zoom; }   // событие из листа
  setZoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), { cx, cy });
}
function spaceKeys(e) {
  if (e.code !== 'Space' || editing || e.target.matches && e.target.matches('input,select,textarea,button')) return;
  spaceDown = e.type === 'keydown'; canvas.classList.toggle('pan', spaceDown); e.preventDefault();
}
canvas.addEventListener('mousedown', e => { if (e.button === 1 || (e.button === 0 && spaceDown)) startPan(e); });
canvas.addEventListener('wheel', onWheel, { passive: false });
document.addEventListener('mousemove', movePan); document.addEventListener('mouseup', endPan);
document.addEventListener('keydown', spaceKeys); document.addEventListener('keyup', spaceKeys);
canvas.addEventListener('scroll', () => placeTextbar());
$('#zoomin').addEventListener('click', () => setZoom(zoom * 1.25)); $('#zoomout').addEventListener('click', () => setZoom(zoom / 1.25));
$('#zoom100').addEventListener('click', () => setZoom(1)); $('#zoomfit').addEventListener('click', zoomFit);
// панели сворачиваются, состояние помнится
for (const [id, cls] of [['toggleL', 'no-left'], ['toggleR', 'no-right']]) {
  const b = $('#' + id), on = localStorage.getItem('ed-' + cls) === '1';
  document.body.classList.toggle(cls, on); b.classList.toggle('on', !on);
  b.addEventListener('click', () => { const v = document.body.classList.toggle(cls); b.classList.toggle('on', !v); localStorage.setItem('ed-' + cls, v ? '1' : '0'); });
}
const numv = (el, n) => { const v = parseFloat(el.style.getPropertyValue('--' + n)); return isNaN(v) ? null : v; };
function placement(el) {            // из инлайн-переменных, иначе из геометрии (offset* без transform)
  const x = numv(el, 'x'), y = numv(el, 'y'), w = numv(el, 'w');
  return { x: x ?? el.offsetLeft, y: y ?? el.offsetTop, w: w ?? el.offsetWidth };
}
function setPlacement(el, p) {
  const k = kind(el);
  if (k !== 'footer') el.style.setProperty('--y', Math.round(p.y) + 'px');
  if (!FULLW.includes(k)) { el.style.setProperty('--x', Math.round(p.x) + 'px'); el.style.setProperty('--w', Math.round(p.w) + 'px'); }
}
const stageW = () => stage.clientWidth;
const blocks = () => [...stage.children].filter(el => !el.dataset.ed);
const shown = el => !el.classList.contains(isPhone() ? 'hide-m' : 'hide-d');
// порядок в колонке: --m у всех, без дыр и повторов (сортировка по (--m, место в DOM))
function normalizeOrder() {
  const els = blocks(), ms = els.map(el => numv(el, 'm'));
  const ok = ms.every(m => m !== null) && new Set(ms).size === ms.length;
  if (ok) return;
  els.map((el, i) => [el, ms[i] ?? i + .5]).sort((a, b) => a[1] - b[1]).forEach(([el], i) => el.style.setProperty('--m', i));
}
const byOrder = () => blocks().sort((a, b) => (numv(a, 'm') ?? 0) - (numv(b, 'm') ?? 0));
const maxOrder = () => blocks().reduce((m, el) => Math.max(m, numv(el, 'm') ?? -1), -1);

// магнит: прилипание к краям/центрам соседей и холста в пределах SNAP, иначе шаг STEP
function magnetize(el, p) {
  const W = stageW(), lines = { x: [0, W, W / 2], y: [0] }, guides = [];
  for (const o of blocks()) {
    if (o === el || kind(o) === 'footer' || !shown(o)) continue;
    const q = placement(o), h = o.offsetHeight;
    if (!FULLW.includes(kind(o))) lines.x.push(q.x, q.x + q.w, q.x + q.w / 2);
    lines.y.push(q.y, q.y + h, q.y + h / 2);
  }
  const h = el.offsetHeight, r = { ...p };
  const fit = (axis, pos, size) => {
    let best = null;
    for (const L of lines[axis]) for (const [off, tag] of [[0, 'a'], [size, 'b'], [size / 2, 'c']]) {
      const d = L - (pos + off); if (Math.abs(d) <= SNAP && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, L };
    }
    if (best) { guides.push({ axis, pos: best.L }); return pos + best.d; }
    return Math.round(pos / STEP) * STEP;
  };
  r.x = fit('x', p.x, p.w); r.y = fit('y', p.y, h);
  return { p: r, guides };
}
function drawGuides(guides) {
  overlay.innerHTML = guides.map(g => g.axis === 'x' ? `<div class="ed-guide v" style="left:${g.pos}px"></div>` : `<div class="ed-guide h" style="top:${g.pos}px"></div>`).join('');
}

function kind(el) {
  const c = el.classList;
  for (const k of ['ghost', 'pic', 'embed', 'cutout', 'scrawl', 'stamp', 'ticker', 'trails', 'buttons', 'masthead']) if (c.contains(k)) return k;
  if (el.tagName === 'FOOTER') return 'footer';
  if (c.contains('field')) return 'field';
  return 'block';
}
const isTextField = el => el.classList.contains('field') && !el.classList.contains('pic') && !el.classList.contains('embed');

/* правило 1: текстовые поля не перекрываются. Считается по реальным прямоугольникам
   (getBoundingClientRect — с учётом высоты текста), каждый расширен на GAPMIN. Только на афише. */
const rectOf = el => { const r = el.getBoundingClientRect(); return { l: r.left - GAPMIN, t: r.top - GAPMIN, r: r.right + GAPMIN, b: r.bottom + GAPMIN }; };
function textFieldsOverlap(a, b) { return a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b; }
function overlaps() {                // все блоки, участвующие хоть в одной паре наложения
  if (isPhone()) return [];
  const fs = blocks().filter(el => isTextField(el) && shown(el)), rs = fs.map(rectOf), bad = new Set();
  for (let i = 0; i < fs.length; i++) for (let j = i + 1; j < fs.length; j++) if (textFieldsOverlap(rs[i], rs[j])) { bad.add(fs[i]); bad.add(fs[j]); }
  return [...bad];
}
function collides(el, p) {           // примерить p к el: true, если el ляжет на другое текстовое поле
  if (!isTextField(el) || isPhone()) return false;
  const was = { x: el.style.getPropertyValue('--x'), y: el.style.getPropertyValue('--y'), w: el.style.getPropertyValue('--w') };
  setPlacement(el, p); const hit = overlaps().includes(el);
  for (const n of ['x', 'y', 'w']) was[n] ? el.style.setProperty('--' + n, was[n]) : el.style.removeProperty('--' + n);
  return hit;
}
const blockName = el => el.id ? '#' + el.id : kind(el) + ' «' + (el.textContent.trim().slice(0, 24) || '…') + '»';

/* ── оверлей и подвал ───────────────────────────────────────────────── */
function refresh() {
  Object.assign(overlay.style, { left: stage.offsetLeft + 'px', top: stage.offsetTop + 'px', width: stageW() + 'px', height: stage.offsetHeight + 'px' });
  fixFooter(); layoutSheet(); drawMarks();
  stage.querySelectorAll('.ed-bad').forEach(n => n.classList.remove('ed-bad'));
  const ov = overlaps(); ov.forEach(el => el.classList.add('ed-bad'));
  if (ov.length) say('перекрываются текстовые поля: ' + ov.map(blockName).join(', ') + ' — сохранить нельзя', true);
  drawSel();
}
function fixFooter() {              // подвал ниже всего: его --y (margin-top) задаёт высоту холста
  const f = stage.querySelector(':scope > footer'); if (!f || isPhone()) return;
  let max = 0; blocks().forEach(el => { if (el !== f && shown(el)) max = Math.max(max, placement(el).y + el.offsetHeight); });
  f.style.setProperty('--y', Math.round(max + 24) + 'px'); f.style.removeProperty('--x'); f.style.removeProperty('--w');
}

/* ── история ────────────────────────────────────────────────────────── */
function snap() { return { s: stage.innerHTML, g: ghosts.innerHTML }; }
function push() { hist.undo.push(snap()); if (hist.undo.length > 50) hist.undo.shift(); hist.redo.length = 0; }
function restore(x) { stage.innerHTML = x.s; ghosts.innerHTML = x.g; select(null); refresh(); }
function undo() { if (!hist.undo.length) return; hist.redo.push(snap()); restore(hist.undo.pop()); say('отменено'); }
function redo() { if (!hist.redo.length) return; hist.undo.push(snap()); restore(hist.redo.pop()); say('повторено'); }

/* ── выделение и панель свойств ─────────────────────────────────────── */
function select(el) {
  if (editing && el !== editing && !(el && el.contains(editing))) endEdit();
  doc.querySelectorAll('.ed-sel').forEach(n => n.classList.remove('ed-sel'));
  sel = el; if (el) el.classList.add('ed-sel');
  drawSel(); renderProps();
}
function drawSel() {                // рамка рисуется отдельным слоем: на blur/multiply outline самого блока не видно
  if (!selbox) return;
  if (!sel || !sel.isConnected) { selbox.hidden = true; return; }
  const r = sel.getBoundingClientRect(), pr = page.getBoundingClientRect();
  Object.assign(selbox.style, { left: r.left - pr.left + 'px', top: r.top - pr.top + 'px', width: r.width + 'px', height: r.height + 'px' });
  selbox.hidden = false;
}
function renderProps() {
  if (!sel) { propsEl.innerHTML = '<p class="hint">Выбери блок на странице.</p>'; return; }
  const k = kind(sel), rows = [];
  const H = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const num = (v) => parseFloat(v) || 0;
  const cssv = n => sel.style.getPropertyValue(n).trim();
  rows.push(`<p class="type">${{ field: 'поле с текстом', pic: 'фото в рамке', embed: 'встраивание', cutout: 'вырезка', scrawl: 'свободный текст', stamp: 'штамп', ghost: 'призрак', ticker: 'бегущая строка', trails: 'оглавление', buttons: 'кнопки 88×31', masthead: 'слот названия', footer: 'подвал', block: 'блок' }[k]}</p>`);

  if (k === 'ghost') {
    const g = { x: num(cssv('--x')) || (cssv('--rx') ? 100 - num(cssv('--rx')) - num(cssv('--w') || '40') : 55), y: num(cssv('--y')), w: num(cssv('--w') || '40'), o: num(cssv('--o') || '.8') };
    rows.push(range('x', 'слева, %', g.x, -30, 100, 1), range('y', 'сверху, %', g.y, -10, 100, 1), range('w', 'ширина, %', g.w, 10, 80, 1), range('o', 'прозрачность', g.o, .1, 1, .05));
    rows.push(imgSelect(sel.querySelector('img'), /^ghost-/));
  } else {
    const p = placement(sel);
    if (k !== 'footer') {
      const pos = FULLW.includes(k) ? '' : `<input type="number" data-p="x" value="${Math.round(p.x)}" title="x"> <input type="number" data-p="y" value="${Math.round(p.y)}" title="y"> <input type="number" data-p="w" min="40" value="${Math.round(p.w)}" title="ширина">`;
      rows.push(`<div class="row"><label>x · y · ширина</label><div class="pair">${pos || `<input type="number" data-p="y" value="${Math.round(p.y)}" title="y"> <span class="val">во всю ширину</span>`}</div></div>`);
      rows.push(`<div class="actions"><button data-act="layer-up" title="позже в DOM = поверх">слой выше</button><button data-act="layer-down">слой ниже</button></div>`);
    }
    if (TILTABLE.includes(k)) rows.push(range('tilt', 'наклон, °', num(cssv('--tilt')), -8, 8, .5));
    if (k === 'pic') {
      const ar = cssv('--ar') || '3 / 2';
      rows.push(`<div class="row"><label>пропорции</label><select data-ar>${['3 / 2', '4 / 3', '1 / 1', '2 / 3', '16 / 9'].map(a => `<option ${a === ar ? 'selected' : ''}>${a}</option>`).join('')}</select></div>`);
    }
    const fx = FX.filter(f => f.kinds.includes(k));
    if (fx.length) rows.push(`<div class="checks"><h3>эффекты</h3>${fx.map(f => chk(f.where === 'frame' ? sel.querySelector('.frame') : sel, f.cls, f.label, f.where)).join('')}</div>`);
    if (k === 'embed') {
      const fr = sel.querySelector('iframe');
      rows.push(`<div class="row"><label>код embed или ссылка</label><textarea data-embed rows="3" placeholder="вставь &lt;iframe …&gt; или https://…">${H(fr ? fr.getAttribute('src') || '' : '')}</textarea></div>`, range('h', 'высота, px', num(cssv('--h')) || 300, 120, 800, 10));
    }
    if (k === 'pic' || k === 'cutout' || k === 'stamp') rows.push(imgSelect(sel.querySelector('img'), k === 'cutout' ? /\.png$/ : k === 'stamp' ? /\.(gif|png)$/ : /\.(jpg|jpeg|png|webp)$/));
    if (k === 'cutout') rows.push(`<div class="actions"><button data-act="crop">настроить вырезку…</button><button data-act="reroll">другой край (seed+1)</button></div>`);
    if (k === 'field' || k === 'scrawl') rows.push(`<div class="row"><label>выравнивание</label><select data-align>${[['', 'слева'], ['center', 'по центру'], ['end', 'справа']].map(([v, l]) => `<option value="${v}" ${v === cssv('--align') ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`);
    if (k === 'scrawl') rows.push(range('fs', 'размер, px', num(cssv('--fs')) || { quote: 30, note: 19, meta: 15 }[['quote', 'note', 'meta'].find(r => sel.classList.contains(r))] || 19, 12, 64, 1), range('ls', 'разрядка, em', num(cssv('--ls')) || 0, 0, .4, .02));
    if (k === 'scrawl') rows.push(`<div class="row"><label>роль</label><select data-role>${['quote', 'note', 'meta'].map(r => `<option value="${r}" ${sel.classList.contains(r) ? 'selected' : ''}>${{ quote: 'цитата', note: 'заметка', meta: 'служебное' }[r]}</option>`).join('')}</select></div>`);
    if (k !== 'footer' && k !== 'masthead') rows.push(`<div class="checks"><h3>появление</h3>${chk(sel, 'reveal', 'проявляется из тумана')}</div>` + range('delay', 'задержка, с', num(cssv('--delay')), 0, 1.5, .05));
  }
  if (k === 'ghost') rows.push(`<div class="checks"><h3>эффекты</h3>${FX.filter(f => f.kinds.includes('ghost')).map(f => chk(sel, f.cls, f.label)).join('')}</div>`);
  if (k !== 'ghost' && k !== 'footer') {
    rows.push(`<div class="checks"><h3>колонка (телефон)</h3><label><input type="checkbox" data-cls="hide-m" data-where=""${sel.classList.contains('hide-m') ? ' checked' : ''}> не показывать в колонке</label><label><input type="checkbox" data-cls="hide-d" data-where=""${sel.classList.contains('hide-d') ? ' checked' : ''}> не показывать на афише</label></div>
      <div class="actions"><button data-act="m-up">↑ раньше в колонке</button><button data-act="m-down">↓ позже</button></div>`);
  }
  if (k !== 'footer' && k !== 'masthead') {
    // проявка: режимы наложения (для текста — только мягкие, остальные гасят текст на тёмном фоне)
    const textual = ['field', 'scrawl', 'ticker', 'trails', 'buttons', 'block'].includes(k);
    const modes = textual ? BLENDS.filter(b => ['normal', 'overlay', 'soft-light'].includes(b[0])) : BLENDS;
    const cur = cssv('--blend') || (k === 'ghost' ? 'screen' : 'normal');
    rows.push(`<div class="checks"><h3>проявка</h3></div><div class="row"><label>наложение</label><select data-blend>${modes.map(([v, l]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`);
    for (const [n, d] of Object.entries(DEV)) { if (n === 'op' && k === 'ghost') continue; rows.push(range(n, d.label, cssv('--' + n) ? num(cssv('--' + n)) : d.def, d.min, d.max, d.step)); }
    rows.push(`<div class="checks"><label><input type="checkbox" data-dev="inv" ${cssv('--inv') === '1' ? 'checked' : ''}> инверсия</label>${['pic', 'cutout', 'stamp'].includes(k) ? `<label><input type="checkbox" data-dev="flip" ${cssv('--flip') === '-1' ? 'checked' : ''}> зеркально</label>` : ''}</div><div class="actions"><button data-act="devreset">сбросить проявку</button></div>`);
  }
  if (!TEXTLESS.includes(k) && k !== 'footer') rows.push('<p class="hint">Текст: двойной клик по блоку на странице.</p>');
  if (k !== 'ghost') rows.push(`<div class="checks"><label><input type="checkbox" data-shared ${sel.classList.contains('shared') ? 'checked' : ''}> общий для всех страниц${sel.id ? ` <code>#${sel.id}</code>` : ''}</label></div>`);
  rows.push(`<div class="actions"><button data-act="dup">дублировать</button><button data-act="del" class="danger">удалить</button></div>`);
  propsEl.innerHTML = rows.join('');
  bindProps();

  function range(n, label, v, min, max, step) { return `<div class="row"><label>${label}</label><div class="pair"><input type="range" data-v="${n}" min="${min}" max="${max}" step="${step}" value="${v}"><span class="val">${v}</span></div></div>`; }
  function chk(el, cls, label, where) { return `<label><input type="checkbox" data-cls="${cls}" data-where="${where || ''}" ${el && el.classList.contains(cls) ? 'checked' : ''}> ${label}</label>`; }
  function imgSelect(img, re) {
    const cur = img ? img.getAttribute('src').replace(/^img\//, '') : '';
    const list = state.images.filter(n => re.test(n));
    return `<div class="row"><label>картинка</label><select data-img>${list.map(n => `<option ${n === cur ? 'selected' : ''}>${n}</option>`).join('')}${list.includes(cur) ? '' : `<option selected>${H(cur)}</option>`}</select></div>
      <div class="row"><label>alt</label><input type="text" data-alt value="${H(img ? img.alt : '')}"></div>`;
  }
}
function bindProps() {
  const unit = { tilt: 'deg', w: '%', delay: 's', x: '%', y: '%', o: '', fs: 'px', ls: 'em', h: 'px' };   // range-ползунки: x/y/w только у призрака (%)
  for (const [n, d] of Object.entries(DEV)) unit[n] = d.unit;
  propsEl.querySelectorAll('input[type=range]').forEach(inp => {
    inp.addEventListener('input', () => {
      inp.nextElementSibling.textContent = inp.value; const n = inp.dataset.v;
      if (DEV[n] && parseFloat(inp.value) === DEV[n].def) sel.style.removeProperty('--' + n); else sel.style.setProperty('--' + n, inp.value + unit[n]);
      if (n === 'x') sel.style.removeProperty('--rx'); if (DEV[n]) updateDev(sel); refresh();
    });
    inp.addEventListener('pointerdown', push, { once: false });
  });
  propsEl.querySelectorAll('input[data-p]').forEach(inp => inp.addEventListener('change', () => {
    const p = placement(sel); p[inp.dataset.p] = parseInt(inp.value, 10) || 0;
    p.w = Math.max(40, p.w); p.y = Math.max(0, p.y);
    if (collides(sel, p)) { bad(sel); renderProps(); return; }
    push(); setPlacement(sel, p); refresh(); renderProps();
  }));
  propsEl.querySelectorAll('input[data-cls]').forEach(inp => inp.addEventListener('change', () => {
    push(); const t = inp.dataset.where === 'frame' ? sel.querySelector('.frame') : sel; t.classList.toggle(inp.dataset.cls, inp.checked); refresh();
  }));
  const blend = propsEl.querySelector('[data-blend]'); if (blend) blend.addEventListener('change', () => { push(); const def = kind(sel) === 'ghost' ? 'screen' : 'normal'; if (blend.value === def) sel.style.removeProperty('--blend'); else sel.style.setProperty('--blend', blend.value); updateDev(sel); refresh(); });
  propsEl.querySelectorAll('input[data-dev]').forEach(inp => inp.addEventListener('change', () => { push(); const n = inp.dataset.dev; if (inp.checked) sel.style.setProperty('--' + n, n === 'flip' ? '-1' : '1'); else sel.style.removeProperty('--' + n); updateDev(sel); refresh(); }));
  const em = propsEl.querySelector('[data-embed]'); if (em) em.addEventListener('change', () => {
    const src = embedSrc(em.value.trim());
    if (!src) return say('не понял код: нужна ссылка или <iframe> с разрешённого сайта (см. embedSrc в editor.js)', true);
    push(); sel.querySelector('iframe').setAttribute('src', src); em.value = src; say('встроено: ' + src);
  });
  const sh = propsEl.querySelector('[data-shared]'); if (sh) sh.addEventListener('change', () => {
    push(); sel.classList.toggle('shared', sh.checked);
    // общий блок синхронизируется по id — без id он не найдётся на других страницах
    if (sh.checked && !sel.id) { let n = 1; while (doc.getElementById(`s-${kind(sel)}-${n}`)) n++; sel.id = `s-${kind(sel)}-${n}`; }
    renderProps();
  });
  const al = propsEl.querySelector('[data-align]'); if (al) al.addEventListener('change', () => { push(); if (al.value) sel.style.setProperty('--align', al.value); else sel.style.removeProperty('--align'); });
  const ar = propsEl.querySelector('[data-ar]'); if (ar) ar.addEventListener('change', () => { push(); sel.style.setProperty('--ar', ar.value); refresh(); });
  const role = propsEl.querySelector('[data-role]'); if (role) role.addEventListener('change', () => { push(); sel.classList.remove('quote', 'note', 'meta'); sel.classList.add(role.value); refresh(); });
  const img = propsEl.querySelector('[data-img]'); if (img) img.addEventListener('change', () => { push(); sel.querySelector('img').setAttribute('src', 'img/' + img.value); setTimeout(refresh, 150); });
  const alt = propsEl.querySelector('[data-alt]'); if (alt) alt.addEventListener('change', () => { push(); sel.querySelector('img').alt = alt.value; });
  propsEl.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => action(b.dataset.act)));
}
async function reroll(el) {
  // другой рисунок разрыва: сервер меняет seed в cutouts.txt и пересобирает PNG; картинка
  // перечитывается сбросом src (сервер шлёт no-store), без ?v= — он утёк бы в index.html
  const img = el.querySelector('img'); const name = (img.getAttribute('src') || '').replace(/^img\//, '').replace(/\.png$/, '');
  say('пересобираю край…');
  const r = await api('/api/reroll?name=' + encodeURIComponent(name), { method: 'POST' });
  if (r.error) return say('ошибка: ' + r.error, true);
  const src = img.getAttribute('src'); img.src = ''; img.src = src;
  say('seed ' + r.seed);
}
function action(a) {
  if (!sel) return;
  push();
  if (a === 'del') { const n = sel; select(null); n.remove(); }
  else if (a === 'dup') { const c = sel.cloneNode(true); c.classList.remove('ed-sel', 'ed-bad'); sel.after(c); if (kind(c) !== 'ghost') { const p = placement(c); p.x += 24; p.y += 24; setPlacement(c, p); c.style.setProperty('--m', maxOrder() + 1); } select(c); }
  else if (a === 'layer-up') { const n = sel.nextElementSibling; if (n && kind(n) !== 'footer' && !n.dataset.ed) n.after(sel); }   // позже в DOM = выше
  else if (a === 'layer-down' && sel.previousElementSibling) sel.previousElementSibling.before(sel);
  else if (a === 'm-up' || a === 'm-down') { const o = byOrder(), i = o.indexOf(sel), j = a === 'm-up' ? i - 1 : i + 1; if (o[j]) swapOrder(sel, o[j]); }
  else if (a === 'reroll') return reroll(sel);
  else if (a === 'crop') return cropModal((sel.querySelector('img').getAttribute('src') || '').replace(/^img\//, '').replace(/\.png$/, ''));
  else if (a === 'devreset') { [...Object.keys(DEV), 'blend', 'inv', 'flip'].forEach(n => sel.style.removeProperty('--' + n)); updateDev(sel); }
  refresh(); renderProps();
}
// .dev ставится, только если хоть одно значение проявки не дефолтное (иначе лишний stacking context)
function updateDev(el) {
  const vars = [...Object.keys(DEV), 'blend', 'inv', 'flip'];
  el.classList.toggle('dev', vars.some(n => el.style.getPropertyValue('--' + n).trim() !== ''));
}
function bad(el) { el.classList.add('ed-bad'); setTimeout(() => el.classList.remove('ed-bad'), 500); say('текстовые поля не могут перекрываться', true); }
function swapOrder(a, b) { const ma = numv(a, 'm') ?? 0, mb = numv(b, 'm') ?? 0; a.style.setProperty('--m', mb); b.style.setProperty('--m', ma); }

/* ── холст: выбор, перетаскивание, текст ────────────────────────────── */
function bindCanvas() {
  let drag = null;
  doc.addEventListener('mouseover', e => { const t = target(e); doc.querySelectorAll('.ed-hover').forEach(n => n.classList.remove('ed-hover')); if (t && t !== sel) t.classList.add('ed-hover'); });
  doc.addEventListener('mousedown', e => {
    if (e.button === 1 || (e.button === 0 && spaceDown)) { if (!editing) return startPan(e); }
    if (e.button !== 0) return;
    if (e.target.closest('[contenteditable="true"]')) return;
    if (editing) endEdit();
    const t = target(e); if (!t) { select(null); return; }
    e.preventDefault(); select(t);
    const k = kind(t);
    if (k === 'ghost') { if (isPhone()) return; drag = { el: t, ghost: true, sx: e.clientX, sy: e.clientY, x0: t.offsetLeft, y0: t.offsetTop, pushed: false }; return; }
    if (k === 'footer') return;
    if (isPhone()) { drag = { el: t, phone: true }; return; }     // в колонке тянем ради обмена --m
    const p = placement(t), r = t.getBoundingClientRect(), edge = 10;
    let mode = 'move';
    if (!FULLW.includes(k)) { if (e.clientX > r.right - edge) mode = 'e'; else if (e.clientX < r.left + edge) mode = 'w'; }
    drag = { el: t, mode, p0: p, sx: e.clientX, sy: e.clientY, pushed: false, last: '' };
  });
  doc.addEventListener('mousemove', e => {
    if (!drag || drag.phone) return;
    if (!drag.pushed) { push(); drag.pushed = true; }
    if (drag.ghost) {
      const nx = drag.x0 + (e.clientX - drag.sx), ny = drag.y0 + (e.clientY - drag.sy);
      drag.el.style.setProperty('--x', (nx / page.clientWidth * 100).toFixed(1) + '%'); drag.el.style.removeProperty('--rx');
      drag.el.style.setProperty('--y', (ny / page.clientHeight * 100).toFixed(1) + '%');
      return;
    }
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy; let p = { ...drag.p0 }, guides = [];
    if (drag.mode === 'move') {
      p.x += dx; p.y += dy;
      const raw = { ...p };
      if (magnet && !e.shiftKey) { ({ p, guides } = magnetize(drag.el, p)); if (collides(drag.el, p)) { p = raw; guides = []; } }   // прилипание не должно вгонять в соседа
      p.y = Math.max(0, p.y); p.x = Math.max(40 - p.w, Math.min(stageW() - 40, p.x));   // хотя бы 40 px блока остаются на холсте
    } else {
      const q = magnet && !e.shiftKey ? v => Math.round(v / STEP) * STEP : v => v;
      if (drag.mode === 'e') p.w = Math.max(60, q(p.w + dx));
      else { const x1 = Math.min(q(p.x + dx), p.x + p.w - 60); p.w = p.w + (p.x - x1); p.x = x1; }
    }
    const key = `${Math.round(p.x)}/${Math.round(p.y)}/${Math.round(p.w)}`; if (key === drag.last) return; drag.last = key;
    if (collides(drag.el, p)) { drag.el.classList.add('ed-bad'); return; }
    drag.el.classList.remove('ed-bad'); setPlacement(drag.el, p); refresh(); drawGuides(guides);
  });
  doc.addEventListener('mouseup', e => {
    if (!drag) return;
    if (drag.phone) {                 // отпустили над другим блоком → меняемся местами в колонке
      const over = target(e); if (over && over !== drag.el && kind(over) !== 'ghost' && kind(over) !== 'footer') { push(); swapOrder(drag.el, over); }
    }
    drag.el.classList.remove('ed-bad'); drag = null; overlay.innerHTML = ''; refresh(); renderProps();
  });
  doc.addEventListener('dblclick', e => {
    const t = target(e); if (!t || TEXTLESS.includes(kind(t)) || kind(t) === 'ghost') { const cap = e.target.closest('figcaption'); if (cap) edit(cap, e); return; }
    edit(kind(t) === 'ticker' ? t.querySelector('span') || t : t, e);
  });
  doc.addEventListener('keydown', keys); document.addEventListener('keydown', keys);
  doc.addEventListener('keydown', spaceKeys); doc.addEventListener('keyup', spaceKeys);
  doc.addEventListener('mousemove', movePan); doc.addEventListener('mouseup', endPan);
  doc.addEventListener('wheel', onWheel, { passive: false });
  doc.addEventListener('paste', e => { if (!editing) return; e.preventDefault(); doc.execCommand('insertText', false, (e.clipboardData || win.clipboardData).getData('text/plain')); });
  win.addEventListener('resize', placeTextbar);
  function target(e) { const g = e.target.closest('.ghost'); if (g) return g; const s = e.target.closest('.stage > *'); return s && !s.dataset.ed ? s : null; }
}
/* ── правка текста на месте ─────────────────────────────────────────── */
let editing = null;                    // элемент в режиме правки (contenteditable)
const textbar = $('#textbar'), linkform = $('#linkform'), linkurl = $('#linkurl');
let savedRange = null;
function edit(el, ev) {
  if (editing === el) return;
  if (editing) endEdit();
  push(); editing = el; el.setAttribute('contenteditable', 'true'); el.focus();
  // mousedown на холсте гасится ради перетаскивания, поэтому браузер сам курсор не ставит:
  // ставим его в точку двойного клика, иначе поле «в правке», а набор текста никуда не идёт
  const s = doc.getSelection(); let r = null;
  if (ev && doc.caretPositionFromPoint) { const c = doc.caretPositionFromPoint(ev.clientX, ev.clientY); if (c && el.contains(c.offsetNode)) { r = doc.createRange(); r.setStart(c.offsetNode, c.offset); r.collapse(true); } }
  else if (ev && doc.caretRangeFromPoint) { const c = doc.caretRangeFromPoint(ev.clientX, ev.clientY); if (c && el.contains(c.startContainer)) r = c; }
  if (!r) { r = doc.createRange(); r.selectNodeContents(el); r.collapse(false); }
  s.removeAllRanges(); s.addRange(r);
  textbar.querySelector('[data-cmd="list"]').disabled = !el.classList.contains('field');
  placeTextbar(); textbar.hidden = false;
}
// правка заканчивается явно (Esc, клик мимо, выбор другого блока, сохранение), не по blur:
// клики по панели текста и её поле URL уводят фокус, и blur закрыл бы правку раньше команды
function endEdit() {
  if (!editing) return;
  const el = editing; editing = null;
  el.removeAttribute('contenteditable'); normalize(el);
  textbar.hidden = true; linkform.hidden = true;
  refresh(); say('текст изменён');
}
function placeTextbar() {
  if (!editing) return;
  const r = editing.getBoundingClientRect(), fr = ifr.getBoundingClientRect();   // r — в координатах листа, fr — уже в масштабе
  textbar.style.left = Math.max(4, fr.left + r.left * zoom) + 'px';
  textbar.style.top = Math.max(48, fr.top + r.top * zoom - textbar.offsetHeight - 6) + 'px';
}
textbar.addEventListener('mousedown', e => { if (e.target === linkurl) { savedRange = currentRange(); return; } e.preventDefault(); });
function currentRange() { const s = doc.getSelection(); return s.rangeCount ? s.getRangeAt(0).cloneRange() : null; }
function restoreRange() { win.focus(); if (editing) editing.focus(); if (savedRange) { const s = doc.getSelection(); s.removeAllRanges(); s.addRange(savedRange); } }
textbar.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b || !editing) return;
  if (b.dataset.cmd === 'bold' || b.dataset.cmd === 'italic') doc.execCommand(b.dataset.cmd);
  else if (b.dataset.cmd === 'list') { if (editing.classList.contains('field')) doc.execCommand('insertUnorderedList'); }
  else if (b.dataset.cmd === 'unlink') doc.execCommand('unlink');
  else if (b.dataset.cmd === 'link') openLink();
  else if ('color' in b.dataset) colorize(b.dataset.color);
});
function openLink() {
  savedRange = currentRange();
  const a = savedRange && savedRange.commonAncestorContainer.parentElement && savedRange.commonAncestorContainer.parentElement.closest('a');
  linkurl.value = a ? a.getAttribute('href') : ''; linkform.hidden = false; linkurl.focus(); linkurl.select();
}
const SAFE_URL = /^(https?:\/\/|mailto:|#|[a-z0-9_./-])/i;   // схемы: http(s), mailto, якорь, относительный путь
linkform.addEventListener('submit', e => {
  e.preventDefault(); const url = linkurl.value.trim(); linkform.hidden = true;
  restoreRange();
  if (!url) return;
  if (!SAFE_URL.test(url) || /^javascript:/i.test(url)) return say('ссылка: только https, mailto, #якорь или относительный путь', true);
  if (savedRange && savedRange.collapsed) { const a = doc.createElement('a'); a.href = url; a.textContent = url; savedRange.insertNode(a); }
  else doc.execCommand('createLink', false, url);
});
function colorize(c) {                 // цвет — классом палитры на span; пустой c снимает цвет
  const r = currentRange(); if (!r || r.collapsed) return say('выдели текст, которому нужен цвет');
  const root = r.commonAncestorContainer.nodeType === 1 ? r.commonAncestorContainer : r.commonAncestorContainer.parentElement;
  root.querySelectorAll('span[class^="c-"]').forEach(sp => { if (r.intersectsNode(sp)) unwrap(sp); });
  if (c) { const sp = doc.createElement('span'); sp.className = 'c-' + c; sp.appendChild(r.extractContents()); r.insertNode(sp); r.selectNodeContents(sp); }
  const s = doc.getSelection(); s.removeAllRanges(); s.addRange(r);
  function unwrap(n) { while (n.firstChild) n.parentNode.insertBefore(n.firstChild, n); n.remove(); }
}
// разрешённая разметка внутри текста: strong/em/a[href]/ul/li/br/p/h2/cite/span.c-*|blink|counter; остальное разворачивается
const KEEP_SPAN = /^(c-(paper|fog|blood|mist)|blink|counter)$/;
function normalize(el) {
  el.querySelectorAll('i').forEach(n => swap(n, 'em')); el.querySelectorAll('b').forEach(n => swap(n, 'strong'));
  if (el.classList.contains('field')) el.querySelectorAll(':scope > div').forEach(n => swap(n, 'p'));
  el.querySelectorAll('span, font').forEach(n => { if (!(n.tagName === 'SPAN' && [...n.classList].some(c => KEEP_SPAN.test(c)))) unwrap(n); });
  el.querySelectorAll('a').forEach(a => { const h = a.getAttribute('href') || ''; if (!h || !SAFE_URL.test(h) || /^javascript:/i.test(h)) unwrap(a); else { [...a.attributes].forEach(at => { if (at.name !== 'href' && at.name !== 'class') a.removeAttribute(at.name); }); } });
  if (!el.classList.contains('field')) el.querySelectorAll('ul, ol').forEach(unwrap);
  el.querySelectorAll('[style]').forEach(n => { if (n !== el && !n.classList.contains('ghost') && !n.style.getPropertyValue('--x')) n.removeAttribute('style'); });
  function swap(n, tag) { const m = doc.createElement(tag); m.innerHTML = n.innerHTML; n.replaceWith(m); }
  function unwrap(n) { while (n.firstChild) n.parentNode.insertBefore(n.firstChild, n); n.remove(); }
}
function keys(e) {
  if (e.key === 'Escape') { if (!linkform.hidden) { linkform.hidden = true; restoreRange(); } else if (editing) endEdit(); else select(null); return; }
  if (editing || e.target.matches('input,select,textarea')) {
    if (editing && e.ctrlKey && e.key === 'i') { e.preventDefault(); doc.execCommand('italic'); }
    if (editing && e.ctrlKey && e.key === 'k') { e.preventDefault(); openLink(); }   // иначе Firefox уводит в поиск
    return;
  }
  if (e.ctrlKey && e.key === '0') { e.preventDefault(); setZoom(1); }
  else if (e.ctrlKey && e.key === '1') { e.preventDefault(); zoomFit(); }
  else if (e.ctrlKey && (e.key === '=' || e.key === '+')) { e.preventDefault(); setZoom(zoom * 1.25); }
  else if (e.ctrlKey && e.key === '-') { e.preventDefault(); setZoom(zoom / 1.25); }
  else if (e.ctrlKey && e.key === 's') { e.preventDefault(); save(); }
  else if (e.ctrlKey && e.key === 'z') { e.preventDefault(); undo(); }
  else if (e.ctrlKey && e.key === 'y') { e.preventDefault(); redo(); }
  else if (sel && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); action('del'); }
  else if (sel && e.key.startsWith('Arrow') && kind(sel) !== 'ghost' && kind(sel) !== 'footer' && !isPhone()) {
    e.preventDefault(); const p = placement(sel), st = e.shiftKey ? STEP : 1, d = { ArrowLeft: [-st, 0], ArrowRight: [st, 0], ArrowUp: [0, -st], ArrowDown: [0, st] }[e.key];
    if (FULLW.includes(kind(sel))) d[0] = 0;
    p.x += d[0]; p.y += d[1]; if (p.y < 0) return;        // стрелки минуют магнит
    if (collides(sel, p)) return bad(sel);
    push(); setPlacement(sel, p); refresh(); renderProps();
  }
}

/* ── палитра ────────────────────────────────────────────────────────── */
const T = {
  field: () => `<section class="field reveal"><h2>заголовок</h2><p>Текст.</p></section>`,
  pic: img => `<figure class="field pic reveal" style="--ar: 3 / 2"><div class="frame glitch"><img src="img/${img}" alt=""></div><figcaption>fig. — подпись</figcaption></figure>`,
  cutout: img => `<figure class="cutout glitch reveal" style="--w: 300px; --tilt: -2deg"><img src="img/${img}" alt=""><figcaption>fig. — подпись</figcaption></figure>`,
  quote: () => `<blockquote class="scrawl quote reveal" style="--tilt: -1.5deg">Цитата<cite>— источник</cite></blockquote>`,
  note: () => `<p class="scrawl note reveal" style="--tilt: 1deg">Мысль на полях.</p>`,
  meta: () => `<p class="scrawl meta reveal">rec 03:14 · tape 07</p>`,
  stamp: img => `<figure class="stamp reveal" style="--w: 96px; --tilt: 4deg"><img src="img/${img}" alt=""></figure>`,
  ghost: img => `<figure class="ghost" style="--x: 55%; --y: 10%; --w: 40%; --o: .8"><img src="img/${img}" alt=""></figure>`,
  embed: () => `<figure class="field embed reveal" style="--h: 300px"><iframe src="about:blank" loading="lazy" allow="fullscreen; encrypted-media" allowfullscreen sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"></iframe><figcaption>сейчас играет</figcaption></figure>`,
};
/* TODO(human): embedSrc(code) — из вставленного embed-кода или голой ссылки вернуть адрес для
   iframe, либо null, если встраивать нельзя. Что учесть:
   - код вида <iframe … src="https://…"></iframe> → взять значение src (регулярное выражение);
   - голая ссылка YouTube https://www.youtube.com/watch?v=ID или https://youtu.be/ID →
     https://www.youtube-nocookie.com/embed/ID (страница просмотра в iframe не открывается);
   - остальные ссылки — как есть, если хост разрешён;
   - хост проверять по суффиксу С ТОЧКОЙ: youtube.com, youtube-nocookie.com, youtu.be, bandcamp.com,
     soundcloud.com, letterboxd.com, open.spotify.com, archive.org («youtube.com.evil.net» → null);
   - только https. Принимать ли произвольные хосты — твоё решение. Пока возвращает null. */
function embedSrc(code) {
  return null;
}
const PICK = { pic: /\.(jpg|jpeg|webp)$/, cutout: /\.png$/, stamp: /\.(gif|png)$/, ghost: /^ghost-/ };
function addBlock(type, img) {
  if (PICK[type] && !img) { img = state.images.find(n => PICK[type].test(n) && !/^(cursor|hand)/.test(n)); if (!img) return say('нет подходящей картинки в img/ — загрузи', true); }
  push();
  const tpl = doc.createElement('template'); tpl.innerHTML = T[type](img).trim();
  const el = tpl.content.firstElementChild;
  if (type === 'ghost') { ghosts.appendChild(el); }
  else {
    const f = stage.querySelector(':scope > footer');
    const w = { field: 520, pic: 440, embed: 560, cutout: 300, stamp: 96, quote: 560, note: 480, meta: 360 }[type] || 400;
    const cr = canvas.getBoundingClientRect(), fr = ifr.getBoundingClientRect();
    const y = Math.max(0, Math.round((cr.top + cr.height / 2 - fr.top) / zoom - stage.offsetTop - 60));   // середина видимой части листа
    setPlacement(el, { x: Math.round((stageW() - w) / 2), y, w });
    el.style.setProperty('--m', maxOrder() + 1);
    f ? f.before(el) : stage.appendChild(el);
  }
  setTimeout(() => { refresh(); select(el); el.scrollIntoView({ block: 'center' }); }, 80);
}
document.querySelectorAll('[data-add]').forEach(b => b.addEventListener('click', () => addBlock(b.dataset.add)));

/* ── фон и загрузка ─────────────────────────────────────────────────── */
$('#bg').addEventListener('change', async e => {
  say('обрабатываю фон…');
  const r = await api('/api/bg?name=' + encodeURIComponent(e.target.value), { method: 'POST' });
  if (r.error) return say(r.error, true);
  state = r.state; doc.documentElement.style.setProperty('--bg-image', `url("img/bg-${e.target.value}.jpg?${Date.now()}")`); say('фон: ' + e.target.value);
});
const drop = $('#drop'), file = $('#file');
drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]); });
file.addEventListener('change', () => { if (file.files[0]) upload(file.files[0]); file.value = ''; });
/* ── поиск гифок на GifCities ──────────────────────────────────────── */
const gc = { box: $('#gifsearch'), form: $('#gcform'), q: $('#gcq'), flavor: $('#gcflavor'), grid: $('#gcgrid'), more: $('#gcmore'), size: 24, offset: 0, query: '' };
$('#uptype').addEventListener('change', () => { gc.box.hidden = $('#uptype').value !== 'stamp'; });
gc.form.addEventListener('submit', e => { e.preventDefault(); gc.offset = 0; gc.grid.innerHTML = ''; gifSearch(); });
gc.flavor.addEventListener('change', () => { if (gc.q.value.trim()) gc.form.requestSubmit(); });
gc.more.addEventListener('click', () => { gc.offset += gc.size; gifSearch(); });
async function gifSearch() {
  const q = gc.q.value.trim(); if (!q) return;
  gc.query = q; gc.more.hidden = true; say(`ищу «${q}»…`);
  try {
    const r = await api(`/api/gifsearch?q=${encodeURIComponent(q)}&flavor=${gc.flavor.value}&offset=${gc.offset}&limit=${gc.size}`, { nopage: true });
    if (r.error) return say(r.error, true);
    for (const it of r.items) {
      const b = document.createElement('button'); b.type = 'button'; b.title = `${it.w}×${it.h}`; b.dataset.checksum = it.checksum;
      const im = document.createElement('img'); im.loading = 'lazy'; im.alt = ''; im.src = it.thumb; b.append(im); gc.grid.append(b);
    }
    gc.more.hidden = r.items.length < gc.size;
    const total = gc.grid.children.length;
    say(total ? `показано ${total}` : 'ничего не нашлось');
  } catch (e) { say('поиск не удался: ' + e.message, true); }
}
gc.grid.addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return;
  b.classList.add('busy'); say('скачиваю…');
  try {
    const r = await api(`/api/gifsave?checksum=${b.dataset.checksum}&q=${encodeURIComponent(gc.query)}`, { method: 'POST' });
    if (r.error) return say(r.error, true);
    state = r.state; addBlock('stamp', r.file); say(`готово: img/${r.file}`);
  } catch (err) { say('не скачалось: ' + err.message, true); }
  finally { b.classList.remove('busy'); }
});

async function upload(f) {
  const type = $('#uptype').value; say(`загружаю ${f.name} как ${type}…`);
  try {
    const r = await api(`/api/upload?type=${type}&name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f });
    if (r.error) return say(r.error, true);
    state = r.state;
    if (type === 'bg') { $('#bg').innerHTML = state.backgrounds.map(b => `<option ${b === r.file.replace(/^bg-|\.jpg$/g, '') ? 'selected' : ''}>${b}</option>`).join(''); doc.documentElement.style.setProperty('--bg-image', `url("img/${r.file}?${Date.now()}")`); }
    else addBlock(type, r.file);
    say(`готово: img/${r.file}`);
    if (type === 'cutout') setTimeout(() => cropModal(r.file.replace(/\.png$/, '')), 400);   // сразу подобрать crop и точки
  } catch (e) { say('загрузка не удалась: ' + e.message, true); }
}

/* ── модальные окна ─────────────────────────────────────────────────── */
const modal = $('#modal'), mtitle = $('#mtitle'), mbody = $('#mbody');
function openModal(title, html) { mtitle.textContent = title; mbody.innerHTML = html; modal.hidden = false; }
function closeModal() { modal.hidden = true; mbody.innerHTML = ''; }
$('#mclose').addEventListener('click', closeModal);
modal.addEventListener('mousedown', e => { if (e.target === modal) closeModal(); });

/* ── обрезка вырезки: рамка crop, точки заливки, параметры → строка cutouts.txt ── */
async function cropModal(name) {
  const d = await api('/api/cutout?name=' + encodeURIComponent(name), { nopage: true });
  if (d.error) return say(d.error, true);
  openModal('вырезка ' + name, `<div class="crop"><div><canvas id="cropc"></canvas><p class="hint">Тяни рамку за края или углы, внутри — переносит. Клик — точка заливки фона (в углах картинки, там где фон), правый клик по точке — убрать.</p></div>
    <div class="side">
      <div class="row"><label>допуск заливки, % <b id="v-fuzz">${d.fuzz}</b></label><input type="range" id="c-fuzz" min="1" max="15" step=".5" value="${d.fuzz}"></div>
      <div class="row"><label>поле бумаги, px <b id="v-margin">${d.margin}</b></label><input type="range" id="c-margin" min="4" max="24" step="1" value="${d.margin}"></div>
      <div class="row"><label>ширина файла, px <b id="v-width">${d.width}</b></label><input type="range" id="c-width" min="120" max="480" step="10" value="${d.width}"></div>
      <div class="row"><label>seed разрыва</label><input type="number" id="c-seed" min="0" value="${d.seed}"> <button id="c-reseed" type="button">другой</button></div>
      <p class="hint" id="c-info"></p>
      <div class="actions"><button id="c-apply">применить</button><button id="c-cancel">отмена</button></div>
    </div></div>`);
  const cv = $('#cropc'), ctx = cv.getContext('2d'), img = new Image();
  const crop = { ...d.crop }; let seeds = d.seeds.map(([x, y]) => [x, y]);
  const maxW = Math.min(640, window.innerWidth - 340), maxH = Math.min(560, window.innerHeight - 200);
  const sc = Math.min(maxW / d.sw, maxH / d.sh, 1);
  cv.width = Math.round(d.sw * sc); cv.height = Math.round(d.sh * sc);
  img.onload = draw; img.src = '/' + d.src;
  function draw() {
    ctx.clearRect(0, 0, cv.width, cv.height); ctx.drawImage(img, 0, 0, cv.width, cv.height);
    ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(img, crop.x, crop.y, crop.w, crop.h, crop.x * sc, crop.y * sc, crop.w * sc, crop.h * sc);
    ctx.strokeStyle = '#e8dfc9'; ctx.lineWidth = 1; ctx.strokeRect(crop.x * sc + .5, crop.y * sc + .5, crop.w * sc, crop.h * sc);
    for (const [x, y] of seeds) { ctx.beginPath(); ctx.arc((crop.x + x) * sc, (crop.y + y) * sc, 5, 0, 7); ctx.fillStyle = 'rgba(155,58,42,.9)'; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.stroke(); }
    $('#c-info').textContent = `crop ${crop.w}×${crop.h} +${crop.x}+${crop.y} · точек: ${seeds.length}`;
  }
  const pos = e => { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) / sc, y: (e.clientY - r.top) / sc }; };
  let drag = null;
  cv.addEventListener('mousedown', e => {
    if (e.button !== 0) return; const p = pos(e), g = 8 / sc;
    const nearL = Math.abs(p.x - crop.x) < g, nearR = Math.abs(p.x - crop.x - crop.w) < g, nearT = Math.abs(p.y - crop.y) < g, nearB = Math.abs(p.y - crop.y - crop.h) < g;
    const inside = p.x > crop.x && p.x < crop.x + crop.w && p.y > crop.y && p.y < crop.y + crop.h;
    const edges = { l: nearL, r: nearR, t: nearT, b: nearB };
    drag = { p0: p, c0: { ...crop }, edges, move: inside && !nearL && !nearR && !nearT && !nearB, moved: false };
  });
  cv.addEventListener('mousemove', e => {
    if (!drag) return; const p = pos(e), dx = Math.round(p.x - drag.p0.x), dy = Math.round(p.y - drag.p0.y);
    if (Math.abs(dx) + Math.abs(dy) > 2 / sc) drag.moved = true; if (!drag.moved) return;
    const c = { ...drag.c0 };
    if (drag.move) { c.x += dx; c.y += dy; }
    else { if (drag.edges.l) { c.x += dx; c.w -= dx; } if (drag.edges.r) c.w += dx; if (drag.edges.t) { c.y += dy; c.h -= dy; } if (drag.edges.b) c.h += dy; }
    c.w = Math.max(8, c.w); c.h = Math.max(8, c.h);
    c.x = Math.max(0, Math.min(d.sw - c.w, c.x)); c.y = Math.max(0, Math.min(d.sh - c.h, c.y)); c.w = Math.min(c.w, d.sw - c.x); c.h = Math.min(c.h, d.sh - c.y);
    // точки хранятся относительно crop: при сдвиге рамки пересчитываем, вышедшие за рамку отбрасываем
    if (!drag.move) { const before = seeds.length; seeds = seeds.map(([x, y]) => [x + drag.c0.x - c.x, y + drag.c0.y - c.y]).filter(([x, y]) => x >= 0 && y >= 0 && x < c.w && y < c.h); if (seeds.length < before) say('точки за рамкой убраны'); }
    Object.assign(crop, c); draw();
  });
  window.addEventListener('mouseup', e => {
    if (!drag) return;
    if (!drag.moved && drag.move) { const p = pos(e); seeds.push([Math.round(p.x - crop.x), Math.round(p.y - crop.y)]); draw(); }
    drag = null;
  });
  cv.addEventListener('contextmenu', e => { e.preventDefault(); const p = pos(e); const i = seeds.findIndex(([x, y]) => Math.hypot(crop.x + x - p.x, crop.y + y - p.y) < 8 / sc); if (i >= 0) { seeds.splice(i, 1); draw(); } });
  for (const n of ['fuzz', 'margin', 'width']) $('#c-' + n).addEventListener('input', e => { $('#v-' + n).textContent = e.target.value; });
  $('#c-reseed').addEventListener('click', () => { $('#c-seed').value = Math.floor(Math.random() * 1e6); });
  $('#c-cancel').addEventListener('click', closeModal);
  $('#c-apply').addEventListener('click', async () => {
    say('пересобираю вырезку…'); $('#c-apply').disabled = true;
    const body = { name, crop, seeds, fuzz: +$('#c-fuzz').value, margin: +$('#c-margin').value, width: +$('#c-width').value, seed: +$('#c-seed').value };
    const r = await api('/api/cutout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), nopage: true });
    if (r.error) { $('#c-apply').disabled = false; return say(r.error, true); }
    closeModal();
    doc.querySelectorAll(`img[src$="/${name}.png"], img[src="img/${name}.png"]`).forEach(im => { const src = im.getAttribute('src'); im.src = ''; im.src = src; });
    if (sel && kind(sel) === 'cutout') { push(); sel.style.setProperty('--w', body.width + 'px'); }
    setTimeout(() => { refresh(); renderProps(); }, 300); say('вырезка пересобрана');
  });
}

/* ── библиотека картинок ────────────────────────────────────────────── */
async function libraryModal() {
  const r = await api('/api/library', { nopage: true }); if (r.error) return say(r.error, true);
  const T_ = { pic: 'фото', cutout: 'вырезка', ghost: 'призрак', stamp: 'штамп', bg: 'фон', none: 'без исходника' };
  openModal('картинки img/', `<div class="lib">${r.items.map(it => `<div class="it" data-name="${it.name}">
      <div class="th"><img src="img/${it.name}" alt="" loading="lazy"></div>
      <div class="nm">${it.name}</div><div>${T_[it.type]} · ${(it.size / 1024).toFixed(0)} КБ</div>
      <div class="${it.used.length ? 'used' : ''}">${it.used.length ? 'на: ' + it.used.join(', ') : 'не используется'}</div>
      <div class="acts">${it.type === 'pic' || it.type === 'none' && /\.(jpe?g|webp)$/i.test(it.name) ? '<button data-ins="pic">→ фото</button>' : ''}${it.type === 'cutout' ? '<button data-ins="cutout">→ вырезка</button>' : ''}${it.type === 'stamp' || it.type === 'none' && /\.(gif|png)$/i.test(it.name) ? '<button data-ins="stamp">→ штамп</button>' : ''}${it.type === 'ghost' ? '<button data-ins="ghost">→ призрак</button>' : ''}${!it.used.length && !it.active_bg ? `<button class="danger" data-del title="${it.removes.join('\n')}">удалить</button>` : ''}</div>
    </div>`).join('')}</div>`);
  mbody.addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return; const name = b.closest('.it').dataset.name;
    if (b.dataset.ins) { closeModal(); addBlock(b.dataset.ins, name); return; }
    if ('del' in b.dataset) {
      const it = r.items.find(i => i.name === name);
      if (!confirm('Удалить навсегда:\n' + it.removes.join('\n'))) return;
      const x = await api('/api/delete?name=' + encodeURIComponent(name), { method: 'POST', nopage: true });
      if (x.error) return say(x.error, true);
      state = x.state; say('удалено: ' + x.removed.join(', ')); libraryModal();
    }
  });
}
$('#library').addEventListener('click', libraryModal);

/* ── сохранение ─────────────────────────────────────────────────────── */
function clean(root) {
  const c = root.cloneNode(true);
  c.querySelectorAll('[data-ed]').forEach(n => n.remove());
  c.querySelectorAll('[contenteditable]').forEach(n => n.removeAttribute('contenteditable'));
  c.querySelectorAll('.ed-sel,.ed-hover,.ed-bad').forEach(n => n.classList.remove('ed-sel', 'ed-hover', 'ed-bad'));
  c.querySelectorAll('[class=""]').forEach(n => n.removeAttribute('class'));
  c.querySelectorAll('[style=""]').forEach(n => n.removeAttribute('style'));
  return c.innerHTML;
}
async function save() {
  endEdit();
  if (isPhone()) { $('#phone').click(); await new Promise(r => setTimeout(r, 150)); }   // наложения проверяются на афише
  const ov = overlaps();
  if (ov.length) return say('не сохранено: перекрываются текстовые поля ' + ov.map(blockName).join(', '), true);
  say('сохраняю…');
  try {
    const r = await api('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stage: clean(stage), ghosts: clean(ghosts) }) });
    if (r.error) return say(r.error, true);
    const n = await syncShared();
    say(`сохранено (${new Date().toLocaleTimeString()})` + (n ? `, общие блоки → ${n} стр.` : ''));
  } catch (e) { say('сервер недоступен: запусти tools/edit.sh', true); }
}
// общие блоки (.shared[id]) копируются на остальные страницы: innerHTML и классы (кроме hide-m/hide-d —
// это раскладка страницы); --x/--y/--w/--m у каждой страницы свои. Нет на странице — вставляется
// перед подвалом ниже всех блоков (--y = max + 40).
async function syncShared() {
  const mine = [...stage.querySelectorAll(':scope > .shared[id]')]; if (!mine.length) return 0;
  const tpl = document.createElement('template'); tpl.innerHTML = clean(stage);
  const cleanMine = mine.map(el => tpl.content.getElementById(el.id)).filter(Boolean);
  let touched = 0;
  for (const pg of (state.pages || []).filter(pg => pg !== PAGE)) {
    const html = await (await fetch(`/${pg}.html`, { cache: 'no-store' })).text();
    const d = new DOMParser().parseFromString(html, 'text/html'), st = d.querySelector('main.stage'); if (!st) continue;
    let changed = false;
    for (const src of cleanMine) {
      const dst = st.querySelector(':scope > #' + CSS.escape(src.id));
      const isHide = c => /^hide-[md]$/.test(c);
      if (dst) {
        const cls = [...src.classList].filter(c => !isHide(c)).concat([...dst.classList].filter(isHide)).join(' ');
        if (dst.innerHTML !== src.innerHTML || dst.className !== cls) { dst.innerHTML = src.innerHTML; dst.className = cls; changed = true; }
      } else {
        const c = d.importNode(src, true); c.classList.remove('hide-m', 'hide-d');
        const kids = [...st.children], maxY = kids.reduce((m, el) => Math.max(m, parseFloat(el.style.getPropertyValue('--y')) || 0), 0);
        const maxM = kids.reduce((m, el) => Math.max(m, parseFloat(el.style.getPropertyValue('--m')) || 0), 0);
        c.style.setProperty('--y', Math.round(maxY + 40) + 'px'); c.style.setProperty('--m', maxM + 1);
        if (!FULLW.includes(kind(c))) c.style.setProperty('--x', '0px'); else c.style.removeProperty('--x');
        const f = st.querySelector(':scope > footer'); f && f !== c ? f.before(c) : st.appendChild(c); changed = true;
      }
    }
    if (!changed) continue;
    const r = await api(`/api/save?page=${pg}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stage: st.innerHTML }), nopage: true });
    if (r.error) say(`${pg}: ${r.error}`, true); else touched++;
  }
  return touched;
}

/* ── страницы ───────────────────────────────────────────────────────── */
function gotoPage(slug) {
  if (hist.undo.length && !confirm('Есть несохранённые правки. Перейти без сохранения?')) { $('#pages').value = PAGE; return; }
  PAGE = slug; hist.undo.length = 0; hist.redo.length = 0; sel = null; editing = null; textbar.hidden = true;
  ifr.src = '/' + slug + '.html';
}
$('#pages').addEventListener('change', e => gotoPage(e.target.value));
$('#newpage').addEventListener('click', async () => {
  const name = prompt('Имя страницы (латиница, цифры, дефис), например shrine-tapes:'); if (!name) return;
  const slug = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug || slug === 'editor' || slug === 'kit') return say('плохое имя', true);
  // шаблон = index.html: остаются общие блоки и одно пустое поле; призраки копируются
  const html = await (await fetch('/index.html', { cache: 'no-store' })).text();
  const d = new DOMParser().parseFromString(html, 'text/html'), st = d.querySelector('main.stage');
  [...st.children].forEach(el => { if (!el.classList.contains('shared')) el.remove(); });
  st.querySelectorAll('a[href^="#"]').forEach(a => a.setAttribute('href', 'index.html' + a.getAttribute('href')));
  const note = d.createElement('section'); note.className = 'field reveal'; note.innerHTML = `<h2>${slug}</h2><p>Текст.</p>`;
  const maxM = [...st.children].reduce((m, el) => Math.max(m, parseFloat(el.style.getPropertyValue('--m')) || 0), 0);
  note.style.cssText = `--x: 320px; --y: 140px; --w: 520px; --m: ${maxM + 1}`;
  const f = st.querySelector(':scope > footer'); f ? f.before(note) : st.appendChild(note);
  d.title = slug;
  const out = '<!doctype html>\n' + d.documentElement.outerHTML + '\n';
  const r = await api(`/api/page?page=${slug}`, { method: 'POST', body: out, nopage: true });
  if (r.error) return say(r.error, true);
  state = r.state; $('#pages').innerHTML = state.pages.map(pg => `<option value="${pg}">${pg}.html</option>`).join('');
  $('#pages').value = slug; gotoPage(slug); say('страница создана: ' + slug + '.html');
});

/* ── бэкапы ─────────────────────────────────────────────────────────── */
$('#backups').addEventListener('click', async () => {
  const r = await api('/api/backups'); if (r.error) return say(r.error, true);
  openModal(`бэкапы ${PAGE}.html`, r.items.length ? `<table class="bk">${r.items.map(i => `<tr><td>${i.time}</td><td>${(i.size / 1024).toFixed(1)} КБ</td><td><button data-restore="${i.file}">восстановить</button></td></tr>`).join('')}</table>` : '<p class="hint">пока нет — бэкап создаётся при каждом сохранении</p>');
  mbody.addEventListener('click', async e => {
    const b = e.target.closest('[data-restore]'); if (!b) return;
    if (!confirm('Заменить текущую страницу этой версией? Текущая уйдёт в бэкап.')) return;
    const x = await api('/api/restore?file=' + encodeURIComponent(b.dataset.restore), { method: 'POST' });
    if (x.error) return say(x.error, true);
    closeModal(); hist.undo.length = 0; ifr.src = '/' + PAGE + '.html'; say('восстановлено');
  });
});

/* ── ключ API и заливка на Neocities ────────────────────────────────── */
$('#push').addEventListener('click', async () => {
  const k = await api('/api/key', { nopage: true });
  const dry = await api('/api/push?dry=1', { method: 'POST', nopage: true }); if (dry.error) return say(dry.error, true);
  openModal('залить на Neocities', `<p class="hint">Уйдёт (только это, без src/tools/refs/editor): ${dry.files.length} файлов.</p><pre class="files">${dry.files.join('\n')}</pre>
    <div class="row"><label>ключ API ${k.has ? '(сохранён в tools/neocities.key)' : '— нет; взять на neocities.org/settings → API'}</label><form id="keyform"><input type="password" id="keyval" placeholder="${k.has ? 'оставь пустым, чтобы не менять' : 'вставь ключ'}"><button type="submit">сохранить ключ</button></form></div>
    <div class="actions"><button id="dopush" ${k.has ? '' : 'disabled'}>залить сейчас</button></div><pre id="pushlog"></pre>`);
  $('#keyform').addEventListener('submit', async e => { e.preventDefault(); const v = $('#keyval').value.trim(); if (!v) return; const x = await api('/api/key', { method: 'POST', body: v, nopage: true }); if (x.error) return say(x.error, true); $('#dopush').disabled = false; $('#keyval').value = ''; say('ключ сохранён'); });
  $('#dopush').addEventListener('click', async () => {
    if (hist.undo.length && !confirm('Есть несохранённые правки — залить то, что на диске?')) return;
    $('#dopush').disabled = true; $('#pushlog').textContent = 'заливаю…';
    const x = await api('/api/push', { method: 'POST', nopage: true });
    $('#pushlog').textContent = x.error ? 'ошибка: ' + x.error : `залито ${x.uploaded.length}: ${x.uploaded.join(', ') || '—'}\nбез изменений: ${x.skipped.length}`;
    $('#dopush').disabled = false; say(x.error ? x.error : 'залито', !!x.error);
  });
});

$('#save').addEventListener('click', save);
$('#undo').addEventListener('click', undo);
$('#redo').addEventListener('click', redo);
$('#phone').addEventListener('click', e => {
  canvas.classList.toggle('phone'); e.target.classList.toggle('on'); select(null);
  doc.documentElement.classList.toggle('ed-phone', isPhone()); doc.documentElement.classList.toggle('ed-desk', !isPhone());
  setTimeout(refresh, 100);
});
$('#magnet').addEventListener('click', e => { magnet = !magnet; e.target.classList.toggle('on', magnet); });

/* ── холст: ширина афиши и телефона (tools/site.json → layout.css) ──── */
// масштабирование раскладки при смене ширины: x, y, w × k; --w вырезок и штампов = ширина файла, не трогается
function scaleLayout(st, k) {
  for (const el of st.children) {
    if (el.dataset && el.dataset.ed) continue;
    for (const n of ['x', 'y', 'w']) {
      if (n === 'w' && PIXELW.some(c => el.classList.contains(c))) continue;
      const v = parseFloat(el.style.getPropertyValue('--' + n)); if (!isNaN(v)) el.style.setProperty('--' + n, Math.round(v * k) + 'px');
    }
  }
}
$('#canvasbtn').addEventListener('click', () => {
  openModal('холст', `<p class="hint">Афиша — фиксированная ширина в пикселях; в окнах уже она уменьшается ступенями zoom, а ниже ${Math.ceil(settings.poster * .78) + 16} px становится колонкой.
    Числа пишутся в <code>tools/site.json</code>, из них собирается <code>layout.css</code>.</p>
    <div class="row"><label>ширина афиши, px</label><input type="number" id="s-poster" min="800" max="2400" step="10" value="${settings.poster}"></div>
    <div class="row"><label>ширина превью телефона, px</label><input type="number" id="s-phone" min="320" max="520" step="10" value="${settings.phone}"></div>
    <div class="row"><label>экран посетителя (только для вида в редакторе), px</label><div class="pair"><input type="number" id="s-screen" min="1000" max="3840" step="10" value="${settings.screen}"> × <input type="number" id="s-screenh" min="500" max="2160" step="10" value="${settings.screenh}"></div></div>
    <div class="checks"><label><input type="checkbox" id="s-scale" checked> пересчитать положение блоков на всех страницах (x, y, ширина × новая/старая; все страницы будут сохранены)</label></div>
    <div class="actions"><button id="s-apply">применить</button></div>`);
  $('#s-apply').addEventListener('click', async () => {
    const body = { poster: +$('#s-poster').value, phone: +$('#s-phone').value, screen: +$('#s-screen').value, screenh: +$('#s-screenh').value }, rescale = $('#s-scale').checked;
    $('#s-apply').disabled = true;
    const r = await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), nopage: true });
    if (r.error) { $('#s-apply').disabled = false; return say(r.error, true); }
    const k = r.new.poster / r.old.poster;
    if (rescale && k !== 1) {
      endEdit(); scaleLayout(stage, k);
      const cur = await api('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stage: clean(stage), ghosts: clean(ghosts) }) });
      if (cur.error) say(cur.error, true);
      for (const pg of (state.pages || []).filter(pg => pg !== PAGE)) {
        const html = await (await fetch(`/${pg}.html`, { cache: 'no-store' })).text();
        const d = new DOMParser().parseFromString(html, 'text/html'), st = d.querySelector('main.stage'); if (!st) continue;
        scaleLayout(st, k);
        const x = await api(`/api/save?page=${pg}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stage: st.innerHTML }), nopage: true });
        if (x.error) say(`${pg}: ${x.error}`, true);
      }
      hist.undo.length = 0; hist.redo.length = 0;
    }
    settings = r.new; applyCanvas(); closeModal();
    if (!rescale || k === 1) say(`холст: афиша ${settings.poster}, телефон ${settings.phone}, экран ${settings.screen}×${settings.screenh}`); else say(`холст ${settings.poster} px, блоки пересчитаны ×${k.toFixed(3)}`);
    ifr.src = '/' + PAGE + '.html';          // новый layout.css
  });
});

/* ── перенос со старой сетки (--c/--r) на афишу ─────────────────────── */
// старые правила сетки временно возвращаются стилем внутри iframe, измеряется положение каждого
// блока (offset*, без transform) и ширина холста W₀, затем всё умножается на k = W_афиши / W₀.
// y тоже масштабируется: медиа с aspect-ratio растут по высоте, иначе наезжали бы на блоки ниже.

window.addEventListener('resize', () => overlay && refresh());
window.addEventListener('beforeunload', e => { if (hist.undo.length) { e.preventDefault(); e.returnValue = ''; } });
