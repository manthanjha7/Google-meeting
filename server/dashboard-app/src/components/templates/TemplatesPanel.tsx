import { useState, useEffect } from 'react'
import { Plus, Trash2, FileText, Loader2 } from 'lucide-react'
import { Button } from '../ui/button'
import { api } from '../../api'
import type { Template, UserIdentity } from '../../types'

interface TemplatesPanelProps {
  identity?: UserIdentity
}

export function TemplatesPanel({ identity }: TemplatesPanelProps) {
  const [templates, setTemplates] = useState<Template[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [saving, setSaving] = useState(false)
  const [creating, setCreating] = useState(false)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    api.templates.list().then(r => {
      setTemplates(r.templates)
      if (r.templates.length > 0) select(r.templates[0])
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function select(t: Template) {
    setSelectedId(t.id)
    setName(t.name || '')
    setPrompt((t as any).prompt || '')
    setDirty(false)
  }

  const handleCreate = async () => {
    setCreating(true)
    try {
      const r = await api.templates.create()
      setTemplates(prev => [...prev, r.template])
      select(r.template)
    } finally {
      setCreating(false)
    }
  }

  const handleSave = async () => {
    if (!selectedId) return
    setSaving(true)
    try {
      const r = await api.templates.update(selectedId, { name, prompt } as any)
      setTemplates(prev => prev.map(t => t.id === r.template.id ? r.template : t))
      setDirty(false)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this template?')) return
    await api.templates.delete(id)
    const remaining = templates.filter(t => t.id !== id)
    setTemplates(remaining)
    if (remaining.length > 0) select(remaining[0])
    else { setSelectedId(null); setName(''); setPrompt('') }
  }

  const selectedTemplate = templates.find(t => t.id === selectedId)

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left sidebar */}
      <div className="w-52 shrink-0 border-r border-border flex flex-col overflow-hidden">
        <div className="p-3 border-b border-border">
          <Button size="sm" className="w-full gap-1.5" onClick={handleCreate} disabled={creating}>
            {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            New Template
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {templates.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-8">No templates yet</p>
          )}
          {templates.map(t => (
            <button
              key={t.id}
              onClick={() => select(t)}
              className={`w-full text-left flex items-center gap-2 px-2.5 py-2 rounded-md transition-colors ${
                selectedId === t.id
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              }`}
            >
              <FileText className="h-3.5 w-3.5 shrink-0" />
              <div className="flex flex-col min-w-0">
                <span className="text-sm truncate">{t.name || 'Untitled'}</span>
                <span className="text-[10px] text-muted-foreground/60 truncate">
                  {(t as any).created_by_id === identity?.id ? 'Me' : ((t as any).created_by_name || 'System')}
                </span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Right editor */}
      {selectedTemplate ? (
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Header */}
          <div className="px-6 py-4 border-b border-border flex items-center gap-3">
            <input
              className="flex-1 bg-transparent text-lg font-semibold text-foreground placeholder:text-muted-foreground/50 outline-none"
              placeholder="Template name"
              value={name}
              onChange={e => { setName(e.target.value); setDirty(true) }}
            />
            <span className="text-xs text-muted-foreground shrink-0">
              by {(selectedTemplate as any).created_by_id === identity?.id ? 'Me' : ((selectedTemplate as any).created_by_name || 'System')}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleDelete(selectedId!)}
              className="text-muted-foreground hover:text-destructive shrink-0"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
            <Button size="sm" onClick={handleSave} disabled={saving || !dirty} className="shrink-0">
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
              Save
            </Button>
          </div>

          {/* Prompt editor */}
          <div className="flex-1 flex flex-col overflow-hidden p-6 gap-2">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Prompt</h4>
              <span className="text-[10px] text-muted-foreground/60">Supports markdown · The transcript is appended automatically</span>
            </div>
            <textarea
              className="flex-1 w-full rounded-lg border border-border bg-card/30 p-4 font-mono text-sm text-foreground placeholder:text-muted-foreground/40 outline-none focus:border-primary/50 resize-none leading-relaxed transition-colors"
              placeholder={`Describe what to extract from the meeting. For example:\n\nThis is a customer discovery call. Extract:\n\n## Pain Points\nList the specific problems the customer mentioned.\n\n## Feature Requests\nList any features or capabilities they asked for.\n\n## Next Steps\nWhat did we commit to?`}
              value={prompt}
              onChange={e => { setPrompt(e.target.value); setDirty(true) }}
            />
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
          {templates.length === 0 ? 'Create your first template' : 'Select a template'}
        </div>
      )}
    </div>
  )
}
