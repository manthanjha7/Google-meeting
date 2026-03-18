import { useState, useEffect } from 'react'
import { Loader2, Save, Info } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import { Button } from '../ui/button'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../ui/select'
import type { Settings } from '../../types'

interface Props {
  open: boolean
  settings: Settings
  onClose: () => void
  onSave: (s: Settings) => Promise<void>
}

const PROVIDER_ENV: Record<string, { label: string; vars: string[] }> = {
  azure:  { label: 'Azure OpenAI',  vars: ['AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_DEPLOYMENT'] },
  groq:   { label: 'Groq',          vars: ['GROQ_API_KEY'] },
  ollama: { label: 'Ollama',        vars: ['OLLAMA_URL (optional)'] },
}

export function SettingsModal({ open, settings, onClose, onSave }: Props) {
  const [provider, setProvider] = useState(settings.llmProvider || 'azure')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setProvider(settings.llmProvider || 'azure')
  }, [settings])

  const handleSave = async () => {
    setLoading(true)
    await onSave({ ...settings, llmProvider: provider }).finally(() => setLoading(false))
    onClose()
  }

  const envInfo = PROVIDER_ENV[provider]

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* Provider selector */}
          <section className="space-y-2">
            <h4 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              LLM Provider
            </h4>
            <Select value={provider} onValueChange={setProvider}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="azure">Azure OpenAI</SelectItem>
                <SelectItem value="groq">Groq</SelectItem>
                <SelectItem value="ollama">Ollama (local)</SelectItem>
              </SelectContent>
            </Select>
          </section>

          {/* .env hint */}
          <div className="rounded-lg border border-border bg-muted/50 p-3 flex gap-2.5">
            <Info className="h-4 w-4 text-primary shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="text-xs font-medium text-foreground">
                Credentials are read from <code className="text-primary">.env</code>
              </p>
              <p className="text-xs text-muted-foreground leading-relaxed">
                For <span className="text-foreground font-medium">{envInfo.label}</span>, make sure these are set in your <code>.env</code> file:
              </p>
              <ul className="mt-1 space-y-0.5">
                {envInfo.vars.map(v => (
                  <li key={v} className="font-mono text-[11px] text-primary/90">{v}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>

        <div className="flex gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={onClose} className="flex-1">Cancel</Button>
          <Button size="sm" onClick={handleSave} disabled={loading} className="flex-1">
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
