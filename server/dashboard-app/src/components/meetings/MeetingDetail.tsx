import { useState, useRef } from 'react'
import { Trash2, Edit2, Check, X, RefreshCw, Loader2, Database, Lock, Users } from 'lucide-react'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../ui/tabs'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../ui/select'
import { AudioPlayer } from './AudioPlayer'
import { TranscriptTab } from './TranscriptTab'
import { SummaryTab } from './SummaryTab'
import { fmtDate, fmtTime, fmtDuration } from '../../lib/utils'
import { api } from '../../api'
import type { Meeting, UserIdentity } from '../../types'

interface Props {
  meeting: Meeting
  onUpdated: (m: Meeting) => void
  onDeleted: () => void
  onSpeakersOpen: () => void
  onToast: (msg: string, type?: 'success' | 'error' | 'info') => void
  identity?: UserIdentity
}

export function MeetingDetail({ meeting, onUpdated, onDeleted, onSpeakersOpen, onToast }: Props) {
  const [editTitle, setEditTitle] = useState(false)
  const [titleVal, setTitleVal] = useState(meeting.title || meeting.meet_title || '')
  const [seekTo, setSeekTo] = useState<{ secs: number; ts: number } | undefined>()
  const [retranscribing, setRetranscribing] = useState(false)
  const [transProgress, setTransProgress] = useState<{ done: number; total: number } | null>(null)
  const [ingestingKb, setIngestingKb] = useState(false)
  const audioRef = useRef<HTMLAudioElement>(null)

  const title = meeting.title || meeting.meet_title || meeting.summary?.title || 'Untitled Meeting'
  const audioUrl = api.meetings.audioUrl(meeting.id)

  const saveTitle = async () => {
    try {
      await api.meetings.updateTitle(meeting.id, titleVal)
      onUpdated({ ...meeting, title: titleVal })
      setEditTitle(false)
      onToast('Title saved', 'success')
    } catch {
      onToast('Failed to save title', 'error')
    }
  }

  const handleDelete = async () => {
    if (!confirm('Delete this meeting?')) return
    try {
      await api.meetings.delete(meeting.id)
      onDeleted()
      onToast('Meeting deleted')
    } catch {
      onToast('Failed to delete', 'error')
    }
  }

  const handleRetranscribe = () => {
    setRetranscribing(true)
    setTransProgress(null)
    api.transcribe.retranscribeStream(meeting.id, {
      onProgress: (p) => setTransProgress(p),
      onDone: async () => {
        try {
          const { meeting: fresh } = await api.meetings.get(meeting.id)
          onUpdated(fresh)
          onToast('Transcription complete', 'success')
        } catch {
          onToast('Transcribed — refresh to view', 'info')
        } finally {
          setRetranscribing(false)
          setTransProgress(null)
        }
      },
      onFailed: (msg) => {
        onToast(msg || 'Re-transcription failed', 'error')
        setRetranscribing(false)
        setTransProgress(null)
      },
    })
  }

  const handleSummarize = async (template: string, customPrompt: string, templateId?: string) => {
    try {
      const result = await api.summarize(meeting.id, template, customPrompt, templateId)
      onUpdated({ ...meeting, summary: result.summary })
      onToast('Summary generated', 'success')
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Summarization failed'
      onToast(msg, 'error')
      throw err
    }
  }

  const handleSendSlack = async (callType: string) => {
    try {
      await api.slack.send(meeting.id, callType)
      onToast('Sent to Slack', 'success')
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to send to Slack'
      onToast(msg, 'error')
      throw err
    }
  }

  const handleIngestKb = async () => {
    setIngestingKb(true)
    try {
      await api.kb.ingestMeeting(meeting.id)
      onToast('Ingested into knowledge base', 'success')
    } catch {
      onToast('Ingestion failed', 'error')
    } finally {
      setIngestingKb(false)
    }
  }

  const handleExport = (format: string) => {
    window.open(api.meetings.exportUrl(meeting.id, format), '_blank')
  }

  const handleShareToggle = async () => {
    const newVisibility = meeting.visibility === 'team' ? 'private' : 'team'
    try {
      const result = await api.meetings.setVisibility(meeting.id, newVisibility)
      onUpdated(result.meeting)
      onToast(newVisibility === 'team' ? 'Shared with team' : 'Set to private', 'success')
    } catch {
      onToast('Failed to update visibility', 'error')
    }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b border-border space-y-3 shrink-0">
        <div className="flex items-start justify-between gap-2">
          {editTitle ? (
            <div className="flex items-center gap-1.5 flex-1">
              <Input
                value={titleVal}
                onChange={(e) => setTitleVal(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') saveTitle(); if (e.key === 'Escape') setEditTitle(false) }}
                className="h-7 text-sm flex-1"
                autoFocus
              />
              <Button size="icon" variant="ghost" onClick={saveTitle}><Check className="h-3.5 w-3.5 text-green-400" /></Button>
              <Button size="icon" variant="ghost" onClick={() => setEditTitle(false)}><X className="h-3.5 w-3.5" /></Button>
            </div>
          ) : (
            <h2 className="text-base font-semibold text-foreground leading-snug flex-1 line-clamp-2">{title}</h2>
          )}
          <div className="flex gap-1 shrink-0">
            <Button variant="ghost" size="icon" onClick={() => { setTitleVal(title); setEditTitle(true) }} title="Edit title">
              <Edit2 className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="icon" onClick={handleDelete} title="Delete" className="text-muted-foreground hover:text-destructive">
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <Select
            value={meeting.call_type || 'internal'}
            onValueChange={async (val) => {
              try {
                const result = await api.meetings.updateCallType(meeting.id, val)
                onUpdated(result.meeting)
              } catch {
                onToast('Failed to update type', 'error')
              }
            }}
          >
            <SelectTrigger className="h-6 text-xs w-auto px-2 border-border bg-transparent">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="internal">Internal</SelectItem>
              <SelectItem value="customer">Customer</SelectItem>
              <SelectItem value="gtm">GTM</SelectItem>
              <SelectItem value="product">Product</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">
            {fmtDate(meeting.created_at)} · {fmtTime(meeting.created_at)}
          </span>
          {meeting.duration_seconds && (
            <span className="text-xs text-muted-foreground">{fmtDuration(meeting.duration_seconds)}</span>
          )}
        </div>

        {/* Action buttons row */}
        <div className="flex gap-1.5 flex-wrap">
          <Button variant="outline" size="sm" onClick={handleRetranscribe} disabled={retranscribing}>
            {retranscribing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {retranscribing && transProgress ? `Transcribing ${transProgress.done}/${transProgress.total}` : 'Re-transcribe'}
          </Button>
          <Button variant="outline" size="sm" onClick={handleIngestKb} disabled={ingestingKb}>
            {ingestingKb ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Database className="h-3.5 w-3.5" />}
            Add to KB
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleShareToggle}
            title={meeting.visibility === 'team' ? 'Visible to team — click to make private' : 'Private — click to share with team'}
          >
            {meeting.visibility === 'team'
              ? <><Users className="h-3.5 w-3.5" />Shared</>
              : <><Lock className="h-3.5 w-3.5" />Private</>
            }
          </Button>
          <Button variant="outline" size="sm" onClick={() => handleExport('txt')}>Export TXT</Button>
          <Button variant="outline" size="sm" onClick={() => handleExport('json')}>Export JSON</Button>
        </div>

        {/* Transcription progress bar */}
        {retranscribing && (
          <div className="space-y-1">
            <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{ width: transProgress ? `${Math.round((transProgress.done / transProgress.total) * 100)}%` : '5%' }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {transProgress ? `Transcribing chunk ${transProgress.done} of ${transProgress.total}…` : 'Preparing audio…'}
            </p>
          </div>
        )}

        {/* Audio player */}
        <AudioPlayer
          src={audioUrl}
          durationSeconds={meeting.duration_seconds}
          seekTo={seekTo}
          audioRef={audioRef}
        />
      </div>

      {/* Tabs */}
      <div className="flex-1 overflow-y-auto min-h-0">
        <Tabs defaultValue="transcript">
          <div className="px-4 pt-3 border-b border-border sticky top-0 bg-background z-10">
            <TabsList>
              <TabsTrigger value="transcript">Transcript</TabsTrigger>
              <TabsTrigger value="summary">Summary</TabsTrigger>
            </TabsList>
          </div>
          <div className="p-4">
            <TabsContent value="transcript">
              <TranscriptTab
                meeting={meeting}
                onSeek={(secs) => setSeekTo({ secs, ts: Date.now() })}
                onOpenSpeakers={onSpeakersOpen}
                audioRef={audioRef}
              />
            </TabsContent>
            <TabsContent value="summary">
              <SummaryTab
                meeting={meeting}
                onSummarize={handleSummarize}
                onSendSlack={handleSendSlack}
              />
            </TabsContent>
          </div>
        </Tabs>
      </div>
    </div>
  )
}
