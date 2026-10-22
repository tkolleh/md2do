import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { addTask, updateTask, updateTasks } from '../../src/writer/index.js';
import { withSource, withoutSource } from '../../src/parser/index.js';

const TOKEN = ' {todoist:999}';
const CHECKBOX = /^\s*-\s+\[[ xX]\]\s/;

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'md2do-preserve-'));
  file = path.join(dir, 'note.md');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const read = () => fs.readFile(file, 'utf-8');
const write = (content: string) => fs.writeFile(file, content, 'utf-8');

/** 1-indexed numbers of checkbox lines outside fenced code, the only lines the scanner reports */
const taskLines = (content: string): number[] => {
  let inFence = false;
  return content.split('\n').flatMap((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return [];
    }
    return !inFence && CHECKBOX.test(line) ? [i + 1] : [];
  });
};

/** Lines that differ between two versions, with the same line count required */
const changedLines = (before: string, after: string): number[] => {
  const a = before.split('\n');
  const b = after.split('\n');
  expect(b).toHaveLength(a.length);
  return a.flatMap((line, i) => (line === b[i] ? [] : [i + 1]));
};

const normaliseMark = (line: string) => line.replace(/\[[xX ]\]/, '[?]');

const LINK_LINE =
  '- [ ] Review [[abcd#h|Design Doc]] and [spec](a/b.md#x) !! @tj #writing #due/2026-11-01';

const FIXTURES: ReadonlyArray<readonly [string, string]> = [
  ['links, priority, assignee, tag, due date', `${LINK_LINE}\n- [ ] second\n`],
  [
    'nested children and nested checkboxes',
    '- [ ] Parent\n  - plain child\n  - [ ] Child\n    - [x] Grandchild\n- [ ] Next\n',
  ],
  [
    'fenced code with task-like lines',
    '- [ ] before\n```\n- [ ] in fence\n```\n- [ ] after\n',
  ],
  ['CRLF line endings', '- [ ] one\r\n- [x] two\r\n- [ ] three\r\n'],
  ['no trailing newline', '- [ ] one\n- [ ] two'],
  ['unicode, emoji and tabs', '- [ ] naïve 🚀\t#tag\n\t- [ ] tabbed 日本語\n'],
  ['YAML frontmatter', '---\ntitle: x\n---\n- [ ] after frontmatter\n'],
  ['task on the first and last line', '- [ ] first\ntext\n- [ ] last'],
  ['duplicate-looking lines', '- [ ] same\n- [ ] same\n- [ ] same\n'],
  ['existing sources', '- [ ] a {teams:msg-789}\n- [ ] b {todoist:5}\n'],
  ['empty lines and trailing spaces', '- [ ] a  \n\n- [ ] b \n\n'],
];

describe('every write keeps all other content (G1)', () => {
  describe.each(FIXTURES)('%s', (_name, content) => {
    it('toggling completion changes only the checkbox mark', async () => {
      for (const line of taskLines(content)) {
        for (const completed of [true, false]) {
          await write(content);
          const result = await updateTask({
            file,
            line,
            updates: { completed },
          });
          expect(result.success).toBe(true);

          const after = await read();
          const changed = changedLines(content, after);
          expect(changed.length).toBeLessThanOrEqual(1);
          if (changed[0] !== undefined) {
            expect(changed).toEqual([line]);
            expect(normaliseMark(after.split('\n')[line - 1] ?? '')).toBe(
              normaliseMark(content.split('\n')[line - 1] ?? ''),
            );
          }
        }
      }
    });

    it('mapLine adds only the owned token', async () => {
      for (const line of taskLines(content)) {
        const before = content.split('\n')[line - 1] ?? '';
        if (/\{todoist:\d+\}/.test(before)) continue;

        await write(content);
        const result = await updateTask({
          file,
          line,
          updates: { mapLine: (l) => withSource(l, 'todoist', '999') },
        });
        expect(result.success).toBe(true);

        const after = await read();
        expect(changedLines(content, after)).toEqual([line]);
        const afterLine = after.split('\n')[line - 1] ?? '';
        expect(afterLine.replace(TOKEN, '')).toBe(before);
        expect(afterLine).toContain('{todoist:999}');
      }
    });

    it('mapLine removes only the owned token, restoring the original bytes', async () => {
      for (const line of taskLines(content)) {
        if (/\{todoist:\d+\}/.test(content.split('\n')[line - 1] ?? '')) {
          continue;
        }
        await write(content);
        await updateTask({
          file,
          line,
          updates: { mapLine: (l) => withSource(l, 'todoist', '999') },
        });
        expect(await read()).not.toBe(content);
        const result = await updateTask({
          file,
          line,
          updates: { mapLine: (l) => withoutSource(l, 'todoist') },
        });
        expect(result.success).toBe(true);
        expect(await read()).toBe(content);
      }
    });

    it('the batch writer keeps other content too', async () => {
      const lines = taskLines(content);
      await write(content);
      const result = await updateTasks(
        file,
        lines.map((line) => ({
          line,
          updates: { mapLine: (l: string) => withSource(l, 'todoist', '999') },
        })),
      );
      const after = await read();
      expect(result.errors).toEqual([]);
      expect(changedLines(content, after)).toEqual(
        lines.filter((line) => {
          const before = content.split('\n')[line - 1] ?? '';
          return !/\{todoist:\d+\}/.test(before);
        }),
      );
      expect(after.endsWith('\n')).toBe(content.endsWith('\n'));
    });
  });
});

describe('the completion toggle only touches the line-start checkbox (R1)', () => {
  it.each([
    ['- [ ] see - [x] foo', false, '- [ ] see - [x] foo'],
    ['- [ ] see - [x] foo', true, '- [x] see - [x] foo'],
    ['- [x] a - [x] b', false, '- [ ] a - [x] b'],
    ['- [x] a - [ ] b', true, '- [x] a - [ ] b'],
    ['-  [ ] spaced', true, '-  [x] spaced'],
    ['\t- [X] tabbed', false, '\t- [ ] tabbed'],
    ['  - [ ] indented - [ ] twice', true, '  - [x] indented - [ ] twice'],
  ])('%j with completed=%s becomes %j', async (before, completed, expected) => {
    await write(`${before}\nkeep`);
    const result = await updateTask({
      file,
      line: 1,
      updates: { completed },
    });
    expect(result.success).toBe(true);
    expect(await read()).toBe(`${expected}\nkeep`);
  });

  it('applies the same rule in the batch writer', async () => {
    await write('- [ ] see - [x] foo\n-  [ ] spaced\n- [x] a - [x] b');
    await updateTasks(file, [
      { line: 1, updates: { completed: true } },
      { line: 2, updates: { completed: true } },
      { line: 3, updates: { completed: false } },
    ]);
    expect(await read()).toBe(
      '- [x] see - [x] foo\n-  [x] spaced\n- [ ] a - [x] b',
    );
  });
});

describe('the completion toggle keeps what is already right', () => {
  it('leaves an upper-case X untouched when completing', async () => {
    await write('- [X] a');
    await updateTask({ file, line: 1, updates: { completed: true } });
    expect(await read()).toBe('- [X] a');
  });

  it('leaves an unchecked box untouched when un-completing', async () => {
    await write('- [ ] a');
    await updateTask({ file, line: 1, updates: { completed: false } });
    expect(await read()).toBe('- [ ] a');
  });
});

describe('the text rewrite keeps the checkbox prefix', () => {
  it.each([
    ['  - [x] Old', 'New @a', '  - [x] New @a'],
    ['-  [ ] spaced', 'N', '-  [ ] N'],
    ['- [ ]   wide', 'N', '- [ ]   N'],
    ['\t- [X] tabbed', 'N', '\t- [X] N'],
  ])('%j with text %j becomes %j', async (before, text, expected) => {
    await write(`${before}\nkeep`);
    const result = await updateTask({ file, line: 1, updates: { text } });
    expect(result.success).toBe(true);
    expect(await read()).toBe(`${expected}\nkeep`);
  });

  it('applies the completion change and the new text together', async () => {
    await write('- [ ] Old');
    await updateTask({
      file,
      line: 1,
      updates: { completed: true, text: 'N' },
    });
    expect(await read()).toBe('- [x] N');
  });

  it('works in the batch writer', async () => {
    await write('- [ ] a\n  - [x] b');
    await updateTasks(file, [
      { line: 2, updates: { text: 'B' } },
      { line: 1, updates: { text: 'A', completed: true } },
    ]);
    expect(await read()).toBe('- [x] A\n  - [x] B');
  });

  it('replaces a whole line only when asked to', async () => {
    await write('- [ ] a\n- [ ] b');
    await updateTask({ file, line: 2, updates: { replaceLine: '- [ ] z' } });
    expect(await read()).toBe('- [ ] a\n- [ ] z');
  });

  it('processes batch updates in line order and reports bad line numbers', async () => {
    await write('- [ ] a\n- [ ] b\nplain');
    const result = await updateTasks(file, [
      { line: 3, updates: { completed: true } },
      { line: 0, updates: { completed: true } },
      { line: 4, updates: { completed: true } },
      { line: 2, updates: { completed: true } },
    ]);
    expect(result.updatedCount).toBe(1);
    expect(result.errors.map((e) => e.line).sort()).toEqual([0, 3, 4]);
    expect(await read()).toBe('- [ ] a\n- [x] b\nplain');
  });
});

describe('mapLine (R4)', () => {
  it('hands the writer the exact current line, including a trailing carriage return', async () => {
    await write('- [ ] a\r\n- [ ] b\r\n');
    const seen: string[] = [];
    await updateTask({
      file,
      line: 2,
      updates: {
        mapLine: (l) => {
          seen.push(l);
          return l;
        },
      },
    });
    expect(seen).toEqual(['- [ ] b\r']);
  });

  it('returns the re-parsed task, including the new source', async () => {
    await write('- [ ] a !!');
    const result = await updateTask({
      file,
      line: 1,
      updates: { mapLine: (l) => withSource(l, 'todoist', '999') },
    });
    expect(result.success).toBe(true);
    expect(result.task?.sources).toEqual({ todoist: '999' });
    expect(result.task?.priority).toBe('high');
  });

  it('applies the completion toggle first, then mapLine', async () => {
    await write('- [ ] a');
    await updateTask({
      file,
      line: 1,
      updates: {
        completed: true,
        mapLine: (l) => withSource(l, 'todoist', '1'),
      },
    });
    expect(await read()).toBe('- [x] a {todoist:1}');
  });

  it.each([
    ['deletes a character', (l: string) => l.slice(0, -1)],
    ['appends plain text', (l: string) => `${l} junk`],
    ['replaces the line', () => '- [ ] something else'],
    ['strips the metadata', (l: string) => l.replace(/ !!.*$/, '')],
    [
      'rewrites a token id',
      (l: string) => withSource(withoutSource(l, 'todoist'), 'todoist', '2'),
    ],
    ['inserts a non-token brace', (l: string) => `${l} {not a token}`],
    ['inserts a completion date', (l: string) => `${l} {completed:2026-01-01}`],
  ])(
    'rejects a transform that %s, leaving the file untouched',
    async (_n, fn) => {
      const content = '- [ ] a !! @tj {todoist:1}\n- [ ] b';
      await write(content);
      const result = await updateTask({
        file,
        line: 1,
        updates: { mapLine: fn },
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/owned token/);
      expect(await read()).toBe(content);
    },
  );

  it('accepts removing a token that has no space before it', async () => {
    await write('- [ ] {todoist:5}a');
    const result = await updateTask({
      file,
      line: 1,
      updates: { mapLine: (l) => withoutSource(l, 'todoist') },
    });
    expect(result.success).toBe(true);
    expect(await read()).toBe('- [ ] a');
  });

  it('rejects removing a token together with a non-space character before it', async () => {
    await write('- [ ] ab{todoist:5}');
    const result = await updateTask({
      file,
      line: 1,
      updates: { mapLine: () => '- [ ] a' },
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/owned token/);
    expect(await read()).toBe('- [ ] ab{todoist:5}');
  });

  it('accepts inserting and removing a source token of another slug', async () => {
    await write('- [ ] a');
    expect(
      (
        await updateTask({
          file,
          line: 1,
          updates: { mapLine: (l) => withSource(l, 'teams', 'm-1') },
        })
      ).success,
    ).toBe(true);
    expect(await read()).toBe('- [ ] a {teams:m-1}');
    expect(
      (
        await updateTask({
          file,
          line: 1,
          updates: { mapLine: (l) => withoutSource(l, 'teams') },
        })
      ).success,
    ).toBe(true);
    expect(await read()).toBe('- [ ] a');
  });

  it('reports a throwing transform and leaves the file untouched', async () => {
    await write('- [ ] a');
    const result = await updateTask({
      file,
      line: 1,
      updates: {
        mapLine: () => {
          throw new Error('Line changed since it was scanned');
        },
      },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('changed since it was scanned');
    expect(await read()).toBe('- [ ] a');
  });

  it('refuses to run on a line that is not a task', async () => {
    await write('plain text');
    const result = await updateTask({
      file,
      line: 1,
      updates: { mapLine: (l) => `${l} {todoist:1}` },
    });
    expect(result.success).toBe(false);
    expect(await read()).toBe('plain text');
  });

  it.each([
    ['text', { text: 'new' }],
    ['replaceLine', { replaceLine: '- [ ] new' }],
  ])('cannot be combined with %s', async (_name, other) => {
    await write('- [ ] a');
    const result = await updateTask({
      file,
      line: 1,
      updates: { mapLine: (l) => l, ...other },
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/mapLine/);
    expect(await read()).toBe('- [ ] a');
  });

  it('in a batch, writes the good lines and reports the refused one', async () => {
    await write('- [ ] a\n- [ ] b\n- [ ] c');
    const result = await updateTasks(file, [
      { line: 1, updates: { mapLine: (l) => withSource(l, 'todoist', '1') } },
      { line: 2, updates: { mapLine: (l) => l.slice(0, -1) } },
      { line: 3, updates: { mapLine: (l) => withSource(l, 'todoist', '3') } },
    ]);
    expect(result.success).toBe(false);
    expect(result.updatedCount).toBe(2);
    expect(result.errors.map((e) => e.line)).toEqual([2]);
    expect(await read()).toBe(
      '- [ ] a {todoist:1}\n- [ ] b\n- [ ] c {todoist:3}',
    );
  });

  it('in a batch, rejects mapLine combined with text', async () => {
    await write('- [ ] a');
    const result = await updateTasks(file, [
      { line: 1, updates: { mapLine: (l) => l, text: 'x' } },
    ]);
    expect(result.success).toBe(false);
    expect(result.errors[0]?.error).toMatch(/mapLine/);
    expect(await read()).toBe('- [ ] a');
  });
});

describe('Todoist link and unlink on a real note (G2)', () => {
  it('keeps priority, assignee, tags, due date and link fragments when linking', async () => {
    const content = `intro\n${LINK_LINE}\noutro\n`;
    await write(content);
    const result = await updateTask({
      file,
      line: 2,
      updates: { mapLine: (l) => withSource(l, 'todoist', '999') },
    });
    expect(result.success).toBe(true);
    expect(await read()).toBe(`intro\n${LINK_LINE} {todoist:999}\noutro\n`);
  });

  it('removes only the token when the task was deleted in Todoist', async () => {
    const content = `${LINK_LINE} {todoist:999} {teams:m-1}\n  - [ ] child\n`;
    await write(content);
    const result = await updateTask({
      file,
      line: 1,
      updates: { mapLine: (l) => withoutSource(l, 'todoist') },
    });
    expect(result.success).toBe(true);
    expect(await read()).toBe(`${LINK_LINE} {teams:m-1}\n  - [ ] child\n`);
  });
});

describe('addTask keeps the final newline state (R5)', () => {
  it.each([
    ['a file that ends with a newline', '- [ ] a\n'],
    ['a file that ends with a newline after text', 'intro\n\n- [ ] a\n'],
    ['a file without a trailing newline', '- [ ] a'],
    ['an empty file', ''],
  ])('appending to %s', async (_n, content) => {
    await write(content);
    const result = await addTask(file, 'new');
    expect(result.success).toBe(true);

    const after = await read();
    expect(after.startsWith(content.replace(/\n$/, ''))).toBe(true);
    expect(after).toContain('- [ ] new');
    if (content !== '') {
      expect(after.endsWith('\n')).toBe(content.endsWith('\n'));
    }
  });

  it.each([
    ['- [ ] a\n', '- [ ] a\n- [ ] new\n', 2],
    ['intro\n\n- [ ] a\n', 'intro\n\n- [ ] a\n- [ ] new\n', 4],
    ['- [ ] a', '- [ ] a\n\n- [ ] new', 3],
    ['', '- [ ] new', 1],
  ])(
    'appending to %j gives %j with the task on line %i',
    async (content, expected, line) => {
      await write(content);
      const result = await addTask(file, 'new');
      expect(await read()).toBe(expected);
      expect(result.task?.line).toBe(line);
      expect(result.task?.text).toBe('new');
    },
  );

  it('creates a missing file holding just the task', async () => {
    const created = path.join(dir, 'created.md');
    await addTask(created, 'new');
    expect(await fs.readFile(created, 'utf-8')).toBe('- [ ] new');
  });

  it.each([
    [1, '- [ ] b\n', '- [ ] new\n- [ ] b\n'],
    [2, '- [ ] b\n', '- [ ] b\n- [ ] new\n'],
    [3, '- [ ] b\n', '- [ ] b\n\n- [ ] new'],
  ])('inserting at line %i of %j', async (line, content, expected) => {
    await write(content);
    const result = await addTask(file, 'new', { line });
    expect(result.success).toBe(true);
    expect(await read()).toBe(expected);
    expect(result.task?.line).toBe(line);
  });

  it.each([0, -1, 4])(
    'rejects inserting at line %i of a two-line file',
    async (line) => {
      await write('- [ ] b\n');
      const result = await addTask(file, 'new', { line });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid line number');
      expect(await read()).toBe('- [ ] b\n');
    },
  );

  it('keeps existing CRLF lines byte-identical', async () => {
    const content = '- [ ] a\r\n- [x] b\r\n';
    await write(content);
    await addTask(file, 'new');
    expect((await read()).startsWith(content)).toBe(true);
  });

  it('inserting at a line keeps the other lines identical', async () => {
    await write('- [ ] a\n- [ ] c\n');
    await addTask(file, 'b', { line: 2 });
    expect(await read()).toBe('- [ ] a\n- [ ] b\n- [ ] c\n');
  });
});

describe('randomised writes keep all other content (G3)', () => {
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
    '!![x]',
    '!!',
    '@tj',
    '#tag',
    '#due/2026-11-01',
    '- [x] inner',
    '{teams:m-1}',
    '🚀',
    'plain',
  ];

  it.each([11, 12, 13])('seed %i', async (seed) => {
    const next = rng(seed);
    const pick = <T>(xs: readonly T[]): T =>
      xs[Math.floor(next() * xs.length)] as T;
    const eol = pick(['\n', '\r\n']);

    const lines = Array.from({ length: 12 }, () =>
      next() < 0.7
        ? `${pick(['- [ ] ', '- [x] ', '  - [ ] ', '\t- [X] ', '-  [ ] '])}${Array.from(
            { length: 1 + Math.floor(next() * 5) },
            () => pick(FRAGMENTS),
          ).join(' ')}${pick(['', ' ', '  '])}`
        : pick(['', 'text', '  indented', '```', '> quote']),
    );
    const content = lines.join(eol) + pick(['', eol]);
    const targets = taskLines(content.replace(/\r\n/g, '\n'));

    for (const line of targets) {
      const ctx = `seed ${seed} line ${line}: ${JSON.stringify(content.split('\n')[line - 1])}`;
      await write(content);
      await updateTask({ file, line, updates: { completed: true } });
      const toggled = await read();
      expect(changedLines(content, toggled).length, ctx).toBeLessThanOrEqual(1);
      expect(toggled.length, ctx).toBe(content.length);

      await write(content);
      await updateTask({
        file,
        line,
        updates: { mapLine: (l) => withSource(l, 'todoist', '999') },
      });
      const linked = await read();
      expect(changedLines(content, linked), ctx).toEqual([line]);
      await updateTask({
        file,
        line,
        updates: { mapLine: (l) => withoutSource(l, 'todoist') },
      });
      expect(await read(), ctx).toBe(content);
    }
  });
});
