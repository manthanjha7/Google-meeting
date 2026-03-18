import { useRef, useState, useEffect, useCallback } from 'react'
import { Play, Pause, Volume2, VolumeX } from 'lucide-react'
import { cn, fmtTimestamp } from '../../lib/utils'

interface AudioPlayerProps {
  src: string
  durationSeconds?: number
  onTimeUpdate?: (secs: number) => void
  seekTo?: { secs: number; ts: number } // external seek trigger — ts ensures re-run on same value
}

export function AudioPlayer({ src, durationSeconds, onTimeUpdate, seekTo }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(durationSeconds || 0)
  const [muted, setMuted] = useState(false)
  const [seeking, setSeeking] = useState(false)
  const seekRef = useRef(0)

  // Use server-stored duration as fallback for WebM files
  const knownDuration = useCallback(() => {
    const d = audioRef.current?.duration
    return d && isFinite(d) && d > 0 ? d : (durationSeconds || 0)
  }, [durationSeconds])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    const onLoadedMeta = () => setDuration(knownDuration())
    const onDurationChange = () => setDuration(knownDuration())
    const onTimeUpdate = () => {
      if (!seeking) setCurrentTime(audio.currentTime)
    }
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    const onEnded = () => { setPlaying(false); setCurrentTime(0) }

    audio.addEventListener('loadedmetadata', onLoadedMeta)
    audio.addEventListener('durationchange', onDurationChange)
    audio.addEventListener('timeupdate', onTimeUpdate)
    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('ended', onEnded)
    return () => {
      audio.removeEventListener('loadedmetadata', onLoadedMeta)
      audio.removeEventListener('durationchange', onDurationChange)
      audio.removeEventListener('timeupdate', onTimeUpdate)
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('ended', onEnded)
    }
  }, [knownDuration, seeking])

  // Emit time updates to parent
  useEffect(() => {
    onTimeUpdate?.(currentTime)
  }, [currentTime, onTimeUpdate])

  // External seek (timestamp clicks in transcript)
  useEffect(() => {
    if (seekTo === undefined || !audioRef.current) return
    audioRef.current.currentTime = seekTo.secs
    setCurrentTime(seekTo.secs)
  }, [seekTo])

  // Init duration from prop
  useEffect(() => {
    if (durationSeconds && !duration) setDuration(durationSeconds)
  }, [durationSeconds])

  const togglePlay = async () => {
    const audio = audioRef.current
    if (!audio) return
    if (playing) {
      audio.pause()
    } else {
      await audio.play().catch(() => {})
    }
  }

  const toggleMute = () => {
    if (!audioRef.current) return
    audioRef.current.muted = !muted
    setMuted(!muted)
  }

  const handleSeekInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value)
    seekRef.current = val
    const dur = knownDuration()
    if (dur > 0) setCurrentTime((val / 1000) * dur)
  }

  const handleSeekCommit = () => {
    const audio = audioRef.current
    if (!audio) return
    const dur = knownDuration()
    if (dur > 0) {
      audio.currentTime = (seekRef.current / 1000) * dur
    }
    setSeeking(false)
  }

  const pct = duration > 0 ? (currentTime / duration) * 1000 : 0

  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
      <audio ref={audioRef} src={src} preload="metadata" />

      <button
        onClick={togglePlay}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
      >
        {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5 translate-x-0.5" />}
      </button>

      <span className="text-[10px] text-muted-foreground w-9 shrink-0 tabular-nums">
        {fmtTimestamp(currentTime)}
      </span>

      <input
        type="range"
        min={0}
        max={1000}
        step={1}
        value={pct}
        onMouseDown={() => setSeeking(true)}
        onTouchStart={() => setSeeking(true)}
        onChange={handleSeekInput}
        onMouseUp={handleSeekCommit}
        onTouchEnd={handleSeekCommit}
        className={cn(
          'flex-1 h-1.5 cursor-pointer appearance-none rounded-full bg-secondary',
          '[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3',
          '[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary',
          '[&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:shadow-sm'
        )}
        style={{
          background: `linear-gradient(to right, hsl(var(--primary)) ${pct / 10}%, hsl(var(--secondary)) ${pct / 10}%)`
        }}
      />

      <span className="text-[10px] text-muted-foreground w-9 shrink-0 tabular-nums">
        {duration > 0 ? fmtTimestamp(duration) : '--:--'}
      </span>

      <button
        onClick={toggleMute}
        className="text-muted-foreground hover:text-foreground transition-colors"
      >
        {muted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
      </button>
    </div>
  )
}
