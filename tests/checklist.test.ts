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
})
