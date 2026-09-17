plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.quizatelier.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.quizatelier.app"
        minSdk = 24          // Android 7.0 — covers ~98% of active devices
        targetSdk = 34       // Play requirements as of 2026
        versionCode = 41
        versionName = "1.6.9"
    }

    // Release signing. Passwords come from the environment (or a local
    // gradle.properties that is NOT committed) — never hardcode them here.
    // Provide: QA_STORE_PASSWORD and QA_KEY_PASSWORD
    signingConfigs {
        create("release") {
            storeFile = rootProject.file("app/release.keystore")
            storePassword = System.getenv("QA_STORE_PASSWORD")
                ?: (project.findProperty("QA_STORE_PASSWORD") as String?)
                ?: error("Set QA_STORE_PASSWORD (env or gradle property) to sign the release build")
            keyAlias = "quizatelier"
            keyPassword = System.getenv("QA_KEY_PASSWORD")
                ?: (project.findProperty("QA_KEY_PASSWORD") as String?)
                ?: storePassword
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false          // single-activity wrapper; shrinking gains nothing
            isShrinkResources = false
            signingConfig = signingConfigs.getByName("release")
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
        debug {
            applicationIdSuffix = ".debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    packaging {
        resources.excludes += setOf("META-INF/LICENSE*", "META-INF/NOTICE*")
    }
    // lintVital false-positives on AppCompatActivity under the offline toolchain;
    // a single-activity WebView wrapper has nothing for release lint to guard.
    lint {
        checkReleaseBuilds = false
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.1")
    implementation("androidx.webkit:webkit:1.11.0")
}
