# HR Employee Portal — Flutter app (Android + iOS)

Employee self-service + GPS attendance for **MBOKA Mon RH (SGRHP)**. Feature-first
Clean Architecture, Riverpod, GoRouter, Dio, Material 3 (light/dark). Talks only to
the secure `/api/v1` mobile API on the SGRHP backend — never to PostgreSQL directly.

## Run
```bash
flutter pub get
dart run build_runner build   # generates the Drift database (local_db.g.dart)
flutter run \
  --dart-define=API_BASE_URL=https://sgrhp.ciblerh-emploi.com \
  --dart-define=GOOGLE_MAPS_API_KEY=xxxx
```
Employees are provisioned by HR in the SGRHP web app (Employé → « Compte application »),
which returns a login (matricule) + temporary password. First login forces a password change.

## Structure
```
lib/
  core/ theme (design system) · config (env) · network (Dio + refresh) · storage (secure) · router · providers
  features/ auth · dashboard · attendance · leave · payslips · profile
  shared/ widgets (GlassCard, StatusPill, AppShell…)
```

## Implemented (MVP, verified against the live backend)
- Auth: login (matricule/email), JWT **+ rotating refresh** (transparent Dio refresh), forced password change, secure token storage, logout.
- Dashboard: greeting, today's attendance status, big check-in/out, leave balance, latest payslip, shortcuts.
- Attendance: GPS acquisition (attendance-time only), site picker, geofence result (success / rejected / exception), history grouped by day, **offline-first queue + auto-sync** (works with no internet).
- Leave: balance, request (date range + comment), status list.
- Payslips: list + amounts (PDF via authenticated `/me/payslips/:id/pdf`).
- Profile: read-only HR fields + logout.

## To wire before release (documented TODOs, interfaces already in place)
- ~~Offline queue (Drift)~~ **DONE** — punches are written to the Drift queue first, sent immediately when online, and flushed by `SyncService` (connectivity-driven + 45s safety net) via `POST /me/sync`, idempotent by `attendance_uuid`, with exponential backoff. States: PENDING_SYNC → SYNCING → SYNCED / FAILED / REQUIRES_REVIEW. A slim banner shows queued count. (Run `build_runner` once to generate `local_db.g.dart`.)
- **Firebase**: add `firebase_options.dart`, `google-services.json` (Android) / `GoogleService-Info.plist` (iOS), register the FCM token via `POST /devices/register`.
- **Maps**: drop the site + user pin on the check-in sheet with `google_maps_flutter`.
- **Biometric unlock** (`local_auth`) after first login.
- **Android/iOS build config**: location + camera permissions in `AndroidManifest.xml` / `Info.plist`; release signing.

## Security notes
Tokens live only in `flutter_secure_storage`. No secrets in source (use `--dart-define`).
Server sets the authoritative attendance timestamp; the client timestamp is stored only as supporting evidence. Out-of-geofence check-ins are recorded as **exceptions** for HR review, never dropped.
