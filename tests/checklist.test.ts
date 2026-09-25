import { describe, expect, it } from 'vitest'
import { codeMask } from '../server/providers/github/checklist.js'

describe('codeMask', () => {
  it('marks backtick-fenced lines, delimiters included', () => {
    const body = ['prose', '```', 'code', '```', 'more'].join('\n')
    expect(codeMask(body)).toEqual([false, true, true, true, false])
  })

  it('marks tilde-fenced lines', () => {
    const body = ['prose', '~~~', 'code', '~~~', 'more'].join('\n')
    expect(codeMask(body)).toEqual([false, true, true, true, false])
  })

  it('marks indented code, by four spaces or by a tab', () => {
    const body = ['prose', '    indented', '\ttabbed', 'more'].join('\n')
    expect(codeMask(body)).toEqual([false, true, true, false])
  })

  it('marks to the end of the body when a fence never closes', () => {
    const body = ['prose', '```', 'code', 'still code'].join('\n')
    expect(codeMask(body)).toEqual([false, true, true, true])
  })

  it('does not let a shorter delimiter close a longer fence', () => {
    const body = ['````', '```', 'still code', '````', 'prose'].join('\n')
    expect(codeMask(body)).toEqual([true, true, true, true, false])
  })

  it('returns one entry per line, trailing empty line included', () => {
    expect(codeMask('a\n\n')).toHaveLength(3)
  })

  it('does not close a fence on a delimiter line with trailing text', () => {
    const body = ['```', '```js', 'still code', '```', 'prose'].join('\n')
    expect(codeMask(body)).toEqual([true, true, true, true, false])
  })

  it('does not close a backtick fence with tildes, or a tilde fence with backticks', () => {
    expect(codeMask(['```', '~~~', 'code', '```', 'prose'].join('\n'))).toEqual([
      true, true, true, true, false,
    ])
    expect(codeMask(['~~~', '```', 'code', '~~~', 'prose'].join('\n'))).toEqual([
      true, true, true, true, false,
    ])
  })

  it('opens a fence indented by fewer than four spaces', () => {
    const body = ['prose', '   ```', 'code', '```', 'more'].join('\n')
    expect(codeMask(body)).toEqual([false, true, true, true, false])
  })

  it('does not treat a three-space indent as code', () => {
    expect(codeMask(['prose', '   three', 'more'].join('\n'))).toEqual([false, false, false])
  })

  it('gives CRLF input the same mask as LF input', () => {
    const lines = ['prose', '```', 'code', '```', '    indented', 'more']
    expect(codeMask(lines.join('\r\n'))).toEqual(codeMask(lines.join('\n')))
  })
})
