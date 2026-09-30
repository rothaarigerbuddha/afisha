# afisha — редактор коллаж-сайтов

Локальный визуальный редактор для сайтов-коллажей: свободная раскладка блоков на «афише» фиксированной
ширины, отдельная колонка для телефона, картинки через единый конвейер (дизеринг, рваные вырезки, призраки),
заливка на Neocities. Живая страница — статичный HTML и CSS без скриптов; весь JavaScript живёт только в
редакторе на вашем компьютере.

**Статус: в разработке (шаг 1 из плана — перенос редактора из entropic division).** English README: `README.en.md` (скоро).

## Как начать

Нужны **Python 3.9+** и **ImageMagick 7** (команда `magick`). Без ImageMagick редактор работает, но картинки
кладутся на сайт как есть, без обработки.

```
python3 afisha.py new ~/my-site --title "мой сайт"   # создать сайт из шаблона forest
python3 afisha.py ~/my-site                          # открыть редактор (браузер откроется сам)
python3 afisha.py check                              # проверить зависимости
```

На Windows: `start.bat <папка сайта>` (Python и ImageMagick ставятся официальными инсталляторами с галочкой
«Add to PATH»). На Linux/macOS: `./start.sh <папка сайта>`.

## Папка сайта

```
index.html, <страница>.html   страницы (правятся редактором)
style.css                     структура темы
layout.css                    генерируется из _afisha/site.json (ширина афиши) — руками не править
fonts/  img/                  шрифты и обработанные картинки (публикуются)
src/<тип>/                    исходники картинок (не публикуются)
_afisha/                      site.json, cutouts.txt, backups/, neocities.key — не публикуется и не отдаётся сервером
```

## Тесты

```
python3 tests/run.py            # харнессы в headless Firefox на копии tests/fixture-forest
python3 tests/run.py --shots    # + скриншоты index.html при 1920 и 400 px в tests/out/
```

## Лицензия

MIT (см. LICENSE). Шрифты в шаблоне — SIL OFL (см. `templates/forest/fonts/LICENSES.txt`).
