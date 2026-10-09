import assert from 'node:assert/strict';
import test from 'node:test';
import { boundedRangeFetch, downloadRanges } from '../src/range-download.js';

const abortError = () => new DOMException('Aborted', 'AbortError');
const delay = (ms, signal) => new Promise((resolve, reject) => {
  const abort = () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    reject(abortError());
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', abort);
    resolve();
  }, ms);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
});
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Test timed out');
    await delay(1);
  }
}

function fixture({ concurrency = 4, size = 350, responseHook, writeHook, latency = 5 } = {}) {
  const source = Uint8Array.from({ length: size }, (_, index) => (index * 17) % 251);
  const disk = new Uint8Array(size);
  const requests = [];
  const writes = [];
  const progress = [];
  let active = 0;
  let peak = 0;
  let activeWrites = 0;
  let peakWrites = 0;
  let closed = false;
  let aborted = false;
  let opened = false;
  const task = { paused: false, cancelRequested: false };
  let resume;
  const waitForTask = async () => {
    if (task.paused) await new Promise((resolve) => { (task.waiters ||= []).push(resolve); });
    if (task.cancelRequested) throw abortError();
  };
  resume = () => {
    task.paused = false;
    task.waiters?.splice(0).forEach((resolve) => resolve());
  };
  const fetchFn = async (url, { headers, signal }) => {
    const [start, requestedEnd] = headers.Range.match(/\d+/g).map(Number);
    requests.push({ start, end: requestedEnd, headers });
    active++;
    peak = Math.max(peak, active);
    try {
      // Alternate latency so ranges finish out of order.
      await delay(start % 64 ? latency : latency * 2, signal);
      const end = Math.min(source.length - 1, requestedEnd);
      const response = new Response(source.slice(start, end + 1), {
        status: 206,
        headers: { 'Content-Range': `bytes ${start}-${end}/${source.length}`, ETag: '"media-v1"' }
      });
      return responseHook?.({ response, start, end, source, headers, requests }) || response;
    } finally { active--; }
  };
  const fileHandle = {
    async createWritable() {
      opened = true;
      return {
        async write({ position, data }) {
          assert.equal(aborted, false, 'No writes after abort');
          activeWrites++;
          peakWrites = Math.max(peakWrites, activeWrites);
          try {
            await delay(2);
            writeHook?.(position);
            disk.set(data, position);
            writes.push(position);
          } finally { activeWrites--; }
        },
        async close() { closed = true; },
        async abort() { aborted = true; }
      };
    }
  };
  return {
    source, disk, requests, writes, progress, task, resume,
    get active() { return active; },
    get peak() { return peak; },
    get peakWrites() { return peakWrites; },
    get closed() { return closed; },
    get aborted() { return aborted; },
    get opened() { return opened; },
    run: () => downloadRanges({
      url: 'https://video.twimg.com/example.mp4', fileHandle, task,
      fetchFn, waitForTask, concurrency, chunkSize: 32,
      onProgress(value) {
        if (value.ratio === 1) assert.equal(closed, true);
        progress.push(value);
      }
    })
  };
}

test('out-of-order ranges produce an identical file with bounded reads and serialized writes', async () => {
  const f = fixture();
  assert.equal(await f.run(), true);
  assert.deepEqual(f.disk, f.source);
  assert.equal(f.peak, 4);
  assert.equal(f.peakWrites, 1);
  assert.equal(f.closed, true);
  assert.equal(f.aborted, false);
  assert.notDeepEqual(f.writes, [...f.writes].sort((a, b) => a - b));
  assert.equal(f.requests.length, Math.ceil(f.source.length / 32));
  assert(f.requests.slice(1).every(({ headers }) => headers['If-Range'] === '"media-v1"'));
  assert.equal(f.progress.at(-1).loaded, f.source.length);
});

test('one connection stays sequential, including a short final block', async () => {
  const f = fixture({ concurrency: 1 });
  await f.run();
  assert.equal(f.peak, 1);
  assert.deepEqual(f.disk, f.source);
  assert.deepEqual(f.writes, [...f.writes].sort((a, b) => a - b));
});

test('a small file uses just the probe and finishes normally', async () => {
  const f = fixture({ size: 13 });
  await f.run();
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.disk, f.source);
});

test('HTTP 200 falls back to saving the full response without duplicate requests', async () => {
  const f = fixture({ responseHook: ({ source }) => new Response(source) });
  await f.run();
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.disk, f.source);
});

test('unknown total delegates to sequential fallback without opening a writer', async () => {
  const f = fixture({ responseHook: ({ response, start, end }) => {
    response.headers.set('Content-Range', `bytes ${start}-${end}/*`);
  } });
  assert.equal(await f.run(), false);
  assert.equal(f.opened, false);
});

test('pause aborts the request group; resume retries unfinished blocks only', async () => {
  const f = fixture({ latency: 25 });
  const running = f.run();
  await until(() => f.active === 4 && f.writes.length === 1);
  f.task.paused = true;
  f.task.controller.abort();
  await until(() => f.active === 0);
  const completed = f.writes.length;
  await delay(10);
  assert.equal(f.writes.length, completed);
  f.resume();
  await running;
  assert.deepEqual(f.disk, f.source);
  assert.equal(f.requests.filter(({ start }) => start === 0).length, 1);
  assert.equal(new Set(f.writes).size, f.writes.length);
});

test('cancellation aborts all requests and discards the partial file', async () => {
  const f = fixture({ latency: 25 });
  const running = f.run();
  await until(() => f.active === 4);
  f.task.cancelRequested = true;
  f.task.controller.abort();
  await assert.rejects(running, { name: 'AbortError' });
  assert.equal(f.active, 0);
  assert.equal(f.aborted, true);
  assert.equal(f.closed, false);
});

test('rejects wrong ranges, changed totals, missing headers, truncated bodies, and ignored Range', async (t) => {
  for (const kind of ['start', 'end', 'total', 'header', 'body', 'status']) {
    await t.test(kind, async () => {
      const f = fixture({ responseHook: ({ response, start, end, source }) => {
        if (!start) return;
        if (kind === 'start') response.headers.set('Content-Range', `bytes ${start + 1}-${end}/${source.length}`);
        if (kind === 'end') response.headers.set('Content-Range', `bytes ${start}-${end - 1}/${source.length}`);
        if (kind === 'total') response.headers.set('Content-Range', `bytes ${start}-${end}/${source.length + 1}`);
        if (kind === 'header') response.headers.delete('Content-Range');
        if (kind === 'body') return new Response(source.slice(start, end), { status: 206, headers: response.headers });
        if (kind === 'status') return new Response(source);
      } });
      await assert.rejects(f.run());
      assert.equal(f.aborted, true);
      assert.equal(f.closed, false);
      assert.equal(f.active, 0);
    });
  }
});

test('transient failure retries the affected block rather than restarting the file', async () => {
  let failed = false;
  const f = fixture({ responseHook: ({ start }) => {
    if (start === 32 && !failed) {
      failed = true;
      throw new TypeError('Temporary network failure');
    }
  } });
  await f.run();
  assert.deepEqual(f.disk, f.source);
  assert.equal(f.requests.filter(({ start }) => start === 32).length, 2);
  assert.equal(f.requests.filter(({ start }) => start === 0).length, 1);
});

test('disk failure stops workers before aborting the writer', async () => {
  const f = fixture({ writeHook(position) {
    if (position > 0) throw new Error('Disk full');
  } });
  await assert.rejects(f.run(), /Disk full/);
  assert.equal(f.active, 0);
  assert.equal(f.aborted, true);
  assert.equal(f.closed, false);
});

test('media reads cap open-ended and large ranges while preserving headers and URL', async () => {
  const seen = [];
  const fetch = boundedRangeFetch(async (input, init) => {
    seen.push(new Headers(init.headers));
    const [start, end] = init.headers.get('range').match(/\d+/g).map(Number);
    const response = new Response(new Uint8Array(end - start + 1), {
      status: 206, headers: { 'content-range': `bytes ${start}-${end}/1024` }
    });
    Object.defineProperty(response, 'url', { value: 'https://video.twimg.com/file.mp4' });
    return response;
  }, 32);
  const request = new Request('https://video.twimg.com/file.mp4', { headers: { Range: 'bytes=100-', 'X-Test': 'preserved' } });
  const response = await fetch(request);
  assert.equal(seen[0].get('range'), 'bytes=100-131');
  assert.equal(seen[0].get('x-test'), 'preserved');
  assert.equal(response.url, request.url);
  await fetch(request, { headers: { Range: 'bytes=100-200' } });
  assert.equal(seen[1].get('range'), 'bytes=100-131');
  await fetch(request, { headers: { Range: 'bytes=100-110' } });
  assert.equal(seen[2].get('range'), 'bytes=100-110');
});

test('media adapter passes manifest requests and unsupported Range responses through', async () => {
  const full = new Response('playlist');
  const init = { headers: { 'X-Test': 'yes' } };
  let seen;
  const fetch = boundedRangeFetch(async (input, options) => { seen = options; return full; });
  assert.equal(await fetch('https://video.twimg.com/file.m3u8', init), full);
  assert.equal(seen, init);
  assert.equal(await fetch('https://video.twimg.com/file.mp4', { headers: { Range: 'bytes=0-' } }), full);
});
