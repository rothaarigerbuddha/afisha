#!/usr/bin/env bash
# Единая обработка картинок: src/<тип>/ → img/. Запускать из любого места: ./tools/process.sh
# Идея: разнородный материал становится одной серией, если пройти через один фильтр.
#   src/bg/      фоны        → дизеринг Флойда-Стейнберга 48 цветов, ширина 1600, JPEG
#   src/cutout/  вырезки     → рваный газетный клочок по tools/cutouts.txt (см. cutout ниже), PNG8
#   src/pic/     фото в рамках → дизеринг 48 цветов, ширина 1400, JPEG
#   src/ghost/   призраки    → без дизеринга; «чёрный пол», чтобы screen-blend убирал фон
#   src/stamp/   штампы/гифы → GIF как есть; PNG: ordered dither RGB, альфа не трогается
#   курсоры      → из ASCII ниже, 16px и 32px
set -e
cd "$(dirname "$0")/.."
mkdir -p img
ACTIVE_BG="${ACTIVE_BG:-forest}"   # какой фон класть в img/ (остальные — ACTIVE_BG=all)

# ── фоны ────────────────────────────────────────────────────────────────
for f in src/bg/*.jpg; do
  n=$(basename "$f" .jpg)
  [ "$ACTIVE_BG" = all ] || [ "$n" = "$ACTIVE_BG" ] || continue
  magick "$f" -resize 1600x -modulate 95,70,100 -brightness-contrast -5x-15 \
    -dither FloydSteinberg -colors 48 -quality 82 "img/bg-$n.jpg"
done

# ── вырезки ─────────────────────────────────────────────────────────────
# Строка tools/cutouts.txt: name crop fuzz seeds width [margin] [seed]
#   width  — ширина ФАЙЛА (на странице ставить --w той же величины → пиксели 1:1)
#   margin — поле бумаги вокруг фигуры, px (по умолчанию 10)
#   seed   — зерно разрыва; другой seed = другой край (по умолчанию 1)
# Шаги: фигура (floodfill, resize, градуировка) → маска бумаги (Dilate на margin) →
#   разрыв: маска смещается шумом двух частот отдельно по X и по Y (Displace читает
#   только красный канал, один проход давал бы строго диагональный сдвиг) → Close/Open и
#   удаление островков → волокнистая кайма (T − Erode, промодулированная шумом) →
#   сборка бумага+фигура → ordered dither RGB → кайма цветом с решётки дизеринга → PNG8.
# CUTOUT_DEBUG=<dir>: дополнительно пишет маски <name>-A/T/F.png (альфа фигуры, клочок, кайма).
cutout() {
  local name=$1 crop=$2 fuzz=$3 seeds=$4 width=$5 M=${6:-10} seed=${7:-1}
  local A=$(( (M*5+1)/2 )) pad fw src draws=() pts p dbg=()      # амплитуда разрыва = 2.5·margin
  pad=$((M+A+2)); fw=$((width-2*pad))
  local n; n=$(ls src/cutout/"$name".* 2>/dev/null | wc -l)
  [ "$n" -eq 1 ] || { echo "cutout $name: найдено $n источников в src/cutout (нужен ровно один)" >&2; exit 1; }
  src=$(ls src/cutout/"$name".*)
  IFS=';' read -ra pts <<< "$seeds"; for p in "${pts[@]}"; do draws+=(-draw "alpha $p floodfill"); done
  noise() { echo "( mpr:P -fill gray50 -colorize 100 -seed $1 +noise Random -colorspace gray -blur 0x$2 -normalize )"; }
  map()   { echo "( $(noise "$1" 8) $(noise "$2" 1) -compose Blend -define compose:args=18 -composite -normalize )"; }
  [ -n "$CUTOUT_DEBUG" ] && dbg=("$CUTOUT_DEBUG/$name")
  magick "$src" -crop "$crop" +repage -fuzz "${fuzz}%" -fill none "${draws[@]}" \
    -channel A -morphology Open Disk:1.5 +channel -trim +repage -resize "${fw}x" \
    -channel RGB -modulate 100,80,100 -level 5%,95% -fill '#d9b26a' -colorize 12% +channel \
    -bordercolor none -border "$pad" -write mpr:fig -alpha extract ${dbg:+-write "${dbg}-A.png"} \
    -morphology Dilate "Disk:$M" -threshold 50% -write mpr:P -blur 0x1 \
    $(map "$seed" $((seed+1))) -compose Displace -define compose:args="${A}x0" -composite -threshold 50% \
    $(map $((seed+2)) $((seed+3))) -compose Displace -define compose:args="0x${A}" -composite -threshold 50% \
    -morphology Close Disk:3 -morphology Open Disk:2 \
    -define connected-components:area-threshold=150 -define connected-components:mean-color=true -connected-components 4 -threshold 50% \
    -write mpr:T ${dbg:+-write "${dbg}-T.png"} \
    \( mpr:T -morphology Erode Disk:3 \) -compose MinusSrc -composite \
    \( $(noise $((seed+4)) 0.8) -threshold 45% \) -compose Multiply -composite \
    \( mpr:T \( mpr:T -morphology Erode Disk:1 \) -compose MinusSrc -composite \) -compose Lighten -composite \
    -write mpr:F ${dbg:+-write "${dbg}-F.png"} +delete \
    \( mpr:P -fill '#e8dfc9' -colorize 100 \) $(noise $((seed+5)) 0.5) -compose Blend -define compose:args=6 -composite \
    mpr:T -alpha off -compose CopyOpacity -composite \
    mpr:fig -compose Over -composite \
    -channel RGB -ordered-dither o8x8,6 +channel \
    \( mpr:P -fill 'rgb(255,255,204)' -colorize 100 \) mpr:F -compose Over -composite \
    -colors 64 -define png:format=png8 -define png:exclude-chunk=date,time,tIME "img/$name.png"
}
grep -v '^\s*#' tools/cutouts.txt | grep -v '^\s*$' | while read -r name crop fuzz seeds width margin seed _; do
  cutout "$name" "$crop" "$fuzz" "$seeds" "$width" "$margin" "$seed"
done

# ── фото в рамках (src/pic) ─────────────────────────────────────────────
for f in src/pic/*; do
  [ -e "$f" ] || continue
  n=$(basename "${f%.*}")
  magick "$f" -resize 1400x -modulate 95,75,100 -dither FloydSteinberg -colors 48 -quality 84 "img/$n.jpg"
done

# ── призраки ────────────────────────────────────────────────────────────
for f in src/ghost/*; do
  n=$(basename "${f%.*}")
  magick "$f" -resize 520x -level 12%,100% -quality 82 "img/ghost-$n.jpg"
done

# ── штампы и гифки ──────────────────────────────────────────────────────
for f in src/stamp/*; do
  [ -e "$f" ] || continue
  n=$(basename "$f")
  case "$f" in
    *.gif) cp "$f" "img/$n" ;;
    *.png) magick "$f" -resize '160x160>' -channel RGB -ordered-dither o4x4,4 +channel "img/$n" ;;
    *)     cp "$f" "img/$n" ;;
  esac
done

# ── курсоры из ASCII ('#' пиксель бумаги, 'o' пиксель чернил, '.' пусто) ──
cursor() { # $1 имя, $2 масштаб, остальное — строки
  local name=$1 scale=$2; shift 2
  local rows=("$@") h=${#rows[@]} w=${#rows[0]} draws=()
  for ((y=0;y<h;y++)); do for ((x=0;x<w;x++)); do
    c=${rows[y]:x:1}
    [ "$c" = "#" ] && draws+=(-fill '#e8dfc9' -draw "point $x,$y")
    [ "$c" = "o" ] && draws+=(-fill '#221c17' -draw "point $x,$y")
  done; done
  magick -size "${w}x${h}" xc:none "${draws[@]}" -scale "$((scale*100))%" "img/$name"
}
CROSS=( "......oo........" "......o#o......." "......o#o......." "......o#o......." "......o#o......."
        "oooooo.#.oooooo." "o#####...#####o." "oooooo.#.oooooo." "......o#o......." "......o#o......."
        "......o#o......." "......o#o......." "......oo........" "................" "................" "................" )
HAND=(  ".....oo........." "....o##o........" "....o##ooo......" "....o##o##oo...." "....o##o##o#o..."
        "oo..o##o##o##o.." "o#o.o#######o#o." "o##o########o#o." "o#############o." ".o###########o.."
        ".o###########o.." "..o#########o..." "..o#########o..." "...o#######o...." "...o#######o...." "...ooooooooo...." )
cursor cursor.png 1 "${CROSS[@]}";  cursor cursor@2x.png 2 "${CROSS[@]}"
cursor hand.png 1 "${HAND[@]}";     cursor hand@2x.png 2 "${HAND[@]}"

ls -la img
