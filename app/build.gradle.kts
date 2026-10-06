plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.example.ninebote3"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.example.ninebote3"
        minSdk = 26
        targetSdk = 35
        versionCode = 12
        versionName = "0.12.0-r12-reference-handshake"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    jvmToolchain(17)
}
