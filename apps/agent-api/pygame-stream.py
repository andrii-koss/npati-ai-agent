"""Live Preview of a Pygame (desktop) game: the game runs in a virtual X display inside the Sandbox, and this HTTP server
streams its window to the browser as JPEG frames and sends the viewer's keys and clicks back as real X input (XTEST).

The Preview proxy carries plain HTTP only (no WebSocket), so the page polls /frame.jpg and posts input with /input.
Usage (from the project folder): python3 /opt/npati-qa/pygame-stream.py --port 6080 [--entry main.py]
"""
import argparse, ctypes, ctypes.util, io, json, os, shutil, subprocess, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

os.environ.setdefault("PYGAME_HIDE_SUPPORT_PROMPT", "1")

args = argparse.ArgumentParser()
args.add_argument("--port", type=int, default=int(os.environ.get("PORT", "6080")))
args.add_argument("--entry", default="")
options = args.parse_args()
entry = options.entry or next((name for name in ("main.py", "game.py", "app.py", "src/main.py") if os.path.isfile(name)), "main.py")
display = ":%d" % (100 + options.port % 400)


def python_for_game():
    venv = os.path.join(".venv", "bin", "python")
    if os.access(venv, os.X_OK) and subprocess.run([venv, "-c", "import pygame"], capture_output=True).returncode == 0:
        return venv
    return sys.executable


xvfb = subprocess.Popen(["Xvfb", display, "-screen", "0", "1280x960x24", "-nolisten", "tcp"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
env = dict(os.environ, DISPLAY=display, SDL_AUDIODRIVER="dummy")
os.environ["DISPLAY"] = display

x11 = ctypes.CDLL(ctypes.util.find_library("X11") or "libX11.so.6")
xtst = ctypes.CDLL(ctypes.util.find_library("Xtst") or "libXtst.so.6")


class XImage(ctypes.Structure):
    _fields_ = [("width", ctypes.c_int), ("height", ctypes.c_int), ("xoffset", ctypes.c_int), ("format", ctypes.c_int),
                ("data", ctypes.c_void_p), ("byte_order", ctypes.c_int), ("bitmap_unit", ctypes.c_int),
                ("bitmap_bit_order", ctypes.c_int), ("bitmap_pad", ctypes.c_int), ("depth", ctypes.c_int),
                ("bytes_per_line", ctypes.c_int), ("bits_per_pixel", ctypes.c_int)]


x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XDefaultRootWindow.restype = ctypes.c_ulong
x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
x11.XGetImage.restype = ctypes.POINTER(XImage)
x11.XGetImage.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_uint, ctypes.c_uint, ctypes.c_ulong, ctypes.c_int]
x11.XStringToKeysym.restype = ctypes.c_ulong
x11.XStringToKeysym.argtypes = [ctypes.c_char_p]
x11.XKeysymToKeycode.restype = ctypes.c_ubyte
x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
x11.XFlush.argtypes = [ctypes.c_void_p]
x11.XFree.argtypes = [ctypes.c_void_p]
xtst.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
xtst.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
xtst.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]

dpy = None
for _ in range(100):
    dpy = x11.XOpenDisplay(display.encode())
    if dpy:
        break
    time.sleep(0.05)
if not dpy:
    print("pygame-stream: the virtual display did not start", file=sys.stderr)
    sys.exit(1)
root = x11.XDefaultRootWindow(dpy)
lock = threading.Lock()

import pygame  # noqa: E402  (after DISPLAY is set; used only to encode frames)

state = {"game": None, "starts": 0, "last_error": "", "log": "", "window": None}


def run_game():
    """Starts the game and starts it again when it ends (Esc, game over that quits, or a crash), keeping its last error."""
    while True:
        log_path = "/tmp/pygame-stream-game-%d.log" % options.port
        with open(log_path, "w") as log:
            state["game"] = subprocess.Popen([python_for_game(), entry], env=env, stdout=log, stderr=subprocess.STDOUT)
            state["starts"] += 1
            state["window"] = None
            state["game"].wait()
        try:
            text = open(log_path, errors="replace").read()
        except OSError:
            text = ""
        if "Traceback (most recent call last)" in text:
            state["last_error"] = text[text.rfind("Traceback (most recent call last)"):][-1500:]
        time.sleep(1.5)


def game_window():
    """The game's window on the virtual screen: (x, y, width, height). Without a window manager it stays where SDL put it."""
    game = state["game"]
    if not game or game.poll() is not None:
        return None
    if state["window"]:
        return state["window"]
    found = subprocess.run(["xdotool", "search", "--onlyvisible", "--pid", str(game.pid)], capture_output=True, text=True, env=env).stdout.split()
    if not found:
        return None
    shell = subprocess.run(["xdotool", "getwindowgeometry", "--shell", found[0]], capture_output=True, text=True, env=env).stdout
    values = dict(line.split("=", 1) for line in shell.split() if "=" in line)
    try:
        window = (int(values["X"]), int(values["Y"]), int(values["WIDTH"]), int(values["HEIGHT"]))
    except (KeyError, ValueError):
        return None
    state["window"] = window
    # Keyboard focus follows the pointer when no window manager runs: keep the pointer over the game.
    with lock:
        xtst.XTestFakeMotionEvent(dpy, -1, window[0] + window[2] // 2, window[1] + window[3] // 2, 0)
        x11.XFlush(dpy)
    return window


def frame_jpeg():
    window = game_window()
    if not window:
        return None
    x, y, width, height = window
    with lock:
        image = x11.XGetImage(dpy, root, x, y, width, height, 0xFFFFFFFF, 2)  # ZPixmap
        if not image:
            return None
        try:
            data = ctypes.string_at(image.contents.data, image.contents.bytes_per_line * height)
            stride = image.contents.bytes_per_line
        finally:
            x11.XFree(image.contents.data)
            x11.XFree(image)
    if stride != width * 4:
        data = b"".join(data[row * stride: row * stride + width * 4] for row in range(height))
    # X gives B, G, R and an unused byte (zero): read as BGRA it is fully transparent and encodes black, so drop it.
    rgb = bytearray(width * height * 3)
    rgb[0::3], rgb[1::3], rgb[2::3] = data[2::4], data[1::4], data[0::4]
    surface = pygame.image.frombuffer(bytes(rgb), (width, height), "RGB")
    out = io.BytesIO()
    pygame.image.save(surface, out, "frame.jpg")
    return out.getvalue()


def send_key(name, down):
    keysym = x11.XStringToKeysym(name.encode())
    if not keysym:
        return False
    with lock:
        code = x11.XKeysymToKeycode(dpy, keysym)
        if not code:
            return False
        xtst.XTestFakeKeyEvent(dpy, code, 1 if down else 0, 0)
        x11.XFlush(dpy)
    return True


def send_click(fx, fy, button=1):
    window = game_window()
    if not window:
        return False
    x, y, width, height = window
    with lock:
        xtst.XTestFakeMotionEvent(dpy, -1, x + int(max(0.0, min(1.0, fx)) * (width - 1)), y + int(max(0.0, min(1.0, fy)) * (height - 1)), 0)
        xtst.XTestFakeButtonEvent(dpy, button, 1, 0)
        xtst.XTestFakeButtonEvent(dpy, button, 0, 0)
        x11.XFlush(dpy)
    return True


PAGE = """<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pygame</title><style>
html,body{margin:0;height:100%;background:#0b1020;color:#cbd5e1;font:14px system-ui,sans-serif}
#wrap{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;outline:none}
#screen{max-width:100%;max-height:100%;image-rendering:auto;box-shadow:0 0 0 1px #1e293b;cursor:pointer}
#hint{position:fixed;left:50%;bottom:10px;transform:translateX(-50%);background:#111827cc;padding:6px 12px;border-radius:999px;font-size:12px}
#error{position:fixed;left:12px;right:12px;top:12px;display:none;white-space:pre-wrap;background:#3f1d24;color:#fecaca;padding:10px;border-radius:8px;font:12px ui-monospace,monospace;max-height:40%;overflow:auto}
</style></head><body><div id="wrap" tabindex="0"><img id="screen" alt="Pygame window"></div>
<div id="hint">Натисніть на гру й керуйте з клавіатури · Click the game, then use the keyboard</div><pre id="error"></pre>
<script>(function(){
const token=new URLSearchParams(location.search).get("token")||"";
const base=location.pathname.endsWith("/")?location.pathname:location.pathname.replace(/[^/]*$/,"");
const url=(path,params)=>{const q=new URLSearchParams(params||{});if(token)q.set("token",token);return base+path+"?"+q};
const img=document.getElementById("screen"),wrap=document.getElementById("wrap"),err=document.getElementById("error");
let last=null,seq=0,shown=0;
// Each frame is a full round trip through the Preview proxy; two requests in flight double the frame rate, and an
// older frame that arrives late is dropped.
async function frame(){const n=++seq;try{const r=await fetch(url("frame.jpg",{t:Date.now()+"-"+n}),{cache:"no-store"});
 if(r.status===200&&n>shown){const b=await r.blob();if(n>shown){shown=n;const u=URL.createObjectURL(b);img.onload=()=>{if(last&&last!==u)URL.revokeObjectURL(last);last=u};img.src=u}}}catch(e){}
 setTimeout(frame,15)}
async function status(){try{const s=await (await fetch(url("status"),{cache:"no-store"})).json();
 err.style.display=s.lastError?"block":"none";err.textContent=s.lastError?"Гра зупинилась з помилкою і перезапущена · The game stopped with an error and was restarted:\\n"+s.lastError:""}catch(e){}
 setTimeout(status,2000)}
const keys={ArrowLeft:"Left",ArrowRight:"Right",ArrowUp:"Up",ArrowDown:"Down"," ":"space",Enter:"Return",Escape:"Escape",Backspace:"BackSpace",Tab:"Tab",Shift:"Shift_L",Control:"Control_L",Alt:"Alt_L"};
function keyName(e){if(keys[e.key])return keys[e.key];if(/^Key[A-Z]$/.test(e.code))return e.code.slice(3).toLowerCase();if(/^Digit[0-9]$/.test(e.code))return e.code.slice(5);return null}
const down=new Set();
function send(type,e){const k=keyName(e);if(!k)return;e.preventDefault();if(type==="down"){if(down.has(k))return;down.add(k)}else down.delete(k);
 fetch(url("input",{type:type,key:k}),{cache:"no-store"}).catch(()=>{})}
window.addEventListener("keydown",e=>send("down",e));window.addEventListener("keyup",e=>send("up",e));
window.addEventListener("blur",()=>{for(const k of down)fetch(url("input",{type:"up",key:k})).catch(()=>{});down.clear()});
img.addEventListener("mousedown",e=>{wrap.focus();const r=img.getBoundingClientRect();
 fetch(url("input",{type:"click",x:((e.clientX-r.left)/r.width).toFixed(4),y:((e.clientY-r.top)/r.height).toFixed(4),button:e.button===2?3:1})).catch(()=>{})});
img.addEventListener("contextmenu",e=>e.preventDefault());
wrap.focus();frame();setTimeout(frame,60);status();
})();</script></body></html>"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, body, kind):
        self.send_response(status)
        self.send_header("content-type", kind)
        self.send_header("cache-control", "no-store")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        name = url.path.rsplit("/", 1)[-1]
        query = {key: values[-1] for key, values in parse_qs(url.query).items()}
        if name == "frame.jpg":
            jpeg = frame_jpeg()
            return self.reply(200, jpeg, "image/jpeg") if jpeg else self.reply(204, b"", "text/plain")
        if name == "status":
            game = state["game"]
            body = {"running": bool(game and game.poll() is None), "starts": state["starts"], "window": state["window"], "lastError": state["last_error"], "entry": entry}
            return self.reply(200, json.dumps(body).encode(), "application/json")
        if name == "input":
            kind = query.get("type")
            ok = send_key(query.get("key", ""), kind == "down") if kind in ("down", "up") else \
                send_click(float(query.get("x", "0.5")), float(query.get("y", "0.5")), 3 if query.get("button") == "3" else 1) if kind == "click" else False
            return self.reply(200 if ok else 400, b"ok" if ok else b"unknown input", "text/plain")
        return self.reply(200, PAGE.encode(), "text/html; charset=utf-8")


if not shutil.which("xdotool"):
    print("pygame-stream: xdotool is missing", file=sys.stderr)
threading.Thread(target=run_game, daemon=True).start()
try:
    ThreadingHTTPServer(("0.0.0.0", options.port), Handler).serve_forever()
finally:
    if state["game"] and state["game"].poll() is None:
        state["game"].kill()
    xvfb.kill()
