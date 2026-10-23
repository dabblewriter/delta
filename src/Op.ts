/* eslint-disable @typescript-eslint/no-explicit-any */
import AttributeMap from './AttributeMap.js';

interface Op {
  // only one property out of {insert, delete, retain} will be present
  insert?: string | Record<string, any>;
  delete?: number;
  retain?: number;

  attributes?: AttributeMap;
}

namespace Op {
  export function iterator(ops: Op[]): OpIterator {
    return new OpIterator(ops);
  }

  /**
   * Returns 0 for an op with no valid length: an empty insert, or a retain or delete that is not a whole number
   * above zero (NaN, null, negative, fractional, or an Infinity delete). Every reader skips such an op.
   */
  export function length(op: Op): number {
    if (op.delete != null) {
      return validLength(op.delete);
    } else if (op.retain != null) {
      // The iterator uses `{ retain: Infinity }` for the rest of the document
      return op.retain === Infinity ? Infinity : validLength(op.retain);
    } else if (typeof op.insert === 'string') {
      return op.insert.length;
    } else {
      return op.insert != null ? 1 : 0;
    }
  }

  export function isEmpty(op: Op): boolean {
    return length(op) === 0;
  }
}

export default Op;

function validLength(n: number): number {
  return Number.isInteger(n) && n > 0 ? n : 0;
}

export function withoutEmpty(ops: Op[]): Op[] {
  let kept: Op[] | undefined;
  ops.forEach((op, i) => {
    if (Op.isEmpty(op)) {
      kept ??= ops.slice(0, i);
    } else {
      kept?.push(op);
    }
  });
  return kept ?? ops;
}

export class OpIterator {
  ops: Op[];
  index: number;
  offset: number;

  constructor(ops: Op[]) {
    this.ops = ops;
    this.index = 0;
    this.offset = 0;
    this.skipEmpty();
  }

  hasNext(): boolean {
    return !!this.peek();
  }

  /**
   * A missing or NaN length takes the rest of the current op. Zero or less takes nothing and returns
   * `{ retain: 0 }`, which `push` drops.
   */
  next(length?: number): Op {
    if (length == null || Number.isNaN(length)) {
      length = Infinity;
    } else if (length <= 0) {
      return { retain: 0 };
    }
    const nextOp = this.ops[this.index];
    if (nextOp) {
      const offset = this.offset;
      const opLength = Op.length(nextOp);
      if (length >= opLength - offset) {
        length = opLength - offset;
        this.index += 1;
        this.offset = 0;
        this.skipEmpty();
      } else {
        this.offset += length;
      }
      if (typeof nextOp.delete === 'number') {
        return { delete: length };
      } else {
        if (opLength === length) return nextOp;
        const retOp: Op = {};
        if (nextOp.attributes) {
          retOp.attributes = nextOp.attributes;
        }
        if (typeof nextOp.retain === 'number') {
          retOp.retain = length;
        } else if (typeof nextOp.insert === 'string') {
          retOp.insert = nextOp.insert.substr(offset, length);
        } else {
          // offset should === 0, length should === 1
          retOp.insert = nextOp.insert;
        }
        return retOp;
      }
    } else {
      return { retain: Infinity };
    }
  }

  peek(): Op {
    return this.ops[this.index];
  }

  peekLength(): number {
    if (this.ops[this.index]) {
      // Should never return 0 if our index is being managed correctly
      return Op.length(this.ops[this.index]) - this.offset;
    } else {
      return Infinity;
    }
  }

  peekType(): string {
    const op = this.ops[this.index];
    if (op) {
      if (typeof op.delete === 'number') {
        return 'delete';
      } else if (typeof op.retain === 'number') {
        return 'retain';
      } else {
        return 'insert';
      }
    }
    return 'retain';
  }

  rest(): Op[] {
    if (!this.hasNext()) {
      return [];
    } else if (this.offset === 0) {
      return withoutEmpty(this.ops.slice(this.index));
    } else {
      const offset = this.offset;
      const index = this.index;
      const next = this.next();
      const rest = withoutEmpty(this.ops.slice(this.index));
      this.offset = offset;
      this.index = index;
      return [next].concat(rest);
    }
  }

  private skipEmpty() {
    while (this.index < this.ops.length && Op.isEmpty(this.ops[this.index])) {
      this.index += 1;
    }
  }
}
