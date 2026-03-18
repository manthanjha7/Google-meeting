import { useState, useEffect } from 'react'
import { Search, Trash2, PlusCircle, Loader2 } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Spinner } from '../shared/Spinner'
import { api } from '../../api'
import type { KbDoc } from '../../types'

export function KbPanel() {
  const [docs, setDocs] = useState<KbDoc[]>([])
  const [loading, setLoading] = useState(true)
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState<{ answer: string; sources: string[] } | null>(null)
  const [querying, setQuerying] = useState(false)
  const [addText, setAddText] = useState('')
  const [addName, setAddName] = useState('')
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    loadDocs()
  }, [])

  const loadDocs = () => {
    api.kb.docs().then((r) => setDocs(r.documents)).finally(() => setLoading(false))
  }

  const handleQuery = async () => {
    if (!question.trim()) return
    setQuerying(true)
    const result = await api.kb.query(question).finally(() => setQuerying(false))
    setAnswer(result)
  }

  const handleDelete = async (id: string) => {
    await api.kb.deleteDoc(id)
    setDocs(prev => prev.filter(d => d.id !== id))
  }

  const handleAdd = async () => {
    if (!addText.trim() || !addName.trim()) return
    setAdding(true)
    await api.kb.addText(addName, addText).finally(() => setAdding(false))
    setAddText('')
    setAddName('')
    loadDocs()
  }

  return (
    <div className="p-6 space-y-6 max-w-3xl mx-auto">
      <h2 className="text-base font-semibold text-foreground">Knowledge Base</h2>

      {/* Query */}
      <Card>
        <CardHeader><CardTitle>Ask a Question</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input
              placeholder="Ask about your meetings..."
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleQuery()}
              className="text-xs"
            />
            <Button size="sm" onClick={handleQuery} disabled={querying || !question.trim()}>
              {querying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
            </Button>
          </div>
          {answer && (
            <div className="rounded-lg bg-card/50 border border-border p-3 space-y-2">
              <p className="text-xs text-foreground leading-relaxed">{answer.answer}</p>
              {answer.sources?.length > 0 && (
                <p className="text-[10px] text-muted-foreground">Sources: {answer.sources.join(', ')}</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add text */}
      <Card>
        <CardHeader><CardTitle>Add Text</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <Input placeholder="Document name" value={addName} onChange={(e) => setAddName(e.target.value)} className="text-xs" />
          <textarea
            placeholder="Paste text to add to knowledge base..."
            value={addText}
            onChange={(e) => setAddText(e.target.value)}
            className="w-full rounded-md border border-input bg-input px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring min-h-[80px] resize-none"
          />
          <Button size="sm" onClick={handleAdd} disabled={adding || !addText.trim() || !addName.trim()}>
            {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlusCircle className="h-3.5 w-3.5" />}
            Add Document
          </Button>
        </CardContent>
      </Card>

      {/* Documents */}
      <Card>
        <CardHeader><CardTitle>Documents ({docs.length})</CardTitle></CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex justify-center py-4"><Spinner /></div>
          ) : docs.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4">No documents yet. Ingest a meeting or add text.</p>
          ) : (
            <div className="space-y-1">
              {docs.map((doc) => (
                <div key={doc.id} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                  <div>
                    <p className="text-xs text-foreground">{doc.name}</p>
                    <p className="text-[10px] text-muted-foreground">{doc.chunkCount} chunks</p>
                  </div>
                  <Button variant="ghost" size="icon" onClick={() => handleDelete(doc.id)} className="text-muted-foreground hover:text-destructive">
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
