import { useCallback, useEffect, useRef, useState } from 'react'
import type { MemoryScope } from '../../../../shared/contracts/learning-memory'
import {
  LearningRequestGuard,
  learningScopeKey,
  type LearningRequestToken
} from './learning-view-state'

interface LearningOperation {
  busy: boolean
  error: string
  notice: string
  execute<T>(
    work: () => Promise<T>,
    saved: (value: T) => void,
    message?: string | ((value: T) => string)
  ): Promise<void>
}
export function learningErrorText(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请重试。'
}
export function useLearningOperation(scope: MemoryScope): LearningOperation {
  const guard = useRef(new LearningRequestGuard()),
    pending = useRef<LearningRequestToken | null>(null)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('')
  const scopeKey = learningScopeKey(scope)
  useEffect(() => {
    const current = guard.current
    current.select(scope)
    return () => {
      current.invalidateAll()
      pending.current = null
    }
    // The canonical key contains every scope field, independent of object reference/order.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey])
  const execute = useCallback(
    async <T>(
      work: () => Promise<T>,
      saved: (value: T) => void,
      message?: string | ((value: T) => string)
    ): Promise<void> => {
      if (pending.current) return
      const token = guard.current.begin('mutation')
      pending.current = token
      setBusy(true)
      setError('')
      setNotice('')
      try {
        const value = await work()
        if (!guard.current.accepts(token)) return
        saved(value)
        setNotice(typeof message === 'function' ? message(value) : (message ?? ''))
      } catch (failure) {
        if (guard.current.accepts(token)) setError(learningErrorText(failure))
      } finally {
        if (pending.current === token) {
          pending.current = null
          if (guard.current.accepts(token)) setBusy(false)
        }
      }
    },
    []
  )
  return { busy, error, notice, execute }
}
