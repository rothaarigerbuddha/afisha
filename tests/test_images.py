"""Конвейер картинок: python-порт против эталонного bash process.sh (tests/ref/) — sha1 файлов img/ совпадают.
Пропускается без bash или magick, а также если версия ImageMagick не та, что записана в tests/ref/IM_VERSION
(дизеринг и шум зависят от сборки). Плюс режим «как есть» без magick."""
import hashlib, os, shutil, subprocess, sys, tempfile, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from server.site import Site
from server import images
from server.errors import ApiError

FIX = HERE / 'fixture-forest'


def sha(p): return hashlib.sha1(Path(p).read_bytes()).hexdigest()


class Pipeline(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        images.find_magick()
        cls.bash = shutil.which('bash')
        cls.tmp = Path(tempfile.mkdtemp(prefix='afisha-img-'))

    @classmethod
    def tearDownClass(cls): shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_same_as_reference(self):
        if not images.MAGICK: self.skipTest('нет magick')
        if not self.bash: self.skipTest('нет bash для эталона')
        want = (HERE / 'ref' / 'IM_VERSION').read_text().split()[0:3]
        have = images.MAGICK_INFO.replace('Version: ', '').split()[0:3]
        if want != have: self.skipTest(f'ImageMagick {have} ≠ эталон {want}')
        ref = self.tmp / 'ref'; (ref / 'tools').mkdir(parents=True)
        shutil.copytree(FIX / 'src', ref / 'src'); shutil.copy(HERE / 'ref' / 'process.sh', ref / 'tools' / 'process.sh')
        shutil.copy(FIX / '_afisha' / 'cutouts.txt', ref / 'tools' / 'cutouts.txt')
        r = subprocess.run([self.bash, 'tools/process.sh'], cwd=ref, capture_output=True, text=True, env={**os.environ, 'ACTIVE_BG': 'all'})
        self.assertEqual(r.returncode, 0, r.stderr[-500:])
        new = self.tmp / 'new'; new.mkdir(); shutil.copytree(FIX / 'src', new / 'src'); (new / '_afisha').mkdir()
        shutil.copy(FIX / '_afisha' / 'cutouts.txt', new / '_afisha' / 'cutouts.txt')
        site = Site(new); site.ensure_meta()
        written = images.process_all(site, images.IMAGES_DEF, images.CURSORS_DEF, active_bg='all')
        ref_files = sorted(p.name for p in (ref / 'img').iterdir())
        self.assertEqual(sorted(written), ref_files, 'набор файлов img/ отличается')
        for n in ref_files:
            if n.startswith(('cursor', 'hand')):        # эталон пишет в курсоры дату (tIME) → сравниваем пиксели
                r = subprocess.run([images.MAGICK, 'compare', '-metric', 'AE', str(ref / 'img' / n), str(new / 'img' / n), 'null:'], capture_output=True, text=True)
                self.assertEqual(r.stderr.strip().split()[0], '0', f'{n}: пиксели отличаются (AE={r.stderr.strip()})')
            else:
                self.assertEqual(sha(ref / 'img' / n), sha(new / 'img' / n), f'{n}: python-порт ≠ process.sh')

    def test_cutout_args_pure(self):
        line = {'name': 'x', 'crop': {'w': 100, 'h': 50, 'x': 0, 'y': 0}, 'fuzz': 3.0, 'seeds': [[2, 2]], 'width': 300, 'margin': 10, 'seed': 7}
        a = images.cutout_args('s.png', 'd.png', line, images.IMAGES_DEF['cutout'])
        self.assertEqual(a[:4], ['s.png', '-crop', '100x50+0+0', '+repage'])
        self.assertIn('alpha 2,2 floodfill', a); self.assertIn('-fuzz', a); self.assertEqual(a[a.index('-fuzz') + 1], '3%')
        self.assertEqual(a[a.index('-border') + 1], '37')          # M=10 → A=(50+1)//2=25, pad=10+25+2
        self.assertIn('compose:args=25x0', a); self.assertIn('compose:args=0x25', a)
        self.assertEqual(a[a.index('-resize') + 1], f'{300 - 2 * 37}x')
        self.assertEqual(a.count('('), a.count(')'))

    def test_no_magick_asis(self):
        saved = images.MAGICK; images.MAGICK = None
        try:
            new = self.tmp / 'asis'; new.mkdir(); shutil.copytree(FIX / 'src', new / 'src'); (new / '_afisha').mkdir()
            shutil.copy(FIX / '_afisha' / 'cutouts.txt', new / '_afisha' / 'cutouts.txt')
            site = Site(new); site.ensure_meta()
            written = images.process_all(site, active_bg='forest')
            self.assertIn('bg-forest.jpg', written); self.assertIn('ghost-water.jpg', written)
            self.assertEqual(sha(new / 'img' / 'bg-forest.jpg'), sha(FIX / 'src' / 'bg' / 'forest.jpg'), 'как есть = копия')
            self.assertIn('an-appeal-to-heavan-flag-book.png', written, 'PNG-вырезка без magick копируется')
            self.assertFalse((new / 'img' / 'milkchan.png').exists(), 'JPG-вырезка без magick не собирается')
            with self.assertRaises(ApiError) as cm:
                images.upload(site, {'type': ['cutout'], 'name': ['a.jpg']}, b'\xff\xd8\xff')
            self.assertIn('ImageMagick', str(cm.exception))
        finally:
            images.MAGICK = saved


if __name__ == '__main__':
    unittest.main(verbosity=2)
