# WeChat AutoReply

[简体中文](README.md) · [Usage guide (Chinese)](docs/personal-wechat.md) · [Contributing](CONTRIBUTING.md)

A Windows foreground automation client for personal WeChat, based on SightFlow and built with Electron, React, vision models and a Windows window helper. This repository also includes a separate enterprise reply service.

**Development preview.** The single-contact workflow has limited real-message validation. Batch mode has not completed final continuous messaging validation with two real contacts, and enterprise background messaging requires a verified platform adapter. Open-source availability does not imply production readiness. See the [personal capability report](docs/capability-report.wechat.md) and [enterprise capability report](docs/capability-report.wework.md) for the recorded scope and limitations.

The dependency release gate still has unresolved advisories; see the [current release blockers](docs/releasing.md#当前依赖发布阻碍2026-11-03).

## Features and limitations

- Single contact: read visible new text, generate a reply using your rules and knowledge, verify the contact/window/draft, persist a SQLite journal, send and verify the outbound echo.
- Recovery and manual control: preserve progress across pauses and restarts; wait or stop for human drafts, conflicting identity or uncertain send results. Uncertain messages are never automatically replayed.
- Personalization: contact-specific rules, personal wording samples, knowledge retrieval, split replies and imported static sticker images.
- Batch mode: an explicit contact allowlist with shared progress. This remains experimental; see the [batch guide](docs/personal-wechat-batch.zh-CN.md).
- Enterprise service: device enrollment, controlled knowledge, working memory, human review and recovery. Window metadata probing alone cannot read or send background chats.

Personal mode occupies the current desktop and requires the complete WeChat window on the primary monitor, in the foreground. Switching apps or covering the chat with a notification makes it wait and revalidate. Group chats and incoming voice, image or file messages are not automatically treated as text. Vision requests can fail or time out; existing tests do not establish long-term reliability, complete message coverage or compatibility with future WeChat versions. Use only accounts and conversations you are authorized to handle, subject to applicable platform rules.

## Run from source

Full development requirements: **Windows x64, Node.js 24.21.0 (see [.node-version](.node-version)), .NET 10 SDK, Python 3 and Visual Studio C++ Build Tools with a Windows SDK**. Window-related native dependencies require `node-gyp` compilation on Node 24. Python is a build tool; no Python service is required to run the app. The optional `.local/toolchain` directory is not included in the repository.

```powershell
git clone https://github.com/zuixi01/Wechat-autoreply.git
cd Wechat-autoreply
npm ci
npm run dev
```

`npm ci` installs and rebuilds Electron native dependencies; leave lifecycle scripts enabled. Development startup and regular builds compile the personal WeChat helper and bind its hash. See [development setup](docs/development-environment.md) for toolchain details.

For source or documentation contributions only, `npm ci --ignore-scripts` can be followed by `npm run check:source` and `npm run verify`. It does not prepare Electron native dependencies and cannot validate client startup, desktop tests or Windows packages.

1. Sign in to personal WeChat. Keep one complete main window on the primary display.
2. Configure and test an HTTPS Chat Completions endpoint and key. Select a vision model supporting image input and a reply model on the home page.
3. Save reply rules; optionally add contact-specific requirements and knowledge.
4. Enter an exact contact name and start single-contact mode. If search cannot establish a unique match, manually open the intended private chat, clear its draft and use the current-chat connection button.

The first single-contact start creates a baseline without replying to history. Batch mode can process existing unread messages for the allowlisted contacts. Verify uncertain send results manually in WeChat before continuing. The [usage guide](docs/personal-wechat.md) covers recovery, draft checks and progress in detail. The helper pastes complete Unicode text while preserving supported clipboard formats, then reads back the draft for exact verification.

## Data and model requests

The vision model receives screenshots of WeChat windows, lists or message bubbles. The reply model receives new messages, recent history, reply rules, retrieved knowledge excerpts and applicable wording samples. Requests go to your configured provider and may incur fees. Running the client locally does not keep all chat data on your computer; review the provider's data policy and your authorization to process the data.

Model configuration and keys, contact rules, knowledge text, recognized messages, replies and progress are stored in the local application data directory. Do not share entire profiles, databases or unredacted logs/screenshots. See [data handling](docs/privacy.md) for paths and precautions, and the [enterprise service documentation](server/README.md) for its separate data boundary.

## Check and build

From the repository root:

```powershell
npm run check:source             # Source repository checks; does not start WeChat
npm run verify                   # Types, lint and routine automated tests
npm run build                    # App and personal WeChat helper compilation
```

Windows runnable directory and installer:

```powershell
npm run build:win:dev
npm run test:packaged-native
npm run test:desktop:release
npm run build:win:installer:dev
```

These checks do not replace real WeChat, install/upgrade, signing or long-term validation. Historical test counts do not establish that the current commit passes. See the [release checklist](docs/releasing.md) and [Windows build guide](docs/windows-installer.zh-CN.md). `npm run test:wechat` uses real profiles, models and conversations and can send messages; run it only with explicit authorization for a test contact as described in the usage guide.

## Documentation and contributions

| Guide | Contents |
| --- | --- |
| [Personal WeChat](docs/personal-wechat.md) / [Batch mode](docs/personal-wechat-batch.zh-CN.md) | Usage, recovery and limitations |
| [Development](docs/development-environment.md) / [Releases](docs/releasing.md) | Toolchain, validation and Windows delivery |
| [Data handling](docs/privacy.md) / [Security](SECURITY.md) | Data flow, private files and vulnerability reporting |
| [Enterprise service](server/README.md) / [Knowledge](docs/knowledge-management.md) | Independent service and knowledge workflows |
| [Contributing](CONTRIBUTING.md) / [Changelog](CHANGELOG.md) | Issues, changes and validation |

Reproducible bug reports and focused pull requests are welcome. Include OS, WeChat and app versions, redacted reproduction steps and errors. Do not upload private conversations, databases or keys. Historical development documents reference reports kept only on a maintainer's machine; reports not distributed with the repository cannot be opened through GitHub.

## License and attribution

Licensed under [Apache License 2.0](LICENSE), based on SightFlow. Upstream attribution remains in [NOTICE](NOTICE); retain the license, NOTICE and applicable third-party notices when distributing. This project is not officially affiliated with WeChat, WeCom or their operators.
