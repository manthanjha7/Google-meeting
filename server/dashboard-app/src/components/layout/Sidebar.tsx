import { Mic, BarChart2, BookOpen, Settings, LayoutTemplate } from 'lucide-react'
import { cn } from '../../lib/utils'

export type Panel = 'meetings' | 'analytics' | 'kb' | 'settings' | 'templates'

interface SidebarProps {
  active: Panel
  onChange: (p: Panel) => void
}

const items: { id: Panel; icon: React.ReactNode; label: string }[] = [
  { id: 'meetings', icon: <Mic className="h-4 w-4" />, label: 'Meetings' },
  { id: 'analytics', icon: <BarChart2 className="h-4 w-4" />, label: 'Analytics' },
  { id: 'kb', icon: <BookOpen className="h-4 w-4" />, label: 'Knowledge Base' },
  { id: 'templates', icon: <LayoutTemplate className="h-4 w-4" />, label: 'Templates' },
  { id: 'settings', icon: <Settings className="h-4 w-4" />, label: 'Settings' },
]

export function Sidebar({ active, onChange }: SidebarProps) {
  return (
    <aside className="flex w-14 flex-col items-center gap-2 border-r border-border bg-[hsl(var(--sidebar-bg))] py-4">
      <div className="mb-4 flex h-8 w-8 items-center justify-center rounded-md bg-primary">
        <Mic className="h-4 w-4 text-primary-foreground" />
      </div>
      {items.map((item) => (
        <button
          key={item.id}
          onClick={() => onChange(item.id)}
          title={item.label}
          className={cn(
            'flex h-9 w-9 items-center justify-center rounded-md transition-colors',
            active === item.id
              ? 'bg-primary/20 text-primary'
              : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
          )}
        >
          {item.icon}
        </button>
      ))}
    </aside>
  )
}
