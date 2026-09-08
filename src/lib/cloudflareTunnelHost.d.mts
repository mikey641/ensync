export type CloudflareQuickTunnelStatus = {
  enabled: boolean
  running: boolean
  url: string | null
  pid: number | null
}

export type CloudflareTunnelStatus = {
  configured: boolean
  hostname: string | null
  url: string | null
  binaryInstalled: boolean
  running: boolean
  pid: number | null
  quick: CloudflareQuickTunnelStatus
}

export type CloudflareTunnelResult = {
  ok: boolean
  error?: string
  status?: CloudflareTunnelStatus
  quick?: { running: boolean; url: string | null }
}

export function cloudflareTunnelAvailable(target?: typeof globalThis): boolean
export function readCloudflareTunnelStatus(target?: typeof globalThis): Promise<CloudflareTunnelStatus>
export function setupCloudflareTunnel(
  input: { domain: string; hostname: string; apiToken: string },
  target?: typeof globalThis,
): Promise<CloudflareTunnelResult>
export function startCloudflareTunnel(target?: typeof globalThis): Promise<CloudflareTunnelResult>
export function stopCloudflareTunnel(target?: typeof globalThis): Promise<CloudflareTunnelResult>
export function clearCloudflareTunnel(target?: typeof globalThis): Promise<CloudflareTunnelResult>
export function startCloudflareQuickTunnel(target?: typeof globalThis): Promise<CloudflareTunnelResult>
export function stopCloudflareQuickTunnel(target?: typeof globalThis): Promise<CloudflareTunnelResult>
