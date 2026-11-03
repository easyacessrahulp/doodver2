// Turns an uploaded document into something the AI can read: PDFs and pictures go as they are; Word, Excel and text files are turned into plain text first.
import JSZip from 'jszip';
import { badRequest } from './errors.ts';

export interface InFile { fileName: string; mimeType: string; bytes: Buffer }
export interface Readable { parts: { mimeType: string; dataBase64: string; fileName: string }[]; texts: string[] }
const MAX_TEXT = 30000;
const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

async function docxText(b: Buffer) {
  const z = await JSZip.loadAsync(b); const f = z.file('word/document.xml'); if (!f) throw badRequest('That Word file could not be read.');
  const xml = await f.async('string');
  return decode(xml.replace(/<\/w:p>/g, '\n').replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>/g, '\n').replace(/<[^>]+>/g, '')).replace(/\n{3,}/g, '\n\n').trim();
}
async function xlsxText(b: Buffer) {
  const z = await JSZip.loadAsync(b); const shared = z.file('xl/sharedStrings.xml'); const strings: string[] = [];
  if (shared) for (const m of (await shared.async('string')).matchAll(/<si>([\s\S]*?)<\/si>/g)) strings.push(decode(m[1].replace(/<[^>]+>/g, '')));
  const out: string[] = [];
  const sheets = Object.keys(z.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort();
  for (const name of sheets) {
    out.push(`[${name.replace(/^xl\/worksheets\//, '').replace('.xml', '')}]`);
    for (const row of (await z.file(name)!.async('string')).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [...row[1].matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map((c) => { const v = /<v>([\s\S]*?)<\/v>/.exec(c[2] ?? '')?.[1] ?? ''; return /t="s"/.test(c[1]) ? strings[Number(v)] ?? '' : decode(v); });
      if (cells.some(Boolean)) out.push(cells.join(' | '));
    }
  }
  return out.join('\n');
}
export async function readableFiles(files: InFile[]): Promise<Readable> {
  const r: Readable = { parts: [], texts: [] };
  for (const f of files) {
    const n = f.fileName.toLowerCase(); const mt = f.mimeType.toLowerCase();
    if (mt === 'application/pdf' || n.endsWith('.pdf')) r.parts.push({ mimeType: 'application/pdf', dataBase64: f.bytes.toString('base64'), fileName: f.fileName });
    else if (/^image\/(png|jpe?g|webp)$/.test(mt)) r.parts.push({ mimeType: mt === 'image/jpg' ? 'image/jpeg' : mt, dataBase64: f.bytes.toString('base64'), fileName: f.fileName });
    else if (n.endsWith('.docx')) r.texts.push(`FILE "${f.fileName}":\n${(await docxText(f.bytes)).slice(0, MAX_TEXT)}`);
    else if (n.endsWith('.xlsx')) r.texts.push(`FILE "${f.fileName}":\n${(await xlsxText(f.bytes)).slice(0, MAX_TEXT)}`);
    else if (/^text\//.test(mt) || /\.(txt|csv|md|json|xml|html?|log)$/.test(n)) r.texts.push(`FILE "${f.fileName}":\n${f.bytes.toString('utf8').replace(/<[^>]+>/g, n.endsWith('.html') || n.endsWith('.htm') ? ' ' : '$&').slice(0, MAX_TEXT)}`);
    else throw badRequest(`“${f.fileName}” is not a type the AI can read. Use a PDF, a picture (JPG/PNG), a Word (.docx) or Excel (.xlsx) file, or a text/CSV file.`);
  }
  return r;
}
