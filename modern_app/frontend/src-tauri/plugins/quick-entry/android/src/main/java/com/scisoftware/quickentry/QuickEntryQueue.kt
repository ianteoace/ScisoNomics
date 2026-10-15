package com.scisoftware.quickentry

const val QUICK_ENTRY_TTL = 120_000L
data class PendingEntry(val id: String, val type: String, val issuedAt: Long)

// Navigation only, never accounts, amounts or financial writes. One latest item.
class QuickEntryQueue(private val clock: () -> Long, private val wasConsumed: (String) -> Boolean,
                      private val remember: (String, Long) -> Boolean) {
    private var pending: PendingEntry? = null
    fun accept(id: String?, type: String?, issuedAt: Long): Boolean {
        if (id == null || !id.matches(Regex("[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}")) || type !in listOf("income", "expense")) return false
        val age = clock() - issuedAt
        if (issuedAt < 0 || age !in 0 until QUICK_ENTRY_TTL || wasConsumed(id)) return false
        if (pending?.id == id || (peek()?.issuedAt ?: -1) > issuedAt) return false
        pending = PendingEntry(id, type!!, issuedAt); return true
    }
    fun peek(): PendingEntry? {
        if (pending?.let { clock() - it.issuedAt !in 0 until QUICK_ENTRY_TTL } == true) pending = null
        return pending
    }
    fun consume(id: String): Boolean {
        val value = peek() ?: return false
        if (id != value.id || !remember(id, value.issuedAt + QUICK_ENTRY_TTL)) return false
        pending = null; return true
    }
}
