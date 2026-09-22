/** Parse a text/event-stream body into { event, data } records. */
export async function* parseSse(
  body: ReadableStream<Uint8Array> | null,
  signal?: AbortSignal,
): AsyncGenerator<{ event: string | undefined; data: string }> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let event: string | undefined;
  let data: string[] = [];
  const onAbort = () => reader.cancel().catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line === '') {
          if (data.length) yield { event, data: data.join('\n') };
          event = undefined;
          data = [];
          continue;
        }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
      }
    }
    if (data.length) yield { event, data: data.join('\n') };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock?.();
  }
}

/** Encode one SSE frame. */
export function sseFrame(data: unknown, event?: string): string {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  return (event ? `event: ${event}\n` : '') + `data: ${payload}\n\n`;
}
