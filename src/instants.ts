// Date parses the timezone/date portion, but its millisecond precision must not
// erase the up-to-nine fractional digits accepted by our timestamp validator.
export function instant(value: string): bigint {
  const match = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value)!;
  return BigInt(Date.parse(match[1] + match[3])) * 1_000_000n + BigInt((match[2] ?? '').padEnd(9, '0'));
}

export function timestampPayload<T extends object>(value: T): T {
  const result = { ...value } as Record<string, unknown>;
  for (const key of ['observed_at', 'starts_at', 'expected_end']) {
    if (typeof result[key] === 'string') result[key] = instant(result[key] as string).toString();
  }
  return result as T;
}
