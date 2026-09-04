export type MutationEntry = {
  ref: string
  field: string
  before: string | null
  after: string | null
  /**
   * Whether this line describes an intended effect rather than one that landed. Under
   * ARMATURE_DRY_RUN the `after` value is what armature would have written and never observed,
   * so an unmarked line would assert a transition that did not happen — and the mutation log
   * exists precisely to answer "here is the write that did it" after a corruption. Defaults to
   * false, and is always serialized, so a reader never has to infer realness from an absent key.
   */
  dryRun?: boolean
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
      dryRun: entry.dryRun === true,
    }),
  )
}
