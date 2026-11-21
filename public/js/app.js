const firebaseConfig = {
    apiKey: "AIzaSyCMoNiG0weAu7T_yUx6NXWWvp3HGgTOMBk",
    authDomain: "termux-apps.firebaseapp.com",
    projectId: "termux-apps",
    storageBucket: "termux-apps.firebasestorage.app",
    messagingSenderId: "45955985639",
    appId: "1:45955985639:web:dbbecb102c3e723730b242",
    measurementId: "G-1ZH5F33V43"
};

firebase.initializeApp(firebaseConfig);

const auth = firebase.auth();
const db = firebase.firestore();

const ADMIN_EMAIL = "paswanmantu92@gmail.com";
const APP_ID = "bpsc_teacher_practice";

const CATEGORIES = [
    "announcement",
    "exam",
    "tre",
    "questions",
    "materials",
    "general"
];

auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);

function isAdmin(user) {
    return !!(
        user &&
        user.emailVerified &&
        user.email &&
        user.email.toLowerCase() === ADMIN_EMAIL
    );
}

function showError(message) {
    document.getElementById("loginError").textContent = message;
}

async function adminLogin() {
    const email = document.getElementById("email").value.trim();
    const password = document.getElementById("password").value;

    showError("");

    try {
        if (email.toLowerCase() !== ADMIN_EMAIL) {
            throw new Error("Administrator email not authorized.");
        }

        const result = await auth.signInWithEmailAndPassword(
            email,
            password
        );

        if (!result.user.emailVerified) {
            await auth.signOut();
            throw new Error("Please verify administrator email.");
        }

    } catch (error) {
        showError(error.message);
    }
}

async function adminLogout() {
    await auth.signOut();
}

auth.onAuthStateChanged(async user => {
    const login = document.getElementById("loginPage");
    const dashboard = document.getElementById("dashboard");

    if (isAdmin(user)) {
        login.hidden = true;
        dashboard.hidden = false;

        showSection("overview");
        await loadOverview();

    } else {
        if (user) await auth.signOut();

        login.hidden = false;
        dashboard.hidden = true;
    }
});

function showSection(name) {
    document.querySelectorAll(".section").forEach(section => {
        section.hidden = true;
    });

    document.getElementById(name).hidden = false;

    if (name === "history") loadHistory();
    if (name === "overview") loadOverview();
}

function toggleUserSelection() {
    const selected =
        document.getElementById("target").value === "selected";

    document.getElementById("userSelection").hidden = !selected;
}

async function sendNotification() {
    const button = document.getElementById("sendButton");
    const status = document.getElementById("sendStatus");

    if (!isAdmin(auth.currentUser)) {
        status.textContent = "Administrator login required.";
        return;
    }

    const title = document.getElementById("title").value.trim();
    const body = document.getElementById("body").value.trim();
    const category = document.getElementById("category").value;
    const target = document.getElementById("target").value;

    const userIds = [
        ...new Set(
            document.getElementById("userIds")
                .value.split(/\s+/)
                .map(x => x.trim())
                .filter(Boolean)
        )
    ];

    if (!title || !body) {
        status.textContent = "Enter notification title and message.";
        return;
    }

    if (title.length > 100 || body.length > 2000) {
        status.textContent = "Title or message is too long.";
        return;
    }

    if (!CATEGORIES.includes(category)) {
        status.textContent = "Invalid notification category.";
        return;
    }

    if (!["all", "selected"].includes(target)) {
        status.textContent = "Invalid notification recipient.";
        return;
    }

    if (userIds.some(uid => uid.length > 128)) {
        status.textContent = "One or more Firebase UIDs are invalid.";
        return;
    }

    if (target === "selected" && !userIds.length) {
        status.textContent = "Enter at least one Firebase UID.";
        return;
    }

    if (target === "selected" && userIds.length > 500) {
        status.textContent = "Maximum 500 users per request.";
        return;
    }

    if (!confirm(
        target === "all"
            ? "Send notification to ALL registered app devices?"
            : "Send notification to " + userIds.length + " selected users?"
    )) {
        return;
    }

    button.disabled = true;
    button.textContent = "Adding to Queue...";
    status.textContent = "Connecting to Firebase...";

    try {
        const queueRef = db.collection("notificationQueue").doc();

        await queueRef.set({
            title,
            body,
            category,
            target,
            userIds: target === "selected" ? userIds : [],
            status: "pending",
            createdBy: auth.currentUser.uid,
            adminEmail: ADMIN_EMAIL,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        status.textContent =
            "Notification queued successfully! ID: " + queueRef.id +
            ". GitHub Actions will process it automatically.";

        document.getElementById("title").value = "";
        document.getElementById("body").value = "";
        document.getElementById("userIds").value = "";

        await loadOverview();

    } catch (error) {
        status.textContent = "Error: " + error.message;
        console.error(error);

    } finally {
        button.disabled = false;
        button.textContent = "Send Notification";
    }
}

async function loadHistory() {
    const container = document.getElementById("historyList");

    container.textContent = "Loading notification history...";

    try {
        const snapshot = await db
            .collection("adminNotificationHistory")
            .orderBy("createdAt", "desc")
            .limit(100)
            .get();

        container.innerHTML = "";

        if (snapshot.empty) {
            container.textContent = "No notifications sent yet.";
            return;
        }

        const statusLabels = {
            sent: "SENT",
            failed: "FAILED",
            no_devices: "NO DEVICES",
            completed_with_failures: "COMPLETED WITH FAILURES"
        };

        const deliveryLabels = {
            results_known: "RESULTS KNOWN",
            unknown: "DELIVERY UNKNOWN",
            partial_or_unknown: "PARTIAL / UNKNOWN",
            not_sent: "NOT SENT"
        };

        snapshot.forEach(doc => {
            const item = doc.data();

            const card = document.createElement("div");
            card.className = "history-item";

            const heading = document.createElement("h3");
            heading.textContent = item.title || "Notification";

            const message = document.createElement("p");
            message.textContent = item.body || "";

            const status = document.createElement("div");
            const statusKey = item.status || "unknown";

            status.className =
                "history-status status-" +
                statusKey.replace(/[^a-z0-9_-]/gi, "");

            status.textContent =
                statusLabels[statusKey] || statusKey.toUpperCase();

            const details = document.createElement("small");

            const date = item.createdAt &&
                typeof item.createdAt.toDate === "function"
                ? item.createdAt.toDate().toLocaleString()
                : "Processing";

            details.textContent =
                "Category: " + (item.category || "Unknown") +
                " | Target: " + (item.target || "Unknown") +
                " | Total devices: " + (item.totalDevices ?? 0) +
                " | Attempted: " + (item.attemptedDevices ?? 0) +
                " | Success: " + (item.successCount ?? 0) +
                " | Failed: " + (item.failureCount ?? 0) +
                " | Unknown: " + (item.unknownCount ?? 0) +
                " | Invalid tokens removed: " +
                (item.invalidTokensRemoved ?? 0) +
                " | Date: " + date;

            const delivery = document.createElement("p");
            delivery.className = "history-delivery";

            const deliveryKey = item.deliveryStatus || "unknown";

            delivery.textContent =
                "Delivery: " +
                (deliveryLabels[deliveryKey] ||
                 deliveryKey.toUpperCase());

            card.append(
                heading,
                message,
                status,
                delivery,
                details
            );

            if (item.error) {
                const error = document.createElement("p");
                error.className = "history-error";
                error.textContent = "Error: " + item.error;
                card.appendChild(error);
            }

            container.appendChild(card);
        });

    } catch (error) {
        container.textContent =
            "Unable to load history: " + error.message;
    }
}

async function loadOverview() {
    const ids = [
        "userCount",
        "deviceCount",
        "notificationCount"
    ];

    ids.forEach(id => {
        document.getElementById(id).textContent = "Loading...";
    });

    try {
        const [users, devices, notifications] = await Promise.all([

            db.collection("users").get(),

            db.collectionGroup("devices")
                .where("app", "==", APP_ID)
                .get(),

            db.collection("adminNotificationHistory").get()

        ]);

        document.getElementById("userCount").textContent =
            users.size;

        document.getElementById("deviceCount").textContent =
            devices.size;

        document.getElementById("notificationCount").textContent =
            notifications.size;

    } catch (error) {
        ids.forEach(id => {
            document.getElementById(id).textContent = "Unavailable";
        });

        console.error("Dashboard statistics error:", error);
    }
}
