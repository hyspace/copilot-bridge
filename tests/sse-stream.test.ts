import {test,expect} from "bun:test";
import {mapSSE} from "~/lib/sse-stream";
test("SSE normalization preserves UTF-8, CRLF and final decoder flush",async()=>{
  const text="data: 你好\r\n\r\ndata: last";
  const bytes=new TextEncoder().encode(text);
  const input=new ReadableStream<Uint8Array>({start(c){for(const b of bytes)c.enqueue(new Uint8Array([b]));c.close()}});
  expect(await new Response(mapSSE(input,s=>s)).text()).toBe(text);
});
test("unread downstream does not greedily drain the upstream",async()=>{
  let pulls=0,cancelled=false,finished=0;
  const input=new ReadableStream<Uint8Array>({
    pull(c){pulls++;c.enqueue(new TextEncoder().encode("data: test\n\n"))},
    cancel(){cancelled=true}
  });
  const output=mapSSE(input,s=>s,()=>finished++);
  await Promise.resolve();await Promise.resolve();await Promise.resolve();
  expect(pulls).toBeLessThanOrEqual(3);
  await output.cancel();
  expect(cancelled).toBeTrue();expect(finished).toBe(1);
});
test("upstream failure remains a failure and releases stream state",async()=>{
  let finished=0;
  const input=new ReadableStream<Uint8Array>({pull(c){c.error(new Error("upstream failed"))}});
  await expect(new Response(mapSSE(input,s=>s,()=>finished++)).text()).rejects.toThrow("upstream failed");
  expect(finished).toBe(1);
});
