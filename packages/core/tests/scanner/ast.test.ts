import { describe, it, expect } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { MarkdownScanner } from '../../src/scanner/index.js';
import { updateTask } from '../../src/writer/index.js';

const scanner = new MarkdownScanner();
const scan = (content: string) => scanner.scanFile('test.md', content);

describe('Markdown structure: fenced code (D1)', () => {
  it('ignores tasks inside ``` fences', () => {
    const { tasks } = scan(
      ['- [ ] before', '```', '- [ ] in fence', '```', '- [ ] after'].join(
        '\n',
      ),
    );
    expect(tasks.map((t) => [t.line, t.text])).toEqual([
      [1, 'before'],
      [5, 'after'],
    ]);
  });

  it('ignores tasks inside ~~~ fences with an info string', () => {
    const { tasks } = scan(
      ['~~~md', '- [ ] in fence', '~~~', '- [ ] after'].join('\n'),
    );
    expect(tasks.map((t) => [t.line, t.text])).toEqual([[4, 'after']]);
  });

  it('handles a fence that opens on line 1', () => {
    const { tasks } = scan(['```', '- [ ] in fence', '```'].join('\n'));
    expect(tasks).toHaveLength(0);
  });

  it('does not close a ``` fence with ~~~ and treats an unclosed fence as open to EOF', () => {
    const { tasks } = scan(
      ['```', '~~~', '- [ ] still in fence', '- [ ] also'].join('\n'),
    );
    expect(tasks).toHaveLength(0);
  });

  it('emits no warnings for lines inside a fence', () => {
    const { warnings } = scan(
      ['```', '* [ ] bullet', '- [x ] malformed', '```'].join('\n'),
    );
    expect(warnings).toHaveLength(0);
  });
});

describe('Markdown structure: nesting (D2)', () => {
  const content = [
    '- [ ] Parent',
    '  - plain child line',
    '  - [ ] Child task',
    '    - deeper note',
    '- [ ] Sibling',
  ].join('\n');

  it('keeps every checkbox as a task with its physical line number', () => {
    const { tasks } = scan(content);
    expect(tasks.map((t) => [t.line, t.text])).toEqual([
      [1, 'Parent'],
      [3, 'Child task'],
      [5, 'Sibling'],
    ]);
  });

  it('links a child checkbox to its parent task', () => {
    const [parent, child, sibling] = scan(content).tasks;
    expect(child?.parent).toBe(parent?.id);
    expect(parent?.parent).toBeUndefined();
    expect(sibling?.parent).toBeUndefined();
  });

  it('collects indented child lines as the parent description', () => {
    const [parent, child, sibling] = scan(content).tasks;
    expect(parent?.description).toContain('plain child line');
    expect(parent?.description).toContain('Child task');
    expect(parent?.description).toContain('deeper note');
    expect(child?.description).toContain('deeper note');
    expect(child?.description).not.toContain('plain child line');
    expect(sibling?.description).toBeUndefined();
  });

  it('leaves the display text of the parent untouched by its children', () => {
    expect(scan(content).tasks[0]?.text).toBe('Parent');
  });

  it('links each level to its innermost parent', () => {
    const [a, b, c, d] = scan(
      ['- [ ] A', '  - [ ] B', '    - [ ] C', '- [ ] D'].join('\n'),
    ).tasks;
    expect(b?.parent).toBe(a?.id);
    expect(c?.parent).toBe(b?.id);
    expect(d).not.toHaveProperty('parent');
  });

  it('links a child that sits on the last line of the file', () => {
    const [a, b] = scan('- [ ] A\n  - [ ] B').tasks;
    expect(b?.parent).toBe(a?.id);
  });

  it('does not link a task that follows a blank line and a sibling at the same indent', () => {
    const [, b] = scan('- [ ] A\n\n- [ ] B').tasks;
    expect(b).not.toHaveProperty('parent');
  });

  it('sets neither key on a task with no relatives', () => {
    const [task] = scan('- [ ] Alone').tasks;
    expect(task).not.toHaveProperty('parent');
    expect(task).not.toHaveProperty('description');
  });

  it('uses the physical line number of each nested task', () => {
    const { tasks } = scan(
      ['intro', '- [ ] A', '  note', '  - [ ] B'].join('\n'),
    );
    expect(tasks.map((t) => [t.line, t.description])).toEqual([
      [2, 'note\n- [ ] B'],
      [4, undefined],
    ]);
  });
});

describe('Markdown structure: metadata only from plain text (D3, D4)', () => {
  it('keeps link syntax intact and extracts metadata from the remaining text', () => {
    const [task] = scan(
      '- [ ] Review [[abcd#h|Design Doc]] and [spec](a/b.md#x) !! @tj #writing #due/2026-11-01',
    ).tasks;
    expect(task?.text).toBe(
      'Review [[abcd#h|Design Doc]] and [spec](a/b.md#x)',
    );
    expect(task?.priority).toBe('high');
    expect(task?.assignee).toBe('tj');
    expect(task?.tags).toEqual(['writing']);
    expect(task?.dueDate).toBeDefined();
  });

  it('does not read a wiki-link heading as a tag', () => {
    const [task] = scan('- [ ] See [[abcd#open-questions]]').tasks;
    expect(task?.tags).toEqual([]);
    expect(task?.text).toBe('See [[abcd#open-questions]]');
  });

  it('does not read ! in link text as a priority', () => {
    const [task] = scan('- [ ] Fix [Urgent!! bug](abcd)').tasks;
    expect(task?.priority).toBeUndefined();
    expect(task?.text).toBe('Fix [Urgent!! bug](abcd)');
  });

  it('does not read the ! of an embed as a priority', () => {
    const [task] = scan('- [ ] ![[abcd]] review').tasks;
    expect(task?.priority).toBeUndefined();
    expect(task?.text).toBe('![[abcd]] review');
  });

  it('does not read a mailto destination as an assignee', () => {
    const [task] = scan('- [ ] [me](mailto:tj@intuit.com) reply').tasks;
    expect(task?.assignee).toBeUndefined();
    expect(task?.text).toBe('[me](mailto:tj@intuit.com) reply');
  });

  it('does not read a URL fragment as a tag', () => {
    const [task] = scan('- [ ] Read https://example.com/a#section now').tasks;
    expect(task?.tags).toEqual([]);
  });

  it('does not treat numeric references as tags and keeps them in the text (D4)', () => {
    const [task] = scan('- [ ] Merge PR #2920 and follow-up #2926 #q4').tasks;
    expect(task?.tags).toEqual(['q4']);
    expect(task?.text).toBe('Merge PR #2920 and follow-up #2926');
  });

  it('still extracts metadata that sits next to a link', () => {
    const [task] = scan('- [ ] [spec](a.md) @tj !!!').tasks;
    expect(task?.assignee).toBe('tj');
    expect(task?.priority).toBe('urgent');
  });
});

describe('Legacy scope preserved (D5)', () => {
  it('still returns tasks inside YAML frontmatter, with physical line numbers', () => {
    const { tasks } = scan(
      ['---', 'items:', '- [ ] in yaml', '---', '- [ ] real'].join('\n'),
    );
    expect(tasks.map((t) => t.line)).toEqual([3, 5]);
  });

  it('still returns a 4-space indented task after a blank line', () => {
    const { tasks } = scan(['Intro', '', '    - [ ] indented'].join('\n'));
    expect(tasks.map((t) => t.line)).toEqual([3]);
  });

  it('still returns a tab-indented task', () => {
    const { tasks } = scan(['- [ ] top', '\t- [ ] tabbed'].join('\n'));
    expect(tasks.map((t) => t.line)).toEqual([1, 2]);
  });

  it('does not return a blockquoted checkbox', () => {
    expect(scan('> - [ ] quoted').tasks).toHaveLength(0);
  });

  it('keeps * + and numbered checkboxes as non-tasks, with the unsupported-bullet warning for * and +', () => {
    const { tasks, warnings } = scan(
      ['* [ ] star', '+ [ ] plus', '1. [ ] numbered'].join('\n'),
    );
    expect(tasks).toHaveLength(0);
    expect(
      warnings
        .filter((w) => w.ruleId === 'unsupported-bullet')
        .map((w) => w.line),
    ).toEqual([1, 2]);
  });

  it('keeps the malformed-checkbox warning outside fences', () => {
    const { warnings } = scan('- [x ] malformed');
    expect(warnings.map((w) => w.ruleId)).toContain('malformed-checkbox');
  });

  it('does not leak a carriage return into text for CRLF files', () => {
    const { tasks } = scan('- [ ] one\r\n- [x] two\r\n');
    expect(tasks.map((t) => t.text)).toEqual(['one', 'two']);
  });
});

describe('Line-number stability with the writer (G6)', () => {
  it('updateTask edits exactly the line the scanner reported', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'md2do-g6-'));
    const file = path.join(dir, 'note.md');
    const original = [
      '---',
      'title: x',
      '---',
      '```',
      '- [ ] in fence',
      '```',
      '- [ ] Parent',
      '  - [ ] Child',
      '    - [ ] Grandchild',
      '- [ ] Last',
    ].join('\n');

    try {
      const { tasks } = scanner.scanFile(file, original);
      expect(tasks.map((t) => t.line)).toEqual([7, 8, 9, 10]);

      for (const task of tasks) {
        await fs.writeFile(file, original, 'utf-8');
        const result = await updateTask({
          file,
          line: task.line,
          updates: { completed: true },
        });
        expect(result.success).toBe(true);

        const before = original.split('\n');
        const after = (await fs.readFile(file, 'utf-8')).split('\n');
        expect(after).toHaveLength(before.length);
        const changed = after
          .map((l, i) => (l === before[i] ? -1 : i + 1))
          .filter((n) => n !== -1);
        expect(changed).toEqual([task.line]);
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
