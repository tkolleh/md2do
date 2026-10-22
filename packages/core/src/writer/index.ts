import * as fs from 'fs/promises';
import { TASK_CHECKBOX } from '../parser/patterns.js';
import { isOwnedTokenEdit, parseTask } from '../parser/index.js';
import type { Span } from '../parser/index.js';
import { analyzeStructure, protectedSpansFor } from '../scanner/structure.js';
import type { Task } from '../types/index.js';

export interface UpdateTaskOptions {
  /**
   * Path to the markdown file
   */
  file: string;

  /**
   * Line number (1-indexed) of the task to update
   */
  line: number;

  /**
   * Updates to apply to the task
   */
  updates: {
    /**
     * Mark task as completed or incomplete
     */
    completed?: boolean;

    /**
     * Update the task text. Rewrites everything after the checkbox, so any
     * metadata not in the new text is lost: only for explicit user rewrites.
     */
    text?: string;

    /**
     * Replace the entire line. Destructive, like `text`.
     */
    replaceLine?: string;

    /**
     * Transform the line (after any `completed` change). The result may differ
     * from the input only by one owned {slug:id} token added or removed;
     * anything else, or a thrown error, rejects the edit and writes nothing.
     * `protectedSpans` are the ranges of the line (links, images, wiki-links)
     * that the scanner treats as opaque; tokens inside them are not owned and
     * the edit is rejected if it adds or removes one.
     * Cannot be combined with `text` or `replaceLine`.
     */
    mapLine?: (line: string, protectedSpans: ReadonlyArray<Span>) => string;
  };
}

type LineUpdates = UpdateTaskOptions['updates'];

// The same spans the scanner masks, so the writer and the scanner agree on what is a token.
// Taken from the lines as they are now, so an earlier edit in a batch cannot leave them stale.
const spansFor = (
  lines: ReadonlyArray<string>,
  lineNumber: number,
): ReadonlyArray<Span> =>
  protectedSpansFor(
    analyzeStructure(lines.join('\n'), lines),
    lineNumber,
    // Stryker disable next-line StringLiteral: the target line was validated to exist, so the fallback only satisfies noUncheckedIndexedAccess
    lines[lineNumber - 1] ?? '',
  );

// Stryker disable next-line Regex: only validated task lines reach here, and they start with the checkbox, so the ^ anchor is a redundant safeguard
const CHECKBOX_MARK = /^(\s*-\s+\[)([ xX])(\])/;

function setCompleted(line: string, completed: boolean): string {
  return line.replace(
    CHECKBOX_MARK,
    (whole: string, open: string, mark: string, close: string) =>
      (mark.toLowerCase() === 'x') === completed
        ? whole
        : `${open}${completed ? 'x' : ' '}${close}`,
  );
}

function applyUpdates(
  originalLine: string,
  updates: LineUpdates,
  protectedSpans: ReadonlyArray<Span>,
): { line: string } | { error: string } {
  if (
    updates.mapLine &&
    (updates.text !== undefined || updates.replaceLine !== undefined)
  ) {
    return { error: 'mapLine cannot be combined with text or replaceLine' };
  }

  if (updates.replaceLine !== undefined) {
    return { line: updates.replaceLine };
  }

  const toggled =
    updates.completed === undefined
      ? originalLine
      : setCompleted(originalLine, updates.completed);

  if (updates.mapLine) {
    try {
      // The toggle keeps the line length, so spans from the original line still apply
      const mapped = updates.mapLine(toggled, protectedSpans);
      return isOwnedTokenEdit(toggled, mapped, protectedSpans)
        ? { line: mapped }
        : { error: 'mapLine may only add or remove an owned token' };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  if (updates.text !== undefined) {
    // Replace task text while preserving checkbox
    // Stryker disable all: callers validate the line with TASK_CHECKBOX first, so the prefix always exists
    const prefix = TASK_CHECKBOX.exec(toggled)?.[0];
    return { line: prefix === undefined ? toggled : prefix + updates.text };
    // Stryker restore all
  }

  return { line: toggled };
}

export interface WriteTaskResult {
  /**
   * Whether the task was successfully updated
   */
  success: boolean;

  /**
   * The updated task (after changes)
   */
  task?: Task;

  /**
   * Error message if update failed
   */
  error?: string;
}

/**
 * Update a task in a markdown file
 * This performs an atomic write using a temporary file
 */
export async function updateTask(
  options: UpdateTaskOptions,
): Promise<WriteTaskResult> {
  const { file, line, updates } = options;

  try {
    // Read the file
    const content = await fs.readFile(file, 'utf-8');
    const lines = content.split('\n');

    // Validate line number
    if (line < 1 || line > lines.length) {
      return {
        success: false,
        error: `Invalid line number ${line}. File has ${lines.length} lines.`,
      };
    }

    // Get the target line (convert from 1-indexed to 0-indexed)
    const lineIndex = line - 1;
    const originalLine = lines[lineIndex];

    // Validate that it's a task
    if (!originalLine || !TASK_CHECKBOX.test(originalLine)) {
      return {
        success: false,
        error: `Line ${line} is not a task: ${originalLine}`,
      };
    }

    // Apply updates
    const applied = applyUpdates(
      originalLine,
      updates,
      updates.mapLine ? spansFor(lines, line) : [],
    );
    if ('error' in applied) {
      return { success: false, error: applied.error };
    }
    const updatedLine = applied.line;

    // Update the line in the array
    lines[lineIndex] = updatedLine;

    // Write to temporary file first (atomic write)
    const tempFile = `${file}.md2do.tmp`;
    const newContent = lines.join('\n');

    await fs.writeFile(tempFile, newContent, 'utf-8');

    // Rename temp file to original (atomic on most filesystems)
    await fs.rename(tempFile, file);

    // Parse the updated task
    const parseResult = parseTask(updatedLine, line, file, {});

    const result: WriteTaskResult = {
      success: true,
    };

    if (parseResult.task) {
      result.task = parseResult.task;
    }

    return result;
  } catch (error) {
    return {
      success: false,
      error: `Failed to update task: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Batch update multiple tasks in a file
 * More efficient than calling updateTask multiple times
 */
export async function updateTasks(
  file: string,
  updates: Array<{
    line: number;
    updates: UpdateTaskOptions['updates'];
  }>,
): Promise<{
  success: boolean;
  updatedCount: number;
  errors: Array<{ line: number; error: string }>;
}> {
  try {
    // Read the file once
    const content = await fs.readFile(file, 'utf-8');
    const lines = content.split('\n');

    const errors: Array<{ line: number; error: string }> = [];
    let updatedCount = 0;

    // Sort updates by line number to process in order
    const sortedUpdates = [...updates].sort((a, b) => a.line - b.line);

    // Apply all updates
    for (const update of sortedUpdates) {
      const { line: lineNumber, updates: taskUpdates } = update;

      // Validate line number
      if (lineNumber < 1 || lineNumber > lines.length) {
        errors.push({
          line: lineNumber,
          error: `Invalid line number ${lineNumber}`,
        });
        continue;
      }

      const lineIndex = lineNumber - 1;
      const originalLine = lines[lineIndex];

      // Validate that it's a task
      if (!originalLine || !TASK_CHECKBOX.test(originalLine)) {
        errors.push({
          line: lineNumber,
          error: `Line ${lineNumber} is not a task`,
        });
        continue;
      }

      // Apply updates
      const applied = applyUpdates(
        originalLine,
        taskUpdates,
        taskUpdates.mapLine ? spansFor(lines, lineNumber) : [],
      );
      if ('error' in applied) {
        errors.push({ line: lineNumber, error: applied.error });
        continue;
      }

      lines[lineIndex] = applied.line;
      updatedCount++;
    }

    // Write atomically
    const tempFile = `${file}.md2do.tmp`;
    const newContent = lines.join('\n');

    await fs.writeFile(tempFile, newContent, 'utf-8');
    await fs.rename(tempFile, file);

    return {
      success: errors.length === 0,
      updatedCount,
      errors,
    };
  } catch (error) {
    return {
      success: false,
      updatedCount: 0,
      errors: [
        {
          line: 0,
          error: `Failed to update tasks: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
}

/**
 * Add a task to a markdown file
 */
export async function addTask(
  file: string,
  text: string,
  options: {
    /**
     * Line number to insert at (1-indexed)
     * If not specified, appends to end of file
     */
    line?: number;

    /**
     * Whether the task is completed
     */
    completed?: boolean;
  } = {},
): Promise<WriteTaskResult> {
  try {
    const checkbox = options.completed ? '- [x]' : '- [ ]';
    const taskLine = `${checkbox} ${text}`;

    // Read existing content
    let content: string;
    try {
      content = await fs.readFile(file, 'utf-8');
    } catch (error) {
      // File doesn't exist, create it
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        content = '';
      } else {
        throw error;
      }
    }

    const lines = content === '' ? [] : content.split('\n');
    const endsWithNewline = content.endsWith('\n');

    // Insert the task
    let insertedLine: number;
    if (options.line !== undefined) {
      // Validate line number
      if (options.line < 1 || options.line > lines.length + 1) {
        return {
          success: false,
          error: `Invalid line number ${options.line}`,
        };
      }
      lines.splice(options.line - 1, 0, taskLine);
      insertedLine = options.line;
    } else if (endsWithNewline) {
      // Replace the empty tail so the file still ends with exactly one newline
      insertedLine = lines.length;
      lines.splice(lines.length - 1, 1, taskLine, '');
    } else {
      // Append to end, after a blank line unless the file is empty
      if (lines.length > 0) {
        lines.push('');
      }
      lines.push(taskLine);
      insertedLine = lines.length;
    }

    // Write atomically
    const tempFile = `${file}.md2do.tmp`;
    const newContent = lines.join('\n');

    await fs.writeFile(tempFile, newContent, 'utf-8');
    await fs.rename(tempFile, file);

    // Parse the new task
    const parseResult = parseTask(taskLine, insertedLine, file, {});

    const result: WriteTaskResult = {
      success: true,
    };

    if (parseResult.task) {
      result.task = parseResult.task;
    }

    return result;
  } catch (error) {
    return {
      success: false,
      error: `Failed to add task: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
