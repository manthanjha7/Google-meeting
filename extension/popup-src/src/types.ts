export type AppState = 'idle' | 'note-prompt' | 'meet-detected' | 'recording' | 'processing' | 'summary-ready' | 'error'

export interface Summary {
  title?: string
  summary?: string
  decisions?: string[]
  actionItems?: string[]
}

export interface StateData {
  startTime?: number
  step?: string
  summary?: Summary
  message?: string
  meetTabId?: number
}

export interface AudioLevels { mic: number; tab: number }
