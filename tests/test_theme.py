"""Тема: валидация манифеста (ошибки с путём), theme.css из шаблона forest эквивалентен токенам старого style.css
entropic division (нормализованная сверка деклараций, не текст), патч через theme_set."""
import json, re, shutil, sys, tempfile, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from server import theme, images
from server.site import Site
from server.errors import ApiError

OLD_CSS = Path.home() / 'neocities' / 'style.css'        # оригинал до выноса токенов (есть только на машине автора)
REF_CSS = HERE / 'ref' / 'style-tokens.css'              # его копия в репозитории


def decls(css):
    """{(селектор, свойство): значение} для :root и @font-face; пробелы схлопнуты, комментарии убраны."""
    css = re.sub(r'/\*.*?\*/', '', css, flags=re.S)
    out = {}
    for m in re.finditer(r'(@font-face|:root)\s*\{([^}]*)\}', css):
        sel, body = m.group(1), m.group(2)
        props = {}
        for d in body.split(';'):
            if ':' not in d: continue
            k, v = d.split(':', 1); props[k.strip()] = re.sub(r'\s+', ' ', v.strip())
        if sel == '@font-face': sel = f'@font-face {props.get("font-family")} {props.get("font-style", "normal")} {props.get("unicode-range", "*")}'
        for k, v in props.items(): out[(sel, k)] = v
    return out


class Theme(unittest.TestCase):
    def setUp(self): self.t = theme.template_theme()

    def test_template_valid(self): self.assertTrue(theme.validate(self.t))

    def test_errors_have_path(self):
        cases = [
            (lambda t: t['colors'][0].update(value='red'), 'colors.night'),
            (lambda t: t['images']['pic'].update(colors=3), 'images.pic.colors'),
            (lambda t: t['images']['pic'].update(mode='magic'), 'images.pic.mode'),
            (lambda t: t['vars'].update(field='x; } body{display:none'), 'vars.field'),
            (lambda t: t['text']['palette'].append('gold'), 'text.palette'),
            (lambda t: t['blocks'][0].update(html='<section class="field"></section><p>x</p>'), 'ровно один'),
            (lambda t: t['blocks'][0].update(html='<script>1</script>'), 'blocks.field'),
            (lambda t: t['kinds'].insert(0, {'kind': 'x', 'match': '.field'}), 'blocks.field: html распознаётся как «x»'),
            (lambda t: t['effects'][0]['kinds'].append('nope'), 'effects.fx-stretch'),
            (lambda t: t.update(background={'active': '../etc'}), 'background.active'),
        ]
        for mut, expect in cases:
            t = json.loads(json.dumps(self.t)); mut(t)
            with self.assertRaises(ApiError, msg=expect) as cm: theme.validate(t)
            self.assertIn(expect, cm.exception.msg, f'ожидал «{expect}» в «{cm.exception.msg}»')

    def test_nav_before_trails(self):
        self.assertEqual(theme.resolve_kind(self.t, 'nav', {'class': 'trails reveal', 'data-nav': ''}), 'nav')
        self.assertEqual(theme.resolve_kind(self.t, 'figure', {'class': 'field pic reveal'}), 'pic')
        self.assertEqual(theme.resolve_kind(self.t, 'section', {'class': 'field reveal'}), 'field')
        self.assertEqual(theme.resolve_kind(self.t, 'footer', {'class': 'shared'}), 'footer')

    def test_css_equals_old_tokens(self):
        ref = OLD_CSS if OLD_CSS.exists() else REF_CSS
        if not ref.exists(): self.skipTest('нет эталонного style.css')
        want = decls(ref.read_text(encoding='utf-8')); have = decls(theme.theme_css(self.t))
        self.assertEqual(want, have)

    def test_theme_set_patch(self):
        tmp = Path(tempfile.mkdtemp(prefix='afisha-th-'))
        try:
            shutil.copytree(HERE.parent / 'templates' / 'forest', tmp, dirs_exist_ok=True)
            site = Site(tmp); site.ensure_meta()
            saved = images.MAGICK; images.MAGICK = None       # без обработки картинок
            try:
                r = theme.theme_set(site, {'colors': [{'id': 'night', 'value': '#102030'}], 'screen': {'grain': False}})
            finally: images.MAGICK = saved
            css = (tmp / 'theme.css').read_text()
            self.assertIn('--night: #102030;', css); self.assertIn('.grain { display: none; }', css)
            self.assertEqual(r['theme']['colors'][0]['value'], '#102030'); self.assertFalse(r['theme']['screen'][0]['on'])
            self.assertTrue(list((tmp / '_afisha' / 'backups').glob('theme__*.json')), 'бэкап темы')
            with self.assertRaises(ApiError): theme.theme_set(site, {'colors': [{'id': 'night', 'value': 'bad'}]})
            self.assertIn('--night: #102030;', (tmp / 'theme.css').read_text(), 'неудачный патч ничего не меняет')
        finally: shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    unittest.main(verbosity=2)
