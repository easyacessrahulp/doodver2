import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, toCsv } from '../src/lib/csv.ts';

test('CSV round-trips NULL vs empty string, quotes, commas, newlines, unicode and trailing empty fields', () => {
  const rows = [[null, '', 'a,b', 'say "hi"', 'line1\nline2', 'தமிழ് ✓', ' padded '], ['x', null, null, null, null, null, null], [null, null, null, null, null, null, 'end']];
  const out = parseCsv(toCsv(['a', 'b', 'c', 'd', 'e', 'f', 'g'], rows));
  assert.deepEqual(out.slice(1), rows);
  assert.deepEqual(parseCsv('a,b,c\r\n1,,\r\n,,3'), [['a', 'b', 'c'], ['1', null, null], [null, null, '3']]);
});
