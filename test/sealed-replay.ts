import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Verify exactly the bytes sealed by the recorder, including each rotated segment. */
export function readSealedReplay(run: string) {
  const manifest = JSON.parse(fs.readFileSync(path.join(run, 'manifest.json'), 'utf8'));
  const hash = createHash('sha256');
  const events = [];
  for (const segment of manifest.integrity.segments ?? [{ name: 'events.jsonl' }]) {
    const bytes = fs.readFileSync(path.join(run, segment.name));
    hash.update(bytes);
    if (segment.sha256) assert.equal(createHash('sha256').update(bytes).digest('hex'), segment.sha256);
    for (const line of bytes.toString().trimEnd().split('\n')) {
      const event = JSON.parse(line);
      assert.equal(event.seq, events.length);
      events.push(event);
    }
  }
  assert.equal(hash.digest('hex'), manifest.integrity.events_sha256);
  assert.equal(events.length, manifest.counts.events);
  assert.equal(events.at(-1)?.type, 'run.end');
  return events;
}
