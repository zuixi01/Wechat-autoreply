import { useEffect, useState } from 'react'
import type { PersonalResourcesApi } from '../../../../shared/contracts/personal-resources'

type Resources = Awaited<ReturnType<PersonalResourcesApi['resources']>>
export default function PersonalReplyResources({ target }: { target: string }): React.JSX.Element {
  const [data, setData] = useState<Resources>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [text, setText] = useState(''),
    [common, setCommon] = useState(false)
  const selected = common ? '' : target.trim()
  const refresh = async (): Promise<void> => {
    setData(await window.foregroundWechat.resources(selected))
  }
  const run = (action: () => Promise<unknown>): void => {
    setBusy(true)
    setError('')
    void action()
      .then(refresh)
      .catch(() => setError('操作未完成。支持 PNG/JPEG，单图不超过 4MB、2048×2048。'))
      .finally(() => setBusy(false))
  }
  useEffect(() => {
    let live = true
    void window.foregroundWechat
      .resources(selected)
      .then((value) => {
        if (live) setData(value)
      })
      .catch(() => {
        if (live) setError('暂时无法读取个人回复设置')
      })
    return () => {
      live = false
    }
  }, [selected])
  return (
    <section style={{ marginTop: 16 }} aria-label="自然回复素材和用词学习">
      <p className="form-hint">
        按内容选择 1–3 个气泡。图片只从你导入并启用的素材中选择，按语境偶尔发送。
      </p>
      {error && <p role="alert">{error}</p>}
      <h3>图片表情包</h3>
      <button
        className="btn btn-secondary btn-sm"
        disabled={busy}
        onClick={() => run(() => window.foregroundWechat.importSticker())}
      >
        导入 PNG / JPEG
      </button>
      {data?.stickers.map((asset) => (
        <div key={asset.id} style={{ marginTop: 10 }}>
          <label>
            <input
              type="checkbox"
              checked={asset.enabled}
              disabled={busy}
              onChange={(event) =>
                run(() =>
                  window.foregroundWechat.editSticker({
                    id: asset.id,
                    enabled: event.target.checked
                  })
                )
              }
            />{' '}
            {asset.label}（{asset.width}×{asset.height}）
          </label>
          <input
            aria-label={`${asset.label}的语境标签`}
            className="form-input"
            defaultValue={asset.tags.join('，')}
            placeholder="语境标签，例如 开心，感谢"
            onBlur={(event) => {
              const tags = event.target.value
                .split(/[,，]/)
                .map((value) => value.trim())
                .filter(Boolean)
                .slice(0, 8)
              if (JSON.stringify(tags) !== JSON.stringify(asset.tags))
                run(() => window.foregroundWechat.editSticker({ id: asset.id, tags }))
            }}
          />
          <button
            className="btn btn-secondary btn-sm"
            disabled={busy}
            onClick={() =>
              run(() => window.foregroundWechat.editSticker({ id: asset.id, delete: true }))
            }
          >
            删除
          </button>
        </div>
      ))}
      <h3 style={{ marginTop: 16 }}>长期个人用词学习</h3>
      <label>
        <input
          type="checkbox"
          checked={data?.learningEnabled ?? true}
          disabled={busy}
          onChange={(event) =>
            run(() => window.foregroundWechat.enableLearning(event.target.checked))
          }
        />{' '}
        学习已核验的人工外发用词
      </label>
      <p className="form-hint">
        只学习运行时确认由你手动发出的短句，排除程序回复。样本在本机保存；不把旧聊天自动当成本人样本，不把样本经历当作事实。
      </p>
      <label>
        <input
          type="checkbox"
          checked={common}
          onChange={(event) => setCommon(event.target.checked)}
        />{' '}
        编辑通用用词（未勾选时只用于 {target || '当前联系人'}）
      </label>
      <input
        className="form-input"
        value={text}
        maxLength={160}
        placeholder="也可以直接教一句你的常用回复"
        onChange={(event) => setText(event.target.value)}
      />
      <button
        className="btn btn-secondary btn-sm"
        disabled={busy || !text.trim() || (!common && !selected)}
        onClick={() =>
          run(async () => {
            await window.foregroundWechat.editStyle({ target: selected, action: 'teach', text })
            setText('')
          })
        }
      >
        保存用词
      </button>
      {data?.style.map((sample) => (
        <div key={`${sample.id}:${sample.revision}`} style={{ marginTop: 10 }}>
          <input
            className="form-input"
            aria-label="本人用词样本"
            defaultValue={sample.text}
            maxLength={160}
            onBlur={(event) => {
              if (event.target.value.trim() && event.target.value.trim() !== sample.text)
                run(() =>
                  window.foregroundWechat.editStyle({
                    target: selected,
                    id: sample.id,
                    action: 'correct',
                    text: event.target.value
                  })
                )
            }}
          />
          <button
            className="btn btn-secondary btn-sm"
            disabled={busy || sample.revision < 2}
            onClick={() =>
              run(() =>
                window.foregroundWechat.editStyle({
                  target: selected,
                  id: sample.id,
                  action: 'rollback'
                })
              )
            }
          >
            恢复上一版
          </button>{' '}
          <button
            className="btn btn-secondary btn-sm"
            disabled={busy}
            onClick={() =>
              run(() =>
                window.foregroundWechat.editStyle({
                  target: selected,
                  id: sample.id,
                  action: 'delete'
                })
              )
            }
          >
            删除样本
          </button>
        </div>
      ))}
    </section>
  )
}
