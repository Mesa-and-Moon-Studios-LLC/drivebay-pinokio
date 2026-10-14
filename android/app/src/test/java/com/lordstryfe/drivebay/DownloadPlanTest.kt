package com.lordstryfe.drivebay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DownloadPlanTest {
    @Test
    fun chunkSizeIsBetween8And16Megabytes() {
        assertTrue(DownloadPlan.CHUNK_BYTES in 8 * 1024 * 1024..16 * 1024 * 1024)
    }

    @Test
    fun nextChunkCoversTheFileInOrder() {
        val first = DownloadPlan.nextChunk(0, 20L * 1024 * 1024)
        assertEquals(0L, first!!.start)
        assertEquals(DownloadPlan.CHUNK_BYTES.toLong() - 1, first.endInclusive)
        assertEquals("bytes=0-${first.endInclusive}", DownloadPlan.rangeHeader(first))

        val last = DownloadPlan.nextChunk(18L * 1024 * 1024, 20L * 1024 * 1024)
        assertEquals(20L * 1024 * 1024 - 1, last!!.endInclusive)
        assertTrue(last.length < DownloadPlan.CHUNK_BYTES)
        assertNull(DownloadPlan.nextChunk(20L * 1024 * 1024, 20L * 1024 * 1024))
        assertNull(DownloadPlan.nextChunk(0, 0))
    }

    @Test
    fun contentRangeAndBackoff() {
        val range = DownloadPlan.parseContentRange("bytes 0-1048575/9000000")
        assertEquals(0L, range!!.start)
        assertEquals(1_048_575L, range.endInclusive)
        assertEquals(9_000_000L, range.total)
        assertNull(DownloadPlan.parseContentRange("bytes */10"))
        assertEquals(1000L, DownloadPlan.backoffMs(0))
        assertEquals(2000L, DownloadPlan.backoffMs(1))
        assertEquals(16000L, DownloadPlan.backoffMs(8))
        assertTrue(DownloadPlan.isRetryableStatus(503))
        assertFalse(DownloadPlan.isRetryableStatus(401))
        assertFalse(DownloadPlan.isRetryableStatus(416))
    }

    @Test
    fun speedAndTimeLeft() {
        assertEquals(1024.0, DownloadPlan.bytesPerSecond(1024, 1000), 0.01)
        assertEquals(2000L, DownloadPlan.etaMs(2048, 1024.0))
        val line = DownloadPlan.statusLine(1024, 2048, 1024.0)
        assertTrue(line.contains("1.0 KB/s"))
        assertTrue(line.contains("left"))
        assertEquals("2s left", DownloadPlan.formatDuration(2500))
        assertEquals("3 min left", DownloadPlan.formatDuration(180_000))
    }
}
