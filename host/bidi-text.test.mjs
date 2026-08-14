import assert from 'node:assert/strict'
import test from 'node:test'

import { characterDirection, createBidiCursor } from '../src/lib/bidiText.mjs'

const split = (...values) => {
  const cursor = createBidiCursor()
  return values.map((value) => cursor.split(value))
}

const runsOf = (value) => createBidiCursor().split(value)

test('character direction reports strong letters only', () => {
  assert.equal(characterDirection('a'), 'ltr')
  assert.equal(characterDirection('ת'), 'rtl')
  assert.equal(characterDirection('م'), 'rtl')
  assert.equal(characterDirection('4'), null)
  assert.equal(characterDirection('₪'), null)
  assert.equal(characterDirection(' '), null)
  assert.equal(characterDirection('·'), null)
  assert.equal(characterDirection(''), null)
  assert.equal(characterDirection(undefined), null)
})

test('text without an opposite direction stays a single unisolated run', () => {
  assert.deepEqual(runsOf('published 17:51:37, 5 photos.'), [
    { text: 'published 17:51:37, 5 photos.', isolate: false },
  ])
  assert.deepEqual(runsOf('להשכרה · מסחרי, ₪4,000, 5 תמונות'), [
    { text: 'להשכרה · מסחרי, ₪4,000, 5 תמונות', isolate: false },
  ])
  assert.deepEqual(runsOf(''), [])
})

test('the reported marketplace line isolates each hebrew phrase and keeps prices outside', () => {
  const [link, rest] = split(
    'https://www.facebook.com/marketplace/item/4362692507313968/',
    ' — published 17:51:37, "להשכרה · מסחרי / חנות", ₪4,000, תל אביב - יפו, 5 photos.',
  )

  assert.deepEqual(link, [
    { text: 'https://www.facebook.com/marketplace/item/4362692507313968/', isolate: false },
  ])
  assert.deepEqual(rest, [
    { text: ' — published 17:51:37, "', isolate: false },
    { text: 'להשכרה · מסחרי / חנות', isolate: true },
    { text: '", ₪4,000, ', isolate: false },
    { text: 'תל אביב - יפו', isolate: true },
    { text: ', 5 photos.', isolate: false },
  ])
})

test('the first strong letter of a line is never isolated so dir="auto" still resolves it', () => {
  assert.deepEqual(runsOf('פורסם 17:51:37 ב-Facebook Marketplace, 5 תמונות'), [
    { text: 'פורסם 17:51:37 ב-', isolate: false },
    { text: 'Facebook Marketplace', isolate: true },
    { text: ', 5 תמונות', isolate: false },
  ])
})

test('each line inside one block resolves its own base direction', () => {
  assert.deepEqual(runsOf('Published: להשכרה\nפורסם: published'), [
    { text: 'Published: ', isolate: false },
    { text: 'להשכרה', isolate: true },
    { text: '\nפורסם: ', isolate: false },
    { text: 'published', isolate: true },
  ])
})

test('digits and inner punctuation stay inside one phrase, quotes and brackets end it', () => {
  assert.deepEqual(runsOf('Posted from רחוב הרצל 5, תל אביב today.'), [
    { text: 'Posted from ', isolate: false },
    { text: 'רחוב הרצל 5, תל אביב', isolate: true },
    { text: ' today.', isolate: false },
  ])
  assert.deepEqual(runsOf('Signed by ד"ר כהן at 18:00.'), [
    { text: 'Signed by ', isolate: false },
    { text: 'ד"ר כהן', isolate: true },
    { text: ' at 18:00.', isolate: false },
  ])
  assert.deepEqual(runsOf('Category (מסחרי) and חנות'), [
    { text: 'Category (', isolate: false },
    { text: 'מסחרי', isolate: true },
    { text: ') and ', isolate: false },
    { text: 'חנות', isolate: true },
  ])
})

test('the cursor carries the base direction across sibling inline nodes', () => {
  const [, hebrew] = split('Listing: ', 'תל אביב')
  assert.deepEqual(hebrew, [{ text: 'תל אביב', isolate: true }])

  const [, latin] = split('כותרת: ', 'Marketplace')
  assert.deepEqual(latin, [{ text: 'Marketplace', isolate: true }])
})

test('non-string values never throw', () => {
  assert.deepEqual(runsOf(undefined), [])
  assert.deepEqual(runsOf(null), [])
  assert.deepEqual(runsOf(4000), [{ text: '4000', isolate: false }])
})
