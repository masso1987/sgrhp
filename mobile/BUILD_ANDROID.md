# Compiling the HR Employee Portal for Android — step by step

> The repo ships `lib/` + `pubspec.yaml`. The `android/` platform folder is **generated**
> by Flutter (step 3). Do the steps in order; each command is copy-paste ready.
> First goal: a **debug APK running on a phone/emulator**. Release signing is at the end.

---

## 0. Prerequisites (one time)

Install, in this order:

1. **Git** and a terminal.
2. **Flutter SDK** (stable). https://docs.flutter.dev/get-started/install
   - After install, add `flutter/bin` to your PATH.
3. **Android Studio** (gives you the Android SDK, platform-tools, and an emulator).
   - In Android Studio → *More Actions → SDK Manager*: install **Android SDK Platform 34** (or latest) and **Android SDK Command-line Tools**. Also install the **NDK (Side by side)** — a plugin requires it; if you skip it now, the first build will tell you the exact NDK version to tick (see §5d).
4. **Java JDK 17** (Android Studio bundles one; if building from CLI, ensure `java -version` is 17).

Verify everything:
```bash
flutter doctor
```
Fix every ✗ it reports. Then accept the Android licenses:
```bash
flutter doctor --android-licenses      # press y until done
```
You want ✓ on: Flutter, Android toolchain, Android Studio.

---

## 1. Get the code
```bash
git clone https://github.com/masso1987/sgrhp.git
cd sgrhp/mobile
```

## 2. Point the app at your backend (no secrets in code)
The app reads its config from `--dart-define` at run time. Decide your API base URL:
- Local test against your PC's server: `http://10.0.2.2:PORT` (the Android emulator's alias for your PC's `localhost`), e.g. `http://10.0.2.2:8080`.
- Production: `https://sgrhp.ciblerh-emploi.com`.

Keep this handy; you pass it in step 6/7.

## 3. Generate the Android/iOS platform folders
Run inside `mobile/` (the `.` means "into this existing project"; it keeps your `lib/`):
```bash
flutter create --org com.ciblerh --project-name hr_employee_portal --platforms=android,ios .
```
This creates `android/`, `ios/`, etc. Your application id becomes `com.ciblerh.hr_employee_portal`.
Recent Flutter generates the Android Gradle files in **Kotlin DSL** (`build.gradle.kts`) — see §5b for the correct syntax.

## 4. Install packages + generate the Drift database
```bash
flutter pub get
dart run build_runner build --delete-conflicting-outputs
```
The second command generates `lib/core/db/local_db.g.dart` (required by the offline queue).
Re-run it whenever you change the Drift table.

> The app uses `url_launcher` (open Google Maps / phone dialer) and `image_picker` (attach
> documents for insurance dependents and AVI requests) — both are already in `pubspec.yaml`,
> so `flutter pub get` installs them. `url_launcher` also needs the `<queries>` block in §5a.
> Note: the project does **not** use the `camera` package (removed — it broke the build on
> recent toolchains). If you re-add it and hit `CallbackToFutureAdapter not found`, prefer
> removing `camera` again, or add `implementation("androidx.concurrent:concurrent-futures:1.2.0")`
> to the `camera_android_camerax` module.

## 5. Android configuration (permissions, SDK levels, Maps key)

### 5a. Permissions — edit `android/app/src/main/AndroidManifest.xml`
Add these **above** the `<application>` tag:
```xml
<uses-permission android:name="android.permission.INTERNET"/>
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION"/>
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION"/>
<uses-permission android:name="android.permission.CAMERA"/>          <!-- only if you enable selfie -->
<uses-permission android:name="android.permission.USE_BIOMETRIC"/>   <!-- optional biometric unlock -->
```
Also add this `<queries>` block as a **direct child of `<manifest>`** (sibling of `<application>`, next to the permissions). It lets the app open Google Maps and the phone dialer from the insurance réseau screen on Android 11+:
```xml
<queries>
  <intent><action android:name="android.intent.action.VIEW"/><data android:scheme="https"/></intent>
  <intent><action android:name="android.intent.action.DIAL"/><data android:scheme="tel"/></intent>
</queries>
```
Inside `<application>` (only needed once you wire Google Maps) you may add your Maps key meta-data. Use a **real key** — `${MAPS_API_KEY}` is only a placeholder and will make Maps fail silently if pasted as-is:
```xml
<meta-data android:name="com.google.android.geo.API_KEY"
           android:value="PASTE_YOUR_REAL_KEY_HERE"/>
```
(Leave the Maps key out for a first test — GPS check-in and "open in Maps" via the browser both work without it.)

### 5b. SDK levels — edit the module Gradle file
Recent Flutter generates **Kotlin DSL** (`android/app/build.gradle.kts`), not Groovy. In `android { defaultConfig { ... } }` set:
```kotlin
minSdk = 23
targetSdk = flutter.targetSdkVersion   // or 34
```
If your project still has the older Groovy `android/app/build.gradle`, use `minSdkVersion 23` / `targetSdkVersion 34` instead. (geolocator/maps/image_picker need 21+; 23 is a safe floor.) Change only the `minSdk` line.

### 5c. Firebase
The three `firebase_*` deps are in `pubspec.yaml` and build fine even though the app does not call `Firebase.initializeApp` at startup (notifications are wired later in §9). You can leave them as-is. If a first build ever fails specifically on a `firebase_*` task, comment those three lines out, `flutter pub get`, build, then restore them for §9.

### 5d. Known fixes with recent Flutter / Android SDK
These are real gotchas on current toolchains (Flutter 3.3x+, SDK 34/35/36, Gradle 9, JDK 17/21). Apply as needed:

- **`Package ndk not found` / "did not install NDK <version>"** — a plugin needs a specific NDK. Install it once: Android Studio → *SDK Manager → SDK Tools* → tick **Show Package Details** → under **NDK (Side by side)** tick the exact version the error names → Apply. (CLI alternative: `sdkmanager "ndk;<version>"`.)
- **`CardTheme` can't be assigned to `CardThemeData?`** (or `TabBarTheme`/`DialogTheme`) — recent Flutter renamed these theme classes. In the file/line the error names, add `Data` to the class name (e.g. `cardTheme: CardThemeData(...)`). Already fixed in `lib/core/theme/app_theme.dart`.
- **`unable to find directory entry in pubspec.yaml: .../assets/`** — the `assets/` folder doesn't exist. Create it: `mkdir assets` (run inside `mobile/`).
- **`ninja: fatal: ... Le fichier de pagination est insuffisant` / "paging file too small"** — Windows ran out of virtual memory while compiling native code (the `jni` plugin). Increase the page file: *View advanced system settings → Performance Settings → Advanced → Virtual memory → Change* → Custom size, e.g. Initial 8192 / Max 16384 → **reboot**. Close heavy apps before building.
- **`flutter run` says "No supported devices"** — start an Android emulator (Device Manager → ▶) or plug in a phone with USB debugging; **don't** re-run `flutter create .` as the message suggests (it would overwrite your edits).

## 6. Run on a device or emulator (debug)

Start an emulator (Android Studio → Device Manager → ▶) **or** plug in a phone with USB debugging on. Confirm it's seen:
```bash
flutter devices
```
Run, passing your backend URL:
```bash
flutter run --dart-define=API_BASE_URL=https://sgrhp.ciblerh-emploi.com
```
Hot-reload with `r`, hot-restart with `R`, quit with `q`.
> To log in you first need an employee account: in the SGRHP web app open an employee →
> "Compte application" → it gives you a matricule + temporary password. Use those.

## 7. Build a shareable debug APK (no signing needed)
```bash
flutter build apk --debug --dart-define=API_BASE_URL=https://sgrhp.ciblerh-emploi.com
```
Output: `build/app/outputs/flutter-apk/app-debug.apk` — copy to a phone and install (allow "unknown sources").

## 8. Build a RELEASE APK / App Bundle (signed)

### 8a. Create a keystore (one time, keep it safe & backed up)
```bash
keytool -genkey -v -keystore ~/hr-portal-upload.jks -keyalg RSA -keysize 2048 -validity 10000 -alias upload
```
### 8b. Tell Gradle about it — create `android/key.properties` (do NOT commit it):
```
storePassword=YOUR_STORE_PASSWORD
keyPassword=YOUR_KEY_PASSWORD
keyAlias=upload
storeFile=/absolute/path/to/hr-portal-upload.jks
```
### 8c. Wire signing in `android/app/build.gradle`
Above `android {`:
```gradle
def keystoreProperties = new Properties()
def keystorePropertiesFile = rootProject.file('key.properties')
if (keystorePropertiesFile.exists()) { keystoreProperties.load(new FileInputStream(keystorePropertiesFile)) }
```
Inside `android { }`:
```gradle
signingConfigs {
    release {
        keyAlias keystoreProperties['keyAlias']
        keyPassword keystoreProperties['keyPassword']
        storeFile keystoreProperties['storeFile'] ? file(keystoreProperties['storeFile']) : null
        storePassword keystoreProperties['storePassword']
    }
}
buildTypes {
    release { signingConfig signingConfigs.release }
}
```
### 8d. Build
```bash
flutter build apk --release   --dart-define=API_BASE_URL=https://sgrhp.ciblerh-emploi.com   # single APK
flutter build appbundle --release --dart-define=API_BASE_URL=https://sgrhp.ciblerh-emploi.com  # .aab for Play Store
```
Outputs: `build/app/outputs/flutter-apk/app-release.apk` and `build/app/outputs/bundle/release/app-release.aab`.

## 9. (Later) Enable Firebase notifications
1. Uncomment the three `firebase_*` deps; `flutter pub get`.
2. Install FlutterFire CLI: `dart pub global activate flutterfire_cli`.
3. `flutterfire configure` — pick/create a Firebase project; it writes `lib/firebase_options.dart` and `android/app/google-services.json`.
4. In `main.dart`, before `runApp`: `await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);`
5. Rebuild. The app registers its FCM token via `POST /devices/register` (already coded).

---

## Troubleshooting
- **`flutter doctor` shows Android licenses not accepted** → `flutter doctor --android-licenses`.
- **Gradle/AndroidX or minSdk errors** → set `minSdkVersion 23` (§5b); run `flutter clean && flutter pub get`.
- **`local_db.g.dart` not found** → run `dart run build_runner build --delete-conflicting-outputs` (§4).
- **App can't reach the server from the emulator** → use `http://10.0.2.2:PORT`, not `localhost`. For plain `http` (not https) in debug, Android may block cleartext; use an https URL, or add `android:usesCleartextTraffic="true"` to `<application>` for local testing only.
- **Firebase build fails** → for the first run keep the `firebase_*` deps commented (§5c); wire Firebase only in §9.
- **Location permission denied** → the app requests it at first check-in; also enable location on the device.
- **Google Fonts don't load** → they download on first run; ensure the device has internet, or bundle the font later.
