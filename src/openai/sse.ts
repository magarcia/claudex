export interface SSEEvent {
  type: string;
  data: Record<string, unknown>;
}

/** Codex events carry their type in the JSON body as well as the `event:` line, so the body is enough. */
export async function* readSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let boundary = /\r?\n\r?\n/u.exec(buffer);
      while (boundary) {
        const event = parseEvent(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index + boundary[0].length);
        if (event) yield event;
        boundary = /\r?\n\r?\n/u.exec(buffer);
      }
      if (done) break;
    }
    const last = parseEvent(buffer);
    if (last) yield last;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function parseEvent(block: string): SSEEvent | undefined {
  const data = block
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data || data === "[DONE]") return undefined;
  try {
    const parsed: unknown = JSON.parse(data);
    if (
      parsed &&
      typeof parsed === "object" &&
      "type" in parsed &&
      typeof parsed.type === "string"
    ) {
      return { type: parsed.type, data: parsed as Record<string, unknown> };
    }
  } catch {
    // A malformed event is skipped rather than ending the stream.
  }
  return undefined;
}
