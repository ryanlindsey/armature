export type MutationEntry = {
  ref: string
  field: string
  before: string | null
  after: string | null
}

export function logMutation(
  entry: MutationEntry,
  write: (line: string) => void = (l) => process.stderr.write(l + '\n'),
): void {
  // Constructed field by field so no caller can widen this into a credential leak.
  write(
    JSON.stringify({
      at: new Date().toISOString(),
      ref: entry.ref,
      field: entry.field,
      before: entry.before,
      after: entry.after,
    }),
  )
}
