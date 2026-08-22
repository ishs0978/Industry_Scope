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
    <div className="chart-title">{title}</div>
    {term && <div className="chart-term">{term}</div>}
  </div>;
}

/** Says plainly when a panel has nothing to draw, and why. */
export function Unavailable({ children }: { children: ReactNode }) {
  return <div className="source-error">{children}</div>;
}
