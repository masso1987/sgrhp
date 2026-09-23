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
   - In Android Studio → *More Actions → SDK Manager*: install **Android SDK Platform 34** (or latest) and **Android SDK Command-line Tools**.
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

## 4. Install packages + generate the Drift database
```bash
flutter pub get
dart run build_runner build --delete-conflicting-outputs
```
The second command generates `lib/core/db/local_db.g.dart` (required by the offline queue).
Re-run it whenever you change the Drift table.

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
Inside `<application>` (only needed once you wire Google Maps) add your Maps key meta-data:
```xml
<meta-data android:name="com.google.android.geo.API_KEY"
           android:value="${MAPS_API_KEY}"/>
```
(You can hard-code the key here for a first test, or leave the map screen out — the check-in works without a map.)

### 5b. SDK levels — edit `android/app/build.gradle` (module app)
In `android { defaultConfig { ... } }`:
```gradle
minSdkVersion 23
targetSdkVersion 34
```
(Firebase/geolocator/maps need 21+; 23 is a safe modern floor. If Gradle uses `flutter.minSdkVersion`, replace it with `23`.)

### 5c. First build WITHOUT Firebase (fastest path)
The app does **not** initialize Firebase at startup, but the three `firebase_*` packages still pull in Android build steps. For your **first** compile, comment them out in `pubspec.yaml`:
```yaml
  # firebase_core: ^3.2.0
  # firebase_messaging: ^15.0.3
  # firebase_crashlytics: ^4.0.3
```
then `flutter pub get` again. (Add them back with the Firebase steps in §9 when you wire notifications.)

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
