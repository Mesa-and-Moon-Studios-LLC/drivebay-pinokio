package com.lordstryfe.drivebay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.TimeZone

class DavBrowseTest {
    // Exactly what linked-dav.mjs sends for a folder listing, with a "&" and a space in names.
    private val listing = """<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">
<d:response><d:href>/dav/Home/Docs/</d:href><d:propstat><d:prop><d:displayname>Docs</d:displayname><d:resourcetype><d:collection/></d:resourcetype><d:getcontentlength>0</d:getcontentlength><d:getlastmodified>Tue, 17 Nov 2026 18:00:00 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
<d:response><d:href>/dav/Home/Docs/b%20-%20notes.txt</d:href><d:propstat><d:prop><d:displayname>b - notes.txt</d:displayname><d:resourcetype/><d:getcontentlength>2048</d:getcontentlength><d:getlastmodified>Mon, 02 Nov 2026 09:30:00 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
<d:response><d:href>/dav/Home/Docs/Zeta/</d:href><d:propstat><d:prop><d:displayname>Zeta</d:displayname><d:resourcetype><d:collection/></d:resourcetype><d:getcontentlength>0</d:getcontentlength><d:getlastmodified>Sun, 01 Nov 2026 00:00:00 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
<d:response><d:href>/dav/Home/Docs/alpha%20%26%20beta.pdf</d:href><d:propstat><d:prop><d:displayname>alpha &amp; beta.pdf</d:displayname><d:resourcetype/><d:getcontentlength>5242880</d:getcontentlength><d:getlastmodified>Sat, 31 Oct 2026 12:00:00 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>"""

    @Test fun parsesFoldersAndFilesAndSkipsTheFolderItself() {
        val entries = DavBrowse.parseMultistatus(listing, "/Home/Docs/", "/dav")!!
        assertEquals(3, entries.size)
        val zeta = entries.first { it.name == "Zeta" }
        assertTrue(zeta.isDir)
        assertEquals("/Home/Docs/Zeta/", zeta.path)
        val notes = entries.first { it.name == "b - notes.txt" }
        assertFalse(notes.isDir)
        assertEquals("/Home/Docs/b - notes.txt", notes.path)
        assertEquals(2048L, notes.size)
        val pdf = entries.first { it.name == "alpha & beta.pdf" }
        assertEquals(5242880L, pdf.size)
        assertEquals(1793448000000L, pdf.modifiedMs)
    }

    @Test fun foldersSortFirstThenFilesIgnoringCase() {
        val sorted = DavBrowse.sort(DavBrowse.parseMultistatus(listing, "/Home/Docs/", "/dav")!!)
        assertEquals(listOf("Zeta", "alpha & beta.pdf", "b - notes.txt"), sorted.map { it.name })
    }

    @Test fun parsesAnyNamespacePrefixAndAbsoluteHrefs() {
        val xml = """<D:multistatus xmlns:D="DAV:"><D:response><D:href>http://100.1.2.3:8765/dav/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>
<D:response><D:href>http://100.1.2.3:8765/dav/System/</D:href><D:propstat><D:prop><D:displayname>System</D:displayname><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response></D:multistatus>"""
        val entries = DavBrowse.parseMultistatus(xml, "/", "/dav")!!
        assertEquals(listOf("/System/"), entries.map { it.path })
        assertTrue(entries[0].isDir)
    }

    @Test fun aPhoneHostHasNoDavPrefix() {
        val xml = """<d:multistatus xmlns:d="DAV:"><d:response><d:href>/</d:href></d:response>
<d:response><d:href>/Pictures/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>"""
        assertEquals("", DavBrowse.basePath("http://100.1.2.3:8766/"))
        assertEquals(listOf("/Pictures/"), DavBrowse.parseMultistatus(xml, "/", "")!!.map { it.path })
    }

    @Test fun badOrHostileXmlIsRejectedNotThrown() {
        assertNull(DavBrowse.parseMultistatus("not xml", "/", "/dav"))
        assertNull(DavBrowse.parseMultistatus("<!DOCTYPE x [<!ENTITY a \"b\">]><d:multistatus xmlns:d=\"DAV:\"/>", "/", "/dav"))
        assertNotNull(DavBrowse.parseMultistatus("<d:multistatus xmlns:d=\"DAV:\"/>", "/", "/dav"))
    }

    @Test fun hrefsOutsideTheDavPrefixAreIgnored() {
        assertNull(DavBrowse.hrefToPath("/other/x", "/dav"))
        assertEquals("/", DavBrowse.hrefToPath("/dav", "/dav"))
        assertEquals("/a b/", DavBrowse.hrefToPath("/dav/a%20b/", "/dav"))
    }

    @Test fun pathHelpers() {
        assertEquals("/", DavBrowse.normalize(""))
        assertEquals("/a/b/", DavBrowse.normalize("a//b/./../"))
        assertTrue(DavBrowse.isRoot("/"))
        assertFalse(DavBrowse.isRoot("/Home/"))
        assertNull(DavBrowse.parent("/"))
        assertEquals("/", DavBrowse.parent("/Home/"))
        assertEquals("/Home/", DavBrowse.parent("/Home/Docs/"))
        assertEquals("/Home/Docs/", DavBrowse.parent("/Home/Docs/a.txt"))
        assertEquals("Home", DavBrowse.driveOf("/Home/Docs/"))
        assertNull(DavBrowse.driveOf("/"))
        assertEquals("/Home/Docs/", DavBrowse.child("/Home/", "Docs", true))
        assertEquals("/Home/Docs/a.txt", DavBrowse.child("/Home/Docs/", "a.txt", false))
        assertEquals("/Home/x", DavBrowse.child("/Home", "x", false))
        assertEquals("a.txt", DavBrowse.nameOf("/Home/Docs/a.txt"))
        assertEquals("/Home/Docs/", DavBrowse.folderPath("/Home/Docs"))
    }

    @Test fun breadcrumbsGoFromTheMachineToTheFolder() {
        val crumbs = DavBrowse.breadcrumbs("/Home/Docs/", "Mac mini")
        assertEquals(listOf("Mac mini", "Home", "Docs"), crumbs.map { it.label })
        assertEquals(listOf("/", "/Home/", "/Home/Docs/"), crumbs.map { it.path })
        assertEquals(listOf("Mac mini"), DavBrowse.breadcrumbs("/", "Mac mini").map { it.label })
    }

    @Test fun urlsEncodeEachSegmentAndKeepTheDavPrefix() {
        val base = "http://100.1.2.3:8765/dav/"
        assertEquals("http://100.1.2.3:8765/dav/", DavBrowse.urlFor(base, "/"))
        assertEquals("http://100.1.2.3:8765/dav/Home/my%20file%20%26%20more%23.txt", DavBrowse.urlFor(base, "/Home/my file & more#.txt"))
        assertEquals("http://100.1.2.3:8765/dav/Home/Docs/", DavBrowse.urlFor(base, "/Home/Docs/"))
        assertEquals("http://100.1.2.3:8766/Pictures/", DavBrowse.urlFor("http://100.1.2.3:8766/", "/Pictures/"))
        assertEquals("http://[fd7a::1]:8765/dav/x", DavBrowse.urlFor("http://[fd7a::1]:8765/dav/", "/x"))
        assertEquals("/a%20b/%C3%A9", DavBrowse.encodePath("/a b/é"))
    }

    @Test fun cannotEscapeTheRootWithDotDot() {
        assertEquals("/etc/passwd", DavBrowse.normalize("/../../etc/passwd"))
        assertEquals("/", DavBrowse.parent("/Home/"))
    }

    @Test fun namesAreChecked() {
        assertNotNull(DavBrowse.nameProblem(""))
        assertNotNull(DavBrowse.nameProblem("  "))
        assertNotNull(DavBrowse.nameProblem(".."))
        assertNotNull(DavBrowse.nameProblem("a/b"))
        assertNotNull(DavBrowse.nameProblem("a\\b"))
        assertNull(DavBrowse.nameProblem("New folder (2)"))
    }

    @Test fun uploadsNeverOverwriteByAccident() {
        assertEquals("a.txt", DavBrowse.uniqueName("a.txt", emptySet()))
        assertEquals("a (1).txt", DavBrowse.uniqueName("a.txt", setOf("a.txt")))
        assertEquals("a (2).txt", DavBrowse.uniqueName("a.txt", setOf("a.txt", "a (1).txt")))
        assertEquals("Makefile (1)", DavBrowse.uniqueName("Makefile", setOf("Makefile")))
    }

    @Test fun sizeAndDateLabels() {
        assertEquals("0 B", DavBrowse.formatSize(0))
        assertEquals("1023 B", DavBrowse.formatSize(1023))
        assertEquals("1.0 KB", DavBrowse.formatSize(1024))
        assertEquals("1.5 MB", DavBrowse.formatSize(1_572_864))
        assertEquals("250 MB", DavBrowse.formatSize(262_144_000))
        assertEquals("2.0 GB", DavBrowse.formatSize(2L * 1024 * 1024 * 1024))
        val utc = TimeZone.getTimeZone("UTC")
        assertEquals("Nov 17, 2026", DavBrowse.formatDate(1794938400000L, utc))
        assertEquals("", DavBrowse.formatDate(null, utc))
        val file = DavBrowse.Entry("a.pdf", "/a.pdf", false, 2048, 1794938400000L)
        assertEquals("2.0 KB · Nov 17, 2026", DavBrowse.subtitle(file, utc))
        assertEquals("Nov 17, 2026", DavBrowse.subtitle(file.copy(isDir = true), utc))
    }

    @Test fun iconsFollowTheType() {
        fun icon(name: String, dir: Boolean = false) = DavBrowse.icon(DavBrowse.Entry(name, "/$name", dir, 0, null))
        assertEquals(icon("x", true), icon("y", true))
        assertFalse(icon("pic.JPG") == icon("notes.txt"))
        assertEquals(icon("a.png"), icon("b.webp"))
        assertEquals(icon("a.pdf"), icon("b.docx"))
        assertFalse(icon("a.mp4") == icon("a.mp3"))
        assertFalse(icon("unknown.bin") == icon("a.pdf"))
        assertFalse(DavBrowse.icon(DavBrowse.Entry("Home", "/Home/", true, 0, null), true) == icon("x", true))
    }

    @Test fun errorsAreClearAndActionable() {
        assertTrue(DavBrowse.errorMessage(null).contains("Could not reach"))
        assertTrue(DavBrowse.errorMessage(401).contains("Join it again"))
        assertEquals("Uploads are turned off on this machine.", DavBrowse.errorMessage(403, "Uploads are turned off on this machine.\nextra"))
        assertEquals("That machine does not allow this.", DavBrowse.errorMessage(403, ""))
        assertTrue(DavBrowse.errorMessage(409, "", "create the folder").contains("create the folder"))
        assertTrue(DavBrowse.errorMessage(404).contains("gone"))
        assertTrue(DavBrowse.errorMessage(500).contains("HTTP 500"))
        assertTrue(DavBrowse.isRefusal(403))
        assertFalse(DavBrowse.isRefusal(404))
    }

    @Test fun basicAuthUsesTheDrivebayUser() {
        assertEquals("ZHJpdmViYXk6dG9r", DavBrowse.basicAuth("tok"))
    }
}
