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
  /** False when final token counters were not observed, even if partial counters exist. */
  tokensComplete?: boolean;
  tokenStatus?: "reported" | "partial" | "not_reported" | "interrupted" | "size_limit" | "invalid_json";
  outcome: "complete" | "http_error" | "interrupted";
}

// Match the Responses normalizer: a legal completion may repeat a large output
// before its final usage object. The old 256 KiB cap silently discarded it.
const MAX_EVENT = 8 * 1024 * 1024;
const MAX_JSON = 8 * 1024 * 1024;
const MAX_RETRY_BYTES = 4 * 1024 * 1024;
const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const billingNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    && value <= Number.MAX_SAFE_INTEGER ? value : null;

const firstNumber = (...values: unknown[]) =>
  values.map(number).find(value => value !== null) ?? null;
interface NativeUsageState { input?: number; read?: number; write?: number }

export function usageFrom(value: any, nativeState: NativeUsageState = {}) {
  let result = { input: null, output: null, cached: null, nanoAiu: null } as {
    input: number | null; output: number | null; cached: number | null; nanoAiu: number | null;
  };
  // Some providers put usage next to the envelope instead of inside it.
  // Inspect only protocol-defined locations, never arbitrary tool/text payloads.
  const nativeMessages = value?.type === "message"
    || (typeof value?.type === "string" && value.type.startsWith("message_"));
  for (const envelope of [value, value?.message, value?.response]) {
    const usage = envelope?.usage;
    let input = firstNumber(usage?.input_tokens, usage?.prompt_tokens);
    let output = firstNumber(usage?.output_tokens, usage?.completion_tokens);
    const total = number(usage?.total_tokens);
    // Exact arithmetic on server counters, not a tokenizer/character estimate.
    if (total !== null && !nativeMessages) {
      if (input === null && output !== null && total >= output) input = total - output;
      if (output === null && input !== null && total >= input) output = total - input;
    }
    const cached = firstNumber(usage?.input_tokens_details?.cached_tokens,
      usage?.prompt_tokens_details?.cached_tokens, usage?.cache_read_input_tokens,
      usage?.prompt_cache_hit_tokens);
    if (nativeMessages && input !== null) {
      nativeState.input = input;
    }
    if (nativeMessages) {
      // Native Anthropic input excludes cache reads/writes, unlike OpenAI.
      // Cache corrections and fresh-input counters can arrive in different frames.
      nativeState.read = number(usage?.cache_read_input_tokens) ?? nativeState.read;
      nativeState.write = number(usage?.cache_creation_input_tokens) ?? nativeState.write;
      if (nativeState.input !== undefined) {
        input = number(nativeState.input + (nativeState.read ?? 0) + (nativeState.write ?? 0));
      }
    }
    const nanoAiu = [usage?.copilot_usage?.total_nano_aiu, envelope?.copilot_usage?.total_nano_aiu]
      .map(billingNumber).find(value => value !== null) ?? null;
    result = { input: input ?? result.input, output: output ?? result.output,
      cached: cached ?? result.cached, nanoAiu: nanoAiu ?? result.nanoAiu };
  }
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
      tokensComplete: false, tokenStatus: "not_reported",
      outcome: response.ok ? "complete" : "http_error" });
    return response;
  }
  const sse = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "text/event-stream";
  let buffer = "";
  let overflow = false;
  let emitted = false;
  let completed = false;
  let streamFailed = false;
  let stopped = false;
  let pendingLine = "", lineHasContent = false, skipLF = false, frameSize = 0;
  let dataLines: string[] = [];
  let eventName = "", parseLimited = false, malformed = false;
  let protocol: "responses" | "messages" | "chat" | undefined;
  let finalTokenCounters = false;
  let usage: ReturnType<typeof usageFrom> = null;
  const nativeUsage: NativeUsageState = {};
  const decoder = new TextDecoder();
  const emit = () => {
    if (emitted) return;
    emitted = true;
    const full = usage?.input != null && usage?.output != null;
    const tokensComplete = full && completed && !parseLimited
      && (!sse || !protocol || finalTokenCounters);
    const tokenStatus: UsageRecord["tokenStatus"] = tokensComplete ? "reported"
      : parseLimited ? "size_limit" : !completed ? "interrupted"
      : usage?.input != null || usage?.output != null ? "partial"
      : malformed ? "invalid_json" : "not_reported";
    report({ ...metadata, kind: "usage", status: response.status,
      input: usage?.input ?? null, output: usage?.output ?? null, cached: usage?.cached ?? null,
      nanoAiu: usage?.nanoAiu ?? null,
      tokensComplete, tokenStatus,
      outcome: !response.ok ? "http_error" : !completed || streamFailed ? "interrupted" : "complete" });
  };
  const parse = (data: string) => {
    if (data.trim() === "[DONE]") { completed = true; return; }
    try {
      const value = JSON.parse(data);
      const type = typeof value?.type === "string" ? value.type : eventName;
      const next = usageFrom(value && typeof value === "object" && !Array.isArray(value)
        ? { ...value, type } : value, nativeUsage);
      if (type.startsWith("response.")) {
        protocol = "responses";
        if (["response.completed", "response.incomplete", "response.failed"].includes(type)
          && next?.input != null && next?.output != null) finalTokenCounters = true;
      } else if (type.startsWith("message_")) {
        protocol = "messages";
        if (type === "message_delta" && next?.output != null) finalTokenCounters = true;
      } else if (Array.isArray(value?.choices)) {
        protocol = "chat";
        if (next?.input != null && next?.output != null
          && (value.choices.length === 0 || value.choices.some((choice: any) => choice?.finish_reason != null))) {
          finalTokenCounters = true;
        }
      }
      if (next) {
        // These are request-level snapshots, not per-frame charges. Never add
        // repeated/cumulative SSE counters or erase a field absent in a later frame.
        usage = {
          input: next.input ?? usage?.input ?? null,
          output: next.output ?? usage?.output ?? null,
          cached: next.cached ?? usage?.cached ?? null,
          nanoAiu: next.nanoAiu ?? usage?.nanoAiu ?? null,
        };
        if (next.input !== null && next.output !== null) parseLimited = false;
      }
      if (["response.completed", "response.incomplete", "response.failed", "message_stop"].includes(type)) completed = true;
      if (type === "response.failed" || type === "response.incomplete" || type === "error") streamFailed = true;
    } catch { malformed = true; /* Never change the model response. */ }
  };
  const dispatchEvent = () => {
    if (!overflow && dataLines.length) {
      const data = dataLines.join("\n");
      if (data) parse(data);
    }
    dataLines = []; frameSize = 0; overflow = false; eventName = "";
  };
  const finishLine = () => {
    if (!lineHasContent) dispatchEvent();
    else if (!overflow && (pendingLine === "data" || pendingLine.startsWith("data:"))) {
      dataLines.push(pendingLine.slice(5).replace(/^ /, ""));
    } else if (!overflow && pendingLine.startsWith("event:")) {
      eventName = pendingLine.slice(6).trim().slice(0, 128);
    }
    pendingLine = ""; lineHasContent = false;
  };
  const accept = (text: string) => {
    if (!sse) {
      if (overflow) return;
      if (buffer.length + text.length > MAX_JSON) { buffer = ""; overflow = true; parseLimited = true; }
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
      if (frameSize > MAX_EVENT) { overflow = true; parseLimited = true; pendingLine = ""; dataLines = []; }
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
          if (!sse) { completed = true; if (!overflow) parse(buffer); }
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
        if (!stopped) { stopped = true; emit(); release(); controller.error(error); }
      }
    },
    async cancel(reason) {
      // Clients commonly cancel after receiving the protocol terminal event.
      // That is successful completion, not a lost/failed request.
      stopped = true; emit();
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
    while (bytes < (limits.maxBytes ?? MAX_RETRY_BYTES)) {
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
