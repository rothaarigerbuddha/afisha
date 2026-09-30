"""Тема сайта: манифест _afisha/theme.json → theme.css (токены, @font-face, фон, экранные слои) и данные для
редактора (/api/state.theme). style.css темы — только структура; всё, что правит панель «тема», живёт здесь.
Сайт без theme.json (старый, до adopt) — «legacy»: манифест берётся из шаблона forest, фон — regex по style.css."""
import copy, json, re, time
from html.parser import HTMLParser
from pathlib import Path
from .errors import ApiError
from . import images

HERE = Path(__file__).resolve().parent.parent
TEMPLATE_THEME = HERE / 'templates' / 'forest' / '_afisha' / 'theme.json'
ID_RE = re.compile(r'[a-z][a-z0-9-]*')
COLOR_RE = re.compile(r'#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?([0-9a-fA-F]{2})?$|rgba?\([\d.,\s%]+\)$|hsla?\([\d.,\s%deg]+\)$')
IMAGE_LIM = {'width': (400, 3000), 'colors': (8, 256), 'quality': (50, 95), 'max': (16, 1000), 'tint_pct': (0, 100)}
IMAGE_MODES = {'dither', 'level', 'ordered', 'asis'}
BLOCK_TAGS = {'section', 'figure', 'blockquote', 'p', 'div', 'nav', 'header', 'footer', 'h2', 'h3', 'img', 'figcaption', 'cite', 'span', 'a', 'iframe', 'ul', 'ol', 'li', 'strong', 'em', 'br', 'dl', 'dt', 'dd'}
BG_RE = re.compile(r'--bg-image:\s*url\("img/bg-([^"]+)\.jpg"\)')
SYSTEM_FONTS = ['Georgia', 'Times New Roman', 'Garamond', 'Palatino', 'serif', 'Arial', 'Helvetica', 'Verdana', 'Trebuchet MS', 'sans-serif',
                'Courier New', 'Consolas', 'Lucida Console', 'monospace', 'Impact', 'Comic Sans MS', 'cursive', 'system-ui']


# ── загрузка ───────────────────────────────────────────────────────────
def template_theme():
    return json.loads(TEMPLATE_THEME.read_text(encoding='utf-8'))


def load(site):
    """→ (theme, error, legacy). Ошибка валидации не роняет сервер: тема из шаблона + текст ошибки в state."""
    f = site.meta / 'theme.json'
    if not f.exists():
        return template_theme(), None, True
    try:
        t = json.loads(site.read(f))
        validate(t, site)
        return t, None, False
    except (ValueError, ApiError) as e:
        return template_theme(), f'theme.json: {getattr(e, "msg", e)}', False


def spec(t, kind):
    d = dict(t.get('defaults', {}))
    for k in t['kinds']:
        if k['kind'] == kind: d.update(k); return d
    return None


# ── валидация ─────────────────────────────────────────────────────────
class _Root(HTMLParser):
    def __init__(self): super().__init__(); self.root = None; self.depth = 0; self.tags = set(); self.roots = 0
    def handle_starttag(self, tag, attrs):
        self.tags.add(tag)
        if self.depth == 0: self.root = (tag, dict(attrs)); self.roots += 1
        if tag not in ('img', 'br'): self.depth += 1
    def handle_endtag(self, tag):
        if tag not in ('img', 'br'): self.depth -= 1


def _matches(sel, tag, attrs):
    """Мини-селектор: `*`, `tag`, `.class`, `[attr]` и их сцепка (`tag.a.b[attr]`)."""
    if sel == '*': return True
    m = re.fullmatch(r'([a-z][a-z0-9]*)?((?:\.[\w-]+|\[[\w-]+\])*)', sel)
    if not m: raise ApiError(f'kinds: селектор «{sel}» — поддерживаются tag, .class, [attr] и их сцепка')
    if m.group(1) and m.group(1) != tag: return False
    classes = set((attrs.get('class') or '').split())
    for part in re.findall(r'\.[\w-]+|\[[\w-]+\]', m.group(2)):
        if part.startswith('.') and part[1:] not in classes: return False
        if part.startswith('[') and part[1:-1] not in attrs: return False
    return True


def resolve_kind(t, tag, attrs):
    for k in t['kinds']:
        if _matches(k['match'], tag, attrs): return k['kind']
    return None


def validate(t, site=None):
    err = lambda m: (_ for _ in ()).throw(ApiError(m))
    if t.get('afisha') != 1: err('afisha: ожидается 1')
    if not ID_RE.fullmatch(str(t.get('name', ''))): err('name: латиница, цифры, дефис')
    ids = set()
    for c in t.get('colors', []):
        if not ID_RE.fullmatch(str(c.get('id', ''))): err(f'colors: плохой id «{c.get("id")}»')
        if c['id'] in ids: err(f'colors: id «{c["id"]}» дважды')
        ids.add(c['id'])
        if not COLOR_RE.match(str(c.get('value', ''))): err(f'colors.{c["id"]}: цвет должен быть #rrggbb или rgb()/rgba()')
    for k, v in t.get('vars', {}).items():
        if not ID_RE.fullmatch(k): err(f'vars: плохое имя «{k}»')
        if re.search(r'[;{}]|url\(|@import|expression', str(v)): err(f'vars.{k}: недопустимые символы')
    fonts = t.get('fonts', {})
    for f in fonts.get('faces', []):
        if not f.get('family') or ';' in f['family']: err('fonts.faces: family обязателен')
        file = str(f.get('file', ''))
        if not file.startswith('fonts/') or '..' in file or not re.fullmatch(r'fonts/[\w.-]+\.(woff2|woff|ttf|otf)', file): err(f'fonts.faces: файл «{file}» должен лежать в fonts/')
        if site and not (site.root / file).exists(): err(f'fonts.faces: нет файла {file}')
    for k, v in fonts.get('stacks', {}).items():
        if not ID_RE.fullmatch(k) or re.search(r'[;{}]|url\(', str(v)): err(f'fonts.stacks.{k}: недопустимо')
    bg = t.get('background', {}).get('active', '')
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]*', str(bg)): err('background.active: имя фона — латиница, цифры, дефис')
    if site and site.src.is_dir() and not (site.src / 'bg' / f'{bg}.jpg').exists(): err(f'background.active: нет src/bg/{bg}.jpg')
    if t.get('color_scheme', 'dark') not in ('dark', 'light'): err('color_scheme: dark или light')
    for s in t.get('screen', []):
        if not ID_RE.fullmatch(str(s.get('id', ''))) or not re.fullmatch(r'[.#]?[\w-]+', str(s.get('sel', ''))): err('screen: id и простой селектор обязательны')
    for sel in t.get('edit', {}).get('silence', []):
        if re.search(r'[;{}]', sel): err('edit.silence: недопустимый селектор')
    if re.search(r'</|@import|url\(', t.get('edit', {}).get('css', '')): err('edit.css: только правила без url/@import')
    for typ, p in t.get('images', {}).items():
        if typ not in images.TYPES: err(f'images: неизвестный тип «{typ}»')
        if 'mode' in p and p['mode'] not in IMAGE_MODES: err(f'images.{typ}.mode: один из {sorted(IMAGE_MODES)}')
        for k, (lo, hi) in IMAGE_LIM.items():
            if k in p:
                try: v = int(p[k])
                except (TypeError, ValueError): err(f'images.{typ}.{k}: нужно целое число')
                if not lo <= v <= hi: err(f'images.{typ}.{k}: допустимо {lo}…{hi}')
        for k in ('paper', 'tint', 'edge'):
            if k in p and not COLOR_RE.match(str(p[k])): err(f'images.{typ}.{k}: цвет')
        if 'match' in p:
            try: re.compile(p['match'])
            except re.error: err(f'images.{typ}.match: плохое регулярное выражение')
    for c in t.get('text', {}).get('palette', []):
        if c not in ids: err(f'text.palette: нет цвета «{c}»')
    kinds = [k.get('kind') for k in t.get('kinds', [])]
    if not kinds: err('kinds: пусто')
    for k in t['kinds']:
        if not ID_RE.fullmatch(str(k.get('kind', ''))): err(f'kinds: плохое имя «{k.get("kind")}»')
        if kinds.count(k['kind']) > 1: err(f'kinds: «{k["kind"]}» дважды')
        if not isinstance(k.get('match'), str) or not k['match']: err(f'kinds.{k["kind"]}: нужен match')
        _matches(k['match'], 'div', {})       # синтаксис
    for e in t.get('effects', []):
        for k in e.get('kinds', []):
            if k not in kinds: err(f'effects.{e.get("cls")}: нет вида «{k}»')
    bids = set()
    for b in t.get('blocks', []):
        if not ID_RE.fullmatch(str(b.get('id', ''))): err(f'blocks: плохой id «{b.get("id")}»')
        if b['id'] in bids: err(f'blocks: id «{b["id"]}» дважды')
        bids.add(b['id'])
        if b.get('kind') not in kinds: err(f'blocks.{b["id"]}: нет вида «{b.get("kind")}»')
        html = str(b.get('html', ''))
        pr = _Root(); pr.feed(html)
        if pr.roots != 1 or not pr.root: err(f'blocks.{b["id"]}.html: ровно один корневой элемент')
        bad = pr.tags - BLOCK_TAGS
        if bad: err(f'blocks.{b["id"]}.html: теги {sorted(bad)} не разрешены')
        if re.search(r'<script|on\w+=|javascript:', html, re.I): err(f'blocks.{b["id"]}.html: скрипты запрещены')
        if '{img}' in html and not b.get('pick'): err(f'blocks.{b["id"]}: {{img}} требует pick')
        if b.get('pick') and b['pick'] not in t.get('images', {}): err(f'blocks.{b["id"]}.pick: нет типа картинок «{b["pick"]}»')
        got = resolve_kind(t, *pr.root)
        if got != b['kind']: err(f'blocks.{b["id"]}: html распознаётся как «{got}», а не «{b["kind"]}» (порядок kinds)')
    if t.get('new_page_block') and t['new_page_block'] not in bids: err('new_page_block: нет такого блока')
    return True


# ── генерация theme.css ───────────────────────────────────────────────
def theme_css(t):
    out = [f'/* theme.css — генерируется afisha из _afisha/theme.json (тема {t["name"]}). Руками не править:\n'
           f'   цвета, шрифты, фон и экранные слои меняются в редакторе (кнопка «тема»). Структура — в style.css. */\n']
    for f in t.get('fonts', {}).get('faces', []):
        d = [f'font-family: "{f["family"]}"', f'src: url({f["file"]}) format("{"woff2" if f["file"].endswith("woff2") else "truetype" if f["file"].endswith("ttf") else "woff" if f["file"].endswith("woff") else "opentype"}")']
        if f.get('style'): d.append(f'font-style: {f["style"]}')
        if f.get('weight'): d.append(f'font-weight: {f["weight"]}')
        if f.get('range'): d.append(f'unicode-range: {f["range"]}')
        d.append('font-display: swap')
        out.append('@font-face { ' + '; '.join(d) + '; }\n')
    out.append(':root {\n')
    for c in t['colors']: out.append(f'  --{c["id"]}: {c["value"]};\n')
    for k, v in t.get('vars', {}).items(): out.append(f'  --{k}: {v};\n')
    out.append(f'  --bg-image: url("img/bg-{t["background"]["active"]}.jpg");\n')
    for k, v in t.get('fonts', {}).get('stacks', {}).items(): out.append(f'  --{k}: {v};\n')
    out.append(f'  color-scheme: {t.get("color_scheme", "dark")};\n}}\n')
    off = [s['sel'] for s in t.get('screen', []) if not s.get('on', True)]
    if off: out.append(f'/* выключенные экранные слои */\n{", ".join(off)} {{ display: none; }}\n')
    return ''.join(out)


def ensure_theme_css(site):
    t, err, legacy = load(site)
    if legacy: return
    css = theme_css(t); f = site.root / 'theme.css'
    if not f.exists() or site.read(f) != css: site.write(f, css)


# ── для клиента ───────────────────────────────────────────────────────
def client_theme(site):
    t, err, legacy = load(site)
    c = copy.deepcopy(t); c.pop('cursors', None)
    faces = c.get('fonts', {}).pop('faces', [])
    c.setdefault('fonts', {})['local'] = sorted({f['family'] for f in faces})
    c['fonts']['system'] = SYSTEM_FONTS
    c['legacy'] = legacy
    if legacy: c['background'] = {'active': legacy_background(site)}
    return c, err


# ── фон ───────────────────────────────────────────────────────────────
def legacy_background(site):
    css = site.read(site.root / 'style.css') if (site.root / 'style.css').exists() else ''
    m = BG_RE.search(css)
    return m.group(1) if m else None


def background(site):
    t, err, legacy = load(site)
    return legacy_background(site) if legacy else t['background']['active']


def backgrounds(site):
    return sorted(p.stem for p in (site.src / 'bg').glob('*.jpg')) if (site.src / 'bg').is_dir() else []


def set_bg(site, q):
    name = q.get('name', [''])[0]
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]*', name) or not (site.src / 'bg' / f'{name}.jpg').exists(): raise ApiError('нет такого фона в src/bg')
    t, err, legacy = load(site)
    if legacy:
        with images.PROCESS_LOCK: images.process_all(site, active_bg=name, only={'bg'})
        css_p = site.root / 'style.css'; css = site.read(css_p)
        css, n = BG_RE.subn(f'--bg-image: url("img/bg-{name}.jpg")', css, count=1)
        if not n: raise ApiError('в style.css не найден --bg-image')
        site.write(css_p, css)
        return {'ok': True}
    return theme_set(site, {'background': {'active': name}})


# ── правка темы из редактора ──────────────────────────────────────────
def _merge(t, patch):
    """Патч верхнего уровня: colors — по id (value), screen — по id (on), images — по типу (поля), остальное — замена/слияние словарей."""
    for key, val in patch.items():
        if key == 'colors':
            byid = {c['id']: c for c in t['colors']}
            for c in val:
                if c.get('id') in byid: byid[c['id']]['value'] = c.get('value', byid[c['id']]['value'])
                else: t['colors'].append(c)
        elif key == 'screen':
            byid = {s['id']: s for s in t.get('screen', [])}
            items = val if isinstance(val, list) else [{'id': k, 'on': v} for k, v in val.items()]
            for s in items:
                if s.get('id') in byid: byid[s['id']]['on'] = bool(s.get('on', True))
        elif key == 'images':
            for typ, p in val.items(): t.setdefault('images', {}).setdefault(typ, {}).update(p)
        elif key == 'fonts':
            for k in ('stacks', 'labels'):
                if k in val: t.setdefault('fonts', {}).setdefault(k, {}).update(val[k])
            if 'faces' in val: t['fonts']['faces'] = val['faces']
        elif isinstance(val, dict) and isinstance(t.get(key), dict): t[key].update(val)
        else: t[key] = val
    return t


def theme_set(site, patch):
    f = site.meta / 'theme.json'
    if not f.exists(): raise ApiError('у этого сайта нет _afisha/theme.json', 'старый сайт: сначала adopt')
    if not isinstance(patch, dict): raise ApiError('тема: ожидается объект')
    old = json.loads(site.read(f)); new = _merge(copy.deepcopy(old), patch)
    validate(new, site)
    site.backups_dir.mkdir(parents=True, exist_ok=True)
    (site.backups_dir / f'theme__{time.strftime("%Y%m%d-%H%M%S")}.json').write_text(json.dumps(old, ensure_ascii=False, indent=1), encoding='utf-8')
    for stale in sorted(site.backups_dir.glob('theme__*.json'))[:-20]: stale.unlink()
    site.write(f, json.dumps(new, ensure_ascii=False, indent=1) + '\n')
    ensure_theme_css(site)
    reprocessed = []
    only = set()
    for typ in patch.get('images', {}):
        if {k: v for k, v in old['images'].get(typ, {}).items() if k not in ('label', 'match', 'upload', 'crop', 'gifsearch')} != {k: v for k, v in new['images'][typ].items() if k not in ('label', 'match', 'upload', 'crop', 'gifsearch')}:
            only.add(typ)
    bg_changed = old['background']['active'] != new['background']['active']
    if bg_changed: only.add('bg')
    if only:
        with images.PROCESS_LOCK:
            reprocessed = images.process_all(site, images_cfg(site), cursors_cfg(site), active_bg=new['background']['active'], only=only)
    return {'ok': True, 'theme': client_theme(site)[0], 'reprocessed': reprocessed}


def images_cfg(site):
    t, err, legacy = load(site)
    cfg = copy.deepcopy(images.IMAGES_DEF)
    for typ, p in t.get('images', {}).items(): cfg.setdefault(typ, {}).update(p)
    return cfg


def cursors_cfg(site):
    t, err, legacy = load(site)
    return t.get('cursors') or None
