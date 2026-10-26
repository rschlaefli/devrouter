const MAX_STATE_BYTES = 1024 * 1024;

export async function readPreviewResponse(
  response: Response,
  label: string,
  maxBytes = MAX_STATE_BYTES,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * MAX_STATE_BYTES)
    throw new Error("Invalid response size bound.");
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    await response.body?.cancel();
    throw new Error(`${label} response exceeds its size bound.`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`${label} response is empty.`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error(`${label} response exceeds its size bound.`);
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks).toString("utf8");
}
