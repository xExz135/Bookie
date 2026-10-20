import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import type { PoolClient } from 'pg';
import { from as copyFrom } from 'pg-copy-streams';

/** Streams a .json.gz file one JSON object per line, without unzipping it to disk. */
export async function* readJsonLines<T>(path: string): AsyncGenerator<T> {
  const lines = createInterface({
    input: createReadStream(path).pipe(createGunzip()),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (line.trim() !== '') yield JSON.parse(line) as T;
  }
}

export type CsvValue = string | number | boolean | Date | null | undefined;

/** One CSV line for PostgreSQL COPY. Null becomes an unquoted empty field (SQL NULL). */
export function csvLine(values: CsvValue[]): string {
  return (
    values
      .map((value) => {
        if (value === null || value === undefined) return '';
        const text = value instanceof Date ? value.toISOString() : String(value);
        return `"${text.replace(/"/g, '""')}"`;
      })
      .join(',') + '\n'
  );
}

/**
 * Collects rows for one temporary staging table and, when full, bulk-loads
 * them with COPY and runs the statements that move them into the real
 * tables. Each statement returns how many rows it inserted.
 */
export class StagedBatch {
  private lines: string[] = [];

  constructor(
    private readonly client: PoolClient,
    private readonly table: string,
    private readonly columns: string[],
    private readonly batchSize: number,
  ) {}

  get size(): number {
    return this.lines.length;
  }

  /** Adds a row; returns true when the batch is full and should be flushed. */
  push(values: CsvValue[]): boolean {
    this.lines.push(csvLine(values));
    return this.lines.length >= this.batchSize;
  }

  /** Loads pending rows into the staging table. Returns the row count. */
  async load(): Promise<number> {
    if (this.lines.length === 0) return 0;
    const count = this.lines.length;
    const stream = this.client.query(
      copyFrom(`COPY ${this.table} (${this.columns.join(', ')}) FROM STDIN WITH (FORMAT csv)`),
    );
    await pipeline(Readable.from([this.lines.join('')]), stream);
    this.lines = [];
    return count;
  }

  async truncate(): Promise<void> {
    await this.client.query(`TRUNCATE ${this.table}`);
  }
}
