"""Тема сайта. Пока (шаг 1) — только фон через regex по style.css, как в старом serve.py.
В шаге 3 здесь появится манифест _afisha/theme.json → theme.css."""
import re
from .errors import ApiError
from . import images

BG_RE = re.compile(r'--bg-image:\s*url\("img/bg-([^"]+)\.jpg"\)')


def background(site):
    css = site.read(site.root / 'style.css') if (site.root / 'style.css').exists() else ''
    m = BG_RE.search(css)
    return m.group(1) if m else None


def backgrounds(site):
    return sorted(p.stem for p in (site.src / 'bg').glob('*.jpg')) if (site.src / 'bg').is_dir() else []


def set_bg(site, q):
    name = q.get('name', [''])[0]
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]*', name) or not (site.src / 'bg' / f'{name}.jpg').exists(): raise ApiError('нет такого фона в src/bg')
    with images.PROCESS_LOCK:
        images.process_all(site, active_bg=name, only={'bg'})
    css_p = site.root / 'style.css'; css = site.read(css_p)
    css, n = BG_RE.subn(f'--bg-image: url("img/bg-{name}.jpg")', css, count=1)
    if not n: raise ApiError('в style.css не найден --bg-image')
    site.write(css_p, css)
    return {'ok': True}


def images_cfg(site):
    return images.IMAGES_DEF


def cursors_cfg(site):
    return images.CURSORS_DEF
