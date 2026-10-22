import { describe, it, expect } from 'vitest';
import {
  cleanTaskText,
  extractTags,
  parseTask,
} from '../../src/parser/index.js';
import type { Span } from '../../src/parser/index.js';

const parse = (line: string, spans?: ReadonlyArray<Span>) =>
  parseTask(line, 1, 'test.md', {}, spans);

describe('parseTask with protected spans', () => {
  it('reads no metadata inside a span and keeps its text', () => {
    const { task } = parse('- [ ] fix [[a!!]] @tj', [[10, 17]]);
    expect(task?.priority).toBeUndefined();
    expect(task?.assignee).toBe('tj');
    expect(task?.text).toBe('fix [[a!!]]');
  });

  it('behaves like the plain parser when no spans are given', () => {
    expect(parse('- [ ] fix [[a!!]]').task?.priority).toBe('high');
    expect(parse('- [ ] fix [[a!!]]', []).task?.priority).toBe('high');
  });

  it('restores several spans to their own positions regardless of the order given', () => {
    const { task } = parse('- [ ] [[a!]] x [[b@z]] #t', [
      [15, 22],
      [6, 12],
    ]);
    expect(task?.priority).toBeUndefined();
    expect(task?.assignee).toBeUndefined();
    expect(task?.tags).toEqual(['t']);
    expect(task?.text).toBe('[[a!]] x [[b@z]]');
  });

  it('protects a span that starts right after the checkbox', () => {
    const { task } = parse('- [ ] [[a!]] x', [[6, 12]]);
    expect(task?.priority).toBeUndefined();
    expect(task?.text).toBe('[[a!]] x');
  });

  it('protects a span that ends at the end of the line', () => {
    const line = '- [ ] fix [[a!!]]';
    const { task } = parse(line, [[10, line.length]]);
    expect(task?.priority).toBeUndefined();
    expect(task?.text).toBe('fix [[a!!]]');
  });

  it('ignores a span that covers the checkbox or starts before the text', () => {
    expect(parse('- [ ] x !!', [[0, 4]]).task?.priority).toBe('high');
    expect(parse('- [ ] x !!', [[4, 9]]).task?.priority).toBe('high');
    expect(parse('- [ ] x !!', [[4, 9]]).task?.text).toBe('x');
  });

  it('ignores a span that runs past the end of the line', () => {
    const { task } = parse('- [ ] x !!', [[6, 99]]);
    expect(task?.priority).toBe('high');
    expect(task?.text).toBe('x');
  });

  it('ignores empty and inverted spans', () => {
    expect(parse('- [ ] x !!', [[8, 8]]).task?.priority).toBe('high');
    expect(parse('- [ ] x !!', [[9, 8]]).task?.priority).toBe('high');
    expect(parse('- [ ] x !!', [[8, 8]]).task?.text).toBe('x');
  });

  it('restores protected text literally, even if it looks like a replacement pattern', () => {
    const { task } = parse('- [ ] a [[x$&y]]', [[8, 16]]);
    expect(task?.text).toBe('a [[x$&y]]');
  });

  it('restores two identical spans by position', () => {
    const { task } = parse('- [ ] [[a]] @tj [[a]]', [
      [6, 11],
      [16, 21],
    ]);
    expect(task?.text).toBe('[[a]] [[a]]');
  });

  it('keeps the original text in warnings and never leaks placeholders', () => {
    const { task, warnings } = parse('- [ ] fix [[a!!]]', [[10, 17]]);
    const due = warnings.find((w) => w.ruleId === 'missing-due-date');
    expect(due?.text).toBe('fix [[a!!]]');
    expect(task?.text).not.toMatch(/[-]/);
  });
});

describe('numeric references are not tags (D4)', () => {
  it('rejects a purely numeric name', () => {
    expect(extractTags('PR #2920')).toEqual([]);
    expect(extractTags('PR #2920 and more')).toEqual([]);
    expect(extractTags('#12 #13')).toEqual([]);
  });

  it('accepts names that merely contain or start with digits', () => {
    expect(extractTags('#2026-q1')).toEqual(['2026-q1']);
    expect(extractTags('#2920abc')).toEqual(['2920abc']);
    expect(extractTags('#a1')).toEqual(['a1']);
  });

  it('still excludes due dates', () => {
    expect(extractTags('#due/2026-01-01')).toEqual([]);
  });

  it('leaves a numeric reference in the display text', () => {
    expect(cleanTaskText('Fix #2920 #q4')).toBe('Fix #2920');
  });
});
