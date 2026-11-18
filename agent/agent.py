#!/usr/bin/env python3
"""
RemoteLink Agent — عميل التحكم المحلي.
يستقبل أوامر الفأرة ولوحة المفاتيح من صفحة RemoteLink المفتوحة على نفس الجهاز
(عبر ws://127.0.0.1:8765) وينفّذها على الشاشة. لا يستمع إلا على localhost.

التثبيت:  pip install websockets pyautogui
التشغيل:  python agent.py   [--monitor N]
"""
import argparse, asyncio, json, sys

try:
    import pyautogui
    import websockets
except ImportError:
    sys.exit("ثبّت المتطلبات أولاً:  pip install websockets pyautogui")

pyautogui.FAILSAFE = False
pyautogui.PAUSE = 0

# تحويل أسماء مفاتيح المتصفح إلى أسماء pyautogui
KEYMAP = {
    'Enter': 'enter', 'Backspace': 'backspace', 'Tab': 'tab', 'Escape': 'esc', ' ': 'space',
    'ArrowUp': 'up', 'ArrowDown': 'down', 'ArrowLeft': 'left', 'ArrowRight': 'right',
    'Delete': 'delete', 'Home': 'home', 'End': 'end', 'PageUp': 'pageup', 'PageDown': 'pagedown',
    'Insert': 'insert', 'CapsLock': 'capslock', 'Control': 'ctrl', 'Shift': 'shift', 'Alt': 'alt',
    'Meta': 'win' if sys.platform.startswith('win') else 'command', 'AltGraph': 'altright',
    'PrintScreen': 'printscreen', 'ContextMenu': 'apps',
    **{f'F{i}': f'f{i}' for i in range(1, 13)},
}

def region(monitor):
    """إرجاع (x, y, w, h) للشاشة المختارة."""
    if monitor is not None:
        try:
            import mss
            m = mss.mss().monitors[monitor]
            return m['left'], m['top'], m['width'], m['height']
        except Exception:
            pass
    w, h = pyautogui.size()
    return 0, 0, w, h

def key_name(msg):
    k = msg.get('key', '')
    if k in KEYMAP:
        return KEYMAP[k]
    if len(k) == 1:
        return k.lower() if msg.get('ctrl') or msg.get('alt') or msg.get('meta') else k
    return None

def handle(msg, area):
    ox, oy, w, h = area
    k = msg.get('k')
    if 'x' in msg and 'y' in msg:
        x, y = ox + msg['x'] * w, oy + msg['y'] * h
    if k == 'move':
        pyautogui.moveTo(x, y)
    elif k == 'down':
        pyautogui.mouseDown(x, y, button=msg.get('button', 'left'))
    elif k == 'up':
        pyautogui.mouseUp(x, y, button=msg.get('button', 'left'))
    elif k == 'click':
        pyautogui.click(x, y, button=msg.get('button', 'left'))
    elif k == 'wheel':
        if msg.get('dy'):
            pyautogui.scroll(-int(msg['dy']) * 120 if sys.platform.startswith('win') else -int(msg['dy']) * 3)
        if msg.get('dx'):
            try: pyautogui.hscroll(int(msg['dx']) * 3)
            except Exception: pass
    elif k in ('keydown', 'keyup'):
        name = key_name(msg)
        if not name:
            return
        # الحروف العادية بدون مفاتيح تعديل تُكتب مباشرة (يدعم العربية عبر write)
        if k == 'keydown' and len(msg.get('key', '')) == 1 and not (msg.get('ctrl') or msg.get('alt') or msg.get('meta')):
            if msg['key'].isascii():
                pyautogui.press(msg['key'])
            else:
                try:
                    import pyperclip
                    pyperclip.copy(msg['key']); pyautogui.hotkey('ctrl', 'v')
                except Exception:
                    pass
            return
        if len(msg.get('key', '')) == 1 and k == 'keyup':
            return
        (pyautogui.keyDown if k == 'keydown' else pyautogui.keyUp)(name)

async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--monitor', type=int, default=None, help='رقم الشاشة (1 = الأولى) عند تعدد الشاشات؛ يتطلب pip install mss')
    a = ap.parse_args()
    area = region(a.monitor)

    async def serve(ws):
        print('✓ اتصلت صفحة RemoteLink')
        try:
            async for raw in ws:
                try:
                    handle(json.loads(raw), area)
                except Exception as e:
                    print('خطأ في تنفيذ الأمر:', e)
        finally:
            print('✗ انقطع اتصال الصفحة')

    async with websockets.serve(serve, '127.0.0.1', a.port):
        print(f'RemoteLink Agent يعمل على ws://127.0.0.1:{a.port}  — الشاشة: {area[2]}x{area[3]}')
        print('اترك هذه النافذة مفتوحة أثناء الجلسة. Ctrl+C للإيقاف.')
        await asyncio.Future()

if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
