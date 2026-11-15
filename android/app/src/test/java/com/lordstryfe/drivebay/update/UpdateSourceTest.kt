package com.lordstryfe.drivebay.update

import org.junit.Assert.assertEquals
import org.junit.Test

class UpdateSourceTest {
    @Test fun playStoreIsPlay() {
        assertEquals(UpdateSource.PLAY, UpdateSource.detect("com.android.vending"))
        assertEquals(UpdateSource.PLAY, UpdateSource.detect(UpdateSource.PLAY_INSTALLER))
    }

    @Test fun missingInstallerIsSideload() {
        assertEquals(UpdateSource.SIDELOAD, UpdateSource.detect(null))
        assertEquals(UpdateSource.SIDELOAD, UpdateSource.detect(""))
    }

    @Test fun packageInstallerAdbAndOtherStoresAreSideload() {
        assertEquals(UpdateSource.SIDELOAD, UpdateSource.detect("com.google.android.packageinstaller"))
        assertEquals(UpdateSource.SIDELOAD, UpdateSource.detect("com.android.packageinstaller"))
        assertEquals(UpdateSource.SIDELOAD, UpdateSource.detect("com.android.shell"))
        assertEquals(UpdateSource.SIDELOAD, UpdateSource.detect("com.amazon.venezia"))
        assertEquals(UpdateSource.SIDELOAD, UpdateSource.detect("com.android.vending.debug"))
    }
}
