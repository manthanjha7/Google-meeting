import { useState, useEffect } from 'react'
import type { UserIdentity } from '../types'

const ID_KEY = 'finrep_user_id'
const NAME_KEY = 'finrep_user_name'

function generateId() {
  return crypto.randomUUID()
}

export function useIdentity() {
  const [identity, setIdentity] = useState<UserIdentity | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const storedId = localStorage.getItem(ID_KEY)
    const storedName = localStorage.getItem(NAME_KEY)
    if (storedId && storedName) {
      setIdentity({ id: storedId, name: storedName })
    }
    setReady(true)
  }, [])

  const saveIdentity = (name: string) => {
    const id = localStorage.getItem(ID_KEY) || generateId()
    localStorage.setItem(ID_KEY, id)
    localStorage.setItem(NAME_KEY, name)
    setIdentity({ id, name })
  }

  const clearIdentity = () => {
    localStorage.removeItem(ID_KEY)
    localStorage.removeItem(NAME_KEY)
    setIdentity(null)
  }

  return { identity, ready, saveIdentity, clearIdentity }
}
