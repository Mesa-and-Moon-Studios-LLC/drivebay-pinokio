package com.lordstryfe.drivebay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DavStoreForTest {
    @Test fun fullScopeUsesTheWholePhoneStore() {
        val shares = MemoryDavStore().also { it.mkcol("/Shared") }
        val full = MemoryDavStore().also { it.mkcol("/DCIM") }
        val gate = object : DavAuthorizer {
            override fun authorized(header: String?, remote: String?): Boolean = true
            override fun acceptedScope(): String = "full"
        }
        val listing = DavProtocol.handle(
            DavRequest("PROPFIND", "/", mapOf("depth" to "1"), ByteArray(0), "10.0.0.2"),
            shares,
            gate,
            storeFor = { scope -> if (scope == "full") full else shares },
        )
        val xml = listing.body.toString(Charsets.UTF_8)
        assertEquals(207, listing.status)
        assertTrue(xml.contains("DCIM"))
        assertTrue(!xml.contains("Shared"))
    }
}
