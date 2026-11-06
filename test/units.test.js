const assert = require('node:assert/strict');
const test = require('node:test');

const { pointInPolygon, pointNearPolygon } = require('../src/geo');
const { toCsv, csvCell } = require('../src/csv');

// 100 m x 100 m block near Sandton. Points are [lat, lng], as stored in site.coordinates.
const block = [
  [-26.1, 28.05],
  [-26.1, 28.051],
  [-26.099, 28.051],
  [-26.099, 28.05],
];

test('pointInPolygon detects inside and outside', () => {
  assert.equal(pointInPolygon([-26.0995, 28.0505], block), true);
  assert.equal(pointInPolygon([-26.0989, 28.0505], block), false);
  assert.equal(pointInPolygon([-26.0995, 28.0525], block), false);
});

test('pointInPolygon returns false for an empty polygon', () => {
  assert.equal(pointInPolygon([-26.0995, 28.0505], []), false);
});

test('pointNearPolygon respects the tolerance in metres', () => {
  const justOutside = [-26.0989, 28.0505]; // ~11 m north of the block edge
  assert.equal(pointInPolygon(justOutside, block), false);
  assert.equal(pointNearPolygon(justOutside, block, 50), true);
  assert.equal(pointNearPolygon(justOutside, block, 5), false);
  assert.equal(pointNearPolygon([-26.0905, 28.0505], block, 50), false); // ~1 km away
});

test('pointNearPolygon ignores zero tolerance and degenerate polygons', () => {
  assert.equal(pointNearPolygon([-26.0995, 28.0505], block, 0), false);
  assert.equal(pointNearPolygon([-26.0995, 28.0505], [block[0]], 50), false);
});

test('csvCell neutralises spreadsheet formulas', () => {
  for (const value of ['=1+1', '+27 82', '-3', '@SUM(A1)']) {
    assert.ok(csvCell(value).startsWith(`"'`), `${value} should be prefixed`);
  }
  assert.equal(csvCell('Unit 12'), '"Unit 12"');
});

test('csvCell doubles embedded quotes and renders empty values', () => {
  assert.equal(csvCell('a"b'), '"a""b"');
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell(undefined), '""');
});

test('toCsv uses the union of keys, CRLF rows and pipe-joined arrays', () => {
  const csv = toCsv([
    { callSign: 'Unit 12', assigned: ['a', 'b'] },
    { callSign: 'Unit 07', online: true },
  ]);
  const [head, first, second] = csv.split('\r\n');
  assert.equal(head, '"callSign","assigned","online"');
  assert.equal(first, '"Unit 12","a|b",""');
  assert.equal(second, '"Unit 07","","true"');
  assert.equal(toCsv([]), '');
});
