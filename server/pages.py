"""Страницы: сохранение содержимого .stage/.ghosts, создание, бэкапы, восстановление."""
import json, os, re, shutil, time
from .errors import ApiError

STAGE_RE = re.compile(r'(<main class="stage">).*?(</main>)', re.S)
GHOSTS_RE = re.compile(r'(<div class="ghosts"[^>]*>).*?(</div>)', re.S)


def save(site, q, body):
    page = site.page_of(q)
    data = json.loads(body)
    html = site.read(page)
    n1 = n2 = 0
    if 'stage' in data:
        html, n1 = STAGE_RE.subn(lambda m: m.group(1) + data['stage'] + m.group(2), html, count=1)
    if 'ghosts' in data:
        html, n2 = GHOSTS_RE.subn(lambda m: m.group(1) + data['ghosts'] + m.group(2), html, count=1)
    if 'stage' in data and not n1 or 'ghosts' in data and not n2:
        raise ApiError(f'в {page.name} не найден <main class="stage"> или <div class="ghosts">', 'страница правилась руками? маркеры обязательны')
    site.backup(page)
    site.write(page, html)
    return {'ok': True, 'bytes': len(html)}


def page_create(site, q, body):
    """Новая страница: HTML собирает редактор (копия index с общими блоками), сервер только пишет файл."""
    page = site.page_of(q, must_exist=False)
    if page.exists(): raise ApiError('страница уже есть: ' + page.name)
    html = body.decode('utf-8')
    if '<main class="stage">' not in html or '<div class="ghosts"' not in html: raise ApiError('в HTML нет .stage / .ghosts')
    site.write(page, html)
    return {'ok': True, 'page': page.stem}


def backups(site, q):
    page = site.page_of(q)
    d = site.backups_dir
    files = sorted(d.glob(f'{page.stem}__*.html'), reverse=True) if d.exists() else []
    return {'ok': True, 'items': [{'file': f.name, 'time': time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(f.stat().st_mtime)), 'size': f.stat().st_size} for f in files]}


def restore(site, q):
    page = site.page_of(q)
    name = os.path.basename(q.get('file', [''])[0])
    src = site.backups_dir / name
    if not name.startswith(page.stem + '__') or not src.exists(): raise ApiError('нет такого бэкапа для этой страницы')
    site.backup(page)                       # текущая версия тоже сохраняется
    shutil.copy(src, page)
    return {'ok': True}
