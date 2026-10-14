// Narration: what untangle is doing, in the terminal and on the page that waits for the review.
import type { Progress } from './build.js';

export interface StepStatus {
  label: string;
  state: 'running' | 'done' | 'failed';
  ms?: number;
  detail?: string;
  notes: string[];
}

export interface Status {
  phase: 'starting' | 'building' | 'ready' | 'failed';
  title: string;
  steps: StepStatus[];
  notes: string[];
  error?: string;
}

export class Narrator implements Progress {
  readonly status: Status = { phase: 'starting', title: '', steps: [], notes: [] };
  private current: { step: StepStatus; start: number } | null = null;
  // Notes of the running step print under it once it ends, so the step line stays in place.
  private pending: string[] = [];
  private drawn = false;
  private readonly tty: boolean;
  private readonly c: (code: string, s: string) => string;

  constructor(private readonly opts: { quiet: boolean; verbose: boolean; color: boolean }) {
    this.tty = !!process.stderr.isTTY && !opts.quiet;
    const color = opts.color && !!process.stderr.isTTY && !process.env.NO_COLOR;
    this.c = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  }

  private write(line: string) {
    this.clear();
    process.stderr.write(line + '\n');
    this.draw();
  }

  private clear() {
    if (this.drawn) process.stderr.write('\r\x1b[K');
    this.drawn = false;
  }

  // The running step, redrawn in place on a terminal.
  private draw() {
    if (!this.tty || !this.current) return;
    const { step, start } = this.current;
    const line = `  ${this.c('2', '…')} ${step.label.padEnd(16)} ${this.c('2', `${Math.round((Date.now() - start) / 1000)} s${step.detail ? '  ' + step.detail : ''}`)}`;
    process.stderr.write('\r\x1b[K' + line.slice(0, (process.stderr.columns || 100) + 20));
    this.drawn = true;
  }

  header(lines: string[]) {
    if (this.opts.quiet) return;
    lines.forEach((l, i) => this.write(i ? '  ' + this.c('2', l) : l));
  }

  title(text: string, sub: string) {
    this.status.title = text;
    if (!this.opts.quiet) {
      this.write('  ' + this.c('1', text));
      this.write('  ' + this.c('2', sub));
    }
  }

  // Arrow functions: callers pass these around as callbacks.
  step = (label: string) => {
    this.finish();
    this.status.phase = 'building';
    const step: StepStatus = { label, state: 'running', notes: [] };
    this.status.steps.push(step);
    this.current = { step, start: Date.now() };
    if (!this.tty && !this.opts.quiet) process.stderr.write(`  … ${label}\n`);
    this.draw();
  }

  detail = (text: string) => {
    if (!this.current) return;
    this.current.step.detail = text;
    this.draw();
  }

  note = (text: string) => {
    (this.current ? this.current.step.notes : this.status.notes).push(text);
    if (this.opts.quiet) return;
    if (this.current) this.pending.push(text);
    else this.write('    ' + this.c('2', text));
  }

  verbose = (text: string) => {
    if (this.opts.verbose && text.trim()) this.write('      ' + this.c('2', text));
  }

  /** Ends the running step. */
  finish(failed = false) {
    if (!this.current) return;
    const { step, start } = this.current;
    step.ms = Date.now() - start;
    step.state = failed ? 'failed' : 'done';
    step.detail = undefined;
    this.current = null;
    if (!this.opts.quiet) {
      this.write(`  ${failed ? this.c('31', '✗') : this.c('32', '✓')} ${step.label.padEnd(16)} ${this.c('2', seconds(step.ms))}`);
      this.pending.forEach((n) => this.write('    ' + this.c('2', n)));
    }
    this.pending = [];
  }

  ready(url: string) {
    this.finish();
    this.status.phase = 'ready';
    if (this.opts.quiet) return;
    this.write('');
    this.write(`  Review at ${this.c('1', url)}`);
    this.write(this.c('2', '  Ctrl+C to stop.'));
  }

  serving(url: string) {
    if (!this.opts.quiet) this.write(`  ${this.c('2', 'Serving at')} ${url}`);
  }

  fail(message: string) {
    this.finish(true);
    this.status.phase = 'failed';
    this.status.error = message;
    this.write(`  ${this.c('31', 'error:')} ${message}`);
  }
}

export const seconds = (ms: number) => (ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);
