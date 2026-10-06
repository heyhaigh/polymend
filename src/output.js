// Sizing for print, and the 3MF writer.

export const VERSION = '0.5.1';

/**
 * With a print height: scale a Z-up model to that height in millimetres, stand it on the
 * bed (lowest point at Z = 0) and centre it on X and Y. With no height the model is
 * returned exactly where and as large as it was, so parts that share an origin still fit.
 * `unitMm` is how many millimetres one of the file's own units is: 1000 for a GLB, whose
 * numbers are meters by definition, so that it is not written out a thousand times too
 * small. Returns new positions and the resulting size in millimetres.
 */
export function layout(positions, { heightMm, unitMm = 1 } = {}) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) {
    const value = positions[i], c = i % 3;
    if (value < lo[c]) lo[c] = value;
    if (value > hi[c]) hi[c] = value;
  }
  const height = hi[2] - lo[2];
  const size = [0, 1, 2].map(c => hi[c] - lo[c]);
  if (!(heightMm > 0) || !(height > 0)) {
    if (unitMm === 1) return { positions: Float64Array.from(positions), scale: 1, size };
    return { positions: Float64Array.from(positions, value => value * unitMm), scale: unitMm, size: size.map(value => value * unitMm) };
  }
  const scale = heightMm / height;
  const shift = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2]];
  const out = new Float64Array(positions.length);
  for (let i = 0; i < positions.length; i++) out[i] = (positions[i] - shift[i % 3]) * scale;
  return { positions: out, scale, size: size.map(value => value * scale) };
}

const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>';
const RELS = '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>';

// Control characters are not allowed in XML at all, so they are dropped rather than escaped.
const escapeXml = text => String(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/[<>&"']/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[ch]);
// Coordinates are written as briefly as possible. Rounding the number and letting
// JavaScript print it is several times faster than formatting and trimming text.
// Five decimal places of a millimetre is a hundredth of a micron, far finer than any
// printer. A model whose own numbers are very small gets more places, so that rounding
// can never pull two of its points together.
const rounder = positions => {
  let reach = 0;
  for (let i = 0; i < positions.length; i++) { const size = Math.abs(positions[i]); if (size > reach) reach = size; }
  const places = reach >= 1 || !(reach > 0) ? 5 : Math.min(15, 5 + Math.ceil(-Math.log10(reach)));
  const factor = 10 ** places;
  return value => { const rounded = Math.round(value * factor) / factor; return rounded === 0 ? '0' : String(rounded); };
};

/**
 * A 3MF file holding one mesh, in millimetres. Unlike STL it keeps the units and the
 * shared vertices, so a slicer does not have to guess either.
 */
export async function write3MF(positions, tris, { title = 'model' } = {}) {
  const number = rounder(positions);
  const encoder = new TextEncoder();
  // The text is turned into bytes a megabyte at a time, so a large model never exists as
  // one enormous string and as its bytes at once.
  const pieces = [];
  let text = '', total = 0;
  const flush = () => { const bytes = encoder.encode(text); pieces.push(bytes); total += bytes.length; text = ''; };
  const write = line => { text += line; if (text.length > 1 << 20) flush(); };
  write('<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n');
  write(`<metadata name="Title">${escapeXml(title)}</metadata>\n<metadata name="Application">polymend ${VERSION}</metadata>\n`);
  write('<resources>\n<object id="1" type="model">\n<mesh>\n<vertices>\n');
  for (let i = 0; i < positions.length; i += 3) write(`<vertex x="${number(positions[i])}" y="${number(positions[i + 1])}" z="${number(positions[i + 2])}"/>\n`);
  write('</vertices>\n<triangles>\n');
  for (let i = 0; i < tris.length; i += 3) write(`<triangle v1="${tris[i]}" v2="${tris[i + 1]}" v3="${tris[i + 2]}"/>\n`);
  write('</triangles>\n</mesh>\n</object>\n</resources>\n<build>\n<item objectid="1"/>\n</build>\n</model>\n');
  flush();
  const model = new Uint8Array(total);
  let at = 0;
  for (const piece of pieces) { model.set(piece, at); at += piece.length; }
  return zip([
    ['[Content_Types].xml', encoder.encode(CONTENT_TYPES)],
    ['_rels/.rels', encoder.encode(RELS)],
    ['3D/3dmodel.model', model],
  ]);
}

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function deflate(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  // Some browsers have CompressionStream but not this format; the file is then stored as it is.
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * One file for a ZIP, packed on its own: deflated where the platform can and where that
 * makes it smaller, stored otherwise. Packing each file separately lets a large archive be
 * put together from parts, without ever holding all of it in one array.
 */
export async function zipEntry(name, data, { compress = true } = {}) {
  const nameBytes = new TextEncoder().encode(name);
  if (nameBytes.length > 255) throw new Error(`A file name in the ZIP is too long: ${name}`);
  const packed = compress ? await deflate(data) : null;
  const body = packed && packed.length < data.length ? packed : data;
  return { nameBytes, crc: crc32(data), method: body === data ? 0 : 8, size: data.length, body };
}

/**
 * The parts of a ZIP archive, in order, from entries made by `zipEntry`. An entry's body
 * may be bytes or a Blob, so `new Blob(zipParts(entries))` builds a large archive without
 * copying it into one array. Archives are plain ZIP, so they must stay under 4 GiB.
 */
export function zipParts(entries) {
  const LIMIT = 0xffffffff;
  const parts = [], directory = [];
  let offset = 0;
  for (const entry of entries) {
    const length = entry.body.size ?? entry.body.length;
    const header = new Uint8Array(30 + entry.nameBytes.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(6, 0x0800, true); view.setUint16(8, entry.method, true);
    view.setUint16(10, 0, true); view.setUint16(12, 0x21, true); // 1980-01-01, so the same model always gives the same file
    view.setUint32(14, entry.crc, true); view.setUint32(18, length, true); view.setUint32(22, entry.size, true);
    view.setUint16(26, entry.nameBytes.length, true); header.set(entry.nameBytes, 30);
    parts.push(header, entry.body);
    directory.push({ ...entry, length, offset });
    offset += header.length + length;
    if (offset > LIMIT || entry.size > LIMIT) throw new Error('The ZIP would be larger than 4 GB.');
  }
  const start = offset;
  for (const entry of directory) {
    const record = new Uint8Array(46 + entry.nameBytes.length);
    const view = new DataView(record.buffer);
    view.setUint32(0, 0x02014b50, true); view.setUint16(4, 20, true); view.setUint16(6, 20, true); view.setUint16(8, 0x0800, true);
    view.setUint16(10, entry.method, true); view.setUint16(12, 0, true); view.setUint16(14, 0x21, true);
    view.setUint32(16, entry.crc, true); view.setUint32(20, entry.length, true); view.setUint32(24, entry.size, true);
    view.setUint16(28, entry.nameBytes.length, true); view.setUint32(42, entry.offset, true);
    record.set(entry.nameBytes, 46);
    parts.push(record);
    offset += record.length;
  }
  if (offset > LIMIT || directory.length > 0xffff) throw new Error('The ZIP would be larger than 4 GB.');
  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true); view.setUint16(8, directory.length, true); view.setUint16(10, directory.length, true);
  view.setUint32(12, offset - start, true); view.setUint32(16, start, true);
  parts.push(end);
  return parts;
}

/** A small ZIP archive in one array. `files` is a list of [name, bytes] pairs. */
export async function zip(files) {
  const entries = [];
  for (const [name, data] of files) entries.push(await zipEntry(name, data));
  const parts = zipParts(entries);
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

/**
 * A file name with nothing in it that could escape a folder, upset an unzip tool, or
 * stop it extracting on Windows: only plain characters, no leading dots, no trailing dots
 * or spaces, not a name Windows reserves, and not too long.
 */
export function safeFileName(name) {
  let out = String(name).replace(/[^A-Za-z0-9 ._()+-]/g, '_').replace(/^[.]+/, '_').replace(/[. ]+$/, '').slice(0, 100);
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(out)) out = '_' + out;
  return out || 'model';
}
