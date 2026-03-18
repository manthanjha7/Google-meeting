import { Search, Upload, RefreshCw } from 'lucide-react'
import { Input } from '../ui/input'
import { Button } from '../ui/button'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../ui/select'
import { MeetingListItem } from './MeetingListItem'
import { Spinner } from '../shared/Spinner'
import { EmptyState } from '../shared/EmptyState'
import type { Meeting } from '../../types'

interface Props {
  meetings: Meeting[]
  loading: boolean
  selectedId: string | null
  onSelect: (m: Meeting) => void
  onRefresh: () => void
  onImport: () => void
  filterType: string
  setFilterType: (t: string) => void
  searchQ: string
  setSearchQ: (q: string) => void
}

export function MeetingList({
  meetings,
  loading,
  selectedId,
  onSelect,
  onRefresh,
  onImport,
  filterType,
  setFilterType,
  searchQ,
  setSearchQ,
}: Props) {
  return (
    <div className="flex h-full flex-col border-r border-border w-72 shrink-0">
      {/* Header */}
      <div className="p-3 border-b border-border space-y-2.5">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-[0.1em]">Meetings</h2>
          <div className="flex gap-0.5">
            <Button variant="ghost" size="icon" onClick={onRefresh} title="Refresh">
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" onClick={onImport} title="Import audio">
              <Upload className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search meetings..."
            className="pl-8 h-8 text-sm"
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
          />
        </div>
        <Select value={filterType} onValueChange={setFilterType}>
          <SelectTrigger className="h-8 text-sm">
            <SelectValue placeholder="All types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            <SelectItem value="internal">Internal</SelectItem>
            <SelectItem value="customer">Customer</SelectItem>
            <SelectItem value="gtm">GTM</SelectItem>
            <SelectItem value="product">Product</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {loading ? (
          <div className="flex justify-center pt-8"><Spinner /></div>
        ) : meetings.length === 0 ? (
          <EmptyState />
        ) : (
          meetings.map((m) => (
            <MeetingListItem
              key={m.id}
              meeting={m}
              selected={m.id === selectedId}
              onClick={() => onSelect(m)}
            />
          ))
        )}
      </div>
    </div>
  )
}
