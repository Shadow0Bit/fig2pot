import type { Reporter, Warning } from '../ir.ts';

/** Collects warnings in memory. */
export class CollectingReporter implements Reporter {
  readonly warnings: Warning[] = [];

  warn(warning: Warning): void {
    this.warnings.push(warning);
  }

  /** Warning counts per code, most frequent first. */
  summary(): { code: string; count: number; sample: Warning }[] {
    const byCode = new Map<string, { code: string; count: number; sample: Warning }>();
    for (const w of this.warnings) {
      const entry = byCode.get(w.code);
      if (entry) entry.count++;
      else byCode.set(w.code, { code: w.code, count: 1, sample: w });
    }
    return [...byCode.values()].sort((x, y) => y.count - x.count);
  }
}

export const silentReporter: Reporter = { warn() {} };
