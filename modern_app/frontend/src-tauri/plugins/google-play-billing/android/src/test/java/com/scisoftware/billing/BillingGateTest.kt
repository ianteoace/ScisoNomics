package com.scisoftware.billing
import org.junit.Assert.*
import org.junit.Test

class BillingGateTest {
    @Test fun coalescesConnectionAndReconnects() {
        val gate=BillingGate();assertTrue(gate.startConnection());assertFalse(gate.startConnection())
        gate.connectionFinished();assertTrue(gate.startConnection())
    }
    @Test fun preventsDuplicatePurchaseAndAllowsRetryAfterCancel() {
        val gate=BillingGate();assertTrue(gate.startPurchase());assertFalse(gate.startPurchase())
        gate.purchaseFinished();assertTrue(gate.startPurchase())
    }
    @Test fun destroyedClientNeverStartsAnotherOperation() {
        val gate=BillingGate();gate.startConnection();gate.startPurchase();gate.destroy()
        // Late callbacks cannot revive an activity that has been destroyed.
        gate.connectionFinished();gate.purchaseFinished()
        assertFalse(gate.startConnection());assertFalse(gate.startPurchase())
    }
}
