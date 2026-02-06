import assert from "node:assert/strict";
import test from "node:test";
import { listStoreProfiles, resolveStoreProfile } from "../src/storeProfiles.js";

test("resolveStoreProfile returns default when missing", () => {
  const profile = resolveStoreProfile();
  assert.equal(profile.id, "bigbox_pickup");
});

test("resolveStoreProfile matches id/name/label variants", () => {
  const byLabel = resolveStoreProfile("BigBox Pickup");
  assert.equal(byLabel.id, "bigbox_pickup");

  const byName = resolveStoreProfile("LocalGrocer");
  assert.equal(byName.id, "local_grocer");

  const byId = resolveStoreProfile("local_grocer");
  assert.equal(byId.id, "local_grocer");
});

test("listStoreProfiles returns both profiles", () => {
  const profiles = listStoreProfiles();
  const ids = profiles.map((profile) => profile.id);
  assert.ok(ids.includes("bigbox_pickup"));
  assert.ok(ids.includes("local_grocer"));
});
