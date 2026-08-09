import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { ChatImageError, ChatImageService } from './chat-images.mjs'
import { createEnsyncHost } from './server.mjs'

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), 'ensync-chat-images-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'a'.repeat(24), 'b'.repeat(24), 'selected-project')
  await mkdir(join(workspace, 'brand'), { recursive: true })
  const image = join(workspace, 'brand', 'logo image.png')
  await writeFile(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  return { root, workspace, image }
}

test('chat images resolve relative, absolute, and file URL paths within one managed workspace', async (context) => {
  const { root, workspace, image } = await fixture(context)
  const service = new ChatImageService({ workspaceRoot: root })
  const canonicalImage = await realpath(image)

  assert.deepEqual(await service.open({ workspacePath: workspace, imagePath: 'brand/logo image.png' }), {
    path: canonicalImage,
    size: 4,
    contentType: 'image/png',
  })
  assert.equal((await service.open({ workspacePath: workspace, imagePath: image })).path, canonicalImage)
  assert.equal((await service.open({ workspacePath: workspace, imagePath: pathToFileURL(image).href })).path, canonicalImage)
})

test('chat images reject paths outside the exact conversation workspace', async (context) => {
  const { root, workspace } = await fixture(context)
  const outside = join(root, 'outside.png')
  await writeFile(outside, 'not exposed')
  const service = new ChatImageService({ workspaceRoot: root })

  await assert.rejects(
    service.open({ workspacePath: workspace, imagePath: outside }),
    (error) => error instanceof ChatImageError && error.code === 'chat_image_forbidden' && error.status === 403,
  )

  const link = join(workspace, 'brand', 'outside.png')
  try {
    await symlink(outside, link)
    await assert.rejects(
      service.open({ workspacePath: workspace, imagePath: link }),
      (error) => error instanceof ChatImageError && error.code === 'chat_image_forbidden',
    )
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error?.code)) throw error
  }
})

test('chat images reject unsupported formats and unmanaged workspace paths', async (context) => {
  const { root, workspace } = await fixture(context)
  const service = new ChatImageService({ workspaceRoot: root })
  const textFile = join(workspace, 'brand', 'notes.txt')
  await writeFile(textFile, 'not an image')

  await assert.rejects(
    service.open({ workspacePath: workspace, imagePath: textFile }),
    (error) => error instanceof ChatImageError && error.code === 'unsupported_chat_image' && error.status === 415,
  )

  const unmanaged = join(root, 'unmanaged')
  await mkdir(unmanaged)
  await assert.rejects(
    service.open({ workspacePath: unmanaged, imagePath: textFile }),
    (error) => error instanceof ChatImageError && error.code === 'chat_image_workspace_forbidden',
  )
})

test('the authenticated Host route returns a verified image with a strict media type', async (context) => {
  const { root, workspace, image } = await fixture(context)
  const authToken = 'c'.repeat(64)
  const server = createEnsyncHost({
    authToken,
    projectIsolationRoot: root,
    statusService: { list: async () => [], get: async () => null },
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  context.after(() => {
    server.closeAllConnections?.()
    server.close()
  })
  const address = server.address()
  assert.equal(typeof address, 'object')
  const search = new URLSearchParams({ workspacePath: workspace, path: image })
  const url = `http://127.0.0.1:${address.port}/api/chat/image?${search}`

  assert.equal((await fetch(url)).status, 401)
  const response = await fetch(url, { headers: { Authorization: `Bearer ${authToken}` } })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/png')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
})
