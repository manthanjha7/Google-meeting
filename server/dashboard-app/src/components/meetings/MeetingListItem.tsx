import { Clock } from 'lucide-react'
import { Badge } from '../ui/badge'
import { cn, fmtDuration, fmtDate, fmtTime } from '../../lib/utils'
import type { Meeting } from '../../types'

const TYPE_COLORS: Record<string, 'default' | 'secondary' | 'success' | 'outline'> = {
  customer: 'success',
  gtm: 'default',
  product: 'secondary',
  internal: 'outline',
}

interface Props {
  meeting: Meeting
  selected: boolean
  onClick: () => void
}

export function MeetingListItem({ meeting, selected, onClick }: Props) {
  const title = meeting.title || meeting.meet_title || meeting.summary?.title || 'Untitled Meeting'
  const callType = meeting.call_type || 'internal'
  const date = fmtDate(meeting.created_at)
  const time = fmtTime(meeting.created_at)
  const duration = fmtDuration(meeting.duration_seconds)

  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full rounded-lg px-3 py-2.5 text-left transition-all hover:bg-accent/60',
        selected
          ? 'bg-accent border border-primary/40 shadow-sm shadow-primary/10'
          : 'border border-transparent hover:border-border'
      )}
    >
      {/* Title */}
      <p className="text-sm font-medium text-foreground leading-snug line-clamp-2 mb-1.5">
        {title}
      </p>

      {/* Meta row */}
      <div className="flex items-center gap-2.5 flex-wrap">
        <Badge variant={TYPE_COLORS[callType] || 'outline'} className="capitalize text-[11px] px-1.5 py-0">
          {callType}
        </Badge>
        <span className="text-xs text-muted-foreground">{date}</span>
        {time && <span className="text-xs text-muted-foreground">{time}</span>}
        {meeting.duration_seconds && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Clock className="h-3 w-3" />
            {duration}
          </span>
        )}
      </div>
    </button>
  )
}
