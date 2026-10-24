export function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  return !!match && isDate(match[1]) && Number(match[2]) <= 23 && Number(match[3]) <= 59 && Number(match[4]) <= 59
    && Number(match[6] ?? 0) <= 23 && Number(match[7] ?? 0) <= 59 && Number.isFinite(Date.parse(value));
}

export function isClientRef(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim() && [...value].length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
}
