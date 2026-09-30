# afisha — a collage-site editor

A local visual editor for collage websites: free block layout on a fixed-width "poster", a separate column layout
for phones, images through one pipeline (dithering, torn-edge cutouts, ghosts), publishing to Neocities. The live
page is static HTML and CSS with no scripts; all JavaScript lives in the editor on your computer.

**Status: in development.** Russian README: `README.md`. The editor UI is available in Russian and English (switch
in the top bar).

## Getting started

You need **Python 3.9+** and **ImageMagick 7** (the `magick` command). Without ImageMagick the editor still works,
but images are copied to the site as they are, without processing.

```
python3 afisha.py new ~/my-site --title "my site"   # create a site from the forest template
python3 afisha.py ~/my-site                         # open the editor (the browser opens by itself)
python3 afisha.py check ~/my-site                   # check dependencies and the theme
```

### Windows

1. Install Python from python.org, ticking **Add python.exe to PATH**.
2. Install ImageMagick 7 from imagemagick.org (the Q16-HDRI installer), ticking **Add application directory to
   your system path**. Do not tick "install legacy utilities" — `convert.exe` clashes with a Windows tool and afisha
   only uses `magick`.
3. Run `start.bat <site folder>` from the afisha folder (or `python afisha.py <site folder>`).

Keep the site folder close to the drive root (`C:\sites\my-site`): long paths make ImageMagick and Python unhappy.

### Linux / macOS

`./start.sh <site folder>` or `python3 afisha.py <site folder>`. ImageMagick comes from your package manager
(`imagemagick` 7.x; on Debian/Ubuntu check that `magick` exists, not only `convert`).

## How to use

1. `python3 afisha.py new ~/my-site --title "my site"` — a site folder from the "forest" template (dark forest,
   dithering, ghosts; the template images are generated procedurally, replace them with your own).
2. `python3 afisha.py ~/my-site` — the editor opens. Left: blocks and image upload; centre: the desk with the sheet
   (Ctrl+wheel — zoom, space+drag — pan); right: properties of the selected block.
3. Blocks are dragged around the poster (the magnet snaps to neighbours, Shift disables it), text is edited by
   double-click, images are dropped onto the left panel and go through processing (dithering, torn cutout edges).
4. "phone" — the layout for narrow screens: block order and what to hide. "canvas" — poster width. "theme" —
   colours, fonts, background, screen layers. Ctrl+S — save (backups in `_afisha/backups/`).
5. "publish" — upload to Neocities with an API key (stored only in `_afisha/neocities.key`). Without Neocities the
   site folder is a ready static site: `index.html`, `style.css`, `theme.css`, `layout.css`, `fonts/`, `img/`.

## Site folder

```
index.html, <page>.html     pages (edited by the editor)
style.css                   theme structure (blocks, layers, effects)
theme.css                   generated from _afisha/theme.json (colours, fonts, background, screen layers) — edit via the "theme" button
layout.css                  generated from _afisha/site.json (poster width) — do not edit by hand
fonts/  img/                fonts and processed images (published)
src/<type>/                 image sources (not published)
_afisha/                    theme.json, site.json, cutouts.txt, backups/, neocities.key — never published or served
```

## Theme

A theme is `style.css` (structure) + `_afisha/theme.json` (manifest: colours, fonts, background, screen layers,
image processing, block kinds and palette buttons) + `fonts/`. The editor reads the manifest instead of constants:
the "theme" button edits colours, fonts, background, layers and dithering; the server rebuilds `theme.css`. A new
block kind means editing `style.css` and `theme.json` by hand (see `templates/forest/_afisha/theme.json`;
`tests/fixture-paper` is a minimal theme).

## Tests

```
python3 tests/run.py            # editor harnesses in headless Firefox on a copy of tests/fixture-*
python3 tests/run.py --shots    # + screenshots of index.html at 1920 and 400 px into tests/out/
python3 tests/test_images.py    # image pipeline vs the reference bash script (byte for byte)
python3 tests/test_theme.py     # manifest validation and theme.css generation
```

## Licence

MIT (see LICENSE). Template fonts are under the SIL OFL (see `templates/forest/fonts/LICENSES.txt`).
