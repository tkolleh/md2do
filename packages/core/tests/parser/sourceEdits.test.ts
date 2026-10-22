import { describe, it, expect } from 'vitest';
import {
  addSourceIfUnchanged,
  removeSourceIfPresent,
  withoutSource,
  withSource,
} from '../../src/parser/index.js';

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
