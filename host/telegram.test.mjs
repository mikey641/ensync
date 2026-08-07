import assert from 'node:assert/strict'
import test from 'node:test'
import { TelegramBridgeError, TelegramBridgeService, validateTelegramTaskContext } from './telegram.mjs'

const BOT_TOKEN = `123456789:${'A'.repeat(35)}`

test('Telegram task context keeps only a validated SSH execution target', () => {
  const context = validateTelegramTaskContext({
    projectId: 'project-1',
    projectLabel: 'Project',
    projectPath: '/local/project',
    conversationId: 'conversation-1',
    provider: 'codex',
    executionTarget: {
      kind: 'ssh',
      connection: {
        hostname: 'Worker.Example.com',
        username: 'developer',
        port: 22,
        identityFile: '/tmp/id_ed25519',
        projectPath: '/srv/project',
        password: 'must-not-survive',
      },
    },
  })
  assert.deepEqual(context.executionTarget, {
    kind: 'ssh',
    connection: {
      hostname: 'worker.example.com',
      username: 'developer',
      port: 22,
      identityFile: '/tmp/id_ed25519',
      projectPath: '/srv/project',
    },
  })
  assert.throws(
    () => validateTelegramTaskContext({
      ...context,
      executionTarget: { kind: 'ssh', connection: { ...context.executionTarget.connection, hostname: 'worker\nFake runtime' } },
    }),
    (error) => error instanceof TelegramBridgeError && error.code === 'invalid_task_context',
  )
})

function deterministicBytes() {
  let sequence = 0
  return (size) => Buffer.alloc(size, ++sequence)
}

function fakeTelegram(options = {}) {
  const calls = []
  let nextMessageId = 100
  const updateBatches = [...(options.updateBatches ?? [])]
  const fetch = async (url, init = {}) => {
    const match = String(url).match(/\/bot([^/]+)\/([^/?]+)/)
    const token = match?.[1]
    const method = match?.[2]
    const payload = init.body ? JSON.parse(init.body) : {}
    calls.push({ token, method, payload, signal: init.signal })
    if (options.hangGetUpdates && method === 'getUpdates') {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        }, { once: true })
      })
    }
    if (options.rejectMethod === method) {
      return {
        ok: false,
        status: options.rejectStatus ?? 401,
        json: async () => ({ ok: false, error_code: options.rejectCode ?? 401 }),
      }
    }
    let result = true
    if (method === 'getMe') {
      result = {
        id: 777000111,
        is_bot: true,
        username: 'ensync_test_bot',
        first_name: 'Ensync',
      }
    } else if (method === 'getUpdates') {
      result = updateBatches.shift() ?? []
    } else if (method === 'sendMessage') {
      result = { message_id: nextMessageId++, chat: { id: payload.chat_id } }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, result }) }
  }
  return { fetch, calls }
}

async function pairedService(options = {}) {
  const telegram = fakeTelegram()
  const nowRef = { value: options.now ?? 1_800_000_000_000 }
  const service = new TelegramBridgeService({
    fetch: telegram.fetch,
    randomBytes: deterministicBytes(),
    now: () => nowRef.value,
    autoPoll: false,
    approvalTtlMs: options.approvalTtlMs,
    chatRunner: options.chatRunner,
  })
  const pairing = await service.startPairing(BOT_TOKEN)
  await service.processUpdate({
    update_id: 1,
    message: {
      message_id: 1,
      text: `/pair ${pairing.code}`,
      chat: { id: 4242, type: 'private' },
      from: { id: 4242, is_bot: false, username: 'owner', first_name: 'Mikey' },
    },
  })
  return { service, telegram, nowRef, pairing }
}

function selectedTaskContext() {
  return {
    projectId: 'relay-project',
    projectLabel: 'Ensync',
    projectPath: '/Users/example/dev/relay',
    conversationId: 'conversation-17',
    provider: 'codex',
  }
}

test('getMe verifies the bot while the token remains memory-only and absent from responses', async () => {
  const telegram = fakeTelegram()
  const service = new TelegramBridgeService({
    fetch: telegram.fetch,
    randomBytes: deterministicBytes(),
    autoPoll: false,
  })

  const result = await service.startPairing(BOT_TOKEN)
  assert.equal(telegram.calls[0].method, 'getMe')
  assert.equal(telegram.calls[0].token, BOT_TOKEN)
  assert.equal(result.bot.username, 'ensync_test_bot')
  assert.equal(result.tokenStorage, 'memory_only')
  assert.equal(result.encryptedCredentialStorage, false)
  assert.equal(JSON.stringify(result).includes(BOT_TOKEN), false)
  assert.equal(JSON.stringify(service.status()).includes(BOT_TOKEN), false)
  await assert.rejects(service.startPairing(BOT_TOKEN), { code: 'pairing_in_progress' })
})

test('invalid or Telegram-rejected tokens never appear in returned errors', async () => {
  const noFetch = fakeTelegram()
  const invalidService = new TelegramBridgeService({ fetch: noFetch.fetch, autoPoll: false })
  await assert.rejects(
    invalidService.startPairing('not-a-token'),
    (error) => error instanceof TelegramBridgeError && error.code === 'invalid_token',
  )
  assert.equal(noFetch.calls.length, 0)

  const rejected = fakeTelegram({ rejectMethod: 'getMe' })
  const rejectedService = new TelegramBridgeService({ fetch: rejected.fetch, autoPoll: false })
  await assert.rejects(rejectedService.startPairing(BOT_TOKEN), (error) => {
    assert.equal(error.code, 'telegram_rejected')
    assert.equal(error.message.includes(BOT_TOKEN), false)
    return true
  })
  assert.equal(rejectedService.status().tokenStorage, 'none')
})

test('pairing accepts only the short-lived code from a private non-bot account', async () => {
  const telegram = fakeTelegram()
  let now = 1_800_000_000_000
  const service = new TelegramBridgeService({
    fetch: telegram.fetch,
    randomBytes: deterministicBytes(),
    now: () => now,
    autoPoll: false,
    pairingTtlMs: 1_000,
  })
  const pairing = await service.startPairing(BOT_TOKEN)

  await service.processUpdate({ message: {
    text: `/pair ${pairing.code}`,
    chat: { id: -10, type: 'group' },
    from: { id: 42, is_bot: false },
  } })
  assert.equal(service.status().state, 'pairing')

  await service.processUpdate({ message: {
    text: '/pair WRONGCODE',
    chat: { id: 42, type: 'private' },
    from: { id: 42, is_bot: false },
  } })
  assert.equal(service.status().state, 'pairing')

  now += 1_001
  await service.processUpdate({ message: {
    text: `/pair ${pairing.code}`,
    chat: { id: 42, type: 'private' },
    from: { id: 42, is_bot: false },
  } })
  assert.equal(service.status().state, 'verified')
  assert.equal(telegram.calls.filter((call) => call.method === 'sendMessage').length, 0)
})

test('successful pairing exposes a real connection identity and sendMessage stays bound to its chat', async () => {
  const { service, telegram } = await pairedService()
  const status = service.status()
  assert.equal(status.state, 'connected')
  assert.ok(status.connectionId)
  assert.equal(status.telegramAccount.id, '4242')
  assert.equal(status.telegramAccount.username, 'owner')
  assert.equal(status.chatId, '4242')
  assert.ok(Date.parse(status.confirmedAt))

  const delivery = await service.sendMessage('real delivery')
  assert.equal(delivery.connectionId, status.connectionId)
  assert.equal(delivery.deliveries[0].messageId, 101)
  const send = telegram.calls.filter((call) => call.method === 'sendMessage').at(-1)
  assert.deepEqual(send.payload, { chat_id: '4242', text: 'real delivery' })

  const revoked = await service.revokeLocalConnection()
  assert.equal(revoked.botTokenRevoked, false)
  assert.equal(service.status().state, 'disconnected')
  await assert.rejects(service.sendMessage('must not send'), { code: 'not_connected' })
})

test('ordinary bound messages create exact approval controls and run only after authenticated approval', async () => {
  const runnerCalls = []
  const chatRunner = {
    run: async (request) => {
      runnerCalls.push(request)
      return { response: 'Task complete', provider: 'codex' }
    },
  }
  const { service, telegram } = await pairedService({ chatRunner })
  service.setTaskContext(selectedTaskContext())

  await service.processUpdate({ message: {
    message_id: 2,
    text: 'Fix the exact failing test',
    chat: { id: 4242, type: 'private' },
    from: { id: 4242, is_bot: false },
  } })
  assert.equal(runnerCalls.length, 0)
  const approvalSend = telegram.calls.filter((call) => call.method === 'sendMessage').at(-1)
  assert.match(approvalSend.payload.text, /Project: Ensync \(relay-project\)/)
  assert.match(approvalSend.payload.text, /Conversation: conversation-17/)
  assert.match(approvalSend.payload.text, /Provider: codex/)
  assert.match(approvalSend.payload.text, /Action: Fix the exact failing test/)
  const approveData = approvalSend.payload.reply_markup.inline_keyboard[0][0].callback_data
  const approvalId = service.status().pendingApprovals[0].id
  assert.ok(Buffer.byteLength(approveData) <= 64)

  await service.processUpdate({ callback_query: {
    id: 'wrong-sender',
    data: approveData,
    from: { id: 9000, is_bot: false },
    message: { message_id: 101, chat: { id: 4242, type: 'private' } },
  } })
  assert.equal(runnerCalls.length, 0)

  await service.processUpdate({ callback_query: {
    id: 'tampered',
    data: `${approveData.slice(0, -1)}X`,
    from: { id: 4242, is_bot: false },
    message: { message_id: 101, chat: { id: 4242, type: 'private' } },
  } })
  assert.equal(runnerCalls.length, 0)

  await service.processUpdate({ callback_query: {
    id: 'approved',
    data: approveData,
    from: { id: 4242, is_bot: false },
    message: { message_id: 101, chat: { id: 4242, type: 'private' } },
  } })
  assert.equal(runnerCalls.length, 1)
  assert.deepEqual(runnerCalls[0], {
    source: 'telegram',
    connectionId: service.status().connectionId,
    approvalId,
    approvedAt: new Date(1_800_000_000_000).toISOString(),
    approvedByTelegramUserId: '4242',
    projectId: 'relay-project',
    projectPath: '/Users/example/dev/relay',
    conversationId: 'conversation-17',
    provider: 'codex',
    prompt: 'Fix the exact failing test',
    approvalScope: 'task_start_only',
    toolApprovalMode: 'host_required',
    safeFallback: 'host_router_pre_mutation_only',
  })
  assert.equal(
    telegram.calls.some((call) => call.method === 'sendMessage' && call.payload.text === 'Task complete'),
    true,
  )

  await service.processUpdate({ callback_query: {
    id: 'replay',
    data: approveData,
    from: { id: 4242, is_bot: false },
    message: { message_id: 101, chat: { id: 4242, type: 'private' } },
  } })
  assert.equal(runnerCalls.length, 1)
})

test('expired approval callbacks cannot execute and missing runners remain honest', async () => {
  const runnerCalls = []
  const { service, telegram, nowRef } = await pairedService({
    approvalTtlMs: 100,
    chatRunner: { run: async (request) => { runnerCalls.push(request); return { response: 'no' } } },
  })
  service.setTaskContext(selectedTaskContext())
  await service.processUpdate({ message: {
    text: 'Expired work',
    chat: { id: 4242, type: 'private' },
    from: { id: 4242, is_bot: false },
  } })
  const approvalSend = telegram.calls.filter((call) => call.method === 'sendMessage').at(-1)
  const approveData = approvalSend.payload.reply_markup.inline_keyboard[0][0].callback_data
  nowRef.value += 101
  await service.processUpdate({ callback_query: {
    id: 'expired',
    data: approveData,
    from: { id: 4242, is_bot: false },
    message: { message_id: 101, chat: { id: 4242, type: 'private' } },
  } })
  assert.equal(runnerCalls.length, 0)
  assert.equal(
    telegram.calls.some((call) => call.method === 'answerCallbackQuery' && call.payload.text.includes('expired')),
    true,
  )

  const withoutRunner = await pairedService()
  withoutRunner.service.setTaskContext(selectedTaskContext())
  await withoutRunner.service.processUpdate({ message: {
    text: 'Cannot execute silently',
    chat: { id: 4242, type: 'private' },
    from: { id: 4242, is_bot: false },
  } })
  const pendingSend = withoutRunner.telegram.calls.filter((call) => call.method === 'sendMessage').at(-1)
  await withoutRunner.service.processUpdate({ callback_query: {
    id: 'approved-without-runner',
    data: pendingSend.payload.reply_markup.inline_keyboard[0][0].callback_data,
    from: { id: 4242, is_bot: false },
    message: { message_id: 101, chat: { id: 4242, type: 'private' } },
  } })
  assert.equal(
    withoutRunner.telegram.calls.some((call) =>
      call.method === 'sendMessage' && call.payload.text.includes('Nothing was executed')),
    true,
  )
})

test('getUpdates advances offset and long polling is abortable', async () => {
  const telegram = fakeTelegram({ updateBatches: [[
    { update_id: 40 },
    { update_id: 41 },
  ], []] })
  const service = new TelegramBridgeService({
    fetch: telegram.fetch,
    randomBytes: deterministicBytes(),
    autoPoll: false,
  })
  await service.startPairing(BOT_TOKEN)
  assert.equal(await service.pollOnce(), 2)
  assert.equal(await service.pollOnce(), 0)
  const polls = telegram.calls.filter((call) => call.method === 'getUpdates')
  assert.equal(polls[0].payload.offset, 0)
  assert.equal(polls[1].payload.offset, 42)
  assert.deepEqual(polls[0].payload.allowed_updates, ['message', 'callback_query'])

  const hangingTelegram = fakeTelegram({ hangGetUpdates: true })
  const hangingService = new TelegramBridgeService({
    fetch: hangingTelegram.fetch,
    randomBytes: deterministicBytes(),
    autoPoll: false,
  })
  await hangingService.startPairing(BOT_TOKEN)
  hangingService.startPolling()
  await new Promise((resolve) => setImmediate(resolve))
  await hangingService.stopPolling()
  const hangingPoll = hangingTelegram.calls.find((call) => call.method === 'getUpdates')
  assert.equal(hangingPoll.signal.aborted, true)
})
