import { useEffect, useRef, useState, type ReactNode } from 'react'
import './model-connection.css'

type Configuration = { provider: string; modelName: string; apiKey: string; baseURL: string }
type Result = { configuration: Configuration; success: boolean; message: string }

function matches(a: Configuration, b: Configuration): boolean {
  return (
    a.provider === b.provider &&
    a.modelName === b.modelName &&
    a.apiKey === b.apiKey &&
    a.baseURL === b.baseURL
  )
}

export default function ModelConnectionTest({
  configuration,
  children
}: {
  configuration: Configuration
  children: ReactNode
}): React.JSX.Element {
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<Result>()
  const busy = useRef(false)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const test = async (): Promise<void> => {
    if (busy.current) return
    const submitted = { ...configuration }
    const problem = !submitted.modelName.trim()
      ? '请先填写模型标识。'
      : !submitted.apiKey.trim()
        ? '请先填写 API Key。'
        : ''
    if (problem) {
      setResult({ configuration: submitted, success: false, message: problem })
      return
    }
    busy.current = true
    setTesting(true)
    setResult(undefined)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      if (!window.electron) throw new Error('请在桌面客户端测试模型连接。')
      const response = await Promise.race([
        window.electron.invoke('model:testConnection', submitted),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('测试超时，请检查网络或模型服务后重试。')),
            20000
          )
        })
      ])
      if (mounted.current)
        setResult({
          configuration: submitted,
          success: response?.success === true,
          message:
            response?.success === true
              ? '连接成功，模型已正常返回文本。可以保存此配置。'
              : response?.error || '连接失败，请检查模型标识、API Key 和 Base URL。'
        })
    } catch (error) {
      if (mounted.current)
        setResult({
          configuration: submitted,
          success: false,
          message: error instanceof Error ? error.message : '测试失败，请重试。'
        })
    } finally {
      if (timer) clearTimeout(timer)
      busy.current = false
      if (mounted.current) setTesting(false)
    }
  }

  const visibleResult = result && matches(result.configuration, configuration) ? result : undefined
  const message = visibleResult?.message.split(configuration.apiKey || '\u0000').join('••••••')
  return (
    <div className="model-connection-footer">
      <p className="form-hint">测试当前填写的配置，无需先保存。仅验证文本调用。</p>
      <div className="model-connection-feedback" aria-live="polite" aria-atomic="true">
        {testing ? (
          <p className="model-test-pending" role="status">
            正在连接模型，请稍候…
          </p>
        ) : (
          visibleResult && (
            <p
              className={`model-test-result ${visibleResult.success ? 'success' : 'error'}`}
              role={visibleResult.success ? 'status' : 'alert'}
            >
              {message}
            </p>
          )
        )}
      </div>
      <div className="modal-footer model-connection-actions">
        <button
          type="button"
          className="btn btn-secondary"
          disabled={testing}
          aria-busy={testing}
          onClick={() => void test()}
        >
          {testing ? '测试中…' : '测试连接'}
        </button>
        <div className="model-save-actions">{children}</div>
      </div>
    </div>
  )
}
