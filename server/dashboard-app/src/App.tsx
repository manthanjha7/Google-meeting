import { useState, useEffect, useCallback } from 'react'
import { Sidebar, type Panel } from './components/layout/Sidebar'
import { MeetingList } from './components/meetings/MeetingList'
import { MeetingDetail } from './components/meetings/MeetingDetail'
import { AnalyticsPanel } from './components/analytics/AnalyticsPanel'
import { KbPanel } from './components/kb/KbPanel'
import { TemplatesPanel } from './components/templates/TemplatesPanel'
import { SpeakerMappingModal } from './components/modals/SpeakerMappingModal'
import { ImportModal } from './components/modals/ImportModal'
import { SettingsModal } from './components/modals/SettingsModal'
import { Toast } from './components/shared/Toast'
import { EmptyState } from './components/shared/EmptyState'
import { NameSetup } from './components/shared/NameSetup'
import { Spinner } from './components/shared/Spinner'
import { Button } from './components/ui/button'
import { Settings } from 'lucide-react'
import { api } from './api'
import { useIdentity } from './hooks/useIdentity'
import type { Meeting, Settings as SettingsType, ToastType } from './types'

interface ToastItem {
  id: number
  message: string
  type: ToastType
}

let toastId = 0

export default function App() {
  const { identity, ready, saveIdentity } = useIdentity()
  const [panel, setPanel] = useState<Panel>('meetings')
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [selectedMeeting, setSelectedMeeting] = useState<Meeting | null>(null)
  const [loadingMeetings, setLoadingMeetings] = useState(true)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [filterType, setFilterType] = useState('all')
  const [searchQ, setSearchQ] = useState('')
  const [settings, setSettings] = useState<SettingsType>({})
  const [toasts, setToasts] = useState<ToastItem[]>([])

  // Modals
  const [speakerModalOpen, setSpeakerModalOpen] = useState(false)
  const [importModalOpen, setImportModalOpen] = useState(false)
  const [settingsModalOpen, setSettingsModalOpen] = useState(false)

  const addToast = useCallback((message: string, type: ToastType = 'info') => {
    const id = ++toastId
    setToasts(prev => [...prev, { id, message, type }])
  }, [])

  const removeToast = (id: number) => setToasts(prev => prev.filter(t => t.id !== id))

  const loadMeetings = useCallback(async () => {
    setLoadingMeetings(true)
    try {
      const result = await api.meetings.list(filterType !== 'all' ? filterType : undefined, searchQ || undefined)
      setMeetings(result.meetings)
    } catch (e) {
      addToast('Failed to load meetings', 'error')
    } finally {
      setLoadingMeetings(false)
    }
  }, [filterType, searchQ, addToast])

  useEffect(() => { loadMeetings() }, [loadMeetings])

  useEffect(() => {
    api.settings.get().then(r => setSettings(r.settings)).catch(() => {})
  }, [])

  const selectMeeting = async (m: Meeting) => {
    setLoadingDetail(true)
    try {
      const result = await api.meetings.get(m.id)
      setSelectedMeeting(result.meeting)
    } catch {
      addToast('Failed to load meeting', 'error')
    } finally {
      setLoadingDetail(false)
    }
  }

  const handleMeetingUpdated = (updated: Meeting) => {
    setSelectedMeeting(updated)
    setMeetings(prev => prev.map(m => m.id === updated.id ? { ...m, ...updated } : m))
  }

  const handleMeetingDeleted = () => {
    setMeetings(prev => prev.filter(m => m.id !== selectedMeeting?.id))
    setSelectedMeeting(null)
    addToast('Meeting deleted', 'success')
  }

  const handleSaveSpeakers = async (speakerNames: Record<string, string>) => {
    if (!selectedMeeting) return
    const result = await api.meetings.saveSpeakers(selectedMeeting.id, speakerNames)
    handleMeetingUpdated(result.meeting)
    addToast('Speaker names saved', 'success')
  }

  const handleGetSuggestions = async (): Promise<Record<string, string>> => {
    if (!selectedMeeting) return {}
    const result = await api.meetings.speakerSuggestions(selectedMeeting.id)
    return result.suggestions
  }

  const handleImport = async (file: File, title: string) => {
    const formData = new FormData()
    formData.append('audio', file)
    if (title) formData.append('title', title)
    const res = await fetch('/api/upload', { method: 'POST', body: formData })
    if (!res.ok) throw new Error('Upload failed')
    addToast('Import started — refresh in a moment', 'info')
    setTimeout(loadMeetings, 3000)
  }

  const handleSaveSettings = async (s: SettingsType) => {
    await api.settings.save(s)
    setSettings(s)
    addToast('Settings saved', 'success')
  }

  if (!ready) return null
  if (!identity) return <NameSetup onSave={saveIdentity} />

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <Sidebar active={panel} onChange={setPanel} />

      {panel === 'meetings' && (
        <>
          <MeetingList
            meetings={meetings}
            loading={loadingMeetings}
            selectedId={selectedMeeting?.id || null}
            onSelect={selectMeeting}
            onRefresh={loadMeetings}
            onImport={() => setImportModalOpen(true)}
            filterType={filterType}
            setFilterType={setFilterType}
            searchQ={searchQ}
            setSearchQ={setSearchQ}
          />

          <main className="flex-1 overflow-hidden">
            {loadingDetail ? (
              <div className="flex h-full items-center justify-center"><Spinner className="h-8 w-8" /></div>
            ) : selectedMeeting ? (
              <MeetingDetail
                meeting={selectedMeeting}
                onUpdated={handleMeetingUpdated}
                onDeleted={handleMeetingDeleted}
                onSpeakersOpen={() => setSpeakerModalOpen(true)}
                onToast={addToast}
                identity={identity}
              />
            ) : (
              <EmptyState
                title="Select a meeting"
                description="Choose a meeting from the list to view its transcript, summary, and controls."
              />
            )}
          </main>
        </>
      )}

      {panel === 'analytics' && <main className="flex-1 overflow-y-auto"><AnalyticsPanel /></main>}
      {panel === 'kb' && <main className="flex-1 overflow-y-auto"><KbPanel /></main>}
      {panel === 'templates' && <main className="flex-1 overflow-hidden"><TemplatesPanel identity={identity} /></main>}

      {panel === 'settings' && (
        <main className="flex-1 overflow-y-auto p-6 max-w-xl">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-base font-semibold">Settings</h2>
          </div>
          <Button onClick={() => setSettingsModalOpen(true)}>
            <Settings className="h-4 w-4" />
            Open Settings
          </Button>
        </main>
      )}

      {/* Modals */}
      <SpeakerMappingModal
        open={speakerModalOpen}
        meeting={selectedMeeting}
        onClose={() => setSpeakerModalOpen(false)}
        onSave={handleSaveSpeakers}
        onGetSuggestions={handleGetSuggestions}
      />
      <ImportModal
        open={importModalOpen}
        onClose={() => setImportModalOpen(false)}
        onImport={handleImport}
      />
      <SettingsModal
        open={settingsModalOpen}
        settings={settings}
        identity={identity}
        onClose={() => setSettingsModalOpen(false)}
        onSave={handleSaveSettings}
        onNameChange={saveIdentity}
      />

      {/* Toast stack */}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
        {toasts.map(t => (
          <Toast key={t.id} message={t.message} type={t.type} onClose={() => removeToast(t.id)} />
        ))}
      </div>
    </div>
  )
}
