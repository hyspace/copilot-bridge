export interface UsageRecord {
  kind: "usage";
  id: string;
  timestamp: number;
  model: string;
  status: number;
  input: number | null;
  output: number | null;
  cached: number | null;
  outcome: "complete" | "http_error" | "interrupted";
}

const MAX_EVENT = 256 * 1024;
const MAX_JSON = 4 * 1024 * 1024;
const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

export function usageFrom(value: any) {
  const usage = value?.response?.usage ?? value?.usage;
  if (!usage || typeof usage !== "object") return null;
  const input = number(usage.input_tokens ?? usage.prompt_tokens);
  const output = number(usage.output_tokens ?? usage.completion_tokens);
  if (input === null || output === null) return null;
  return {
    input, output,
    cached: number(usage.input_tokens_details?.cached_tokens
      ?? usage.prompt_tokens_details?.cached_tokens)
  };
}

/** Observation only: each original byte is forwarded unchanged. No tee/read-ahead branch. */
export function observeResponse(
  response: Response,
  metadata: Pick<UsageRecord, "id" | "timestamp" | "model">,
  report: (record: UsageRecord) => void,
): Response {
  if (!response.body) {
    report({ ...metadata, kind: "usage", status: response.status,
      input: null, output: null, cached: null,
      outcome: response.ok ? "complete" : "http_error" });
    return response;
  }
  const sse = response.headers.get("content-type")?.includes("text/event-stream") ?? false;
  let buffer = "";
  let overflow = false;
  let emitted = false;
  let completed = !sse;
  let usage: ReturnType<typeof usageFrom> = null;
  const decoder = new TextDecoder();
  const emit = (interrupted = false) => {
    if (emitted) return;
    emitted = true;
    report({ ...metadata, kind: "usage", status: response.status,
      input: usage?.input ?? null, output: usage?.output ?? null, cached: usage?.cached ?? null,
      outcome: !response.ok ? "http_error" : interrupted || !completed ? "interrupted" : "complete" });
  };
  const parse = (data: string) => {
    if (data === "[DONE]") { completed = true; return; }
    try {
      const value = JSON.parse(data);
      usage = usageFrom(value) ?? usage;
      if (value.type === "response.completed" || value.type === "message_stop") completed = true;
      if (value.type === "response.failed" || value.type === "error") completed = false;
    } catch { /* A malformed event must not change the model response. */ }
  };
  const accept = (text: string) => {
    if (!sse) {
      if (overflow) return;
      if (buffer.length + text.length > MAX_JSON) { buffer = ""; overflow = true; }
      else buffer += text;
      return;
    }
    // Process incrementally, even if the transport delivers one unusually large chunk.
    for (const piece of text.split(/(\n)/)) {
      buffer += piece;
      if (buffer.length > MAX_EVENT) { buffer = ""; overflow = true; }
      if (/\r?\n\r?\n$/.test(buffer)) {
        if (!overflow) {
          const data = buffer.split(/\r?\n/)
            .filter(line => line.startsWith("data:"))
            .map(line => line.slice(5).replace(/^ /, "")).join("\n");
          if (data) parse(data);
        }
        buffer = ""; overflow = false;
      }
    }
  };
  const reader = response.body.getReader();
  let released = false;
  const release = () => { if (!released) { released = true; reader.releaseLock(); } };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          accept(decoder.decode());
          if (!sse && !overflow) parse(buffer);
          buffer = "";
          emit();
          release();
          controller.close();
        } else {
          accept(decoder.decode(next.value, { stream: true }));
          controller.enqueue(next.value);
        }
      } catch (error) {
        buffer = ""; emit(true); release(); controller.error(error);
      }
    },
    async cancel(reason) {
      buffer = ""; emit(true);
      try { await reader.cancel(reason); } finally { release(); }
    }
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export function trackedURL(input: string | URL | Request, allowedOrigin: string): boolean {
  try {
    const url = new URL(input instanceof Request ? input.url : input);
    return url.origin === allowedOrigin
      && /\/(responses|chat\/completions|embeddings|messages)$/.test(url.pathname);
  } catch { return false; }
}
