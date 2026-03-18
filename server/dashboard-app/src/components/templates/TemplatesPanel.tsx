import { useState, useEffect } from 'react'
import { Plus, Trash2, GripVertical, FileText, Loader2 } from 'lucide-react'
import { Button } from '../ui/button'
import { api } from '../../api'
import type { Template, TemplateSection } from '../../types'

type KeyedSection = TemplateSection & { _key: string }

interface DraftTemplate {
  id: string
  name: string
  meeting_context: string
  sections: KeyedSection[]
  created_at?: string
}

function SectionEditor({
  section,
  onChange,
  onDelete,
}: {
  section: KeyedSection
  onChange: (s: KeyedSection) => void
  onDelete: () => void
}) {
  return (
    <div className="rounded-lg border border-border bg-card/50 p-3 space-y-2 group">
      <div className="flex items-center gap-2">
        <GripVertical className="h-4 w-4 text-muted-foreground/40 shrink-0" />
        <input
          className="flex-1 bg-transparent text-sm font-semibold text-foreground placeholder:text-muted-foreground/50 outline-none"
          placeholder="Section title"
          value={section.title}
          onChange={e => onChange({ ...section, title: e.target.value })}
        />
        <button
          onClick={onDelete}
          className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <textarea
        className="w-full bg-transparent text-xs text-muted-foreground placeholder:text-muted-foreground/40 outline-none resize-none leading-relaxed"
        placeholder="Describe what to extract in this section..."
        rows={2}
        value={section.prompt}
        onChange={e => onChange({ ...section, prompt: e.target.value })}
      />
    </div>
  )
}

function toKeyed(sections: TemplateSection[]): KeyedSection[] {
  return sections.map((s, i) => ({ ...s, _key: s.id || String(i) }))
}

function toDraft(t: Template): DraftTemplate {
  return { ...t, sections: toKeyed(t.sections) }
}

export function TemplatesPanel() {
  const [templates, setTemplates] = useState<Template[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<DraftTemplate | null>(null)
  const [saving, setSaving] = useState(false)
  const [creating, setCreating] = useState(false)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    api.templates.list().then(r => {
      setTemplates(r.templates)
      if (r.templates.length > 0) {
        setSelectedId(r.templates[0].id)
      }
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!selectedId) return
    const t = templates.find(t => t.id === selectedId)
    if (t) {
      setDraft(toDraft(t))
      setDirty(false)
    }
  }, [selectedId, templates])

  const handleCreate = async () => {
    setCreating(true)
    try {
      const r = await api.templates.create()
      setTemplates(prev => [...prev, r.template])
      setSelectedId(r.template.id)
    } finally {
      setCreating(false)
    }
  }

  const handleSave = async () => {
    if (!draft) return
    setSaving(true)
    try {
      const r = await api.templates.update(draft.id, {
        name: draft.name,
        meeting_context: draft.meeting_context,
        sections: draft.sections.map((s, i) => ({ title: s.title, prompt: s.prompt, position: i })),
      })
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
    setSelectedId(prev => {
      if (prev !== id) return prev
      return remaining.length > 0 ? remaining[0].id : null
    })
  }

  const updateDraft = (updates: Partial<DraftTemplate>) => {
    setDraft(prev => prev ? { ...prev, ...updates } : prev)
    setDirty(true)
  }

  const addSection = () => {
    if (!draft) return
    updateDraft({
      sections: [
        ...draft.sections,
        { title: '', prompt: '', _key: String(Date.now()) },
      ],
    })
  }

  const updateSection = (key: string, updated: KeyedSection) => {
    if (!draft) return
    updateDraft({
      sections: draft.sections.map(s => s._key === key ? updated : s),
    })
  }

  const deleteSection = (key: string) => {
    if (!draft) return
    updateDraft({ sections: draft.sections.filter(s => s._key !== key) })
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left sidebar */}
      <div className="w-56 shrink-0 border-r border-border flex flex-col overflow-hidden">
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
              onClick={() => setSelectedId(t.id)}
              className={`w-full text-left flex items-center gap-2 px-2.5 py-2 rounded-md text-sm transition-colors ${
                selectedId === t.id
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              }`}
            >
              <FileText className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{t.name || 'Untitled'}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Right editor */}
      {draft ? (
        <div className="flex-1 overflow-y-auto p-6 space-y-6 max-w-2xl">
          {/* Name */}
          <div className="flex items-start justify-between gap-4">
            <input
              className="flex-1 bg-transparent text-xl font-semibold text-foreground placeholder:text-muted-foreground/50 outline-none border-b border-transparent focus:border-border pb-1 transition-colors"
              placeholder="Template name"
              value={draft.name}
              onChange={e => updateDraft({ name: e.target.value })}
            />
            <div className="flex gap-2 shrink-0">
              <Button variant="outline" size="sm" onClick={() => handleDelete(draft.id)} className="text-muted-foreground hover:text-destructive">
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
              <Button size="sm" onClick={handleSave} disabled={saving || !dirty}>
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
                Save
              </Button>
            </div>
          </div>

          {/* Meeting Context */}
          <div className="space-y-2">
            <h4 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Meeting Context</h4>
            <textarea
              className="w-full rounded-lg border border-border bg-card/50 p-3 text-sm text-foreground placeholder:text-muted-foreground/50 outline-none focus:border-primary/50 resize-none leading-relaxed transition-colors"
              rows={4}
              placeholder="Describe the type of meeting and what you want to focus on. E.g. 'I had a call with a potential customer. I want to understand their needs and identify opportunities.'"
              value={draft.meeting_context}
              onChange={e => updateDraft({ meeting_context: e.target.value })}
            />
          </div>

          {/* Sections */}
          <div className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Sections</h4>
            {draft.sections.length === 0 && (
              <p className="text-xs text-muted-foreground">No sections yet. Add a section to define what to extract.</p>
            )}
            <div className="space-y-2">
              {draft.sections.map(s => (
                <SectionEditor
                  key={s._key}
                  section={s}
                  onChange={updated => updateSection(s._key, updated)}
                  onDelete={() => deleteSection(s._key)}
                />
              ))}
            </div>
            <Button variant="outline" size="sm" onClick={addSection} className="gap-1.5">
              <Plus className="h-3.5 w-3.5" />
              Add section
            </Button>
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
