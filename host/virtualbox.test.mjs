import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  discoverVBoxManage,
  getVirtualBoxStatus,
  inspectVirtualMachine,
  listVirtualMachines,
  parseMachineReadable,
  parseRegisteredVirtualMachines,
  previewVirtualMachine,
  provisionVirtualMachine,
  startVirtualMachine,
  VirtualBoxError,
} from './virtualbox.mjs'

function result(stdout = '', overrides = {}) {
  return {
    exitCode: 0,
    signal: null,
    stdout,
    stderr: '',
    error: null,
    timedOut: false,
    overflow: false,
    ...overrides,
  }
}

function fixtureRunner(resolver) {
  const calls = []
  const runner = async (executable, args) => {
    calls.push({ executable, args: [...args] })
    return resolver(args, calls.length)
  }
  runner.calls = calls
  return runner
}

async function planFixture(context) {
  const root = await mkdtemp(join(tmpdir(), 'ensync-vbox-test-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const baseFolder = join(root, 'machines')
  await mkdir(baseFolder)
  const isoPath = join(root, 'ubuntu.iso')
  await writeFile(isoPath, 'fake test ISO; never passed to real VirtualBox')
  return {
    name: 'Ensync Ubuntu',
    cpuCount: 4,
    memoryMb: 8192,
    diskSizeGb: 64,
    hostSshPort: 2222,
    isoPath,
    baseFolder,
    diskPath: join(baseFolder, 'Ensync Ubuntu', 'ensync-ubuntu.vdi'),
  }
}

test('discovers official macOS and Windows VBoxManage locations without running them', async () => {
  const macPath = '/Applications/VirtualBox.app/Contents/MacOS/VBoxManage'
  assert.equal(await discoverVBoxManage({
    platform: 'darwin',
    env: { PATH: '' },
    fileAccessible: async (candidate) => candidate === macPath,
  }), macPath)

  const windowsPath = 'C:\\Program Files\\Oracle\\VirtualBox\\VBoxManage.exe'
  assert.equal(await discoverVBoxManage({
    platform: 'win32',
    env: { ProgramFiles: 'C:\\Program Files', PATH: '' },
    fileAccessible: async (candidate) => candidate === windowsPath,
  }), windowsPath)
})

test('reports only the exact VBoxManage version returned by the injected runner', async () => {
  const runner = fixtureRunner((args) => {
    assert.deepEqual(args, ['--version'])
    return result('7.1.8r168469')
  })
  const status = await getVirtualBoxStatus({
    platform: 'darwin',
    fileAccessible: async (candidate) => candidate.includes('VirtualBox.app'),
    runner,
  })
  assert.equal(status.installed, true)
  assert.equal(status.version, '7.1.8r168469')
  assert.equal(runner.calls.length, 1)
})

test('parses registered VMs and machine-readable state plus NAT SSH forwarding', async () => {
  assert.deepEqual(parseRegisteredVirtualMachines('"Ubuntu Dev" {12345678-1234-1234-1234-123456789abc}'), [
    { name: 'Ubuntu Dev', uuid: '12345678-1234-1234-1234-123456789abc' },
  ])
  assert.deepEqual(parseMachineReadable('name="Ubuntu Dev"\nVMState="running"\n'), {
    name: 'Ubuntu Dev',
    VMState: 'running',
  })

  const runner = fixtureRunner((args) => {
    if (args[0] === 'list') {
      return result('"Ubuntu Dev" {12345678-1234-1234-1234-123456789abc}')
    }
    assert.deepEqual(args, ['showvminfo', '12345678-1234-1234-1234-123456789abc', '--machinereadable'])
    return result([
      'name="Ubuntu Dev"',
      'UUID="12345678-1234-1234-1234-123456789abc"',
      'VMState="running"',
      'CfgFile="/VMs/Ubuntu Dev/Ubuntu Dev.vbox"',
      'nic1="nat"',
      'Forwarding(0)="ensync-ssh,tcp,127.0.0.1,2222,,22"',
      'natpf1="web,tcp,127.0.0.1,8080,,80"',
    ].join('\n'))
  })
  const machines = await listVirtualMachines({ executable: '/fake/VBoxManage', runner })
  assert.equal(machines.length, 1)
  assert.equal(machines[0].state, 'running')
  assert.equal(machines[0].networkMode, 'nat')
  assert.deepEqual(machines[0].sshForwards, [{
    name: 'ensync-ssh',
    protocol: 'tcp',
    hostIp: '127.0.0.1',
    hostPort: 2222,
    guestIp: null,
    guestPort: 22,
  }])
})

test('preview validates paths and returns a non-starting, manual-install plan', async (context) => {
  const input = await planFixture(context)
  const runner = fixtureRunner((args) => {
    assert.deepEqual(args, ['list', 'vms'])
    return result('')
  })
  const preview = await previewVirtualMachine(input, {
    executable: '/fake/VBoxManage',
    runner,
  })
  assert.equal(preview.confirmation, 'CREATE VM Ensync Ubuntu')
  assert.equal(preview.startsAutomatically, false)
  assert.equal(preview.installationState, 'not_started')
  assert.equal(preview.steps.length, 7)
  assert.deepEqual(preview.steps.map((step) => step.status), Array(7).fill('pending'))
  assert.match(preview.installationNotice, /does not install/i)
})

test('preview rejects an existing disk before invoking the injected runner', async (context) => {
  const input = await planFixture(context)
  await mkdir(join(input.baseFolder, input.name))
  await writeFile(input.diskPath, 'existing disk')
  const runner = fixtureRunner(() => result(''))
  await assert.rejects(
    previewVirtualMachine(input, { executable: '/fake/VBoxManage', runner }),
    (error) => error instanceof VirtualBoxError && error.code === 'virtualbox_target_exists',
  )
  assert.equal(runner.calls.length, 0)
})

test('provisioning requires the server allow flag and exact typed confirmation', async (context) => {
  const input = await planFixture(context)
  const runner = fixtureRunner(() => result(''))

  await assert.rejects(
    provisionVirtualMachine({ ...input, confirmation: `CREATE VM ${input.name}` }, {
      executable: '/fake/VBoxManage', runner,
    }),
    (error) => error instanceof VirtualBoxError && error.code === 'virtualbox_mutation_disabled',
  )
  assert.equal(runner.calls.length, 0)

  await assert.rejects(
    provisionVirtualMachine({ ...input, confirmation: input.name }, {
      executable: '/fake/VBoxManage', runner, allowMutation: true,
    }),
    (error) => error instanceof VirtualBoxError && error.code === 'virtualbox_confirmation_required',
  )
  assert.equal(runner.calls.length, 1)
})

test('provisioning uses argument arrays, reports every completed step, and never starts automatically', async (context) => {
  const input = await planFixture(context)
  const runner = fixtureRunner((args) => {
    if (args[0] === 'list') return result('')
    if (args[0] === 'showvminfo') {
      return result([
        `name="${input.name}"`,
        'UUID="12345678-1234-1234-1234-123456789abc"',
        'VMState="poweroff"',
        'nic1="nat"',
        `Forwarding(0)="ensync-ssh,tcp,127.0.0.1,${input.hostSshPort},,22"`,
      ].join('\n'))
    }
    return result('ok')
  })
  const progress = []
  const provisioned = await provisionVirtualMachine({
    ...input,
    confirmation: `CREATE VM ${input.name}`,
  }, {
    executable: '/fake/VBoxManage',
    runner,
    allowMutation: true,
    onStep: (step) => progress.push({ ...step }),
  })

  assert.equal(provisioned.started, false)
  assert.equal(provisioned.installationState, 'not_started')
  assert.equal(provisioned.steps.every((step) => step.status === 'completed'), true)
  assert.equal(progress.length, 14)
  const mutationCalls = runner.calls.filter((call) => !['list', 'showvminfo'].includes(call.args[0]))
  assert.deepEqual(mutationCalls.map((call) => call.args[0]), [
    'createvm', 'modifyvm', 'createmedium', 'storagectl', 'storageattach', 'storagectl', 'storageattach',
  ])
  assert.equal(mutationCalls.some((call) => call.args[0] === 'startvm'), false)
  assert.equal(mutationCalls[0].args.includes(input.name), true)
})

test('a failed provisioning step returns partial recovery state without cleanup commands', async (context) => {
  const input = await planFixture(context)
  const runner = fixtureRunner((args) => {
    if (args[0] === 'list') return result('')
    if (args[0] === 'createmedium') return result('', { exitCode: 1, stderr: 'disk creation failed' })
    return result('ok')
  })
  await assert.rejects(
    provisionVirtualMachine({ ...input, confirmation: `CREATE VM ${input.name}` }, {
      executable: '/fake/VBoxManage', runner, allowMutation: true,
    }),
    (error) => {
      assert.equal(error instanceof VirtualBoxError, true)
      assert.equal(error.code, 'virtualbox_provision_failed')
      assert.deepEqual(error.partialState.steps.slice(0, 3).map((step) => step.status), [
        'completed', 'completed', 'failed',
      ])
      assert.match(error.partialState.recovery, /never overwritten/i)
      return true
    },
  )
  assert.equal(runner.calls.some((call) => ['unregistervm', 'closemedium'].includes(call.args[0])), false)
})

test('starting a VM is a separate allowlisted action with its own exact confirmation', async () => {
  const runner = fixtureRunner((args) => {
    if (args[0] === 'showvminfo') return result('name="Ensync Ubuntu"\nVMState="poweroff"')
    return result('VM started')
  })
  await assert.rejects(
    startVirtualMachine({ name: 'Ensync Ubuntu', confirmation: 'yes' }, {
      executable: '/fake/VBoxManage', runner, allowMutation: true,
    }),
    (error) => error instanceof VirtualBoxError && error.code === 'virtualbox_start_confirmation_required',
  )
  assert.equal(runner.calls.length, 0)

  const started = await startVirtualMachine({
    name: 'Ensync Ubuntu',
    confirmation: 'START VM Ensync Ubuntu',
    mode: 'headless',
  }, {
    executable: '/fake/VBoxManage', runner, allowMutation: true,
  })
  assert.equal(started.started, true)
  assert.equal(started.installationState, 'installer_running_or_booting')
  assert.deepEqual(runner.calls.at(-1).args, ['startvm', 'Ensync Ubuntu', '--type', 'headless'])
  assert.match(started.installationNotice, /not verified/i)
})

test('inspect rejects unsafe identifiers before invoking VBoxManage', async () => {
  const runner = fixtureRunner(() => result(''))
  await assert.rejects(
    inspectVirtualMachine('bad\nname', { executable: '/fake/VBoxManage', runner }),
    (error) => error instanceof VirtualBoxError && error.code === 'invalid_virtualbox_vm',
  )
  assert.equal(runner.calls.length, 0)
})
