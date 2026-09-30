"""adopt: перевод старого сайта (entropic division до afisha: tools/, токены и @font-face внутри style.css,
editor.* в корне) на раскладку afisha: _afisha/{site.json,cutouts.txt,backups,neocities.key,theme.json},
style.css без токенов, theme.css и layout.css сгенерированы, <link theme.css> на всех страницах.
Перед всем — полная копия папки в соседнюю <сайт>-adopt-<время> (никогда внутрь самой папки); при её неудаче adopt
не начинается. Идемпотентно: сайт с _afisha/theme.json пропускается. Извлечение из style.css — regex по рукописному
CSS, рассчитано на структуру темы forest; для чужих старых сайтов не обещается."""
import json, re, shutil, time
from pathlib import Path
from .errors import ApiError
from .site import Site
from . import theme, layout, images

FACE_RE = re.compile(r'@font-face\s*\{([^}]*)\}\s*', re.S)
ROOT_RE = re.compile(r':root\s*\{([^}]*)\}\s*', re.S)
FONT_SECTION_RE = re.compile(r'/\*\s*── шрифты.*?\*/\s*', re.S)
TOKEN_SECTION_RE = re.compile(r'/\*\s*── токены.*?\*/\s*', re.S)


def _decls(body):
    out = {}
    for d in re.sub(r'/\*.*?\*/', '', body, flags=re.S).split(';'):
        if ':' in d:
            k, v = d.split(':', 1); out[k.strip()] = re.sub(r'\s+', ' ', v.strip())
    return out


def extract_theme(css, base):
    """Манифест forest как основа + значения из style.css: цвета/vars/фон/стеки из :root, faces из @font-face."""
    t = json.loads(json.dumps(base))
    root = {}
    for m in ROOT_RE.finditer(css): root.update(_decls(m.group(1)))
    known = {c['id'] for c in t['colors']}
    for k, v in root.items():
        if not k.startswith('--'): continue
        name = k[2:]
        if name in known:
            for c in t['colors']:
                if c['id'] == name: c['value'] = v
        elif name == 'bg-image':
            m = re.search(r'bg-([a-z0-9-]+)\.jpg', v)
            if m: t['background']['active'] = m.group(1)
        elif name in t['fonts']['stacks']: t['fonts']['stacks'][name] = v
        else: t.setdefault('vars', {})[name] = v
    if root.get('color-scheme') in ('dark', 'light'): t['color_scheme'] = root['color-scheme']
    faces = []
    for m in FACE_RE.finditer(css):
        d = _decls(m.group(1)); fam = (d.get('font-family') or '').strip('"\''); src = re.search(r'url\(["\']?([^)"\']+)', d.get('src', ''))
        if not fam or not src: continue
        f = {'family': fam, 'file': src.group(1)}
        if d.get('font-style'): f['style'] = d['font-style']
        if d.get('font-weight'): f['weight'] = d['font-weight']
        if d.get('unicode-range'): f['range'] = d['unicode-range']
        faces.append(f)
    if faces: t['fonts']['faces'] = faces
    return t


def strip_tokens(css, t):
    """style.css без @font-face и :root; структурные rgba(цвет темы, a) → color-mix через токен."""
    css = FONT_SECTION_RE.sub('', css); css = TOKEN_SECTION_RE.sub('', css)
    css = FACE_RE.sub('', css)
    css = ROOT_RE.sub(lambda m: '' if '--' in m.group(1) else m.group(0), css)
    css = css.replace('/* ── база', '/* ── шрифты и токены — в theme.css (генерируется из _afisha/theme.json) ─────────── */\n\n/* ── база', 1)
    for c in t['colors']:
        m = re.fullmatch(r'#([0-9a-f]{6})', c['value'].lower())
        if not m: continue
        r, g, b = (int(m.group(1)[i:i + 2], 16) for i in (0, 2, 4))
        pat = re.compile(rf'rgba\(\s*{r}\s*,\s*{g}\s*,\s*{b}\s*,\s*(0?\.\d+|1)\s*\)')
        css = pat.sub(lambda mm: f'color-mix(in srgb, var(--{c["id"]}) {round(float(mm.group(1)) * 100):g}%, transparent)', css)
    return css


def add_link(html):
    if 'theme.css' in html: return html
    return html.replace('<link rel="stylesheet" href="style.css">', '<link rel="stylesheet" href="style.css">\n<link rel="stylesheet" href="theme.css">', 1)


def adopt(root, say=print):
    root = Path(root).resolve()
    if (root / '_afisha' / 'theme.json').exists(): raise ApiError('сайт уже на afisha (_afisha/theme.json есть)')
    if not (root / 'style.css').exists(): raise ApiError('нет style.css')
    backup = root.parent / f'{root.name}-adopt-{time.strftime("%Y%m%d-%H%M%S")}'
    try: shutil.copytree(root, backup, symlinks=True)
    except OSError as e: raise ApiError(f'не удалось сделать копию в {backup}: {e}', 'adopt не начат')
    say('копия сайта:', backup)
    site = Site(root); site.meta.mkdir(exist_ok=True)
    tools = root / 'tools'
    moved = []
    for name in ('site.json', 'cutouts.txt', 'neocities.key', 'backups'):
        src, dst = tools / name, site.meta / name
        if not src.exists(): continue
        if dst.exists():
            # запуск в legacy-режиме успевает создать пустой cutouts.txt и site.json по умолчанию — они уступают tools/
            empty = (name == 'cutouts.txt' and not images.cutout_lines(site)) or (name == 'site.json' and not site.settings_all())
            if not empty: say('  оставлен существующий _afisha/' + name); continue
            dst.unlink() if dst.is_file() else shutil.rmtree(dst)
        shutil.move(str(src), str(dst)); moved.append(name)
    say('в _afisha/:', ', '.join(moved) or 'ничего (tools/ пуст)')
    css = site.read(root / 'style.css')
    t = extract_theme(css, theme.template_theme())
    html_index = site.read(root / 'index.html')
    m = re.search(r'<title>(.*?)</title>', html_index, re.S); title = m.group(1).strip() if m else root.name
    m = re.search(r'<html[^>]*\blang="([^"]+)"', html_index); lang = m.group(1) if m else 'ru'
    s = site.settings_all(); s.setdefault('title', title); s.setdefault('lang', lang); site.settings_write(s)
    theme.validate(t, site)
    site.write(site.meta / 'theme.json', json.dumps(t, ensure_ascii=False, indent=1) + '\n')
    say('тема:', t['name'], '| цветов:', len(t['colors']), '| шрифтов:', len(t['fonts'].get('faces', [])), '| фон:', t['background']['active'])
    site.write(root / 'style.css', strip_tokens(css, t))
    theme.ensure_theme_css(site); layout.ensure_layout(site)
    n = 0
    for p in root.glob('*.html'):
        if p.stem == 'editor': continue
        h = site.read(p); h2 = add_link(h)
        if h2 != h: site.write(p, h2); n += 1
    say('theme.css подключён на страницах:', n)
    removed = []
    for name in ('editor.html', 'editor.css', 'editor.js'):
        if (root / name).exists(): (root / name).unlink(); removed.append(name)
    if tools.exists():
        leftover = [p.name for p in tools.iterdir()]
        shutil.rmtree(tools); removed.append('tools/ (' + ', '.join(leftover) + ')')
    say('удалено:', ', '.join(removed) or 'ничего')
    gi = root / '.gitignore'
    txt = site.read(gi) if gi.exists() else ''
    if '_afisha/neocities.key' not in txt: site.write(gi, txt.rstrip('\n') + ('\n' if txt else '') + '_afisha/neocities.key\n_afisha/lock\n_afisha/backups/\n')
    say('готово. Открыть: python3 afisha.py', str(root))
    return t
