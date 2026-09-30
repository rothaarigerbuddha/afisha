"""HTTP-сервер редактора: статика сайта от корня, редактор по /_editor/, API под /api/.
Слушает только 127.0.0.1; POST принимается только с заголовком X-Editor: 1 (см. do_POST)."""
import http.server, json, os, socket, traceback, urllib.parse
from pathlib import Path
from .errors import ApiError
from . import images, layout, pages, publish, gifcities, theme

HERE = Path(__file__).resolve().parent.parent
EDITOR_DIR = HERE / 'editor'
TESTS_DIR = HERE / 'tests' / 'harness'
HIDDEN_TOP = {'_afisha'}                 # не отдаётся никогда (src/ читается: модалка обрезки берёт исходник оттуда)


def state(site):
    layout.ensure_layout(site); theme.ensure_theme_css(site)
    th, th_err = theme.client_theme(site)
    return {'ok': True, 'images': [i['name'] for i in images.images_list(site)], 'backgrounds': theme.backgrounds(site), 'background': theme.background(site),
            'pages': site.pages(), 'settings': site.settings(), 'theme': th, 'theme_error': th_err,
            'magick': {'found': images.MAGICK is not None, 'info': images.MAGICK_INFO, 'hint': '' if images.MAGICK else images.MAGICK_HINT}}


def make_handler(site, tests=False):
    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k): super().__init__(*a, directory=str(site.root), **k)

        def log_message(self, fmt, *args):
            if '/api/' in str(args[0] if args else ''): super().log_message(fmt, *args)

        def _json(self, code, obj):
            b = json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(code); self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)

        def end_headers(self):
            self.send_header('Cache-Control', 'no-store'); super().end_headers()

        def _host_ok(self):
            h = (self.headers.get('Host') or '').split(':')[0]
            return h in ('localhost', '127.0.0.1')

        def translate_path(self, path):
            """Редактор — из папки afisha по /_editor/; сайт — от корня; _afisha, src и точки-файлы закрыты."""
            p = urllib.parse.urlparse(path).path
            p = urllib.parse.unquote(p)
            parts = [x for x in p.split('/') if x and x != '.']
            if '..' in parts or any(x.startswith('.') for x in parts): return str(site.root / '__forbidden__')
            if parts and parts[0] == '_editor':
                if len(parts) > 1 and parts[1] == 'tests':
                    if not tests: return str(site.root / '__forbidden__')
                    base, rest = TESTS_DIR, parts[2:]
                else:
                    base, rest = EDITOR_DIR, parts[1:]
            else:
                if parts and parts[0] in HIDDEN_TOP: return str(site.root / '__forbidden__')
                base, rest = site.root, parts
            full = base.joinpath(*rest) if rest else base
            try:
                if not full.resolve().is_relative_to(base.resolve()): return str(site.root / '__forbidden__')
            except OSError:
                return str(site.root / '__forbidden__')
            return str(full)

        def _call(self, fn):
            try:
                return self._json(200, fn())
            except ApiError as e:
                return self._json(400, e.to_json())
            except (ValueError, KeyError, TypeError) as e:
                return self._json(400, {'error': str(e)})
            except Exception as e:
                traceback.print_exc()
                return self._json(500, {'error': 'внутренняя ошибка: ' + str(e), 'hint': 'подробности в консоли afisha'})

        def do_GET(self):
            if not self._host_ok(): return self._json(403, {'error': 'плохой Host'})
            u = urllib.parse.urlparse(self.path); q = urllib.parse.parse_qs(u.query)
            GET = {
                '/api/state': lambda: state(site),
                '/api/gifsearch': lambda: gifcities.gifsearch(q),
                '/api/cutout': lambda: images.cutout_get(site, q),
                '/api/library': lambda: images.library(site, theme.background(site)),
                '/api/backups': lambda: pages.backups(site, q),
                '/api/key': lambda: publish.key_get(site),
                '/api/settings': lambda: {'ok': True, 'settings': site.settings()},
                '/api/theme': lambda: {'ok': True, 'theme': theme.client_theme(site)[0], 'error': theme.client_theme(site)[1]},
            }
            if u.path in GET: return self._call(GET[u.path])
            if u.path.startswith('/api/'): return self._json(404, {'error': 'нет такого API'})
            return super().do_GET()

        def do_POST(self):
            if not self._host_ok(): return self._json(403, {'error': 'плохой Host'})
            u = urllib.parse.urlparse(self.path); q = urllib.parse.parse_qs(u.query)
            body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
            # чужая вкладка в том же браузере может послать «простой» POST на localhost; заголовок
            # заставляет браузер делать preflight, который мы не разрешаем → только сам редактор
            if self.headers.get('X-Editor') != '1': return self._json(403, {'error': 'нет заголовка X-Editor'})
            img_cfg, cur_cfg = theme.images_cfg(site), theme.cursors_cfg(site)
            def with_state(d): d['state'] = state(site); return d
            def do_upload(): return with_state(images.upload(site, q, body, img_cfg, cur_cfg, active_bg=theme.background(site)))
            def do_bg(): theme.set_bg(site, q); return with_state({'ok': True})
            def do_reroll(): return with_state({'ok': True, 'seed': images.reroll(site, q, img_cfg)})
            def do_gifsave():
                name = gifcities.gifsave(site, q)
                with images.PROCESS_LOCK: images.process_all(site, img_cfg, cur_cfg, only={'stamp'})
                return with_state({'ok': True, 'file': name})
            def do_delete(): return with_state(images.delete_img(site, q, theme.background(site)))
            def do_page(): return with_state(pages.page_create(site, q, body))
            def do_tlog():
                print('[T] ' + body.decode('utf-8', 'replace')); return {'ok': True}
            POST = {
                '/api/save': lambda: pages.save(site, q, body),
                '/api/upload': do_upload,
                '/api/bg': do_bg,
                '/api/reroll': do_reroll,
                '/api/gifsave': do_gifsave,
                '/api/cutout': lambda: images.cutout_set(site, body, img_cfg),
                '/api/delete': do_delete,
                '/api/page': do_page,
                '/api/restore': lambda: pages.restore(site, q),
                '/api/key': lambda: publish.key_set(site, body),
                '/api/push': lambda: publish.push(site, q),
                '/api/settings': lambda: site.settings_set(body),
                '/api/theme': lambda: with_state(theme.theme_set(site, json.loads(body))),
            }
            if tests: POST['/api/tlog'] = do_tlog
            if u.path in POST: return self._call(POST[u.path])
            return self._json(404, {'error': 'нет такого API'})
    return H


REUSE = os.name != 'nt'      # на Windows SO_REUSEADDR пускает второй сервер на занятый порт; на POSIX без него мешает TIME_WAIT


def port_free(port):
    """Пробный bind (на Windows — без SO_REUSEADDR, иначе занятый порт выглядит свободным)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    if REUSE: s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        s.bind(('127.0.0.1', port)); return True
    except OSError:
        return False
    finally:
        s.close()


class Server(http.server.ThreadingHTTPServer):
    allow_reuse_address = REUSE
    daemon_threads = True


def serve(site, port, tests=False):
    with Server(('127.0.0.1', port), make_handler(site, tests)) as s:
        try: s.serve_forever()
        except KeyboardInterrupt: pass
