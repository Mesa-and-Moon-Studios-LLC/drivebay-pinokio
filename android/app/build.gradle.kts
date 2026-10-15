import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Release signing: shared Mesa and Moon upload key (same props file as X:\projects\CipherVault).
val keystoreProperties: Properties? = run {
    val src = listOf(
        File(System.getProperty("user.home"), "Android/ciphervault-keystore.properties"),
        rootProject.file("keystore.properties"),
    ).firstOrNull { it.isFile } ?: return@run null
    Properties().apply { src.inputStream().buffered().use { load(it) } }
}
fun Properties.nonBlank(key: String): String? = getProperty(key)?.trim()?.takeIf { it.isNotEmpty() }
val releaseStoreFile: File? = keystoreProperties?.nonBlank("storeFile")?.let { path ->
    val f = File(path)
    listOf(f, File("X:/projects/CipherVault", path), File(System.getProperty("user.home"), "Android/ciphervault-upload.jks"))
        .firstOrNull { it.isAbsolute && it.isFile } ?: f
}
val canSignRelease = releaseStoreFile?.isFile == true &&
    keystoreProperties?.nonBlank("storePassword") != null &&
    keystoreProperties?.nonBlank("keyAlias") != null &&
    keystoreProperties?.nonBlank("keyPassword") != null
android {
    namespace = "com.lordstryfe.drivebay"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.mesaandmoon.drivebay"
        minSdk = 26
        targetSdk = 36
        versionCode = 33300
        versionName = "3.33.0"
    }

    signingConfigs {
        if (canSignRelease) {
            create("release") {
                storeFile = releaseStoreFile
                storePassword = keystoreProperties!!.nonBlank("storePassword")
                keyAlias = keystoreProperties.nonBlank("keyAlias")
                keyPassword = keystoreProperties.nonBlank("keyPassword")
            }
        }
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (canSignRelease) signingConfig = signingConfigs.getByName("release")
        }
        debug { isMinifyEnabled = false }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("androidx.activity:activity-ktx:1.9.2")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.6")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    testImplementation("junit:junit:4.13.2")
}
