/**
 * Edge TTS v2 DRM 签名（Sec-MS-GEC）。
 *
 * 2026-10 微软升级校验：旧 v1（纯 SHA-256，版本串前缀 "1-"）一律 403，必须用
 * v2 token（对照 rany2/edge-tts 的 drm.py @ master 移植，issue #290）：
 * - Sec-MS-GEC = "<CS64 16hex>-<SHA256 64hex>"，被签串仍是
 *   `${ticks}${TrustedClientToken}`（ticks 对齐 5 分钟的 filetime，与 v1 一致）；
 * - 这里的 SHA-256 不是 FIPS 标准：第 14 轮常量被替换、消息调度用五项截断
 *   sigma（逆向自 Edge 客户端 JS），WebCrypto subtle.digest 不可替代；
 * - CS64 是微软自定义校验和，以 SHA 摘要前 8 字节为密钥。
 *
 * 本文件全部常量与预期值由上游 Python 实现机器导出（勿手改）；正确性由
 * edgeDrm.test.ts 的固定向量保证。版本串 "2-<Chromium 版本>" 见 edgeTts.ts。
 */

// ---- 以下常量由 drm.py 机器导出（tshex.py），与上游逐字对应 ----

const SHA256_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
  0x1f83d9ab, 0x5be0cd19,
];

/** 初始状态跑完首块前 14 轮（全零字）后的缓存，首块从第 14 轮续算。 */
const SHA256_STATE = [
  0xfd9fbea2, 0x91243ce7, 0xbe499094, 0xcd2e1e0a, 0x6c006f49, 0x04bd35ab,
  0xfeb0a7e4, 0x03effbd2,
];

/** 首块消息调度词 16-29 的预计算值（仅词 14/15 携带数据）。 */
const SHA256_SCHEDULE = [
  0xeb24bf9e, 0x1558691f, 0xa0c09ee2, 0x0cfa32ba, 0xa622ee8c, 0xd1dd9491,
  0xc0dd25a0, 0xf9e70ab6, 0xf0c31573, 0x7058ce4e, 0x7188e606, 0x00e5ab33,
  0xd258b060, 0x72766564,
];

const SHA256_ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const CS64_COEFFICIENTS = [
  [0xe82e91b1, 0xb32700d0],
  [0x44de24c6, 0x88dff51d],
  [0x3beb65bc, 0x29514038],
  [0xc89c5933, 0xb328cbdf],
  [0x8d1ec211, 0xd405b4d5],
  [0x314ef5d5, 0x26e55f3c],
  [0xe92491b1, 0x607801c6],
  [0xf0a5b9d5, 0x82b2c1fb],
  [0x06064cf3, 0xfa51a3da],
  [0xda79fa60, 0x207cc464],
  [0xbed20560, 0x3c3c74f3],
  [0x89f9c9f8, 0xd2d14b61],
  [0x35fa38c6, 0xbb04a2c1],
  [0xcb49e3c6, 0xc5626167],
];

const SHA256_ADJUSTMENT = 0xc9dc06a7;
const SIGMA0_ADJUSTMENT = 0x059c0b80;
const SIGMA1_ADJUSTMENT = 0x000b92c0;
const CS64_FACTOR = 0x82893933;
const CS64_ADJUSTMENT0 = 0xf2f90b1a;
const CS64_ADJUSTMENT1 = 0x0b1a0000;

/** 首块用第 14 轮常量被替换（0x9BDC06A7 → 0xC9DC06A7）的版本。 */
const SHA256_BLOCK_CONSTANTS = SHA256_ROUND_CONSTANTS.slice();
SHA256_BLOCK_CONSTANTS[14] = SHA256_ADJUSTMENT;

// ---- 魔改 SHA-256 ----

/** 五项截断 σ0：比标准 σ0 多 SHR7/SHR18 两项（上游实现原样，勿"修正"）。 */
function sigma0(v: number): number {
  return ((v >>> 7) ^ (v << 25) ^ (v >>> 18) ^ (v << 14) ^ (v >>> 3)) >>> 0;
}

/** 五项截断 σ1：比标准 σ1 多 SHR17/SHR10 两项。 */
function sigma1(v: number): number {
  return ((v >>> 17) ^ (v << 15) ^ (v >>> 19) ^ (v << 13) ^ (v >>> 10)) >>> 0;
}

function rotr(v: number, n: number): number {
  return ((v >>> n) | (v << (32 - n))) >>> 0;
}

/** 32 位循环左移 16 位（高低 16 位对调，CS64 内部使用）。 */
function rotl16(v: number): number {
  return ((v << 16) | (v >>> 16)) >>> 0;
}

/** u32 乘法（mod 2^32）。 */
function mul(a: number, b: number): number {
  return Math.imul(a, b) >>> 0;
}

/** 扩充消息调度到 64 词（对首块从 31 起——词 16-30 已由预计算表给出）。 */
function expandSchedule(words: number[], firstWord: number): void {
  for (let index = firstWord; index < 64; index += 1) {
    const x = words[index - 2];
    const y = words[index - 15];
    words.push(
      (sigma1(x) + words[index - 7] + sigma0(y) + words[index - 16]) >>> 0,
    );
  }
}

/** 标准轮函数，但首块（firstRound=14）用替换过第 14 轮常量的表。 */
function sha256Rounds(
  state: number[],
  words: number[],
  firstRound: number,
): number[] {
  let [a, b, c, d, e, f, g, h] = state;
  const constants = firstRound === 14 ? SHA256_BLOCK_CONSTANTS : SHA256_ROUND_CONSTANTS;
  for (let index = firstRound; index < 64; index += 1) {
    const t1 =
      (h +
        (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) +
        (g ^ (e & (f ^ g))) +
        constants[index] +
        words[index]) >>>
      0;
    const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) | (c & (a | b)))) >>> 0;
    [a, b, c, d, e, f, g, h] = [(t1 + t2) >>> 0, a, b, c, (d + t1) >>> 0, e, f, g];
  }
  return [a, b, c, d, e, f, g, h];
}

/** 大端取 data[start, start+len) 为 u32。 */
function beWord(data: Uint8Array, start: number, len: number): number {
  let value = 0;
  for (let i = 0; i < len; i += 1) value = value * 256 + data[start + i];
  return value >>> 0;
}

/**
 * 首块状态：词 0-13 全零、词 14/15 携带 data 前 7 字节，调度词 16-30 用
 * 预计算表 + 定点 σ 校正（index 16/29），词 30 另有常量补偿公式。
 */
function sha256FirstBlockState(data7: Uint8Array): number[] {
  const words: number[] = new Array(14).fill(0);
  words.push(beWord(data7, 0, 3));
  words.push(beWord(data7, 3, 4));
  for (let index = 16; index < 30; index += 1) {
    let value = SHA256_SCHEDULE[index - 16];
    if (index - 2 >= 14) {
      value +=
        index === 16
          ? sigma1(words[index - 2]) ^ SIGMA1_ADJUSTMENT
          : sigma1(words[index - 2]);
    }
    if (index - 7 >= 14) value += words[index - 7];
    if (index - 15 >= 14) {
      value +=
        index === 29
          ? sigma0(words[index - 15]) ^ SIGMA0_ADJUSTMENT
          : sigma0(words[index - 15]);
    }
    words.push(value >>> 0);
  }
  words.push(
    (sigma1(words[28]) +
      words[23] +
      sigma0(words[15]) +
      words[14] +
      SHA256_ADJUSTMENT -
      SHA256_ROUND_CONSTANTS[14]) >>>
      0,
  );
  expandSchedule(words, 31);
  const working = sha256Rounds(SHA256_STATE, words, 14);
  return working.map((x, i) => (x + SHA256_INITIAL[i]) >>> 0);
}

/** 魔改 SHA-256 摘要（32 字节）。被签串固定 ≥7 字节：前 7 字节进首块。 */
export function sha256Modified(data: Uint8Array): Uint8Array {
  if (data.length < 7) throw new Error("签名数据不足 7 字节");
  const length = 57 + data.length;
  const zeros = (((55 - length) % 64) + 64) % 64;
  const padded = new Uint8Array(data.length - 7 + 1 + zeros + 8);
  padded.set(data.subarray(7), 0);
  padded[data.length - 7] = 0x80;
  // 补零保持 0；结尾 8 字节大端比特长。
  const bitLength = length * 8;
  for (let i = 0; i < 8; i += 1) {
    padded[padded.length - 1 - i] = (Math.floor(bitLength / 256 ** i)) % 256;
  }

  let state = sha256FirstBlockState(data.subarray(0, 7));
  for (let offset = 0; offset < padded.length; offset += 64) {
    const words: number[] = [];
    for (let i = 0; i < 16; i += 1) {
      words.push(beWord(padded, offset + i * 4, 4));
    }
    expandSchedule(words, 16);
    const working = sha256Rounds(state, words, 0);
    state = state.map((x, i) => (x + working[i]) >>> 0);
  }
  const out = new Uint8Array(32);
  state.forEach((v, i) => {
    out[i * 4] = v >>> 24;
    out[i * 4 + 1] = (v >>> 16) & 0xff;
    out[i * 4 + 2] = (v >>> 8) & 0xff;
    out[i * 4 + 3] = v & 0xff;
  });
  return out;
}

// ---- CS64 校验和 ----

/** data 前置一个 0 字节、补齐到 4 的倍数，按小端 u32 切词；奇数个再补 0。 */
function wordsLe4Even(data: Uint8Array): number[] {
  const total = 1 + data.length;
  const paddedLen = total + ((4 - (total % 4)) % 4);
  const words: number[] = [];
  for (let i = 0; i < paddedLen; i += 4) {
    let word = 0;
    for (let b = 3; b >= 0; b -= 1) {
      const idx = i + b;
      const byte = idx === 0 ? 0 : idx - 1 < data.length ? data[idx - 1] : 0;
      word = ((word << 8) | byte) >>> 0;
    }
    words.push(word);
  }
  if (words.length % 2) words.push(0);
  return words;
}

/** CS64 摘要：返回 (swapLast^state, swapAcc^acc) 两个 u32。 */
export function cs64Digest(
  data: Uint8Array,
  sha: Uint8Array,
): [number, number] {
  let keyA = (sha[0] | (sha[1] << 8) | (sha[2] << 16) | (sha[3] << 24)) >>> 0;
  let keyB = (sha[4] | (sha[5] << 8) | (sha[6] << 16) | (sha[7] << 24)) >>> 0;
  keyA = (keyA | 1) >>> 0;
  keyB = (keyB | 1) >>> 0;
  const factorA = mul(keyA, CS64_FACTOR);
  const factorB = mul(keyB, CS64_FACTOR);
  const terms = CS64_COEFFICIENTS.map(
    ([coefficient], index) => mul(coefficient, index % 2 === 0 ? factorA : factorB),
  );
  const offsets = CS64_COEFFICIENTS.map(([, offset]) => offset);
  for (const [index, word] of wordsLe4Even(data).entries()) {
    let term = mul(word, index % 2 === 0 ? keyA : keyB);
    let offset = mul(rotl16(word), index % 2 === 0 ? 0xef0569fb : 0xc31713db);
    if (index === 0) {
      term = (term + mul(CS64_ADJUSTMENT0, factorA)) >>> 0;
      offset = (offset + CS64_ADJUSTMENT1) >>> 0;
    }
    terms.push(term);
    offsets.push(offset);
  }

  let swapAcc = 0;
  let swapLast = 0;
  let state = 0;
  let acc = 0;
  for (let index = 0; index < terms.length; index += 2) {
    const x = terms[index];
    const y = terms[index + 1];
    let t = rotl16((offsets[index] + x) >>> 0);
    let q = mul(t, 0x76f50f34);
    swapAcc = (swapAcc + ((mul(rotl16(q), 0xc3efea97) + q) >>> 0)) >>> 0;
    t = rotl16((offsets[index + 1] + y) >>> 0);
    q = mul(t, 0x1881ce3c);
    swapLast = (mul(rotl16(q), 0x35bd1ec9) + q) >>> 0;
    swapAcc = (swapAcc + swapLast) >>> 0;

    state = (mul(state, keyA) + x) >>> 0;
    state = mul(rotl16(state), 0xcf98b111);
    state = mul(rotl16(state), 0x87085b9f);
    state = mul(rotl16(state), 0x12ceb96d);
    state = mul(rotl16(state), 0x257e1d83);
    acc = (acc + state) >>> 0;
    t = (mul(state, keyB) + y) >>> 0;
    t = mul(rotl16(t), 0xa27416f5);
    t = mul(rotl16(t), 0xd38396ff);
    state = mul(rotl16(mul(rotl16(t), 0x7c932b89)), 0xbfa49f69);
    acc = (acc + state) >>> 0;
  }
  return [(swapLast ^ state) >>> 0, (swapAcc ^ acc) >>> 0];
}

// ---- 对外的 v2 token ----

function toHexUpper(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

/** v2 Sec-MS-GEC："<CS64 16hex>-<魔改 SHA256 64hex>"（data = `${ticks}${TOKEN}`）。 */
export function secMsGecV2(data: Uint8Array): string {
  const sha = sha256Modified(data);
  const [w0, w1] = cs64Digest(data, sha);
  const cs64 = new Uint8Array(8);
  cs64[0] = w0 & 0xff;
  cs64[1] = (w0 >>> 8) & 0xff;
  cs64[2] = (w0 >>> 16) & 0xff;
  cs64[3] = (w0 >>> 24) & 0xff;
  cs64[4] = w1 & 0xff;
  cs64[5] = (w1 >>> 8) & 0xff;
  cs64[6] = (w1 >>> 16) & 0xff;
  cs64[7] = (w1 >>> 24) & 0xff;
  return `${toHexUpper(cs64)}-${toHexUpper(sha)}`;
}
