# afisha — редактор коллаж-сайтов

Локальный визуальный редактор для сайтов-коллажей: свободная раскладка блоков на «афише» фиксированной
ширины, отдельная колонка для телефона, картинки через единый конвейер (дизеринг, рваные вырезки, призраки),
заливка на Neocities. Живая страница — статичный HTML и CSS без скриптов; весь JavaScript живёт только в
редакторе на вашем компьютере.

**Статус: в разработке (шаги 1–4 из плана: перенос, конвейер картинок, манифест темы, интерфейс ru/en).** English README: `README.en.md`.

Язык интерфейса редактора переключается в верхней панели (ru / en); по умолчанию русский.

## Как начать

Нужны **Python 3.9+** и **ImageMagick 7** (команда `magick`). Без ImageMagick редактор работает, но картинки
кладутся на сайт как есть, без обработки.

```
python3 afisha.py new ~/my-site --title "мой сайт"   # создать сайт из шаблона forest
python3 afisha.py ~/my-site                          # открыть редактор (браузер откроется сам)
python3 afisha.py check                              # проверить зависимости
```

### Windows

1. Поставить Python с python.org, отметив **Add python.exe to PATH**.
2. Поставить ImageMagick 7 с imagemagick.org (инсталлятор Q16-HDRI), отметив **Add application directory to your
   system path**. Галочку «install legacy utilities» не ставить: `convert.exe` совпадает с системной утилитой Windows,
   afisha пользуется только `magick`.
3. Запускать `start.bat <папка сайта>` из папки afisha (или `python afisha.py <папка сайта>`).

Папку сайта держать ближе к корню диска (`C:\sites\my-site`): длинные пути не нравятся ImageMagick и Python.

### Linux / macOS

`./start.sh <папка сайта>` или `python3 afisha.py <папка сайта>`. ImageMagick — из пакетного менеджера
(`imagemagick` 7.x; на Debian/Ubuntu проверить, что есть команда `magick`, а не только `convert`).

Если ImageMagick не найден, редактор предупредит при запуске и в статусе; загруженные картинки лягут на сайт как
есть (вырезки — только из готовых PNG с прозрачностью).

## Папка сайта

```
index.html, <страница>.html   страницы (правятся редактором)
style.css                     структура темы (блоки, слои, эффекты)
theme.css                     генерируется из _afisha/theme.json (цвета, шрифты, фон, экранные слои) — правится кнопкой «тема»
layout.css                    генерируется из _afisha/site.json (ширина афиши) — руками не править
fonts/  img/                  шрифты и обработанные картинки (публикуются)
src/<тип>/                    исходники картинок (не публикуются)
_afisha/                      theme.json, site.json, cutouts.txt, backups/, neocities.key — не публикуется и не отдаётся сервером
```

## Тема

Тема = `style.css` (структура) + `_afisha/theme.json` (манифест: цвета, шрифты, фон, экранные слои, обработка
картинок, виды блоков и кнопки палитры) + `fonts/`. Редактор читает манифест, а не константы: кнопка «тема» правит
цвета, шрифты, фон, слои и дизеринг, сервер пересобирает `theme.css`. Свой вид блока — правка `style.css` и
`theme.json` руками (см. `templates/forest/_afisha/theme.json` как образец; `tests/fixture-paper` — минимальная тема).

## Тесты

```
python3 tests/run.py            # харнессы редактора в headless Firefox на копии tests/fixture-*
python3 tests/run.py --shots    # + скриншоты index.html при 1920 и 400 px в tests/out/
python3 tests/test_images.py    # конвейер картинок против эталонного bash-скрипта (байт в байт)
python3 tests/test_theme.py     # валидация манифеста и генерация theme.css
```

## Лицензия

MIT (см. LICENSE). Шрифты в шаблоне — SIL OFL (см. `templates/forest/fonts/LICENSES.txt`).
