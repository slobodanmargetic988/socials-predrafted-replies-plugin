// Opens the side panel from the toolbar icon, and keeps the extension's copy of the drafts
// file current. Nothing here touches X or Facebook pages.
importScripts("store.js");

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error("Reply Drafts: could not set panel behavior", err));

const SYNC_ALARM = "syncDrafts";

function sync() {
  return XStore.syncBundledFile().catch((err) => {
    console.error("Reply Drafts: could not read the drafts file", err);
    return { changed: false, error: String(err) };
  });
}

// Re-read the drafts file at install/reload, at Chrome startup, every few minutes,
// and whenever a reply box or the side panel asks.
chrome.alarms.get(SYNC_ALARM).then((alarm) => {
  if (!alarm) chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 5 });
});
chrome.runtime.onInstalled.addListener(sync);
chrome.runtime.onStartup.addListener(sync);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) sync();
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === "syncDrafts") {
    sync().then(sendResponse);
    return true;
  }
});
