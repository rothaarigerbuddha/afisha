#!/bin/sh
# Запуск редактора: ./start.sh <папка сайта>
exec python3 "$(dirname "$0")/afisha.py" "$@"
