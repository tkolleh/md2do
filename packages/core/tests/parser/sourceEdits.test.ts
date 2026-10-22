import { describe, it, expect } from 'vitest';
import {
  addSourceIfUnchanged,
  isOwnedTokenEdit,
  removeSourceIfPresent,
  withoutSource,
  withSource,
} from '../../src/parser/index.js';
import {
  analyzeStructure,
  protectedSpansFor,
} from '../../src/scanner/structure.js';

/** Protected spans of one line, as the scanner and the writer compute them */
const spansOf = (content: string, lineNumber = 1) => {
  const lines = content.split('\n');
  return protectedSpansFor(
    analyzeStructure(content, lines),
    lineNumber,
    lines[lineNumber - 1] ?? '',
  );
};

const LOSSY =
  '- [ ] Review [[abcd#h|Design Doc]] and [spec](a/b.md#x) !! @tj #writing #due/2026-11-01';

describe('withSource', () => {
  it('appends the token and keeps every other byte of the line', () => {
    expect(withSource(LOSSY, 'todoist', '999')).toBe(`${LOSSY} {todoist:999}`);
  });

  it('appends after other sources', () => {
    expect(withSource('- [ ] a {teams:msg-789}', 'todoist', '5')).toBe(
      '- [ ] a {teams:msg-789} {todoist:5}',
    );
  });

  it('inserts before trailing whitespace instead of deleting it', () => {
    expect(withSource('- [ ] a  ', 'todoist', '5')).toBe(
      '- [ ] a {todoist:5}  ',
    );
    expect(withSource('- [ ] naïve 🚀\t', 'todoist', '1')).toBe(
      '- [ ] naïve 🚀 {todoist:1}\t',
    );
  });

  it('keeps a trailing carriage return last', () => {
    expect(withSource('- [ ] a\r', 'todoist', '5')).toBe(
      '- [ ] a {todoist:5}\r',
    );
    expect(withSource('- [ ] a  \r', 'todoist', '5')).toBe(
      '- [ ] a {todoist:5}  \r',
    );
  });

  it('never rewrites a token that is already there', () => {
    const line = '- [ ] a {todoist:5}';
    expect(withSource(line, 'todoist', '5')).toBe(line);
    expect(withSource(line, 'todoist', '6')).toBe(line);
    expect(withSource('- [ ] a [todoist:7]', 'todoist', '8')).toBe(
      '- [ ] a [todoist:7]',
    );
  });

  it('treats a different slug as absent', () => {
    expect(withSource('- [ ] a {teams:5}', 'todoist', '5')).toBe(
      '- [ ] a {teams:5} {todoist:5}',
    );
  });

  it('leaves the completion date alone', () => {
    expect(withSource('- [x] a {completed:2026-01-01}', 'todoist', '5')).toBe(
      '- [x] a {completed:2026-01-01} {todoist:5}',
    );
  });
});

describe('withoutSource', () => {
  it('removes the token and the space before it', () => {
    expect(withoutSource('- [ ] a {todoist:5}', 'todoist')).toBe('- [ ] a');
  });

  it('removes a token from the middle of the line', () => {
    expect(withoutSource('- [ ] a {todoist:5} !! @tj', 'todoist')).toBe(
      '- [ ] a !! @tj',
    );
  });

  it('removes the legacy bracket form, with or without a space', () => {
    expect(withoutSource('- [ ] a [todoist:5]', 'todoist')).toBe('- [ ] a');
    expect(withoutSource('- [ ] a [todoist: 5]', 'todoist')).toBe('- [ ] a');
  });

  it('keeps other sources', () => {
    expect(withoutSource('- [ ] a {teams:1} {todoist:5}', 'todoist')).toBe(
      '- [ ] a {teams:1}',
    );
    expect(withoutSource('- [ ] a {todoist:5} {teams:1}', 'todoist')).toBe(
      '- [ ] a {teams:1}',
    );
  });

  it('is a no-op when the token is absent', () => {
    expect(withoutSource('- [ ] a {teams:1}', 'todoist')).toBe(
      '- [ ] a {teams:1}',
    );
    expect(withoutSource(LOSSY, 'todoist')).toBe(LOSSY);
  });

  it('keeps a trailing carriage return', () => {
    expect(withoutSource('- [ ] a {todoist:5}\r', 'todoist')).toBe('- [ ] a\r');
  });

  it('keeps link fragments, priority, assignee, tags and due date', () => {
    expect(withoutSource(`${LOSSY} {todoist:999}`, 'todoist')).toBe(LOSSY);
  });

  it('removes a token that has no space before it', () => {
    expect(withoutSource('- [ ] {todoist:5}a', 'todoist')).toBe('- [ ] a');
  });
});

describe('token matching is exact', () => {
  it('treats regex characters in a slug or id literally', () => {
    expect(withSource('- [ ] x {axb:1}', 'a.b', '2')).toBe(
      '- [ ] x {axb:1} {a.b:2}',
    );
    expect(() =>
      removeSourceIfPresent('teams', 'a.c')('- [ ] x {teams:abc}'),
    ).toThrow(/changed since it was scanned/);
    expect(removeSourceIfPresent('teams', 'a.c')('- [ ] x {teams:a.c}')).toBe(
      '- [ ] x',
    );
  });

  it('only knows the legacy bracket form for todoist', () => {
    expect(withSource('- [ ] a [todoist:5]', 'teams', '9')).toBe(
      '- [ ] a [todoist:5] {teams:9}',
    );
    expect(withSource('- [ ] a [teams:5]', 'teams', '9')).toBe(
      '- [ ] a [teams:5] {teams:9}',
    );
    expect(withoutSource('- [ ] a [teams:5]', 'teams')).toBe(
      '- [ ] a [teams:5]',
    );
    expect(() =>
      removeSourceIfPresent('teams', '5')('- [ ] a [teams:5]'),
    ).toThrow(/changed since it was scanned/);
  });

  it('matches the token case-insensitively, like the scanner does for the legacy form', () => {
    expect(withoutSource('- [ ] a [TODOIST:5]', 'todoist')).toBe('- [ ] a');
    expect(withoutSource('- [ ] a {TODOIST:5}', 'todoist')).toBe('- [ ] a');
    expect(withSource('- [ ] a [Todoist:7]', 'todoist', '8')).toBe(
      '- [ ] a [Todoist:7]',
    );
  });

  it('removes only the token with the requested id', () => {
    expect(
      withoutSource('- [ ] a {todoist:1} {todoist:2}', 'todoist', '2'),
    ).toBe('- [ ] a {todoist:1}');
  });
});

describe('addSourceIfUnchanged', () => {
  it('appends the token when the line is exactly the one that was scanned', () => {
    expect(addSourceIfUnchanged(LOSSY, 'todoist', '999')(LOSSY)).toBe(
      `${LOSSY} {todoist:999}`,
    );
  });

  it('refuses when the line differs from the scanned one', () => {
    expect(() =>
      addSourceIfUnchanged(LOSSY, 'todoist', '999')('- [ ] other task'),
    ).toThrow(/changed since it was scanned/);
    expect(() =>
      addSourceIfUnchanged(LOSSY, 'todoist', '999')(`${LOSSY} `),
    ).toThrow(/changed since it was scanned/);
  });
});

describe('removeSourceIfPresent', () => {
  it('removes the token when the line still carries that id', () => {
    expect(
      removeSourceIfPresent('todoist', '5')('- [ ] a !! {todoist:5}'),
    ).toBe('- [ ] a !!');
  });

  it('removes the legacy bracket form of that id', () => {
    expect(removeSourceIfPresent('todoist', '5')('- [ ] a [todoist:5]')).toBe(
      '- [ ] a',
    );
  });

  it('refuses when the line has no token or a different id', () => {
    expect(() => removeSourceIfPresent('todoist', '5')('- [ ] a')).toThrow(
      /changed since it was scanned/,
    );
    expect(() =>
      removeSourceIfPresent('todoist', '5')('- [ ] a {todoist:6}'),
    ).toThrow(/changed since it was scanned/);
    expect(() =>
      removeSourceIfPresent('todoist', '5')('- [ ] a {teams:5}'),
    ).toThrow(/changed since it was scanned/);
  });
});

describe('withSource/withoutSource round trip (seeded)', () => {
  // mulberry32: small deterministic PRNG so a failure prints a reproducible seed
  const rng = (seed: number) => () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const FRAGMENTS = [
    '[[abcd#h|T]]',
    '[s](a.md#x)',
    '![[e]]',
    '!!',
    '!!!',
    '@tj',
    '#tag',
    '#due/2026-11-01',
    '{teams:m-1}',
    '{completed:2026-01-01}',
    '`code`',
    'naïve',
    '🚀',
    '#2920',
    'plain',
  ];
  const TAILS = ['', ' ', '  ', '\t', '\r', ' \r'];

  it.each([1, 2, 3, 4, 5])(
    'seed %i: removing what was added restores the line',
    (seed) => {
      const next = rng(seed);
      const pick = <T>(xs: readonly T[]): T =>
        xs[Math.floor(next() * xs.length)] as T;

      for (let i = 0; i < 200; i++) {
        const count = 1 + Math.floor(next() * 6);
        const text = Array.from({ length: count }, () => pick(FRAGMENTS)).join(
          ' ',
        );
        const line = `${pick(['- [ ] ', '- [x] ', '  - [ ] ', '\t- [ ] '])}${text}${pick(TAILS)}`;
        const added = withSource(line, 'todoist', '999');

        expect(
          added,
          `seed ${seed} iteration ${i}: ${JSON.stringify(line)}`,
        ).toContain('{todoist:999}');
        expect(
          withoutSource(added, 'todoist'),
          `seed ${seed} iteration ${i}: ${JSON.stringify(line)}`,
        ).toBe(line);
      }
    },
  );
});

describe('tokens inside links, wiki-links and embeds are not owned', () => {
  // [content, the same line with its protected token only]
  const PROTECTED: ReadonlyArray<readonly [string, string]> = [
    ['link destination', '- [ ] see [x](u/{todoist:5}) end'],
    ['link title', '- [ ] see [x](u "[todoist:5]") end'],
    ['image', '- [ ] see ![x](u/{todoist:5}) end'],
    ['wiki-link', '- [ ] see [[a{todoist:5}]] end'],
    ['embed', '- [ ] see ![[a{todoist:5}]] end'],
    ['reference link', '- [ ] see [x{todoist:5}][r] end\n\n[r]: u'],
  ];

  describe.each(PROTECTED)('in a %s', (_name, content) => {
    const line = content.split('\n')[0] ?? '';
    const spans = spansOf(content);
    // Reference links only parse with their definition, which sits after the task line
    const withReal = (token: string) =>
      `${line} ${token}${content.slice(line.length)}`;

    it('guards the fixture: the scanner protects a span around the token', () => {
      expect(spans.length).toBeGreaterThan(0);
    });

    it('withSource ignores it for the presence check and still appends', () => {
      expect(withSource(line, 'todoist', '9', spans)).toBe(
        `${line} {todoist:9}`,
      );
    });

    it('withSource without spans keeps today’s behaviour', () => {
      expect(withSource(line, 'todoist', '9')).toBe(line);
    });

    it('withoutSource leaves it alone', () => {
      expect(withoutSource(line, 'todoist', undefined, spans)).toBe(line);
    });

    it('withoutSource removes the real token after it, not the protected one', () => {
      const real = withReal('{todoist:5}');
      expect(
        withoutSource(real.split('\n')[0] ?? '', 'todoist', '5', spansOf(real)),
      ).toBe(line);
    });

    it('removeSourceIfPresent refuses when only the protected token carries the id', () => {
      expect(() => removeSourceIfPresent('todoist', '5')(line, spans)).toThrow(
        /changed since it was scanned/,
      );
    });

    it('removeSourceIfPresent removes the real token', () => {
      const real = withReal('{todoist:5}');
      expect(
        removeSourceIfPresent('todoist', '5')(
          real.split('\n')[0] ?? '',
          spansOf(real),
        ),
      ).toBe(line);
    });

    it('addSourceIfUnchanged appends past it', () => {
      expect(addSourceIfUnchanged(line, 'todoist', '9')(line, spans)).toBe(
        `${line} {todoist:9}`,
      );
    });

    it('the guard rejects removing it, and accepts it only without spans', () => {
      const after = line.replace(/ ?(\{todoist:5\}|\[todoist:5\])/, '');
      expect(after).not.toBe(line);
      expect(isOwnedTokenEdit(line, after, spans)).toBe(false);
      expect(isOwnedTokenEdit(line, after)).toBe(true);
    });
  });

  it('removes a legacy bracket token in a title only when it is outside', () => {
    const line = '- [ ] see [x](u "[todoist:5]") [todoist:5]';
    expect(withoutSource(line, 'todoist', '5', spansOf(line))).toBe(
      '- [ ] see [x](u "[todoist:5]")',
    );
  });

  it('treats a token that touches a span edge as outside it', () => {
    const line = '- [ ] [x](u){todoist:5}';
    expect(withoutSource(line, 'todoist', '5', spansOf(line))).toBe(
      '- [ ] [x](u)',
    );
    const before = '- [ ] a{todoist:5}[x](u)';
    expect(withoutSource(before, 'todoist', '5', spansOf(before))).toBe(
      '- [ ] a[x](u)',
    );
  });

  describe('isOwnedTokenEdit with spans', () => {
    const before = '- [ ] [x](u/) end';
    const spans = spansOf(before);

    it('rejects inserting a token inside a span', () => {
      const after = '- [ ] [x](u/{todoist:5}) end';
      expect(isOwnedTokenEdit(before, after, spans)).toBe(false);
      expect(isOwnedTokenEdit(before, after)).toBe(true);
    });

    it('rejects inserting a token with its separating space inside a span', () => {
      const after = '- [ ] [x](u/ {todoist:5}) end';
      expect(isOwnedTokenEdit(before, after, spans)).toBe(false);
    });

    it('accepts inserting right after a span', () => {
      expect(
        isOwnedTokenEdit(before, '- [ ] [x](u/) {todoist:5} end', spans),
      ).toBe(true);
    });

    it('accepts inserting right before a span', () => {
      const tight = '- [ ] a[x](u)';
      expect(
        isOwnedTokenEdit(tight, '- [ ] a{todoist:5}[x](u)', spansOf(tight)),
      ).toBe(true);
    });

    it('accepts removing a real token while a protected one is present', () => {
      const both = '- [ ] [x](u/{todoist:5}) {todoist:5}';
      expect(
        isOwnedTokenEdit(both, '- [ ] [x](u/{todoist:5})', spansOf(both)),
      ).toBe(true);
    });

    it('still rejects any other change', () => {
      expect(isOwnedTokenEdit(before, `${before}x`, spans)).toBe(false);
    });
  });
});

describe('span-aware round trip (seeded)', () => {
  const rng = (seed: number) => () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // Protected tokens reuse the id that gets linked, so ignoring spans fails fast
  const FRAGMENTS = [
    '[x](u/{todoist:999})',
    '[[a{todoist:999}]]',
    '![[b{todoist:999}]]',
    '![i](p/{todoist:999})',
    '[s](a.md#x)',
    '[[abcd#h|T]]',
    '!!',
    '@tj',
    '#tag',
    '{teams:m-1}',
    '🚀',
    'plain',
  ];
  const TAILS = ['', ' ', '  ', '\r', ' \r'];

  it.each([21, 22, 23, 24, 25])(
    'seed %i: unlinking what was linked restores the line',
    (seed) => {
      const next = rng(seed);
      const pick = <T>(xs: readonly T[]): T =>
        xs[Math.floor(next() * xs.length)] as T;

      for (let i = 0; i < 200; i++) {
        const text = Array.from({ length: 1 + Math.floor(next() * 5) }, () =>
          pick(FRAGMENTS),
        ).join(' ');
        const line = `${pick(['- [ ] ', '- [x] ', '  - [ ] '])}${text}${pick(TAILS)}`;
        const ctx = `seed ${seed} iteration ${i}: ${JSON.stringify(line)}`;

        const added = withSource(line, 'todoist', '999', spansOf(line));
        expect(added, ctx).not.toBe(line);
        expect(
          withoutSource(added, 'todoist', '999', spansOf(added)),
          ctx,
        ).toBe(line);
      }
    },
  );
});
