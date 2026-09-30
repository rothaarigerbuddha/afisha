"""Заливка на Neocities через REST API. Ключ — _afisha/neocities.key, в ответах API не появляется.
Уходит только явный allow-list файлов; _afisha/ и src/ — никогда."""
import hashlib, json, mimetypes, os, re, urllib.error, urllib.request, uuid
from .errors import ApiError
from .site import PAGE_RE

USER_AGENT = 'afisha editor'
NOT_PUBLISHED = {'kit'}           # каталог блоков темы остаётся локальным


def key_get(site):
    return {'ok': True, 'has': site.key_file.exists() and bool(site.read(site.key_file).strip())}


def key_set(site, body):
    k = body.decode().strip()
    if not re.fullmatch(r'[A-Za-z0-9_-]{16,128}', k): raise ApiError('ключ выглядит неправильно', 'neocities.org/settings → API key')
    site.write(site.key_file, k + '\n')
    try: os.chmod(site.key_file, 0o600)
    except OSError: pass                   # Windows
    return {'ok': True, 'has': True}


def publish_files(site):
    """Явный список того, что уходит на Neocities: страницы (кроме kit), style/theme/layout.css, favicon, fonts/, img/."""
    from .layout import ensure_layout
    ensure_layout(site)
    out = [p for p in site.root.glob('*.html') if p.stem not in NOT_PUBLISHED and PAGE_RE.fullmatch(p.stem)]
    out += [site.root / 'style.css', site.root / 'theme.css', site.layout_file]
    out += list(site.root.glob('favicon.*'))
    for d in ('fonts', 'img'):
        if (site.root / d).is_dir(): out += [p for p in sorted((site.root / d).iterdir()) if p.is_file() and not p.name.startswith('.')]
    return [p for p in out if p.exists()]


def _neocities(path, key, data=None, files=None):
    """Вызов API Neocities. data — обычные поля формы, files — {удалённый_путь: локальный Path}."""
    boundary = '----ed' + uuid.uuid4().hex
    parts = []
    for k, v in (data or {}).items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    for remote, local in (files or {}).items():
        ctype = mimetypes.guess_type(local.name)[0] or 'application/octet-stream'
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{remote}"; filename="{local.name}"\r\nContent-Type: {ctype}\r\n\r\n'.encode() + local.read_bytes() + b'\r\n')
    body = b''.join(parts) + f'--{boundary}--\r\n'.encode()
    req = urllib.request.Request('https://neocities.org/api/' + path, data=body, method='POST',
                                 headers={'Authorization': 'Bearer ' + key, 'Content-Type': f'multipart/form-data; boundary={boundary}', 'User-Agent': USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=120) as r: return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try: err = json.loads(e.read().decode())
        except Exception: err = {}
        raise ApiError(f"Neocities {e.code}: {err.get('error_type', '')} {err.get('message', '')}".strip())
    except urllib.error.URLError as e:
        raise ApiError('нет связи с neocities.org: ' + str(e.reason), 'проверь интернет')


def push(site, q):
    files = publish_files(site)
    rel = {p.relative_to(site.root).as_posix(): p for p in files}
    if q.get('dry', [''])[0]: return {'ok': True, 'dry': True, 'files': sorted(rel)}
    if not key_get(site)['has']: raise ApiError('нет ключа API', 'кнопка «ключ» в верхней панели (neocities.org/settings → API)')
    key = site.read(site.key_file).strip()
    hashes = {r: hashlib.sha1(p.read_bytes()).hexdigest() for r, p in rel.items()}
    same = _neocities('upload_hash', key, data=hashes).get('files', {})     # true = на сервере уже такой файл
    todo = [r for r in sorted(rel) if not same.get(r)]
    uploaded = []
    for i in range(0, len(todo), 20):
        chunk = todo[i:i + 20]
        _neocities('upload', key, files={r: rel[r] for r in chunk}); uploaded += chunk
    return {'ok': True, 'uploaded': uploaded, 'skipped': [r for r in sorted(rel) if r not in todo]}
