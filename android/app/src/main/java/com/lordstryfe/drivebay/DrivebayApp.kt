package com.lordstryfe.drivebay

import android.app.Application

class DrivebayApp : Application() {
    override fun onCreate() {
        super.onCreate()
        CrashLog.install(this)
        DownloadNotifier(this).ensureChannels()
        DrivebayDownloadService.resumeIncomplete(this)
        PhoneShareService.resumeIfEnabled(this)
    }
}
