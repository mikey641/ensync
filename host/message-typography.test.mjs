import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const appCssPath = new URL('../src/index.css', import.meta.url)

function ruleFor(css, selector) {
  const start = css.indexOf(`${selector} {`)
  assert.notEqual(start, -1, `${selector} rule is missing`)
  return css.slice(start, css.indexOf('}', start) + 1)
}

test('conversation message typography resolves through display tokens', async () => {
  const css = await readFile(appCssPath, 'utf8')

  assert.match(ruleFor(css, '.message-content p'), /font-size: var\(--font-content\)/)
  assert.match(ruleFor(css, '.message__run-meta'), /font-size: var\(--font-label\)/)
  assert.match(ruleFor(css, '.message-code-block__header'), /font-size: var\(--font-label\)/)
  assert.match(ruleFor(css, '.message-code-block pre'), /font-size: var\(--font-ui\)/)
})

test('conversation message chrome never pins a size below the 13px label floor', async () => {
  const css = await readFile(appCssPath, 'utf8')
  const belowLabelFloor = /font(?:-size)?:\s*(?:[0-9]|1[0-2])px/

  for (const selector of [
    '.message-content p',
    '.message__meta strong',
    '.message__meta span',
    '.message__run-meta',
    '.message-code-block__header',
    '.message-code-block pre',
    '.message-actions button',
  ]) {
    assert.equal(
      belowLabelFloor.test(ruleFor(css, selector)),
      false,
      `${selector} still pins a size below the documented 13px label floor`,
    )
  }
})
