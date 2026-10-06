import { inflateRawSync } from 'zlib';

/**
 * Đọc sheet đầu tiên của file .xlsx thành mảng dòng (mảng text từng ô) — chỉ dùng `zlib` của Node, không thêm thư viện.
 * Đủ cho TC export: tên cột, số dòng, giá trị ô. Hỗ trợ shared strings, inline string và số.
 */
export function readXlsxRows(buffer: Buffer): string[][] {
  const entries = unzip(buffer);
  const shared = parseSharedStrings(entries.get('xl/sharedStrings.xml') ?? '');
  const sheetName = [...entries.keys()].filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort()[0];
  if (!sheetName) throw new Error('The workbook has no worksheet');
  const rows: string[][] = [];
  for (const rowMatch of entries.get(sheetName)!.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: string[] = [];
    for (const cell of rowMatch[1].matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cell[1];
      const inner = cell[2] ?? '';
      const ref = /r="([A-Z]+)\d+"/.exec(attrs)?.[1];
      const column = ref ? columnIndex(ref) : row.length;
      const type = /t="([^"]+)"/.exec(attrs)?.[1];
      let value = '';
      if (type === 's') value = shared[Number(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? -1)] ?? '';
      else if (type === 'inlineStr') value = textOf(inner);
      else value = decode(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '');
      while (row.length < column) row.push('');
      row[column] = value;
    }
    rows.push(row);
  }
  return rows;
}

function columnIndex(letters: string): number {
  return [...letters].reduce((acc, ch) => acc * 26 + ch.charCodeAt(0) - 64, 0) - 1;
}

function parseSharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) => textOf(match[1]));
}

function textOf(xml: string): string {
  return [...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((match) => decode(match[1])).join('');
}

function decode(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

/** Giải nén các entry .xml của zip qua central directory (method 0 = store, 8 = deflate). */
function unzip(buffer: Buffer): Map<string, string> {
  const files = new Map<string, string>();
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('Not a zip / xlsx file');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i += 1) {
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (!name.endsWith('.xml')) continue;
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(start, start + compressedSize);
    files.set(name, (method === 8 ? inflateRawSync(data) : data).toString('utf8'));
  }
  return files;
}
