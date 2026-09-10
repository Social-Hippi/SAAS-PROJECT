import "./load-env";
import { encryptToken, decryptToken } from "../lib/encryption";

// Quick sanity check for lib/encryption.ts. Run with: npm run test:encryption
// (requires ENCRYPTION_KEY in .env — see .env.example for how to generate it).

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`\n❌ FAIL: ${message}`);
    process.exit(1);
  }
}

const sample = "EAAGm0xampleMetaAccessToken_1234567890abcdef";
console.log("Plaintext:  ", sample);

const encrypted = encryptToken(sample);
console.log("Encrypted:  ", encrypted);

const decrypted = decryptToken(encrypted);
// decrypted is a SecretToken — logging it prints "[REDACTED]", not the value.
console.log("Decrypted:  ", decrypted, "(reveal):", decrypted.reveal());

assert(decrypted.reveal() === sample, "round-trip did not match the original");
console.log("✅ Round-trip matches the original.");
assert(
  String(decrypted) === "[REDACTED]" && JSON.stringify(decrypted) === '"[REDACTED]"',
  "SecretToken must redact on toString/JSON",
);
console.log("✅ SecretToken redacts on log/serialize.");

// A fresh random IV per call means the same input encrypts differently.
assert(
  encryptToken(sample) !== encrypted,
  "ciphertext should differ each run (random IV)",
);
console.log("✅ Non-deterministic (fresh IV each call).");

// The GCM auth tag must reject any tampering with the ciphertext.
let tamperRejected = false;
try {
  const buf = Buffer.from(encrypted, "base64");
  buf[buf.length - 1] ^= 0x01; // flip one bit
  decryptToken(buf.toString("base64"));
} catch {
  tamperRejected = true;
}
assert(tamperRejected, "tampered ciphertext should have been rejected");
console.log("✅ Tamper detection works (modified ciphertext rejected).");

console.log("\n🎉 ALL CHECKS PASSED — AES-256-GCM encrypt/decrypt is working.");
