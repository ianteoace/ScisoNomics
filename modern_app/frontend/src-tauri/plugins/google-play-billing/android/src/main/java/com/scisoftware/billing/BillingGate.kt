package com.scisoftware.billing

// Main-thread state, independently testable without Android/Play Store.
class BillingGate {
    var destroyed = false; private set
    var connecting = false; private set
    var purchasing = false; private set
    fun startConnection(): Boolean {
        if (destroyed || connecting) return false
        connecting = true; return true
    }
    fun connectionFinished() { connecting = false }
    fun startPurchase(): Boolean {
        if (destroyed || purchasing) return false
        purchasing = true; return true
    }
    fun purchaseFinished() { purchasing = false }
    fun destroy() { destroyed = true; connecting = false; purchasing = false }
}
