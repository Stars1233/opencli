/**
 * Output formatting: table, JSON, Markdown, CSV, YAML.
 */

import chalk from 'chalk';
import Table from 'cli-table3';
import yaml from 'js-yaml';

export interface RenderOptions {
  fmt?: string;
  columns?: string[];
  title?: string;
  elapsed?: number;
  source?: string;
}

export function render(data: any, opts: RenderOptions = {}): void {
  const fmt = opts.fmt ?? 'table';
  if (data === null || data === undefined) {
    console.log(data);
    return;
  }
  switch (fmt) {
    case 'json': renderJson(data); break;
    case 'md': case 'markdown': renderMarkdown(data, opts); break;
    case 'csv': renderCsv(data, opts); break;
    case 'yaml': case 'yml': renderYaml(data); break;
    default: renderTable(data, opts); break;
  }
}

function renderTable(data: any, opts: RenderOptions): void {
  const rows: any[] = Array.isArray(data) ? data : [data];
  if (!rows.length) { console.log(chalk.dim('(no data)')); return; }
  const columns = opts.columns ?? Object.keys(rows[0]);

  const header = columns.map(c => capitalize(c));
  const table = new Table({
    head: header.map(h => chalk.bold(h)),
    style: { head: [], border: [] },
    wordWrap: true,
    wrapOnWordBoundary: true,
  });

  for (const row of rows) {
    table.push(columns.map(c => {
      const v = row[c];
      return v === null || v === undefined ? '' : String(v);
    }));
  }

  console.log();
  if (opts.title) console.log(chalk.dim(`  ${opts.title}`));
  console.log(table.toString());
  const footer: string[] = [];
  footer.push(`${rows.length} items`);
  if (opts.elapsed) footer.push(`${opts.elapsed.toFixed(1)}s`);
  if (opts.source) footer.push(opts.source);
  console.log(chalk.dim(footer.join(' · ')));
}

function renderJson(data: any): void {
  console.log(JSON.stringify(data, null, 2));
}

function renderMarkdown(data: any, opts: RenderOptions): void {
  const rows: any[] = Array.isArray(data) ? data : [data];
  if (!rows.length) return;
  const columns = opts.columns ?? Object.keys(rows[0]);
  console.log('| ' + columns.join(' | ') + ' |');
  console.log('| ' + columns.map(() => '---').join(' | ') + ' |');
  for (const row of rows) {
    console.log('| ' + columns.map(c => String(row[c] ?? '')).join(' | ') + ' |');
  }
}

function renderCsv(data: any, opts: RenderOptions): void {
  const rows: any[] = Array.isArray(data) ? data : [data];
  if (!rows.length) return;
  const columns = opts.columns ?? Object.keys(rows[0]);
  console.log(columns.join(','));
  for (const row of rows) {
    console.log(columns.map(c => {
      const v = String(row[c] ?? '');
      return v.includes(',') || v.includes('"') || v.includes('\n')
        ? `"${v.replace(/"/g, '""')}"` : v;
    }).join(','));
  }
}

function renderYaml(data: any): void {
  console.log(yaml.dump(data, { sortKeys: false, lineWidth: 120, noRefs: true }));
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
