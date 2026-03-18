export interface Meeting {
  id: string
  title?: string
  meet_title?: string
  created_at?: string
  duration_seconds?: number
  call_type?: string
  transcript?: string
  summary?: Summary
  audio_path?: string
  speakerNames?: Record<string, string>
  segments?: Segment[]
  meet_link?: string
  slack_posted?: boolean
  visibility?: 'private' | 'team'
  user_id?: string
  user_name?: string
}

export interface UserIdentity {
  id: string
  name: string
}

export interface Summary {
  title?: string
  summary?: string
  decisions?: string[]
  actionItems?: string[]
  followUps?: string[]
  nextSteps?: string[]
  deadlines?: string[]
  participants?: string[]
  customSections?: Array<{ title: string; content: string }>
}

export interface TemplateSection {
  id?: string
  title: string
  prompt: string
  position?: number
}

export interface Template {
  id: string
  name: string
  meeting_context: string
  sections: TemplateSection[]
  created_at?: string
  created_by_id?: string
  created_by_name?: string
}

export interface Segment {
  speaker: string
  text: string
  startTime?: number
  endTime?: number
  confidence?: number
}

export interface KbDoc {
  id: string
  name: string
  chunkCount: number
}

export interface Analytics {
  totalMeetings: number
  avgDurationSeconds: number
  totalDurationSeconds: number
  actionItemCount: number
  meetingsPerDay: Array<{ date: string; count: number }>
  byCallType: Array<{ type: string; count: number }>
  topParticipants: Array<{ name: string; count: number }>
}

export interface Settings {
  llmProvider?: string
  groqApiKey?: string
  groqModel?: string
  ollamaUrl?: string
  ollamaModel?: string
  azureEndpoint?: string
  azureKey?: string
  slackBotToken?: string
  slackChannelId?: string
  defaultTemplate?: string
  customPrompt?: string
  linesPerPage?: number
}

export type ToastType = 'success' | 'error' | 'info'
