/** Backpressure-aware SSE frame mapping. No background loop drains an unread response. */
export function mapSSE(
  upstream: ReadableStream<Uint8Array>,
  transform: (frame: string) => string,
  finished: () => void = () => {},
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder(), encoder = new TextEncoder();
  let buffer = "", eof = false, stopped = false, released = false;
  const release = () => {
    if (!released) { released = true; finished(); reader.releaseLock(); }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (!stopped) {
          const separator = /\r?\n\r?\n/.exec(buffer);
          if (separator) {
            const frame = buffer.slice(0, separator.index);
            buffer = buffer.slice(separator.index + separator[0].length);
            controller.enqueue(encoder.encode(transform(frame) + separator[0]));
            return;
          }
          if (eof) {
            if (buffer) controller.enqueue(encoder.encode(transform(buffer)));
            buffer = ""; stopped = true; release(); controller.close(); return;
          }
          // Do not silently buffer arbitrarily large malformed/unterminated SSE frames.
          if (buffer.length > 8 * 1024 * 1024) throw new Error("Upstream SSE frame exceeds 8 MiB");
          const next = await reader.read();
          if (stopped) return;
          if (next.done) { eof = true; buffer += decoder.decode(); }
          else buffer += decoder.decode(next.value, { stream: true });
        }
      } catch (error) {
        if (stopped) return;
        stopped = true; buffer = "";
        try { await reader.cancel(error); } finally { release(); controller.error(error); }
      }
    },
    async cancel(reason) {
      stopped = true; buffer = "";
      try { await reader.cancel(reason); } finally { release(); }
    }
  });
}
