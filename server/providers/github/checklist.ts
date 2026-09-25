// One boolean per line of `body`, true when that line is inside fenced or indented code.
//
// Extracted from items.ts's stripCodeBlocks, which now wraps it. The two callers want the same
// answer in different shapes: stripCodeBlocks drops the lines, the checklist parser keeps them
// so a line's position in the body survives to the write. One rule, one set of tests.
//
// The conservative bias documented on stripCodeBlocks carries over unchanged, and points the
// same way for both callers. A line wrongly called code is an epic declaration that does not
// match and a checklist entry that cannot be ticked — both free. A line wrongly called prose is
// a silent wrong-epic attachment, or a write into a code sample.
export function codeMask(body: string): boolean[] {
  const mask: boolean[] = []
  let fence: { char: '`' | '~'; len: number } | null = null

  for (const rawLine of body.split(/\r?\n/)) {
    if (fence) {
      mask.push(true) // fence content, and the closing delimiter itself
      if (new RegExp(`^\\${fence.char}{${fence.len},}$`).test(rawLine.trim())) fence = null
      continue
    }

    // At most three leading spaces, as in GFM. Four or more make the line indented code, and
    // reading it as an opener would mask every line after it — a whole checklist gone quietly.
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(rawLine)
    if (open) {
      const marker = open[1]!
      fence = { char: marker[0] as '`' | '~', len: marker.length }
      mask.push(true)
      continue
    }

    mask.push(/^( {4,}|\t)/.test(rawLine)) // indented code — checked before any trimming
  }

  return mask
}
