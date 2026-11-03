// RFC-4180 CSV. NULL is written as an empty field, an empty string as "" — so backups round-trip exactly.
export function csvField(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s === '' || /[",\r\n]/.test(s) || /^\s|\s$/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
export const toCsv = (columns: string[], rows: unknown[][]) => '\ufeff' + [columns.map(csvField).join(','), ...rows.map((r) => r.map(csvField).join(','))].join('\r\n') + '\r\n';

export function parseCsv(text: string): (string | null)[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: (string | null)[][] = []; let row: (string | null)[] = []; let i = 0; const n = text.length;
  while (i < n) {
    if (text[i] === '"') {                                   // quoted field (may be empty string)
      let v = ''; i++;
      for (;;) { if (i >= n) throw new Error('Unterminated quoted field'); if (text[i] === '"') { if (text[i + 1] === '"') { v += '"'; i += 2; } else { i++; break; } } else v += text[i++]; }
      row.push(v);
    } else { let j = i; while (j < n && text[j] !== ',' && text[j] !== '\n' && text[j] !== '\r') j++; const v = text.slice(i, j); row.push(v === '' ? null : v); i = j; }
    if (text[i] === ',') { i++; if (i >= n || text[i] === '\n' || text[i] === '\r') row.push(null); else continue; }   // trailing empty field
    if (text[i] === '\r') i++; if (text[i] === '\n') i++;
    rows.push(row); row = [];
  }
  if (row.length) rows.push(row);
  return rows.filter((r) => !(r.length === 1 && r[0] === null));
}
