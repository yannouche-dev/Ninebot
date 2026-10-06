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
        versionCode = 13
        versionName = "0.13.0-r13-appkey-transition"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    jvmToolchain(17)
}
