export function formatUsageValue(value: number, fractionDigits = 2): string {
  if (!Number.isFinite(value)) return (0).toFixed(fractionDigits)
  return value.toFixed(fractionDigits)
}

export function formatUsageLimit(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

export function formatUsageRatio(used: number, limit: number): string {
  if (limit <= 0) return formatUsageValue(used)
  return `${formatUsageValue(used)} / ${formatUsageLimit(limit)}`
}
