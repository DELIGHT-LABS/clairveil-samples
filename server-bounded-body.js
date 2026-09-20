// Shared byte accounting only; callers retain their own routing and size policy.
export async function readBoundedBody(stream, maximum) {
  const chunks = [];
  let length = 0;
  for await (const chunk of stream) {
    length += chunk.length;
    if (length > maximum) throw new Error('BODY_LIMIT');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
