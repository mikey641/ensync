import assert from 'node:assert/strict'
import test from 'node:test'
import { createEnsyncHost } from './server.mjs'
import { SystemSpeechService } from './system-speech.mjs'

test('macOS speech uses fixed executable arguments and waits for successful playback', async () => {
  let invocation
  const speech = new SystemSpeechService({
    platform: 'darwin',
    runFile(executable, args, options, callback) {
      invocation = { executable, args, options }
      callback(null)
    },
  })

  const result = await speech.speak({
    text: 'Production finished.',
    voiceId: JSON.stringify(['com.apple.voice.compact.en-US.Samantha', 'Samantha', 'en-US']),
  })

  assert.equal(result.status, 'played')
  assert.equal(invocation.executable, '/usr/bin/say')
  assert.deepEqual(invocation.args, ['-v', 'Samantha', 'Production finished.'])
  assert.equal(invocation.options.timeout, 30_000)
})

test('Windows speech passes notification content through environment variables, not command interpolation', async () => {
  let invocation
  const speech = new SystemSpeechService({
    platform: 'win32',
    runFile(executable, args, options, callback) {
      invocation = { executable, args, options }
      callback(null)
    },
  })
  const content = 'Production; $(unsafe) "finished".'
  const result = await speech.speak({ text: content, voiceId: JSON.stringify(['uri', 'Microsoft Zira', 'en-US']) })

  assert.equal(result.status, 'played')
  assert.equal(invocation.executable, 'powershell.exe')
  assert.equal(invocation.args.includes(content), false)
  assert.equal(invocation.options.env.ENSYNC_SPEECH_TEXT, content)
  assert.equal(invocation.options.env.ENSYNC_SPEECH_VOICE, 'Microsoft Zira')
})

test('Host exposes native speech behind the active native-shell lease', async (context) => {
  const calls = []
  const daemonLeaseService = {
    has: (ownerId) => ownerId === 'window-owner',
  }
  const server = createEnsyncHost({
    daemonLeaseService,
    systemSpeechService: {
      async speak(request) {
        calls.push(request)
        return { status: 'played', message: 'Spoken.' }
      },
    },
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  context.after(() => new Promise((resolve) => server.close(resolve)))
  const { port } = server.address()

  const rejected = await fetch(`http://127.0.0.1:${port}/api/notifications/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Production finished.' }),
  })
  assert.equal(rejected.status, 403)

  const accepted = await fetch(`http://127.0.0.1:${port}/api/notifications/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Ensync-Owner': 'window-owner' },
    body: JSON.stringify({ text: 'Production finished.', voiceId: null }),
  })
  assert.equal(accepted.status, 200)
  assert.deepEqual(await accepted.json(), { status: 'played', message: 'Spoken.' })
  assert.deepEqual(calls, [{ text: 'Production finished.', voiceId: null }])
})
