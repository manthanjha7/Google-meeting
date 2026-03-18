import { useEffect, useState } from 'react'
import { BarChart2, Clock, Mic, CheckSquare } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card'
import { Spinner } from '../shared/Spinner'
import { fmtDuration } from '../../lib/utils'
import { api } from '../../api'
import type { Analytics } from '../../types'

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <Card>
      <CardContent className="p-4 flex items-center gap-3">
        <div className="rounded-lg bg-primary/15 p-2.5 text-primary">{icon}</div>
        <div>
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{label}</p>
          <p className="text-xl font-bold text-foreground tabular-nums mt-0.5">{value}</p>
        </div>
      </CardContent>
    </Card>
  )
}

export function AnalyticsPanel() {
  const [data, setData] = useState<Analytics | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.analytics().then(setData).finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="flex justify-center pt-16"><Spinner className="h-8 w-8" /></div>
  if (!data) return <div className="text-center pt-16 text-muted-foreground text-xs">Failed to load analytics</div>

  return (
    <div className="p-6 space-y-6 max-w-3xl mx-auto">
      <h2 className="text-lg font-semibold text-foreground">Analytics</h2>

      <div className="grid grid-cols-2 gap-3">
        <StatCard icon={<Mic className="h-4 w-4" />} label="Total Meetings" value={String(data.totalMeetings)} />
        <StatCard icon={<Clock className="h-4 w-4" />} label="Avg Duration" value={fmtDuration(data.avgDurationSeconds)} />
        <StatCard icon={<BarChart2 className="h-4 w-4" />} label="Total Time" value={fmtDuration(data.totalDurationSeconds)} />
        <StatCard icon={<CheckSquare className="h-4 w-4" />} label="Action Items" value={String(data.actionItemCount)} />
      </div>

      {data.byCallType?.length > 0 && (
        <Card>
          <CardHeader><CardTitle>By Call Type</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {data.byCallType.map((item) => {
              const pct = data.totalMeetings > 0 ? (item.count / data.totalMeetings) * 100 : 0
              return (
                <div key={item.type} className="space-y-1">
                  <div className="flex justify-between text-xs">
                    <span className="capitalize text-foreground">{item.type}</span>
                    <span className="text-muted-foreground">{item.count}</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
                    <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              )
            })}
          </CardContent>
        </Card>
      )}

      {data.topParticipants?.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Top Participants</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-1">
              {data.topParticipants.slice(0, 10).map((p) => (
                <div key={p.name} className="flex justify-between text-xs py-1 border-b border-border last:border-0">
                  <span className="text-foreground">{p.name}</span>
                  <span className="text-muted-foreground">{p.count} meetings</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
