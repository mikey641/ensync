import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const appCssPath = new URL('../src/index.css', import.meta.url)

function ruleFor(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'm'))
  assert.ok(match, `expected a rule for ${selector}`)
  return match[1]
}

test('conversation Markdown sizes follow the content scale instead of fixed pixels', async () => {
  const css = await readFile(appCssPath, 'utf8')

  // Rendered Markdown must track the Display preference (Comfortable 16px /
  // Large 18px). Fixed pixel sizes made tables read far smaller than prose.
  const scaled = [
    '.message-table table',
    '.message-list',
    'h1.message-heading',
    'h2.message-heading',
    'h3.message-heading',
    '.message-code-block pre',
  ]
  for (const selector of scaled) {
    const body = ruleFor(css, selector)
    assert.match(body, /font-size:\s*(?:var\(--font-content\)|calc\(var\(--font-content\)[^)]*\))/, selector)
    assert.doesNotMatch(body, /font-size:\s*\d+px/, `${selector} must not pin a pixel size`)
  }

  // Inline code sits inside whatever block holds it, so it scales relatively.
  assert.match(ruleFor(css, '.message-inline-code'), /font-size:\s*\.?\d*\.?\d+em/)
  assert.doesNotMatch(ruleFor(css, '.message-inline-code'), /font-size:\s*\d+px/)
})
