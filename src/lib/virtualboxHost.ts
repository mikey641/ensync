export type VirtualBoxStatus = {
  installed: boolean
  executable: string | null
  version: string | null
  installUrl: string
  reason: string | null
  checkedAt: string
}

export type VirtualBoxNatForward = {
  name: string
  protocol: string
  hostIp: string | null
  hostPort: number
  guestIp: string | null
  guestPort: number
}

export type VirtualMachine = {
  name: string | null
  uuid: string | null
  state: string
  configFile: string | null
  networkMode: string | null
  natForwards: VirtualBoxNatForward[]
  sshForwards: VirtualBoxNatForward[]
  inspectionError?: string
}

export type VirtualBoxProvisionInput = {
  name: string
  cpuCount: number
  memoryMb: number
  diskSizeGb: number
  hostSshPort: number
  isoPath: string
  baseFolder: string
  diskPath: string
}

export type VirtualBoxPlanStep = {
  id: string
  label: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  error: string | null
}

export type VirtualBoxPlan = {
  plan: VirtualBoxProvisionInput
  executable: string
  confirmation: string
  steps: VirtualBoxPlanStep[]
  startsAutomatically: false
  installationState: 'not_started'
  installationNotice: string
  previewedAt: string
}

export type VirtualBoxProvisionResult = {
  machine: VirtualMachine
  plan: VirtualBoxProvisionInput
  steps: VirtualBoxPlanStep[]
  started: false
  installationState: 'not_started'
  installationNotice: string
  completedAt: string
}

export type VirtualBoxPartialState = {
  name: string
  steps: VirtualBoxPlanStep[]
  recovery: string
  installationState: 'not_started'
}

export type VirtualBoxStartResult = {
  name: string
  mode: 'gui' | 'headless'
  started: true
  installationState: 'installer_running_or_booting'
  installationNotice: string
  startedAt: string
}

type ErrorPayload = {
  error?: string
  code?: string
  partialState?: VirtualBoxPartialState | null
}

export class VirtualBoxHostError extends Error {
  status: number
  code: string | null
  partialState: VirtualBoxPartialState | null

  constructor(message: string, status: number, payload: ErrorPayload | null) {
    super(message)
    this.name = 'VirtualBoxHostError'
    this.status = status
    this.code = payload?.code ?? null
    this.partialState = payload?.partialState ?? null
  }
}

export interface VirtualBoxClientContract {
  status(): Promise<VirtualBoxStatus>
  list(): Promise<{ machines: VirtualMachine[] }>
  inspect(name: string): Promise<{ machine: VirtualMachine }>
  preview(input: VirtualBoxProvisionInput): Promise<VirtualBoxPlan>
  provision(input: VirtualBoxProvisionInput & { confirmation: string }): Promise<VirtualBoxProvisionResult>
  start(input: {
    name: string
    confirmation: string
    mode: 'gui' | 'headless'
  }): Promise<VirtualBoxStartResult>
}

export class VirtualBoxHostClient implements VirtualBoxClientContract {
  readonly baseUrl: string

  constructor(baseUrl = '/api') {
    this.baseUrl = baseUrl.replace(/\/$/, '')
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    })
    const payload = await response.json() as T | ErrorPayload
    if (!response.ok) {
      const error = payload as ErrorPayload
      throw new VirtualBoxHostError(
        error.error ?? `Ensync Host request failed (${response.status}).`,
        response.status,
        error,
      )
    }
    return payload as T
  }

  status() {
    return this.request<VirtualBoxStatus>('/virtualbox/status')
  }

  list() {
    return this.request<{ machines: VirtualMachine[] }>('/virtualbox/vms')
  }

  inspect(name: string) {
    return this.request<{ machine: VirtualMachine }>('/virtualbox/inspect', {
      method: 'POST',
      body: JSON.stringify({ name }),
    })
  }

  preview(input: VirtualBoxProvisionInput) {
    return this.request<VirtualBoxPlan>('/virtualbox/preview', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  provision(input: VirtualBoxProvisionInput & { confirmation: string }) {
    return this.request<VirtualBoxProvisionResult>('/virtualbox/provision', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  start(input: { name: string; confirmation: string; mode: 'gui' | 'headless' }) {
    return this.request<VirtualBoxStartResult>('/virtualbox/start', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }
}

export const virtualBoxHost = new VirtualBoxHostClient()
