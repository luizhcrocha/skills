/**
 * SHA-256 of a text's UTF-8 bytes, synchronous and with no imports: the page checks a card's script against its hash in
 * `shownOptions`, a pure rule in `fleet-core`, and `crypto.subtle` is async and missing on plain http on the LAN.
 */
const INIT = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const at = (words: ArrayLike<number>, index: number): number => words[index] ?? 0;

const rotr = (word: number, bits: number): number => (word >>> bits) | (word << (32 - bits));

/** The lowercase hex SHA-256 of `text` as UTF-8. */
export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const padded = new Uint8Array(((bytes.length + 72) >>> 6) << 6);

  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);

  view.setUint32(padded.length - 8, Math.floor(bytes.length / 2 ** 29));
  view.setUint32(padded.length - 4, bytes.length << 3);
  const state = Uint32Array.from(INIT);
  const w = new Uint32Array(64);

  for (let block = 0; block < padded.length; block += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(block + t * 4);

    for (let t = 16; t < 64; t++) {
      const x = at(w, t - 15);
      const y = at(w, t - 2);

      w[t] = at(w, t - 16) + (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) + at(w, t - 7) + (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10));
    }

    const v = state.slice();

    for (let t = 0; t < 64; t++) {
      const a = at(v, 0);
      const e = at(v, 4);
      const t1 = at(v, 7) + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & at(v, 5)) ^ (~e & at(v, 6))) + at(K, t) + at(w, t);
      const t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & at(v, 1)) ^ (a & at(v, 2)) ^ (at(v, 1) & at(v, 2)));

      v.copyWithin(1, 0, 7);
      v[4] = at(v, 4) + t1;
      v[0] = t1 + t2;
    }

    for (let i = 0; i < 8; i++) state[i] = at(state, i) + at(v, i);
  }

  return [...state].map((word) => word.toString(16).padStart(8, "0")).join("");
}
