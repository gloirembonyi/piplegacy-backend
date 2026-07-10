import path from 'path'

/** Writable data directory - uses /tmp on Vercel where the project filesystem is read-only. */
export function getDataDir(subdir: string): string {
  const base = process.env.VERCEL
    ? path.join('/tmp', 'market-signal')
    : path.join(process.cwd(), '.data')
  return path.join(base, subdir)
}
