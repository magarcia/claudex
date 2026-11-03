function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function mentionsJson(item: unknown): boolean {
  const message = object(item);
  if (!message || (message.type !== undefined && message.type !== "message")) return false;
  if (typeof message.content === "string") return /json/iu.test(message.content);
  if (!Array.isArray(message.content)) return false;
  return message.content.some((part: unknown) => {
    const content = object(part);
    return (
      (content?.type === "input_text" || content?.type === "output_text") &&
      typeof content.text === "string" &&
      /json/iu.test(content.text)
    );
  });
}

/** The upstream JSON-mode check considers input messages separately from instructions. */
export function ensureJsonObjectInput(input: unknown[], format: unknown): unknown[] {
  if (object(format)?.type !== "json_object" || input.some((item) => mentionsJson(item)))
    return input;
  return [
    ...input,
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Respond with a JSON object." }],
    },
  ];
}
