package com.scisoftware.quickentry
import org.junit.Assert.*
import org.junit.Test

class QuickEntryQueueTest {
    private val a = "11111111-1111-4111-8111-111111111111"
    private val b = "22222222-2222-4222-8222-222222222222"
    @Test fun validatesColdAndWarmAndKeepsLatest() {
        var now = 1000L
        val ids = mutableSetOf<String>()
        val queue = QuickEntryQueue({ now }, ids::contains, { id, _ -> ids.add(id); true })
        assertFalse(queue.accept(a, "ingreso", now)); assertFalse(queue.accept("bad", "income", now))
        assertTrue(queue.accept(a, "income", now)); assertFalse(queue.accept(a, "income", now))
        now++; assertTrue(queue.accept(b, "expense", now)); assertEquals("expense", queue.peek()?.type)
        assertFalse(queue.consume(a)); assertTrue(queue.consume(b)); assertFalse(queue.consume(b)); assertNull(queue.peek())
        // A recreated plugin rejects an already-consumed root Activity intent.
        val recreated = QuickEntryQueue({ now }, ids::contains, { _, _ -> true })
        assertFalse(recreated.accept(b, "expense", now))
    }
    @Test fun expiryFutureTimeAndFailedAcknowledgementFailClosed() {
        var now = 1000L
        val queue = QuickEntryQueue({ now }, { false }, { _, _ -> false })
        assertFalse(queue.accept(a, "income", now + 1)); assertTrue(queue.accept(a, "expense", now))
        assertFalse(queue.consume(a)); assertNotNull(queue.peek())
        now += QUICK_ENTRY_TTL; assertNull(queue.peek()); assertFalse(queue.consume(a))
        assertFalse(queue.accept(a, "income", 1000))
    }
}
