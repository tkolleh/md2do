import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const source = fs.readFileSync(
  path.join(__dirname, '../src/commands/todoist.ts'),
  'utf-8',
);

/** Everything between `updateTask({` and its matching `})`, per call */
const updateTaskCalls = (src: string): string[] =>
  Array.from(src.matchAll(/updateTask\(\{/g), (m) => {
    const start = m.index ?? 0;
    let depth = 0;
    for (let i = start + 'updateTask('.length; i < src.length; i++) {
      if (src[i] === '{') depth++;
      if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    return src.slice(start);
  });

describe('Todoist push and sync edit only the owned token', () => {
  const calls = updateTaskCalls(source);

  it('finds the three updateTask calls', () => {
    expect(calls).toHaveLength(3);
  });

  it('never rewrites the task text or the whole line', () => {
    for (const call of calls) {
      expect(call).not.toMatch(/\btext\s*:/);
      expect(call).not.toMatch(/replaceLine/);
    }
  });

  it('links a pushed task by appending its Todoist id to the scanned line', () => {
    expect(source).toMatch(
      /mapLine:\s*addSourceIfUnchanged\(\s*lineContent,\s*'todoist',\s*todoistTask\.id\s*\)/,
    );
  });

  it('detaches a task deleted in Todoist by removing only its Todoist id', () => {
    expect(source).toMatch(
      /mapLine:\s*removeSourceIfPresent\(\s*'todoist',\s*todoistId\s*\)/,
    );
  });

  it('hands the transforms to the writer directly, so it can pass them the protected spans', () => {
    const mapLines = calls.flatMap((c) => c.match(/mapLine:[^,\n]*/g) ?? []);
    expect(mapLines).toHaveLength(2);
    for (const mapLine of mapLines) {
      expect(mapLine).toMatch(
        /mapLine:\s*(addSourceIfUnchanged|removeSourceIfPresent)\(/,
      );
    }
  });

  it('keeps the completion pull as a plain checkbox update', () => {
    const completion = calls.filter((c) => /completed:/.test(c));
    expect(completion).toHaveLength(1);
    expect(completion[0]).not.toMatch(/mapLine/);
  });
});
