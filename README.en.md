# WeChat AutoReply

A Windows personal WeChat client with a separate enterprise reply service, based on SightFlow. Attribution and licensing are in NOTICE and LICENSE. See the [Chinese guide](README.md) for the complete workflow.

The default personal workflow reads visible messages, generates a reply with your configured model and rules, verifies the contact/window/draft, writes a durable journal, sends, and verifies the outbound echo. WeChat must remain in the foreground. Losing focus waits; returning revalidates before continuing.

## Run

Windows x64, Node.js 24.21 or compatible Node 24, and .NET 10 SDK are required for development. The existing workspace can use `.local/toolchain`; a fresh checkout can use system tools. Native input installation may require Windows C++ build tools.

```powershell
npm ci
npm run dev
```

Configure an HTTPS Chat Completions endpoint and key, test the connection, select a vision-capable model and a reply model, then save reply rules. Enter an exact contact name and start. If search cannot identify a unique contact, manually open that private chat, clear its draft and use the current-chat connection button.

The first start establishes a baseline without replying to history. Pause/restart preserves progress. A changed window or policy requires explicitly reconnecting from current messages. Human drafts, manual replies and discontinuous history pause the process. Unknown send outcomes require manual verification in WeChat; reconciliation never automatically replays the message.

Batch processing is optional and limited to an explicit contact list. Enterprise services and working memory initialize when first opened. Enterprise background messaging still requires a verified platform adapter; the window probe alone cannot provide that capability.

## Validate and build

```powershell
npm run test:personal
npm run test:foreground-input
npm run verify
npm run build
npm run build:win:dev
npm run test:desktop:release
```

With an explicitly authorized contact, `npm run test:wechat -- --target "Exact name"` runs the real application and provider. It waits for a new inbound message, confirms one new outbound reply, then pauses and exits. It reports failure when no new message arrives or validation fails. Add `--current-chat` only after selecting the intended chat manually.

The pinned Windows helper writes Unicode character messages to the verified focused control in the foreground WeChat window, without the clipboard. It checks the window, process and focused control before every character. The application rereads the complete draft before pressing Enter. Initial connection allows a short wait for WeChat to return to the foreground.

Successful Windows builds retain two successful releases and recent diagnostics. `npm run clean:artifacts` previews cleanup; add `-- --apply` to execute it. Only allowlisted generated caches are eligible. Source, dependencies, toolchains, user profiles, databases and personal acceptance reports are preserved. Directory junctions are never followed.

Python sentiment training, unused providers/devices, offline design drafts and broken test commands have been removed. Personal replies do not require Python, PostgreSQL or an enterprise server.
