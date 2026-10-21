package com.lordstryfe.drivebay

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Bring a share the user left on back after a reboot or an app update. */
class PhoneShareBoot : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action ?: return
        val origin = when (action) {
            Intent.ACTION_BOOT_COMPLETED -> PhoneShareLifecycle.ShareStartOrigin.BOOT_COMPLETED
            Intent.ACTION_MY_PACKAGE_REPLACED -> PhoneShareLifecycle.ShareStartOrigin.PACKAGE_REPLACED
            else -> return
        }
        PhoneShareService.resumeIfEnabled(context, origin)
    }
}
