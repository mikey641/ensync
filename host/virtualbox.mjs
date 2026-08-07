import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access, lstat, realpath, stat } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join, parse, resolve, win32 } from 'node:path'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_OUTPUT_BYTES = 512 * 1024
const INSTALL_URL = 'https://www.virtualbox.org/wiki/Downloads'
const VM_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,79}$/u

export class VirtualBoxError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'VirtualBoxError'
    this.code = options.code ?? 'virtualbox_error'
    this.status = options.status ?? 400
    this.partialState = options.partialState ?? null
  }
}

function platformAbsolute(path, platform) {
  return platform === 'win32' ? win32.isAbsolute(path) : isAbsolute(path)
}

function executableNames(platform, env) {
  if (platform !== 'win32') return ['VBoxManage']
  const extensions = (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .filter(Boolean)
  return extensions.map((extension) => `VBoxManage${extension}`)
}

async function defaultFileAccessible(path, platform, mode = 'execute') {
  try {
    const info = await stat(path)
    if (!info.isFile()) return false
    const accessMode = mode === 'read'
      ? fsConstants.R_OK
      : platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK
    await access(path, accessMode)
    return true
  } catch {
    return false
  }
}

function discoveryCandidates(platform, env) {
  const candidates = []
  if (platform === 'darwin') {
    candidates.push(
      '/Applications/VirtualBox.app/Contents/MacOS/VBoxManage',
      '/opt/homebrew/bin/VBoxManage',
      '/usr/local/bin/VBoxManage',
    )
  } else if (platform === 'win32') {
    for (const root of [env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)']]) {
      if (root) candidates.push(win32.join(root, 'Oracle', 'VirtualBox', 'VBoxManage.exe'))
    }
  }

  const pathValue = env.PATH ?? env.Path ?? env.path ?? ''
  const pathDelimiter = platform === 'win32' ? ';' : delimiter
  for (const directory of pathValue.split(pathDelimiter).filter(Boolean)) {
    const cleanDirectory = directory.replace(/^"|"$/g, '')
    for (const name of executableNames(platform, env)) {
      candidates.push(platform === 'win32' ? win32.join(cleanDirectory, name) : join(cleanDirectory, name))
    }
  }
  return [...new Set(candidates)]
}

export async function discoverVBoxManage(options = {}) {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const fileAccessible = options.fileAccessible ?? defaultFileAccessible

  for (const candidate of discoveryCandidates(platform, env)) {
    if (await fileAccessible(candidate, platform, 'execute')) return candidate
  }
  return null
}

export function runVBoxManage(executable, args, options = {}) {
  if (typeof executable !== 'string' || !executable || !Array.isArray(args)
    || args.some((arg) => typeof arg !== 'string')) {
    throw new TypeError('VBoxManage requires an executable and an array of string arguments.')
  }

  return new Promise((resolvePromise) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    let stdout = ''
    let stderr = ''
    let outputBytes = 0
    let settled = false
    let overflow = false

    const append = (current, chunk) => {
      outputBytes += chunk.length
      if (outputBytes > MAX_OUTPUT_BYTES) {
        overflow = true
        child.kill()
        return current
      }
      return current + chunk.toString('utf8')
    }
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk) })
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk) })

    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({
        ...result,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        overflow,
      })
    }
    child.on('error', (error) => finish({ exitCode: null, signal: null, error: error.message, timedOut: false }))
    child.on('close', (exitCode, signal) => finish({ exitCode, signal, error: null, timedOut: false }))
    const timer = setTimeout(() => {
      child.kill()
      finish({ exitCode: null, signal: null, error: null, timedOut: true })
    }, timeoutMs)
    timer.unref()
  })
}

function firstErrorLine(result, fallback) {
  if (result.overflow) return 'VBoxManage produced too much output.'
  if (result.timedOut) return 'VBoxManage timed out.'
  if (result.error) return result.error
  return result.stderr.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? fallback
}

async function checkedVBox(executable, args, options = {}) {
  const runner = options.runner ?? runVBoxManage
  const result = await runner(executable, args, options)
  if (result.exitCode !== 0 || result.error || result.timedOut || result.overflow) {
    throw new VirtualBoxError(
      firstErrorLine(result, options.failureMessage ?? 'VBoxManage could not complete the operation.'),
      { code: options.code ?? 'virtualbox_command_failed', status: options.status ?? 409 },
    )
  }
  return result
}

async function resolveRuntime(options = {}) {
  const executable = options.executable ?? await discoverVBoxManage(options)
  if (!executable) {
    throw new VirtualBoxError('Oracle VirtualBox is not installed or VBoxManage could not be found.', {
      code: 'virtualbox_unavailable',
      status: 503,
    })
  }
  return executable
}

function unquoteMachineValue(value) {
  if (!(value.startsWith('"') && value.endsWith('"'))) return value
  return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
}

export function parseMachineReadable(output) {
  const values = {}
  for (const line of String(output).split(/\r?\n/)) {
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    values[line.slice(0, separator).trim()] = unquoteMachineValue(line.slice(separator + 1).trim())
  }
  return values
}

export function parseRegisteredVirtualMachines(output) {
  const machines = []
  for (const line of String(output).split(/\r?\n/)) {
    const match = line.match(/^"((?:[^"\\]|\\.)*)"\s+\{([0-9a-f-]+)\}$/i)
    if (!match) continue
    machines.push({
      name: match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'),
      uuid: match[2],
    })
  }
  return machines
}

function parseNatForward(value) {
  const fields = String(value).split(',')
  if (fields.length < 6) return null
  const hostPort = Number(fields[3])
  const guestPort = Number(fields[5])
  if (!Number.isInteger(hostPort) || !Number.isInteger(guestPort)) return null
  return {
    name: fields[0],
    protocol: fields[1].toLowerCase(),
    hostIp: fields[2] || null,
    hostPort,
    guestIp: fields[4] || null,
    guestPort,
  }
}

export function virtualMachineFromInfo(values, fallback = {}) {
  const natForwards = Object.entries(values)
    .filter(([key]) => /^(?:natpf\d+|Forwarding\(\d+\))$/i.test(key))
    .map(([, value]) => parseNatForward(value))
    .filter(Boolean)
  return {
    name: values.name ?? fallback.name ?? null,
    uuid: values.UUID ?? fallback.uuid ?? null,
    state: values.VMState ?? 'unknown',
    configFile: values.CfgFile ?? null,
    networkMode: values.nic1 ?? null,
    natForwards,
    sshForwards: natForwards.filter((forward) => forward.protocol === 'tcp' && forward.guestPort === 22),
  }
}

export async function inspectVirtualMachine(identifier, options = {}) {
  if (typeof identifier !== 'string' || !identifier.trim() || /[\0\r\n]/.test(identifier)) {
    throw new VirtualBoxError('Select a valid VirtualBox VM.', { code: 'invalid_virtualbox_vm' })
  }
  const executable = await resolveRuntime(options)
  const result = await checkedVBox(executable, ['showvminfo', identifier.trim(), '--machinereadable'], {
    ...options,
    failureMessage: `VirtualBox could not inspect VM ${identifier.trim()}.`,
    code: 'virtualbox_vm_not_found',
  })
  return virtualMachineFromInfo(parseMachineReadable(result.stdout), { name: identifier.trim() })
}

export async function listVirtualMachines(options = {}) {
  const executable = await resolveRuntime(options)
  const listed = await checkedVBox(executable, ['list', 'vms'], {
    ...options,
    failureMessage: 'VirtualBox could not list registered VMs.',
  })
  const registrations = parseRegisteredVirtualMachines(listed.stdout)
  const machines = []
  for (const registration of registrations) {
    try {
      machines.push(await inspectVirtualMachine(registration.uuid, { ...options, executable }))
    } catch (error) {
      machines.push({
        ...registration,
        state: 'unknown',
        configFile: null,
        networkMode: null,
        natForwards: [],
        sshForwards: [],
        inspectionError: error instanceof Error ? error.message : 'VirtualBox could not inspect this VM.',
      })
    }
  }
  return machines
}

export async function getVirtualBoxStatus(options = {}) {
  const executable = await discoverVBoxManage(options)
  if (!executable) {
    return {
      installed: false,
      executable: null,
      version: null,
      installUrl: INSTALL_URL,
      reason: 'VBoxManage was not found in the Oracle installation folder or on PATH.',
      checkedAt: new Date().toISOString(),
    }
  }
  try {
    const result = await checkedVBox(executable, ['--version'], {
      ...options,
      failureMessage: 'VBoxManage was found but did not report its version.',
    })
    return {
      installed: true,
      executable,
      version: result.stdout || null,
      installUrl: INSTALL_URL,
      reason: result.stdout ? null : 'VBoxManage returned an empty version.',
      checkedAt: new Date().toISOString(),
    }
  } catch (error) {
    return {
      installed: true,
      executable,
      version: null,
      installUrl: INSTALL_URL,
      reason: error instanceof Error ? error.message : 'VBoxManage version check failed.',
      checkedAt: new Date().toISOString(),
    }
  }
}

function numberInRange(value, label, minimum, maximum) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new VirtualBoxError(`${label} must be a whole number from ${minimum} to ${maximum}.`, {
      code: 'invalid_virtualbox_plan',
    })
  }
  return number
}

async function mustBeDirectory(path, label) {
  try {
    const info = await stat(path)
    if (!info.isDirectory()) throw new Error('not-directory')
    await access(path, fsConstants.R_OK | fsConstants.W_OK)
  } catch {
    throw new VirtualBoxError(`${label} must be an existing readable and writable directory.`, {
      code: 'invalid_virtualbox_path',
    })
  }
}

async function mustNotExist(path, label) {
  try {
    await lstat(path)
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return
    throw new VirtualBoxError(`Ensync Host could not inspect ${label}.`, { code: 'invalid_virtualbox_path' })
  }
  throw new VirtualBoxError(`${label} already exists. Ensync will not overwrite it.`, {
    code: 'virtualbox_target_exists',
    status: 409,
  })
}

async function validateProvisionInput(input, options = {}) {
  if (!input || typeof input !== 'object') {
    throw new VirtualBoxError('A VirtualBox provisioning plan is required.', { code: 'invalid_virtualbox_plan' })
  }
  const platform = options.platform ?? process.platform
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!VM_NAME_PATTERN.test(name) || name === '.' || name === '..' || /[ .]$/.test(name)) {
    throw new VirtualBoxError('VM name must start with a letter or number and use only letters, numbers, spaces, dots, underscores, or hyphens.', {
      code: 'invalid_virtualbox_name',
    })
  }

  const isoPath = typeof input.isoPath === 'string' ? input.isoPath.trim() : ''
  const baseFolderInput = typeof input.baseFolder === 'string' ? input.baseFolder.trim() : ''
  const diskPathInput = typeof input.diskPath === 'string' ? input.diskPath.trim() : ''
  for (const [value, label] of [[isoPath, 'ISO path'], [baseFolderInput, 'VM base folder'], [diskPathInput, 'virtual disk path']]) {
    if (!value || !platformAbsolute(value, platform) || /[\0\r\n]/.test(value)) {
      throw new VirtualBoxError(`${label} must be an absolute local path.`, { code: 'invalid_virtualbox_path' })
    }
  }

  let canonicalIso
  try {
    canonicalIso = await realpath(isoPath)
    const info = await stat(canonicalIso)
    if (!info.isFile()) throw new Error('not-file')
    await access(canonicalIso, fsConstants.R_OK)
  } catch {
    throw new VirtualBoxError('ISO path must identify an existing readable file.', {
      code: 'invalid_virtualbox_iso',
    })
  }

  const baseFolder = resolve(baseFolderInput)
  const diskPath = resolve(diskPathInput)
  if (baseFolder === parse(baseFolder).root || diskPath === parse(diskPath).root) {
    throw new VirtualBoxError('Filesystem roots cannot be used as VirtualBox target paths.', {
      code: 'invalid_virtualbox_path',
    })
  }
  await mustBeDirectory(baseFolder, 'VM base folder')
  const machineFolder = join(baseFolder, name)
  const diskParent = dirname(diskPath)
  if (diskParent !== machineFolder) {
    await mustBeDirectory(diskParent, 'Virtual disk parent folder')
  }
  await mustNotExist(machineFolder, 'VM machine folder')
  await mustNotExist(diskPath, 'Virtual disk')

  return {
    name,
    cpuCount: numberInRange(input.cpuCount, 'CPU count', 1, 32),
    memoryMb: numberInRange(input.memoryMb, 'RAM in MB', 1024, 131072),
    diskSizeGb: numberInRange(input.diskSizeGb, 'Disk size in GB', 8, 2048),
    hostSshPort: numberInRange(input.hostSshPort, 'Host SSH port', 1024, 65535),
    isoPath: canonicalIso,
    baseFolder,
    diskPath,
  }
}

function provisionSteps(plan) {
  const diskSizeMb = plan.diskSizeGb * 1024
  return [
    {
      id: 'register-machine',
      label: 'Register the VM',
      args: ['createvm', '--name', plan.name, '--ostype', 'Ubuntu_64', '--basefolder', plan.baseFolder, '--register'],
    },
    {
      id: 'configure-machine',
      label: 'Configure CPU, RAM, boot order, NAT, and SSH forwarding',
      args: [
        'modifyvm', plan.name,
        '--cpus', String(plan.cpuCount),
        '--memory', String(plan.memoryMb),
        '--ioapic', 'on',
        '--boot1', 'dvd', '--boot2', 'disk', '--boot3', 'none', '--boot4', 'none',
        '--nic1', 'nat',
        '--natpf1', `ensync-ssh,tcp,127.0.0.1,${plan.hostSshPort},,22`,
      ],
    },
    {
      id: 'create-disk',
      label: 'Create a dynamically allocated VDI disk',
      args: ['createmedium', 'disk', '--filename', plan.diskPath, '--size', String(diskSizeMb), '--format', 'VDI', '--variant', 'Standard'],
    },
    {
      id: 'add-disk-controller',
      label: 'Add the SATA disk controller',
      args: ['storagectl', plan.name, '--name', 'SATA Controller', '--add', 'sata', '--controller', 'IntelAhci'],
    },
    {
      id: 'attach-disk',
      label: 'Attach the virtual disk',
      args: ['storageattach', plan.name, '--storagectl', 'SATA Controller', '--port', '0', '--device', '0', '--type', 'hdd', '--medium', plan.diskPath],
    },
    {
      id: 'add-iso-controller',
      label: 'Add the installation-media controller',
      args: ['storagectl', plan.name, '--name', 'IDE Controller', '--add', 'ide', '--controller', 'PIIX4'],
    },
    {
      id: 'attach-iso',
      label: 'Attach the operating-system ISO',
      args: ['storageattach', plan.name, '--storagectl', 'IDE Controller', '--port', '0', '--device', '0', '--type', 'dvddrive', '--medium', plan.isoPath],
    },
  ]
}

function publicStep(step, status = 'pending', error = null) {
  return { id: step.id, label: step.label, status, error }
}

async function ensureNoVirtualBoxConflict(plan, options, executable) {
  const machines = await listVirtualMachines({ ...options, executable })
  if (machines.some((machine) => machine.name === plan.name)) {
    throw new VirtualBoxError(`A VirtualBox VM named ${plan.name} already exists.`, {
      code: 'virtualbox_vm_exists',
      status: 409,
    })
  }
  if (machines.some((machine) => machine.sshForwards.some((forward) => forward.hostPort === plan.hostSshPort))) {
    throw new VirtualBoxError(`Host SSH port ${plan.hostSshPort} is already forwarded by another VirtualBox VM.`, {
      code: 'virtualbox_ssh_port_in_use',
      status: 409,
    })
  }
}

export async function previewVirtualMachine(input, options = {}) {
  const executable = await resolveRuntime(options)
  const plan = await validateProvisionInput(input, options)
  await ensureNoVirtualBoxConflict(plan, options, executable)
  return {
    plan,
    executable,
    confirmation: `CREATE VM ${plan.name}`,
    steps: provisionSteps(plan).map((step) => publicStep(step)),
    startsAutomatically: false,
    installationState: 'not_started',
    installationNotice: 'Provisioning attaches the ISO but does not install the guest OS. Start the VM separately and complete the ISO installer.',
    previewedAt: new Date().toISOString(),
  }
}

export async function provisionVirtualMachine(input, options = {}) {
  if (options.allowMutation !== true) {
    throw new VirtualBoxError('VirtualBox provisioning is disabled by the Ensync Host configuration.', {
      code: 'virtualbox_mutation_disabled',
      status: 403,
    })
  }
  const preview = await previewVirtualMachine(input, options)
  if (input.confirmation !== preview.confirmation) {
    throw new VirtualBoxError(`Type ${preview.confirmation} exactly to create this VM.`, {
      code: 'virtualbox_confirmation_required',
      status: 409,
    })
  }

  const internalSteps = provisionSteps(preview.plan)
  const steps = internalSteps.map((step) => publicStep(step))
  for (let index = 0; index < internalSteps.length; index += 1) {
    const step = internalSteps[index]
    steps[index] = publicStep(step, 'running')
    options.onStep?.(steps[index], [...steps])
    try {
      await checkedVBox(preview.executable, step.args, {
        ...options,
        failureMessage: `${step.label} failed.`,
      })
      steps[index] = publicStep(step, 'completed')
      options.onStep?.(steps[index], [...steps])
    } catch (error) {
      const message = error instanceof Error ? error.message : `${step.label} failed.`
      steps[index] = publicStep(step, 'failed', message)
      options.onStep?.(steps[index], [...steps])
      throw new VirtualBoxError(
        `${message} Ensync did not delete completed work; inspect the partial VM before retrying.`,
        {
          code: 'virtualbox_provision_failed',
          status: 409,
          partialState: {
            name: preview.plan.name,
            steps,
            recovery: 'Open VirtualBox Manager or inspect the VM in Ensync. Resolve the failed step before retrying; existing machines and disks are never overwritten.',
            installationState: 'not_started',
          },
        },
      )
    }
  }

  return {
    machine: await inspectVirtualMachine(preview.plan.name, { ...options, executable: preview.executable }),
    plan: preview.plan,
    steps,
    started: false,
    installationState: 'not_started',
    installationNotice: preview.installationNotice,
    completedAt: new Date().toISOString(),
  }
}

export async function startVirtualMachine(input, options = {}) {
  if (options.allowMutation !== true) {
    throw new VirtualBoxError('Starting VirtualBox VMs is disabled by the Ensync Host configuration.', {
      code: 'virtualbox_mutation_disabled',
      status: 403,
    })
  }
  const name = typeof input?.name === 'string' ? input.name.trim() : ''
  if (!VM_NAME_PATTERN.test(name)) {
    throw new VirtualBoxError('Select a valid VirtualBox VM.', { code: 'invalid_virtualbox_vm' })
  }
  const confirmation = `START VM ${name}`
  if (input.confirmation !== confirmation) {
    throw new VirtualBoxError(`Type ${confirmation} exactly to start this VM.`, {
      code: 'virtualbox_start_confirmation_required',
      status: 409,
    })
  }
  const mode = input.mode === 'headless' ? 'headless' : 'gui'
  const executable = await resolveRuntime(options)
  const before = await inspectVirtualMachine(name, { ...options, executable })
  if (!['poweroff', 'saved', 'aborted'].includes(before.state)) {
    throw new VirtualBoxError(`VM ${name} cannot be started from state ${before.state}.`, {
      code: 'virtualbox_vm_not_startable',
      status: 409,
    })
  }
  await checkedVBox(executable, ['startvm', name, '--type', mode], {
    ...options,
    failureMessage: `VirtualBox could not start VM ${name}.`,
  })
  return {
    name,
    mode,
    started: true,
    installationState: 'installer_running_or_booting',
    installationNotice: 'The VM was started from the attached ISO. Ensync has not verified that the guest OS installation completed.',
    startedAt: new Date().toISOString(),
  }
}

export class VirtualBoxService {
  constructor(options = {}) {
    this.options = options
  }

  status() {
    return getVirtualBoxStatus(this.options)
  }

  list() {
    return listVirtualMachines(this.options)
  }

  inspect(input) {
    return inspectVirtualMachine(input?.name ?? input?.uuid, this.options)
  }

  preview(input) {
    return previewVirtualMachine(input, this.options)
  }

  provision(input) {
    return provisionVirtualMachine(input, this.options)
  }

  start(input) {
    return startVirtualMachine(input, this.options)
  }
}
