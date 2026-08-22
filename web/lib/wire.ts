/**
 * Column-oriented encoding for the large arrays on a sector payload.
 *
 * A sector page carries its raw series so the client can recompute any date
 * window without another request. The obvious shape, one object per row, spends
 * most of its bytes restating the same key names: a page with 82,000 macro
 * observations sends "series_id" 82,000 times. On the banks page that pushed
 * the prerendered response past Vercel's 19 MB limit and broke the deploy.
 *
 * Sending the column names once and the values as tuples changes no number and
 * no behaviour. It is applied only to the arrays big enough to matter; the rest
 * of the payload stays readable as it is.
 */
export type Packed<T> = { columns: readonly (keyof T & string)[]; rows: unknown[][] };

export function packRows<T>(columns: readonly (keyof T & string)[], rows: T[]): Packed<T> {
  return { columns, rows: rows.map((row) => columns.map((column) => row[column])) };
}

/**
 * Rebuild the rows. Reads the column list off the payload rather than a
 * constant, so a response cached before a column was added still decodes.
 */
export function unpackRows<T>(packed: Packed<T>): T[] {
  return packed.rows.map((values) =>
    Object.fromEntries(packed.columns.map((column, index) => [column, values[index]])) as T);
}
