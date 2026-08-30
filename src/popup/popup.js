/**
 * @file popup.js
 * @description UI controller for the ProtonMail Labels → Tags popup.
 *
 * Runs in the popup page opened by the toolbar button. Communicates with
 * background.js exclusively through `browser.runtime.sendMessage` (outbound)
 * and `browser.runtime.onMessage` (inbound). Persists the last-selected
 * account in `storage.local` so the UI restores it on next open.
 * Sync-in-progress state is owned by background.js; the popup reads it from
 * storage on open to recover correctly after being closed and reopened mid-sync.
 *
 * Message protocol (popup → background)
 * --------------------------------------
 * GET_ACCOUNTS              — request the list of IMAP accounts
 * SYNC        { accountId } — start a sync for the given account
 * CANCEL_SYNC               — request cancellation of the running sync
 *
 * Message protocol (background → popup)
 * --------------------------------------
 * PROGRESS  { status }  — human-readable status string during a sync
 * DONE      { result }  — sync completed; result contains counts
 * ERROR     { message } — sync failed; message contains the error text
 * CANCELLED             — background confirmed the sync was cancelled
 */

const accountSelect = document.getElementById('account');
const syncBtn = document.getElementById('syncBtn');
const resetBtn = document.getElementById('resetBtn');
const statusEl = document.getElementById('status');

/** A sync started more than this many ms ago is treated as stale/crashed. Must match syncStartedAt written by background.js. */
const SYNC_STALE_MS = 10 * 60 * 1000;

/** How long to wait for a CANCELLED confirmation before force-re-enabling the sync button. */
const CANCEL_FALLBACK_MS = 30_000;

/**
 * Updates the status area text and toggles the error style.
 *
 * @param {string} text - Message to display.
 * @param {boolean} [isError=false] - When true, applies the `.error` CSS class.
 */
function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.className = isError ? 'error' : '';
}

/**
 * Populates the account dropdown and restores UI state on popup open.
 * Sends GET_ACCOUNTS to the background, then reads storage to restore the
 * last-selected account and detect whether a sync is already in progress.
 * Syncs older than SYNC_STALE_MS are treated as crashed and reset automatically.
 */
(async () => {
  const accounts = await browser.runtime.sendMessage({ type: 'GET_ACCOUNTS' });
  accountSelect.innerHTML = '';
  if (!accounts.length) {
    accountSelect.innerHTML = '<option value="">No accounts found</option>';
    setStatus('No IMAP accounts found. Make sure ProtonMail Bridge is running and the account is added in Thunderbird.');
    return;
  }
  for (const acc of accounts) {
    const opt = document.createElement('option');
    opt.value = acc.id;
    opt.textContent = `${acc.name} (${acc.type})`;
    accountSelect.appendChild(opt);
  }

  const { lastAccountId, syncInProgress, syncStartedAt } =
    await browser.storage.local.get(['lastAccountId', 'syncInProgress', 'syncStartedAt']);

  if (lastAccountId) {
    const exists = [...accountSelect.options].some(o => o.value === lastAccountId);
    if (exists) accountSelect.value = lastAccountId;
  }

  const stale = syncInProgress && (Date.now() - (syncStartedAt || 0) > SYNC_STALE_MS);
  if (syncInProgress && !stale) {
    syncBtn.disabled = true;
    resetBtn.style.display = 'block';
    setStatus('Sync in progress…');
  } else {
    if (stale) {
      browser.storage.local.set({ syncInProgress: false });
      setStatus('Previous sync timed out — ready to retry.');
    }
    syncBtn.disabled = false;
  }
})().catch(err => setStatus('Failed to load accounts: ' + err.message, true));

/**
 * Sends a CANCEL_SYNC message to the background and shows a "Cancelling…" state.
 * The sync button stays disabled until the background confirms cancellation via a
 * CANCELLED message. A 30-second fallback re-enables the button in case the
 * background crashes before sending CANCELLED.
 */
resetBtn.addEventListener('click', () => {
  browser.runtime.sendMessage({ type: 'CANCEL_SYNC' }).catch(() => {});
  resetBtn.style.display = 'none';
  setStatus('Cancelling…');
  setTimeout(() => {
    if (syncBtn.disabled) {
      syncBtn.disabled = false;
      setStatus('Sync cancelled.');
    }
  }, CANCEL_FALLBACK_MS);
});

/**
 * Sends a SYNC message to the background for the currently selected account
 * and disables the sync button until the background responds.
 * Persists the selected account ID to storage for next-open restoration.
 */
syncBtn.addEventListener('click', () => {
  const accountId = accountSelect.value;
  if (!accountId) return;

  browser.storage.local.set({ lastAccountId: accountId });
  syncBtn.disabled = true;
  setStatus('Starting…');

  browser.runtime.sendMessage({ type: 'SYNC', accountId }).catch(err => {
    syncBtn.disabled = false;
    setStatus('Failed to start sync: ' + err.message, true);
  });
});

/**
 * Handles inbound messages from the background script.
 *
 * PROGRESS  — updates the status text with the current phase description.
 * DONE      — shows the sync summary (counts + any warnings) and re-enables the sync button.
 * ERROR     — shows the error message in red and re-enables the sync button.
 * CANCELLED — confirms cancellation and re-enables the sync button.
 *
 * @param {{ type: string, [key: string]: any }} msg - Message sent by the background.
 */
browser.runtime.onMessage.addListener(msg => {
  if (msg.type === 'PROGRESS') {
    setStatus(msg.status);
  } else if (msg.type === 'DONE') {
    resetBtn.style.display = 'none';
    const r = msg.result;
    let summary = `Done!\n` +
      `Label folders: ${r.labelFolders}\n` +
      `Messages indexed: ${r.uniqueMessagesIndexed}\n` +
      `Messages updated: ${r.messagesUpdated}`;
    if (r.foldersSkipped > 0) summary += `\nWarning: ${r.foldersSkipped} folder(s) skipped (read error)`;
    if (r.messagesFailed > 0) summary += `\nWarning: ${r.messagesFailed} message update(s) failed`;
    setStatus(summary);
    syncBtn.disabled = false;
  } else if (msg.type === 'ERROR') {
    resetBtn.style.display = 'none';
    setStatus(`Error: ${msg.message}`, true);
    syncBtn.disabled = false;
  } else if (msg.type === 'CANCELLED') {
    syncBtn.disabled = false;
    setStatus('Sync cancelled.');
  }
});
