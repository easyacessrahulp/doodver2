// Small helpers for producing Word (.docx) files with the `docx` package.
import { AlignmentType, BorderStyle, Document, Footer, HeadingLevel, HeightRule, LevelFormat, Packer, PageNumber, PageOrientation, Paragraph, Table, TableCell, TableRow, TextRun, VerticalAlign, WidthType, ShadingType } from 'docx';

export type Block = Paragraph | Table;
const FONT = 'Calibri';
export const run = (text: string, o: { bold?: boolean; italics?: boolean; size?: number; color?: string } = {}) => new TextRun({ text, font: FONT, ...o });
export const heading = (text: string, level: 1 | 2 | 3 = 1) => new Paragraph({ heading: [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][level - 1], spacing: { before: 200, after: 100 }, children: [run(text, { bold: true })] });
export const para = (text: string, o: { bold?: boolean; italics?: boolean; size?: number; color?: string; after?: number } = {}) => new Paragraph({ spacing: { after: o.after ?? 100 }, children: [run(text, o)] });
export const muted = (text: string) => para(text, { color: '666666', size: 18 });

/** Turns what the user typed in the Notes editor into Word paragraphs: "-", "*", "•" lines become bullets, "1." / "1)" lines become numbered points, blank lines separate paragraphs. */
export function textToBlocks(text: string): Paragraph[] {
  const out: Paragraph[] = [];
  for (const raw of String(text ?? '').replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, ''); if (!line.trim()) continue;
    const b = line.match(/^\s*[-*•–]\s+(.*)$/); const n = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (b) out.push(new Paragraph({ numbering: { reference: 'bullets', level: 0 }, spacing: { after: 60 }, children: [run(b[1])] }));
    else if (n) out.push(new Paragraph({ spacing: { after: 60 }, indent: { left: 360, hanging: 360 }, children: [run(`${n[1]}.\t${n[2]}`)] }));
    else out.push(new Paragraph({ spacing: { after: 100 }, children: [run(line.trim())] }));
  }
  return out;
}

const cellBorder = { style: BorderStyle.SINGLE, size: 4, color: 'BBBBBB' };
const borders = { top: cellBorder, bottom: cellBorder, left: cellBorder, right: cellBorder };
/** A simple bordered table. `widths` are in DXA and should add up to the page width. */
export function table(columns: string[], rows: string[][], widths: number[]) {
  const total = widths.reduce((a, b) => a + b, 0);
  const cell = (t: string, w: number, head = false) => new TableCell({ borders, width: { size: w, type: WidthType.DXA }, margins: { top: 60, bottom: 60, left: 90, right: 90 },
    shading: head ? { fill: 'E8EEF7', type: ShadingType.CLEAR, color: 'auto' } : undefined, children: String(t ?? '').split('\n').map((l) => new Paragraph({ children: [run(l, { bold: head, size: 18 })] })) });
  return new Table({ width: { size: total, type: WidthType.DXA }, columnWidths: widths,
    rows: [new TableRow({ tableHeader: true, children: columns.map((c, i) => cell(c, widths[i], true)) }), ...rows.map((r) => new TableRow({ cantSplit: true, children: r.map((c, i) => cell(c, widths[i])) }))] });
}


// ───── Company branding for notes: a coloured banner (monogram + company name), a tri-tone stripe and a footer ─────
export const PALETTE: Record<string, { label: string; hex: string }> = {
  navy: { label: 'Navy blue', hex: '1F3864' }, teal: { label: 'Teal', hex: '0F766E' }, crimson: { label: 'Crimson', hex: '9F1239' },
  amber: { label: 'Amber', hex: 'B45309' }, purple: { label: 'Purple', hex: '6D28D9' }, green: { label: 'Green', hex: '15803D' }, slate: { label: 'Slate', hex: '334155' },
};
export interface Brand { name: string; color: string; label?: string }
const KEYS = Object.keys(PALETTE);
/** A stable colour per company unless the author picked one. */
export const brandColor = (key: string | null | undefined, seed: string) => PALETTE[key ?? '']?.hex ?? PALETTE[KEYS[[...seed].reduce((a, c) => a + c.charCodeAt(0), 0) % KEYS.length]].hex;
const mix = (hex: string, pct: number) => { const c = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)); return c.map((v) => Math.round(v + (255 - v) * pct).toString(16).padStart(2, '0')).join('').toUpperCase(); };
const monogram = (name: string) => { const w = name.replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean); return (w.length > 1 ? w[0][0] + w[1][0] : (w[0] ?? 'D').slice(0, 2)).toUpperCase(); };
const NONE = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }; const noBorders = { top: NONE, bottom: NONE, left: NONE, right: NONE };
const fill = (hex: string) => ({ fill: hex, type: ShadingType.CLEAR, color: 'auto' });

/** Banner for the top of a note. `width` is the usable page width in DXA. */
export function brandBanner(b: Brand, width: number): Block[] {
  const stripe = new Table({ width: { size: width, type: WidthType.DXA }, columnWidths: [Math.round(width * 0.7), Math.round(width * 0.2), width - Math.round(width * 0.7) - Math.round(width * 0.2)],
    rows: [new TableRow({ height: { value: 110, rule: HeightRule.EXACT }, children: [[0.7, b.color], [0.2, mix(b.color, 0.45)], [0.1, mix(b.color, 0.8)]].map(([w, c]) => new TableCell({ borders: noBorders, width: { size: Math.round(width * (w as number)), type: WidthType.DXA }, shading: fill(c as string), children: [new Paragraph({ spacing: { after: 0 }, children: [new TextRun({ text: '', size: 2 })] })] })) })] });
  const logoW = 1150;
  const banner = new Table({ width: { size: width, type: WidthType.DXA }, columnWidths: [logoW, width - logoW],
    rows: [new TableRow({ children: [
      new TableCell({ borders: noBorders, width: { size: logoW, type: WidthType.DXA }, shading: fill(b.color), verticalAlign: VerticalAlign.CENTER, margins: { top: 140, bottom: 140, left: 60, right: 60 },
        children: [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 0 }, children: [new TextRun({ text: monogram(b.name), font: 'Arial', bold: true, size: 44, color: 'FFFFFF' })] })] }),
      new TableCell({ borders: noBorders, width: { size: width - logoW, type: WidthType.DXA }, shading: fill(mix(b.color, 0.9)), verticalAlign: VerticalAlign.CENTER, margins: { top: 120, bottom: 120, left: 240, right: 160 },
        children: [new Paragraph({ spacing: { after: 20 }, children: [new TextRun({ text: b.name.toUpperCase(), font: 'Arial', bold: true, size: 34, color: b.color })] }),
          ...(b.label ? [new Paragraph({ spacing: { after: 0 }, children: [new TextRun({ text: b.label.toUpperCase(), font: 'Arial', size: 17, color: '666666', characterSpacing: 40 })] })] : [])] }),
    ] })] });
  return [stripe, banner, new Paragraph({ spacing: { after: 200 }, border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: b.color, space: 1 } }, children: [new TextRun({ text: '', size: 4 })] })];
}
export const brandFooter = (b: Brand) => ({ default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, border: { top: { style: BorderStyle.SINGLE, size: 6, color: b.color, space: 6 } },
  children: [new TextRun({ text: `${b.name}  ·  Page `, font: 'Arial', size: 16, color: b.color }), new TextRun({ children: [PageNumber.CURRENT], font: 'Arial', size: 16, color: b.color }), new TextRun({ text: ' of ', font: 'Arial', size: 16, color: b.color }), new TextRun({ children: [PageNumber.TOTAL_PAGES], font: 'Arial', size: 16, color: b.color })] })] }) });

export async function buildDocx(children: Block[], o: { landscape?: boolean; title?: string; brand?: Brand } = {}) {
  const doc = new Document({
    creator: 'DOOD', title: o.title ?? 'DOOD',
    styles: { default: { document: { run: { font: FONT, size: 22 } } },
      paragraphStyles: [1, 2, 3].map((n) => ({ id: `Heading${n}`, name: `Heading ${n}`, basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: [32, 26, 23][n - 1], bold: true, font: FONT, color: o.brand?.color, color: '1F3864' }, paragraph: { spacing: { before: 200, after: 100 }, outlineLevel: n - 1 } })) },
    numbering: { config: [{ reference: 'bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] }] },
    sections: [{ properties: { page: { size: { width: 11906, height: 16838, orientation: o.landscape ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT }, margin: { top: 1000, right: 1000, bottom: 1000, left: 1000 } } }, ...(o.brand ? { footers: brandFooter(o.brand) } : {}), children: o.brand ? [...brandBanner(o.brand, 9906), ...children] : children }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const safeName = (s: string) => s.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'note';

// ───── "Proper note" in the company's formal format: SUB line, Dear Sir, numbered points with lettered sub-points, "For approval", signer and date ─────
export interface FormalNote { subject: string; salutation: string; points: { text: string; sub: string[] }[]; closing: string; signerTitle: string; date: string }
export async function formalNoteDocx(n: FormalNote, title = 'Note', brand?: Brand) {
  const A = 'Arial'; const r = (text: string, bold = false) => new TextRun({ text, font: A, size: 22, bold });
  const p = (children: TextRun[], o: Record<string, unknown> = {}) => new Paragraph({ alignment: AlignmentType.JUSTIFIED, spacing: { after: 120 }, children, ...o });
  const C = brand?.color ?? '000000';
  const kids: Block[] = [
    ...(brand ? brandBanner(brand, 9026) : []),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 80, after: 240 }, shading: brand ? fill(mix(C, 0.9)) : undefined,
      border: brand ? { top: { style: BorderStyle.SINGLE, size: 6, color: C, space: 6 }, bottom: { style: BorderStyle.SINGLE, size: 6, color: C, space: 6 } } : undefined,
      children: [new TextRun({ text: `SUB: ${n.subject.replace(/^SUB:\s*/i, '').toUpperCase()}`, font: A, size: 23, bold: true, color: brand ? C : undefined })] }),
    p([r(n.salutation)], { spacing: { after: 200 } }),
  ];
  for (const pt of n.points) {
    kids.push(p([r(pt.text)], { numbering: { reference: 'formal', level: 0 } }));
    for (const s of pt.sub) kids.push(p([r(s)], { numbering: { reference: 'formal', level: 1 }, spacing: { after: 80 } }));
  }
  kids.push(p([r('')]), p([new TextRun({ text: n.closing, font: A, size: 22, bold: true, color: brand ? C : undefined })], { spacing: { after: 360 } }), p([r(n.signerTitle)], { spacing: { after: 40 } }), p([r(n.date)]));
  const doc = new Document({
    creator: 'DOOD', title, styles: { default: { document: { run: { font: A, size: 22 } } } },
    numbering: { config: [{ reference: 'formal', levels: [
      { level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } }, run: { bold: true, color: brand ? C : undefined } } },
      { level: 1, format: LevelFormat.LOWER_LETTER, text: '%2.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 1440, hanging: 360 } }, run: { color: brand ? C : undefined } } }] }] },
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } }, ...(brand ? { footers: brandFooter(brand) } : {}), children: kids }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}
