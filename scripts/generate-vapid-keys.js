/**
 * Prints a fresh VAPID keypair for the .env file.
 * Usage: npm run keys
 */
import webpush from "web-push";

const { publicKey, privateKey } = webpush.generateVAPIDKeys();

console.log("\nAdd these to your .env:\n");
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}\n`);
console.log("Keep the private key secret. Changing it invalidates every");
console.log("existing push subscription — devices will need to re-subscribe.\n");
