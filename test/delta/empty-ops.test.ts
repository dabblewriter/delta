import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import AttributeMap from '../../src/AttributeMap.js';
import Delta from '../../src/Delta.js';
import Op, { OpIterator } from '../../src/Op.js';

// Rebuilding through the builder merges adjacent ops, so results compare by content, not op boundaries
const rebuild = (ops: Op[]) =>
  ops.reduce((delta, op) => {
    if (op.insert !== undefined) return delta.insert(op.insert, op.attributes);
    if (op.retain !== undefined) return delta.retain(op.retain, op.attributes);
    return delta.delete(op.delete ?? 0);
  }, new Delta());

function expectSame(actual: Delta, expected: Delta) {
  expect(actual.ops.filter(op => Op.length(op) <= 0)).toEqual([]);
  expect(rebuild(actual.ops)).toEqual(rebuild(expected.ops));
}

const attributes = fc.constantFrom<AttributeMap>({ bold: true }, { italic: true }, { a: 1 }, { bold: true, a: 1 });
const formats = fc.oneof(attributes, fc.constantFrom<AttributeMap>({ bold: null }, { a: null, italic: true }));
const text = fc.string({ unit: fc.constantFrom('a', 'b', 'c', '\n'), minLength: 1, maxLength: 6 });
const insert = fc.record(
  { insert: fc.oneof({ arbitrary: text, weight: 4 }, fc.constant({ image: 'x' })), attributes },
  { requiredKeys: ['insert'] }
);
const emptyInsert = fc.record({ insert: fc.constant(''), attributes }, { requiredKeys: ['insert'] });
const empty = fc.oneof(
  emptyInsert,
  fc.record({ retain: fc.integer({ min: -3, max: 0 }), attributes: formats }, { requiredKeys: ['retain'] }),
  fc.record({ delete: fc.integer({ min: -3, max: 0 }) })
);
const length = fc.integer({ min: 1, max: 6 });
const change = fc.oneof(
  { arbitrary: fc.record({ retain: length, attributes: formats }, { requiredKeys: ['retain'] }), weight: 3 },
  { arbitrary: fc.record({ delete: length }), weight: 2 },
  { arbitrary: insert, weight: 2 },
  { arbitrary: empty, weight: 2 }
);

// The same raw ops twice: with ops of no length (zero or negative) scattered through, and without them
const pair = (ops: Op[]) => ({ dirty: new Delta(ops), clean: new Delta(ops.filter(op => Op.length(op) > 0)) });
const docs = fc.array(fc.oneof({ arbitrary: insert, weight: 3 }, empty), { maxLength: 12 }).map(pair);
const changes = fc.array(change, { maxLength: 10 }).map(pair);

const runs = { numRuns: 1000 };

describe('ops with no length', () => {
  it('compose() ignores them in either delta', () => {
    fc.assert(
      fc.property(docs, changes, (doc, change) => {
        const expected = doc.clean.compose(change.clean);
        expectSame(doc.dirty.compose(change.clean), expected);
        expectSame(doc.clean.compose(change.dirty), expected);
        expectSame(doc.dirty.compose(change.dirty), expected);
      }),
      runs
    );
  });

  it('compose() of two changes ignores them', () => {
    fc.assert(
      fc.property(changes, changes, (a, b) => {
        expectSame(a.dirty.compose(b.dirty), a.clean.compose(b.clean));
      }),
      runs
    );
  });

  it('transform() ignores them', () => {
    fc.assert(
      fc.property(changes, changes, fc.boolean(), (a, b, priority) => {
        expectSame(a.dirty.transform(b.dirty, priority), a.clean.transform(b.clean, priority));
      }),
      runs
    );
  });

  it('transformPosition() ignores them', () => {
    fc.assert(
      fc.property(changes, fc.nat(40), fc.boolean(), (change, index, priority) => {
        expect(change.dirty.transformPosition(index, priority)).toEqual(
          change.clean.transformPosition(index, priority)
        );
      }),
      runs
    );
  });

  it('invert() ignores them', () => {
    fc.assert(
      fc.property(docs, changes, (doc, change) => {
        expectSame(change.dirty.invert(doc.dirty), change.clean.invert(doc.clean));
      }),
      runs
    );
  });

  it('diff() ignores them', () => {
    fc.assert(
      fc.property(docs, docs, (a, b) => {
        expectSame(a.dirty.diff(b.dirty), a.clean.diff(b.clean));
      }),
      runs
    );
  });

  it('slice(), length() and changeLength() ignore them', () => {
    fc.assert(
      fc.property(docs, changes, fc.nat(40), fc.nat(40), (doc, change, start, end) => {
        expect(doc.dirty.length()).toEqual(doc.clean.length());
        expect(change.dirty.length()).toEqual(change.clean.length());
        expect(change.dirty.changeLength()).toEqual(change.clean.changeLength());
        expectSame(doc.dirty.slice(start, end), doc.clean.slice(start, end));
      }),
      runs
    );
  });

  it('concat() ignores them', () => {
    fc.assert(
      fc.property(docs, docs, (a, b) => {
        expectSame(a.dirty.concat(b.dirty), a.clean.concat(b.clean));
      }),
      runs
    );
  });

  it('push() drops them', () => {
    fc.assert(
      fc.property(fc.array(change, { maxLength: 10 }), ops => {
        const pushed = ops.reduce((delta, op) => delta.push({ ...op }), new Delta());
        expect(pushed.ops.filter(op => Op.length(op) <= 0)).toEqual([]);
        expect(rebuild(pushed.ops)).toEqual(rebuild(ops));
      }),
      runs
    );
  });

  it('OpIterator never yields one', () => {
    const iter = new OpIterator([
      { insert: '' },
      { insert: 'ab' },
      { retain: 0 },
      { delete: 0 },
      { retain: -2 },
      { delete: -1 },
      { insert: 'cd' },
      { insert: '' },
    ]);
    expect(iter.peekLength()).toEqual(2);
    expect(iter.next(1)).toEqual({ insert: 'a' });
    expect(iter.next()).toEqual({ insert: 'b' });
    expect(iter.peekLength()).toEqual(2);
    expect(iter.rest()).toEqual([{ insert: 'cd' }]);
    expect(iter.next()).toEqual({ insert: 'cd' });
    expect(iter.hasNext()).toEqual(false);
  });

  it('OpIterator.next() takes nothing for a length of zero or less', () => {
    const iter = new OpIterator([{ insert: 'ab' }, { delete: 3 }]);
    expect(iter.next(0)).toEqual({ retain: 0 });
    expect(iter.next(-1)).toEqual({ retain: 0 });
    expect(iter.peekLength()).toEqual(2);
    expect(iter.next()).toEqual({ insert: 'ab' });
  });

  it('OpIterator.next() takes the rest of the op for a missing or NaN length', () => {
    for (const length of [undefined, null, NaN]) {
      const iter = new OpIterator([{ insert: 'abc' }, { delete: 3 }]);
      iter.next(1);
      expect(iter.next(length as number)).toEqual({ insert: 'bc' });
      expect(iter.peekLength()).toEqual(3);
    }
  });
});

describe('a negative-length op', () => {
  it('does not stop compose() or transform() from finishing', () => {
    const doc = new Delta([{ insert: 'abc' }]);
    const change = new Delta([{ retain: 1 }, { retain: -1 }, { delete: 1 }]);
    expect(doc.compose(change)).toEqual(new Delta([{ insert: 'ac' }]));
    expect(change.transform(new Delta([{ retain: 2 }, { insert: 'x' }]), true)).toEqual(
      new Delta([{ retain: 1 }, { insert: 'x' }])
    );
  });
});

describe('DAB-1886: a delete crossing an empty insert', () => {
  const source = Array.from({ length: 313 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');
  const ops = [{ insert: source.slice(0, 113) }, { insert: '', attributes: { a: 1 } }, { insert: source.slice(113) }];
  const change = new Delta([
    { retain: 71 },
    { insert: ' ' },
    { delete: 67 },
    { retain: 119 },
    { retain: 1, attributes: { b: true } },
  ]);
  const expected = new Delta()
    .insert(source.slice(0, 71) + ' ' + source.slice(138, 257))
    .insert(source[257], { b: true })
    .insert(source.slice(258));

  it('deletes exactly 67 chars', () => {
    const result = new Delta(ops).compose(change);
    expect(result.length()).toEqual(313 + 1 - 67);
    expect(result).toEqual(expected);
  });

  it('deletes exactly 67 chars after an op was emptied in place', () => {
    const doc = new Delta().insert(source.slice(0, 113)).insert('\n', { a: 1 }).insert(source.slice(113));
    doc.ops[1].insert = '';
    expect(doc.compose(change)).toEqual(expected);
  });
});
