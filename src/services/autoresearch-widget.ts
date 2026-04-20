/**
 * Autoresearch status widget — a single-line progress indicator.
 *
 * Pure rendering only. The runner is responsible for deciding whether the
 * terminal supports ANSI and for writing the carriage-return / clear-line
 * prefix that redraws the previous widget in place.
 */

export interface WidgetState {
  readonly iter: number;
  readonly kept: number;
  readonly discarded: number;
  readonly baseline: number;
  readonly best: number;
  readonly currentMetric: number;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/**
 * Render one line describing the current loop state. No ANSI, no newlines —
 * the caller prefixes `\r\x1b[2K` when writing to a TTY, plain text otherwise.
 */
export function renderStatus(state: WidgetState): string {
  return (
    `iter ${state.iter} | ` +
    `kept ${state.kept} | ` +
    `disc ${state.discarded} | ` +
    `best ${fmt(state.best)} (base ${fmt(state.baseline)}) | ` +
    `cur ${fmt(state.currentMetric)}`
  );
}

export interface TerminalInfo {
  readonly isTTY: boolean;
  readonly term: string | undefined;
}

/**
 * Decide whether the widget should redraw in place (true) or print as plain
 * log lines (false). Both gates are load-bearing: CI environments often pass
 * the TTY check but render `\x1b[K` literally when `TERM=dumb`.
 */
export function shouldRenderWidget(info: TerminalInfo): boolean {
  if (!info.isTTY) return false;
  if (info.term === "dumb") return false;
  return true;
}
