#!/usr/bin/env python3
"""Installed-package check: empty MODKH_HOME -> automatic TypeScript server -> diagnostics.

Runs the published CLI from the tarball install against a project with a real type error, using an
offline OpenAI-compatible model fixture that asks for read_file. No network is needed after the
isolated install. Verifies automatic install, a genuine type diagnostic, no reinstall on reuse,
and that the diagnostic disappears after the edit.
"""
import http.server
import json
import os
import subprocess
import sys
import threading
import time
from language_acceptance_state import analysis_observed, retry_read

cli, work, project = sys.argv[1], sys.argv[2], sys.argv[3]
home = os.path.join(work, "lang-home")
env = {**os.environ, "MODKH_HOME": home, "MODKH_PLAIN": "1"}
failures = []
requests = []
analysis_started = None


def check(label, condition, detail=""):
    print(("ok: " if condition else "FAIL: ") + label)
    if not condition:
        failures.append(f"{label}: {detail}")


class Model(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        global analysis_started
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        requests.append(body)
        results = [m for m in body["messages"] if m.get("role") == "tool"]
        observed = json.loads(results[-1]["content"])["output"] if results else ""
        if results and analysis_started is None:
            analysis_started = time.monotonic()
        waiting = bool(results) and retry_read(observed, time.monotonic() - analysis_started)
        if not results or waiting:
            if waiting:
                time.sleep(0.5)
            delta = {"tool_calls": [{"index": 0, "id": f"call_{len(requests)}", "type": "function",
                                     "function": {"name": "read_file", "arguments": json.dumps({"path": "src/bad.ts"})}}]}
            finish = "tool_calls"
        else:
            delta = {"content": "OBSERVED_ANALYSIS " + observed.replace("\n", " | ")[:1500]}
            finish = "stop"
        payload = json.dumps({"id": "c", "object": "chat.completion.chunk", "created": 1, "model": "fixture",
                              "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]})
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        self.wfile.write(f"data: {payload}\n\ndata: [DONE]\n\n".encode())


server = http.server.HTTPServer(("127.0.0.1", 0), Model)
threading.Thread(target=server.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{server.server_port}/v1"


def run_cli(prompt="Read src/bad.ts and report what the analysis says.\n/exit\n"):
    global analysis_started
    analysis_started = None
    return subprocess.run(["node", cli, "chat", "--cwd", project, "--model", "compatible/fixture", "--base-url", base],
                          input=prompt, capture_output=True, text=True, env=env, timeout=600)


def state():
    with open(os.path.join(home, "language", "state.json"), encoding="utf-8") as handle:
        return json.load(handle)


try:
    first = run_cli()
    check("the CLI exited cleanly", first.returncode == 0, first.stderr[-1200:])
    state_path = os.path.join(home, "language", "state.json")
    check("a language server was installed into the managed area", os.path.exists(state_path))
    check("the project gained no server dependency", not os.path.exists(os.path.join(project, "node_modules")))
    check("the project lockfile was not modified", not os.path.exists(os.path.join(project, "package-lock.json")))
    check("the model received a real type diagnostic",
          analysis_observed(first.stdout) and "Type 'string' is not assignable to type 'number'" in first.stdout, first.stdout[-1500:])
    check("the analysis was reached through the ordinary read path", len(requests) >= 2 and all(
        call["function"]["name"] == "read_file"
        for request in requests for message in request["messages"]
        for call in message.get("tool_calls", [])), str(len(requests)))

    before = state()
    with open(os.path.join(project, "src", "bad.ts"), "w", encoding="utf-8") as handle:
        handle.write("export const value: number = 42;\n")
    second = run_cli()
    check("the reuse CLI exited cleanly", second.returncode == 0, second.stderr[-1200:])
    after = state()
    check("reuse did not reinstall the server", before["servers"] == after["servers"])
    check("the fixed file no longer reports the type error",
          analysis_observed(second.stdout) and "診断0件" in second.stdout
          and "Type 'string' is not assignable to type 'number'" not in second.stdout, second.stdout[-1500:])
    diagnostics_lines = [line for line in second.stdout.splitlines() if "OBSERVED_ANALYSIS" in line]
    check("the second read still carried analysis output", bool(diagnostics_lines), second.stdout[-800:])

    status = subprocess.run(["node", cli, "language", "status"], capture_output=True, text=True, env=env, timeout=120)
    check("language status reports typescript as installed", "typescript" in status.stdout and "yes" in status.stdout,
          status.stdout[:600])
    check("language status did not change the managed state", state() == after)
finally:
    server.shutdown()

if failures:
    print("\n".join(failures))
    sys.exit(1)
print("LANGUAGE_ACCEPTANCE_OK")
