type MessageType =
  | 'GET_STATE' | 'START_RECORDING_REQUEST' | 'STOP_RECORDING' | 'STOP_REQUESTED'
  | 'CANCEL_RECORDING' | 'CANCEL_REQUESTED' | 'SEND_TO_SLACK' | 'RESET'
  | 'RECOVER_RECORDING' | 'DISMISS_RECOVERY' | 'GET_CALENDAR_STATUS'
  | 'CONNECT_CALENDAR' | 'DISCONNECT_CALENDAR' | 'TOGGLE_MIC_MUTE' | 'TOGGLE_TAB_MUTE'
  | 'ENABLE_NOTES' | 'SKIP_NOTES'

export function sendMsg(type: MessageType, payload?: Record<string, unknown>): Promise<any> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...payload }, (resp) => {
      if (chrome.runtime.lastError) { resolve(null); return }
      resolve(resp)
    })
  })
}

export function getStorage<T>(keys: string[]): Promise<Record<string, T>> {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve as any))
}

export function onStorageChange(callback: (changes: Record<string, chrome.storage.StorageChange>) => void) {
  chrome.storage.local.onChanged.addListener(callback)
  return () => chrome.storage.local.onChanged.removeListener(callback)
}
