#!/usr/bin/env python3
"""afisha — локальный визуальный редактор коллаж-сайтов (статичный HTML без скриптов на живой странице).

  python3 afisha.py <папка сайта> [--port 8787] [--no-browser]      открыть редактор
  python3 afisha.py new <папка> [--template forest] [--title …]      создать сайт из шаблона
  python3 afisha.py check [<папка>]                                 проверить зависимости
  python3 afisha.py process <папка> [--all-bg]                      пересобрать картинки
  python3 afisha.py adopt <папка>                                   перевести старый сайт (tools/, токены в style.css) на afisha

Нужны Python 3.9+ и ImageMagick 7 (magick). Без ImageMagick редактор работает, картинки кладутся как есть."""
import argparse, os, re, shutil, sys, threading, time, webbrowser
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
if sys.version_info < (3, 9):
    print('afisha: нужен Python 3.9 или новее, а это ' + sys.version.split()[0]); sys.exit(2)
try: sys.stdout.reconfigure(encoding='utf-8', errors='replace', line_buffering=True); sys.stderr.reconfigure(encoding='utf-8', errors='replace', line_buffering=True)
except AttributeError: pass

from server.site import Site
from server import app, images, layout, theme, adopt as adopt_mod
from server.errors import ApiError

TEMPLATES = HERE / 'templates'


def say(*a): print('afisha:', *a)


def check_magick():
    exe, info = images.find_magick()
    if exe: say('ImageMagick:', info)
    else: say('ImageMagick не найден — картинки будут класться как есть.', images.MAGICK_HINT)
    return exe


def open_site(path, create=False):
    root = Path(path).expanduser()
    if not root.is_dir(): say(f'папки {root} нет'); sys.exit(2)
    if not (root / 'index.html').exists():
        say(f'это не сайт afisha: в {root} нет index.html.', 'создать — python3 afisha.py new <папка>'); sys.exit(2)
    site = Site(root); site.ensure_meta()
    return site


def cmd_serve(a):
    site = open_site(a.site)
    check_magick()
    layout.ensure_layout(site)
    th, th_err, legacy = theme.load(site)
    if th_err: say('тема:', th_err, '— пока используется тема шаблона, панель «тема» покажет ошибку')
    elif legacy: say('старый сайт без _afisha/theme.json: тема читается из style.css, панель «тема» недоступна')
    else: theme.ensure_theme_css(site)
    port = a.port
    if not app.port_free(port):
        if a.port_given: say(f'порт {port} занят'); sys.exit(2)
        for p in range(port + 1, port + 11):
            if app.port_free(p): say(f'порт {port} занят (редактор уже запущен?) — беру {p}'); port = p; break
        else: say('свободного порта нет'); sys.exit(2)
    lock = site.meta / 'lock'
    if lock.exists() and time.time() - lock.stat().st_mtime < 3600:
        say('похоже, этот сайт уже открыт в другом редакторе (файл _afisha/lock моложе часа). Два редактора на одну папку затирают друг друга.')
    site.write(lock, str(os.getpid()) + '\n')
    url = f'http://127.0.0.1:{port}/_editor/editor.html'
    say('редактор:', url); say('сайт:    ', f'http://127.0.0.1:{port}/'); say('Ctrl+C — выключить')
    if not a.no_browser: threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    import signal
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))   # kill → тихий выход и снятие lock
    try: app.serve(site, port, tests=a.tests)
    finally:
        try: lock.unlink()
        except OSError: pass


def cmd_new(a):
    root = Path(a.path).expanduser()
    tpl = TEMPLATES / a.template
    if not tpl.is_dir(): say('нет шаблона', a.template, '— есть:', ', '.join(p.name for p in TEMPLATES.iterdir() if p.is_dir())); sys.exit(2)
    if root.exists() and any(root.iterdir()): say(f'папка {root} не пуста — нужна пустая или новая'); sys.exit(2)
    shutil.copytree(tpl, root, dirs_exist_ok=True)
    site = Site(root); site.ensure_meta()
    blank = root / 'blank.html'
    if blank.exists():
        html = site.read(blank).replace('{title}', a.title).replace('{lang}', a.lang)
        site.write(root / 'index.html', html); blank.unlink()
    s = site.settings_all(); s.setdefault('title', a.title); s.setdefault('lang', a.lang); site.settings_write(s)
    layout.ensure_layout(site); theme.ensure_theme_css(site)
    check_magick()
    with images.PROCESS_LOCK:
        images.process_all(site, theme.images_cfg(site), theme.cursors_cfg(site), active_bg=theme.background(site) or 'all')
    say('готово:', root); say('открыть: python3', Path(sys.argv[0]).name, str(root))


def cmd_check(a):
    say('Python', sys.version.split()[0])
    check_magick()
    if a.site:
        site = open_site(a.site)
        say('сайт:', site.root, '| страницы:', ', '.join(site.pages()))
        th, err, legacy = theme.load(site)
        if err: say('тема:', err)
        elif legacy: say('тема: legacy (нет _afisha/theme.json)')
        else:
            say('тема:', th['name'], '| видов:', len(th['kinds']), '| блоков:', len(th['blocks']))
            css = site.read(site.root / 'style.css') if (site.root / 'style.css').exists() else ''
            missing = []
            for k in th['kinds']:
                m = k['match']
                for cls in re.findall(r'\.([\w-]+)', m):
                    if '.' + cls not in css: missing.append(f'{k["kind"]}: в style.css нет .{cls}')
            for e in th.get('effects', []):
                if '.' + e['cls'] not in css: missing.append(f'эффект {e["cls"]}: нет в style.css')
            for c in th.get('colors', []):
                if '--' + c['id'] not in css: missing.append(f'цвет --{c["id"]}: в style.css не используется')
            for m in missing: say('  ⚠', m)
            if not missing: say('  манифест и style.css согласованы (грубая проверка по именам)')


def cmd_process(a):
    site = open_site(a.site)
    check_magick()
    with images.PROCESS_LOCK:
        w = images.process_all(site, theme.images_cfg(site), theme.cursors_cfg(site), active_bg='all' if a.all_bg else theme.background(site))
    say('записано:', ', '.join(w) or 'ничего')


def cmd_adopt(a):
    root = Path(a.site).expanduser()
    if not root.is_dir() or not (root / 'index.html').exists(): say(f'в {root} нет index.html'); sys.exit(2)
    check_magick()
    try: adopt_mod.adopt(root, say)
    except ApiError as e: say('adopt остановлен:', e.msg, ('— ' + e.hint) if e.hint else ''); sys.exit(1)


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    cmds = {'serve', 'new', 'check', 'process', 'adopt'}
    if not argv or argv[0] not in cmds and not argv[0].startswith('-'): argv.insert(0, 'serve')
    p = argparse.ArgumentParser(prog='afisha', description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest='cmd')
    s = sub.add_parser('serve', help='открыть редактор'); s.add_argument('site'); s.add_argument('--port', type=int, default=8787)
    s.add_argument('--no-browser', action='store_true'); s.add_argument('--tests', action='store_true', help='отдавать tests/harness по /_editor/tests/')
    n = sub.add_parser('new', help='создать сайт из шаблона'); n.add_argument('path'); n.add_argument('--template', default='forest')
    n.add_argument('--title', default='мой сайт'); n.add_argument('--lang', default='ru')
    c = sub.add_parser('check', help='проверить зависимости'); c.add_argument('site', nargs='?')
    r = sub.add_parser('process', help='пересобрать картинки'); r.add_argument('site'); r.add_argument('--all-bg', action='store_true')
    d = sub.add_parser('adopt', help='перевести старый сайт на afisha'); d.add_argument('site')
    a = p.parse_args(argv)
    a.port_given = '--port' in argv
    if not a.cmd: p.print_help(); return
    try: {'serve': cmd_serve, 'new': cmd_new, 'check': cmd_check, 'process': cmd_process, 'adopt': cmd_adopt}[a.cmd](a)
    except ApiError as e:
        say('ошибка:', e.msg, ('— ' + e.hint) if e.hint else ''); sys.exit(1)


if __name__ == '__main__':
    main()
