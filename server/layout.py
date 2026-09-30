"""Холст: _afisha/site.json → layout.css. Всё, что зависит от ширины афиши, живёт в сгенерированном
layout.css, потому что @media не читает переменные. style.css описывает оба режима через
--l-pos/--l-w/--l-ft/--l-page, здесь они лишь переключаются по ширине окна."""
import math

SCROLLBAR = 16          # классическая полоса прокрутки съедает столько; media queries считают её


def layout_css(s):
    W = s['poster']
    edge = lambda z: math.ceil(W * z) + SCROLLBAR       # от этой ширины окна афиша с zoom z помещается
    column = ('  :root { --l-pos: static; --l-w: auto; --l-ft: 0px; --l-page: min(100%, var(--column-max)); }\n'
              '  .hide-m { display: none; }\n')
    poster = '  .hide-d { display: none; }\n'
    steps = [(.78, .85), (.85, .92), (.92, 1)]
    out = [f'/* layout.css — генерируется afisha из _afisha/site.json (poster {W}, phone {s["phone"]}). Руками не править:\n'
           f'   ширина меняется в редакторе (кнопка «холст»). Правила раскладки — в style.css. */\n',
           f':root {{ --poster: {W}px; }}\n',
           f'/* колонка: окно уже {edge(.78)} px */\n@media (max-width: {edge(.78) - 1}px) {{\n{column}}}\n',
           f'/* афиша целиком */\n@media (min-width: {edge(1)}px) {{\n{poster}}}\n',
           f'/* между ними афиша уменьшается ступенями zoom (Firefox 126+, Chrome, Safari) */\n@supports (zoom: 1) {{\n'
           f'  @media (min-width: {edge(.78)}px) and (max-width: {edge(1) - 1}px) {{\n  {poster}  }}\n']
    for z, zn in steps:
        out.append(f'  @media (min-width: {edge(z)}px) and (max-width: {edge(zn) - 1}px) {{ .page {{ zoom: {z:g}; }} }}\n')
    out.append(f'}}\n/* без zoom — колонка до самой афиши */\n@supports not (zoom: 1) {{\n'
               f'  @media (min-width: {edge(.78)}px) and (max-width: {edge(1) - 1}px) {{\n{column.replace(chr(10) + "  ", chr(10) + "    ").replace("  :root", "    :root", 1)}  }}\n}}\n')
    return ''.join(out)


def ensure_layout(site, s=None):
    css = layout_css(s or site.settings())
    if not site.layout_file.exists() or site.read(site.layout_file) != css: site.write(site.layout_file, css)
