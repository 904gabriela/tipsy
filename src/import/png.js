// Reading character cards out of PNG images.
//
// A character card PNG hides its JSON in a tEXt chunk. V2 cards use the
// keyword "chara", V3 cards use "ccv3", and cards written by recent tools
// carry both. The payload is base64 of UTF-8 bytes.
//
// The encoding is the part that goes wrong. The chunk itself is plain ASCII
// base64, so it must be read as latin1. What comes out of the base64 is
// UTF-8, so it must be decoded as UTF-8. Getting either backwards turns
// every accented character and every piece of Japanese into mojibake.

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function isPNG(bytes) {
  if (!bytes || bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  return true;
}

/**
 * Walk a PNG's chunks and collect every tEXt entry.
 * @returns {Array<{keyword: string, text: string}>}
 */
export function readTextChunks(bytes) {
  if (!isPNG(bytes)) throw new ImportError('NOT_A_PNG', 'This file is not a PNG image.');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const latin1 = new TextDecoder('latin1');
  const chunks = [];
  let p = 8;

  while (p + 8 <= bytes.length) {
    const length = view.getUint32(p, false); // big-endian, covers data only
    p += 4;
    const type = String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);
    p += 4;

    if (p + length + 4 > bytes.length) break; // truncated file, stop cleanly
    const data = bytes.subarray(p, p + length);
    p += length + 4; // skip the data and its CRC

    if (type === 'tEXt') {
      const nul = data.indexOf(0);
      if (nul > 0) {
        chunks.push({
          keyword: latin1.decode(data.subarray(0, nul)),
          text: latin1.decode(data.subarray(nul + 1)),
        });
      }
    }
    if (type === 'IEND') break;
  }
  return chunks;
}

/** Decode base64 to a string, treating the result as UTF-8. */
function decodeBase64Utf8(b64) {
  const clean = String(b64).replace(/\s+/g, '');
  let raw;
  if (typeof atob === 'function') {
    raw = atob(clean);
  } else {
    raw = Buffer.from(clean, 'base64').toString('latin1');
  }
  const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // Some older cards were written with latin1 bytes. Better a readable
    // card with a few odd characters than a hard failure.
    return new TextDecoder('latin1').decode(bytes);
  }
}

/**
 * Pull the character card JSON out of a PNG.
 * Prefers the V3 chunk when a card carries both.
 * @param {Uint8Array} bytes
 * @returns {{json: object, chunk: string}}
 */
export function extractCardFromPNG(bytes) {
  const chunks = readTextChunks(bytes);
  const find = (name) => chunks.find((c) => c.keyword.toLowerCase() === name);
  const picked = find('ccv3') || find('chara');

  if (!picked) {
    throw new ImportError(
      'NO_CARD_DATA',
      'This PNG has no character data in it. It may be an ordinary picture, or it may have been re-saved by an image editor, which strips the hidden data out.'
    );
  }

  let json;
  try {
    json = JSON.parse(decodeBase64Utf8(picked.text));
  } catch (e) {
    throw new ImportError('BAD_CARD_DATA', 'The character data inside this PNG is damaged and could not be read.');
  }
  return { json, chunk: picked.keyword.toLowerCase() };
}

export class ImportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
  }
}
