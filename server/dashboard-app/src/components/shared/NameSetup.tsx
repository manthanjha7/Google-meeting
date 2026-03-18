import { useState } from 'react'
import { Mic } from 'lucide-react'
import { Button } from '../ui/button'

interface Props {
  onSave: (name: string) => void
}

export function NameSetup({ onSave }: Props) {
  const [name, setName] = useState('')

  return (
    <div className="flex h-screen items-center justify-center bg-background">
      <div className="w-full max-w-sm space-y-6 px-6">
        <div className="flex flex-col items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary">
            <Mic className="h-6 w-6 text-primary-foreground" />
          </div>
          <h1 className="text-xl font-semibold text-foreground">Welcome to Finrep</h1>
          <p className="text-center text-sm text-muted-foreground">
            Enter your name so your meetings stay separate from your teammates'.
          </p>
        </div>
        <div className="space-y-3">
          <input
            autoFocus
            className="w-full rounded-lg border border-border bg-card px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/60 transition-colors"
            placeholder="Your name (e.g. Rahul)"
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && name.trim()) onSave(name.trim()) }}
          />
          <Button className="w-full" disabled={!name.trim()} onClick={() => onSave(name.trim())}>
            Get started
          </Button>
        </div>
      </div>
    </div>
  )
}
