import { useState, useEffect } from 'react'
import { Wand2, Send, Loader2 } from 'lucide-react'
import { Button } from '../ui/button'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../ui/select'
import { api } from '../../api'
import type { Meeting, Summary, Template } from '../../types'

interface Props {
  meeting: Meeting
  onSummarize: (template: string, customPrompt: string, templateId?: string) => Promise<void>
  onSendSlack: (callType: string) => Promise<void>
}

function SectionList({ title, items }: { title: string; items?: string[] }) {
  if (!items?.length) return null
  return (
    <div className="space-y-1.5">
      <h4 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{title}</h4>
      <ul className="space-y-1.5">
        {items.map((item, i) => (
          <li key={i} className="flex gap-2 text-sm text-secondary-foreground leading-relaxed">
            <span className="text-primary shrink-0 mt-1 text-xs">●</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function SummaryTab({ meeting, onSummarize, onSendSlack }: Props) {
  const [template, setTemplate] = useState('general')
  const [callType, setCallType] = useState(meeting.call_type || 'internal')
  const [loadingSummarize, setLoadingSummarize] = useState(false)
  const [loadingSlack, setLoadingSlack] = useState(false)
  const [customTemplates, setCustomTemplates] = useState<Template[]>([])
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('__none__')

  useEffect(() => {
    api.templates.list().then(r => setCustomTemplates(r.templates)).catch(() => {})
  }, [])

  const summary: Summary | undefined = meeting.summary

  const handleSummarize = async () => {
    setLoadingSummarize(true)
    const templateId = selectedTemplateId !== '__none__' ? selectedTemplateId : undefined
    await onSummarize(template, '', templateId).finally(() => setLoadingSummarize(false))
  }

  const handleSlack = async () => {
    setLoadingSlack(true)
    await onSendSlack(callType).finally(() => setLoadingSlack(false))
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Controls */}
      <div className="flex items-center gap-2">
        {/* Custom template selector */}
        <Select value={selectedTemplateId} onValueChange={setSelectedTemplateId}>
          <SelectTrigger className="h-7 text-xs flex-1">
            <SelectValue placeholder="Template" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">None (General)</SelectItem>
            {customTemplates.map(t => (
              <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Built-in template selector (only shown when no custom template selected) */}
        {selectedTemplateId === '__none__' && (
          <Select value={template} onValueChange={setTemplate}>
            <SelectTrigger className="h-7 text-xs w-28">
              <SelectValue placeholder="Style" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="general">General</SelectItem>
              <SelectItem value="customer">Customer</SelectItem>
              <SelectItem value="product">Product</SelectItem>
              <SelectItem value="technical">Technical</SelectItem>
            </SelectContent>
          </Select>
        )}

        <Button size="sm" onClick={handleSummarize} disabled={loadingSummarize}>
          {loadingSummarize ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
          {loadingSummarize ? 'Generating...' : 'Summarize'}
        </Button>
      </div>

      {/* Summary content */}
      {summary ? (
        <div className="space-y-4 rounded-lg border border-border bg-card/50 p-4">
          {summary.title && (
            <h3 className="text-base font-semibold text-foreground">{summary.title}</h3>
          )}
          {summary.summary && (
            <div className="space-y-1.5">
              <h4 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Summary</h4>
              <p className="text-sm text-secondary-foreground leading-relaxed">{summary.summary}</p>
            </div>
          )}
          <SectionList title="Decisions" items={summary.decisions} />
          <SectionList title="Action Items" items={summary.actionItems} />
          <SectionList title="Next Steps" items={summary.nextSteps} />
          <SectionList title="Follow-ups" items={summary.followUps} />
          <SectionList title="Deadlines" items={summary.deadlines} />
          <SectionList title="Participants" items={summary.participants} />
          {summary.customSections?.map((cs, i) => (
            <div key={i} className="space-y-1.5">
              <h4 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{cs.title}</h4>
              <p className="text-sm text-secondary-foreground leading-relaxed">{cs.content}</p>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center h-28 rounded-lg border border-dashed border-border gap-2">
          <p className="text-xs text-muted-foreground">No summary yet</p>
          <p className="text-[10px] text-muted-foreground">Click Summarize to generate one</p>
        </div>
      )}

      {/* Slack */}
      <div className="flex items-center gap-2 pt-1 border-t border-border">
        <Select value={callType} onValueChange={setCallType}>
          <SelectTrigger className="h-7 text-xs w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="internal">Internal</SelectItem>
            <SelectItem value="customer">Customer</SelectItem>
            <SelectItem value="gtm">GTM</SelectItem>
            <SelectItem value="product">Product</SelectItem>
          </SelectContent>
        </Select>
        <Button
          variant="secondary"
          size="sm"
          onClick={handleSlack}
          disabled={loadingSlack || !summary}
          className="flex-1"
        >
          {loadingSlack ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          Send to Slack
        </Button>
      </div>
    </div>
  )
}
