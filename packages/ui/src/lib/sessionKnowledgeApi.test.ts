import { afterAll, expect, test } from 'bun:test';
import { fetchSessionKnowledge, fetchSessionKnowledgeSummary, reportSessionKnowledgeDelivered } from './sessionKnowledgeApi';
import { switchRuntimeEndpoint } from './runtime-switch';

const originalFetch = globalThis.fetch;
let body = 'Original';
let fail = false;
let reads = 0;
let deliveryResponse: Promise<Response> | null = null;
let knowledgeReads = 0;
globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.includes('/session-knowledge/delivered') && deliveryResponse) return deliveryResponse;
  if (url.includes('/session-knowledge?')) {
    knowledgeReads += 1;
    return Response.json({ text: '', signature: '' });
  }
  if (!url.includes('/session-knowledge/summary')) return Response.json({});
  reads += 1;
  return fail ? Response.json({ error: 'offline' }, { status: 503 }) : Response.json({
    notes: [{ id: 'n1', body }], plans: [{ id: 'p1', title: 'Plan' }], memory: { global: 0, project: 0 },
  });
}, originalFetch);
afterAll(() => { globalThis.fetch = originalFetch; });

test('the next knowledge read waits for a pending delivery report', async () => {
  let resolve!: (response: Response) => void;
  deliveryResponse = new Promise<Response>((done) => { resolve = done; });
  const report = reportSessionKnowledgeDelivered('/delivery', 's-delivery', 'signature');
  const knowledge = fetchSessionKnowledge('/delivery', 's-delivery');
  expect(knowledgeReads).toBe(0);
  resolve(Response.json({ ok: true }));
  await report;
  expect(await knowledge).toEqual({ text: '', signature: '' });
  expect(knowledgeReads).toBe(1);
  deliveryResponse = null;
});

test('a failed delivery report releases the next knowledge read', async () => {
  let reject!: (error: Error) => void;
  deliveryResponse = new Promise<Response>((_done, fail) => { reject = fail; });
  const report = reportSessionKnowledgeDelivered('/delivery', 's-failed', 'signature');
  const knowledge = fetchSessionKnowledge('/delivery', 's-failed');
  reject(new Error('offline'));
  await report;
  expect(await knowledge).toEqual({ text: '', signature: '' });
  expect(knowledgeReads).toBe(2);
  deliveryResponse = null;
});

test('peer changes can bypass the cached attachment summary without changing IDs', async () => {
  const initial = await fetchSessionKnowledgeSummary('/summary', 's1');
  body = 'Peer edit';
  expect(await fetchSessionKnowledgeSummary('/summary', 's1')).toEqual(initial);
  expect(reads).toBe(1);
  const refreshed = await fetchSessionKnowledgeSummary('/summary', 's1', { fresh: true });
  expect(refreshed?.notes).toEqual([{ id: 'n1', body: 'Peer edit' }]);
  expect(refreshed?.plans.map(plan => plan.id)).toEqual(['p1']);
  expect(reads).toBe(2);
});

test('failure is distinct from an authoritative empty attachment list', async () => {
  fail = true;
  expect(await fetchSessionKnowledgeSummary('/summary', 's1', { fresh: true })).toBeNull();
  fail = false;
});

test('same-path sessions on another runtime cannot reuse the old summary', async () => {
  switchRuntimeEndpoint({ apiBaseUrl: 'http://other.test', runtimeKey: 'summary-other' });
  body = 'Other runtime';
  const summary = await fetchSessionKnowledgeSummary('/summary', 's1');
  expect(summary?.notes[0].body).toBe('Other runtime');
});
