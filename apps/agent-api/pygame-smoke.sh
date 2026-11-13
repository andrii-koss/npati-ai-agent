#!/bin/sh
# Plays a Pygame project for a few seconds in a virtual X display (Xvfb) and reports whether it opened a window, took real
# key presses (XTEST) and stayed up without a Python error. It is the "build" check of a Pygame project: a game that
# crashes on start or on input fails, and the error goes to the repair loop. A virtual display is real X11 rendering and
# input, not a physical monitor. Usage (from the project folder): sh /opt/npati-qa/pygame-smoke.sh [entry.py]
entry="$1"
if [ -z "$entry" ]; then for candidate in main.py game.py app.py src/main.py; do [ -f "$candidate" ] && { entry=$candidate; break; }; done; fi
entry="${entry:-main.py}"
[ -f "$entry" ] || { echo "PYGAME_SMOKE: no $entry in the project"; exit 1; }
# The project's venv when it has pygame; otherwise the Sandbox's system Python, which ships pygame.
py=python3
if [ -x .venv/bin/python ] && .venv/bin/python -c "import pygame" >/dev/null 2>&1; then py=.venv/bin/python; fi
$py -c "import pygame" >/dev/null 2>&1 || { echo "PYGAME_SMOKE: pygame is not importable"; exit 1; }
work=$(mktemp -d)
trap 'kill $game $xvfb 2>/dev/null; rm -rf "$work"' EXIT
display=":$(( ($$ % 400) + 100 ))"
Xvfb "$display" -screen 0 1280x960x24 -nolisten tcp >"$work/xvfb.log" 2>&1 &
xvfb=$!
i=0; while [ $i -lt 50 ] && ! DISPLAY="$display" xdotool getmouselocation >/dev/null 2>&1; do sleep 0.1; i=$((i + 1)); done
export DISPLAY="$display" SDL_AUDIODRIVER=dummy PYGAME_HIDE_SUPPORT_PROMPT=1
$py "$entry" >"$work/game.log" 2>&1 &
game=$!
window=""
i=0; while [ $i -lt 60 ] && [ -z "$window" ] && kill -0 $game 2>/dev/null; do sleep 0.1; window=$(xdotool search --pid $game 2>/dev/null | head -1); i=$((i + 1)); done
crashed() { ! kill -0 $game 2>/dev/null || grep -q "Traceback (most recent call last)" "$work/game.log"; }
report() { echo "PYGAME_SMOKE: $1 (python: $py, entry: $entry)"; echo "--- game output ---"; tail -n 30 "$work/game.log"; }
if [ -z "$window" ]; then crashed && { report "the game stopped before it opened a window"; exit 1; }; report "no window appeared"; exit 1; fi
# Keyboard focus follows the pointer without a window manager: put it over the window, then press keys the way a person does.
eval "$(xdotool getwindowgeometry --shell "$window" 2>/dev/null)" || true
xdotool mousemove $(( ${X:-0} + ${WIDTH:-200} / 2 )) $(( ${Y:-0} + ${HEIGHT:-200} / 2 )) click 1 2>/dev/null
pressed=0
for key in space Return Right Left Up Down space a d w s; do
  xdotool keydown "$key"; sleep 0.25; xdotool keyup "$key"; sleep 0.1; pressed=$((pressed + 1))
  if crashed; then report "the game stopped after the key $key"; exit 1; fi
done
sleep 0.5
if crashed; then report "the game stopped after the key presses"; exit 1; fi
echo "PYGAME_SMOKE: OK - window opened, $pressed real key presses, no Python error (python: $py, entry: $entry; virtual display, not a physical monitor)"
