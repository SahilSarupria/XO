import { describeSchema, type DescribeSchemaOptions, type SchemaDescriptor } from '@xo/ai-core';
import type { RecordSet } from './types.js';

/**
 * UW-14b — a record set as an egress schema descriptor: its headers, declared types, counts and value shapes, never a value. This is
 * what a planning model may be shown about a customer's workbook (ADR 0020); the values stay in the instance.
 */
export function describeRecordSet(set: RecordSet, options: DescribeSchemaOptions = {}): SchemaDescriptor {
  return describeSchema(
    {
      name: set.sheet ?? 'table',
      columns: set.columns.map((c) => ({ header: c.header, type: c.declaredType })),
      rows: set.records.map((r) =>
        set.columns.map((c) => {
          const cell = r.cells[c.column];
          return cell === undefined ? undefined : (cell.date?.iso ?? cell.raw);
        }),
      ),
    },
    options,
  );
}
