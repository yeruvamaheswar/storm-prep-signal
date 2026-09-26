const PLOT_PAD = 14

/** Chart space is 0–100. Y grows downward so a larger MW sits higher. */
export function chartPoint(index: number, count: number, value: number, max: number): { x: number; y: number } {
  const x = count === 0 ? 0 : ((index + 0.5) / count) * 100
  const span = 100 - PLOT_PAD * 2
  const y = max <= 0 ? 100 - PLOT_PAD : PLOT_PAD + (1 - value / max) * span
  return { x, y }
}

export function valuesPolyline(values: readonly number[], max: number): string {
  return values
    .map((value, index) => {
      const point = chartPoint(index, values.length, value, max)
      return `${point.x.toFixed(2)},${point.y.toFixed(2)}`
    })
    .join(" ")
}
