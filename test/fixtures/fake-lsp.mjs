/**
 * A controllable LSP server used to test states a real server cannot reproduce reliably:
 * silent (no diagnostics), stale versions, and a crash mid-session.
 * Mode comes from FAKE_LSP_MODE; documents come from the client over stdio JSON-RPC.
 */
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node';

const mode = process.argv[2] ?? process.env.FAKE_LSP_MODE ?? 'clean';
const connection = createMessageConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout),
);
let crashed = false;

connection.onRequest('initialize', () => ({
  capabilities: {
    textDocumentSync: 1,
    hoverProvider: true,
    definitionProvider: true,
    referencesProvider: true,
  },
  serverInfo: { name: 'fake', version: '1' },
}));
connection.onNotification('initialized', () => {});
connection.onNotification('textDocument/didOpen', params => deliver(params));
connection.onNotification('textDocument/didChange', params => deliver(params));
connection.onNotification('textDocument/didSave', () => {});
connection.onNotification('textDocument/didClose', () => {});
connection.onRequest('shutdown', () => null);
connection.onNotification('exit', () => process.exit(0));

connection.onRequest('textDocument/hover', params => {
  const doc = documents.get(params.textDocument.uri);
  return { contents: { kind: 'markdown', value: `HOVER ${params.position.line}:${params.position.character} ${doc?.text.length ?? 0}` } };
});
connection.onRequest('textDocument/definition', params => {
  const uri = params.textDocument.uri;
  if (mode === 'no-definition') return null;
  return [{ uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }];
});
connection.onRequest('textDocument/references', params => {
  if (mode === 'crash-on-references') { process.exit(0); }
  return [{ uri: params.textDocument.uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }];
});

const documents = new Map();

function deliver(params) {
  const uri = params.textDocument?.uri;
  const text = params.contentChanges?.[0]?.text ?? params.textDocument?.text ?? '';
  const version = params.textDocument?.version;
  if (typeof uri === 'string') documents.set(uri, { text, version });
  if (mode === 'silent') return;
  if (mode === 'crash') { process.exit(0); }
  if (mode === 'stale') {
    connection.sendNotification('textDocument/publishDiagnostics', {
      uri, version: Math.max(0, (version ?? 1) - 1),
      diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: 'STALE_DIAGNOSTIC' }],
    });
    return;
  }
  const diagnostics = text.includes('BROKEN')
    ? [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, severity: 1, message: 'BROKEN_FOUND', source: 'fake' }]
    : [];
  connection.sendNotification('textDocument/publishDiagnostics', { uri, version, diagnostics });
}

if (mode === 'no-initialize') {
  // Accept bytes but never answer initialize: the client must time out, not hang forever.
  process.stdin.resume();
} else {
  connection.listen();
}
void crashed;
