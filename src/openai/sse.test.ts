import { describe, expect, it } from "bun:test";

import { readSSE } from "./sse.ts";

function streamOf(...parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const types: string[] = [];
  for await (const event of readSSE(stream)) types.push(event.type);
  return types;
}

describe("readSSE", () => {
  it("decodes UTF-8 and CRLF delimiters split across byte chunks", async () => {
    const bytes = new TextEncoder().encode('data: {"type":"delta","text":"🌕"}\r\n\r\n');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < bytes.length; index++)
          controller.enqueue(bytes.slice(index, index + 1));
        controller.close();
      },
    });
    const events = [];
    for await (const event of readSSE(stream)) events.push(event);
    expect(events).toEqual([{ type: "delta", data: { type: "delta", text: "🌕" } }]);
  });

  it("cancels the upstream reader when the consumer stops after an event", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"done"}\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const event of readSSE(stream)) {
      expect(event.type).toBe("done");
      break;
    }
    expect(cancelled).toBe(true);
  });

  it("parses events split across chunks", async () => {
    const stream = streamOf(
      'event: response.created\ndata: {"type":"response.cre',
      'ated"}\n\ndata: {"type":"response.completed"}\n\n',
    );

    expect(await collect(stream)).toEqual(["response.created", "response.completed"]);
  });

  it("handles CRLF line endings and a final event with no trailing blank line", async () => {
    expect(await collect(streamOf('data: {"type":"a"}\r\n\r\ndata: {"type":"b"}'))).toEqual([
      "a",
      "b",
    ]);
  });

  it("skips [DONE], comments and malformed events", async () => {
    const stream = streamOf(
      ': keepalive\n\ndata: not json\n\ndata: {"type":"a"}\n\ndata: [DONE]\n\n',
    );

    expect(await collect(stream)).toEqual(["a"]);
  });
});
