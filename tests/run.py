#!/usr/bin/env python3
"""Прогон харнессов редактора в headless Firefox на временной копии фикстуры.
  python3 tests/run.py [t11 t15 …] [--fixture fixture-forest] [--port 8791] [--keep] [--shots]
Харнесс пишет в консоль строки «[T] PASS …» / «[T] FAIL …» и «[T] DONE»; здесь они собираются из stdout Firefox.
--shots: дополнительно скриншоты index.html при 1920 и 400 px в tests/out/."""
import argparse, os, re, shutil, subprocess, sys, tempfile, time, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
FIREFOX = os.environ.get('FIREFOX', shutil.which('firefox') or '/usr/bin/firefox')
OUT = HERE / 'out'
FIXTURES = {'t20-theme': 'fixture-paper'}       # харнессы с другой фикстурой; остальные — --fixture (fixture-forest)


def decode(s):
    return re.sub(r'\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})', lambda m: chr(int(m.group(1) or m.group(2), 16)), s)


def wait_server(port, t=15):
    for _ in range(int(t * 10)):
        try:
            urllib.request.urlopen(f'http://127.0.0.1:{port}/api/state', timeout=1).read(); return True
        except Exception: time.sleep(.1)
    return False


def firefox(url, log, timeout=90, shot=None, size=None):
    prof = Path(tempfile.mkdtemp(prefix='afisha-ff-'))
    prefs = (HERE / 'ffprofile' / 'user.js').read_text()
    if shot: prefs += 'user_pref("ui.prefersReducedMotion", 1);\n'     # скриншот не ждёт .reveal; харнессам анимации нужны (fx-*)
    (prof / 'user.js').write_text(prefs)
    cmd = [FIREFOX, '--headless', '--no-remote', '--profile', str(prof)]
    if shot: cmd += ['--screenshot', str(shot), '--window-size=' + size]
    cmd.append(url)
    with open(log, 'w', encoding='utf-8') as f:
        try: subprocess.run(cmd, stdout=f, stderr=subprocess.STDOUT, timeout=timeout)
        except subprocess.TimeoutExpired: f.write('\n[run] TIMEOUT\n')
    shutil.rmtree(prof, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('tests', nargs='*'); ap.add_argument('--fixture', default='fixture-forest'); ap.add_argument('--port', type=int, default=8791)
    ap.add_argument('--keep', action='store_true'); ap.add_argument('--shots', action='store_true')
    a = ap.parse_args()
    tests = a.tests or sorted(p.stem for p in (HERE / 'harness').glob('t*.html'))
    OUT.mkdir(exist_ok=True)
    fails = 0; tmp = None; srv = None
    def start(fixture=None):
        nonlocal tmp, srv
        stop()
        tmp = Path(tempfile.mkdtemp(prefix='afisha-site-'))                 # каждому харнессу — свежая копия фикстуры
        shutil.copytree(HERE / (fixture or a.fixture), tmp, dirs_exist_ok=True)
        srv = subprocess.Popen([sys.executable, str(ROOT / 'afisha.py'), 'serve', str(tmp), '--port', str(a.port), '--no-browser', '--tests'],
                               stdout=open(OUT / 'server.log', 'a'), stderr=subprocess.STDOUT)
        if not wait_server(a.port): print('сервер не поднялся, см. tests/out/server.log'); sys.exit(2)
    def stop():
        nonlocal tmp, srv
        if srv: srv.terminate(); srv.wait(5) if srv.poll() is None else None; srv = None
        if tmp and not a.keep: shutil.rmtree(tmp, ignore_errors=True)
        elif tmp: print('копия сайта:', tmp)
        tmp = None
    (OUT / 'server.log').write_text('')
    try:
        subprocess.run(['pkill', '-x', 'firefox'], capture_output=True)
        for t in tests:
            start(FIXTURES.get(t)); log = OUT / f'{t}.log'
            firefox(f'http://127.0.0.1:{a.port}/_editor/tests/{t}.html', log)
            lines = [decode(m.group(1)) for m in re.finditer(r'console\.log: "\[T\] (.*?)"\n', log.read_text(encoding='utf-8', errors='replace'))]
            p = sum(l.startswith('PASS') for l in lines); f = sum(l.startswith(('FAIL', 'ERROR')) for l in lines); done = any(l == 'DONE' for l in lines)
            for l in lines:
                if l.startswith('FAIL') or l.startswith('ERROR'): print(f'  {t}: {l}')
            if not done: f += 1; print(f'  {t}: нет DONE (таймаут или исключение), см. {log}')
            fails += f
            print(f'{t}: {p} PASS, {f} FAIL')
        if a.shots:
            start()
            for w, h in ((1920, 1600), (400, 1700)):
                firefox(f'http://127.0.0.1:{a.port}/index.html', OUT / f'shot-{w}.log', shot=OUT / f'index-{w}.png', size=f'{w},{h}')
                print(f'скриншот: tests/out/index-{w}.png')
    finally:
        stop()
    print('ИТОГ:', 'все зелёные' if not fails else f'{fails} FAIL')
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
