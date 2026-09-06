"use client";

import { useState, type ReactNode } from "react";

/**
 * The small pieces the ETF and company pages share.
 *
 * These mirror the markup and classes the sector dashboard already uses, so the
 * detail pages inherit its styling without that component having to export its
 * internals or the two drifting apart visually.
 */

export function DetailHead(
  { eyebrow, title, subtitle, description, asOf }:
  { eyebrow: string; title: string; subtitle?: string; description: string; asOf?: string },
) {
  return <div className="panel-head">
    <div>
      <div className="panel-index">{eyebrow}</div>
      <h2>{title}</h2>
      {subtitle && <div className="chart-term">{subtitle}</div>}
      <p className="panel-description">{description}</p>
    </div>
    {asOf && <div className="as-of">Data as of<br /><strong>{asOf}</strong></div>}
  </div>;
}

export function Stat(
  { label, term, value, definition }:
  { label: string; term?: string; value: ReactNode; definition?: string },
) {
  const [open, setOpen] = useState(false);
  return <div className="stat">
    {definition ? <>
      <button aria-expanded={open} className="term-toggle" onClick={() => setOpen(!open)}>
        <span className="stat-label">{label}</span>
        {term && <span className="chart-term">{term}</span>}
      </button>
      {open && <div className="term-body">{definition}</div>}
    </> : <>
      <div className="stat-label">{label}</div>
      {term && <div className="chart-term">{term}</div>}
    </>}
    <div className="stat-value">{value}</div>
  </div>;
}

export function Heading({ title, term }: { title: string; term?: string }) {
  return <div className="chart-heading">
    <h3 className="chart-title">{title}</h3>
    {term && <div className="chart-term">{term}</div>}
  </div>;
}

/** Says plainly when a panel has nothing to draw, and why. */
export function Unavailable({ children }: { children: ReactNode }) {
  return <div className="source-error">{children}</div>;
}

/**
 * The rows a chart was drawn from, for a reader who cannot read the drawing.
 *
 * Most charts on the site already sit beside prose or a table that carries the
 * same answer, and those do not need this. It is for the few where the answer
 * exists only in the picture. Collapsed by default so it costs a sighted reader
 * nothing, and inside a `details` rather than a toggle so it works before the
 * page has hydrated.
 *
 * Only for series short enough to read. A daily macro series runs to tens of
 * thousands of rows, and a table that long is not an alternative to anything;
 * those charts state their range and endpoints in the label instead.
 */
export function ChartTable(
  { caption, columns, rows }:
  { caption: string; columns: string[]; rows: ReactNode[][] },
) {
  return <details className="chart-table">
    <summary>Show the numbers</summary>
    <div className="data-table-wrap" tabIndex={0}>
      <table>
        <caption className="visually-hidden">{caption}</caption>
        <thead><tr>{columns.map((column) => <th key={column} scope="col">{column}</th>)}</tr></thead>
        <tbody>{rows.map((row, index) => <tr key={index}>
          <th scope="row">{row[0]}</th>
          {row.slice(1).map((cell, cellIndex) => <td key={columns[cellIndex + 1]}>{cell}</td>)}
        </tr>)}</tbody>
      </table>
    </div>
  </details>;
}
