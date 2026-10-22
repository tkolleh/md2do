import { describe, it, expect } from 'vitest';
import {
  analyzeStructure,
  childRange,
  mergeSpans,
  protectedSpansFor,
  wikiLinkSpans,
  type Structure,
} from '../../src/scanner/structure.js';
import type { Span } from '../../src/parser/index.js';

const analyze = (content: string): Structure =>
  analyzeStructure(content, content.split('\n'));
const spansOf = (s: Structure) => Object.fromEntries(s.linkSpans);

describe('mergeSpans', () => {
  it('returns an empty list for no spans', () => {
    expect(mergeSpans([])).toEqual([]);
  });

  it('keeps disjoint spans, sorted by start', () => {
    expect(
      mergeSpans([
        [10, 12],
        [0, 2],
        [5, 6],
      ]),
    ).toEqual([
      [0, 2],
      [5, 6],
      [10, 12],
    ]);
  });

  it('merges overlapping spans to the widest end', () => {
    expect(
      mergeSpans([
        [0, 5],
        [3, 8],
      ]),
    ).toEqual([[0, 8]]);
  });

  it('keeps the outer end when a span is contained in another', () => {
    expect(
      mergeSpans([
        [0, 10],
        [2, 3],
      ]),
    ).toEqual([[0, 10]]);
  });

  it('merges touching spans', () => {
    expect(
      mergeSpans([
        [0, 2],
        [2, 4],
      ]),
    ).toEqual([[0, 4]]);
  });

  it('does not merge spans separated by a gap', () => {
    expect(
      mergeSpans([
        [0, 2],
        [3, 4],
      ]),
    ).toEqual([
      [0, 2],
      [3, 4],
    ]);
  });

  it('does not mutate its input', () => {
    const input: ReadonlyArray<Span> = Object.freeze([
      [5, 6],
      [0, 2],
    ] as Span[]);
    mergeSpans(input);
    expect(input).toEqual([
      [5, 6],
      [0, 2],
    ]);
  });
});

describe('wikiLinkSpans', () => {
  it('finds wiki-links and embeds with exact offsets', () => {
    expect(wikiLinkSpans('a [[x]] b ![[y|z]]')).toEqual([
      [2, 7],
      [10, 18],
    ]);
  });

  it('finds adjacent wiki-links', () => {
    expect(wikiLinkSpans('[[a]][[b]]')).toEqual([
      [0, 5],
      [5, 10],
    ]);
  });

  it('ignores empty and unbalanced brackets', () => {
    expect(wikiLinkSpans('no links')).toEqual([]);
    expect(wikiLinkSpans('[[]]')).toEqual([]);
    expect(wikiLinkSpans('[[a[b]]]')).toEqual([]);
    expect(wikiLinkSpans('[single]')).toEqual([]);
  });
});

describe('analyzeStructure: fenced lines', () => {
  it('marks a backtick fence including its delimiter lines', () => {
    expect(analyze('a\n```\n- [ ] x\n```\nb').fencedLines).toEqual(
      new Set([2, 3, 4]),
    );
  });

  it('marks a tilde fence with an info string', () => {
    expect(analyze('~~~md\n- [ ] x\n~~~').fencedLines).toEqual(
      new Set([1, 2, 3]),
    );
  });

  it('keeps a shorter fence inside a longer one', () => {
    expect(analyze('````\n```\n- [ ] x\n```\n````').fencedLines).toEqual(
      new Set([1, 2, 3, 4, 5]),
    );
  });

  it('runs an unclosed fence to the end of the file', () => {
    expect(analyze('a\n```\n- [ ] x').fencedLines).toEqual(new Set([2, 3]));
  });

  it('marks a fence nested in a list item', () => {
    expect(analyze('- item\n  ```\n  - [ ] x\n  ```').fencedLines).toEqual(
      new Set([2, 3, 4]),
    );
  });

  it('does not treat indented code as a fence, even when a real fence follows', () => {
    expect(analyze('Intro\n\n    code\n\n```\nx\n```').fencedLines).toEqual(
      new Set([5, 6, 7]),
    );
  });

  it('is empty for plain text', () => {
    expect(analyze('plain\ntext').fencedLines).toEqual(new Set());
  });
});

describe('analyzeStructure: link spans', () => {
  it('records an inline link with exact columns', () => {
    expect(spansOf(analyze('- [ ] a [s](b.md) c'))).toEqual({
      1: [[8, 17]],
    });
  });

  it('records an image', () => {
    expect(spansOf(analyze('![i](p.png) x'))).toEqual({ 1: [[0, 11]] });
  });

  it('records a bare URL autolink', () => {
    expect(spansOf(analyze('see https://e.com/a#f now'))).toEqual({
      1: [[4, 21]],
    });
  });

  it('records a link by line using that line start, not the file start', () => {
    expect(spansOf(analyze('first line\nxx\n- [ ] a [s](b.md)'))).toEqual({
      3: [[8, 17]],
    });
  });

  it('records several links on one line in order', () => {
    expect(spansOf(analyze('a [x](1) b [y](2)'))).toEqual({
      1: [
        [2, 8],
        [11, 17],
      ],
    });
  });

  it('splits a link that spans lines into per-line ranges', () => {
    expect(spansOf(analyze('[a\nb\nc](u)'))).toEqual({
      1: [[0, 2]],
      2: [[0, 1]],
      3: [[0, 5]],
    });
  });

  it('records a reference link but not its definition', () => {
    expect(spansOf(analyze('see [r] now\n\n[r]: http://x'))).toEqual({
      1: [[4, 7]],
    });
  });

  it('records an image reference', () => {
    expect(spansOf(analyze('![i][r] x\n\n[r]: p.png'))).toEqual({
      1: [[0, 7]],
    });
  });

  it('ignores an undefined reference and plain text', () => {
    expect(spansOf(analyze('see [r] now'))).toEqual({});
    expect(spansOf(analyze('plain text'))).toEqual({});
  });

  it('keeps columns correct for CRLF files', () => {
    expect(spansOf(analyze('a\r\n- [ ] [s](u)\r\n'))).toEqual({
      2: [[6, 12]],
    });
  });

  it('records no links inside a fence', () => {
    expect(spansOf(analyze('x\n```\n[s](u)\n```'))).toEqual({});
  });
});

describe('protectedSpansFor', () => {
  it('merges AST links with wiki-links on the line, sorted', () => {
    const line = '- [ ] [s](u) and [[w]] x';
    expect(protectedSpansFor(analyze(line), 1, line)).toEqual([
      [6, 12],
      [17, 22],
    ]);
  });

  it('merges a wiki-link that overlaps a link span', () => {
    const structure: Structure = {
      fencedLines: new Set(),
      linkSpans: new Map([[1, [[2, 6]]]]),
    };
    expect(protectedSpansFor(structure, 1, 'ab[[c]]d')).toEqual([[2, 7]]);
  });

  it('uses only the spans of the requested line', () => {
    const structure: Structure = {
      fencedLines: new Set(),
      linkSpans: new Map([[2, [[0, 4]]]]),
    };
    expect(protectedSpansFor(structure, 1, 'ab[[c]]d')).toEqual([[2, 7]]);
    expect(protectedSpansFor(structure, 3, 'plain')).toEqual([]);
  });
});

describe('childRange', () => {
  it('has no children when the next line is a sibling or shallower', () => {
    expect(childRange(['- [ ] p'], 1)).toEqual({
      end: 1,
      description: undefined,
    });
    expect(childRange(['- [ ] p', '- [ ] q'], 1)).toEqual({
      end: 1,
      description: undefined,
    });
    expect(
      childRange(['  - [ ] p', '  sibling'], 1).description,
    ).toBeUndefined();
    expect(
      childRange(['  - [ ] p', 'shallower'], 1).description,
    ).toBeUndefined();
  });

  it('owns deeper lines up to the next line at its own indent', () => {
    expect(childRange(['- [ ] p', '  a', '  b', '- [ ] q'], 1)).toEqual({
      end: 3,
      description: 'a\nb',
    });
  });

  it('keeps a blank line between children', () => {
    expect(childRange(['- [ ] p', '  a', '', '  b', '- [ ] q'], 1)).toEqual({
      end: 4,
      description: 'a\n\nb',
    });
  });

  it('normalises whitespace-only lines inside the description to empty lines', () => {
    expect(childRange(['- [ ] p', '  a', '   ', '  b'], 1).description).toBe(
      'a\n\nb',
    );
  });

  it('excludes trailing blank lines from the range', () => {
    expect(childRange(['- [ ] p', '  a', '', '- [ ] q'], 1)).toEqual({
      end: 2,
      description: 'a',
    });
    expect(childRange(['- [ ] p', '  a', '   '], 1).end).toBe(2);
  });

  it('drops leading blank lines from the description but counts them in the range', () => {
    expect(childRange(['- [ ] p', '', '  a'], 1)).toEqual({
      end: 3,
      description: 'a',
    });
  });

  it('keeps relative indentation of deeper children', () => {
    expect(childRange(['- [ ] p', '  a', '    b'], 1).description).toBe(
      'a\n  b',
    );
  });

  it('dedents by the shallowest child', () => {
    expect(childRange(['- [ ] p', '    a', '  b'], 1).description).toBe(
      '  a\nb',
    );
  });

  it('works for a task in the middle of a file', () => {
    expect(childRange(['x', '- [ ] p', '  a', 'y'], 2)).toEqual({
      end: 3,
      description: 'a',
    });
  });

  it('treats a whitespace-only line shallower than the task as blank, not as a stop', () => {
    expect(childRange(['  - [ ] p', ' ', '      c'], 1)).toEqual({
      end: 3,
      description: 'c',
    });
  });

  it('has no children when only blank lines follow', () => {
    expect(childRange(['- [ ] p', '', ''], 1)).toEqual({
      end: 1,
      description: undefined,
    });
    expect(childRange(['- [ ] p', ''], 1).description).toBeUndefined();
  });

  it('ignores whitespace-only lines when choosing how much to dedent', () => {
    expect(
      childRange(['- [ ] p', '     a', ' ', '     b'], 1).description,
    ).toBe('a\n\nb');
  });

  it('drops a leading whitespace-only line from the description', () => {
    expect(childRange(['- [ ] p', '   ', '  a'], 1).description).toBe('a');
  });

  it('counts a tab as four columns of indentation', () => {
    expect(childRange(['- [ ] p', '\tchild'], 1)).toEqual({
      end: 2,
      description: 'child',
    });
    expect(childRange(['\t- [ ] p', '        x'], 1).description).toBe('x');
    expect(childRange(['\t- [ ] p', '    x'], 1).description).toBeUndefined();
    expect(childRange(['    - [ ] p', '\tx'], 1).description).toBeUndefined();
  });
});
