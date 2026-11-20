# BPSC FCM integration — correction and validation report

## Corrections made

### Android app
- Added the Android 13+ `POST_NOTIFICATIONS` runtime permission request. The manifest permission alone does not grant notification display permission.
- Kept token registration at app launch and pending-token flush after Firebase authentication.
- Kept the app identity `bpsc_teacher_practice` and device document path `users/{uid}/devices/{sha256(token)}`.
- Removed the hard-coded release signing password from `app/build.gradle`. Release signing now reads `BPSC_STORE_PASSWORD` and `BPSC_KEY_PASSWORD` from the build environment; debug builds do not require them.

### Admin and worker
- Changed FCM sends to **high-priority data-only** messages. This makes `BpscFirebaseMessagingService.onMessageReceived()` responsible for rendering notifications in both foreground and background, so the app can consistently choose its category notification channel.
- Added explicit validation for worker credentials and queued notification payloads.
- Added failure records to `adminNotificationHistory`, including a visible status/error in the Admin history screen.
- Added stale-processing recovery. Jobs left in `processing` for more than 30 minutes are marked failed for manual review rather than silently remaining stuck or being automatically resent. This avoids accidental duplicate notifications where FCM may already have accepted the first send.
- Added a root worker `package.json` and made GitHub Actions install dependencies from that manifest.
- Synchronized the Android and Admin Firestore rules. Device-token writes are now explicitly allowed for the signed-in owner; queue creation is restricted to the verified admin and validated fields.

## Compatibility checks — passed
- Android package: `in.mantusir.bpscteacherpractice` exists exactly once in `google-services.json`.
- Firebase project ID: `termux-apps` in Android and Admin configuration.
- Android device app marker and Admin worker query: `bpsc_teacher_practice`.
- Device schema: Android writes `users/{uid}/devices/{documentId}` with `token`, `platform=android`, `app=bpsc_teacher_practice`, and `updatedAt`; Admin queries that same collection group and app marker.
- Admin queue fields and worker fields agree: `title`, `body`, `category`, `target`, `userIds`, `createdBy`, `status`.
- FCM data keys consumed by Android agree with those sent by the worker: `title`, `body`, `category`, `notificationId`.
- Admin and Android Firestore rules are byte-identical.
- JSON/XML parsing passed; Admin JS, worker JS, Functions JS, Android auth JS, and inline scripts in the main/mock-test HTML passed Node syntax checks.

## Not yet verified (requires the user's Firebase/GitHub runtime and a real Android device)
- Gradle build and Java compilation were not run here because this environment does not have the Android Gradle build toolchain/SDK configured.
- Firestore rules were not deployed or emulator-tested.
- The GitHub Actions workflow was not dispatched from the user's repository in this environment.
- No live FCM request was sent and no physical-device receipt was observed. A successful Admin SDK response alone would still not prove that Android displayed the notification; the device test below is required.

## End-to-end delivery test after applying these sources
1. Build and install the corrected Android APK, sign in, and grant notification permission when prompted.
2. Confirm that the signed-in user's `users/{uid}/devices` subcollection contains a document with `app = bpsc_teacher_practice` and a non-empty `token`.
3. In the Admin dashboard, select the **selected users** target and enter that Firebase Auth UID. Send a clearly labelled test message such as `FCM delivery test`.
4. In GitHub Actions, run **BPSC Notification Worker** using `workflow_dispatch` (or wait for the five-minute schedule). The repository secret `FIREBASE_SERVICE_ACCOUNT_JSON` must remain configured and must be a service account for project `termux-apps`.
5. Verify that the matching `notificationQueue/{id}` becomes `completed`, and `adminNotificationHistory/{id}` reports `successCount >= 1` and `failureCount = 0`.
6. Verify that the notification actually appears on the Android device. If it does not, check Android notification permission/channel settings and the device token document before sending another test.

A stale/failed job is not automatically resent because its delivery outcome may be ambiguous. Review it before manually creating a replacement test.
