export type Hooks = {
  onProgress: (label: string, done: number, total: number) => void
  shouldStop: () => boolean
}

export class StoppedError extends Error {
  constructor() {
    super('Stopped before anything was finished.')
  }
}

// Runs fn over items with at most `limit` at once, keeping the input order.
// After the first failure no new items are started, so a failed run doesn't keep spending credit.
export async function runPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  let failed = false

  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next++
      try {
        results[index] = await fn(items[index], index)
      } catch (err) {
        failed = true
        throw err
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}
