import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Nodes } from 'mdast';
import type { Span } from '../parser/index.js';

/**
 * What the Markdown AST says about a file, keyed by 1-indexed line number.
 * The scanner still decides what a task is; this only says which lines are
 * fenced code and which character ranges are links.
 */
export interface Structure {
  fencedLines: ReadonlySet<number>;
  linkSpans: ReadonlyMap<number, ReadonlyArray<Span>>;
}

const LINK_NODES: ReadonlySet<string> = new Set([
  'link',
  'image',
  'linkReference',
  'imageReference',
]);

const FENCE_CHARS = '`~';

// [[target]], [[target#heading|label]] and the embed form ![[target]]
const WIKI_LINK = /!?\[\[[^[\]\n]+\]\]/g;

const processor = unified().use(remarkParse).use(remarkGfm);

const lineStartOffsets = (lines: ReadonlyArray<string>): number[] =>
  lines.reduce<number[]>(
    (acc, line, i) => [...acc, (acc[i] ?? 0) + line.length + 1],
    [0],
  );

const rangeOf = (from: number, to: number): number[] =>
  Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);

const walk = (node: Nodes): Nodes[] => [
  node,
  // Stryker disable next-line ArrayDeclaration: a stray non-node element is ignored by every type filter below
  ...('children' in node ? node.children.flatMap(walk) : []),
];

/**
 * Merge overlapping or touching spans into a sorted, disjoint list
 */
export function mergeSpans(spans: ReadonlyArray<Span>): Span[] {
  return [...spans]
    .sort((a, b) => a[0] - b[0])
    .reduce<Span[]>((acc, span) => {
      const last = acc[acc.length - 1];
      return last && span[0] <= last[1]
        ? [...acc.slice(0, -1), [last[0], Math.max(last[1], span[1])]]
        : [...acc, span];
    }, []);
}

/**
 * Wiki-link and embed ranges in a single line (not part of Markdown proper,
 * so the AST reports them as plain text)
 */
export function wikiLinkSpans(line: string): Span[] {
  return Array.from(
    line.matchAll(WIKI_LINK),
    (m): Span => [m.index, m.index + m[0].length],
  );
}

/**
 * Parse `content` and collect fenced-code lines and link ranges.
 * `lines` must be `content.split('\n')`, so line offsets match the AST's.
 */
export function analyzeStructure(
  content: string,
  lines: ReadonlyArray<string>,
): Structure {
  const nodes = walk(processor.parse(content));
  const starts = lineStartOffsets(lines);

  const fencedLines = new Set(
    nodes.flatMap((node) => {
      const pos = node.position;
      // A code node is fenced when it starts at a fence marker; indented code starts at whitespace
      const isFence =
        node.type === 'code' &&
        // Stryker disable next-line ConditionalExpression,OptionalChaining: remark gives every parsed node a position; the check only narrows the type
        pos?.start.offset !== undefined &&
        FENCE_CHARS.includes(content.charAt(pos.start.offset));
      return isFence && pos ? rangeOf(pos.start.line, pos.end.line) : [];
    }),
  );

  const perLine = nodes
    .filter((node) => LINK_NODES.has(node.type))
    .flatMap((node) => {
      const pos = node.position;
      // Stryker disable all: remark gives every parsed node a position; the guard only narrows the type
      if (pos?.start.offset === undefined || pos.end.offset === undefined) {
        return [];
      }
      // Stryker restore all
      const { start, end } = pos;
      return rangeOf(start.line, end.line).map((line): [number, Span] => {
        const lineStart = starts[line - 1] ?? 0;
        // Stryker disable next-line OptionalChaining: link lines always exist in `lines`; the fallback only satisfies noUncheckedIndexedAccess
        const lineLength = lines[line - 1]?.length ?? 0;
        return [
          line,
          [
            line === start.line ? start.offset! - lineStart : 0,
            line === end.line ? end.offset! - lineStart : lineLength,
          ],
        ];
      });
    });

  const linkSpans = new Map<number, Span[]>();
  for (const [line, span] of perLine) {
    linkSpans.set(line, [...(linkSpans.get(line) ?? []), span]);
  }

  return { fencedLines, linkSpans };
}

/**
 * Protected ranges for one line: AST links plus wiki-links
 */
export function protectedSpansFor(
  structure: Structure,
  lineNumber: number,
  line: string,
): Span[] {
  return mergeSpans([
    ...(structure.linkSpans.get(lineNumber) ?? []),
    ...wikiLinkSpans(line),
  ]);
}

const leadingOf = (line: string): string =>
  line.slice(0, line.length - line.trimStart().length);

const indentOf = (line: string): number =>
  [...leadingOf(line)].reduce((width, ch) => width + (ch === '\t' ? 4 : 1), 0);

/**
 * Nesting: a task owns the following lines that are blank or indented deeper
 * than it, up to the first non-blank line at its own indent or shallower.
 * `end` is the last owned line; `description` is those lines, dedented.
 */
export function childRange(
  lines: ReadonlyArray<string>,
  taskLine: number,
): { end: number; description: string | undefined } {
  // Stryker disable next-line all: taskLine always indexes a real line; '' is only a type fallback
  const taskIndent = indentOf(lines[taskLine - 1] ?? '');
  const rest = lines.slice(taskLine);
  const stop = rest.findIndex(
    (line) => line.trim() !== '' && indentOf(line) <= taskIndent,
  );
  const owned = stop === -1 ? rest : rest.slice(0, stop);
  const lastNonBlank = owned.reduce(
    (last, line, i) => (line.trim() === '' ? last : i),
    -1,
  );
  const children = owned.slice(0, lastNonBlank + 1);

  if (children.length === 0) return { end: taskLine, description: undefined };

  const strip = Math.min(
    ...children.filter((l) => l.trim() !== '').map((l) => leadingOf(l).length),
  );
  const description = children
    .slice(children.findIndex((l) => l.trim() !== ''))
    .map((l) => (l.trim() === '' ? '' : l.slice(strip)))
    .join('\n');

  return { end: taskLine + children.length, description };
}
