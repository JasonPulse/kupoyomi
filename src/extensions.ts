import { db } from "./db.js";
import { gql } from "./suwayomi.js";

/**
 * Installing and uninstalling extensions, and recording whether we want them.
 *
 * Four places wrote the same mutation: suwayomi.ts installed, probe.ts uninstalled,
 * paid.ts uninstalled inline, and the extensions page did both. Two of them also wrote
 * their own version of the desired-flag upsert. Suwayomi runs on emptyDir, so the desired
 * flag is what brings an extension back after a cold start, and a path that changes the
 * install without recording it leaves the reconciler fighting the last thing you did.
 */
export async function setInstalled(pkg: string, install: boolean): Promise<void> {
  await gql(
    `mutation($pkg:String!){ updateExtension(input:{id:$pkg,patch:{${
      install ? "install" : "uninstall"}:true}}){ clientMutationId } }`,
    { pkg },
  );
}

/** Whether the boot reconciler should put this extension back. */
export async function setDesired(pkg: string, desired: boolean): Promise<void> {
  if (desired) {
    await db().query(
      `INSERT INTO extension (pkg_name, desired) VALUES ($1,true)
       ON CONFLICT (pkg_name) DO UPDATE SET desired = true`, [pkg]);
  } else {
    await db().query("UPDATE extension SET desired = false WHERE pkg_name = $1", [pkg]);
  }
}

/** Both at once, which is what every caller actually wanted. */
export async function setExtension(pkg: string, install: boolean): Promise<void> {
  await setInstalled(pkg, install);
  await setDesired(pkg, install);
}
