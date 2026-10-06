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
        versionCode = 11
        versionName = "0.11.0-r11-late-ping-pair"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    jvmToolchain(17)
}
