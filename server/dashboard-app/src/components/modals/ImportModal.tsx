import { useState, useRef } from 'react'
import { Upload, Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import { Button } from '../ui/button'
import { Input } from '../ui/input'

interface Props {
  open: boolean
  onClose: () => void
  onImport: (file: File, title: string) => Promise<void>
}

export function ImportModal({ open, onClose, onImport }: Props) {
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [loading, setLoading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const handleSubmit = async () => {
    if (!file) return
    setLoading(true)
    await onImport(file, title).finally(() => setLoading(false))
    setFile(null)
    setTitle('')
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Import Audio</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div
            className="border-2 border-dashed border-border rounded-lg p-6 text-center cursor-pointer hover:border-primary/50 transition-colors"
            onClick={() => fileRef.current?.click()}
          >
            <Upload className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
            {file ? (
              <p className="text-xs text-foreground">{file.name}</p>
            ) : (
              <>
                <p className="text-xs font-medium text-foreground">Click to select audio file</p>
                <p className="text-[10px] text-muted-foreground mt-1">WebM, MP3, WAV, MP4 supported</p>
              </>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="audio/*,video/webm"
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
            />
          </div>

          <Input
            placeholder="Meeting title (optional)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="h-8 text-xs"
          />
        </div>

        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onClose} className="flex-1">Cancel</Button>
          <Button size="sm" onClick={handleSubmit} disabled={!file || loading} className="flex-1">
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            Upload & Process
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
