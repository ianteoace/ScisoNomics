package com.scisoftware.quickentry

import android.app.Activity
import android.app.StatusBarManager
import android.content.ComponentName
import android.content.Intent
import android.graphics.drawable.Icon
import android.os.Build
import android.os.SystemClock
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONObject

@InvokeArg class ConsumeArgs { var id: String = "" }
@InvokeArg class TileArgs { var type: String = "" }

@TauriPlugin
class QuickEntryPlugin(private val activity: Activity) : Plugin(activity) {
    private val consumed = activity.getSharedPreferences("sciso_quick_entry_consumed", Activity.MODE_PRIVATE)
    // Only short-lived consumed navigation IDs are retained. Pending actions,
    // financial data, auth state and credentials never go into preferences.
    private fun consumedIds(): Set<String> {
        val now = SystemClock.elapsedRealtime()
        val live = (consumed.getStringSet("ids", emptySet()) ?: emptySet()).filter {
            val expiry = it.substringAfter(':', "").toLongOrNull() ?: return@filter false
            expiry - now in 1..QUICK_ENTRY_TTL
        }.toSet()
        if (live != consumed.getStringSet("ids", emptySet())) consumed.edit().putStringSet("ids", live).apply()
        return live
    }
    private val queue = QuickEntryQueue(SystemClock::elapsedRealtime,
        { id -> consumedIds().any { it.substringBefore(':') == id } },
        { id, expiry -> consumed.edit().putStringSet("ids", (consumedIds() + "$id:$expiry")
            .sortedBy { it.substringAfter(':').toLong() }.takeLast(32).toSet()).commit() })

    override fun load(webView: WebView) { super.load(webView); receive(activity.intent) }
    override fun onNewIntent(intent: Intent) { receive(intent) }
    private fun receive(intent: Intent?) {
        // Auth VIEW intents are untouched and continue through deep-link plugin.
        if (intent == null || intent.action != "${activity.packageName}.QUICK_ENTRY" || intent.data != null
            || intent.component?.className != "com.scisoftware.scisonomics.MainActivity") return
        val marker = intent.getBooleanExtra(ENTRY_MARKER, false)
        val type = intent.getStringExtra(ENTRY_TYPE)
        val id = intent.getStringExtra(ENTRY_ID)
        val issuedAt = intent.getLongExtra(ENTRY_TIME, -1)
        for (key in listOf(ENTRY_MARKER, ENTRY_TYPE, ENTRY_ID, ENTRY_TIME)) intent.removeExtra(key)
        if (marker && queue.accept(id, type, issuedAt)) payload()?.let { trigger("pending", it) }
    }
    private fun payload(): JSObject? {
        val value = queue.peek() ?: return null
        return JSObject().put("id", value.id).put("type", value.type)
            .put("remainingMs", value.issuedAt + QUICK_ENTRY_TTL - SystemClock.elapsedRealtime())
    }
    @Command fun peekPending(invoke: Invoke) = activity.runOnUiThread {
        invoke.resolve(JSObject().put("pending", payload() ?: JSONObject.NULL))
    }
    @Command fun consumePending(invoke: Invoke) = activity.runOnUiThread {
        val id = invoke.parseArgs(ConsumeArgs::class.java).id
        invoke.resolve(JSObject().put("consumed", queue.consume(id)))
    }
    @Command fun getInfo(invoke: Invoke) { invoke.resolve(JSObject().put("sdk", Build.VERSION.SDK_INT)) }
    private var addingTile = false
    @Command fun requestAddTile(invoke: Invoke) = activity.runOnUiThread {
        val type = invoke.parseArgs(TileArgs::class.java).type
        if (type !in listOf("income", "expense")) { invoke.reject("quick_entry_invalid_type"); return@runOnUiThread }
        if (Build.VERSION.SDK_INT < 33) { invoke.resolve(JSObject().put("status", "manual")); return@runOnUiThread }
        if (!activity.hasWindowFocus() || activity.isFinishing || addingTile) {
            invoke.resolve(JSObject().put("status", "unavailable")); return@runOnUiThread
        }
        val income = type == "income"
        val service = if (income) IncomeQuickTileService::class.java else ExpenseQuickTileService::class.java
        val label = activity.getString(if (income) R.string.sciso_tile_income else R.string.sciso_tile_expense)
        val icon = Icon.createWithResource(activity, if (income) R.drawable.sciso_tile_income else R.drawable.sciso_tile_expense)
        addingTile = true
        try {
            activity.getSystemService(StatusBarManager::class.java).requestAddTileService(
                ComponentName(activity, service), label, icon, activity.mainExecutor
            ) { result ->
                addingTile = false
                val status = when (result) {
                    StatusBarManager.TILE_ADD_REQUEST_RESULT_TILE_ADDED -> "added"
                    StatusBarManager.TILE_ADD_REQUEST_RESULT_TILE_ALREADY_ADDED -> "already_added"
                    StatusBarManager.TILE_ADD_REQUEST_RESULT_TILE_NOT_ADDED -> "not_added"
                    else -> "error"
                }
                invoke.resolve(JSObject().put("status", status))
            }
        } catch (_: Exception) { addingTile = false; invoke.resolve(JSObject().put("status", "error")) }
    }
}
