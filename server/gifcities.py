"""GifCities (архив гифок GeoCities от Internet Archive). Ищем через сам сайт gifcities.org: у него
новый индекс (режимы semantic / lexical / hybrid), а старый JSON-API ищет только по пути файла.
JSON у сайта нет, разбираем HTML блоков <div class="result"> — при смене вёрстки чинить здесь.
Запросы идут с этого компьютера прямо в archive.org; превью грузит браузер с blob.gifcities.org."""
import re, urllib.error, urllib.parse, urllib.request
from .errors import ApiError

GC_SEARCH = 'https://gifcities.org/special-search'
GC_BLOB = 'https://blob.gifcities.org/gifcities/{}.gif'
GC_RESULT = re.compile(r'<div class="result">(.*?)</div>', re.S)
GC_FLAVORS = {'hybrid', 'semantic', 'lexical'}


def _get(url, timeout=25):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (afisha editor)'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r: return r.read()
    except urllib.error.URLError as e:
        raise ApiError('gifcities.org не отвечает: ' + str(getattr(e, 'reason', e)), 'проверь интернет или попробуй позже')


def gifsearch(q):
    query = q.get('q', [''])[0].strip()
    if not query: raise ApiError('пустой запрос')
    offset, size = int(q.get('offset', ['0'])[0]), min(int(q.get('limit', ['24'])[0]), 200)
    flavor = q.get('flavor', ['hybrid'])[0]
    if flavor not in GC_FLAVORS: flavor = 'hybrid'
    html = _get(GC_SEARCH + '?' + urllib.parse.urlencode({'q': query, 'flavor': flavor, 'offset': offset, 'page_size': size})).decode('utf-8', 'replace')
    items = []
    for block in GC_RESULT.findall(html):
        m = re.search(r'gifcities/([A-Z0-9]{32})\.gif', block)
        if not m: continue
        w, h = re.search(r'width="(\d+)"', block), re.search(r'height="(\d+)"', block)
        page = re.search(r'href="(https://web\.archive\.org/[^"]+)"', block)
        items.append({'checksum': m.group(1), 'w': int(w.group(1)) if w else None, 'h': int(h.group(1)) if h else None,
                      'page': page.group(1) if page else '', 'thumb': GC_BLOB.format(m.group(1))})
    return {'ok': True, 'q': query, 'flavor': flavor, 'offset': offset, 'items': items}


def gifsave(site, q):
    """Скачать гифку в src/stamp как gc-<запрос>-<6 знаков checksum>.gif; обработку запускает вызывающий."""
    checksum, query = q.get('checksum', [''])[0], q.get('q', [''])[0]
    if not re.fullmatch(r'[A-Z0-9]{32}', checksum): raise ApiError('плохой checksum')
    slug = re.sub(r'[^a-z0-9]+', '-', query.lower()).strip('-')[:24] or 'gif'
    name = f'gc-{slug}-{checksum[:6].lower()}.gif'
    dst = site.src / 'stamp' / name
    if not dst.exists():
        body = _get(GC_BLOB.format(checksum), timeout=60)
        if not body.startswith(b'GIF8'): raise ApiError('gifcities отдал не GIF')
        dst.parent.mkdir(parents=True, exist_ok=True); dst.write_bytes(body)
    return name
