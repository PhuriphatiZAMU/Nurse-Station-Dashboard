
const admin = require("firebase-admin");
const serviceAccount = require("c:\\Users\\iznamu\\Downloads\\preserving-fall-detector-firebase-adminsdk-fbsvc-d8689c6e68.json");

console.log("🔒 Connecting to Firebase Admin SDK (Backend Mode)...");

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://preserving-fall-detector-default-rtdb.firebaseio.com"
});

const db = admin.database();
const ref = db.ref("hospital_system");

console.log("✅ Admin SDK Initialized Successfully!");
console.log("📡 Fetching data from /hospital_system...");

ref.once("value", (snapshot) => {
    const data = snapshot.val();
    if (data) {
        console.log("------------------------------------------");
        console.log("📊 Database Connection Verified!");
        console.log("Found System Nodes:", Object.keys(data).length > 0 ? Object.keys(data) : 'None');
        console.log("------------------------------------------");
    } else {
        console.log("⚠️ /hospital_system is empty. You can start adding devices!");
    }
    process.exit(0);
}, (error) => {
    console.error("❌ Read Error:", error);
    process.exit(1);
});
