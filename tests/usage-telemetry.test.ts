import { describe, test, expect } from "bun:test";
import { observeResponse, trackedURL, usageFrom, type UsageRecord } from "~/lib/usage-telemetry";

const meta = { id: "one", model: "test", timestamp: 1 };
const wrap = (text: string, contentType = "text/event-stream", status = 200, chunks = 7) => {
  const bytes = new TextEncoder().encode(text);
  const input = new ReadableStream<Uint8Array>({
    start(c) { for (let i=0;i<bytes.length;i+=chunks) c.enqueue(bytes.slice(i,i+chunks)); c.close(); }
  });
  const events: UsageRecord[] = [];
  const response = observeResponse(new Response(input, {status,headers:{"content-type":contentType}}),meta,e=>events.push(e));
  return {response,events};
};
describe("byte-transparent, bounded telemetry", () => {
  for (const newline of ["\n", "\r\n", "\r"]) {
    test(`observes usage over ${JSON.stringify(newline)} framing without rewriting bytes`, async () => {
      const text = 'data:{"type":"response.completed",' + newline
        + 'data:"response":{"usage":{"input_tokens":7,"output_tokens":2}}}' + newline + newline;
      const {response,events} = wrap(text,"text/event-stream",200,1);
      expect(await response.text()).toBe(text);
      expect(events[0]).toMatchObject({input:7,output:2,outcome:"complete"});
    });
  }
  test("a failed event followed by DONE is not successful",async()=>{
    const {response,events}=wrap('data: {"type":"response.failed"}\n\ndata: [DONE]\n\n');
    await response.text();
    expect(events[0].outcome).toBe("interrupted");
  });
  test("preserves SSE bytes, CRLF, UTF-8 and counts usage once", async () => {
    const text = 'data: {"type":"response.output_text.delta","delta":"你好"}\r\n\r\n'
      + 'data: {"type":"response.completed","response":{"usage":{"input_tokens":12,"output_tokens":3,"input_tokens_details":{"cached_tokens":4}}}}\r\n\r\n'
      + 'data: [DONE]\r\n\r\n';
    const {response,events}=wrap(text);
    expect(await response.text()).toBe(text);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({input:12,output:3,cached:4,outcome:"complete"});
  });
  test("does not turn missing usage into zero", async()=>{
    const {response,events}=wrap('data: {"type":"response.completed"}\n\n');
    await response.text(); expect(events[0].input).toBeNull();
  });
  test("non-streaming Chat usage and errors",async()=>{
    const text=JSON.stringify({usage:{prompt_tokens:10,completion_tokens:5}});
    const {response,events}=wrap(text,"application/json"); expect(await response.text()).toBe(text);
    expect(events[0]).toMatchObject({input:10,output:5});
    const error=wrap("too big","text/plain",413);await error.response.text();
    expect(error.events[0].outcome).toBe("http_error");
  });
  test("interrupted streams never fabricate completion",async()=>{
    const {response,events}=wrap('data: {"type":"response.output_text.delta","delta":"partial"}\n\n');
    await response.text();expect(events[0].outcome).toBe("interrupted");
  });
  test("oversized events are forwarded and the next usage event still works",async()=>{
    const text=`data: ${"x".repeat(300000)}\n\n`
      +'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":2}}}\n\n';
    const {response,events}=wrap(text,"text/event-stream",200,65536);
    expect(await response.text()).toBe(text);expect(events[0].input).toBe(1);
  });
  test("rejects invalid usage and foreign origins",()=>{
    expect(usageFrom({usage:{input_tokens:-1,output_tokens:2}})).toBeNull();
    expect(trackedURL("https://evil.test/responses","https://api.githubcopilot.com")).toBeFalse();
    expect(trackedURL("https://api.githubcopilot.com/responses","https://api.githubcopilot.com")).toBeTrue();
  });
});
