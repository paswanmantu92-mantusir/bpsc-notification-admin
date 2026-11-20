import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";

if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON GitHub Actions secret.");
}

let credentials;
try {
  credentials = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
} catch {
  throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON.");
}

if (!credentials.project_id || credentials.project_id !== "termux-apps") {
  throw new Error("Invalid Firebase service account.");
}

if (!getApps().length) {
  initializeApp({ credential: cert(credentials) });
}

const db = getFirestore();
const messaging = getMessaging();

const APP_ID = "bpsc_teacher_practice";

async function processNotification(doc) {
  const ref = doc.ref;
  const data = doc.data();

  if (typeof data.title !== "string" || !data.title.trim() || data.title.length > 100 ||
      typeof data.body !== "string" || !data.body.trim() || data.body.length > 2000 ||
      !["announcement", "exam", "tre", "questions", "materials", "general"].includes(data.category) ||
      !["all", "selected"].includes(data.target)) {
    const reason = "Invalid notification queue payload.";
    const batch = db.batch();
    batch.update(ref, {
      status: "failed",
      error: reason,
      completedAt: FieldValue.serverTimestamp()
    });
    batch.set(db.collection("adminNotificationHistory").doc(doc.id), {
      title: typeof data.title === "string" ? data.title : "",
      body: typeof data.body === "string" ? data.body : "",
      category: data.category || "general",
      target: data.target || "all",
      status: "failed",
      error: reason,
      sentBy: data.createdBy || null,
      createdAt: FieldValue.serverTimestamp()
    });
    await batch.commit();
    return;
  }

  // Claim the job to prevent duplicate processing.
  const claimed = await db.runTransaction(async tx => {
    const current = await tx.get(ref);

    if (!current.exists || current.data().status !== "pending") {
      return false;
    }

    tx.update(ref, {
      status: "processing",
      startedAt: FieldValue.serverTimestamp()
    });

    return true;
  });

  if (!claimed) return;

  let devices = [];

  try {
    if (data.target === "all") {
      const snapshot = await db
        .collectionGroup("devices")
        .where("app", "==", APP_ID)
        .get();

      devices = snapshot.docs;
    } else {
      const ids = [...new Set(data.userIds || [])];

      if (!ids.length || ids.length > 500) {
        throw new Error("Invalid selected user list.");
      }

      const results = await Promise.all(
        ids.map(uid =>
          db.collection("users")
            .doc(uid)
            .collection("devices")
            .where("app", "==", APP_ID)
            .get()
        )
      );

      devices = results.flatMap(s => s.docs);
    }

    const unique = new Map();

    for (const device of devices) {
      const token = device.get("token");

      if (typeof token === "string" && token.length > 0) {
        unique.set(token, { ref: device.ref, token });
      }
    }

    const list = [...unique.values()];
    let success = 0;
    let failure = 0;
    const invalid = [];

    for (let i = 0; i < list.length; i += 500) {
      const batch = list.slice(i, i + 500);

      const result = await messaging.sendEachForMulticast({
        tokens: batch.map(x => x.token),

        // Data-only delivery ensures BpscFirebaseMessagingService handles both
        // foreground and background messages and selects the intended channel.
        data: {
          title: data.title,
          body: data.body,
          category: data.category,
          notificationId: doc.id
        },

        android: {
          priority: "high"
        }
      });

      success += result.successCount;
      failure += result.failureCount;

      result.responses.forEach((response, index) => {
        if (!response.success) {
          const code = response.error?.code || "";

          if (
            code.includes("registration-token-not-registered") ||
            code.includes("invalid-registration-token")
          ) {
            invalid.push(batch[index].ref);
          }
        }
      });
    }

    for (let i = 0; i < invalid.length; i += 450) {
      const batch = db.batch();

      invalid.slice(i, i + 450).forEach(ref => batch.delete(ref));

      await batch.commit();
    }

    const historyRef = db
      .collection("adminNotificationHistory")
      .doc(doc.id);

    const batch = db.batch();

    batch.set(historyRef, {
      status: "completed",
      title: data.title,
      body: data.body,
      category: data.category,
      target: data.target,
      totalDevices: list.length,
      successCount: success,
      failureCount: failure,
      invalidTokensRemoved: invalid.length,
      sentBy: data.createdBy,
      createdAt: FieldValue.serverTimestamp()
    });

    batch.update(ref, {
      status: "completed",
      successCount: success,
      failureCount: failure,
      totalDevices: list.length,
      completedAt: FieldValue.serverTimestamp()
    });

    await batch.commit();

    console.log(`Completed ${doc.id}: ${success} successful, ${failure} failed`);

  } catch (error) {
    console.error("Notification failed:", doc.id, error);

    const reason = String(error?.message || error).slice(0, 500);
    const failureBatch = db.batch();
    failureBatch.update(ref, {
      status: "failed",
      error: reason,
      completedAt: FieldValue.serverTimestamp()
    });
    failureBatch.set(db.collection("adminNotificationHistory").doc(doc.id), {
      status: "failed",
      title: typeof data.title === "string" ? data.title : "",
      body: typeof data.body === "string" ? data.body : "",
      category: data.category || "general",
      target: data.target || "all",
      error: reason,
      sentBy: data.createdBy || null,
      createdAt: FieldValue.serverTimestamp()
    });
    await failureBatch.commit();
  }
}

async function recoverStaleProcessing() {
  // A runner may be cancelled or time out after claiming a job. Never silently
  // leave it stuck forever. We mark old leases failed rather than auto-resend,
  // because FCM may already have accepted the message before the runner stopped.
  const cutoff = Date.now() - 30 * 60 * 1000;
  const processing = await db
    .collection("notificationQueue")
    .where("status", "==", "processing")
    .limit(50)
    .get();

  for (const doc of processing.docs) {
    const startedAt = doc.get("startedAt");
    if (!startedAt || typeof startedAt.toMillis !== "function" || startedAt.toMillis() > cutoff) {
      continue;
    }

    const reason = "Worker lease expired. Delivery may be uncertain; verify before manually retrying.";
    const recovered = await db.runTransaction(async tx => {
      const current = await tx.get(doc.ref);
      if (!current.exists || current.get("status") !== "processing") return false;
      const currentStartedAt = current.get("startedAt");
      if (!currentStartedAt || currentStartedAt.toMillis() > cutoff) return false;
      tx.update(doc.ref, {
        status: "failed",
        error: reason,
        completedAt: FieldValue.serverTimestamp()
      });
      return true;
    });
    if (!recovered) continue;
    await db.collection("adminNotificationHistory").doc(doc.id).set({
      status: "failed",
      title: doc.get("title") || "",
      body: doc.get("body") || "",
      category: doc.get("category") || "general",
      target: doc.get("target") || "all",
      error: reason,
      sentBy: doc.get("createdBy") || null,
      createdAt: FieldValue.serverTimestamp()
    }, { merge: true });
    console.error(`Marked stale notification ${doc.id} as failed; manual review required.`);
  }
}

async function main() {
  await recoverStaleProcessing();

  const pending = await db
    .collection("notificationQueue")
    .where("status", "==", "pending")
    .limit(10)
    .get();

  console.log("Pending notifications:", pending.size);

  for (const doc of pending.docs) {
    await processNotification(doc);
  }

  console.log("Worker finished.");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
