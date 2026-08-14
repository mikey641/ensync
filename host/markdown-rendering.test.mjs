import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  classifyLinkTarget,
  filePathFromText,
  parseInline,
  parseMarkdown,
} from '../src/lib/markdown.mjs'

const text = (value) => ({ type: 'text', text: value })
const paragraph = (...content) => ({ type: 'paragraph', content })

test('plain prose stays one paragraph with internal line breaks intact', () => {
  const content = 'First line\nSecond line'
  assert.deepEqual(parseMarkdown(content), [paragraph(text('First line\nSecond line'))])
})

test('blank lines split paragraphs without inventing empty blocks', () => {
  assert.deepEqual(parseMarkdown('One\n\n\nTwo\n'), [
    paragraph(text('One')),
    paragraph(text('Two')),
  ])
})

test('atx headings parse levels with inline content and reject fakes', () => {
  assert.deepEqual(parseMarkdown('## Codex hot patch **backported**'), [
    { type: 'heading', level: 2, content: [text('Codex hot patch '), { type: 'strong', content: [text('backported')] }] },
  ])
  assert.deepEqual(parseMarkdown('###### deep'), [
    { type: 'heading', level: 6, content: [text('deep')] },
  ])
  assert.deepEqual(parseMarkdown('####### too deep'), [paragraph(text('####### too deep'))])
  assert.deepEqual(parseMarkdown('#hash'), [paragraph(text('#hash'))])
})

test('fenced code blocks pass through the existing fence parser', () => {
  assert.deepEqual(parseMarkdown('Before\n```js\nrun()\n```\nAfter'), [
    paragraph(text('Before')),
    { type: 'code', code: 'run()\n', language: 'js' },
    paragraph(text('After')),
  ])
})

test('gfm pipe tables parse header, alignment, and normalized rows', () => {
  const content = [
    '| Project | Stars | License |',
    '| :--- | ---: | :---: |',
    '| claude-replay | 792 | MIT |',
    '| happy | 23.2k |',
  ].join('\n')

  assert.deepEqual(parseMarkdown(content), [{
    type: 'table',
    align: ['left', 'right', 'center'],
    header: [[text('Project')], [text('Stars')], [text('License')]],
    rows: [
      [[text('claude-replay')], [text('792')], [text('MIT')]],
      [[text('happy')], [text('23.2k')], []],
    ],
  }])
})

test('escaped pipes stay inside table cells', () => {
  const content = '| a | b |\n| --- | --- |\n| c \\| d | e |'
  const [table] = parseMarkdown(content)
  assert.equal(table.type, 'table')
  assert.deepEqual(table.rows[0][0], [text('c | d')])
})

test('a pipe line without a delimiter row stays prose', () => {
  assert.deepEqual(parseMarkdown('a | b\nplain'), [paragraph(text('a | b\nplain'))])
})

test('unordered and ordered lists parse items, start numbers, and nesting', () => {
  assert.deepEqual(parseMarkdown('- one\n- two\n  - two.a\n- three'), [{
    type: 'list',
    ordered: false,
    start: null,
    items: [
      { content: [text('one')], children: [] },
      {
        content: [text('two')],
        children: [{
          type: 'list',
          ordered: false,
          start: null,
          items: [{ content: [text('two.a')], children: [] }],
        }],
      },
      { content: [text('three')], children: [] },
    ],
  }])

  assert.deepEqual(parseMarkdown('3. third\n4. fourth'), [{
    type: 'list',
    ordered: true,
    start: 3,
    items: [
      { content: [text('third')], children: [] },
      { content: [text('fourth')], children: [] },
    ],
  }])
})

test('a non-list line ends the list', () => {
  assert.deepEqual(parseMarkdown('- item\nafter'), [
    { type: 'list', ordered: false, start: null, items: [{ content: [text('item')], children: [] }] },
    paragraph(text('after')),
  ])
})

test('blockquotes strip markers and parse nested blocks', () => {
  assert.deepEqual(parseMarkdown('> ## Quoted\n> line one\n> line two'), [{
    type: 'blockquote',
    blocks: [
      { type: 'heading', level: 2, content: [text('Quoted')] },
      paragraph(text('line one\nline two')),
    ],
  }])
})

test('thematic breaks parse and setext headings are intentionally not supported', () => {
  assert.deepEqual(parseMarkdown('above\n\n---\n\nbelow'), [
    paragraph(text('above')),
    { type: 'rule' },
    paragraph(text('below')),
  ])
  assert.deepEqual(parseMarkdown('* * *'), [{ type: 'rule' }])
  const [spacedDashes] = parseMarkdown('- - x')
  assert.equal(spacedDashes.type, 'list')
})

test('inline emphasis, strikethrough, and nesting parse', () => {
  assert.deepEqual(parseInline('**bold** and *em* and ~~gone~~'), [
    { type: 'strong', content: [text('bold')] },
    text(' and '),
    { type: 'em', content: [text('em')] },
    text(' and '),
    { type: 'del', content: [text('gone')] },
  ])
  assert.deepEqual(parseInline('**byte-identical to the *installed* hot patch**'), [
    {
      type: 'strong',
      content: [
        text('byte-identical to the '),
        { type: 'em', content: [text('installed')] },
        text(' hot patch'),
      ],
    },
  ])
})

test('intraword underscores never emphasize identifiers', () => {
  assert.deepEqual(parseInline('ENSYNC_HOST_IDLE_SHUTDOWN_MS'), [text('ENSYNC_HOST_IDLE_SHUTDOWN_MS')])
  assert.deepEqual(parseInline('_lead_'), [{ type: 'em', content: [text('lead')] }])
})

test('code spans win over emphasis and support double-backtick escaping', () => {
  assert.deepEqual(parseInline('run `npm --prefix desktop test` now'), [
    text('run '),
    { type: 'code', text: 'npm --prefix desktop test' },
    text(' now'),
  ])
  assert.deepEqual(parseInline('`turn/steer` sent `**not bold**`'), [
    { type: 'code', text: 'turn/steer' },
    text(' sent '),
    { type: 'code', text: '**not bold**' },
  ])
  assert.deepEqual(parseInline('`` has ` tick ``'), [{ type: 'code', text: 'has ` tick' }])
})

test('links, images, and autolinks parse', () => {
  assert.deepEqual(parseInline('[es617/claude-replay](https://github.com/es617/claude-replay)'), [
    { type: 'link', href: 'https://github.com/es617/claude-replay', content: [text('es617/claude-replay')] },
  ])
  assert.deepEqual(parseInline('![diagram](https://example.com/d.png)'), [
    { type: 'image', src: 'https://example.com/d.png', alt: 'diagram' },
  ])
  assert.deepEqual(parseInline('see https://github.com/slopus/happy.'), [
    text('see '),
    { type: 'link', href: 'https://github.com/slopus/happy', content: [text('https://github.com/slopus/happy')] },
    text('.'),
  ])
})

test('backslash escapes render markdown punctuation literally', () => {
  assert.deepEqual(parseInline('\\*not em\\* and \\`not code\\`'), [text('*not em* and `not code`')])
})

test('link targets classify external, local file, and refused schemes', () => {
  assert.deepEqual(classifyLinkTarget('https://ensync.vercel.app'), { kind: 'external', url: 'https://ensync.vercel.app' })
  assert.deepEqual(classifyLinkTarget('http://localhost:5173'), { kind: 'external', url: 'http://localhost:5173' })
  assert.deepEqual(classifyLinkTarget('mailto:mikey641@gmail.com'), { kind: 'external', url: 'mailto:mikey641@gmail.com' })
  assert.deepEqual(classifyLinkTarget('/tmp/ensync-app-backup/chat.mjs'), { kind: 'file', path: '/tmp/ensync-app-backup/chat.mjs' })
  assert.deepEqual(classifyLinkTarget('~/dev/relay/host/chat.mjs'), { kind: 'file', path: '~/dev/relay/host/chat.mjs' })
  assert.deepEqual(classifyLinkTarget('file:///Users/mikey/notes.txt'), { kind: 'file', path: '/Users/mikey/notes.txt' })
  assert.deepEqual(classifyLinkTarget('C:\\dev\\relay\\host\\chat.mjs'), { kind: 'file', path: 'C:\\dev\\relay\\host\\chat.mjs' })
  assert.deepEqual(classifyLinkTarget('javascript:alert(1)'), { kind: 'none' })
  assert.deepEqual(classifyLinkTarget('docs/readme'), { kind: 'none' })
})

test('path-like inline code resolves to an openable file reference', () => {
  assert.deepEqual(filePathFromText('/Users/mikey/dev/relay/host/chat.mjs:12'), {
    path: '/Users/mikey/dev/relay/host/chat.mjs',
    line: 12,
  })
  assert.deepEqual(filePathFromText('host/codex-live-turn.mjs'), { path: 'host/codex-live-turn.mjs', line: null })
  assert.deepEqual(filePathFromText('src/components/MessageContent.tsx:39'), { path: 'src/components/MessageContent.tsx', line: 39 })
  assert.deepEqual(filePathFromText('~/dev/relay'), { path: '~/dev/relay', line: null })
  assert.equal(filePathFromText('npm run test:host'), null)
  assert.equal(filePathFromText('https://github.com/x/y'), null)
  assert.equal(filePathFromText('a/b'), null)
  assert.equal(filePathFromText('turn/started'), null)
})

test('message component renders markdown safely with bidi and native open wiring', async () => {
  const [component, appCss, themeCss, app] = await Promise.all([
    readFile(new URL('../src/components/MessageContent.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/index.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/theme.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
  ])

  assert.match(component, /parseMarkdown/)
  assert.doesNotMatch(component, /dangerouslySetInnerHTML/)
  assert.match(component, /<p key=\{key\} dir="auto">/)
  assert.match(component, /<pre dir="ltr"><code>\{code\}<\/code><\/pre>/)
  assert.match(component, /target="_blank" rel="noreferrer"/)
  assert.match(component, /loading="lazy"/)
  assert.match(component, /ensyncDesktop\?\.openPath/)
  assert.match(component, /Couldn't open/)
  assert.equal(
    app.match(/<MessageContent content=\{message\.content\} projectPath=\{projectPath\} \/>/g)?.length,
    2,
  )
  assert.match(app, /<MessageContent content=\{note\.text\} projectPath=\{projectPath\} \/>/)

  assert.match(appCss, /\.message-content__table\s*\{[^}]*overflow-x:\s*auto/s)
  assert.match(appCss, /\.message-content table\s*\{/)
  assert.match(appCss, /\.message-content blockquote\s*\{/)
  assert.match(themeCss, /\.message-content a\s*\{[^}]*var\(--/s)
})

test('native shell exposes a validated open-path bridge', async () => {
  const [preload, main, viteEnv] = await Promise.all([
    readFile(new URL('../desktop/src/preload.cjs', import.meta.url), 'utf8'),
    readFile(new URL('../desktop/src/main.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../src/vite-env.d.ts', import.meta.url), 'utf8'),
  ])

  assert.match(preload, /openPath: \(request\) => ipcRenderer\.invoke\(WORKSPACE_OPEN_PATH_CHANNEL, request\)/)
  assert.match(preload, /'ensync:workspace:open-path'/)
  assert.match(main, /'ensync:workspace:open-path'/)
  assert.match(main, /shell\.openPath/)
  assert.match(main, /existsSync/)
  assert.match(viteEnv, /openPath\?: \(request: \{ path: string; projectPath\?: string \| null \}\) => Promise<\{ ok: boolean; error\?: string \}>/)
})
