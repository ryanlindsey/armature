import type { ChecklistEntry } from '../types.js'

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

// Space or tab only, as in GFM — `\s` would also admit a no-break space GitHub does not render
// as a task, and a later byte-exact write must agree with GitHub about which lines are tasks.
const ENTRY = /^[-*+][ \t]+\[([ xX])\][ \t]+(.+)$/
// An optional closing sequence must be preceded by whitespace, as in GFM: `## C#` is "C#".
const HEADING = /^#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/

// Leading indentation, removed before matching ENTRY or HEADING. ASCII spaces and tabs only, never
// trim(): trim() also strips a no-break space or an ideographic space, and GitHub renders
// `\u00a0- [ ] y` as text, not a task. Anything that deep in indentation codeMask already masked.
function unindent(rawLine: string): string {
  return rawLine.replace(/^[ \t]+/, '')
}

// One boolean per line, true when the line is code (see codeMask) or starts inside an HTML
// comment. Issue templates hide sample checklists in `<!-- -->`, which GitHub does not render, so
// an entry there is not a task and must never be written.
//
// Kept here rather than in codeMask so stripCodeBlocks and parseEpicFromBody are unchanged. A
// comment opener inside code is code, not a comment, so code lines are never scanned.
//
// Conservative in the same direction as codeMask: any `<!--` outside code opens a comment until
// the next `-->`, even one GFM would read as literal text (inside an inline code span, say). A
// line is masked when it *starts* inside a comment, which covers the closer's line — text after
// `-->` there is still part of the HTML block. An entry that opens a comment after its own text
// is still an entry: its box comes before the comment.
function checklistMask(body: string, lines: string[]): boolean[] {
  const code = codeMask(body)
  let inComment = false

  return lines.map((line, i) => {
    if (code[i]) return true
    const masked = inComment
    let at = 0
    for (;;) {
      const next = inComment ? line.indexOf('-->', at) : line.indexOf('<!--', at)
      if (next < 0) break
      at = next + (inComment ? 3 : 4)
      inComment = !inComment
    }
    return masked
  })
}

// Every task-list entry outside code and HTML comments, with the nearest preceding ATX heading as
// context.
//
// The heading is reported, never interpreted: which heading means "acceptance" is the caller's
// judgment, and parseEpicFromBody is the record of what happens when the server reads intent
// out of prose. A heading inside code or a comment is not a heading, so the mask applies to both.
//
// Deliberately narrower than GFM: ATX headings only (not setext), `-`/`*`/`+` bullets only (not
// ordered or blockquoted tasks), and a nested task indented four or more columns is masked as
// code. See docs/superpowers/follow-ups.md.
export function parseChecklist(body: string): ChecklistEntry[] {
  const lines = body.split(/\r?\n/)
  const mask = checklistMask(body, lines)
  const entries: ChecklistEntry[] = []
  let heading: string | null = null

  for (const [i, rawLine] of lines.entries()) {
    if (mask[i]) continue
    const line = unindent(rawLine)

    const head = HEADING.exec(line)
    if (head) {
      heading = head[1]!.trim()
      continue
    }

    const entry = ENTRY.exec(line)
    if (entry) entries.push({ text: entry[2]!.trim(), checked: entry[1] !== ' ', heading })
  }

  return entries
}
