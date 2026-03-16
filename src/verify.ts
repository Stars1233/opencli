/**
 * Verification: runs validation and optional smoke test.
 *
 * The smoke test is intentionally kept as a stub — full browser-based
 * smoke testing requires a running browser session and is better suited
 * to the `opencli test` command or CI pipelines.
 */

import { validateClisWithTarget, renderValidationReport, type ValidationReport } from './validate.js';

export interface VerifyOptions {
  builtinClis: string;
  userClis: string;
  target?: string;
  smoke?: boolean;
}

export interface VerifyReport {
  ok: boolean;
  validation: ValidationReport;
  smoke: null;
}

export async function verifyClis(opts: VerifyOptions): Promise<VerifyReport> {
  const report = validateClisWithTarget([opts.builtinClis, opts.userClis], opts.target);
  return { ok: report.ok, validation: report, smoke: null };
}

export function renderVerifyReport(report: VerifyReport): string {
  return renderValidationReport(report.validation);
}

