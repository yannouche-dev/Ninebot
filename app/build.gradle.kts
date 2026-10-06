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
        versionCode = 8
        versionName = "0.8.0-r8-x3-encryption2"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    jvmToolchain(17)
}
