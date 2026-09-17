/* One-time migration: the demo accounts move from usernames to email
   identities so the new email-based sign-in has matching demo credentials.
   Run with:  node server/scripts/migrate-users.js
   (The server must be restarted afterwards.) */
"use strict";
const fs = require("fs");
const path = require("path");

const DB_FILE = path.join(__dirname, "..", "data", "db.json");
const crypto = require("crypto");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function makeUser(email, password, role, name) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { id: email, role, name, username: email, email, passSalt: salt, passHash: hash };
}

let db;
try { db = JSON.parse(fs.readFileSync(DB_FILE, "utf8")); }
catch { console.error("No db.json found — nothing to migrate."); process.exit(0); }

db.users = (db.users || []).filter(Boolean);
db.consent = db.consent || {};

for (const u of db.users) {
  if (u.username === "teacher") {
    db.users[db.users.indexOf(u)] = makeUser("teacher@quiz.dev", "teacher123", "teacher", "Prof. Meera");
    console.log("teacher → teacher@quiz.dev / teacher123");
  } else if (u.username === "student") {
    db.users[db.users.indexOf(u)] = makeUser("student@quiz.dev", "student123", "student", "Aarav");
    console.log("student → student@quiz.dev / student123");
  } else if (!EMAIL_RE.test(u.email || u.username)) {
    const email = `${u.username}@quiz.dev`;
    u.email = email; u.username = email; u.id = email;
    console.log(`${u.name} → ${email}`);
  }
}

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
fs.writeFileSync(DB_FILE, JSON.stringify(db));
console.log("Migration complete.");
