import { useEffect } from 'react'
import { CheckCircle, AlertCircle, Info, X } from 'lucide-react'
import type { ToastType } from '../../types'

interface ToastProps {
  message: string
  type: ToastType
  onClose: () => void
}

const icons = {
  success: <CheckCircle className="h-4 w-4 text-green-400" />,
  error: <AlertCircle className="h-4 w-4 text-destructive" />,
  info: <Info className="h-4 w-4 text-primary" />,
}

const colors = {
  success: 'border-green-500/30 bg-green-500/10',
  error: 'border-destructive/30 bg-destructive/10',
  info: 'border-primary/30 bg-primary/10',
}

export function Toast({ message, type, onClose }: ToastProps) {
  useEffect(() => {
    const t = setTimeout(onClose, type === 'error' ? 8000 : 4000)
    return () => clearTimeout(t)
  }, [onClose, type])

  return (
    <div className={`flex items-start gap-3 rounded-lg border p-3 shadow-lg ${colors[type]} max-w-sm`}>
      {icons[type]}
      <p className="flex-1 text-xs text-foreground">{message}</p>
      <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
