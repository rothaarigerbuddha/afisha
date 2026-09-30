/* Редактор коллажа (afisha). Холст = страница в iframe с настоящими style.css + theme.css + layout.css.
   Виды блоков, эффекты, палитра, слои — из манифеста темы (THEME, см. theme.js), не из констант.
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
let STEP = 8, SNAP = 6, GAPMIN = 8;             // шаг магнита, радиус прилипания, запас между текстовыми полями — из THEME.layout
let KEEP_SPAN = /^$/;                           // разрешённые span в тексте (цвета палитры темы + keep_span) — из THEME.text

/* ── статус и API ───────────────────────────────────────────────────── */
function say(msg, err) { statusEl.textContent = msg; statusEl.classList.toggle('err', !!err); if (!err) hint(''); }
function sayk(key, err, vars) { statusEl.dataset.key = key; say(t(key, vars), err); }
function hint(text) { const hb = $('#hintbox'); if (!text) { hb.hidden = true; return; } $('#hinttext').textContent = text; hb.hidden = false; }
function fail(r) { say((r && r.error) || t('st.error'), true); hint(r && r.hint); }
$('#hintclose').addEventListener('click', () => hint(''));
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
  if (!stage || !page) return sayk('st.no_stage', true);
  if (!ghosts) { ghosts = doc.createElement('div'); ghosts.className = 'ghosts'; ghosts.setAttribute('aria-hidden', 'true'); page.prepend(ghosts); }
  await loadState(); if (!THEME) return;      // манифест темы нужен раньше стилей правки и первого refresh
  injectStyle();
  try { doc.execCommand('defaultParagraphSeparator', false, 'p'); } catch (e) {}
  overlay = doc.createElement('div'); overlay.className = 'ed-overlay'; overlay.dataset.ed = '1'; page.appendChild(overlay);
  selbox = doc.createElement('div'); selbox.className = 'ed-selbox'; selbox.dataset.ed = '1'; selbox.hidden = true; page.appendChild(selbox);
  bindCanvas();
  doc.documentElement.classList.add(isPhone() ? 'ed-phone' : 'ed-desk');
  refresh();                          // лист и пометки сразу, с настройками по умолчанию; после ответа сервера — ещё раз
  if (localStorage.getItem('ed-zoom') === null) zoomFit();   // первый запуск: вся страница на столе
  normalizeOrder();
  refresh(); select(null); updateSingles();
  if (state.theme_error) fail({ error: state.theme_error, hint: t('st.theme_stub') });
  else { sayk('st.ready'); if (THEME.warnings.length) say(t('st.ready') + t('st.theme_warn', { w: THEME.warnings[0] })); }
  if (state.magick && !state.magick.found && !sessionStorage.getItem('ed-magick-warned')) { sessionStorage.setItem('ed-magick-warned', '1'); fail({ error: t('st.no_magick'), hint: state.magick.hint }); }
});
const isPhone = () => canvas.classList.contains('phone');

function injectStyle() {
  const s = doc.createElement('style'); s.dataset.ed = '1';
  s.textContent = `
    ${themeEditCss()}
    .bg{position:absolute!important;inset:0;background-size:100% auto!important;background-repeat:repeat-y!important;background-position:center top!important}
    .ed-margin{position:absolute;top:0;bottom:0;background:rgba(0,0,0,.32);pointer-events:none;z-index:1}
    .ed-margin.l{left:0;border-right:1px dashed rgba(232,223,201,.55)} .ed-margin.r{right:0;border-left:1px dashed rgba(232,223,201,.55)}
    .ed-fold{position:absolute;left:0;right:0;border-top:1px dashed rgba(155,58,42,.75);pointer-events:none;z-index:1}
    .ed-fold i,.ed-label{position:absolute;font:11px/1 monospace;font-style:normal;color:#e8dfc9;background:rgba(11,20,16,.85);padding:2px 6px;pointer-events:none}
    .ed-fold i{right:8px;top:-17px} .ed-label{left:0;top:4px;z-index:1}
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
    applyTheme(state.theme);
    applyCanvas();
    const bg = $('#bg'); bg.innerHTML = state.backgrounds.map(b => `<option value="${b}" ${b === state.background ? 'selected' : ''}>${b}</option>`).join('');
    $('#pages').innerHTML = (state.pages || ['index']).map(pg => `<option value="${pg}" ${pg === PAGE ? 'selected' : ''}>${pg}.html</option>`).join('');
  } catch (e) { sayk('st.server_down', true); }
}
// тема из манифеста: константы, палитра, textbar; после правки темы — ещё и перечитать theme.css
function applyTheme(t) {
  THEME = normalizeTheme(t);
  STEP = THEME.layout.step; SNAP = THEME.layout.snap; GAPMIN = THEME.layout.gap; KEEP_SPAN = keepSpanRe();
  buildPalette(); $('#themebtn').hidden = !!THEME.legacy;
  if (THEME.warnings.length) console.warn('тема:\n' + THEME.warnings.join('\n'));
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
  F.querySelector('i').textContent = t('st.first_screen', { w: settings.screen, h: settings.screenh });
  lab.textContent = phone ? t('st.column_px', { w: settings.phone }) : t('st.poster_px', { w: settings.poster, m: ml });
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
  const sp = specOf(el);
  if (!sp.bottom) el.style.setProperty('--y', Math.round(p.y) + 'px');
  if (!sp.fullw) { el.style.setProperty('--x', Math.round(p.x) + 'px'); el.style.setProperty('--w', Math.round(p.w) + 'px'); }
}
const stageW = () => stage.clientWidth;
const blocks = () => [...stage.children].filter(el => !el.dataset.ed);
const bottomEl = () => blocks().find(isBottom);        // подвал: вид с bottom (в потоке, задаёт высоту холста)
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
    if (o === el || isBottom(o) || !shown(o)) continue;
    const q = placement(o), h = o.offsetHeight;
    if (!specOf(o).fullw) lines.x.push(q.x, q.x + q.w, q.x + q.w / 2);
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
  if (ov.length) sayk('st.overlap', true, { names: ov.map(blockName).join(', ') });
  drawSel();
}
function fixFooter() {              // подвал ниже всего: его --y (margin-top) задаёт высоту холста
  const f = bottomEl(); if (!f || isPhone()) return;
  let max = 0; blocks().forEach(el => { if (el !== f && shown(el)) max = Math.max(max, placement(el).y + el.offsetHeight); });
  f.style.setProperty('--y', Math.round(max + 24) + 'px'); f.style.removeProperty('--x'); f.style.removeProperty('--w');
}

/* ── история ────────────────────────────────────────────────────────── */
function snap() { return { s: stage.innerHTML, g: ghosts.innerHTML }; }
function push() { hist.undo.push(snap()); if (hist.undo.length > 50) hist.undo.shift(); hist.redo.length = 0; }
function restore(x) { stage.innerHTML = x.s; ghosts.innerHTML = x.g; select(null); refresh(); }
function undo() { if (!hist.undo.length) return; hist.redo.push(snap()); restore(hist.undo.pop()); sayk('st.undone'); }
function redo() { if (!hist.redo.length) return; hist.undo.push(snap()); restore(hist.redo.pop()); sayk('st.redone'); }

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
  if (!sel) { propsEl.innerHTML = `<p class="hint">${t('props.choose')}</p>`; return; }
  const k = kind(sel), sp = spec(k), rows = [];
  const H = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const num = (v) => parseFloat(v) || 0;
  const cssv = n => sel.style.getPropertyValue(n).trim();
  const fxChecks = () => { const fx = fxFor(k); return fx.length ? `<div class="checks"><h3>${t('props.effects')}</h3>${fx.map(f => chk(f.where === 'frame' ? sel.querySelector('.frame') : sel, f.cls, H(L(f.label)), f.where)).join('')}</div>` : ''; };
  rows.push(`<p class="type">${H(L(sp.label) || k)}</p>`);

  if (sp.layer === 'ghosts') {
    const g = { x: num(cssv('--x')) || (cssv('--rx') ? 100 - num(cssv('--rx')) - num(cssv('--w') || '40') : 55), y: num(cssv('--y')), w: num(cssv('--w') || '40'), o: num(cssv('--o') || '.8') };
    rows.push(range('x', t('props.left_pct'), g.x, -30, 100, 1), range('y', t('props.top_pct'), g.y, -10, 100, 1), range('w', t('props.width_pct'), g.w, 10, 80, 1), range('o', t('props.opacity'), g.o, .1, 1, .05));
    if (sp.image) rows.push(imgSelect(sel.querySelector('img'), imgRe(sp.image)));
    rows.push(fxChecks());
  } else {
    const p = placement(sel);
    if (!sp.bottom) {
      const pos = sp.fullw ? '' : `<input type="number" data-p="x" value="${Math.round(p.x)}" title="x"> <input type="number" data-p="y" value="${Math.round(p.y)}" title="y"> <input type="number" data-p="w" min="40" value="${Math.round(p.w)}" title="${t('props.width')}">`;
      rows.push(`<div class="row"><label>${t('props.xyw')}</label><div class="pair">${pos || `<input type="number" data-p="y" value="${Math.round(p.y)}" title="y"> <span class="val">${t('props.fullw')}</span>`}</div></div>`);
      rows.push(`<div class="actions"><button data-act="layer-up" title="${t('props.layer_up_t')}">${t('props.layer_up')}</button><button data-act="layer-down">${t('props.layer_down')}</button></div>`);
    }
    if (sp.tiltable) rows.push(range('tilt', t('props.tilt'), num(cssv('--tilt')), -8, 8, .5));
    if (sp.ar) {
      const ar = cssv('--ar') || sp.ar[0];
      rows.push(`<div class="row"><label>${t('props.ratio')}</label><select data-ar>${sp.ar.map(a => `<option ${a === ar ? 'selected' : ''}>${H(a)}</option>`).join('')}</select></div>`);
    }
    rows.push(fxChecks());
    if (sp.embed) {
      const fr = sel.querySelector('iframe'), E = THEME.embed;
      rows.push(`<div class="row"><label>${t('props.embed')}</label><textarea data-embed rows="3" placeholder="${H(t('props.embed_ph'))}">${H(fr ? fr.getAttribute('src') || '' : '')}</textarea></div>`, range('h', t('props.height_px'), num(cssv(E.var)) || E.def, E.min, E.max, E.step));
    }
    if (sp.image) rows.push(imgSelect(sel.querySelector('img'), imgRe(sp.image)));
    if (sp.image && THEME.images[sp.image] && THEME.images[sp.image].crop) rows.push(`<div class="actions"><button data-act="crop">${t('props.crop')}</button><button data-act="reroll">${t('props.reroll')}</button></div>`);
    if (sp.align) rows.push(`<div class="row"><label>${t('props.align')}</label><select data-align>${[['', t('props.align_l')], ['center', t('props.align_c')], ['end', t('props.align_r')]].map(([v, l]) => `<option value="${v}" ${v === cssv('--align') ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`);
    if (sp.roles) {
      const roles = Object.keys(sp.roles), cur = roles.find(r => sel.classList.contains(r)), fsd = sp.fs || { min: 12, max: 64 }, lsd = sp.ls || { min: 0, max: .4, step: .02 };
      rows.push(range('fs', t('props.size_px'), num(cssv('--fs')) || (cur && sp.roles[cur].fs) || 19, fsd.min, fsd.max, 1), range('ls', t('props.spacing_em'), num(cssv('--ls')) || 0, lsd.min, lsd.max, lsd.step));
      rows.push(`<div class="row"><label>${t('props.role')}</label><select data-role>${roles.map(r => `<option value="${r}" ${r === cur ? 'selected' : ''}>${H(L(sp.roles[r].label) || r)}</option>`).join('')}</select></div>`);
    }
    if (sp.reveal) rows.push(`<div class="checks"><h3>${t('props.appear')}</h3>${chk(sel, 'reveal', t('props.reveal'))}</div>` + range('delay', t('props.delay_s'), num(cssv('--delay')), 0, 1.5, .05));
  }
  if (sp.layer !== 'ghosts' && sp.hide) {
    rows.push(`<div class="checks"><h3>${t('props.column')}</h3><label><input type="checkbox" data-cls="hide-m" data-where=""${sel.classList.contains('hide-m') ? ' checked' : ''}> ${t('props.hide_m')}</label><label><input type="checkbox" data-cls="hide-d" data-where=""${sel.classList.contains('hide-d') ? ' checked' : ''}> ${t('props.hide_d')}</label></div>
      <div class="actions"><button data-act="m-up">${t('props.m_up')}</button><button data-act="m-down">${t('props.m_down')}</button></div>`);
  }
  if (sp.dev) {
    // проявка: режимы наложения (для текста — только мягкие, остальные гасят текст на тёмном фоне)
    const modes = sp.blends === 'all' ? THEME.blends.all : sp.blends === 'none' ? [] : THEME.blends.all.filter(b => THEME.blends.soft.includes(b.v));
    const cur = cssv('--blend') || sp.blend_default;
    rows.push(`<div class="checks"><h3>${t('props.dev')}</h3></div>`);
    if (modes.length) rows.push(`<div class="row"><label>${t('props.blend')}</label><select data-blend>${modes.map(b => `<option value="${b.v}" ${b.v === cur ? 'selected' : ''}>${H(L(b.label) || b.v)}</option>`).join('')}</select></div>`);
    for (const [n, d] of Object.entries(THEME.dev)) { if (n === 'op' && sp.layer === 'ghosts') continue; rows.push(range(n, H(L(d.label) || n), cssv('--' + n) ? num(cssv('--' + n)) : d.def, d.min, d.max, d.step)); }
    rows.push(`<div class="checks"><label><input type="checkbox" data-dev="inv" ${cssv('--inv') === '1' ? 'checked' : ''}> ${t('props.invert')}</label>${sp.flip ? `<label><input type="checkbox" data-dev="flip" ${cssv('--flip') === '-1' ? 'checked' : ''}> ${t('props.flip')}</label>` : ''}</div><div class="actions"><button data-act="devreset">${t('props.devreset')}</button></div>`);
  }
  if (sp.edit === 'body' && !sp.bottom && !sp.generated) rows.push(`<p class="hint">${t('props.text_hint')}</p>`);
  else if (sp.edit === 'caption') rows.push(`<p class="hint">${t('props.caption_hint')}</p>`);
  if (sp.layer !== 'ghosts' && sp.shared) rows.push(`<div class="checks"><label><input type="checkbox" data-shared ${sel.classList.contains('shared') ? 'checked' : ''}> ${t('props.shared')}${sel.id ? ` <code>#${sel.id}</code>` : ''}</label></div>`);
  rows.push(`<div class="actions"><button data-act="dup">${t('props.dup')}</button><button data-act="del" class="danger">${t('props.del')}</button></div>`);
  propsEl.innerHTML = rows.join('');
  bindProps();

  function range(n, label, v, min, max, step) { return `<div class="row"><label>${label}</label><div class="pair"><input type="range" data-v="${n}" min="${min}" max="${max}" step="${step}" value="${v}"><span class="val">${v}</span></div></div>`; }
  function chk(el, cls, label, where) { return `<label><input type="checkbox" data-cls="${cls}" data-where="${where || ''}" ${el && el.classList.contains(cls) ? 'checked' : ''}> ${label}</label>`; }
  function imgSelect(img, re) {
    const cur = img ? img.getAttribute('src').replace(/^img\//, '') : '';
    const list = state.images.filter(n => !re || re.test(n));
    return `<div class="row"><label>${t('props.image')}</label><select data-img>${list.map(n => `<option ${n === cur ? 'selected' : ''}>${n}</option>`).join('')}${list.includes(cur) ? '' : `<option selected>${H(cur)}</option>`}</select></div>
      <div class="row"><label>${t('props.alt')}</label><input type="text" data-alt value="${H(img ? img.alt : '')}"></div>`;
  }
}
function bindProps() {
  const unit = { tilt: 'deg', w: '%', delay: 's', x: '%', y: '%', o: '', fs: 'px', ls: 'em', h: 'px' };   // range-ползунки: x/y/w только у призрака (%)
  for (const [n, d] of Object.entries(THEME.dev)) unit[n] = d.unit;
  propsEl.querySelectorAll('input[type=range]').forEach(inp => {
    inp.addEventListener('input', () => {
      inp.nextElementSibling.textContent = inp.value; const n = inp.dataset.v;
      if (THEME.dev[n] && parseFloat(inp.value) === THEME.dev[n].def) sel.style.removeProperty('--' + n); else sel.style.setProperty('--' + n, inp.value + unit[n]);
      if (n === 'x') sel.style.removeProperty('--rx'); if (THEME.dev[n]) updateDev(sel); refresh();
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
  const blend = propsEl.querySelector('[data-blend]'); if (blend) blend.addEventListener('change', () => { push(); const def = specOf(sel).blend_default; if (blend.value === def) sel.style.removeProperty('--blend'); else sel.style.setProperty('--blend', blend.value); updateDev(sel); refresh(); });
  propsEl.querySelectorAll('input[data-dev]').forEach(inp => inp.addEventListener('change', () => { push(); const n = inp.dataset.dev; if (inp.checked) sel.style.setProperty('--' + n, n === 'flip' ? '-1' : '1'); else sel.style.removeProperty('--' + n); updateDev(sel); refresh(); }));
  const em = propsEl.querySelector('[data-embed]'); if (em) em.addEventListener('change', () => {
    const src = embedSrc(em.value.trim());
    if (!src) return sayk('st.embed_bad', true);
    push(); sel.querySelector('iframe').setAttribute('src', src); em.value = src; sayk('st.embedded', false, { src });
  });
  const sh = propsEl.querySelector('[data-shared]'); if (sh) sh.addEventListener('change', () => {
    push(); sel.classList.toggle('shared', sh.checked);
    // общий блок синхронизируется по id — без id он не найдётся на других страницах
    if (sh.checked && !sel.id) { let n = 1; while (doc.getElementById(`s-${kind(sel)}-${n}`)) n++; sel.id = `s-${kind(sel)}-${n}`; }
    renderProps();
  });
  const al = propsEl.querySelector('[data-align]'); if (al) al.addEventListener('change', () => { push(); if (al.value) sel.style.setProperty('--align', al.value); else sel.style.removeProperty('--align'); });
  const ar = propsEl.querySelector('[data-ar]'); if (ar) ar.addEventListener('change', () => { push(); sel.style.setProperty('--ar', ar.value); refresh(); });
  const role = propsEl.querySelector('[data-role]'); if (role) role.addEventListener('change', () => { push(); sel.classList.remove(...Object.keys(specOf(sel).roles || {})); sel.classList.add(role.value); refresh(); });
  const img = propsEl.querySelector('[data-img]'); if (img) img.addEventListener('change', () => { push(); sel.querySelector('img').setAttribute('src', 'img/' + img.value); setTimeout(refresh, 150); });
  const alt = propsEl.querySelector('[data-alt]'); if (alt) alt.addEventListener('change', () => { push(); sel.querySelector('img').alt = alt.value; });
  propsEl.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => action(b.dataset.act)));
}
async function reroll(el) {
  // другой рисунок разрыва: сервер меняет seed в cutouts.txt и пересобирает PNG; картинка
  // перечитывается сбросом src (сервер шлёт no-store), без ?v= — он утёк бы в index.html
  const img = el.querySelector('img'); const name = (img.getAttribute('src') || '').replace(/^img\//, '').replace(/\.png$/, '');
  sayk('st.reroll_wait');
  const r = await api('/api/reroll?name=' + encodeURIComponent(name), { method: 'POST' });
  if (r.error) return fail(r);
  const src = img.getAttribute('src'); img.src = ''; img.src = src;
  say('seed ' + r.seed);
}
function action(a) {
  if (!sel) return;
  push();
  if (a === 'del') { const n = sel; select(null); n.remove(); updateSingles(); }
  else if (a === 'dup') { const c = sel.cloneNode(true); c.classList.remove('ed-sel', 'ed-bad'); sel.after(c); if (!isGhost(c)) { const p = placement(c); p.x += 24; p.y += 24; setPlacement(c, p); c.style.setProperty('--m', maxOrder() + 1); } select(c); }
  else if (a === 'layer-up') { const n = sel.nextElementSibling; if (n && !isBottom(n) && !n.dataset.ed) n.after(sel); }   // позже в DOM = выше
  else if (a === 'layer-down' && sel.previousElementSibling) sel.previousElementSibling.before(sel);
  else if (a === 'm-up' || a === 'm-down') { const o = byOrder(), i = o.indexOf(sel), j = a === 'm-up' ? i - 1 : i + 1; if (o[j]) swapOrder(sel, o[j]); }
  else if (a === 'reroll') return reroll(sel);
  else if (a === 'crop') return cropModal((sel.querySelector('img').getAttribute('src') || '').replace(/^img\//, '').replace(/\.png$/, ''));
  else if (a === 'devreset') { [...Object.keys(THEME.dev), 'blend', 'inv', 'flip'].forEach(n => sel.style.removeProperty('--' + n)); updateDev(sel); }
  refresh(); renderProps();
}
// .dev ставится, только если хоть одно значение проявки не дефолтное (иначе лишний stacking context)
function updateDev(el) {
  const vars = [...Object.keys(THEME.dev), 'blend', 'inv', 'flip'];
  el.classList.toggle('dev', vars.some(n => el.style.getPropertyValue('--' + n).trim() !== ''));
}
function bad(el) { el.classList.add('ed-bad'); setTimeout(() => el.classList.remove('ed-bad'), 500); sayk('st.overlap_bad', true); }
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
    const sp = specOf(t);
    if (sp.layer === 'ghosts') { if (isPhone()) return; drag = { el: t, ghost: true, sx: e.clientX, sy: e.clientY, x0: t.offsetLeft, y0: t.offsetTop, pushed: false }; return; }
    if (sp.bottom) return;
    if (isPhone()) { drag = { el: t, phone: true }; return; }     // в колонке тянем ради обмена --m
    const p = placement(t), r = t.getBoundingClientRect(), edge = 10;
    let mode = 'move';
    if (!sp.fullw) { if (e.clientX > r.right - edge) mode = 'e'; else if (e.clientX < r.left + edge) mode = 'w'; }
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
      const over = target(e); if (over && over !== drag.el && !isGhost(over) && !isBottom(over)) { push(); swapOrder(drag.el, over); }
    }
    drag.el.classList.remove('ed-bad'); drag = null; overlay.innerHTML = ''; refresh(); renderProps();
  });
  doc.addEventListener('dblclick', e => {
    const t = target(e); if (!t) return;
    const sp = specOf(t);
    if (sp.generated || sp.edit === 'none') return;
    if (sp.edit === 'caption') { const cap = e.target.closest('figcaption'); if (cap) edit(cap, e); return; }
    edit(sp.edit_sel ? t.querySelector(sp.edit_sel) || t : t, e);
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
  textbar.querySelector('[data-cmd="list"]').disabled = !listAllowed(el);
  placeTextbar(); textbar.hidden = false;
}
// правка заканчивается явно (Esc, клик мимо, выбор другого блока, сохранение), не по blur:
// клики по панели текста и её поле URL уводят фокус, и blur закрыл бы правку раньше команды
function endEdit() {
  if (!editing) return;
  const el = editing; editing = null;
  el.removeAttribute('contenteditable'); normalize(el);
  textbar.hidden = true; linkform.hidden = true;
  refresh(); sayk('st.text_changed');
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
  else if (b.dataset.cmd === 'list') { if (listAllowed(editing)) doc.execCommand('insertUnorderedList'); }
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
  if (!SAFE_URL.test(url) || /^javascript:/i.test(url)) return sayk('st.link_bad', true);
  if (savedRange && savedRange.collapsed) { const a = doc.createElement('a'); a.href = url; a.textContent = url; savedRange.insertNode(a); }
  else doc.execCommand('createLink', false, url);
});
function colorize(c) {                 // цвет — классом палитры на span; пустой c снимает цвет
  const r = currentRange(); if (!r || r.collapsed) return sayk('st.color_select');
  const root = r.commonAncestorContainer.nodeType === 1 ? r.commonAncestorContainer : r.commonAncestorContainer.parentElement;
  root.querySelectorAll('span[class^="c-"]').forEach(sp => { if (r.intersectsNode(sp)) unwrap(sp); });
  if (c) { const sp = doc.createElement('span'); sp.className = 'c-' + c; sp.appendChild(r.extractContents()); r.insertNode(sp); r.selectNodeContents(sp); }
  const s = doc.getSelection(); s.removeAllRanges(); s.addRange(r);
  function unwrap(n) { while (n.firstChild) n.parentNode.insertBefore(n.firstChild, n); n.remove(); }
}
// разрешённая разметка внутри текста: strong/em/a[href]/ul/li/br/p/h2/cite/span (KEEP_SPAN из темы); остальное разворачивается
const listAllowed = el => !!(el && el.parentElement === stage && specOf(el).list);   // списки и абзацы — только в блочных полях (list)
function normalize(el) {
  el.querySelectorAll('i').forEach(n => swap(n, 'em')); el.querySelectorAll('b').forEach(n => swap(n, 'strong'));
  if (listAllowed(el)) el.querySelectorAll(':scope > div').forEach(n => swap(n, 'p'));
  el.querySelectorAll('span, font').forEach(n => { if (!(n.tagName === 'SPAN' && [...n.classList].some(c => KEEP_SPAN.test(c)))) unwrap(n); });
  el.querySelectorAll('a').forEach(a => { const h = a.getAttribute('href') || ''; if (!h || !SAFE_URL.test(h) || /^javascript:/i.test(h)) unwrap(a); else { [...a.attributes].forEach(at => { if (at.name !== 'href' && at.name !== 'class') a.removeAttribute(at.name); }); } });
  if (!listAllowed(el)) el.querySelectorAll('ul, ol').forEach(unwrap);
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
  else if (sel && e.key.startsWith('Arrow') && !isGhost(sel) && !isBottom(sel) && !isPhone()) {
    e.preventDefault(); const p = placement(sel), st = e.shiftKey ? STEP : 1, d = { ArrowLeft: [-st, 0], ArrowRight: [st, 0], ArrowUp: [0, -st], ArrowDown: [0, st] }[e.key];
    if (specOf(sel).fullw) d[0] = 0;
    p.x += d[0]; p.y += d[1]; if (p.y < 0) return;        // стрелки минуют магнит
    if (collides(sel, p)) return bad(sel);
    push(); setPlacement(sel, p); refresh(); renderProps();
  }
}

/* ── палитра ────────────────────────────────────────────────────────── */
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
// блок из манифеста: type — id кнопки палитры или тип картинки (библиотека и загрузка передают тип)
function addBlock(type, img) {
  const b = blockFor(type); if (!b) return sayk('st.no_block', true, { id: type });
  const sp = spec(b.kind);
  if (b.pick && !img) { img = pickImage(b.pick); if (!img) return sayk('st.no_image', true); }
  if (sp.single && blocks().some(el => kind(el) === b.kind)) return sayk('st.single_exists', true);
  push();
  const tpl = doc.createElement('template'); tpl.innerHTML = blockHtml(b, img);
  const el = tpl.content.firstElementChild;
  if (sp.layer === 'ghosts') { ghosts.appendChild(el); }
  else {
    const f = bottomEl();
    const w = b.width || 400;
    const cr = canvas.getBoundingClientRect(), fr = ifr.getBoundingClientRect();
    const y = Math.max(0, Math.round((cr.top + cr.height / 2 - fr.top) / zoom - stage.offsetTop - 60));   // середина видимой части листа
    setPlacement(el, { x: Math.round((stageW() - w) / 2), y, w });
    el.style.setProperty('--m', maxOrder() + 1);
    f && f !== el ? f.before(el) : stage.appendChild(el);
  }
  setTimeout(() => { refresh(); select(el); el.scrollIntoView({ block: 'center' }); updateSingles(); }, 80);
}
$('#palette-add').addEventListener('click', e => { const b = e.target.closest('[data-add]'); if (b && !b.disabled) addBlock(b.dataset.add); });


/* ── фон и загрузка ─────────────────────────────────────────────────── */
$('#bg').addEventListener('change', async e => {
  sayk('st.bg_wait');
  const r = await api('/api/bg?name=' + encodeURIComponent(e.target.value), { method: 'POST' });
  if (r.error) return fail(r);
  state = r.state; if (r.state.theme) THEME.background = r.state.theme.background; doc.documentElement.style.setProperty('--bg-image', `url("img/bg-${e.target.value}.jpg?${Date.now()}")`); sayk('st.bg_set', false, { name: e.target.value });
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
  gc.query = q; gc.more.hidden = true; sayk('st.gif_searching', false, { q });
  try {
    const r = await api(`/api/gifsearch?q=${encodeURIComponent(q)}&flavor=${gc.flavor.value}&offset=${gc.offset}&limit=${gc.size}`, { nopage: true });
    if (r.error) return fail(r);
    for (const it of r.items) {
      const b = document.createElement('button'); b.type = 'button'; b.title = `${it.w}×${it.h}`; b.dataset.checksum = it.checksum;
      const im = document.createElement('img'); im.loading = 'lazy'; im.alt = ''; im.src = it.thumb; b.append(im); gc.grid.append(b);
    }
    gc.more.hidden = r.items.length < gc.size;
    const total = gc.grid.children.length;
    total ? sayk('st.gif_shown', false, { n: total }) : sayk('st.gif_none');
  } catch (e) { sayk('st.gif_fail', true, { e: e.message }); }
}
gc.grid.addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return;
  b.classList.add('busy'); sayk('st.gif_dl');
  try {
    const r = await api(`/api/gifsave?checksum=${b.dataset.checksum}&q=${encodeURIComponent(gc.query)}`, { method: 'POST' });
    if (r.error) return fail(r);
    state = r.state; addBlock('stamp', r.file); sayk('st.done_img', false, { f: r.file });
  } catch (err) { sayk('st.gif_dl_fail', true, { e: err.message }); }
  finally { b.classList.remove('busy'); }
});

async function upload(f) {
  const type = $('#uptype').value; sayk('st.uploading', false, { f: f.name, t: type });
  try {
    const r = await api(`/api/upload?type=${type}&name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f });
    if (r.error) return fail(r);
    state = r.state;
    if (type === 'bg') { $('#bg').innerHTML = state.backgrounds.map(b => `<option ${b === r.file.replace(/^bg-|\.jpg$/g, '') ? 'selected' : ''}>${b}</option>`).join(''); doc.documentElement.style.setProperty('--bg-image', `url("img/${r.file}?${Date.now()}")`); }
    else addBlock(type, r.file);
    sayk('st.done_img', false, { f: r.file });
    if (type === 'cutout') setTimeout(() => cropModal(r.file.replace(/\.png$/, '')), 400);   // сразу подобрать crop и точки
  } catch (e) { sayk('st.upload_fail', true, { e: e.message }); }
}

/* ── модальные окна ─────────────────────────────────────────────────── */
const modal = $('#modal'), mtitle = $('#mtitle'), mbody = $('#mbody');
function openModal(title, html) { mtitle.textContent = title; mbody.innerHTML = html; modal.hidden = false; }
function closeModal() { modal.hidden = true; mbody.innerHTML = ''; if (THEME && doc) THEME.colors.forEach(c => doc.documentElement.style.removeProperty('--' + c.id)); }
$('#mclose').addEventListener('click', closeModal);
modal.addEventListener('mousedown', e => { if (e.target === modal) closeModal(); });

/* ── обрезка вырезки: рамка crop, точки заливки, параметры → строка cutouts.txt ── */
async function cropModal(name) {
  const d = await api('/api/cutout?name=' + encodeURIComponent(name), { nopage: true });
  if (d.error) return fail(d);
  openModal(t('crop.title', { name }), `<div class="crop"><div><canvas id="cropc"></canvas><p class="hint">${t('crop.hint')}</p></div>
    <div class="side">
      <div class="row"><label>${t('crop.fuzz')} <b id="v-fuzz">${d.fuzz}</b></label><input type="range" id="c-fuzz" min="1" max="15" step=".5" value="${d.fuzz}"></div>
      <div class="row"><label>${t('crop.margin')} <b id="v-margin">${d.margin}</b></label><input type="range" id="c-margin" min="4" max="24" step="1" value="${d.margin}"></div>
      <div class="row"><label>${t('crop.width')} <b id="v-width">${d.width}</b></label><input type="range" id="c-width" min="120" max="480" step="10" value="${d.width}"></div>
      <div class="row"><label>${t('crop.seed')}</label><input type="number" id="c-seed" min="0" value="${d.seed}"> <button id="c-reseed" type="button">${t('crop.other')}</button></div>
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
    $('#c-info').textContent = t('crop.info', { w: crop.w, h: crop.h, x: crop.x, y: crop.y, n: seeds.length });
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
    if (!drag.move) { const before = seeds.length; seeds = seeds.map(([x, y]) => [x + drag.c0.x - c.x, y + drag.c0.y - c.y]).filter(([x, y]) => x >= 0 && y >= 0 && x < c.w && y < c.h); if (seeds.length < before) sayk('crop.seeds_trimmed'); }
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
    sayk('crop.wait'); $('#c-apply').disabled = true;
    const body = { name, crop, seeds, fuzz: +$('#c-fuzz').value, margin: +$('#c-margin').value, width: +$('#c-width').value, seed: +$('#c-seed').value };
    const r = await api('/api/cutout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), nopage: true });
    if (r.error) { $('#c-apply').disabled = false; return fail(r); }
    closeModal();
    doc.querySelectorAll(`img[src$="/${name}.png"], img[src="img/${name}.png"]`).forEach(im => { const src = im.getAttribute('src'); im.src = ''; im.src = src; });
    if (sel && kind(sel) === 'cutout') { push(); sel.style.setProperty('--w', body.width + 'px'); }
    setTimeout(() => { refresh(); renderProps(); }, 300); sayk('crop.done');
  });
}

/* ── библиотека картинок ────────────────────────────────────────────── */
async function libraryModal() {
  const r = await api('/api/library', { nopage: true }); if (r.error) return fail(r);
  const T_ = ty => L((THEME.images[ty] || {}).label) || (ty === 'none' ? t('lib.no_source') : ty);
  const ins = it => Object.keys(THEME.images).filter(ty => blockFor(ty) && (it.type === ty || it.type === 'none' && imgRe(ty) && imgRe(ty).test(it.name))).map(ty => `<button data-ins="${ty}">→ ${T_(ty)}</button>`).join('');
  openModal(t('lib.title'), `<div class="lib">${r.items.map(it => `<div class="it" data-name="${it.name}">
      <div class="th"><img src="img/${it.name}" alt="" loading="lazy"></div>
      <div class="nm">${it.name}</div><div>${T_(it.type)} · ${(it.size / 1024).toFixed(0)} ${t('lib.kb')}</div>
      <div class="${it.used.length ? 'used' : ''}">${it.used.length ? t('lib.used', { pages: it.used.join(', ') }) : t('lib.unused')}</div>
      <div class="acts">${ins(it)}${!it.used.length && !it.active_bg ? `<button class="danger" data-del title="${it.removes.join('\n')}">${t('lib.del')}</button>` : ''}</div>
    </div>`).join('')}</div>`);
  mbody.addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return; const name = b.closest('.it').dataset.name;
    if (b.dataset.ins) { closeModal(); addBlock(b.dataset.ins, name); return; }
    if ('del' in b.dataset) {
      const it = r.items.find(i => i.name === name);
      if (!confirm(t('lib.confirm', { list: it.removes.join('\n') }))) return;
      const x = await api('/api/delete?name=' + encodeURIComponent(name), { method: 'POST', nopage: true });
      if (x.error) return fail(x);
      state = x.state; sayk('lib.deleted', false, { list: x.removed.join(', ') }); libraryModal();
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
  if (ov.length) return sayk('save.overlap', true, { names: ov.map(blockName).join(', ') });
  sayk('save.saving');
  try {
    const r = await api('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stage: clean(stage), ghosts: clean(ghosts) }) });
    if (r.error) return fail(r);
    const n = await syncShared();
    statusEl.dataset.key = 'save.saved'; say(t('save.saved', { time: new Date().toLocaleTimeString() }) + (n ? t('save.shared', { n }) : ''));
  } catch (e) { sayk('st.server_down', true); }
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
        if (!specOf(c).fullw) c.style.setProperty('--x', '0px'); else c.style.removeProperty('--x');
        const f = [...st.children].find(isBottom); f && f !== c ? f.before(c) : st.appendChild(c); changed = true;
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
  if (hist.undo.length && !confirm(t('pages.unsaved_goto'))) { $('#pages').value = PAGE; return; }
  PAGE = slug; hist.undo.length = 0; hist.redo.length = 0; sel = null; editing = null; textbar.hidden = true;
  ifr.src = '/' + slug + '.html';
}
$('#pages').addEventListener('change', e => gotoPage(e.target.value));
$('#newpage').addEventListener('click', async () => {
  const name = prompt(t('pages.prompt')); if (!name) return;
  const slug = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug || slug === 'editor' || slug === 'kit') return sayk('pages.bad', true);
  // шаблон = index.html: остаются общие блоки и одно пустое поле; призраки копируются
  const html = await (await fetch('/index.html', { cache: 'no-store' })).text();
  const d = new DOMParser().parseFromString(html, 'text/html'), st = d.querySelector('main.stage');
  [...st.children].forEach(el => { if (!el.classList.contains('shared')) el.remove(); });
  st.querySelectorAll('a[href^="#"]').forEach(a => a.setAttribute('href', 'index.html' + a.getAttribute('href')));
  // первый блок новой страницы — из манифеста (new_page_block); заголовок = имя страницы
  const nb = blockFor(THEME.new_page_block) || THEME.blocks[0];
  const tpl = d.createElement('template'); tpl.innerHTML = nb ? blockHtml(nb, '') : '<section class="field reveal"><h2></h2><p></p></section>';
  const note = tpl.content.firstElementChild; const h = note.querySelector('h1,h2,h3'); if (h) h.textContent = slug;
  const maxM = [...st.children].reduce((m, el) => Math.max(m, parseFloat(el.style.getPropertyValue('--m')) || 0), 0);
  note.style.cssText = `--x: 320px; --y: 140px; --w: ${(nb && nb.width) || 520}px; --m: ${maxM + 1}`;
  const f = [...st.children].find(isBottom); f ? f.before(note) : st.appendChild(note);
  d.title = slug;
  const out = '<!doctype html>\n' + d.documentElement.outerHTML + '\n';
  const r = await api(`/api/page?page=${slug}`, { method: 'POST', body: out, nopage: true });
  if (r.error) return fail(r);
  state = r.state; $('#pages').innerHTML = state.pages.map(pg => `<option value="${pg}">${pg}.html</option>`).join('');
  $('#pages').value = slug; gotoPage(slug); sayk('pages.created', false, { slug });
});

/* ── бэкапы ─────────────────────────────────────────────────────────── */
$('#backups').addEventListener('click', async () => {
  const r = await api('/api/backups'); if (r.error) return fail(r);
  openModal(t('bk.title', { page: PAGE }), r.items.length ? `<table class="bk">${r.items.map(i => `<tr><td>${i.time}</td><td>${(i.size / 1024).toFixed(1)} ${t('lib.kb')}</td><td><button data-restore="${i.file}">${t('bk.restore')}</button></td></tr>`).join('')}</table>` : `<p class="hint">${t('bk.none')}</p>`);
  mbody.addEventListener('click', async e => {
    const b = e.target.closest('[data-restore]'); if (!b) return;
    if (!confirm(t('bk.confirm'))) return;
    const x = await api('/api/restore?file=' + encodeURIComponent(b.dataset.restore), { method: 'POST' });
    if (x.error) return fail(x);
    closeModal(); hist.undo.length = 0; ifr.src = '/' + PAGE + '.html'; sayk('bk.restored');
  });
});

/* ── ключ API и заливка на Neocities ────────────────────────────────── */
$('#push').addEventListener('click', async () => {
  const k = await api('/api/key', { nopage: true });
  const dry = await api('/api/push?dry=1', { method: 'POST', nopage: true }); if (dry.error) return fail(dry);
  openModal(t('push.title'), `<p class="hint">${t('push.files', { n: dry.files.length })}</p><pre class="files">${dry.files.join('\n')}</pre>
    <div class="row"><label>${t('push.key')} ${k.has ? t('push.key_has') : t('push.key_none')}</label><form id="keyform"><input type="password" id="keyval" placeholder="${k.has ? t('push.key_keep') : t('push.key_paste')}"><button type="submit">${t('push.key_save')}</button></form></div>
    <div class="actions"><button id="dopush" ${k.has ? '' : 'disabled'}>${t('push.now')}</button></div><pre id="pushlog"></pre>`);
  $('#keyform').addEventListener('submit', async e => { e.preventDefault(); const v = $('#keyval').value.trim(); if (!v) return; const x = await api('/api/key', { method: 'POST', body: v, nopage: true }); if (x.error) return fail(x); $('#dopush').disabled = false; $('#keyval').value = ''; sayk('push.key_saved'); });
  $('#dopush').addEventListener('click', async () => {
    if (hist.undo.length && !confirm(t('push.unsaved'))) return;
    $('#dopush').disabled = true; $('#pushlog').textContent = t('push.pushing');
    const x = await api('/api/push', { method: 'POST', nopage: true });
    $('#pushlog').textContent = x.error ? t('push.error', { e: x.error }) : t('push.result', { n: x.uploaded.length, list: x.uploaded.join(', ') || '—', skipped: x.skipped.length });
    $('#dopush').disabled = false; x.error ? fail(x) : sayk('push.done');
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
      if (n === 'w' && specOf(el).pixelw) continue;
      const v = parseFloat(el.style.getPropertyValue('--' + n)); if (!isNaN(v)) el.style.setProperty('--' + n, Math.round(v * k) + 'px');
    }
  }
}
$('#canvasbtn').addEventListener('click', () => {
  openModal(t('canvas.title'), `<p class="hint">${t('canvas.hint', { px: Math.ceil(settings.poster * .78) + 16 })}</p>
    <div class="row"><label>${t('canvas.poster')}</label><input type="number" id="s-poster" min="800" max="2400" step="10" value="${settings.poster}"></div>
    <div class="row"><label>${t('canvas.phone')}</label><input type="number" id="s-phone" min="320" max="520" step="10" value="${settings.phone}"></div>
    <div class="row"><label>${t('canvas.screen')}</label><div class="pair"><input type="number" id="s-screen" min="1000" max="3840" step="10" value="${settings.screen}"> × <input type="number" id="s-screenh" min="500" max="2160" step="10" value="${settings.screenh}"></div></div>
    <div class="checks"><label><input type="checkbox" id="s-scale" checked> ${t('canvas.scale')}</label></div>
    <div class="actions"><button id="s-apply">${t('apply')}</button></div>`);
  $('#s-apply').addEventListener('click', async () => {
    const body = { poster: +$('#s-poster').value, phone: +$('#s-phone').value, screen: +$('#s-screen').value, screenh: +$('#s-screenh').value }, rescale = $('#s-scale').checked;
    $('#s-apply').disabled = true;
    const r = await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), nopage: true });
    if (r.error) { $('#s-apply').disabled = false; return fail(r); }
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
    if (!rescale || k === 1) sayk('canvas.done', false, { p: settings.poster, ph: settings.phone, w: settings.screen, h: settings.screenh }); else sayk('canvas.scaled', false, { p: settings.poster, k: k.toFixed(3) });
    ifr.src = '/' + PAGE + '.html';          // новый layout.css
  });
});

/* ── тема: цвета, шрифты, фон, экранные слои, картинки → POST /api/theme → theme.css ─────── */
// правится только theme.css: после ответа сервера перечитывается один <link>, страница, история и выделение остаются
const DEF_MODE = { bg: 'dither', pic: 'dither', ghost: 'level', stamp: 'ordered' };
function toHex(v) {
  v = String(v || '').trim(); let m;
  if ((m = /^#([0-9a-f]{3})$/i.exec(v))) return '#' + [...m[1]].map(c => c + c).join('').toLowerCase();
  if ((m = /^#([0-9a-f]{6})/i.exec(v))) return '#' + m[1].toLowerCase();
  if ((m = /^rgba?\(\s*(\d+)\D+(\d+)\D+(\d+)/.exec(v))) return '#' + [m[1], m[2], m[3]].map(n => (+n).toString(16).padStart(2, '0')).join('');
  return '#000000';
}
function firstFamily(stack) { const m = /^\s*"([^"]+)"|^\s*([^,]+)/.exec(stack || ''); return m ? (m[1] || m[2]).trim() : ''; }
function stackWith(fam, stack, local) {          // выбранный шрифт первым; локальный сохраняет запасные, системный — только generic
  const tail = (stack || '').split(',').slice(1).map(x => x.trim()).filter(Boolean), generic = tail.length ? tail[tail.length - 1] : 'serif';
  const q = /[\s"]/.test(fam) ? `"${fam.replace(/"/g, '')}"` : fam, rest = (local.includes(fam) ? tail : [generic]).filter(x => x.replace(/"/g, '') !== fam);
  return [q, ...rest].join(', ');
}
function reloadThemeCss() {
  return new Promise(res => {
    const link = doc.querySelector('link[href*="theme.css"]'); if (!link) return res();
    const nl = link.cloneNode(); nl.href = 'theme.css?v=' + Date.now();
    nl.addEventListener('load', () => { link.remove(); res(); }); nl.addEventListener('error', () => res());
    link.after(nl);
  });
}
function reloadImages() {                        // пересобранные картинки: сброс src (сервер шлёт no-store)
  doc.querySelectorAll('img').forEach(im => { const src = im.getAttribute('src'); if (src && src.startsWith('img/')) { im.src = ''; im.src = src; } });
  doc.documentElement.style.setProperty('--bg-image', `url("img/bg-${THEME.background.active}.jpg?${Date.now()}")`);
}
function themeModal() {
  if (THEME.legacy) return sayk('theme.legacy', true);
  const H = x => String(x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const T = THEME;
  const fontOpts = cur => { const fam = firstFamily(cur); const opt = f => `<option value="${H(f)}" ${f === fam ? 'selected' : ''}>${H(f)}</option>`; return `<optgroup label="${t('theme.local')}">${T.fonts.local.map(opt).join('')}</optgroup><optgroup label="${t('theme.system')}">${T.fonts.system.map(opt).join('')}</optgroup>`; };
  const imgRows = Object.entries(T.images).filter(([, p]) => 'mode' in p);
  openModal(t('theme.title', { name: L(T.label) || T.name }), `<div class="theme">
    <h3>${t('theme.colors')}</h3>${T.colors.map(c => `<div class="row"><label>${H(L(c.label) || c.id)}</label><div class="pair"><input type="color" data-color="${c.id}" value="${toHex(c.value)}"><code>--${c.id}</code></div></div>`).join('')}
    ${Object.keys(T.fonts.stacks).length ? `<h3>${t('theme.fonts')}</h3>` + Object.entries(T.fonts.stacks).map(([k, v]) => `<div class="row"><label>${H(L(T.fonts.labels[k]) || k)}</label><select data-font="${k}" data-stack="${H(v)}">${fontOpts(v)}</select></div>`).join('') : ''}
    <h3>${t('theme.bg')}</h3><div class="row"><label>${t('theme.bg_img')}</label><select data-bg>${(state.backgrounds || []).map(b => `<option ${b === T.background.active ? 'selected' : ''}>${b}</option>`).join('')}</select></div>
    ${T.screen.length ? `<h3>${t('theme.screen')}</h3><div class="checks" style="grid-column:1/-1">${T.screen.map(x => `<label><input type="checkbox" data-layer="${x.id}" ${x.on !== false ? 'checked' : ''}> ${H(L(x.label) || x.id)}</label>`).join('')}</div>` : ''}
    ${imgRows.length ? `<h3>${t('theme.images')}</h3>` + imgRows.map(([typ, p]) => `<div class="row"><label>${H(L(p.label) || typ)}</label><div class="pair">${'colors' in p ? `<input type="number" data-icolors="${typ}" min="8" max="256" value="${p.colors}" title="${t('theme.dither_t')}"> <span class="val">${t('theme.colors_n')}</span>` : ''}<label><input type="checkbox" data-asis="${typ}" ${p.mode === 'asis' ? 'checked' : ''}> ${t('theme.asis')}</label></div></div>`).join('') : ''}
    ${T.warnings.length ? `<p class="warn">${T.warnings.map(H).join('<br>')}</p>` : ''}
    <p class="hint" style="grid-column:1/-1">${t('theme.hint')}</p>
    <div class="actions"><button id="th-apply">${t('apply')}</button><button id="th-cancel">${t('cancel')}</button></div></div>`);
  mbody.querySelectorAll('input[data-color]').forEach(inp => inp.addEventListener('input', () => doc.documentElement.style.setProperty('--' + inp.dataset.color, inp.value)));
  $('#th-cancel').addEventListener('click', closeModal);
  $('#th-apply').addEventListener('click', async () => {
    const patch = {
      colors: [...mbody.querySelectorAll('input[data-color]')].map(i => ({ id: i.dataset.color, value: i.value })),
      screen: Object.fromEntries([...mbody.querySelectorAll('input[data-layer]')].map(i => [i.dataset.layer, i.checked])),
      background: { active: mbody.querySelector('[data-bg]').value }, images: {},
    };
    const stacks = Object.fromEntries([...mbody.querySelectorAll('select[data-font]')].map(x => [x.dataset.font, stackWith(x.value, x.dataset.stack, T.fonts.local)]));
    if (Object.keys(stacks).length) patch.fonts = { stacks };
    mbody.querySelectorAll('input[data-icolors]').forEach(i => { (patch.images[i.dataset.icolors] ||= {}).colors = +i.value; });
    mbody.querySelectorAll('input[data-asis]').forEach(i => { const ty = i.dataset.asis, cur = T.images[ty].mode; (patch.images[ty] ||= {}).mode = i.checked ? 'asis' : (cur !== 'asis' ? cur : DEF_MODE[ty] || 'dither'); });
    $('#th-apply').disabled = true; sayk('theme.applying');
    const r = await api('/api/theme', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch), nopage: true });
    if (r.error) { $('#th-apply').disabled = false; return fail(r); }
    closeModal(); if (r.state) state = r.state; applyTheme(r.theme);
    $('#bg').innerHTML = (state.backgrounds || []).map(b => `<option value="${b}" ${b === THEME.background.active ? 'selected' : ''}>${b}</option>`).join('');
    await reloadThemeCss(); if (r.reprocessed && r.reprocessed.length) reloadImages();
    refresh(); renderProps();
    statusEl.dataset.key = 'theme.applied'; say(t('theme.applied') + (r.reprocessed && r.reprocessed.length ? t('theme.reprocessed', { n: r.reprocessed.length }) : ''));
  });
}
$('#themebtn').addEventListener('click', themeModal);

window.addEventListener('resize', () => overlay && refresh());
window.addEventListener('beforeunload', e => { if (hist.undo.length) { e.preventDefault(); e.returnValue = ''; } });
