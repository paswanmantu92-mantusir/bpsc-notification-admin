import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";

const rawCredentials = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

if (!rawCredentials) {
  throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON secret is missing.");
}

const credentials = JSON.parse(rawCredentials);

if (credentials.project_id !== "termux-apps") {
  throw new Error("Invalid Firebase service account project.");
}

if (!getApps().length) {
  initializeApp({ credential: cert(credentials) });
}

const db = getFirestore();
const messaging = getMessaging();

const APP_ID = "bpsc_teacher_practice";
const ADMIN_EMAIL = "paswanmantu92@gmail.com";

const CATEGORIES = [
  "announcement",
  "exam",
  "tre",
  "questions",
  "materials",
  "general"
];

function validateNotification(data) {
  if (!data || typeof data !== "object") {
    throw new Error("Invalid notification document.");
  }

  if (
    typeof data.title !== "string" ||
    data.title.trim().length === 0 ||
    data.title.length > 100
  ) {
    throw new Error("Invalid notification title.");
  }

  if (
    typeof data.body !== "string" ||
    data.body.trim().length === 0 ||
    data.body.length > 2000
  ) {
    throw new Error("Invalid notification body.");
  }

  if (!CATEGORIES.includes(data.category)) {
    throw new Error("Invalid notification category.");
  }

  if (!["all", "selected"].includes(data.target)) {
    throw new Error("Invalid notification target.");
  }

  if (
    typeof data.createdBy !== "string" ||
    !data.createdBy.trim()
  ) {
    throw new Error("Invalid notification creator.");
  }

  if (data.adminEmail !== ADMIN_EMAIL) {
    throw new Error("Invalid notification administrator.");
  }

  if (!Array.isArray(data.userIds) || data.userIds.length > 500) {
    throw new Error("Invalid user ID list.");
  }

  if (
    data.userIds.some(uid =>
      typeof uid !== "string" ||
      !uid.trim() ||
      uid.length > 128 ||
      uid.includes("/")
    )
  ) {
    throw new Error("Invalid Firebase UID in recipient list.");
  }

  if (data.target === "all" && data.userIds.length !== 0) {
    throw new Error("All-users notification must have an empty user list.");
  }

  if (data.target === "selected" && data.userIds.length === 0) {
    throw new Error("Selected-users notification has no recipients.");
  }
}

async function processNotification(doc) {
  const ref = doc.ref;
  const data = doc.data();

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

  let totalDevices = 0;
  let attemptedDevices = 0;
  let success = 0;
  let failure = 0;
  let invalidTokensRemoved = 0;

  const historyRef = db
    .collection("adminNotificationHistory")
    .doc(doc.id);

  try {
    validateNotification(data);

    let devices = [];

    if (data.target === "all") {
      const snapshot = await db
        .collectionGroup("devices")
        .where("app", "==", APP_ID)
        .get();

      devices = snapshot.docs;
    } else {
      const ids = [...new Set(data.userIds)];

      const results = await Promise.all(
        ids.map(uid =>
          db.collection("users")
            .doc(uid)
            .collection("devices")
            .where("app", "==", APP_ID)
            .get()
        )
      );

      devices = results.flatMap(snapshot => snapshot.docs);
    }

    const unique = new Map();

    for (const device of devices) {
      const token = device.get("token");

      if (typeof token === "string" && token.trim()) {
        unique.set(token, {
          ref: device.ref,
          token
        });
      }
    }

    const list = [...unique.values()];
    totalDevices = list.length;

    const invalid = [];

    for (let i = 0; i < list.length; i += 500) {
      const batch = list.slice(i, i + 500);

      // If the request throws, delivery of this batch is uncertain.
      attemptedDevices += batch.length;

      const result = await messaging.sendEachForMulticast({
        tokens: batch.map(item => item.token),

        notification: {
          title: data.title,
          body: data.body
        },

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
      const deleteBatch = db.batch();

      invalid.slice(i, i + 450).forEach(deviceRef => {
        deleteBatch.delete(deviceRef);
      });

      await deleteBatch.commit();
      invalidTokensRemoved += Math.min(450, invalid.length - i);
    }

    const historyStatus =
      totalDevices === 0
        ? "no_devices"
        : failure > 0
          ? "completed_with_failures"
          : "sent";

    const batch = db.batch();

    batch.set(historyRef, {
      title: data.title,
      body: data.body,
      category: data.category,
      target: data.target,
      status: historyStatus,
      deliveryStatus: "results_known",
      totalDevices,
      attemptedDevices,
      successCount: success,
      failureCount: failure,
      unknownCount: 0,
      invalidTokensRemoved,
      sentBy: data.createdBy,
      createdAt: FieldValue.serverTimestamp()
    });

    batch.update(ref, {
      status: "completed",
      successCount: success,
      failureCount: failure,
      totalDevices,
      completedAt: FieldValue.serverTimestamp()
    });

    await batch.commit();

    console.log(
      `Completed ${doc.id}: ${success} successful, ${failure} failed, ${totalDevices} devices`
    );

  } catch (error) {
    const errorMessage = String(error?.message || error).slice(0, 500);

    const unknownCount = Math.max(
      0,
      attemptedDevices - success - failure
    );

    const deliveryStatus =
      unknownCount > 0
        ? success > 0
          ? "partial_or_unknown"
          : "unknown"
        : attemptedDevices > 0
          ? "results_known"
          : "not_sent";

    console.error("Notification failed:", doc.id, errorMessage);

    const historyData = {
      title: typeof data.title === "string" ? data.title : "",
      body: typeof data.body === "string" ? data.body : "",
      category: typeof data.category === "string" ? data.category : "unknown",
      target: typeof data.target === "string" ? data.target : "unknown",
      status: "failed",
      deliveryStatus,
      totalDevices,
      attemptedDevices,
      successCount: success,
      failureCount: failure,
      unknownCount,
      invalidTokensRemoved,
      error: errorMessage,
      sentBy: typeof data.createdBy === "string" ? data.createdBy : "",
      createdAt: FieldValue.serverTimestamp()
    };

    // Try to record both queue failure and history atomically.
    try {
      const batch = db.batch();

      batch.update(ref, {
        status: "failed",
        error: errorMessage,
        successCount: success,
        failureCount: failure,
        totalDevices,
        attemptedDevices,
        unknownCount,
        completedAt: FieldValue.serverTimestamp()
      });

      batch.set(historyRef, historyData);

      await batch.commit();

    } catch (recordError) {
      console.error(
        "Atomic failure-history recording failed:",
        recordError.message || recordError
      );

      // Preserve at least the queue failure state if possible.
      try {
        await ref.update({
          status: "failed",
          error: errorMessage,
          successCount: success,
          failureCount: failure,
          totalDevices,
          attemptedDevices,
          unknownCount,
          completedAt: FieldValue.serverTimestamp()
        });
      } catch (queueError) {
        console.error(
          "Unable to update failed queue item:",
          queueError.message || queueError
        );
      }

      try {
        await historyRef.set(historyData);
      } catch (historyError) {
        console.error(
          "Unable to write failure history:",
          historyError.message || historyError
        );
      }
    }

    // Never automatically retry a failed notification.
    throw error;
  }
}


async function recoverStaleProcessing() {
  const cutoff = Date.now() - 30 * 60 * 1000;

  const processing = await db
    .collection("notificationQueue")
    .where("status", "==", "processing")
    .limit(50)
    .get();

  for (const doc of processing.docs) {
    const startedAt = doc.get("startedAt");

    if (
      !startedAt ||
      typeof startedAt.toMillis !== "function" ||
      startedAt.toMillis() > cutoff
    ) {
      continue;
    }

    const reason =
      "Worker lease expired. Delivery may be uncertain; verify before manually retrying.";

    const recovered = await db.runTransaction(async tx => {
      const current = await tx.get(doc.ref);

      if (
        !current.exists ||
        current.get("status") !== "processing"
      ) {
        return false;
      }

      const currentStartedAt = current.get("startedAt");

      if (
        !currentStartedAt ||
        currentStartedAt.toMillis() > cutoff
      ) {
        return false;
      }

      tx.update(doc.ref, {
        status: "failed",
        error: reason,
        completedAt: FieldValue.serverTimestamp()
      });

      return true;
    });

    if (!recovered) continue;

    await db
      .collection("adminNotificationHistory")
      .doc(doc.id)
      .set({
        status: "failed",
        title: doc.get("title") || "",
        body: doc.get("body") || "",
        category: doc.get("category") || "general",
        target: doc.get("target") || "all",
        deliveryStatus: "unknown",
        error: reason,
        sentBy: doc.get("createdBy") || null,
        createdAt: FieldValue.serverTimestamp()
      }, { merge: true });

    console.error(
      `Marked stale notification ${doc.id} as failed; manual review required.`
    );
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

  let failedCount = 0;

  for (const doc of pending.docs) {
    try {
      await processNotification(doc);
    } catch (error) {
      failedCount++;

      console.error(
        "Queue item failed:",
        doc.id,
        error.message || error
      );
    }
  }

  console.log("Worker finished. Failed notifications:", failedCount);

  if (failedCount > 0) {
    throw new Error(
      `${failedCount} notification(s) failed. Check queue and history.`
    );
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
