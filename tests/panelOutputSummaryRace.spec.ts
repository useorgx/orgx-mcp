import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync('public/widgets/shared/panel/panel-app.js', 'utf8');
const start = source.indexOf('    function fetchView(kind)');
const end = source.indexOf('    /** Say a sentence', start);
if (start < 0 || end < start) throw new Error('Panel output read functions moved');
const functions = source.slice(start, end);
const id = 'a1111111-1111-4111-8111-111111111111';
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(delayedDetail = false) {
  let releaseList!: (value: unknown) => void;
  let releaseDetail!: (value: unknown) => void;
  let details = 0;
  const canonical = { data: {}, meta: { previews: { [id]: { preview: 'Body', frontDoor: { answer: 'Canonical answer' } } } } };
  const ui = { generation: 1, tab: 'outputs', outputsPhase: 'ready', outSel: id, outPreviews: {} as Record<string, { frontDoor?: { answer: string } }>, outDoorPending: {} };
  const reads = runInNewContext(functions + '\n({fetchOutputs,fetchOutputSummary})', {
    ui, isGallery: false, PREVIEW_META_KEY: 'previews', GOAL_REASONS_META_KEY: 'goals',
    render() {}, accept() {}, isSnapshot() { return false; },
    observeRead(_key: string, _origin: string, promise: Promise<unknown>) { return promise; },
    R: { callToolResult(_name: string, args: { query?: string }) {
      if (!args.query) return new Promise(resolve => { releaseList = resolve; });
      details++;
      return delayedDetail ? new Promise(resolve => { releaseDetail = resolve; }) : Promise.resolve(canonical);
    } },
  }) as { fetchOutputs(): void; fetchOutputSummary(id: string): void };
  return { ui, reads, canonical, details: () => details, releaseList() { releaseList({ data: { outputs: { items: [{ id }] } }, meta: { previews: { [id]: { preview: 'Compact body' } } } }); }, releaseDetail() { releaseDetail(canonical); } };
}

describe('selected panel output read ordering', () => {
  it('rereads the selected canonical summary when an older list finishes later', async () => {
    const f = fixture();
    f.reads.fetchOutputs(); f.reads.fetchOutputSummary(id);
    await tick();
    expect(f.ui.outPreviews[id]?.frontDoor?.answer).toBe('Canonical answer');
    f.releaseList(); await tick();
    expect(f.details()).toBe(2);
    expect(f.ui.outPreviews[id]?.frontDoor?.answer).toBe('Canonical answer');
  });
  it('lets an already pending selected-detail read settle without another request', async () => {
    const f = fixture(true);
    f.reads.fetchOutputs(); f.reads.fetchOutputSummary(id);
    f.releaseList(); await tick();
    expect(f.details()).toBe(1);
    f.releaseDetail(); await tick();
    expect(f.ui.outPreviews[id]?.frontDoor?.answer).toBe('Canonical answer');
  });
  it('does not let the previous workspace list start another detail read', async () => {
    const f = fixture(); f.reads.fetchOutputs(); f.ui.generation++;
    f.releaseList(); await tick();
    expect(f.details()).toBe(0);
    expect(f.ui.outPreviews).toEqual({});
  });
});
