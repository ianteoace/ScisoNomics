const DETAIL = "scisonomicsSettingsDetail";
function urlFor(section: string | null) {
  const url = new URL(window.location.href);
  url.searchParams.delete("panel");
  if (section) url.searchParams.set("section", section); else url.searchParams.delete("section");
  return url.pathname + url.search + url.hash;
}
// Android's default WebView Back uses real browser history. Leave dialogs and
// native Back listeners untouched, and preserve Next's history metadata.
export function prepareSettingsHistory(section: string | null, android: boolean) {
  if (!android || !section || window.history.state?.[DETAIL]) return;
  const state = window.history.state;
  window.history.replaceState(state, "", urlFor(null));
  window.history.pushState({ ...state, [DETAIL]: true }, "", urlFor(section));
}
export function navigateSettingsHistory(section: string | null, android: boolean) {
  const history = window.history;
  if (android && !section && history.state?.[DETAIL]) { history.back(); return; }
  const url = urlFor(section);
  if (android && section && !history.state?.[DETAIL]) history.pushState({ ...history.state, [DETAIL]: true }, "", url);
  else history.replaceState(history.state, "", url);
}
