package com.scisoftware.quickentry

import android.app.PendingIntent
import android.content.Intent
import android.graphics.drawable.Icon
import android.os.Build
import android.os.SystemClock
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import java.util.UUID

const val ENTRY_MARKER = "scisonomics_quick_entry"
const val ENTRY_TYPE = "scisonomics_quick_entry_type"
const val ENTRY_ID = "scisonomics_quick_entry_id"
const val ENTRY_TIME = "scisonomics_quick_entry_time"

abstract class QuickTileService : TileService() {
    abstract val kind: String
    abstract val labelRes: Int
    abstract val iconRes: Int
    override fun onStartListening() {
        super.onStartListening()
        qsTile?.apply {
            label = getString(labelRes); icon = Icon.createWithResource(this@QuickTileService, iconRes)
            state = Tile.STATE_INACTIVE; updateTile()
        }
    }
    override fun onClick() {
        super.onClick()
        if (isLocked) unlockAndRun { launchEntry() } else launchEntry()
    }
    @Suppress("DEPRECATION")
    private fun launchEntry() {
        val launch = packageManager.getLaunchIntentForPackage(packageName) ?: return
        // Explicit launcher component works with both release and .debug IDs.
        if (launch.component?.className != "com.scisoftware.scisonomics.MainActivity") return
        launch.action = "$packageName.QUICK_ENTRY"; launch.data = null
        launch.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        launch.putExtra(ENTRY_MARKER, true).putExtra(ENTRY_TYPE, kind)
            .putExtra(ENTRY_ID, UUID.randomUUID().toString()).putExtra(ENTRY_TIME, SystemClock.elapsedRealtime())
        if (Build.VERSION.SDK_INT >= 34) {
            val pending = PendingIntent.getActivity(this, if (kind == "income") 71 else 72, launch,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            startActivityAndCollapse(pending)
        } else startActivityAndCollapse(launch)
    }
}
class IncomeQuickTileService : QuickTileService() {
    override val kind = "income"
    override val labelRes = R.string.sciso_tile_income
    override val iconRes = R.drawable.sciso_tile_income
}
class ExpenseQuickTileService : QuickTileService() {
    override val kind = "expense"
    override val labelRes = R.string.sciso_tile_expense
    override val iconRes = R.drawable.sciso_tile_expense
}
