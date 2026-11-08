const test = require("node:test");
const assert = require("node:assert/strict");

const {
	aptPackagesHash,
	normalizeAptPackages,
	resolveAptImageRef,
} = require("./cargo-apt-packages.js");

test("normalizeAptPackages returns empty list when unset", () => {
	assert.deepEqual(
		normalizeAptPackages({ currentConfig: {}, label: "linters.cargo-clippy" }),
		[],
	);
});

test("normalizeAptPackages accepts Ubuntu official names", () => {
	assert.deepEqual(
		normalizeAptPackages({
			currentConfig: { apt_packages: ["libgtk-4-dev", "libasound2-dev"] },
			label: "linters.cargo-clippy",
		}),
		["libgtk-4-dev", "libasound2-dev"],
	);
});

test("normalizeAptPackages rejects non-array", () => {
	assert.throws(
		() =>
			normalizeAptPackages({
				currentConfig: { apt_packages: "libgtk-4-dev" },
				label: "linters.cargo-clippy",
			}),
		/linters\.cargo-clippy\.apt_packages must be an array/,
	);
});

test("normalizeAptPackages rejects shell metacharacters and version pinning", () => {
	for (const bad of [
		"libgtk-4-dev; rm -rf /",
		"pkg=1.0",
		"PKG",
		"-foo",
		"a b",
		"foo/bar",
		"$(id)",
	]) {
		assert.throws(
			() =>
				normalizeAptPackages({
					currentConfig: { apt_packages: [bad] },
					label: "linters.cargo-clippy",
				}),
			/must match/,
			`expected rejection for ${bad}`,
		);
	}
});

test("normalizeAptPackages rejects duplicates and oversized lists", () => {
	assert.throws(
		() =>
			normalizeAptPackages({
				currentConfig: { apt_packages: ["libgtk-4-dev", "libgtk-4-dev"] },
				label: "linters.cargo-clippy",
			}),
		/duplicates/,
	);
	assert.throws(
		() =>
			normalizeAptPackages({
				currentConfig: { apt_packages: Array.from({ length: 21 }, (_, i) => `pkg${i}`) },
				label: "linters.cargo-clippy",
			}),
		/at most 20/,
	);
});

test("aptPackagesHash is order-independent and resolveAptImageRef appends suffix", () => {
	const a = aptPackagesHash(["b", "a"]);
	const b = aptPackagesHash(["a", "b"]);
	assert.equal(a, b);
	assert.equal(a.length, 12);
	assert.equal(
		resolveAptImageRef("localhost/img:tag", []),
		"localhost/img:tag",
	);
	assert.match(
		resolveAptImageRef("localhost/img:tag", ["libgtk-4-dev"]),
		/^localhost\/img:tag-apt-[0-9a-f]{12}$/,
	);
});
