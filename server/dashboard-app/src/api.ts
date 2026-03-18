const BASE = '/api'

function getIdentityHeaders(): Record<string, string> {
  const id = localStorage.getItem('finrep_user_id')
  const name = localStorage.getItem('finrep_user_name')
  const headers: Record<string, string> = {}
  if (id) headers['X-User-ID'] = id
  if (name) headers['X-User-Name'] = name
  return headers
}

async function req<T>(path: string, opts?: RequestInit): Promise<T> {
  const identityHeaders = getIdentityHeaders()
  const existingHeaders = (opts?.headers as Record<string, string>) || {}
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { ...identityHeaders, ...existingHeaders },
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || res.statusText)
  }
  return res.json()
}

export const api = {
  meetings: {
    list: (type?: string, q?: string) => {
      const params = new URLSearchParams()
      if (type && type !== 'all') params.set('type', type)
      if (q) params.set('q', q)
      return req<{ meetings: import('./types').Meeting[] }>(`/meetings?${params}`)
    },
    get: (id: string) => req<{ meeting: import('./types').Meeting }>(`/meetings/${id}`),
    updateTitle: (id: string, title: string) =>
      req(`/meetings/${id}/title`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) }),
    updateCallType: (id: string, callType: string) =>
      req<{ meeting: import('./types').Meeting }>(`/meetings/${id}/call-type`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callType }) }),
    delete: (id: string) => req(`/meetings/${id}`, { method: 'DELETE' }),
    saveSpeakers: (id: string, speakerNames: Record<string, string>) =>
      req<{ meeting: import('./types').Meeting }>(`/meetings/${id}/speakers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ speakerNames }) }),
    speakerSuggestions: (id: string) => req<{ suggestions: Record<string, string> }>(`/meetings/${id}/speaker-suggestions`),
    updateSummary: (id: string, summary: import('./types').Summary) =>
      req(`/meetings/${id}/summary`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ summary }) }),
    setVisibility: (id: string, visibility: 'private' | 'team') =>
      req<{ meeting: import('./types').Meeting }>(`/meetings/${id}/visibility`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visibility }) }),
    audioUrl: (id: string) => `${BASE}/meetings/${id}/audio`,
    exportUrl: (id: string, format: string) => `${BASE}/meetings/${id}/export/${format}`,
  },
  summarize: (meetingId: string, template: string, customPrompt: string, templateId?: string) =>
    req<{ summary: import('./types').Summary }>(`/summarize`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ meetingId, template, customPrompt, templateId }) }),
  transcribe: {
    retranscribe: (meetingId: string, numSpeakers?: number) =>
      req(`/transcribe/retranscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ meetingId, numSpeakers }) }),
  },
  analytics: () => req<import('./types').Analytics>(`/analytics`),
  settings: {
    get: () => req<{ settings: import('./types').Settings }>(`/settings`),
    save: (settings: import('./types').Settings) =>
      req(`/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) }),
  },
  kb: {
    query: (question: string) => req<{ answer: string; sources: string[] }>(`/kb/query`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question }) }),
    docs: () => req<{ documents: import('./types').KbDoc[] }>(`/kb/documents`),
    deleteDoc: (id: string) => req(`/kb/documents/${id}`, { method: 'DELETE' }),
    ingestMeeting: (meetingId: string) => req(`/kb/ingest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ meetingId }) }),
    addText: (name: string, text: string) => req(`/kb/add-text`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, text }) }),
  },
  slack: {
    send: (meetingId: string, callType: string) =>
      req(`/slack/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ meetingId, callType }) }),
  },
  templates: {
    list: () => req<{ templates: import('./types').Template[] }>(`/templates`),
    create: () => req<{ template: import('./types').Template }>(`/templates`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'New Template' }) }),
    update: (id: string, data: Partial<import('./types').Template>) =>
      req<{ template: import('./types').Template }>(`/templates/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
    delete: (id: string) => req(`/templates/${id}`, { method: 'DELETE' }),
  },
}
