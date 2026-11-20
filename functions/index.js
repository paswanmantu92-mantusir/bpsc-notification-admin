const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();

const db = getFirestore();

const ADMIN_EMAIL = "paswanmantu92@gmail.com";

const CATEGORIES = [
  "announcement",
  "exam",
  "tre",
  "questions",
  "materials",
  "general"
];

setGlobalOptions({
  maxInstances: 5,
  region: "asia-south1"
});

// Verify administrator identity.
function verifyAdmin(request) {
  const user = request.auth;

  if (!user ||
      user.token.email !== ADMIN_EMAIL ||
      user.token.email_verified !== true) {
    throw new HttpsError(
      "permission-denied",
      "Only the verified administrator can send notifications."
    );
  }

  return user.uid;
}

// Send notification.
exports.sendAdminNotification = onCall(
  {
    enforceAppCheck: false
  },
  async (request) => {

    const adminUid = verifyAdmin(request);

    const {
      title,
      body,
      category,
      target = "all",
      userIds = []
    } = request.data || {};

    if (
      typeof title !== "string" ||
      typeof body !== "string" ||
      !title.trim() ||
      !body.trim() ||
      title.length > 100 ||
      body.length > 2000
    ) {
      throw new HttpsError(
        "invalid-argument",
        "Invalid notification title or message."
      );
    }

    if (!CATEGORIES.includes(category)) {
      throw new HttpsError(
        "invalid-argument",
        "Invalid notification category."
      );
    }

    if (
      target !== "all" &&
      target !== "selected"
    ) {
      throw new HttpsError(
        "invalid-argument",
        "Invalid notification target."
      );
    }

    if (
      target === "selected" &&
      (
        !Array.isArray(userIds) ||
        userIds.length === 0 ||
        userIds.length > 500
      )
    ) {
      throw new HttpsError(
        "invalid-argument",
        "Select between 1 and 500 users."
      );
    }

    let deviceSnapshots = [];

    if (target === "all") {
      const snapshot = await db
        .collectionGroup("devices")
        .where("app", "==", "bpsc_teacher_practice")
        .get();

      deviceSnapshots = snapshot.docs;

    } else {

      const uniqueIds = [...new Set(userIds)];

      const results = await Promise.all(
        uniqueIds.map(uid =>
          db.collection("users")
            .doc(uid)
            .collection("devices")
            .where("app", "==", "bpsc_teacher_practice")
            .get()
        )
      );

      deviceSnapshots = results.flatMap(
        snapshot => snapshot.docs
      );
    }

    const devices = deviceSnapshots
      .map(doc => ({
        ref: doc.ref,
        token: doc.get("token")
      }))
      .filter(device =>
        typeof device.token === "string" &&
        device.token.length > 0
      );

    const uniqueDevices = [
      ...new Map(
        devices.map(device => [device.token, device])
      ).values()
    ];

    const historyRef = db
      .collection("adminNotificationHistory")
      .doc();

    let success = 0;
    let failure = 0;
    const invalidTokens = [];

    // FCM accepts at most 500 tokens per multicast request.
    for (let i = 0; i < uniqueDevices.length; i += 500) {

      const batch = uniqueDevices.slice(i, i + 500);

      const response = await getMessaging()
        .sendEachForMulticast({
          tokens: batch.map(device => device.token),

          notification: {
            title: title.trim(),
            body: body.trim()
          },

          data: {
            title: title.trim(),
            body: body.trim(),
            category,
            notificationId: historyRef.id
          },

          android: {
            priority: "high"
          }
        });

      success += response.successCount;
      failure += response.failureCount;

      response.responses.forEach((result, index) => {

        if (!result.success) {

          const code = result.error?.code || "";

          if (
            code.includes("registration-token-not-registered") ||
            code.includes("invalid-registration-token")
          ) {
            invalidTokens.push(batch[index].ref);
          }
        }
      });
    }

    // Remove expired device tokens.
    const cleanup = db.batch();

    invalidTokens.forEach(ref => cleanup.delete(ref));

    if (invalidTokens.length > 0) {
      await cleanup.commit();
    }

    // Save notification history.
    await historyRef.set({
      title: title.trim(),
      body: body.trim(),
      category,
      target,
      selectedUserCount: target === "selected"
        ? [...new Set(userIds)].length
        : null,
      totalDevices: uniqueDevices.length,
      successCount: success,
      failureCount: failure,
      invalidTokensRemoved: invalidTokens.length,
      sentBy: adminUid,
      adminEmail: ADMIN_EMAIL,
      createdAt: FieldValue.serverTimestamp()
    });

    return {
      success: true,
      notificationId: historyRef.id,
      totalDevices: uniqueDevices.length,
      successCount: success,
      failureCount: failure,
      invalidTokensRemoved: invalidTokens.length
    };
  }
);

// Admin-only notification history.
exports.getAdminNotificationHistory = onCall(
  async (request) => {

    verifyAdmin(request);

    const snapshot = await db
      .collection("adminNotificationHistory")
      .orderBy("createdAt", "desc")
      .limit(100)
      .get();

    return {
      notifications: snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data(),
        createdAt: doc.data().createdAt
          ? doc.data().createdAt.toDate().toISOString()
          : null
      }))
    };
  }
);

// Admin dashboard statistics.
exports.getAdminDashboardStats = onCall(
  async (request) => {

    verifyAdmin(request);

    const [users, devices, notifications] =
      await Promise.all([

        db.collection("users").count().get(),

        db.collectionGroup("devices")
          .where("app", "==", "bpsc_teacher_practice")
          .count()
          .get(),

        db.collection("adminNotificationHistory")
          .count()
          .get()

      ]);

    return {
      users: users.data().count,
      devices: devices.data().count,
      notifications: notifications.data().count
    };
  }
);

