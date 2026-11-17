export async function computeGitBlobShaFromText(text: string): Promise<string> {
  const normalized = text.replace(/\r\n/g, "\n");
  const encoder = new TextEncoder();
  const bytes = encoder.encode(normalized);
  return computeGitBlobShaFromBytes(bytes);
}

export async function computeGitBlobShaFromBytes(bytes: Uint8Array): Promise<string> {
  const encoder = new TextEncoder();
  const header = encoder.encode(`blob ${bytes.byteLength}\0`);
  const combined = new Uint8Array(header.byteLength + bytes.byteLength);
  combined.set(header, 0);
  combined.set(bytes, header.byteLength);
  const hashBuffer = await crypto.subtle.digest("SHA-1", combined);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
