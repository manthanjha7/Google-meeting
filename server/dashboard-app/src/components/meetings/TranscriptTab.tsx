import { useState, useMemo, useRef, useEffect } from 'react'
import { ChevronLeft, ChevronRight, Users } from 'lucide-react'
import { Button } from '../ui/button'
import { cn, parseTimestamp } from '../../lib/utils'
import type { Meeting } from '../../types'

interface Props {
  meeting: Meeting
  onSeek: (secs: number) => void
  onOpenSpeakers: () => void
  audioRef?: React.RefObject<HTMLAudioElement>
}

const LINES_PER_PAGE = 80

const SPEAKER_COLORS = [
  'text-blue-400', 'text-purple-400', 'text-emerald-400',
  'text-amber-400', 'text-rose-400', 'text-cyan-400',
]

function getSpeakerColor(label: string, colorMap: Map<string, string>): string {
  if (!colorMap.has(label)) {
    colorMap.set(label, SPEAKER_COLORS[colorMap.size % SPEAKER_COLORS.length])
  }
  return colorMap.get(label)!
}

interface TranscriptLine {
  speaker: string
  displayName: string
  timestamp: string
  timeSecs: number
  text: string
}

function parseTranscript(raw: string, speakerNames: Record<string, string>): TranscriptLine[] {
  const lines: TranscriptLine[] = []
  const lineRegex = /^\[(\d+:\d+(?::\d+)?)\]\s+(SPEAKER_\d+|\d+):(.*)$/
  for (const line of raw.split('\n')) {
    const m = line.match(lineRegex)
    if (m) {
      const [, ts, speaker, text] = m
      const displayName = speakerNames?.[speaker] || speaker
      lines.push({ speaker, displayName, timestamp: ts, timeSecs: parseTimestamp(ts), text: text.trim() })
    } else if (line.trim()) {
      lines.push({ speaker: '', displayName: '', timestamp: '', timeSecs: -1, text: line.trim() })
    }
  }
  return lines
}

const COL_TEMPLATE = '5.5rem 9rem 1fr'
const COL_GAP = '0.75rem'

export function TranscriptTab({ meeting, onSeek, onOpenSpeakers, audioRef }: Props) {
  const [page, setPage] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const colorMap = useMemo(() => new Map<string, string>(), [meeting.id])
  const activeRowRef = useRef<HTMLDivElement>(null)

  // Subscribe directly to the audio element's timeupdate event
  useEffect(() => {
    const audio = audioRef?.current
    if (!audio) return
    const handler = () => setCurrentTime(audio.currentTime)
    audio.addEventListener('timeupdate', handler)
    return () => audio.removeEventListener('timeupdate', handler)
  }, [audioRef])

  const lines = useMemo(
    () => parseTranscript(meeting.transcript || '', meeting.speakerNames || {}),
    [meeting.transcript, meeting.speakerNames]
  )

  const totalPages = Math.max(1, Math.ceil(lines.length / LINES_PER_PAGE))

  // Last timed line whose timeSecs <= currentTime
  const activeGlobalIndex = useMemo(() => {
    if (currentTime <= 0) return -1
    let idx = -1
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].timestamp && lines[i].timeSecs <= currentTime) idx = i
    }
    return idx
  }, [lines, currentTime])

  // Auto-flip page when active line is on a different page
  useEffect(() => {
    if (activeGlobalIndex < 0) return
    const activePage = Math.floor(activeGlobalIndex / LINES_PER_PAGE)
    if (activePage !== page) setPage(activePage)
  }, [activeGlobalIndex])

  // Auto-scroll active row into view
  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [activeGlobalIndex])

  const pageLines = lines.slice(page * LINES_PER_PAGE, (page + 1) * LINES_PER_PAGE)
  const pageOffset = page * LINES_PER_PAGE

  if (!meeting.transcript) {
    return (
      <div className="flex flex-col items-center justify-center h-40 gap-2 text-muted-foreground">
        <p className="text-xs">No transcript available</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{lines.length} lines</span>
        <Button variant="outline" size="sm" onClick={onOpenSpeakers}>
          <Users className="h-3.5 w-3.5" />
          Name Speakers
        </Button>
      </div>

      {/* Transcript rows */}
      <div className="rounded-lg border border-border bg-card/60 px-2 py-3 flex flex-col gap-0.5">
        {pageLines.map((line, i) => {
          const globalIdx = pageOffset + i
          const isActive = globalIdx === activeGlobalIndex
          const color = line.speaker ? getSpeakerColor(line.speaker, colorMap) : ''

          return (
            <div
              key={globalIdx}
              ref={isActive ? activeRowRef : undefined}
              className={cn('grid rounded-xl px-2 py-1 transition-colors duration-200', !isActive && 'hover:bg-muted/30')}
              style={{
                gridTemplateColumns: COL_TEMPLATE,
                columnGap: COL_GAP,
                backgroundColor: isActive ? 'rgba(251, 191, 36, 0.25)' : undefined,
                boxShadow: isActive ? 'inset 3px 0 0 rgb(251, 191, 36)' : undefined,
              }}
            >
              {/* Col 1: timestamp */}
              <div className="flex items-baseline pt-[1px]">
                {line.timestamp ? (
                  <button
                    onClick={() => onSeek(line.timeSecs)}
                    className="font-mono text-xs tabular-nums text-muted-foreground hover:text-primary transition-colors whitespace-nowrap rounded px-0.5 hover:bg-primary/10"
                    title={`Seek to ${line.timestamp}`}
                  >
                    [{line.timestamp}]
                  </button>
                ) : (
                  <span className="invisible select-none font-mono text-xs">[--:--]</span>
                )}
              </div>

              {/* Col 2: speaker name */}
              <div className={cn('text-sm font-semibold truncate leading-relaxed', color)}>
                {line.displayName ? `${line.displayName}:` : ''}
              </div>

              {/* Col 3: text */}
              <div className="text-sm text-foreground/85 leading-relaxed break-words min-w-0">
                {line.text}
              </div>
            </div>
          )
        })}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 pb-2">
          <Button variant="ghost" size="icon" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-xs text-muted-foreground">Page {page + 1} / {totalPages}</span>
          <Button variant="ghost" size="icon" onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page === totalPages - 1}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  )
}
