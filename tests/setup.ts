// A test that lets a mutation log line reach the real stderr has forgotten `logWrite`, which
// means two things at once: the line is noise in CI output, and the test is exercising
// logMutation's production writer instead of asserting on what was written. One such test shipped
// on this branch and was only noticed by eye. Caught here instead.
const realWrite = process.stderr.write.bind(process.stderr)

const MUTATION_LINE = /^\{"at":"[^"]+","ref":/

process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
  const text = typeof chunk === 'string' ? chunk : String(chunk)
  if (MUTATION_LINE.test(text)) {
    throw new Error(
      `A test wrote a mutation log line to the real stderr: ${text.trim()}\n` +
        `Pass { logWrite } in DispatchOptions so the line is captured by the test instead.`,
    )
  }
  return (realWrite as (...args: unknown[]) => boolean)(chunk, ...rest)
}) as typeof process.stderr.write
