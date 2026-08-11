// A browser reorders one rendered line as a single bidirectional paragraph, so
// the spaces, punctuation, and numbers sitting between a Hebrew phrase and the
// Latin sentence around it are pulled into the Hebrew run: a price, a closing
// quote, or the "5" of "5 photos" ends up in the middle of the Hebrew instead of
// where it was written. Marking each opposite-direction run lets the renderer
// wrap it in <bdi>, which restores the written order without adding a single
// character to the stored or copied text.

const LETTER = /[\p{L}\p{M}]/u
const RTL_LETTER = /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}]/u

// Quotes and brackets delimit a phrase in either direction, so a run stops at
// them. A quote between two letters is Hebrew gershayim (ד"ר) rather than a
// delimiter, and splitting there would transpose the word.
const PHRASE_EDGE = /["'‘’“”„«»‹›()[\]{}]/

function textOf(value) {
  return typeof value === 'string' ? value : String(value ?? '')
}

function characterBefore(text, index) {
  return [...text.slice(Math.max(0, index - 2), index)].at(-1)
}

function characterAfter(text, index) {
  return [...text.slice(index, index + 2)][0]
}

function insideWord(text, index, character) {
  const before = characterBefore(text, index)
  const after = characterAfter(text, index + character.length)
  return Boolean(before && after && LETTER.test(before) && LETTER.test(after))
}

/**
 * The strong direction a character contributes, or null when it only follows
 * its neighbours. Digits, currency signs, and punctuation are never strong,
 * which is why they need isolation rather than a direction of their own.
 */
export function characterDirection(value) {
  const character = textOf(value)
  if (!character || !LETTER.test(character)) return null
  return RTL_LETTER.test(character) ? 'rtl' : 'ltr'
}

/**
 * Follows the base direction a browser derives for the line being rendered and
 * splits each text node into runs. Runs written in the opposite direction are
 * marked for isolation; the first strong letter of every line never is, so
 * `dir="auto"` and `unicode-bidi: plaintext` still derive the same base
 * direction they do today. One cursor spans a whole block, because a line can
 * start inside a link or bold span and continue in plain prose.
 */
export function createBidiCursor() {
  let base = null

  const split = (value) => {
    const text = textOf(value)
    const runs = []
    let plainStart = 0
    let isolateStart = -1
    let isolateEnd = -1

    const closeIsolate = () => {
      if (isolateStart < 0) return
      if (isolateStart > plainStart) runs.push({ text: text.slice(plainStart, isolateStart), isolate: false })
      runs.push({ text: text.slice(isolateStart, isolateEnd), isolate: true })
      plainStart = isolateEnd
      isolateStart = -1
    }

    let index = 0
    for (const character of text) {
      if (character === '\n') {
        closeIsolate()
        base = null
      } else {
        const direction = characterDirection(character)
        if (!direction) {
          if (PHRASE_EDGE.test(character) && !insideWord(text, index, character)) closeIsolate()
        } else {
          base ??= direction
          if (direction === base) {
            closeIsolate()
          } else {
            if (isolateStart < 0) isolateStart = index
            isolateEnd = index + character.length
          }
        }
      }
      index += character.length
    }

    closeIsolate()
    if (plainStart < text.length) runs.push({ text: text.slice(plainStart), isolate: false })
    return runs
  }

  return { split }
}
