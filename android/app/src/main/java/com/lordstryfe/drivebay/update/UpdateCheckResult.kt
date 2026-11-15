package com.lordstryfe.drivebay.update

/** Result of a settings "Check for updates" run. The banner is the update itself. */
enum class UpdateCheckResult {
    UPDATE_AVAILABLE,
    UP_TO_DATE,
    FAILED,
}
