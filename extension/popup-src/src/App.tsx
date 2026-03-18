import { useState, useEffect, useRef, useCallback } from 'react'
import { sendMsg, getStorage, onStorageChange } from './lib/chrome'
import type { AppState, StateData, Summary, AudioLevels } from './types'

// ─── Sub-components ────────────────────────────────────────────────────────────

function CalendarBar() {
  const [connected, setConnected] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    sendMsg('GET_CALENDAR_STATUS').then(r => setConnected(!!r?.connected))
  }, [])

  const toggle = async () => {
    if (connected) {
      await sendMsg('DISCONNECT_CALENDAR')
      setConnected(false)
    } else {
      setConnecting(true)
      setError('')
      const r = await sendMsg('CONNECT_CALENDAR')
      setConnecting(false)
      if (r?.success) setConnected(true)
      else setError(r?.error || 'Auth failed — check OAuth setup')
    }
  }

  return (
    <div className="mb-3 rounded-lg border border-border bg-card/50 px-3 py-2 flex items-center justify-between gap-2">
      <span className="text-[11px] text-muted-foreground">
        📅 {connected ? 'Calendar connected' : error || 'Calendar not connected'}
      </span>
      <button
        onClick={toggle}
        disabled={connecting}
        className="text-[10px] px-2 py-1 rounded border border-border bg-secondary text-secondary-foreground hover:bg-accent hover:text-accent-foreground transition-colors disabled:opacity-50"
      >
        {connecting ? '...' : connected ? 'Disconnect' : 'Connect'}
      </button>
    </div>
  )
}

function AudioVisualizer({ active }: { active: boolean }) {
  const bars = 20
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [heights, setHeights] = useState<number[]>(Array(bars).fill(3))

  useEffect(() => {
    if (active) {
      intervalRef.current = setInterval(() => {
        setHeights(prev => prev.map(() => Math.random() * 44 + 3))
      }, 100)
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current)
      setHeights(Array(bars).fill(3))
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [active])

  return (
    <div className="flex items-end justify-center gap-[3px] h-14 mb-3">
      {heights.map((h, i) => (
        <div
          key={i}
          className="w-1 rounded-sm transition-all duration-75"
          style={{
            height: `${h}px`,
            background: active
              ? `linear-gradient(to top, hsl(var(--primary)), hsl(239 84% 77%))`
              : 'hsl(var(--secondary))'
          }}
        />
      ))}
    </div>
  )
}

function SourceLevels({ levels, micMuted, tabMuted, onToggleMic, onToggleTab }: {
  levels: AudioLevels
  micMuted: boolean
  tabMuted: boolean
  onToggleMic: () => void
  onToggleTab: () => void
}) {
  return (
    <div className="flex gap-2 mb-3 px-2">
      {/* MIC */}
      <div className="flex-1 flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5">
        <button onClick={onToggleMic} className={`text-sm transition-all ${micMuted ? 'opacity-30 grayscale' : 'opacity-80 hover:opacity-100'}`}>
          {micMuted ? '🔇' : '🎤'}
        </button>
        <span className="text-[8px] font-bold tracking-widest text-secondary-foreground bg-secondary rounded px-1 py-0.5">MIC</span>
        <div className="flex-1 h-1 rounded-full bg-secondary overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-75"
            style={{ width: `${Math.min(100, levels.mic * 100)}%`, background: 'linear-gradient(to right, #4ade80, #facc15)' }}
          />
        </div>
      </div>
      {/* TAB */}
      <div className="flex-1 flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5">
        <button onClick={onToggleTab} className={`text-sm transition-all ${tabMuted ? 'opacity-30 grayscale' : 'opacity-80 hover:opacity-100'}`}>
          {tabMuted ? '🔇' : '🔊'}
        </button>
        <span className="text-[8px] font-bold tracking-widest text-secondary-foreground bg-secondary rounded px-1 py-0.5">TAB</span>
        <div className="flex-1 h-1 rounded-full bg-secondary overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-75"
            style={{ width: `${Math.min(100, levels.tab * 100)}%`, background: 'linear-gradient(to right, hsl(var(--primary)), #a78bfa)' }}
          />
        </div>
      </div>
    </div>
  )
}

function LiveTranscript({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { ref.current?.scrollTo(0, ref.current.scrollHeight) }, [lines])
  if (!lines.length) return null
  return (
    <div className="mb-3 border-t border-border pt-2">
      <p className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1">Live Transcript</p>
      <div ref={ref} className="text-xs text-secondary-foreground leading-relaxed max-h-20 overflow-y-auto break-words">
        {lines.slice(-5).map((l, i) => <p key={i}>{l}</p>)}
      </div>
    </div>
  )
}

function Timer({ startTime }: { startTime: number }) {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const iv = setInterval(() => setElapsed(Math.floor((Date.now() - startTime) / 1000)), 500)
    return () => clearInterval(iv)
  }, [startTime])
  const h = Math.floor(elapsed / 3600)
  const m = Math.floor((elapsed % 3600) / 60)
  const s = elapsed % 60
  const fmt = (n: number) => String(n).padStart(2, '0')
  return <p className="text-4xl font-light font-mono text-destructive my-3 tracking-wide">{fmt(h)}:{fmt(m)}:{fmt(s)}</p>
}

function ProcessingSteps({ step }: { step: string }) {
  const steps = ['uploading', 'transcribing', 'summarizing']
  const idx = steps.indexOf(step)
  const labels = ['Upload', 'Transcribe', 'Summarize']
  return (
    <div className="flex items-center justify-center gap-2 mt-3">
      {steps.map((s, i) => {
        const isDone = i < idx
        const isActive = i === idx
        return (
          <div key={s} className="flex items-center gap-2">
            {i > 0 && <span className="text-[10px] text-muted-foreground">→</span>}
            <span className={`text-[11px] font-medium px-2.5 py-1 rounded-md border transition-all
              ${isDone ? 'bg-green-500/15 text-green-400 border-green-600'
              : isActive ? 'bg-primary/20 text-primary border-primary shadow-sm shadow-primary/30'
              : 'bg-secondary text-muted-foreground border-border'}`}>
              {labels[i]}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function SummarySection({ title, items }: { title: string; items?: string[] }) {
  if (!items?.length) return null
  return (
    <div className="mb-3">
      <h4 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1">{title}</h4>
      <ul className="space-y-0.5">
        {items.map((item, i) => (
          <li key={i} className="flex gap-2 text-xs text-secondary-foreground">
            <span className="text-primary shrink-0">•</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ─── Main App ──────────────────────────────────────────────────────────────────

export default function App() {
  const [state, setState] = useState<AppState>('idle')
  const [stateData, setStateData] = useState<StateData>({})
  const [includeMic, setIncludeMic] = useState(true)
  const [levels, setLevels] = useState<AudioLevels>({ mic: 0, tab: 0 })
  const [micMuted, setMicMuted] = useState(false)
  const [tabMuted, setTabMuted] = useState(false)
  const [liveTranscript, setLiveTranscript] = useState<string[]>([])
  const [callType, setCallType] = useState('internal')
  const [sendingSlack, setSendingSlack] = useState(false)
  const [recovery, setRecovery] = useState<{ message: string; meetingId?: string } | null>(null)

  const loadState = useCallback(async () => {
    const result = await sendMsg('GET_STATE')
    if (result) {
      setState(result.state as AppState)
      setStateData(result.data || {})
    }
    // Load recovery notice
    const stored = await getStorage<any>(['recoveryNotice', 'liveTranscript'])
    if (stored.recoveryNotice) setRecovery(stored.recoveryNotice)
    if (stored.liveTranscript) setLiveTranscript(stored.liveTranscript)
  }, [])

  useEffect(() => {
    loadState()
    const unsub = onStorageChange((changes) => {
      if (changes.extensionState) setState(changes.extensionState.newValue as AppState)
      if (changes.stateData) setStateData(changes.stateData.newValue || {})
      if (changes.audioLevels) setLevels((changes.audioLevels.newValue as AudioLevels) || { mic: 0, tab: 0 })
      if (changes.liveTranscript) setLiveTranscript((changes.liveTranscript.newValue as string[]) || [])
      if (changes.recoveryNotice) setRecovery(changes.recoveryNotice.newValue as { message: string; meetingId?: string } | null)
    })
    return unsub
  }, [loadState])

  const startRecording = () => {
    sendMsg('START_RECORDING_REQUEST', { includeMic })
  }

  const stopRecording = () => sendMsg('STOP_RECORDING')
  const cancelRecording = () => sendMsg('CANCEL_RECORDING')

  const toggleMic = async () => {
    const r = await sendMsg('TOGGLE_MIC_MUTE')
    setMicMuted(r?.muted ?? !micMuted)
  }

  const toggleTab = async () => {
    const r = await sendMsg('TOGGLE_TAB_MUTE')
    setTabMuted(r?.muted ?? !tabMuted)
  }

  const sendSlack = async () => {
    setSendingSlack(true)
    await sendMsg('SEND_TO_SLACK', { callType })
    setSendingSlack(false)
  }

  const reset = () => sendMsg('RESET')

  const recover = async () => {
    await sendMsg('RECOVER_RECORDING')
    setRecovery(null)
    loadState()
  }

  const dismissRecovery = async () => {
    await sendMsg('DISMISS_RECOVERY')
    setRecovery(null)
  }

  const summary: Summary | undefined = stateData.summary as Summary | undefined

  // ── Render ──

  return (
    <div className="p-4">
      {/* Header */}
      <header className="text-center border-b border-border pb-3 mb-4">
        <h1 className="text-[13px] font-semibold text-accent-foreground uppercase tracking-widest">
          Finrep Meeting Intelligence
        </h1>
      </header>

      {/* Recovery banner */}
      {recovery && (
        <div className="mb-3 rounded-lg border border-destructive bg-destructive/8 p-2.5">
          <p className="text-[11px] text-red-300 mb-2 leading-snug">{recovery.message}</p>
          <div className="flex gap-2">
            <button onClick={recover} className="flex-1 text-[11px] py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors">
              Recover
            </button>
            <button onClick={dismissRecovery} className="flex-1 text-[11px] py-1 rounded border border-border bg-secondary text-secondary-foreground hover:bg-accent transition-colors">
              Dismiss
            </button>
          </div>
        </div>
      )}

      <CalendarBar />

      {/* ── Idle ── */}
      {state === 'idle' && (
        <div className="text-center py-4">
          <div className="text-5xl mb-3 text-muted-foreground/50">⬤</div>
          <p className="text-sm text-secondary-foreground mb-1">No active meeting detected</p>
          <p className="text-xs text-muted-foreground">Open a Google Meet to get started</p>
        </div>
      )}

      {/* ── Note Prompt ── */}
      {state === 'note-prompt' && (
        <div className="rounded-xl border border-border bg-card p-5 text-center shadow-xl">
          <div className="text-4xl mb-3">📝</div>
          <h2 className="text-base font-semibold text-foreground mb-1.5">Meeting Detected</h2>
          <p className="text-sm text-secondary-foreground mb-1">Do you want to enable note taking?</p>
          <p className="text-[11px] text-muted-foreground mb-5 leading-relaxed">
            Finrep will record, transcribe, and summarize this meeting automatically.
          </p>
          <div className="flex flex-col gap-2">
            <button
              onClick={() => sendMsg('ENABLE_NOTES')}
              className="w-full py-3 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
            >
              Yes, Enable Notes
            </button>
            <button
              onClick={() => sendMsg('SKIP_NOTES')}
              className="w-full py-2.5 rounded-lg border border-border bg-secondary text-secondary-foreground text-sm hover:bg-accent transition-colors"
            >
              No Thanks
            </button>
          </div>
        </div>
      )}

      {/* ── Meet Detected ── */}
      {state === 'meet-detected' && (
        <div className="text-center">
          <div className="text-5xl mb-3 animate-pulse text-primary">⬤</div>
          <p className="text-sm text-secondary-foreground mb-1">Google Meet detected!</p>
          <p className="text-xs text-muted-foreground mb-3">Click below to start capturing audio</p>
          <label className="flex items-center gap-2 cursor-pointer rounded-lg border border-border bg-secondary px-3 py-2 mb-3 hover:bg-accent hover:border-ring transition-colors">
            <input
              type="checkbox"
              checked={includeMic}
              onChange={(e) => setIncludeMic(e.target.checked)}
              className="h-4 w-4 accent-primary cursor-pointer"
            />
            <div className="text-left">
              <p className="text-xs text-foreground">Include my microphone</p>
              <p className="text-[10px] text-muted-foreground">Captures your voice + other participants.</p>
            </div>
          </label>
          <button
            onClick={startRecording}
            className="w-full py-3 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
          >
            Start Recording
          </button>
        </div>
      )}

      {/* ── Recording ── */}
      {state === 'recording' && (
        <div className="text-center">
          <AudioVisualizer active />
          <SourceLevels
            levels={levels}
            micMuted={micMuted}
            tabMuted={tabMuted}
            onToggleMic={toggleMic}
            onToggleTab={toggleTab}
          />
          <p className="text-sm text-secondary-foreground">Recording in progress</p>
          <Timer startTime={stateData.startTime || Date.now()} />
          <LiveTranscript lines={liveTranscript} />
          <div className="flex gap-2">
            <button
              onClick={stopRecording}
              className="flex-1 py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
            >
              Stop Recording
            </button>
            <button
              onClick={cancelRecording}
              className="flex-1 py-2.5 rounded-lg border border-border bg-secondary text-secondary-foreground text-sm hover:bg-accent transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Processing ── */}
      {state === 'processing' && (
        <div className="text-center py-4">
          <div className="h-10 w-10 mx-auto mb-4 rounded-full border-2 border-border border-t-primary animate-spin" />
          <p className="text-sm text-secondary-foreground">{stateData.step || 'Processing...'}</p>
          <ProcessingSteps step={stateData.step?.toLowerCase() || 'uploading'} />
        </div>
      )}

      {/* ── Summary Ready ── */}
      {state === 'summary-ready' && (
        <div>
          {summary?.title && (
            <h2 className="text-sm font-semibold text-foreground mb-3">{summary.title}</h2>
          )}
          <div className="max-h-60 overflow-y-auto mb-3 space-y-2">
            {summary?.summary && (
              <div className="mb-3">
                <h4 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1">Summary</h4>
                <p className="text-xs text-secondary-foreground leading-relaxed">{summary.summary}</p>
              </div>
            )}
            <SummarySection title="Decisions" items={summary?.decisions} />
            <SummarySection title="Action Items" items={summary?.actionItems} />
          </div>
          <div className="flex items-center gap-2 mb-2">
            <label className="text-xs text-muted-foreground whitespace-nowrap">Call Type:</label>
            <select
              value={callType}
              onChange={(e) => setCallType(e.target.value)}
              className="flex-1 rounded-md border border-border bg-input text-foreground text-xs px-2 py-1.5 outline-none focus:ring-1 focus:ring-ring cursor-pointer"
            >
              <option value="internal">Internal</option>
              <option value="customer">Customer</option>
              <option value="gtm">GTM</option>
              <option value="product">Product</option>
            </select>
          </div>
          <button
            onClick={sendSlack}
            disabled={sendingSlack}
            className="w-full py-3 rounded-lg bg-[#4a154b] text-white text-sm font-medium hover:bg-[#61196e] transition-colors disabled:opacity-50"
          >
            {sendingSlack ? 'Sending...' : 'Send to Slack'}
          </button>
        </div>
      )}

      {/* ── Error ── */}
      {state === 'error' && (
        <div className="text-center py-4">
          <div className="inline-flex h-12 w-12 items-center justify-center rounded-full border-2 border-destructive text-destructive text-2xl mb-3">!</div>
          <p className="text-sm text-destructive mb-4">{stateData.message || 'An error occurred'}</p>
          <div className="flex gap-2">
            <button onClick={loadState} className="flex-1 py-2 rounded-lg bg-primary text-primary-foreground text-sm hover:bg-primary/90 transition-colors">Retry</button>
            <button onClick={reset} className="flex-1 py-2 rounded-lg border border-border bg-secondary text-secondary-foreground text-sm hover:bg-accent transition-colors">Reset</button>
          </div>
        </div>
      )}
    </div>
  )
}
