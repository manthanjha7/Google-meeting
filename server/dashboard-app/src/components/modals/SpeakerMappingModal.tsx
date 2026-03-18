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

function extractSpeakers(transcript: string): string[] {
  const speakers = new Set<string>()
  const regex = /\[\d+:\d+(?::\d+)?\]\s+(SPEAKER_\d+|\d+):/g
  let m
  while ((m = regex.exec(transcript)) !== null) {
    speakers.add(m[1])
  }
  return Array.from(speakers).sort()
}

export function SpeakerMappingModal({ open, meeting, onClose, onSave, onGetSuggestions }: Props) {
  const [names, setNames] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [suggesting, setSuggesting] = useState(false)

  const speakers = meeting?.transcript ? extractSpeakers(meeting.transcript) : []

  useEffect(() => {
    if (open && meeting) {
      setNames(meeting.speakerNames || {})
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
    setNames(prev => ({ ...suggestions, ...prev }))
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Name Speakers</DialogTitle>
          <DialogDescription>Assign names to speaker labels</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {speakers.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4">No speakers found in transcript</p>
          ) : (
            speakers.map((speaker) => (
              <div key={speaker} className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground w-20 shrink-0 font-mono">{speaker}</span>
                <Input
                  placeholder="Enter name..."
                  value={names[speaker] || ''}
                  onChange={(e) => setNames(prev => ({ ...prev, [speaker]: e.target.value }))}
                  className="h-7 text-xs"
                />
              </div>
            ))
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
