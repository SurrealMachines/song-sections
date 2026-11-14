// Standard base64 (RFC 4648 §4: A-Z a-z 0-9 + /, `=` padding), in plain ECMAScript. Live's extension host runs the
// bundle in its own V8 context, which has no btoa/atob (it does have Buffer: docs/structure-engine-findings.md). The
// dialog (a browser) has btoa/atob but no Buffer, and the tests (Node) have both; this module must behave the same in
// all three, so it uses neither.
// Output is byte-identical to btoa over the bytes as a binary string, so caches written with btoa stay valid.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < 64; i++) LOOKUP[ALPHABET.charCodeAt(i)] = i;

const CHUNK = 0x6000; // output chars gathered before they are pushed as one piece, so a long string is not built by one huge +=

export function base64Encode(bytes: Uint8Array): string {
  const pieces: string[] = [];
  let out = "";
  const full = bytes.length - (bytes.length % 3);
  for (let i = 0; i < full; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63];
    if (out.length >= CHUNK) {
      pieces.push(out);
      out = "";
    }
  }
  const rest = bytes.length - full;
  if (rest === 1) {
    const n = bytes[full] << 16;
    out += `${ALPHABET[n >> 18]}${ALPHABET[(n >> 12) & 63]}==`;
  } else if (rest === 2) {
    const n = (bytes[full] << 16) | (bytes[full + 1] << 8);
    out += `${ALPHABET[n >> 18]}${ALPHABET[(n >> 12) & 63]}${ALPHABET[(n >> 6) & 63]}=`;
  }
  pieces.push(out);
  return pieces.join("");
}

/** Throws on anything atob would reject for our own output: wrong length, a character outside the alphabet, misplaced `=`. */
export function base64Decode(s: string): Uint8Array {
  if (s.length % 4 !== 0) throw new Error("invalid base64: length is not a multiple of 4");
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((s.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    let n = 0;
    for (let j = 0; j < 4; j++) {
      const c = s.charCodeAt(i + j);
      let v: number;
      if (c === 61 /* = */ && i + j >= s.length - pad) v = 0;
      else if ((v = c < 128 ? LOOKUP[c] : -1) < 0) throw new Error("invalid base64: character outside the alphabet");
      n = (n << 6) | v;
    }
    if (o < out.length) out[o++] = n >> 16;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}
