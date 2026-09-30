"""Конвейер картинок: src/<тип>/ → img/. Перенос tools/process.sh на Python: те же аргументы magick,
вызов списком без shell (работает на Windows с magick.exe). Идея прежняя: разнородный материал
становится одной серией, если пройти через один фильтр.
  bg      фоны          → дизеринг Флойда-Стейнберга, ширина 1600, JPEG (только активный фон)
  pic     фото в рамках → дизеринг, ширина 1400, JPEG
  ghost   призраки      → без дизеринга; «чёрный пол», чтобы screen-blend убирал фон
  stamp   штампы/гифы   → GIF как есть; PNG: ordered dither RGB, альфа не трогается
  cutout  вырезки       → рваный клочок по _afisha/cutouts.txt (см. cutout_args)
  курсоры               → из ASCII, 16 и 32 px
Без ImageMagick всё копируется «как есть» (copy_asis)."""
import os, re, shutil, struct, subprocess, threading, zlib
from pathlib import Path
from .errors import ApiError
from .site import IMG_EXT

TYPES = {'pic', 'cutout', 'ghost', 'stamp', 'bg'}
PROCESS_LOCK = threading.RLock()     # cutouts.txt и запуск конвейера — под одним замком (два «применить» внахлёст)

# параметры темы forest (пока тема не вынесена в манифест — шаг 3)
IMAGES_DEF = {
    'bg':     {'mode': 'dither', 'width': 1600, 'colors': 48, 'modulate': '95,70,100', 'brightness_contrast': '-5x-15', 'quality': 82},
    'pic':    {'mode': 'dither', 'width': 1400, 'colors': 48, 'modulate': '95,75,100', 'quality': 84},
    'ghost':  {'mode': 'level', 'width': 520, 'level': '12%,100%', 'quality': 82},
    'stamp':  {'mode': 'ordered', 'max': 160, 'dither': 'o4x4,4'},
    'cutout': {'paper': '#e8dfc9', 'tint': '#d9b26a', 'tint_pct': 12, 'edge': 'rgb(255,255,204)', 'dither': 'o8x8,6', 'colors': 64,
               'desaturate': '100,80,100', 'level': '5%,95%'},
}
CURSORS_DEF = {
    'paper': '#e8dfc9', 'ink': '#221c17',
    'cursor': {'hot': [7, 7], 'rows': ["......oo........", "......o#o.......", "......o#o.......", "......o#o.......", "......o#o.......",
                                       "oooooo.#.oooooo.", "o#####...#####o.", "oooooo.#.oooooo.", "......o#o.......", "......o#o.......",
                                       "......o#o.......", "......o#o.......", "......oo........", "................", "................", "................"]},
    'hand':   {'hot': [5, 1], 'rows': [".....oo.........", "....o##o........", "....o##ooo......", "....o##o##oo....", "....o##o##o#o...",
                                       "oo..o##o##o##o..", "o#o.o#######o#o.", "o##o########o#o.", "o#############o.", ".o###########o..",
                                       ".o###########o..", "..o#########o...", "..o#########o...", "...o#######o....", "...o#######o....", "...ooooooooo...."]},
}

# ── ImageMagick ────────────────────────────────────────────────────────────
MAGICK = None
MAGICK_INFO = ''


def find_magick():
    """(путь к magick или None, строка с версией или причиной). Только magick (IM7): convert.exe на Windows — системная утилита."""
    global MAGICK, MAGICK_INFO
    exe = shutil.which('magick')
    if not exe and os.name == 'nt':
        for d in sorted(Path(os.environ.get('ProgramFiles', r'C:\Program Files')).glob('ImageMagick-7*')):
            if (d / 'magick.exe').exists(): exe = str(d / 'magick.exe'); break
    if not exe:
        MAGICK, MAGICK_INFO = None, 'ImageMagick не найден'
        return MAGICK, MAGICK_INFO
    try:
        v = subprocess.run([exe, '-version'], capture_output=True, encoding='utf-8', errors='replace', timeout=20).stdout.split('\n')[0]
    except (OSError, subprocess.TimeoutExpired) as e:
        MAGICK, MAGICK_INFO = None, f'magick не запускается: {e}'
        return MAGICK, MAGICK_INFO
    m = re.search(r'ImageMagick (\d+)\.', v)
    if not m or int(m.group(1)) < 7:
        MAGICK, MAGICK_INFO = None, 'найден старый ImageMagick (' + v.strip() + '), нужна версия 7'
        return MAGICK, MAGICK_INFO
    MAGICK, MAGICK_INFO = exe, v.strip()
    return MAGICK, MAGICK_INFO


MAGICK_HINT = 'поставь ImageMagick 7 (imagemagick.org/script/download.php; на Windows — инсталлятор с галочкой «Add to PATH») и перезапусти afisha'
MAGICK_HINTS = [   # подстрока stderr → (сообщение, подсказка)
    ('no decode delegate', 'формат картинки не поддерживается', 'сохрани как JPG или PNG'),
    ('improper image header', 'файл повреждён или это не картинка', 'открой файл в просмотрщике и пересохрани'),
    ('insufficient image data', 'файл обрезан или повреждён', 'пересохрани картинку'),
    ('unable to open image', 'файл не найден или нет доступа', 'проверь имя и права на папку'),
    ('cache resources exhausted', 'слишком большая картинка для ImageMagick', 'уменьши её до 4000 px по длинной стороне'),
    ('exceeds limit', 'картинка превышает лимиты ImageMagick', 'уменьши её до 4000 px по длинной стороне'),
    ('memory allocation failed', 'не хватило памяти на обработку', 'уменьши картинку'),
    ('not authorized', 'формат запрещён политикой ImageMagick', 'policy.xml в папке ImageMagick разрешает этот формат'),
    ('unrecognized option', 'старая или неполная установка ImageMagick', 'нужна версия 7 (команда magick)'),
    ('unable to open module', 'неполная установка ImageMagick (нет модуля формата)', 'переустанови ImageMagick 7'),
    ('geometry does not contain image', 'не удалось выделить фигуру вырезки', 'проверь точки заливки и допуск в «настроить вырезку»'),
]


def humanize(stderr):
    s = stderr.lower()
    for key, msg, hint in MAGICK_HINTS:
        if key in s: return msg, hint
    return 'ImageMagick: ' + stderr.strip()[-300:], 'полный вывод — в консоли, где запущен afisha'


def run(args, what='обработка картинки'):
    if not MAGICK: raise ApiError(f'{what}: нужен ImageMagick', MAGICK_HINT)
    env = dict(os.environ); env['MAGICK_THREAD_LIMIT'] = '1'      # детерминированный шум (+noise) — см. docs/design.md
    try:
        r = subprocess.run([MAGICK, *args], capture_output=True, encoding='utf-8', errors='replace', env=env, timeout=300)
    except OSError as e:
        raise ApiError(f'{what}: magick не запустился ({e})', MAGICK_HINT)
    except subprocess.TimeoutExpired:
        raise ApiError(f'{what}: ImageMagick не ответил за 5 минут', 'слишком большая картинка?')
    if r.returncode:
        print(f'[magick] {what}: rc={r.returncode}\n{r.stderr}')
        msg, hint = humanize(r.stderr)
        raise ApiError(f'{what}: {msg}', hint)


def identify(path):
    """(ширина, высота) первого кадра. Без magick — читаем заголовки PNG/JPEG/GIF/WebP сами."""
    path = Path(path)
    if MAGICK:
        r = subprocess.run([MAGICK, 'identify', '-format', '%w %h', str(path) + '[0]'], capture_output=True, encoding='utf-8', errors='replace')
        wh = r.stdout.split()
        if len(wh) >= 2: return int(wh[0]), int(wh[1])
    with open(path, 'rb') as f: head = f.read(32)
    if head[:8] == b'\x89PNG\r\n\x1a\n': return struct.unpack('>II', head[16:24])
    if head[:6] in (b'GIF87a', b'GIF89a'): return struct.unpack('<HH', head[6:10])
    if head[:4] == b'RIFF' and head[8:12] == b'WEBP':
        if head[12:16] == b'VP8 ': return struct.unpack('<HH', head[26:30])[0] & 0x3fff, struct.unpack('<HH', head[26:30])[1] & 0x3fff
        if head[12:16] == b'VP8L':
            b = head[21:25]; return (b[0] | (b[1] & 0x3f) << 8) + 1, ((b[1] >> 6) | b[2] << 2 | (b[3] & 0xf) << 10) + 1
        if head[12:16] == b'VP8X': return (int.from_bytes(head[24:27], 'little') + 1, int.from_bytes(head[27:30], 'little') + 1)
    if head[:2] == b'\xff\xd8':
        with open(path, 'rb') as f:
            f.seek(2)
            while True:
                b = f.read(1)
                while b and b != b'\xff': b = f.read(1)
                while b == b'\xff': b = f.read(1)
                if not b: break
                if b[0] in (0xc0, 0xc1, 0xc2): f.read(3); h, w = struct.unpack('>HH', f.read(4)); return w, h
                (ln,) = struct.unpack('>H', f.read(2)); f.seek(ln - 2, 1)
    raise ApiError('не удалось прочитать размер картинки ' + path.name, 'сохрани как JPG или PNG')


# ── имена результатов и «как есть» ────────────────────────────────────────
def outputs_for(typ, name, asis):
    stem, ext = os.path.splitext(name)
    if asis: return {'pic': name, 'cutout': f'{stem}.png', 'ghost': f'ghost-{name}', 'stamp': name, 'bg': f'bg-{name}'}[typ]
    return {'pic': f'{stem}.jpg', 'cutout': f'{stem}.png', 'ghost': f'ghost-{stem}.jpg', 'stamp': name, 'bg': f'bg-{stem}.jpg'}[typ]


def copy_asis(src, dst):
    Path(dst).parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(src, dst)


# ── шаги конвейера (аргументы 1:1 из process.sh) ──────────────────────────
def process_bg(src, dst, p):
    run([str(src), '-resize', f'{p["width"]}x', '-modulate', p['modulate'], '-brightness-contrast', p['brightness_contrast'],
         '-dither', 'FloydSteinberg', '-colors', str(p['colors']), '-quality', str(p['quality']), str(dst)], 'фон ' + Path(src).name)


def process_pic(src, dst, p):
    run([str(src), '-resize', f'{p["width"]}x', '-modulate', p['modulate'], '-dither', 'FloydSteinberg', '-colors', str(p['colors']),
         '-quality', str(p['quality']), str(dst)], 'фото ' + Path(src).name)


def process_ghost(src, dst, p):
    run([str(src), '-resize', f'{p["width"]}x', '-level', p['level'], '-quality', str(p['quality']), str(dst)], 'призрак ' + Path(src).name)


def process_stamp(src, dst, p):
    if Path(src).suffix.lower() == '.png':
        run([str(src), '-resize', f'{p["max"]}x{p["max"]}>', '-channel', 'RGB', '-ordered-dither', p['dither'], '+channel', str(dst)], 'штамп ' + Path(src).name)
    else:
        copy_asis(src, dst)


def cursors(theme_cursors, img_dir):
    """Курсоры из ASCII ('#' бумага, 'o' чернила, '.' пусто), 1x и 2x."""
    c = theme_cursors; out = []
    for name in ('cursor', 'hand'):
        rows = c[name]['rows']; h, w = len(rows), len(rows[0]); draws = []
        for y in range(h):
            for x in range(w):
                ch = rows[y][x]
                if ch == '#': draws += ['-fill', c['paper'], '-draw', f'point {x},{y}']
                if ch == 'o': draws += ['-fill', c['ink'], '-draw', f'point {x},{y}']
        for scale, suffix in ((1, ''), (2, '@2x')):
            run(['-size', f'{w}x{h}', 'xc:none', *draws, '-scale', f'{scale * 100}%', '-define', 'png:exclude-chunk=date,time,tIME', str(Path(img_dir) / f'{name}{suffix}.png')], 'курсор ' + name)
            out.append(f'{name}{suffix}.png')
    return out


def _noise(seed, blur):
    """Шум одной частоты поверх маски P: ( mpr:P -fill gray50 -colorize 100 -seed N +noise Random -colorspace gray -blur 0xB -normalize )."""
    return ['(', 'mpr:P', '-fill', 'gray50', '-colorize', '100', '-seed', str(seed), '+noise', 'Random', '-colorspace', 'gray', '-blur', f'0x{blur:g}', '-normalize', ')']


def _map(s1, s2):
    """Карта смещения из двух частот шума (крупная 8 + мелкая 1, смешаны 18%)."""
    return ['(', *_noise(s1, 8), *_noise(s2, 1), '-compose', 'Blend', '-define', 'compose:args=18', '-composite', '-normalize', ')']


def cutout_args(src, dst, line, p, debug_dir=None):
    """Аргументы magick для одной вырезки — дословно process.sh cutout(). Чистая функция (тестируется без запуска).
    line: {crop{w,h,x,y}, fuzz, seeds[[x,y]], width, margin, seed}; p: theme.images.cutout.
    Шаги: фигура (floodfill по точкам, resize, градуировка) → маска бумаги (Dilate на margin) → разрыв: маска
    смещается шумом двух частот отдельно по X и по Y (Displace читает только красный канал) → Close/Open и
    удаление островков → волокнистая кайма (T − Erode, промодулированная шумом) → сборка бумага+фигура →
    ordered dither RGB → кайма цветом с решётки дизеринга → PNG8 без дат."""
    M, seed, width = int(line['margin']), int(line['seed']), int(line['width'])
    A = (M * 5 + 1) // 2                       # амплитуда разрыва = 2.5·margin
    pad = M + A + 2; fw = width - 2 * pad
    c = line['crop']; crop = f"{c['w']}x{c['h']}+{c['x']}+{c['y']}"
    draws = []
    for x, y in line['seeds']: draws += ['-draw', f'alpha {x},{y} floodfill']
    dbg = lambda tag: ['-write', str(Path(debug_dir) / f"{line['name']}-{tag}.png")] if debug_dir else []
    return [str(src), '-crop', crop, '+repage', '-fuzz', f"{line['fuzz']:g}%", '-fill', 'none', *draws,
            '-channel', 'A', '-morphology', 'Open', 'Disk:1.5', '+channel', '-trim', '+repage', '-resize', f'{fw}x',
            '-channel', 'RGB', '-modulate', p['desaturate'], '-level', p['level'], '-fill', p['tint'], '-colorize', f"{p['tint_pct']}%", '+channel',
            '-bordercolor', 'none', '-border', str(pad), '-write', 'mpr:fig', '-alpha', 'extract', *dbg('A'),
            '-morphology', 'Dilate', f'Disk:{M}', '-threshold', '50%', '-write', 'mpr:P', '-blur', '0x1',
            *_map(seed, seed + 1), '-compose', 'Displace', '-define', f'compose:args={A}x0', '-composite', '-threshold', '50%',
            *_map(seed + 2, seed + 3), '-compose', 'Displace', '-define', f'compose:args=0x{A}', '-composite', '-threshold', '50%',
            '-morphology', 'Close', 'Disk:3', '-morphology', 'Open', 'Disk:2',
            '-define', 'connected-components:area-threshold=150', '-define', 'connected-components:mean-color=true', '-connected-components', '4', '-threshold', '50%',
            '-write', 'mpr:T', *dbg('T'),
            '(', 'mpr:T', '-morphology', 'Erode', 'Disk:3', ')', '-compose', 'MinusSrc', '-composite',
            '(', *_noise(seed + 4, 0.8), '-threshold', '45%', ')', '-compose', 'Multiply', '-composite',
            '(', 'mpr:T', '(', 'mpr:T', '-morphology', 'Erode', 'Disk:1', ')', '-compose', 'MinusSrc', '-composite', ')', '-compose', 'Lighten', '-composite',
            '-write', 'mpr:F', *dbg('F'), '+delete',
            '(', 'mpr:P', '-fill', p['paper'], '-colorize', '100', ')', *_noise(seed + 5, 0.5), '-compose', 'Blend', '-define', 'compose:args=6', '-composite',
            'mpr:T', '-alpha', 'off', '-compose', 'CopyOpacity', '-composite',
            'mpr:fig', '-compose', 'Over', '-composite',
            '-channel', 'RGB', '-ordered-dither', p['dither'], '+channel',
            '(', 'mpr:P', '-fill', p['edge'], '-colorize', '100', ')', 'mpr:F', '-compose', 'Over', '-composite',
            '-colors', str(p['colors']), '-define', 'png:format=png8', '-define', 'png:exclude-chunk=date,time,tIME', str(dst)]


def process_cutout(site, line, p, debug_dir=None):
    name = line['name']
    srcs = list((site.src / 'cutout').glob(f'{name}.*'))
    if len(srcs) != 1: raise ApiError(f'вырезка {name}: найдено {len(srcs)} источников в src/cutout (нужен ровно один)')
    if MAGICK is None:
        if srcs[0].suffix.lower() == '.png': copy_asis(srcs[0], site.img / f'{name}.png'); return
        raise ApiError(f'вырезке {name} нужен ImageMagick (или готовый PNG с прозрачностью)', MAGICK_HINT)
    if not line.get('crop'): raise ApiError(f'вырезка {name}: плохой crop в _afisha/cutouts.txt')
    run(cutout_args(srcs[0], site.img / f'{name}.png', line, p, debug_dir), 'вырезка ' + name)


def process_all(site, images=None, cursors_cfg=None, active_bg=None, only=None, debug_dir=None):
    """Вся сборка src → img (как process.sh целиком). only — набор типов; active_bg — какой фон (None = из темы, 'all' = все).
    Возвращает список записанных файлов. Без magick — копии «как есть» (вырезки пропускаются с предупреждением)."""
    images = images or IMAGES_DEF; written = []; warnings = []
    site.img.mkdir(exist_ok=True)
    asis_all = MAGICK is None
    asis_list = set(site.settings_all().get('asis', []))
    def want(t): return only is None or t in only
    if want('bg'):
        for f in sorted((site.src / 'bg').glob('*.jpg')):
            n = f.stem
            if active_bg != 'all' and n != active_bg: continue
            dst = site.img / outputs_for('bg', f.name, asis_all or images['bg'].get('mode') == 'asis' or n in asis_list)
            if asis_all or images['bg'].get('mode') == 'asis' or n in asis_list: copy_asis(f, dst)
            else: process_bg(f, dst, images['bg'])
            written.append(dst.name)
    if want('cutout'):
        if asis_all or images['cutout'].get('mode') == 'asis':      # без magick (или «как есть»): готовые PNG копируются, остальное пропускается
            for f in sorted((site.src / 'cutout').glob('*.png')) if (site.src / 'cutout').is_dir() else []:
                copy_asis(f, site.img / f.name); written.append(f.name)
            skipped = [f.name for f in (site.src / 'cutout').iterdir() if f.is_file() and f.suffix.lower() != '.png'] if (site.src / 'cutout').is_dir() else []
            if skipped and asis_all: warnings.append('вырезки без ImageMagick не собираются: ' + ', '.join(skipped))
        else:
            for d in cutout_lines(site):
                try:
                    process_cutout(site, d, images['cutout'], debug_dir); written.append(d['name'] + '.png')
                except ApiError as e:
                    warnings.append(str(e))
    for typ, fn in (('pic', process_pic), ('ghost', process_ghost), ('stamp', process_stamp)):
        if not want(typ): continue
        for f in sorted((site.src / typ).iterdir()) if (site.src / typ).is_dir() else []:
            if not f.is_file() or f.suffix.lower() not in IMG_EXT: continue
            asis = asis_all or images[typ].get('mode') == 'asis' or f.stem in asis_list
            dst = site.img / outputs_for(typ, f.name, asis)
            if asis: copy_asis(f, dst)
            else: fn(f, dst, images[typ])
            written.append(dst.name)
    if cursors_cfg and MAGICK and (only is None or 'cursors' in only):
        written += cursors(cursors_cfg, site.img)
    if warnings: print('[process] ' + '; '.join(warnings))
    return written


# ── строки _afisha/cutouts.txt ─────────────────────────────────────────────
def new_seed(stem):
    """Seed разрыва для новой вырезки: воспроизводимый из имени (тот же файл → тот же край;
    hash() не годится, он меняется между запусками Python). Дальше меняется кнопкой «другой край»."""
    return zlib.crc32(stem.encode()) % 10**6


def _cutout_lines_raw(site):
    return site.read(site.cutouts_file).split('\n') if site.cutouts_file.exists() else []


def _parse_line(l):
    t = l.split()
    if len(t) < 5 or l.lstrip().startswith('#'): return None
    m = re.fullmatch(r'(\d+)x(\d+)\+(\d+)\+(\d+)', t[1])
    return {'name': t[0], 'crop': {'w': int(m[1]), 'h': int(m[2]), 'x': int(m[3]), 'y': int(m[4])} if m else None,
            'fuzz': float(t[2]), 'seeds': [[int(a), int(b)] for a, b in (s.split(',') for s in t[3].split(';') if s)],
            'width': int(t[4]), 'margin': int(t[5]) if len(t) > 5 else 10, 'seed': int(t[6]) if len(t) > 6 else 1}


def cutout_lines(site):
    return [d for d in (_parse_line(l) for l in _cutout_lines_raw(site)) if d]


def cutout_line(site, name):
    """Строка вырезки как dict (crop, fuzz, seeds, width, margin, seed) или None."""
    for d in cutout_lines(site):
        if d['name'] == name: return d
    return None


def write_cutout_line(site, d):
    """Переписать (или добавить) строку вырезки d; остальные строки и комментарии не трогаются."""
    c = d['crop']; seeds = ';'.join(f'{x},{y}' for x, y in d['seeds']) or '2,2'
    line = f"{d['name']}  {c['w']}x{c['h']}+{c['x']}+{c['y']}  {d['fuzz']:g}  {seeds}  {int(d['width'])}  {int(d['margin'])}  {int(d['seed'])}"
    lines = _cutout_lines_raw(site); done = False
    for i, l in enumerate(lines):
        t = l.split()
        if len(t) >= 5 and t[0] == d['name'] and not l.lstrip().startswith('#'): lines[i] = line; done = True; break
    if not done: lines = [l for l in lines if l.strip()] + [line]
    site.write(site.cutouts_file, '\n'.join(lines).rstrip('\n') + '\n')


def remove_cutout_line(site, stem):
    site.write(site.cutouts_file, '\n'.join(l for l in _cutout_lines_raw(site) if not (l.split() and l.split()[0] == stem and not l.lstrip().startswith('#'))).rstrip('\n') + '\n')


def cutout_get(site, q):
    name = q.get('name', [''])[0]
    d = cutout_line(site, name)
    if not d: raise ApiError(f'нет строки {name} в _afisha/cutouts.txt')
    srcs = list((site.src / 'cutout').glob(f'{name}.*'))
    if len(srcs) != 1: raise ApiError(f'в src/cutout найдено {len(srcs)} файлов {name}.*')
    w, h = identify(srcs[0])
    d.update(src=f'src/cutout/{srcs[0].name}', sw=w, sh=h)
    return {'ok': True, **d}


def cutout_set(site, body, images=None):
    import json
    with PROCESS_LOCK: return _cutout_set(site, json.loads(body), images)


def _cutout_set(site, d, images):
    if not re.fullmatch(r'[a-z0-9][\w.-]*', d.get('name', '')): raise ApiError('плохое имя вырезки')
    if not cutout_line(site, d['name']): raise ApiError('нет такой строки')
    c = d['crop']
    for k in ('w', 'h', 'x', 'y'): c[k] = max(0, int(c[k]))
    if c['w'] < 8 or c['h'] < 8: raise ApiError('слишком маленький crop')
    d['seeds'] = [[max(0, min(c['w'] - 1, int(x))), max(0, min(c['h'] - 1, int(y)))] for x, y in d.get('seeds', [])]
    d['fuzz'] = max(0, min(30, float(d.get('fuzz', 3)))); d['width'] = max(60, min(600, int(d.get('width', 300))))
    d['margin'] = max(2, min(30, int(d.get('margin', 10)))); d['seed'] = max(0, int(d.get('seed', 1)))
    write_cutout_line(site, d)
    process_cutout(site, cutout_line(site, d['name']), (images or IMAGES_DEF)['cutout'])
    return {'ok': True, **cutout_line(site, d['name'])}


def reroll(site, q, images=None):
    """Другой рисунок разрыва: seed+1 в строке вырезки, пересборка."""
    name = q.get('name', [''])[0]
    with PROCESS_LOCK:
        d = cutout_line(site, name)
        if not d: raise ApiError(f'нет строки {name} в _afisha/cutouts.txt')
        d['seed'] += 1; write_cutout_line(site, d)
        process_cutout(site, d, (images or IMAGES_DEF)['cutout'])
    return d['seed']


# ── загрузка и библиотека ─────────────────────────────────────────────────
def upload(site, q, body, images=None, cursors_cfg=None, active_bg=None):
    typ, name = q.get('type', [''])[0], q.get('name', [''])[0]
    asis = bool(q.get('asis', [''])[0])
    if typ not in TYPES: raise ApiError('тип должен быть один из ' + ', '.join(sorted(TYPES)))
    name = re.sub(r'[^\w.-]+', '-', os.path.basename(name)).lower().strip('-')
    stem, ext = os.path.splitext(name)
    if ext.lower() not in IMG_EXT: raise ApiError('не картинка: ' + name, 'jpg, png, gif или webp')
    if typ == 'bg' and ext.lower() != '.jpg': raise ApiError('фон — только .jpg')
    if typ == 'cutout' and ext.lower() not in {'.jpg', '.jpeg', '.png'}: raise ApiError('вырезка — jpg или png')
    if typ == 'cutout' and MAGICK is None and ext.lower() != '.png':
        raise ApiError('вырезке нужен ImageMagick или готовый PNG с прозрачностью', MAGICK_HINT)
    dst = site.src / typ / name
    if typ == 'cutout':
        others = [p.name for p in (site.src / 'cutout').glob(f'{stem}.*') if p.name != name]
        if others: raise ApiError(f'в src/cutout уже есть {others[0]}', 'удали его или переименуй файл')
    dst.parent.mkdir(parents=True, exist_ok=True); dst.write_bytes(body)
    if asis:
        s = site.settings_all(); s['asis'] = sorted(set(s.get('asis', [])) | {stem}); site.settings_write(s)
    with PROCESS_LOCK:
        if typ == 'cutout' and MAGICK:
            if not cutout_line(site, stem):   # подобранную строку не трогаем
                w, h = identify(dst)
                seeds = f'2,2;{w-3},2;{w//2},2;2,{h//2};{w-3},{h//2}'
                txt = site.read(site.cutouts_file) if site.cutouts_file.exists() else ''
                site.write(site.cutouts_file, txt.rstrip('\n') + f'\n{stem}  {w}x{h}+0+0  3  {seeds}  300  10  {new_seed(stem)}\n')
        process_all(site, images, cursors_cfg, active_bg=stem if typ == 'bg' else active_bg, only={typ})
    out = outputs_for(typ, name, asis or MAGICK is None or (images or IMAGES_DEF)[typ].get('mode') == 'asis')
    return {'ok': True, 'file': out}


def img_source(site, name):
    """Тип картинки по наличию исходника: (тип, [файлы исходника], есть_строка_cutouts)."""
    stem = os.path.splitext(name)[0]
    if name.startswith('ghost-'): return 'ghost', list((site.src / 'ghost').glob(f'{stem[6:]}.*')), False
    if name.startswith('bg-'): return 'bg', list((site.src / 'bg').glob(f'{stem[3:]}.*')), False
    if (site.src / 'stamp' / name).exists(): return 'stamp', [site.src / 'stamp' / name], False
    cut = list((site.src / 'cutout').glob(f'{stem}.*'))
    if cut or cutout_line(site, stem): return 'cutout', cut, bool(cutout_line(site, stem))
    pic = list((site.src / 'pic').glob(f'{stem}.*'))
    if pic: return 'pic', pic, False
    return 'none', [], False


def images_list(site):
    """Список img/ с типом и размером — для state()."""
    out = []
    for p in sorted(site.img.iterdir()) if site.img.is_dir() else []:
        if p.suffix.lower() not in IMG_EXT or p.name.startswith(('cursor', 'hand')): continue
        out.append({'name': p.name, 'type': img_source(site, p.name)[0]})
    return out


def library(site, background):
    """Все картинки img/ с типом, числом использований по всем *.html и css и списком того, что удалит delete."""
    texts = {p.name: site.read(p) for p in site.root.glob('*.html')}
    for css in ('style.css', 'theme.css'):
        if (site.root / css).exists(): texts[css] = site.read(site.root / css)
    items = []
    for p in sorted(site.img.iterdir()):
        if p.suffix.lower() not in IMG_EXT or p.name.startswith(('cursor', 'hand')): continue
        typ, srcs, has_line = img_source(site, p.name)
        used = [f for f, txt in texts.items() if p.name in txt]
        removes = [f'img/{p.name}'] + [s.relative_to(site.root).as_posix() for s in srcs] + ([f'строка {p.stem} в _afisha/cutouts.txt'] if has_line else [])
        items.append({'name': p.name, 'type': typ, 'used': used, 'removes': removes, 'size': p.stat().st_size, 'active_bg': typ == 'bg' and p.stem[3:] == background})
    return {'ok': True, 'items': items}


def delete_img(site, q, background):
    name = os.path.basename(q.get('name', [''])[0])
    p = site.img / name
    if not name or not p.exists() or p.suffix.lower() not in IMG_EXT: raise ApiError('нет такой картинки')
    item = next((i for i in library(site, background)['items'] if i['name'] == name), None)
    if not item: raise ApiError('картинку нельзя удалить')
    if item['used']: raise ApiError('используется в ' + ', '.join(item['used']), 'сначала убери её со страниц')
    if item['active_bg']: raise ApiError('это текущий фон', 'сначала выбери другой фон')
    typ, srcs, has_line = img_source(site, name)
    p.unlink()
    for s in srcs: s.unlink()
    if has_line: remove_cutout_line(site, os.path.splitext(name)[0])
    return {'ok': True, 'removed': item['removes']}
