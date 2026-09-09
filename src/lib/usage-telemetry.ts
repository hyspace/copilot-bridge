export interface UsageRecord {
  kind: "usage";
  id: string;
  timestamp: number;
  model: string;
  status: number;
  input: number | null;
  output: number | null;
  cached: number | null;
  /** Server-reported request charge. One credit is 1,000,000,000 nano-AIU. */
  nanoAiu: number | null;
  outcome: "complete" | "http_error" | "interrupted";
}

const MAX_EVENT = 256 * 1024;
const MAX_JSON = 4 * 1024 * 1024;
const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const billingNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    && value <= Number.MAX_SAFE_INTEGER ? value : null;

export function usageFrom(value: any) {
  const envelope = value?.response ?? value?.message ?? value;
  const usage = envelope?.usage;
  const input = number(usage?.input_tokens ?? usage?.prompt_tokens);
  const output = number(usage?.output_tokens ?? usage?.completion_tokens);
  const result = {
    input, output,
    cached: number(usage?.input_tokens_details?.cached_tokens
      ?? usage?.prompt_tokens_details?.cached_tokens),
    nanoAiu: billingNumber(usage?.copilot_usage?.total_nano_aiu
      ?? envelope?.copilot_usage?.total_nano_aiu),
  };
  // Billing and token counters are independent. Some stream frames contain only one.
  return Object.values(result).some(value => value !== null) ? result : null;
}

/** Observation only: each original byte is forwarded unchanged. No tee/read-ahead branch. */
export function observeResponse(
  response: Response,
  metadata: Pick<UsageRecord, "id" | "timestamp" | "model">,
  report: (record: UsageRecord) => void,
): Response {
  if (!response.body) {
    report({ ...metadata, kind: "usage", status: response.status,
      input: null, output: null, cached: null, nanoAiu: null,
      outcome: response.ok ? "complete" : "http_error" });
    return response;
  }
  const sse = response.headers.get("content-type")?.includes("text/event-stream") ?? false;
  let buffer = "";
  let overflow = false;
  let emitted = false;
  let completed = !sse;
  let streamFailed = false;
  let stopped = false;
  let pendingLine = "", lineHasContent = false, skipLF = false, frameSize = 0;
  let dataLines: string[] = [];
  let usage: ReturnType<typeof usageFrom> = null;
  const decoder = new TextDecoder();
  const emit = (interrupted = false) => {
    if (emitted) return;
    emitted = true;
    report({ ...metadata, kind: "usage", status: response.status,
      input: usage?.input ?? null, output: usage?.output ?? null, cached: usage?.cached ?? null,
      nanoAiu: usage?.nanoAiu ?? null,
      outcome: !response.ok ? "http_error" : interrupted || !completed || streamFailed ? "interrupted" : "complete" });
  };
  const parse = (data: string) => {
    if (data === "[DONE]") { completed = true; return; }
    try {
      const value = JSON.parse(data);
      const next = usageFrom(value);
      if (next) {
        // These are request-level snapshots, not per-frame charges. Never add
        // repeated/cumulative SSE counters or erase a field absent in a later frame.
        usage = {
          input: next.input ?? usage?.input ?? null,
          output: next.output ?? usage?.output ?? null,
          cached: next.cached ?? usage?.cached ?? null,
          nanoAiu: next.nanoAiu ?? usage?.nanoAiu ?? null,
        };
      }
      if (value.type === "response.completed" || value.type === "message_stop") completed = true;
      if (value.type === "response.failed" || value.type === "error") streamFailed = true;
    } catch { /* A malformed event must not change the model response. */ }
  };
  const dispatchEvent = () => {
    if (!overflow && dataLines.length) {
      const data = dataLines.join("\n");
      if (data) parse(data);
    }
    dataLines = []; frameSize = 0; overflow = false;
  };
  const finishLine = () => {
    if (!lineHasContent) dispatchEvent();
    else if (!overflow && (pendingLine === "data" || pendingLine.startsWith("data:"))) {
      dataLines.push(pendingLine.slice(5).replace(/^ /, ""));
    }
    pendingLine = ""; lineHasContent = false;
  };
  const accept = (text: string) => {
    if (!sse) {
      if (overflow) return;
      if (buffer.length + text.length > MAX_JSON) { buffer = ""; overflow = true; }
      else buffer += text;
      return;
    }
    // LF, CRLF and bare CR must match the protocol normalizer, including byte-split chunks.
    for (const character of text) {
      if (skipLF) { skipLF = false; if (character === "\n") continue; }
      if (character === "\r" || character === "\n") {
        finishLine(); skipLF = character === "\r"; continue;
      }
      lineHasContent = true;
      frameSize += character.length;
      if (frameSize > MAX_EVENT) { overflow = true; pendingLine = ""; dataLines = []; }
      else if (!overflow) pendingLine += character;
    }
  };
  const reader = response.body.getReader();
  let released = false;
  const release = () => {
    if (!released) {
      released = true; buffer = ""; pendingLine = ""; dataLines = []; reader.releaseLock();
    }
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (stopped) return;
        if (next.done) {
          accept(decoder.decode());
          if (!sse && !overflow) parse(buffer);
          if (sse) { if (lineHasContent) finishLine(); dispatchEvent(); }
          buffer = "";
          emit();
          stopped = true;
          release();
          controller.close();
        } else {
          accept(decoder.decode(next.value, { stream: true }));
          controller.enqueue(next.value);
        }
      } catch (error) {
        if (!stopped) { stopped = true; emit(true); release(); controller.error(error); }
      }
    },
    async cancel(reason) {
      stopped = true; emit(true);
      try { await reader.cancel(reason); } finally { release(); }
    }
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** Read retry-response telemetry without retaining the body or waiting indefinitely. */
export async function drainRetryResponse(
  response: Response,
  signal?: AbortSignal | null,
  limits: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  let done = false, bytes = 0;
  let interrupt!: () => void;
  const interrupted = new Promise<undefined>(resolve => { interrupt = () => resolve(undefined); });
  const timer = setTimeout(interrupt, limits.timeoutMs ?? 1000);
  signal?.addEventListener("abort", interrupt, { once: true });
  if (signal?.aborted) interrupt();
  try {
    while (bytes < (limits.maxBytes ?? MAX_JSON)) {
      const next = await Promise.race([reader.read(), interrupted]);
      if (!next) break;
      if (next.done) { done = true; break; }
      bytes += next.value.byteLength;
    }
  } catch { /* The observer reports read failures; the original request can retry. */ }
  finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", interrupt);
    // Cancellation is initiated immediately, but a misbehaving cancel hook must
    // not extend the retry deadline. The observer emits at most once on cancel.
    if (!done) void reader.cancel("Retry response observation limit reached").catch(() => {});
    reader.releaseLock();
  }
}

export function trackedURL(input: string | URL | Request, allowedOrigin: string): boolean {
  try {
    const url = new URL(input instanceof Request ? input.url : input);
    return url.origin === allowedOrigin
      && /\/(responses|chat\/completions|embeddings|messages)$/.test(url.pathname);
  } catch { return false; }
}
