package com.lordstryfe.drivebay

/**
 * The WebDAV calls the browser makes against one linked machine with its saved grant token.
 * PROPFIND, MKCOL, MOVE and DELETE go over DavClient's socket. None of these methods throws.
 * Every call blocks, so call them off the main thread.
 */
class DavSession(val baseUrl: String, token: String) {
    private val auth = DavBrowse.basicAuth(token)
    private val base = DavBrowse.basePath(baseUrl)

    sealed class Listing {
        data class Ok(val entries: List<DavBrowse.Entry>) : Listing()
        data class Fail(val status: Int?, val message: String) : Listing()
    }

    data class Op(val ok: Boolean, val status: Int?, val message: String)

    fun auth(): String = auth

    fun url(path: String): String = DavBrowse.urlFor(baseUrl, path)

    fun list(path: String): Listing {
        val folder = DavBrowse.folderPath(path)
        val reply = DavClient.propfind(url(folder), auth, depth = "1", timeoutMs = 12000)
            ?: return Listing.Fail(null, DavBrowse.errorMessage(null))
        if (reply.status != 207) return Listing.Fail(reply.status, DavBrowse.errorMessage(reply.status, reply.body, "open that folder"))
        val entries = DavBrowse.parseMultistatus(reply.body, folder, base)
            ?: return Listing.Fail(reply.status, "The machine sent a folder list this app could not read.")
        return Listing.Ok(DavBrowse.sort(entries))
    }

    fun makeFolder(path: String): Op =
        run("MKCOL", url(DavBrowse.folderPath(path)), emptyMap(), "create the folder")

    fun move(from: String, to: String, isDir: Boolean): Op {
        val source = if (isDir) DavBrowse.folderPath(from) else DavBrowse.normalize(from).trimEnd('/')
        val target = if (isDir) DavBrowse.folderPath(to) else DavBrowse.normalize(to).trimEnd('/')
        return run("MOVE", url(source), mapOf("Destination" to url(target), "Overwrite" to "F"), "rename it")
    }

    fun delete(path: String, isDir: Boolean): Op {
        val target = if (isDir) DavBrowse.folderPath(path) else DavBrowse.normalize(path).trimEnd('/')
        return run("DELETE", url(target), emptyMap(), "delete it")
    }

    private fun run(method: String, url: String, headers: Map<String, String>, action: String): Op {
        val reply = DavClient.request(method, url, auth, headers, timeoutMs = 12000)
            ?: return Op(false, null, DavBrowse.errorMessage(null))
        val ok = reply.status in 200..299
        return Op(ok, reply.status, if (ok) "" else DavBrowse.errorMessage(reply.status, reply.body, action))
    }
}
