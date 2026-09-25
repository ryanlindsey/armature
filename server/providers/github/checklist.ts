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
    // Indentation is measured before any trimming, in columns, over ASCII spaces and tabs only:
    // CommonMark tab stops are 4, so ' \t' reaches column 4 exactly as four spaces do. NBSP and
    // other Unicode whitespace are content, not indentation.
    const { columns, rest } = indentation(rawLine)

    if (fence) {
      mask.push(true) // fence content, and the closing delimiter itself
      // A closer is indented 0-3 columns, uses the opener's character, is at least as long, and
      // has nothing after it but spaces or tabs. `    ```` inside a fence is content, not a closer.
      const run = fenceRun(rest, fence.char)
      if (columns <= 3 && run >= fence.len && /^[ \t]*$/.test(rest.slice(run))) fence = null
      continue
    }

    // At most three columns of indentation, as in GFM. Four or more make the line indented code,
    // and reading it as an opener would mask every line after it — a whole checklist gone quietly.
    if (columns <= 3) {
      const open = /^(`{3,}|~{3,})/.exec(rest)
      if (open) {
        const marker = open[1]!
        fence = { char: marker[0] as '`' | '~', len: marker.length }
        mask.push(true)
        continue
      }
    }

    mask.push(columns >= 4) // indented code
  }

  return mask
}

// Leading ASCII spaces and tabs, as a CommonMark column count (tab stops of 4), and the rest.
function indentation(line: string): { columns: number; rest: string } {
  let columns = 0
  let i = 0
  for (; i < line.length; i++) {
    if (line[i] === ' ') columns += 1
    else if (line[i] === '\t') columns += 4 - (columns % 4)
    else break
  }
  return { columns, rest: line.slice(i) }
}

// Length of the run of `char` that `text` starts with.
function fenceRun(text: string, char: '`' | '~'): number {
  let n = 0
  while (text[n] === char) n++
  return n
}
