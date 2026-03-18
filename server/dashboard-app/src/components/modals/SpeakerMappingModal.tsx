import { useState, useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import type { Meeting } from '../../types'

interface Props {
  open: boolean
  meeting: Meeting | null
  onClose: () => void
  onSave: (speakerNames: Record<string, string>) => Promise<void>
  onGetSuggestions: () => Promise<Record<string, string>>
}

interface TranscriptPart {
  partNumber: number
  totalParts: number
  speakers: string[]
}

const PART_MARKER_RE = /\[--- Part (\d+) of (\d+) begins/

/**
 * Split a transcript into parts using [--- Part N of M begins ---] markers.
 * Single-chunk transcripts return a single part with no number prefix.
 */
function parseTranscriptParts(transcript: string): TranscriptPart[] {
  const lines = transcript.split('\n')
  const speakerRe = /\[\d+:\d+(?::\d+)?\]\s+(SPEAKER_\d+|\d+):/

  // Find part marker lines and their line indices
  const markerIndices: { lineIdx: number; partNum: number; total: number }[] = []
  lines.forEach((line, i) => {
    const m = line.match(PART_MARKER_RE)
    if (m) markerIndices.push({ lineIdx: i, partNum: parseInt(m[1]), total: parseInt(m[2]) })
  })

  if (markerIndices.length === 0) {
    // No markers — single chunk
    const speakers = new Set<string>()
    for (const line of lines) {
      const m = line.match(speakerRe)
      if (m) speakers.add(m[1])
    }
    return [{ partNumber: 1, totalParts: 1, speakers: Array.from(speakers).sort() }]
  }

  return markerIndices.map((marker, i) => {
    const start = marker.lineIdx
    const end = i + 1 < markerIndices.length ? markerIndices[i + 1].lineIdx : lines.length
    const speakers = new Set<string>()
    for (let j = start; j < end; j++) {
      const m = lines[j].match(speakerRe)
      if (m) speakers.add(m[1])
    }
    return { partNumber: marker.partNum, totalParts: marker.total, speakers: Array.from(speakers).sort() }
  })
}

/** Build the storage key for a speaker label. Multi-part uses "p1:SPEAKER_0" scoping. */
function speakerKey(partNumber: number, totalParts: number, label: string): string {
  return totalParts > 1 ? `p${partNumber}:${label}` : label
}

export function SpeakerMappingModal({ open, meeting, onClose, onSave, onGetSuggestions }: Props) {
  const [names, setNames] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [suggesting, setSuggesting] = useState(false)
  const [activePart, setActivePart] = useState(1)

  const parts = meeting?.transcript ? parseTranscriptParts(meeting.transcript) : []
  const isMultiPart = parts.length > 1
  const totalParts = parts[0]?.totalParts ?? 1

  useEffect(() => {
    if (open && meeting) {
      setNames(meeting.speakerNames || {})
      setActivePart(1)
    }
  }, [open, meeting])

  const handleSave = async () => {
    setLoading(true)
    await onSave(names).finally(() => setLoading(false))
    onClose()
  }

  const handleSuggest = async () => {
    setSuggesting(true)
    const suggestions = await onGetSuggestions().finally(() => setSuggesting(false))
    // AI returns flat keys (SPEAKER_0 → name). Scope them to the active part.
    const scoped: Record<string, string> = {}
    for (const [label, name] of Object.entries(suggestions)) {
      scoped[speakerKey(activePart, totalParts, label)] = name
    }
    // Only fill in blanks — don't overwrite names the user already typed
    setNames(prev => ({ ...scoped, ...prev }))
  }

  const currentPart = parts.find(p => p.partNumber === activePart) ?? parts[0]
  const currentSpeakers = currentPart?.speakers ?? []

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Name Speakers</DialogTitle>
          <DialogDescription>
            {isMultiPart
              ? `This meeting had ${totalParts} parts — speaker IDs reset each part`
              : 'Assign names to speaker labels'}
          </DialogDescription>
        </DialogHeader>

        {/* Part tabs — only shown for multi-chunk meetings */}
        {isMultiPart && (
          <div className="flex gap-1 border-b border-border pb-2">
            {parts.map(p => (
              <button
                key={p.partNumber}
                onClick={() => setActivePart(p.partNumber)}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                  activePart === p.partNumber
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                }`}
              >
                Part {p.partNumber}
              </button>
            ))}
          </div>
        )}

        <div className="space-y-3 py-2">
          {currentSpeakers.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4">No speakers found in transcript</p>
          ) : (
            currentSpeakers.map((label) => {
              const key = speakerKey(activePart, totalParts, label)
              return (
                <div key={key} className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground w-20 shrink-0 font-mono">{label}</span>
                  <Input
                    placeholder="Enter name..."
                    value={names[key] || ''}
                    onChange={(e) => setNames(prev => ({ ...prev, [key]: e.target.value }))}
                    className="h-7 text-xs"
                  />
                </div>
              )
            })
          )}
        </div>

        <div className="flex gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={handleSuggest} disabled={suggesting} className="flex-1">
            {suggesting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : '✨'}
            AI Suggest
          </Button>
          <Button size="sm" onClick={handleSave} disabled={loading} className="flex-1">
            {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save Names
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
