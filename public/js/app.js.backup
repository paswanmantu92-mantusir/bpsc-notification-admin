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

const functions = firebase.app().functions("asia-south1");

const sendFunction = functions.httpsCallable("sendAdminNotification");
const historyFunction = functions.httpsCallable("getAdminNotificationHistory");

const ADMIN_EMAIL = "paswanmantu92@gmail.com";

auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);

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

        const result = await auth.signInWithEmailAndPassword(email, password);

        if (!result.user.emailVerified) {
            await auth.signOut();
            throw new Error("Please verify your administrator email.");
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

    if (user && user.emailVerified &&
        user.email.toLowerCase() === ADMIN_EMAIL) {

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

    const title = document.getElementById("title").value.trim();
    const body = document.getElementById("body").value.trim();
    const category = document.getElementById("category").value;
    const target = document.getElementById("target").value;

    const userIds = document.getElementById("userIds")
        .value.split(/\s+/)
        .map(x => x.trim())
        .filter(Boolean);

    if (!title || !body) {
        status.textContent = "Enter notification title and message.";
        return;
    }

    if (target === "selected" && userIds.length === 0) {
        status.textContent = "Enter at least one Firebase UID.";
        return;
    }

    if (target === "selected" && userIds.length > 500) {
        status.textContent = "Maximum 500 users per request.";
        return;
    }

    if (!confirm(
        target === "all"
        ? "Send this notification to ALL registered app devices?"
        : "Send this notification to " + userIds.length + " selected users?"
    )) return;

    button.disabled = true;
    button.textContent = "Sending...";

    status.textContent = "Connecting to Firebase...";

    try {
        const result = await sendFunction({
            title,
            body,
            category,
            target,
            userIds
        });

        const data = result.data;

        status.textContent =
            "Notification completed! Success: " +
            data.successCount +
            " | Failed: " +
            data.failureCount +
            " | Total devices: " +
            data.totalDevices;

        document.getElementById("title").value = "";
        document.getElementById("body").value = "";

        document.getElementById("userIds").value = "";

        await loadOverview();

    } catch (error) {
        status.textContent = "Error: " + error.message;
    }

    button.disabled = false;
    button.textContent = "Send Notification";
}

async function loadHistory() {
    const container = document.getElementById("historyList");

    container.textContent = "Loading notification history...";

    try {
        const result = await historyFunction();

        const notifications = result.data.notifications || [];

        container.innerHTML = "";

        if (!notifications.length) {
            container.textContent = "No notifications sent yet.";
            return;
        }

        notifications.forEach(item => {
            const card = document.createElement("div");
            card.className = "history-item";

            const heading = document.createElement("h3");
            heading.textContent = item.title;

            const message = document.createElement("p");
            message.textContent = item.body;

            const details = document.createElement("small");

            details.textContent =
                "Category: " + item.category +
                " | Target: " + item.target +
                " | Devices: " + item.totalDevices +
                " | Success: " + item.successCount +
                " | Failed: " + item.failureCount +
                " | Date: " + (item.createdAt || "Unknown");

            card.append(heading, message, details);

            container.appendChild(card);
        });

    } catch (error) {
        container.textContent = "Unable to load history: " + error.message;
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
        const statsFunction =
            functions.httpsCallable("getAdminDashboardStats");

        const result = await statsFunction();

        document.getElementById("userCount").textContent =
            result.data.users;

        document.getElementById("deviceCount").textContent =
            result.data.devices;

        document.getElementById("notificationCount").textContent =
            result.data.notifications;

    } catch (error) {
        ids.forEach(id => {
            document.getElementById(id).textContent = "Unavailable";
        });

        console.error(error);
    }
}
