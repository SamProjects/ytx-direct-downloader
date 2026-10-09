// UrlSource asks for open-ended ranges, but GM's adapter buffers each response.
// Cap those reads; UrlSource resumes capped responses as needed.
export function boundedRangeFetch(fetchFn, chunkSize = 4 * 1024 * 1024) {
  return async (input, init = {}) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init.headers).forEach((value, name) => headers.set(name, value));
    const match = headers.get('range')?.match(/^bytes=(\d+)-(\d*)$/i);
    if (!match || String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase() !== 'GET') {
      return fetchFn(input, init);
    }
    const start = Number(match[1]);
    const end = Math.min(match[2] ? Number(match[2]) : Infinity, start + chunkSize - 1);
    headers.set('range', `bytes=${start}-${end}`);
    const response = await fetchFn(input, { ...init, headers });
    if (response.status === 206) {
      const range = response.headers.get('content-range')?.match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
      if (!range || Number(range[1]) !== start || Number(range[2]) < start || Number(range[2]) > end
        || (range[3] !== '*' && Number(range[3]) <= Number(range[2]))) {
        throw new Error('Invalid media range response.');
      }
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength !== Number(range[2]) - start + 1) throw new Error('Incomplete media range.');
      const result = new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
      Object.defineProperty(result, 'url', { value: response.url });
      return result;
    }
    return response;
  };
}

// Concurrent network reads, bounded buffers, and one serialized disk writer.
export async function downloadRanges({
  url, fileHandle, task, fetchFn, waitForTask, concurrency = 4,
  chunkSize = 4 * 1024 * 1024, onProgress
}) {
  let controller = new AbortController();
  task.controller = controller;
  let fatal = null;
  let writer;
  let written = 0;
  let total = 0;
  let writeQueue = Promise.resolve();
  let validator = null;

  const checkpoint = async () => {
    await waitForTask(task);
    if (fatal) throw fatal;
    // Pause aborts the whole request group. Resume creates a fresh group.
    if (controller.signal.aborted) {
      controller = new AbortController();
      task.controller = controller;
    }
  };
  const request = async (start, end) => {
    let attempts = 0;
    while (true) {
      await checkpoint();
      const signal = controller.signal;
      try {
        const headers = { Range: `bytes=${start}-${end}` };
        if (validator) headers['If-Range'] = validator;
        const response = await fetchFn(url, { headers, signal });
        if ([408, 429, 500, 502, 503, 504].includes(response.status)) {
          throw new TypeError(`Retryable HTTP ${response.status}`);
        }
        return response;
      } catch (error) {
        if (fatal || task.cancelRequested) throw fatal || error;
        if (signal.aborted) continue; // Retry the interrupted block after resume.
        if (!(error instanceof TypeError || error?.name === 'TimeoutError') || attempts++ >= 3) throw error;
        await new Promise((resolve) => {
          const done = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', done);
            resolve();
          };
          const timer = setTimeout(done, Math.min(1000 * 2 ** (attempts - 1), 8000));
          signal.addEventListener('abort', done, { once: true });
          if (signal.aborted) done();
        });
      }
    }
  };
  const readRange = async (response, start, requestedEnd, expectedTotal = null) => {
    if (response.status !== 206) throw new Error(`Media download failed (HTTP ${response.status}); expected partial content.`);
    const match = response.headers.get('content-range')?.match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
    if (response.status !== 206 || !match) throw new Error('Invalid HTTP range response.');
    const rangeStart = Number(match[1]);
    const rangeEnd = Number(match[2]);
    const rangeTotal = match[3] === '*' ? null : Number(match[3]);
    if (![rangeStart, rangeEnd].every(Number.isSafeInteger)
      || rangeStart !== start || rangeEnd < start || rangeEnd > requestedEnd
      || (rangeTotal !== null && (!Number.isSafeInteger(rangeTotal) || rangeTotal <= rangeEnd))
      || (expectedTotal !== null && (rangeTotal !== expectedTotal || rangeEnd !== requestedEnd))) {
      throw new Error('Media range or file size changed during download.');
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== rangeEnd - rangeStart + 1) throw new Error('Incomplete media range.');
    return { bytes, total: rangeTotal };
  };
  const write = (start, bytes) => {
    writeQueue = writeQueue.then(async () => {
      await checkpoint();
      await writer.write({ type: 'write', position: start, data: bytes });
      written += bytes.length;
      onProgress?.({ loaded: written, total, ratio: total ? Math.min(written / total, 0.999) : null });
    });
    return writeQueue;
  };

  try {
    // Reuse the probe as the first data block; don't trust a cached file size.
    const probe = await request(0, chunkSize - 1);
    let first;
    if (probe.status === 200) {
      first = new Uint8Array(await probe.arrayBuffer());
      if (!first.length) throw new Error('Empty media response.');
      total = first.length;
    } else {
      const range = await readRange(probe, 0, chunkSize - 1);
      // Unknown length keeps the existing sequential downloader as a fallback.
      if (range.total === null) return false;
      first = range.bytes;
      total = range.total;
      const etag = probe.headers.get('etag');
      validator = etag && !etag.startsWith('W/') ? etag : probe.headers.get('last-modified');
    }
    await checkpoint();
    writer = await fileHandle.createWritable();
    await write(0, first);
    let next = first.length;
    const worker = async () => {
      try {
        while (true) {
          await checkpoint();
          if (next >= total) return;
          const start = next;
          const end = Math.min(total - 1, start + chunkSize - 1);
          next = end + 1;
          const response = await request(start, end);
          const { bytes } = await readRange(response, start, end, total);
          // Await disk writes before taking another block: memory stays bounded.
          await write(start, bytes);
        }
      } catch (error) {
        fatal ||= error;
        controller.abort();
        throw error;
      }
    };
    const results = await Promise.allSettled(Array.from(
      { length: Math.min(Math.max(1, Math.floor(concurrency)), 8, Math.ceil((total - next) / chunkSize)) },
      worker
    ));
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
    await checkpoint();
    if (written !== total) throw new Error('Downloaded file is incomplete.');
    await writer.close();
    writer = null;
    onProgress?.({ loaded: written, total, ratio: 1 });
    return true;
  } catch (error) {
    fatal ||= error;
    controller.abort();
    await writeQueue.catch(() => {});
    if (writer) await writer.abort().catch(() => {});
    throw error;
  } finally {
    if (task.controller === controller) task.controller = null;
  }
}
