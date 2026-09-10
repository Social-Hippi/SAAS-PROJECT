import "./load-env";
import { createClerkClient } from "@clerk/backend";

// Grants (or revokes) the platform super_admin role for a Clerk user by email,
// by setting publicMetadata.role — the same claim the proxy + admin panel read.
//
// Usage:
//   npm run set:super-admin -- you@example.com           # grant super_admin
//   npm run set:super-admin -- you@example.com agency_admin   # set another role
//
// After running, SIGN OUT and back in so the new role lands in the session token.

const VALID = ["super_admin", "agency_admin", "hotel_client"] as const;
type RoleArg = (typeof VALID)[number];

async function main() {
  const email = process.argv[2];
  const role = (process.argv[3] ?? "super_admin") as RoleArg;

  if (!email) {
    console.error("Usage: npm run set:super-admin -- <email> [role]");
    process.exit(1);
  }
  if (!VALID.includes(role)) {
    console.error(`Role must be one of: ${VALID.join(", ")}`);
    process.exit(1);
  }
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    console.error("CLERK_SECRET_KEY is not set in your environment.");
    process.exit(1);
  }

  const clerk = createClerkClient({ secretKey });
  const { data } = await clerk.users.getUserList({ emailAddress: [email] });
  const user = data[0];
  if (!user) {
    console.error(`No Clerk user found with email ${email}. Sign up first.`);
    process.exit(1);
  }

  await clerk.users.updateUserMetadata(user.id, { publicMetadata: { role } });
  console.log(
    `✓ Set ${email} (${user.id}) role = ${role}.\n` +
      "  Sign out and back in to refresh your session token, then open /admin.",
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
