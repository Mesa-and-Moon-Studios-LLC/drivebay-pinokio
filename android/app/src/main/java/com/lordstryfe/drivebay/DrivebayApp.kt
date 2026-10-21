package com.lordstryfe.drivebay

import android.app.Application

class DrivebayApp : Application() {
    override fun onCreate() {
        super.onCreate()
        CrashLog.install(this)
        DownloadNotifier(this).ensureChannels()
        DrivebayDownloadService.resumeIncomplete(this)
        // Do not start phone sharing here. A background process start has
        // mAllowStartForeground false, and launching the foreground service crashes.
        // MainActivity.onResume and PhoneShareBoot resume it from an allowed context.
    }
}
