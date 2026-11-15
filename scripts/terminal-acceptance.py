#!/usr/bin/env python3
"""Exercise the shipped CLI in a real POSIX pseudo-terminal, with an offline API fixture."""
import errno
import fcntl
import http.server
import json
import os
import pathlib
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time

ENTRY = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'dist/index.js').resolve()
NODE = sys.argv[2] if len(sys.argv) > 2 else 'node'
requests = []

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        requests.append(body)
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        last = body['messages'][-1]['content']
        text = 'TUI_RESPONSE_OK' if last != 'slow' else 'WAITING_FOR_STOP'
        chunks = [({'role': 'assistant', 'content': text}, None)]
        if last != 'slow':
            chunks.append(({}, 'stop'))
        try:
            for delta, finish in chunks:
                frame = {'id': 'pty-test', 'object': 'chat.completion.chunk', 'created': 1,
                         'model': 'llama3.2', 'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
                self.wfile.write(('data: ' + json.dumps(frame) + '\n\n').encode())
                self.wfile.flush()
            if last == 'slow':
                # Wait for the test to release this request; no live service or charged call.
                release.wait(5)
            else:
                self.wfile.write(b'data: [DONE]\n\n')
        except (BrokenPipeError, ConnectionResetError):
            pass

release = threading.Event()
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
with tempfile.TemporaryDirectory(prefix='modkh-pty-') as home:
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 32, 110, 0, 0))
    before = termios.tcgetattr(slave)
    env = dict(os.environ, MODKH_HOME=home, TERM='xterm-256color',
               OLLAMA_BASE_URL=f'http://127.0.0.1:{server.server_port}/v1')
    env.pop('MODKH_PLAIN', None)
    env.pop('NO_COLOR', None)  # This isolated run verifies blue; unit tests cover NO_COLOR.
    child = subprocess.Popen([NODE, str(ENTRY)], stdin=slave, stdout=slave, stderr=slave, env=env)
    output = b''
    checkpoint = 0

    def wait_for(text, timeout=8):
        global output
        deadline = time.monotonic() + timeout
        target = text.encode()
        while target not in output[checkpoint:]:
            if child.poll() is not None:
                raise AssertionError(f'CLI exited {child.returncode}: {output[-4000:]!r}')
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssertionError(f'Missing {text!r}: {output[-6000:]!r}')
            ready, _, _ = select.select([master], [], [], remaining)
            if ready:
                try:
                    output += os.read(master, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    raise AssertionError(f'PTY closed before {text!r}') from error

    def send(data):
        global checkpoint
        checkpoint = len(output)
        os.write(master, data.encode())

    try:
        wait_for('何を調べますか')
        assert '██████'.encode() in output and b'MODKH' in output
        wait_for('\x1b[?25h')
        welcome = output.rsplit(b'\x1b[H', 1)[-1].decode()
        lines = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', welcome).split('\r\n')
        editor_row = next(i for i, line in enumerate(lines) if '何を調べますか' in line)
        logo_row = next(i for i, line in enumerate(lines) if '██████' in line)
        assert 14 <= editor_row <= 23, f'editor is not near the center: {editor_row}'
        assert 0 < editor_row - logo_row <= 12, 'logo and input are disconnected'
        assert '\x1b[34m' in welcome and '\x1b[35m' not in welcome, 'expected blue accents'
        send('/conn')
        wait_for('Commands')
        send('\r')
        wait_for('Hermes Agent')
        for provider in ['OpenAI', 'OpenCode', 'Ollama Local', 'Ollama Cloud', 'OpenRouter', 'Infron', 'Hermes Agent']:
            assert provider.encode() in output[checkpoint:], provider
        send('oll')
        wait_for('Ollama')
        send('\r')
        wait_for('ollama/llama3.2')
        send('\r')
        wait_for('接続しました: ollama/llama3.2')
        send('こんにちは\r')
        wait_for('TUI_RESPONSE_OK')
        wait_for('応答終了')
        send('slow\r')
        wait_for('WAITING_FOR_STOP')
        send('\x03')
        wait_for('中断しました')
        release.set()
        send('/connect\r')
        wait_for('Hermes Agent')
        send('\x1b')
        wait_for('何を調べますか')
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 16, 42, 0, 0))
        child.send_signal(signal.SIGWINCH)
        send('/exit\r')
        child.wait(timeout=8)
        assert child.returncode == 0, child.returncode
        # Raw mode must be restored even after Stop and terminal resize.
        after = termios.tcgetattr(slave)
        assert before[3] == after[3], 'terminal local flags not restored'
        sessions = list((pathlib.Path(home) / 'sessions').glob('*.jsonl'))
        assert len(sessions) == 1
        journal = sessions[0].read_text()
        assert journal.count('こんにちは') == 1, journal
        assert len(requests) == 2, requests
        print('PTY_ACCEPTANCE_OK: centered blue welcome, completion, seven providers, search, connect, streamed response, Stop, Esc, resize, cleanup')
    finally:
        release.set()
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
        os.close(slave)
        server.shutdown()
        server.server_close()
