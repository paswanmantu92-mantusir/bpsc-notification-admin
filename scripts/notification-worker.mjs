import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";

const credentials = JSON.parse(
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON
);

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
      const batch = db.batch();

      invalid.slice(i, i + 450).forEach(ref => batch.delete(ref));

      await batch.commit();
    }

    const historyRef = db
      .collection("adminNotificationHistory")
      .doc(doc.id);

    const batch = db.batch();

    batch.set(historyRef, {
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

    await ref.update({
      status: "failed",
      error: String(error.message).slice(0, 500),
      completedAt: FieldValue.serverTimestamp()
    });
  }
}

async function main() {
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
