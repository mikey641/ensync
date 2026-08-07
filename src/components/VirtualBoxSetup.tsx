import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Box,
  CheckCircle2,
  ExternalLink,
  LoaderCircle,
  Play,
  RefreshCw,
  Server,
  X,
} from 'lucide-react'
import {
  virtualBoxHost,
  VirtualBoxHostError,
  type VirtualBoxClientContract,
  type VirtualBoxPartialState,
  type VirtualBoxPlan,
  type VirtualBoxPlanStep,
  type VirtualBoxProvisionInput,
  type VirtualBoxProvisionResult,
  type VirtualBoxStartResult,
  type VirtualBoxStatus,
  type VirtualMachine,
} from '../lib/virtualboxHost'
import './VirtualBoxSetup.css'

type VirtualBoxSetupProps = {
  client?: VirtualBoxClientContract
  onClose?: () => void
  onProvisioned?: (result: VirtualBoxProvisionResult) => void
  className?: string
}

const INITIAL_INPUT: VirtualBoxProvisionInput = {
  name: 'Ensync Ubuntu',
  cpuCount: 4,
  memoryMb: 8192,
  diskSizeGb: 64,
  hostSshPort: 2222,
  isoPath: '',
  baseFolder: '',
  diskPath: '',
}

function StepList({ steps }: { steps: VirtualBoxPlanStep[] }) {
  return (
    <ol className="ensync-vbox__steps">
      {steps.map((step) => (
        <li key={step.id} data-status={step.status}>
          <span aria-hidden="true">
            {step.status === 'completed' ? <CheckCircle2 size={16} /> : step.status === 'failed'
              ? <AlertTriangle size={16} /> : step.status === 'running'
                ? <LoaderCircle className="ensync-vbox__spin" size={16} /> : <span />}
          </span>
          <div>
            <strong>{step.label}</strong>
            {step.error && <small>{step.error}</small>}
          </div>
        </li>
      ))}
    </ol>
  )
}

function MachineFacts({ machine }: { machine: VirtualMachine }) {
  const ssh = machine.sshForwards[0]
  return (
    <dl className="ensync-vbox__facts">
      <div><dt>State</dt><dd>{machine.state}</dd></div>
      <div><dt>Network</dt><dd>{machine.networkMode ?? 'Not reported'}</dd></div>
      <div><dt>SSH forwarding</dt><dd>{ssh ? `${ssh.hostIp ?? '*'}:${ssh.hostPort} → guest :${ssh.guestPort}` : 'None'}</dd></div>
      <div><dt>Configuration</dt><dd title={machine.configFile ?? undefined}>{machine.configFile ?? 'Not reported'}</dd></div>
    </dl>
  )
}

export function VirtualBoxSetup({
  client = virtualBoxHost,
  onClose,
  onProvisioned,
  className = '',
}: VirtualBoxSetupProps) {
  const [status, setStatus] = useState<VirtualBoxStatus | null>(null)
  const [machines, setMachines] = useState<VirtualMachine[]>([])
  const [selected, setSelected] = useState<VirtualMachine | null>(null)
  const [input, setInput] = useState<VirtualBoxProvisionInput>(INITIAL_INPUT)
  const [plan, setPlan] = useState<VirtualBoxPlan | null>(null)
  const [provisioned, setProvisioned] = useState<VirtualBoxProvisionResult | null>(null)
  const [partial, setPartial] = useState<VirtualBoxPartialState | null>(null)
  const [confirmation, setConfirmation] = useState('')
  const [startConfirmation, setStartConfirmation] = useState('')
  const [startMode, setStartMode] = useState<'gui' | 'headless'>('gui')
  const [startResult, setStartResult] = useState<VirtualBoxStartResult | null>(null)
  const [busy, setBusy] = useState<'refresh' | 'inspect' | 'preview' | 'provision' | 'start' | null>('refresh')
  const [error, setError] = useState<string | null>(null)

  const refresh = async () => {
    setBusy('refresh')
    setError(null)
    try {
      const nextStatus = await client.status()
      setStatus(nextStatus)
      if (nextStatus.installed && nextStatus.version) {
        const response = await client.list()
        setMachines(response.machines)
        if (selected?.uuid) {
          setSelected(response.machines.find((machine) => machine.uuid === selected.uuid) ?? null)
        }
      } else {
        setMachines([])
        setSelected(null)
      }
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'Ensync Host could not inspect VirtualBox.')
    } finally {
      setBusy(null)
    }
  }

  useEffect(() => {
    void refresh()
    // The client is an injected, stable host adapter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client])

  const update = <Key extends keyof VirtualBoxProvisionInput>(
    key: Key,
    value: VirtualBoxProvisionInput[Key],
  ) => {
    setInput((current) => ({ ...current, [key]: value }))
    setPlan(null)
    setProvisioned(null)
    setPartial(null)
    setConfirmation('')
    setError(null)
  }

  const inspect = async (machine: VirtualMachine) => {
    if (!machine.name) return
    setBusy('inspect')
    setError(null)
    try {
      const response = await client.inspect(machine.name)
      setSelected(response.machine)
      setStartConfirmation('')
      setStartResult(null)
    } catch (inspectError) {
      setError(inspectError instanceof Error ? inspectError.message : 'Ensync Host could not inspect that VM.')
    } finally {
      setBusy(null)
    }
  }

  const preview = async () => {
    setBusy('preview')
    setError(null)
    setPlan(null)
    setPartial(null)
    setProvisioned(null)
    try {
      setPlan(await client.preview(input))
      setConfirmation('')
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : 'Ensync Host could not validate that VM plan.')
    } finally {
      setBusy(null)
    }
  }

  const provision = async () => {
    if (!plan || confirmation !== plan.confirmation) return
    setBusy('provision')
    setError(null)
    setPartial(null)
    try {
      const result = await client.provision({ ...plan.plan, confirmation })
      setProvisioned(result)
      setSelected(result.machine)
      setMachines((current) => [result.machine, ...current.filter((machine) => machine.uuid !== result.machine.uuid)])
      onProvisioned?.(result)
    } catch (provisionError) {
      if (provisionError instanceof VirtualBoxHostError) setPartial(provisionError.partialState)
      setError(provisionError instanceof Error ? provisionError.message : 'VirtualBox provisioning failed.')
    } finally {
      setBusy(null)
    }
  }

  const startName = provisioned?.machine.name ?? selected?.name ?? null
  const exactStartConfirmation = startName ? `START VM ${startName}` : ''
  const start = async () => {
    if (!startName || startConfirmation !== exactStartConfirmation) return
    setBusy('start')
    setError(null)
    setStartResult(null)
    try {
      setStartResult(await client.start({ name: startName, confirmation: startConfirmation, mode: startMode }))
      await refresh()
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : 'VirtualBox could not start that VM.')
    } finally {
      setBusy(null)
    }
  }

  const planReady = Boolean(status?.installed && status.version)
  const steps = provisioned?.steps ?? partial?.steps ?? plan?.steps ?? []
  const stateLabel = status === null ? 'Checking…' : status.installed
    ? status.version ? `VirtualBox ${status.version}` : 'VirtualBox detected · version unavailable'
    : 'VirtualBox not installed'
  const numericFields = useMemo(() => [
    ['cpuCount', 'CPUs', 1, 32],
    ['memoryMb', 'RAM (MB)', 1024, 131072],
    ['diskSizeGb', 'Disk (GB)', 8, 2048],
    ['hostSshPort', 'Host SSH port', 1024, 65535],
  ] as const, [])

  return (
    <section className={`ensync-vbox ${className}`.trim()} aria-labelledby="ensync-vbox-title">
      <header className="ensync-vbox__header">
        <div className="ensync-vbox__title-icon" aria-hidden="true"><Box size={20} /></div>
        <div>
          <span className="ensync-vbox__eyebrow">REMOTE RUNTIME</span>
          <h2 id="ensync-vbox-title">Oracle VirtualBox setup</h2>
          <p>Create VM hardware safely, then complete the operating-system installer from your ISO.</p>
        </div>
        <button type="button" className="ensync-vbox__icon-button" onClick={() => void refresh()} disabled={busy !== null} aria-label="Refresh VirtualBox status">
          <RefreshCw className={busy === 'refresh' ? 'ensync-vbox__spin' : ''} size={17} />
        </button>
        {onClose && <button type="button" className="ensync-vbox__icon-button" onClick={onClose} aria-label="Close VirtualBox setup"><X size={18} /></button>}
      </header>

      <div className="ensync-vbox__body">
        <div className={`ensync-vbox__status ${status?.installed && status.version ? 'is-ready' : ''}`} role="status">
          <Server size={17} aria-hidden="true" />
          <div><strong>{stateLabel}</strong><small>{status?.executable ?? status?.reason ?? 'Waiting for Ensync Host.'}</small></div>
          {status && !status.installed && <a href={status.installUrl} target="_blank" rel="noopener noreferrer">Get VirtualBox <ExternalLink size={13} /></a>}
        </div>

        {error && <div className="ensync-vbox__notice is-error" role="alert"><AlertTriangle size={17} /><span>{error}</span></div>}
        {startResult && <div className="ensync-vbox__notice is-success" role="status"><CheckCircle2 size={17} /><span>{startResult.installationNotice}</span></div>}

        {machines.length > 0 && (
          <section className="ensync-vbox__section">
            <div className="ensync-vbox__section-heading"><div><h3>Registered VMs</h3><p>Live state reported by VBoxManage.</p></div></div>
            <div className="ensync-vbox__machine-list">
              {machines.map((machine) => (
                <button type="button" key={machine.uuid ?? machine.name} className={selected?.uuid === machine.uuid ? 'is-selected' : ''} onClick={() => void inspect(machine)} disabled={busy !== null}>
                  <Box size={16} /><span><strong>{machine.name ?? machine.uuid}</strong><small>{machine.inspectionError ?? `${machine.state} · ${machine.sshForwards.length ? `SSH :${machine.sshForwards[0].hostPort}` : 'no SSH forward'}`}</small></span>
                </button>
              ))}
            </div>
            {selected && <MachineFacts machine={selected} />}
          </section>
        )}

        <section className="ensync-vbox__section">
          <div className="ensync-vbox__section-heading"><div><h3>New Ubuntu VM</h3><p>No VM, disk, or ISO is overwritten. Paths are validated by Ensync Host.</p></div></div>
          <div className="ensync-vbox__form-grid">
            <label className="is-wide"><span>VM name</span><input value={input.name} onChange={(event) => update('name', event.target.value)} disabled={!planReady || busy !== null} /></label>
            {numericFields.map(([key, label, min, max]) => (
              <label key={key}><span>{label}</span><input type="number" min={min} max={max} value={input[key]} onChange={(event) => update(key, Number(event.target.value))} disabled={!planReady || busy !== null} /></label>
            ))}
            <label className="is-wide"><span>Absolute ISO path</span><input value={input.isoPath} onChange={(event) => update('isoPath', event.target.value)} placeholder="/absolute/path/to/ubuntu.iso" disabled={!planReady || busy !== null} /></label>
            <label className="is-wide"><span>Absolute VM base folder</span><input value={input.baseFolder} onChange={(event) => update('baseFolder', event.target.value)} placeholder="/absolute/path/to/VirtualBox VMs" disabled={!planReady || busy !== null} /></label>
            <label className="is-wide"><span>Absolute VDI disk path</span><input value={input.diskPath} onChange={(event) => update('diskPath', event.target.value)} placeholder="/base/Ensync Ubuntu/ensync-ubuntu.vdi" disabled={!planReady || busy !== null} /></label>
          </div>
          <button className="ensync-vbox__primary" type="button" onClick={() => void preview()} disabled={!planReady || busy !== null}>
            {busy === 'preview' && <LoaderCircle className="ensync-vbox__spin" size={16} />}
            Preview creation plan
          </button>
        </section>

        {steps.length > 0 && (
          <section className="ensync-vbox__section">
            <div className="ensync-vbox__section-heading"><div><h3>{provisioned ? 'Provisioning completed' : partial ? 'Partial VM requires attention' : 'Creation plan'}</h3><p>{partial?.recovery ?? plan?.installationNotice ?? provisioned?.installationNotice}</p></div></div>
            <StepList steps={steps} />
            {plan && !provisioned && !partial && (
              <div className="ensync-vbox__confirmation">
                <label><span>Type <code>{plan.confirmation}</code> to continue</span><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={busy !== null} /></label>
                <button className="ensync-vbox__primary" type="button" onClick={() => void provision()} disabled={busy !== null || confirmation !== plan.confirmation}>
                  {busy === 'provision' && <LoaderCircle className="ensync-vbox__spin" size={16} />}Create VM
                </button>
              </div>
            )}
          </section>
        )}

        {startName && ['poweroff', 'saved', 'aborted'].includes(selected?.state ?? provisioned?.machine.state ?? '') && (
          <section className="ensync-vbox__section ensync-vbox__start">
            <div className="ensync-vbox__section-heading"><div><h3>Start {startName}</h3><p>Starting is separate from creation. The ISO installer still needs to run inside the VM.</p></div></div>
            <div className="ensync-vbox__start-controls">
              <label><span>Window mode</span><select value={startMode} onChange={(event) => setStartMode(event.target.value as 'gui' | 'headless')} disabled={busy !== null}><option value="gui">Open VirtualBox window</option><option value="headless">Headless</option></select></label>
              <label><span>Type <code>{exactStartConfirmation}</code></span><input value={startConfirmation} onChange={(event) => setStartConfirmation(event.target.value)} disabled={busy !== null} /></label>
              <button className="ensync-vbox__primary" type="button" onClick={() => void start()} disabled={busy !== null || startConfirmation !== exactStartConfirmation}><Play size={15} />Start VM</button>
            </div>
          </section>
        )}
      </div>
    </section>
  )
}
