import { describe, test, expect } from "bun:test";
import { drainRetryResponse, observeResponse, trackedURL, usageFrom, type UsageRecord } from "~/lib/usage-telemetry";

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
    expect(usageFrom({usage:{input_tokens:-1,output_tokens:2}})).toMatchObject({input:null,output:2,nanoAiu:null});
    expect(trackedURL("https://evil.test/responses","https://api.githubcopilot.com")).toBeFalse();
    expect(trackedURL("https://api.githubcopilot.com/responses","https://api.githubcopilot.com")).toBeTrue();
  });
  test("collects request billing independently of missing tokens", async () => {
    const text = JSON.stringify({usage:{copilot_usage:{total_nano_aiu:1234567890}}});
    const {response,events} = wrap(text,"application/json");
    expect(await response.text()).toBe(text);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({input:null,output:null,nanoAiu:1234567890});
  });
  test("keeps explicit zero billing distinct from missing or malformed billing", () => {
    expect(usageFrom({usage:{copilot_usage:{total_nano_aiu:0}}})?.nanoAiu).toBe(0);
    expect(usageFrom({usage:{copilot_usage:{total_nano_aiu:0.5}}})?.nanoAiu).toBe(0.5);
    for (const value of [undefined, null, -1, NaN, Infinity, true, "123", Number.MAX_SAFE_INTEGER + 1]) {
      expect(usageFrom({usage:{input_tokens:2,output_tokens:1,copilot_usage:{total_nano_aiu:value}}}))
        .toMatchObject({input:2,output:1,nanoAiu:null});
    }
  });
  for (const newline of ["\n","\r\n","\r"]) {
    test(`merges split token/billing snapshots with ${JSON.stringify(newline)} framing`, async () => {
      const frames = [
        {type:"message_start",message:{usage:{input_tokens:12}}},
        {type:"message_delta",usage:{output_tokens:3,copilot_usage:{total_nano_aiu:1000000000}}},
        {usage:{copilot_usage:{total_nano_aiu:1250000000}}},
        {usage:{copilot_usage:{total_nano_aiu:1250000000}}},
        {type:"message_stop",usage:{output_tokens:4}},
      ];
      const text = frames.map(f=>`data: ${JSON.stringify(f)}${newline}${newline}`).join("");
      const {response,events}=wrap(text,"text/event-stream",200,1);
      expect(await response.text()).toBe(text);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({input:12,output:4,nanoAiu:1250000000,outcome:"complete"});
    });
  }
  test("captures billing on Responses completion and top-level usage extensions", async () => {
    const text = 'data: {"type":"response.completed","response":{"usage":{"input_tokens":4,"output_tokens":2,"copilot_usage":{"total_nano_aiu":250000000}}}}\n\n';
    const {response,events}=wrap(text);
    expect(await response.text()).toBe(text);
    expect(events[0].nanoAiu).toBe(250000000);
    expect(usageFrom({usage:{prompt_tokens:3,completion_tokens:2},copilot_usage:{total_nano_aiu:7}})?.nanoAiu).toBe(7);
  });
  test("retains observed billing when a stream is interrupted", async () => {
    const text='data: {"usage":{"copilot_usage":{"total_nano_aiu":500000000}}}\n\n';
    const {response,events}=wrap(text);
    await response.text();
    expect(events[0]).toMatchObject({nanoAiu:500000000,outcome:"interrupted"});
  });
  test("retry observation has a deadline and reports only once", async () => {
    let cancelled = false;
    const records: UsageRecord[] = [];
    const response=observeResponse(new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode('data: {"usage":{"copilot_usage":{"total_nano_aiu":5}}}\n\n')); },
      cancel() { cancelled=true; },
    }),{status:503,headers:{"content-type":"text/event-stream"}}),meta,r=>records.push(r));
    await drainRetryResponse(response,undefined,{timeoutMs:20});
    expect(cancelled).toBeTrue();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({nanoAiu:5,outcome:"http_error"});
  });
  test("retry observation respects its byte cap and cancellation", async () => {
    let cancelled = false;
    const records: UsageRecord[] = [];
    const response=observeResponse(new Response(new ReadableStream<Uint8Array>({
      pull(c) { c.enqueue(new Uint8Array(64)); },
      cancel() { cancelled=true; },
    }),{status:503}),meta,r=>records.push(r));
    await drainRetryResponse(response,undefined,{maxBytes:64});
    expect(cancelled).toBeTrue();
    expect(records).toHaveLength(1);
    expect(records[0].nanoAiu).toBeNull();
  });
  test("captures large legal completion events instead of dropping their trailing usage", async () => {
    const text = `data: ${JSON.stringify({type:"response.completed",response:{
      output:[{type:"message",content:[{type:"output_text",text:"x".repeat(700000)}]}],
      usage:{input_tokens:120000,output_tokens:180000,input_tokens_details:{cached_tokens:110000},
        copilot_usage:{total_nano_aiu:123000000}},
    }})}\n\n`;
    const {response,events}=wrap(text,"text/event-stream",200,65536);
    expect(await response.text()).toBe(text);
    expect(events[0]).toMatchObject({input:120000,output:180000,cached:110000,
      tokensComplete:true,nanoAiu:123000000,tokenStatus:"reported"});
  });
  test("keeps the parser bounded and diagnoses an oversized usage event", async () => {
    const text = `data: ${JSON.stringify({type:"response.completed",response:{
      output:"x".repeat(8 * 1024 * 1024),usage:{input_tokens:9,output_tokens:8},
    }})}\n\ndata: [DONE]\n\n`;
    const {response,events}=wrap(text,"text/event-stream",200,65536);
    expect(await response.text()).toBe(text);
    expect(events[0]).toMatchObject({input:null,output:null,tokensComplete:false,tokenStatus:"size_limit"});
  });
  test("SSE event names work without a duplicated JSON type field", async () => {
    const text='event: response.completed\ndata: {"response":{"usage":{"input_tokens":7,"output_tokens":2}}}\n\n';
    const {response,events}=wrap(text,"text/event-stream",200,1);
    expect(await response.text()).toBe(text);
    expect(events[0]).toMatchObject({outcome:"complete",tokensComplete:true});
  });
  test("a usage-only Chat chunk after finish_reason is still observed", async () => {
    const text = [
      {choices:[{delta:{content:"test"},finish_reason:null}],usage:null},
      {choices:[{delta:{},finish_reason:"stop"}],usage:null},
      {choices:[],usage:{prompt_tokens:20,completion_tokens:5,total_tokens:25,
        prompt_tokens_details:{cached_tokens:12}}},
    ].map(v=>`data: ${JSON.stringify(v)}\n\n`).join("")+"data: [DONE]  \n\n";
    const {response,events}=wrap(text,"Text/Event-Stream; charset=utf-8");
    await response.text();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({input:20,output:5,cached:12,tokensComplete:true});
  });
  test("normal client cancellation after a terminal event is not an interrupted request", async () => {
    let cancelled=false;
    const records:UsageRecord[]=[];
    const response=observeResponse(new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode(
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":12,"output_tokens":3}}}\n\n')); },
      cancel() { cancelled=true; },
    }),{headers:{"content-type":"text/event-stream"}}),meta,r=>records.push(r));
    const reader=response.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(cancelled).toBeTrue();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({input:12,output:3,outcome:"complete",tokensComplete:true});
  });
  test("counters in an unfinished stream are partial, not a complete token report", async () => {
    const {response,events}=wrap('data: {"type":"response.created","response":{"usage":{"input_tokens":12,"output_tokens":0}}}\n\n');
    await response.text();
    expect(events[0]).toMatchObject({input:12,output:0,tokensComplete:false,tokenStatus:"interrupted"});
  });
  test("initial placeholder usage does not become complete just because the stream stops", async () => {
    for (const frames of [
      [{type:"response.created",response:{usage:{input_tokens:12,output_tokens:0}}},{type:"response.completed"}],
      [{choices:[{delta:{}}],usage:{prompt_tokens:12,completion_tokens:0}},{choices:[{finish_reason:"stop"}]}],
      [{type:"message_start",message:{usage:{input_tokens:12,output_tokens:0}}},{type:"message_stop"}],
    ]) {
      const {response,events}=wrap(frames.map(v=>`data: ${JSON.stringify(v)}\n\n`).join("")+"data: [DONE]\n\n");
      await response.text();
      expect(events[0]).toMatchObject({input:12,output:0,outcome:"complete",tokensComplete:false,tokenStatus:"partial"});
    }
  });
  test("token field aliases, sibling envelopes and exact total arithmetic", () => {
    expect(usageFrom({response:{usage:null},usage:{prompt_tokens:10,completion_tokens:4,
      cache_read_input_tokens:7}})).toMatchObject({input:10,output:4,cached:7});
    expect(usageFrom({usage:{input_tokens:"invalid",prompt_tokens:10,completion_tokens:4,
      prompt_cache_hit_tokens:6}})).toMatchObject({input:10,output:4,cached:6});
    expect(usageFrom({usage:{prompt_tokens:10,total_tokens:14}})).toMatchObject({input:10,output:4});
    expect(usageFrom({usage:{output_tokens:4,total_tokens:14}})).toMatchObject({input:10,output:4});
    expect(usageFrom({usage:{prompt_tokens:10,total_tokens:10}})).toMatchObject({input:10,output:0});
    expect(usageFrom({usage:{prompt_tokens:10,total_tokens:3}})?.output).toBeNull();
    expect(usageFrom({usage:{total_tokens:14}})).toBeNull();
    expect(usageFrom({output:[{usage:{input_tokens:1,output_tokens:2}}]})).toBeNull();
  });
  test("normalizes native Anthropic cached input without adding OpenAI caches twice", async () => {
    const frames=[
      {type:"message_start",message:{usage:{input_tokens:5,cache_read_input_tokens:30,cache_creation_input_tokens:10,output_tokens:0}}},
      {type:"message_delta",usage:{input_tokens:3,output_tokens:12}},
      {type:"message_delta",usage:{cache_read_input_tokens:21}},
      {type:"message_stop"},
    ];
    const {response,events}=wrap(frames.map(v=>`data: ${JSON.stringify(v)}\n\n`).join(""));
    await response.text();
    expect(events[0]).toMatchObject({input:34,output:12,cached:21,tokensComplete:true});
    expect(usageFrom({usage:{input_tokens:45,output_tokens:12,cache_read_input_tokens:30}})?.input).toBe(45);
  });
});
