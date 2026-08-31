# ProtonMail Labels to Tags — Thunderbird Extension

> **Early stage warning**
> This is work at a very early stage. Things will go wrong — do not use this extension
> without being willing to have duplicated or wrong tags on your messages.

Synchronizes ProtonMail labels to local Thunderbird tags. Requires **ProtonMail Bridge** to be running.

---

## Features

- Reads your ProtonMail labels via Bridge and creates matching Thunderbird tags automatically.
- Reconciles tags on every sync: labels removed in ProtonMail are also removed from your messages in Thunderbird.
- Shows live progress and a summary in the popup.
- Remembers your last-used account across sessions.
- Sync is **read-only with respect to ProtonMail** — it only writes Thunderbird-local tags and never touches the server.

---

## Prerequisites

| Requirement | Notes |
| --- | --- |
| [ProtonMail Bridge](https://proton.me/mail/bridge) | Must be running; your account must be set up in Thunderbird via Bridge |
| Thunderbird 128 or later | Requires the MV3 MailExtension API |

---

## Installation

1. Go to the [Releases page](../../releases) and download the `.xpi` file from the latest release.
2. Open Thunderbird and go to **Tools → Add-ons and themes**.
3. Click the gear icon → **Install Add-on From File…**.
4. Select the downloaded `.xpi`.

---

## Usage

1. Click the **Sync ProtonMail Labels** button in the Thunderbird toolbar.
2. Select your ProtonMail Bridge account from the dropdown.
3. Click **Sync now**.

The popup shows live progress and a summary when the sync finishes:

```
Done!
Label folders: 5
Messages indexed: 1243
Messages updated: 87
```

If any folder could not be read or a message update fails, a warning line is appended — the sync always continues past individual failures.

While a sync is running a **Cancel sync** button appears. If Thunderbird was closed mid-sync previously, the stale in-progress state is cleared automatically on the next launch.

The extension looks for a top-level IMAP folder named **`Labels`** (case-insensitive). ProtonMail Bridge creates this folder automatically with one subfolder per label. No configuration file is needed.

---

## Known limitations

- **One-way sync only.** Tags are not written back to ProtonMail labels.
- **Bridge required.** Does not work without ProtonMail Bridge running locally.
- **No automatic sync.** Each run is a full scan triggered manually from the popup.
- **Nested label folders not supported.** Only direct children of `Labels` are used; sub-folders are ignored.

---

## Contributing

Bug reports and pull requests are welcome. Please open an issue before starting larger changes.

### Development environment

| Tool | Purpose | Remarks |
| --- | --- | --- |
| [Node.js](https://nodejs.org/) 18+ | Runs `web-ext` | `web-ext` is an npm package; Node.js is the only way to install and run it |
| [Task](https://taskfile.dev) | Task runner | Wraps npm scripts with named, documented tasks and handles dependencies (e.g. lint before build) |
| [Thunderbird](https://www.thunderbird.net/) 128+ | Runtime | The actual host for the extension; needed for `task dev` and all manual testing |
| [ProtonMail Bridge](https://proton.me/mail/bridge) | Data source | Creates the `Labels` IMAP folder the extension reads; without it there is nothing to sync |

After cloning, install JS dependencies once:

```bash
task install
```

Available tasks:

```
task install   install development dependencies
task lint      validate manifest and source files via web-ext
task build     package the extension into an installable .xpi
task dev       launch Thunderbird with the extension in a temporary profile
task clean     remove build artifacts
```

Run `task` with no arguments to list all tasks.

### Loading unpacked for development

1. Open Thunderbird → **Tools → Developer Tools → Debug Add-ons**.
2. Click **Load Temporary Add-on…** and select `src/manifest.json`.

The extension stays loaded until Thunderbird restarts. `task dev` does the same in a throwaway profile.

### Repository layout

```
protonmail-tb-sync/
├── src/
│   ├── manifest.json       — extension metadata and permissions
│   ├── background.js       — all sync logic
│   └── popup/
│       ├── popup.html      — toolbar button UI
│       └── popup.js        — popup controller
├── .web-ext-config.mjs     — web-ext sourceDir / artifactsDir
└── package.json            — dev tooling (web-ext)
```

### Architecture

#### How it works

ProtonMail Bridge exposes labels as IMAP subfolders: a message tagged "Work" in ProtonMail appears in both `Inbox` and `Labels/Work`. The extension uses this to map label folder membership back to Thunderbird tags.

#### Concurrency and state

- **`syncRunning` / `syncCancelled`** — module-level flags in `background.js`. `syncRunning` prevents a second concurrent sync if the popup is closed and reopened mid-run. `syncCancelled` suppresses `PROGRESS`/`DONE`/`ERROR` messages after the user cancels. Both flags are cleared in a `finally` block. `background.js` is the authoritative owner of `syncInProgress` in `storage.local`; a `browser.runtime.onStartup` listener clears it at Thunderbird launch to recover from crashes.
- **`MSG_REFRESH_BATCH_SIZE`** — constant (`50`) controlling how many `browser.messages.get()` calls run concurrently when refreshing tag state before each sync phase.
- **Parallel I/O** — system folder discovery and label folder fetching run concurrently. Individual folder failures return `null`; `skippedFolders` is derived post-hoc by counting `null` entries.

#### Folder model

- **Top-level folder discovery** — `browser.folders.query({ accountId })` filtered on `!f.parentId`. `getSubFolders(account)` is not used because Thunderbird 128 no longer accepts a `MailAccount` object there.
- **`findLabelsRoot`** — finds the top-level folder named `Labels` (case-insensitive), returns it or `null`.
- **`collectDescendants(folder, childrenOf, seen)`** — synchronously walks a pre-built `parentId → children[]` map; the `seen` Set guards against circular folder graphs.
- **`listAllMessages(folder)`** — paginates through `browser.messages.list` + `continueList` sequentially per folder; callers fan out across folders with `Promise.all`.

#### Indexing

- **`systemIndex`** — `Map<headerMessageId, MessageHeader[]>` built from all non-`Labels` folders.
- **`labelIndex`** — `Map<headerMessageId, Set<labelName>>` built from direct children of `Labels`.
- **`activeLabels`** — only labels appearing on at least one matched message; empty label folders never create Thunderbird tags.

#### Tag management

- **`buildTagKeyMap(labelNames)`** — resolves active labels to Thunderbird tag keys in one `tagApi.list()` call. Key and color allocation runs synchronously (JS is single-threaded), then all `tagApi.create()` calls run concurrently with `Promise.allSettled`. If a tag with the same name already exists it is reused without creation, preventing "Specified tag already exists" errors. `allPmKeys` is seeded from all existing `pm_*` keys so stale tags from deleted labels can be stripped. Non-`pm_*` reused keys are excluded from `allPmKeys` so user tags are never stripped.

#### Sync phases

- **Phase 1 — apply:** for each message in `labelIndex` that also appears in `systemIndex`, compute `desired = nonPmTags + tagKeys` and update only if the tag set changed. All updates run with `Promise.allSettled`.
- **Phase 2 — strip:** for each message in `systemIndex` not in `labelIndex`, remove any `pm_*` tags. All updates run with `Promise.allSettled`.

#### Permissions used

See [manifest.json](src/manifest.json)

| Permission | Why |
| --- | --- |
| `accountsRead` | List IMAP accounts so the user can pick one |
| `messagesRead` | Read messages and their headers across folders |
| `messagesTagsList` | Read the existing tag list |
| `messagesTags` | Create and manage tags |
| `messagesUpdate` | Write tags back to messages |
| `storage` | Remember the last-selected account across popup opens |
