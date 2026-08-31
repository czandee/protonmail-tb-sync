/**
 * @file background.js
 * @description Background service script for the ProtonMail Labels → Tags extension.
 *
 * Synchronises ProtonMail labels to Thunderbird tags by exploiting the way
 * ProtonMail Bridge exposes labels over IMAP: each label appears as a subfolder
 * under a top-level folder named "Labels". A message that carries a label shows
 * up in both its real system folder (e.g. Inbox) and the corresponding Labels
 * subfolder. This script indexes both sets of folders, matches messages by their
 * Message-ID header, and writes Thunderbird tags accordingly.
 *
 * Sync is one-way (ProtonMail → Thunderbird) and non-incremental: every run
 * performs a full scan. pm_* tags for labels removed in ProtonMail are stripped
 * from messages on the next run.
 *
 * @requires ProtonMail Bridge (running, account added to Thunderbird via IMAP)
 * @requires Thunderbird 128+ (Manifest V3, browser.folders.query, browser.messages.tags)
 *
 * Module-level state
 * ------------------
 * @var {boolean} syncRunning    - True while a sync is in progress; blocks concurrent syncs.
 * @var {boolean} syncCancelled  - Set by a CANCEL_SYNC message; suppresses outbound
 *                                 PROGRESS/DONE/ERROR messages and causes the finally
 *                                 block to emit CANCELLED instead.
 */

let syncRunning = false;
let syncCancelled = false;

/** How many messages to refresh via messages.get() per concurrent batch. */
const MSG_REFRESH_BATCH_SIZE = 50;

/** Delay in ms after Thunderbird startup before triggering an auto-sync, to allow Bridge IMAP to connect. */
const STARTUP_SYNC_DELAY_MS = 15_000;

const tagApi = {
  list: () => browser.messages.tags.list(),
  create: (k, n, c) => browser.messages.tags.create(k, n, c),
};

/**
 * Returns all descendants of `folder` using a pre-built parent→children map.
 *
 * @param {MailFolder} folder - Root folder to start from.
 * @param {Map<string, MailFolder[]>} childrenOf - Maps MailFolderId to its direct children.
 * @param {Set<string>} [seen] - Visited folder IDs; a fresh set is created per top-level call.
 * @returns {MailFolder[]} All descendant folders in depth-first order.
 */
function collectDescendants(folder, childrenOf, seen = new Set()) {
  if (seen.has(folder.id)) return [];
  seen.add(folder.id);
  const children = childrenOf.get(folder.id) ?? [];
  return [...children, ...children.flatMap(f => collectDescendants(f, childrenOf, seen))];
}

/**
 * Fetches all messages in a folder, following pagination automatically.
 *
 * @param {MailFolder} folder - Folder to list; must have an `id` property.
 * @returns {Promise<MessageHeader[]>} Every message in the folder.
 */
async function listAllMessages(folder) {
  const messages = [];
  let page = await browser.messages.list(folder.id);
  while (page) {
    messages.push(...page.messages);
    page = page.id ? await browser.messages.continueList(page.id) : null;
  }
  return messages;
}

/**
 * Resolves ProtonMail label names to Thunderbird tag keys, creating missing tags as needed.
 *
 * Tag keys are generated as `pm_<normalized-label-name>` and are collision-safe.
 * Colors are assigned from a fixed palette, preferring slots not yet used by pm_* tags.
 * Case-variant label names that normalize to the same key share a tag and emit a warning.
 *
 * @param {Set<string>} labelNames - ProtonMail label names to resolve.
 * @returns {Promise<{ tagKeyMap: Map<string, string>, allPmKeys: Set<string> }>}
 *   `tagKeyMap` maps each label name to its Thunderbird tag key.
 *   `allPmKeys` contains every pm_* key known to Thunderbird — including keys for
 *   previously-deleted labels — so callers can strip stale tags from messages.
 */
async function buildTagKeyMap(labelNames) {
  const palette = ['#8B5CF6', '#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#EC4899'];
  const existing = await tagApi.list();
  const byName = new Map(existing.map(t => [t.tag.toLowerCase(), t.key]));
  const usedKeys = new Set(existing.map(t => t.key));
  // Track colors in use by pm_* tags so new tags pick unused slots first.
  const usedPmColors = new Set(
    existing.filter(t => t.key.startsWith('pm_')).map(t => t.color?.toLowerCase()).filter(Boolean)
  );

  const allPmKeys = new Set(existing.filter(t => t.key.startsWith('pm_')).map(t => t.key));

  const tagKeyMap = new Map();
  const toCreate = [];
  const seenLower = new Map();

  for (const name of labelNames) {
    const lower = name.toLowerCase();

    if (seenLower.has(lower)) {
      console.warn(`[pm-sync] Labels "${seenLower.get(lower)}" and "${name}" both normalize to "${lower}" — "${name}" will share the same Thunderbird tag.`);
    } else {
      seenLower.set(lower, name);
    }

    const existingKey = byName.get(lower);
    if (existingKey) {
      // Reuse any existing tag with this name. Non-pm_* keys are intentionally
      // excluded from allPmKeys so phase 2 never strips a user's own tag.
      tagKeyMap.set(name, existingKey);
      continue;
    }

    // Generate a key that doesn't collide with any existing key.
    const base = 'pm_' + lower.replace(/[^a-z0-9]/g, '_');
    let key = base;
    let n = 1;
    while (usedKeys.has(key)) key = `${base}_${n++}`;

    // Pick the first palette color not yet used by a pm_* tag; cycle if all are taken.
    const color = palette.find(c => !usedPmColors.has(c.toLowerCase()))
      ?? palette[usedPmColors.size % palette.length];
    usedPmColors.add(color.toLowerCase());

    // Register key immediately so later iterations see it as taken.
    byName.set(lower, key);
    usedKeys.add(key);
    allPmKeys.add(key);
    tagKeyMap.set(name, key);
    toCreate.push({ key, name, color });
  }

  const createResults = await Promise.allSettled(
    toCreate.map(({ key, name, color }) => tagApi.create(key, name, color))
  );
  for (let i = 0; i < createResults.length; i++) {
    if (createResults[i].status === 'rejected') {
      console.warn(`[pm-sync] Failed to create tag "${toCreate[i].name}" (key: ${toCreate[i].key}): ${createResults[i].reason}`);
      tagKeyMap.delete(toCreate[i].name);
      allPmKeys.delete(toCreate[i].key);
    }
  }
  return { tagKeyMap, allPmKeys };
}

/**
 * Finds the ProtonMail Bridge "Labels" root folder among an account's top-level folders.
 *
 * @param {MailFolder[]} topLevelFolders - Top-level folders to search (case-insensitive match).
 * @returns {MailFolder|null} The Labels folder, or null if not present.
 */
function findLabelsRoot(topLevelFolders) {
  return topLevelFolders.find(f => f.name.toLowerCase() === 'labels') ?? null;
}

/**
 * Runs a full label→tag sync for one IMAP account.
 *
 * Discovers all folders via `browser.folders.query`, separates them into label folders
 * (direct children of the "Labels" root) and system folders (everything else), then:
 *   1. Indexes every system-folder message by Message-ID header.
 *   2. Indexes every label-folder message to determine which labels each message carries.
 *   3. Applies the correct pm_* tags to labeled messages (phase 1).
 *   4. Strips stale pm_* tags from messages that no longer carry any label (phase 2).
 *
 * Individual folder or message failures are caught and counted rather than aborting the run.
 *
 * @param {string} accountId - ID of the MailAccount to sync.
 * @param {(progress: { status: string }) => void} progressCallback - Receives status strings during the sync.
 * @returns {Promise<{
 *   labelFolders: number,
 *   uniqueMessagesIndexed: number,
 *   messagesUpdated: number,
 *   messagesFailed: number,
 *   foldersSkipped: number
 * }>} Counts summarising the completed sync run.
 * @throws {Error} If no "Labels" folder is found for the account.
 */
async function syncAccount(accountId, progressCallback) {
  progressCallback({ status: 'Locating Labels folder…' });

  const allFolders = await browser.folders.query({ accountId });

  // Build a parent→children map for system folder tree traversal.
  const childrenOf = new Map();
  for (const f of allFolders) {
    if (f.parentId) {
      if (!childrenOf.has(f.parentId)) childrenOf.set(f.parentId, []);
      childrenOf.get(f.parentId).push(f);
    }
  }

  const topLevel = allFolders.filter(f => !f.parentId);
  const labelsRoot = findLabelsRoot(topLevel);
  if (!labelsRoot) {
    throw new Error(
      'No "Labels" folder found for this account. ' +
      'Make sure ProtonMail Bridge is connected and the account is fully synced.'
    );
  }

  // Label folders fetched via getSubFolders because Bridge's virtual Labels folder
  // exposes children with a parentId that doesn't match labelsRoot.id in query results.
  const labelFolders = await browser.folders.getSubFolders(labelsRoot.id);
  const systemTopLevel = topLevel.filter(f => f.id !== labelsRoot.id);
  const systemFolders = systemTopLevel.flatMap(f => [f, ...collectDescendants(f, childrenOf)]);

  progressCallback({
    status: `Found ${labelFolders.length} label(s), scanning messages…`
  });

  // Fetch system and label folder messages in parallel.
  // Individual folder failures are caught so one bad folder doesn't abort the sync.
  const [systemMsgResults, labelMsgResults] = await Promise.all([
    Promise.all(systemFolders.map(f => listAllMessages(f).catch(() => null))),
    Promise.all(labelFolders.map(f => listAllMessages(f).catch(err => {
      console.warn(`[pm-sync] Failed to read label folder "${f.name}": ${err.message}`);
      return null;
    }))),
  ]);

  const systemMsgArrays = systemMsgResults.map(r => r ?? []);
  const labelMsgArrays = labelMsgResults.map(r => r ?? []);
  const foldersSkipped = systemMsgResults.filter(r => r === null).length
    + labelMsgResults.filter(r => r === null).length;

  // Build systemIndex: headerMessageId → message objects in system folders
  const systemIndex = new Map();
  for (const msgs of systemMsgArrays) {
    for (const msg of msgs) {
      if (!msg.headerMessageId) continue;
      if (!systemIndex.has(msg.headerMessageId)) systemIndex.set(msg.headerMessageId, []);
      systemIndex.get(msg.headerMessageId).push(msg);
    }
  }

  // Build labelIndex: headerMessageId → Set of label names
  const labelIndex = new Map();
  for (let i = 0; i < labelFolders.length; i++) {
    for (const msg of labelMsgArrays[i]) {
      if (!msg.headerMessageId) continue;
      if (!labelIndex.has(msg.headerMessageId)) labelIndex.set(msg.headerMessageId, new Set());
      labelIndex.get(msg.headerMessageId).add(labelFolders[i].name);
    }
  }

  const totalMsgs = systemMsgArrays.reduce((n, msgs) => n + msgs.length, 0);
  progressCallback({ status: `Scanned ${totalMsgs} messages across ${systemFolders.length} folder(s), applying tags…` });

  // Only create Thunderbird tags for labels that actually appear on at least one
  // message. allPmKeys still covers all known pm_* keys (including previously-deleted
  // labels) so stale tags can be stripped in phase 2.
  const activeLabels = new Set([...labelIndex.values()].flatMap(s => [...s]));
  const { tagKeyMap, allPmKeys } = await buildTagKeyMap(activeLabels);

  // Refresh tags via messages.get() — messages.list() does not reliably populate
  // MessageHeader.tags on the first call after extension load in TB 128.
  // Covers phase 1 (labeled messages) and phase 2 candidates (unlabeled messages
  // whose stale data already shows pm_* keys, to confirm before stripping).
  // Requests are batched to avoid flooding the messages API.
  const msgsToRefresh = [];
  for (const msgId of labelIndex.keys()) {
    for (const msg of systemIndex.get(msgId) ?? []) msgsToRefresh.push(msg);
  }
  for (const [msgId, msgs] of systemIndex) {
    if (labelIndex.has(msgId)) continue;
    for (const msg of msgs) {
      if ((msg.tags || []).some(k => allPmKeys.has(k))) msgsToRefresh.push(msg);
    }
  }
  const freshTags = new Map(); // messageId → tags[]
  for (let i = 0; i < msgsToRefresh.length; i += MSG_REFRESH_BATCH_SIZE) {
    await Promise.all(
      msgsToRefresh.slice(i, i + MSG_REFRESH_BATCH_SIZE).map(msg =>
        browser.messages.get(msg.id)
          .then(full => freshTags.set(msg.id, full.tags || []))
          .catch(() => freshTags.set(msg.id, msg.tags || []))
      )
    );
  }

  // Phase 1: messages with labels — replace pm_* tags with exactly the current set.
  // Non-pm_* tags on the message are preserved.
  const phase1Promises = [];
  for (const [msgId, labelNames] of labelIndex) {
    const systemMsgs = systemIndex.get(msgId);
    if (!systemMsgs) continue;

    const tagKeys = [...labelNames].map(n => tagKeyMap.get(n)).filter(Boolean);

    for (const msg of systemMsgs) {
      const current = freshTags.get(msg.id) ?? [];
      const nonPm = current.filter(k => !allPmKeys.has(k));
      const desired = [...new Set([...nonPm, ...tagKeys])];
      const currentSet = new Set(current);
      const desiredSet = new Set(desired);
      const changed = desired.some(k => !currentSet.has(k)) || current.some(k => !desiredSet.has(k));
      if (changed) {
        phase1Promises.push(browser.messages.update(msg.id, { tags: desired }));
      }
    }
  }
  if (phase1Promises.length) progressCallback({ status: `Applying tags to ${phase1Promises.length} message(s)…` });
  const phase1Results = await Promise.allSettled(phase1Promises);
  const phase1Failed = phase1Results.filter(r => r.status === 'rejected').length;

  // Phase 2: messages with no labels — strip any stale pm_* tags.
  const phase2Promises = [];
  for (const [msgId, msgs] of systemIndex) {
    if (labelIndex.has(msgId)) continue;
    for (const msg of msgs) {
      const current = freshTags.get(msg.id) ?? msg.tags ?? [];
      if (!current.some(k => allPmKeys.has(k))) continue;
      phase2Promises.push(browser.messages.update(msg.id, { tags: current.filter(k => !allPmKeys.has(k)) }));
    }
  }
  if (phase2Promises.length) progressCallback({ status: `Stripping stale tags from ${phase2Promises.length} message(s)…` });
  const phase2Results = await Promise.allSettled(phase2Promises);
  const phase2Failed = phase2Results.filter(r => r.status === 'rejected').length;

  return {
    labelFolders: labelFolders.length,
    uniqueMessagesIndexed: systemIndex.size,
    messagesUpdated: phase1Promises.length + phase2Promises.length - phase1Failed - phase2Failed,
    messagesFailed: phase1Failed + phase2Failed,
    foldersSkipped,
  };
}

/**
 * Manages sync state and runs a full sync for the given account.
 * PROGRESS/DONE/ERROR/CANCELLED messages are sent to the popup if it is open;
 * if no popup is listening the sends fail silently via .catch(() => {}).
 * This allows runSync to be called both from the message handler (popup open)
 * and from the startup listener (popup not open).
 *
 * @param {string} accountId - ID of the account to sync.
 */
async function runSync(accountId) {
  if (syncRunning) return;
  syncRunning = true;
  syncCancelled = false;
  browser.storage.local.set({ syncInProgress: true, syncStartedAt: Date.now() });
  try {
    const result = await syncAccount(accountId, (progress) => {
      if (!syncCancelled) browser.runtime.sendMessage({ type: 'PROGRESS', ...progress }).catch(() => {});
    });
    if (!syncCancelled) browser.runtime.sendMessage({ type: 'DONE', result }).catch(() => {});
  } catch (err) {
    if (!syncCancelled) browser.runtime.sendMessage({ type: 'ERROR', message: err.message }).catch(() => {});
  } finally {
    const wasCancelled = syncCancelled;
    syncRunning = false;
    syncCancelled = false;
    browser.storage.local.set({ syncInProgress: false });
    if (wasCancelled) browser.runtime.sendMessage({ type: 'CANCELLED' }).catch(() => {});
  }
}

// Clear any stale syncInProgress flag left over from a previous Thunderbird crash.
// The finally block in runSync normally clears it, but won't run if the process is
// killed before it completes. If autoSyncOnStartup is enabled and a lastAccountId is
// saved, trigger a silent sync after a short delay to allow Bridge IMAP to connect.
browser.runtime.onStartup.addListener(async () => {
  browser.storage.local.set({ syncInProgress: false });

  const { autoSyncOnStartup, lastAccountId } =
    await browser.storage.local.get(['autoSyncOnStartup', 'lastAccountId']);
  if (!autoSyncOnStartup || !lastAccountId) return;

  await new Promise(resolve => setTimeout(resolve, STARTUP_SYNC_DELAY_MS));
  runSync(lastAccountId);
});

browser.runtime.onMessage.addListener(async (msg) => {
  if (msg.type === 'GET_ACCOUNTS') {
    const accounts = await browser.accounts.list();
    return accounts.filter(a => a.type === 'imap').map(a => ({ id: a.id, name: a.name, type: a.type }));
  }

  if (msg.type === 'CANCEL_SYNC') {
    syncCancelled = true;
    return;
  }

  if (msg.type === 'SYNC') {
    runSync(msg.accountId);
  }
});
