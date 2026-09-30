"""Папка сайта: пути, чтение/запись (всегда utf-8, LF), страницы, бэкапы, настройки холста.
Метаданные редактора живут в <сайт>/_afisha/ (не публикуется и не отдаётся сервером)."""
import json, re, shutil, time
from pathlib import Path
from .errors import ApiError

PAGE_RE = re.compile(r'[a-z0-9][a-z0-9-]{0,40}')
RESERVED = {'editor', 'kit', '_editor'}
IMG_EXT = {'.png', '.jpg', '.jpeg', '.gif', '.webp'}
SETTINGS_DEF = {'poster': 1400, 'phone': 400, 'screen': 1920, 'screenh': 1080}   # афиша, превью телефона, экран посетителя, px
SETTINGS_LIM = {'poster': (800, 2400), 'phone': (320, 520), 'screen': (1000, 3840), 'screenh': (500, 2160)}
KEEP_BACKUPS = 20


class Site:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.meta = self.root / '_afisha'
        self.img = self.root / 'img'
        self.src = self.root / 'src'
        self.backups_dir = self.meta / 'backups'
        self.settings_file = self.meta / 'site.json'
        self.layout_file = self.root / 'layout.css'
        self.cutouts_file = self.meta / 'cutouts.txt'
        self.key_file = self.meta / 'neocities.key'

    # ── файлы: только utf-8 и LF, иначе на Windows кириллица и переводы строк ломают страницы и push
    def read(self, p):
        return Path(p).read_text(encoding='utf-8')

    def write(self, p, text):
        Path(p).parent.mkdir(parents=True, exist_ok=True)
        with open(p, 'w', encoding='utf-8', newline='\n') as f: f.write(text)

    def ensure_meta(self):
        self.meta.mkdir(exist_ok=True)
        for d in ('bg', 'pic', 'ghost', 'stamp', 'cutout'): (self.src / d).mkdir(parents=True, exist_ok=True)
        self.img.mkdir(exist_ok=True)
        if not self.cutouts_file.exists():
            self.write(self.cutouts_file, '# Параметры вырезок: имя  crop(WxH+X+Y)  fuzz%  точки-заливки(x,y;x,y;...)  ширина-файла  [поле-бумаги]  [seed]\n'
                                          '# Точки заливки — в координатах ПОСЛЕ crop. Строка не перезаписывается редактором при повторной загрузке.\n')

    # ── страницы
    def page_of(self, q, must_exist=True):
        """?page=<slug> → файл страницы (по умолчанию index). Только имя без путей."""
        slug = q.get('page', ['index'])[0]
        if not PAGE_RE.fullmatch(slug) or slug in RESERVED: raise ApiError('плохое имя страницы: ' + slug, 'латиница, цифры и дефис; editor и kit заняты')
        f = self.root / f'{slug}.html'
        if must_exist and not f.exists(): raise ApiError('нет страницы ' + slug)
        return f

    def pages(self):
        return sorted(p.stem for p in self.root.glob('*.html') if p.stem not in RESERVED and PAGE_RE.fullmatch(p.stem))

    def backup(self, page):
        """Копия страницы в _afisha/backups/<slug>__<время>.html, хранится 20 последних на страницу."""
        self.backups_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy(page, self.backups_dir / f'{page.stem}__{time.strftime("%Y%m%d-%H%M%S")}.html')
        for old in sorted(self.backups_dir.glob(f'{page.stem}__*.html'))[:-KEEP_BACKUPS]:
            old.unlink()

    # ── настройки холста (_afisha/site.json)
    def settings(self):
        d = dict(SETTINGS_DEF)
        if self.settings_file.exists():
            try: d.update({k: int(v) for k, v in json.loads(self.read(self.settings_file)).items() if k in d})
            except (ValueError, AttributeError): pass
        return d

    def settings_all(self):
        """Весь site.json как есть (в нём кроме размеров живут title/lang/nav/asis)."""
        if self.settings_file.exists():
            try: return json.loads(self.read(self.settings_file))
            except ValueError: pass
        return {}

    def settings_write(self, d):
        self.meta.mkdir(exist_ok=True)
        self.write(self.settings_file, json.dumps(d, ensure_ascii=False) + '\n')

    def settings_set(self, body):
        from .layout import ensure_layout
        old = self.settings(); new = dict(self.settings_all()); new.update(old)
        for k, v in json.loads(body).items():
            if k not in SETTINGS_LIM: continue
            lo, hi = SETTINGS_LIM[k]
            try: v = int(v)
            except (TypeError, ValueError): raise ApiError(f'{k}: нужно целое число')
            if not lo <= v <= hi: raise ApiError(f'{k}: допустимо {lo}…{hi} px')
            new[k] = v
        self.settings_write(new); ensure_layout(self)
        return {'ok': True, 'old': old, 'new': {k: new[k] for k in SETTINGS_DEF}}
