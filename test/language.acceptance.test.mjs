import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('language acceptance waits for observed diagnostics and bounds silent-server retries', () => {
  const result = spawnSync('python3', ['-B', '-c', `
from language_acceptance_state import analysis_observed, retry_read
waiting = '解析: partial typescript [typescript:waiting]'
error = "解析: ok typescript [typescript:observed]。1件\\nType 'string' is not assignable to type 'number'"
clean = '解析: ok typescript [typescript:observed]。診断0件'
expected = "Type 'string' is not assignable to type 'number'"
assert not analysis_observed(waiting)
assert retry_read(waiting, 1, expected)
assert not retry_read(waiting, 30, expected)
assert analysis_observed(error) and not retry_read(error, 1, expected)
assert analysis_observed(clean) and retry_read(clean, 1, expected)
assert not retry_read(clean, 1, '診断0件')
assert not analysis_observed('解析: 未実施')
assert not retry_read('解析: 未実施', 1, expected)
`], { cwd: fileURLToPath(new URL('../scripts/', import.meta.url)), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('acceptance model polls a pending read in the same conversation and stops at the deadline', () => {
  const script = process.env.MODKH_ACCEPTANCE_SCRIPT ?? fileURLToPath(new URL('../scripts/language-acceptance.py', import.meta.url));
  const result = spawnSync('python3', ['-B', '-c', `
import ast, http.server, io, json, sys
from types import SimpleNamespace
from language_acceptance_state import retry_read
# Execute the actual HTTP handler without starting the package-install driver.
tree = ast.parse(open(sys.argv[1]).read())
handler = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'Model')
ns = dict(http=http, json=json, time=SimpleNamespace(monotonic=lambda: 1, sleep=lambda _: None),
          requests=[], analysis_started=None, retry_read=retry_read,
          expected_diagnostic="Type 'string' is not assignable to type 'number'")
exec(compile(ast.Module(body=[handler], type_ignores=[]), sys.argv[1], 'exec'), ns)
def respond(output=None):
    messages = [{'role':'user', 'content':'Read src/bad.ts'}]
    if output is not None:
        messages.append({'role':'tool', 'content':json.dumps({'output':output})})
    payload = json.dumps({'messages':messages}).encode()
    model = ns['Model'].__new__(ns['Model'])
    model.headers = {'content-length':len(payload)}
    model.rfile, model.wfile = io.BytesIO(payload), io.BytesIO()
    model.send_response = lambda *args: None
    model.send_header = lambda *args: None
    model.end_headers = lambda: None
    model.do_POST()
    return json.loads(model.wfile.getvalue().decode().splitlines()[0][6:])['choices'][0]
assert respond()['finish_reason'] == 'tool_calls'
waiting = '解析: partial typescript [typescript:waiting]'
assert respond(waiting)['finish_reason'] == 'tool_calls', 'waiting must not end the diagnostic check'
ready = "解析: ok typescript [typescript:observed]。1件\\nType 'string' is not assignable to type 'number'"
answer = respond(ready)
assert answer['finish_reason'] == 'stop'
assert "Type 'string'" in answer['delta']['content']
clean = '解析: ok typescript [typescript:observed]。診断0件'
assert respond(clean)['finish_reason'] == 'tool_calls', 'empty syntax report must not end the broken-file check'
assert respond(ready)['finish_reason'] == 'stop', 'the later semantic error completes the broken-file check'
ns['analysis_started'] = -29
assert respond(waiting)['finish_reason'] == 'stop', 'silent server must not loop at the 30-second deadline'
assert respond(clean)['finish_reason'] == 'stop', 'a missing semantic error must still reach the deadline'
ns['expected_diagnostic'] = '診断0件'
ns['analysis_started'] = None
assert respond(ready)['finish_reason'] == 'tool_calls', 'the fixed-file check waits for an observed clean report'
assert respond(clean)['finish_reason'] == 'stop'
`, script], { cwd: fileURLToPath(new URL('../scripts/', import.meta.url)), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
