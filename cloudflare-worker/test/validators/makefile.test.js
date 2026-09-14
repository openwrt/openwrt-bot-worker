import { describe, test } from 'node:test';
import assert from 'node:assert';
import { validateMakefileContext, validatePkgReleaseBumps, findPkgRoot, isPackageMakefilePath } from '../../src/validators.js';
import { CONFIG } from './helpers.js';

describe('validateMakefileContext', () => {
  test('accepts version bump matching commit subject', () => {
    const commit = { commit: { message: 'bash: update to 5.3' } };
    const patch = `
--- a/package/utils/bash/Makefile
+++ b/package/utils/bash/Makefile
+PKG_VERSION:=5.3
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
  });

  test('accepts version bump with leading zero difference (subject has zero, Makefile does not)', () => {
    const commit = { commit: { message: 'mypkg: update to 2026.07.04' } };
    const patch = `
--- a/package/utils/mypkg/Makefile
+++ b/package/utils/mypkg/Makefile
+PKG_VERSION:=2026.7.4
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
  });

  test('accepts version bump with leading zero difference (Makefile has zero, subject does not)', () => {
    const commit = { commit: { message: 'mypkg: update to 2026.7.4' } };
    const patch = `
--- a/package/utils/mypkg/Makefile
+++ b/package/utils/mypkg/Makefile
+PKG_VERSION:=2026.07.04
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
  });

  test('catches version mismatch with commit subject', () => {
    const commit = { commit: { message: 'bash: update to 5.3' } };
    const patch = `
--- a/package/utils/bash/Makefile
+++ b/package/utils/bash/Makefile
+PKG_VERSION:=5.4
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.ok(res.errors.some(e => e.includes('PKG_VERSION')));
  });

  test('skips subject validation for a revert restoring the previous PKG_VERSION', () => {
    const commit = { commit: { message: 'sing-box: Revert "sing-box: update to 1.12.3"\n\nThis reverts commit 9fceb02d0ae598e95dc970b74767f19372d61af8.' } };
    const patch = `
--- a/package/net/sing-box/Makefile
+++ b/package/net/sing-box/Makefile
+PKG_VERSION:=1.12.2
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
    assert.ok(res.successes.some(s => s.includes('Commit reverts a previous change')));
  });

  test('catches version mismatch on a revert when allow_revert is disabled', () => {
    const commit = { commit: { message: 'sing-box: Revert "sing-box: update to 1.12.3"' } };
    const patch = `
--- a/package/net/sing-box/Makefile
+++ b/package/net/sing-box/Makefile
+PKG_VERSION:=1.12.2
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, { ...CONFIG, allow_revert: false }, state);
    assert.ok(res.errors.some(e => e.includes('PKG_VERSION')));
  });

  test('catches version mismatch on a revert that does not reference the reverted commit', () => {
    const commit = { commit: { message: 'sing-box: Revert "sing-box: update to 1.12.3"\n\nIt broke the build.' } };
    const patch = `
--- a/package/net/sing-box/Makefile
+++ b/package/net/sing-box/Makefile
+PKG_VERSION:=1.12.2
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.ok(res.errors.some(e => e.includes('PKG_VERSION')));
  });

  test('skips subject validation for dynamic/templated PKG_VERSION', () => {
    const commit = { commit: { message: 'apk: update to 2.14.0' } };
    const patch = `
--- a/package/utils/apk/Makefile
+++ b/package/utils/apk/Makefile
+PKG_VERSION:=$(subst -,.,$(PKG_SOURCE_VERSION))
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(res.errors.length, 0);
  });

  test('validates every Makefile version bump in a commit, not just the first', () => {
    const commit = { commit: { message: 'bash: update to 5.3' } };
    const patch = `
diff --git a/package/utils/bash/Makefile b/package/utils/bash/Makefile
--- a/package/utils/bash/Makefile
+++ b/package/utils/bash/Makefile
+PKG_VERSION:=5.3
diff --git a/package/utils/sed/Makefile b/package/utils/sed/Makefile
--- a/package/utils/sed/Makefile
+++ b/package/utils/sed/Makefile
+PKG_VERSION:=4.9
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.ok(res.errors.some(e => e.includes("'4.9'")), `Errors: ${res.errors.join(', ')}`);
    assert.ok(res.successes.some(s => s.includes('(5.3)')), `Successes: ${res.successes.join(', ')}`);
  });

  test('still validates a version bump when the same commit adds a new package', () => {
    const commit = { commit: { message: 'newpkg: add package' } };
    const patch = `
diff --git a/package/utils/newpkg/Makefile b/package/utils/newpkg/Makefile
--- /dev/null
+++ b/package/utils/newpkg/Makefile
+PKG_NAME:=newpkg
+PKG_VERSION:=1.0
+PKG_RELEASE:=1
+PKG_MAINTAINER:=Jane Doe <jane@doe.com>
+PKG_LICENSE:=MIT
+PKG_LICENSE_FILES:=LICENSE
diff --git a/package/utils/bash/Makefile b/package/utils/bash/Makefile
--- a/package/utils/bash/Makefile
+++ b/package/utils/bash/Makefile
+PKG_VERSION:=5.3
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(state.isNewPackage, true);
    assert.ok(res.errors.some(e => e.includes("'5.3'")), `Errors: ${res.errors.join(', ')}`);
    assert.ok(!res.errors.some(e => e.includes("'1.0'")), `Errors: ${res.errors.join(', ')}`);
  });

  test('skips version subject validation for autosquash commits', () => {
    const commit = { commit: { message: 'fixup! bash: fix build on musl' } };
    const patch = `
--- a/package/utils/bash/Makefile
+++ b/package/utils/bash/Makefile
+PKG_VERSION:=5.3
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
    assert.ok(res.successes.some(s => s.includes('Autosquash commit')), `Successes: ${res.successes.join(', ')}`);
  });

  test('requires metadata fields for new packages', () => {
    const commit = { commit: { message: 'newpkg: add package' } };
    const patch = `
--- /dev/null
+++ b/package/newpkg/Makefile
@@ -0,0 +1,10 @@
+PKG_NAME:=newpkg
+PKG_VERSION:=1.0
+PKG_RELEASE:=1
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(state.isNewPackage, true);
    assert.ok(res.errors.some(e => e.includes('PKG_MAINTAINER')));
    assert.ok(res.errors.some(e => e.includes('PKG_LICENSE')));
    assert.ok(res.errors.some(e => e.includes('PKG_LICENSE_FILES')));
    assert.ok(!res.errors.some(e => e.includes('PKG_VERSION')), 'PKG_VERSION should not be checked for new packages');
  });

  test('does not require package metadata for a new build target Makefile', () => {
    const commit = { commit: { message: 'ti-k3: add new target for BeaglePlay' } };
    const patch = `
diff --git a/target/linux/ti-k3/Makefile b/target/linux/ti-k3/Makefile
new file mode 100644
--- /dev/null
+++ b/target/linux/ti-k3/Makefile
@@ -0,0 +1,12 @@
+#
+# Copyright (C) 2025 OpenWrt.org
+#
+include $(TOPDIR)/rules.mk
+
+ARCH:=aarch64
+BOARD:=ti-k3
+BOARDNAME:=Texas Instruments K3
+FEATURES:=ext4 squashfs fpu usb gpio rtc pci
+KERNEL_PATCHVER:=6.12
+
+include $(TOPDIR)/target/linux/Makefile
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(state.isNewPackage, false, 'a target definition is not a new package');
    assert.ok(!res.errors.some(e => e.includes('PKG_MAINTAINER')));
    assert.ok(!res.errors.some(e => e.includes('PKG_LICENSE')));
    assert.ok(!res.errors.some(e => e.includes('PKG_LICENSE_FILES')));
  });

  test('does not require package metadata for a new host tool Makefile', () => {
    const commit = { commit: { message: 'tools/newtool: add host build helper' } };
    const patch = `
--- /dev/null
+++ b/tools/newtool/Makefile
@@ -0,0 +1,5 @@
+PKG_NAME:=newtool
+PKG_VERSION:=1.0
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(state.isNewPackage, false);
    assert.ok(!res.errors.some(e => e.includes('mandatory parameter')));
  });

  test('still requires package metadata when a target commit also adds a package', () => {
    const commit = { commit: { message: 'ti-k3: add new target for BeaglePlay' } };
    const patch = `
diff --git a/target/linux/ti-k3/Makefile b/target/linux/ti-k3/Makefile
--- /dev/null
+++ b/target/linux/ti-k3/Makefile
@@ -0,0 +1,3 @@
+BOARD:=ti-k3
+BOARDNAME:=Texas Instruments K3
diff --git a/package/boot/uboot-ti-k3/Makefile b/package/boot/uboot-ti-k3/Makefile
--- /dev/null
+++ b/package/boot/uboot-ti-k3/Makefile
@@ -0,0 +1,3 @@
+PKG_NAME:=uboot-ti-k3
+PKG_VERSION:=2025.01
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(state.isNewPackage, true);
    assert.ok(res.errors.some(e => e.includes('PKG_MAINTAINER')));
  });

  test('does not flag a removed target Makefile as a dropped package', () => {
    const commit = { commit: { message: 'ti-k3: drop target' } };
    const patch = `
--- a/target/linux/ti-k3/Makefile
+++ /dev/null
@@ -1,3 +0,0 @@
-BOARD:=ti-k3
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(state.isDroppedPackage, false);
  });

  test('flags a removed package Makefile as a dropped package', () => {
    const commit = { commit: { message: 'oldpkg: drop package' } };
    const patch = `
--- a/package/utils/oldpkg/Makefile
+++ /dev/null
@@ -1,3 +0,0 @@
-PKG_NAME:=oldpkg
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(state.isDroppedPackage, true);
  });

  test('supports custom metadata fields in check_openwrt_meta', () => {
    const commit = { commit: { message: 'newpkg: add package' } };
    const patch = `
--- /dev/null
+++ b/package/newpkg/Makefile
@@ -0,0 +1,10 @@
+PKG_NAME:=newpkg
+PKG_VERSION:=1.0
+PKG_RELEASE:=1
+PKG_MAINTAINER:=John Doe <john@doe.com>
     `;
    const customConfig = { ...CONFIG, check_openwrt_meta: ['PKG_MAINTAINER', 'PKG_LICENSE'] };
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, customConfig, state);
    assert.strictEqual(state.isNewPackage, true);
    // Should error for PKG_LICENSE (which is in the custom list but missing)
    assert.ok(res.errors.some(e => e.includes('PKG_LICENSE')));
    // Should NOT error for PKG_LICENSE_FILES (which is not in the custom list)
    assert.ok(!res.errors.some(e => e.includes('PKG_LICENSE_FILES')));
  });

  test('skips PKG_LICENSE/PKG_LICENSE_FILES when package includes trusted-firmware-a.mk', () => {
    const commit = { commit: { message: 'packages/boot: add arm-trusted-firmware-airoha' } };
    const patch = `
--- /dev/null
+++ b/package/boot/arm-trusted-firmware-airoha/Makefile
@@ -0,0 +1,15 @@
+#
+# Copyright (C) 2024 OpenWrt.org
+#
+include $(TOPDIR)/rules.mk
+include $(INCLUDE_DIR)/trusted-firmware-a.mk
+
+PKG_NAME:=arm-trusted-firmware-airoha
+PKG_VERSION:=1.0
+PKG_RELEASE:=1
+PKG_MAINTAINER:=John Doe <john@example.com>
+
+define Package/arm-trusted-firmware-airoha
+  TITLE:=Airoha ARM Trusted Firmware
+endef
+    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(state.isNewPackage, true);
    // Should NOT error for PKG_LICENSE or PKG_LICENSE_FILES since trusted-firmware-a.mk defines them
    assert.ok(!res.errors.some(e => e.includes('PKG_LICENSE')), 'PKG_LICENSE should not be required when trusted-firmware-a.mk is included');
    assert.ok(!res.errors.some(e => e.includes('PKG_LICENSE_FILES')), 'PKG_LICENSE_FILES should not be required when trusted-firmware-a.mk is included');
    // But should still require PKG_MAINTAINER
    assert.ok(!res.errors.some(e => e.includes('PKG_MAINTAINER')), 'PKG_MAINTAINER should still be required');
  });

  test('skips PKG_LICENSE/PKG_LICENSE_FILES when package includes u-boot.mk', () => {
    const commit = { commit: { message: 'uboot: add new board support' } };
    const patch = `
--- /dev/null
+++ b/package/boot/uboot-someboard/Makefile
@@ -0,0 +1,15 @@
+#
+# Copyright (C) 2024 OpenWrt.org
+#
+include $(TOPDIR)/rules.mk
+include $(INCLUDE_DIR)/u-boot.mk
+
+PKG_NAME:=uboot-someboard
+PKG_VERSION:=2024.01
+PKG_RELEASE:=1
+PKG_MAINTAINER:=Jane Doe <jane@example.com>
+
+define Package/uboot-someboard
+  TITLE:=U-Boot for SomeBoard
+endef
+    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(state.isNewPackage, true);
    // Should NOT error for PKG_LICENSE or PKG_LICENSE_FILES since u-boot.mk defines them
    assert.ok(!res.errors.some(e => e.includes('PKG_LICENSE')), 'PKG_LICENSE should not be required when u-boot.mk is included');
    assert.ok(!res.errors.some(e => e.includes('PKG_LICENSE_FILES')), 'PKG_LICENSE_FILES should not be required when u-boot.mk is included');
    // But should still require PKG_MAINTAINER
    assert.ok(!res.errors.some(e => e.includes('PKG_MAINTAINER')), 'PKG_MAINTAINER should still be required');
  });

  test('still requires PKG_LICENSE/PKG_LICENSE_FILES when no known license include is present', () => {
    const commit = { commit: { message: 'newpkg: add package' } };
    const patch = `
--- /dev/null
+++ b/package/newpkg/Makefile
@@ -0,0 +1,12 @@
+#
+# Copyright (C) 2024 OpenWrt.org
+#
+include $(TOPDIR)/rules.mk
+include $(INCLUDE_DIR)/package.mk
+
+PKG_NAME:=newpkg
+PKG_VERSION:=1.0
+PKG_RELEASE:=1
+PKG_MAINTAINER:=John Doe <john@example.com>
+
+define Package/newpkg
+  TITLE:=New Package
+endef
+    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(state.isNewPackage, true);
    // Should still error for PKG_LICENSE and PKG_LICENSE_FILES since no known license .mk is included
    assert.ok(res.errors.some(e => e.includes('PKG_LICENSE')), 'PKG_LICENSE should still be required when no known license include present');
    assert.ok(res.errors.some(e => e.includes('PKG_LICENSE_FILES')), 'PKG_LICENSE_FILES should still be required when no known license include present');
  });

  test('detects CRLF line endings', () => {
    const commit = { commit: { message: 'bash: test' } };
    const patch = `
--- a/package/utils/bash/Makefile
+++ b/package/utils/bash/Makefile
+PKG_VERSION:=5.3\r
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.ok(res.errors.some(e => e.includes('CRLF')));
  });

  test('does not enforce openwrt metadata on subsequent commits even if state.isNewPackage is true', () => {
    const commit1 = { commit: { message: 'newpkg: add package' } };
    const patch1 = `
--- /dev/null
+++ b/package/newpkg/Makefile
+PKG_NAME:=newpkg
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    // This call sets state.isNewPackage = true
    validateMakefileContext(commit1, patch1, CONFIG, state);
    assert.strictEqual(state.isNewPackage, true);

    const commit2 = { commit: { message: 'newpkg: update version to 1.0.0' } };
    const patch2 = `
--- a/package/newpkg/Makefile
+++ b/package/newpkg/Makefile
+PKG_VERSION:=1.0.0
    `;
    // This call should not complain about missing PKG_MAINTAINER, etc.
    const res = validateMakefileContext(commit2, patch2, CONFIG, state);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
  });

  test('accepts PKG_MAINTAINER with valid email format', () => {
    const commit = { commit: { message: 'bash: test' } };
    const patch = `
--- a/package/utils/bash/Makefile
+++ b/package/utils/bash/Makefile
+PKG_MAINTAINER:=Jane Doe <jane.doe@example.com>
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
  });

  test('accepts multiple PKG_MAINTAINER names and emails', () => {
    const commit = { commit: { message: 'bash: test' } };
    const patch = `
--- a/package/utils/bash/Makefile
+++ b/package/utils/bash/Makefile
+PKG_MAINTAINER:=Jane Doe <jane.doe@example.com>, John Doe <john.doe@example.com>
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
  });

  test('rejects PKG_MAINTAINER with URL/website inside angle brackets', () => {
    const commit = { commit: { message: 'bash: test' } };
    const patch = `
--- a/package/utils/bash/Makefile
+++ b/package/utils/bash/Makefile
+PKG_MAINTAINER:=Jane Doe <https://example.com/janedoe>
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.ok(res.errors.some(e => e.includes('must be a valid email address and not a website/URL')));
  });

  test('rejects PKG_MAINTAINER without angle brackets / email', () => {
    const commit = { commit: { message: 'bash: test' } };
    const patch = `
--- a/package/utils/bash/Makefile
+++ b/package/utils/bash/Makefile
+PKG_MAINTAINER:=Jane Doe
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.ok(res.errors.some(e => e.includes("should contain an email address inside angle brackets '<>'")));
  });

  test('does not demand conffiles for non-config payload under /etc', () => {
    const commit = { commit: { message: 'uhttpd: run in ujail' } };
    const patch = `
diff --git a/package/network/services/uhttpd/Makefile b/package/network/services/uhttpd/Makefile
--- a/package/network/services/uhttpd/Makefile
+++ b/package/network/services/uhttpd/Makefile
+	$(INSTALL_DIR) $(1)/etc/capabilities
+	$(INSTALL_DATA) ./files/uhttpd.capabilities $(1)/etc/capabilities/uhttpd.json
+	$(INSTALL_DIR) $(1)/usr/share/acl.d
+	$(INSTALL_DATA) ./files/uhttpd.acl $(1)/usr/share/acl.d/uhttpd.json
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.ok(!res.errors.some(e => e.includes('conffiles')), `Errors: ${res.errors.join(', ')}`);
  });

  test('still demands conffiles for INSTALL_CONF and /etc/config destinations in a new Makefile', () => {
    const commit = { commit: { message: 'foo: add new package' } };
    for (const installLine of [
      '+	$(INSTALL_CONF) ./files/foo.config $(1)/etc/foo',
      '+	$(CP) ./files/foo.config $(1)/etc/config/foo'
    ]) {
      const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
new file mode 100644
--- /dev/null
+++ b/package/utils/foo/Makefile
${installLine}
    `;
      const state = { isNewPackage: true, isDroppedPackage: false };
      const res = validateMakefileContext(commit, patch, CONFIG, state);
      assert.ok(res.errors.some(e => e.includes("missing the required 'conffiles' section")), `Errors for '${installLine.trim()}': ${res.errors.join(', ')}`);
    }
  });

  test('does not demand conffiles when an existing Makefile only changes its install line', () => {
    const commit = { commit: { message: 'foo: install the configuration with INSTALL_CONF' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
@@ -120,7 +120,7 @@ define Package/foo/install
-	$(INSTALL_DATA) ./files/foo.conf $(1)/etc/foo.conf
+	$(INSTALL_CONF) ./files/foo.conf $(1)/etc/foo.conf
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.ok(!res.errors.some(e => e.includes("missing the required 'conffiles' section")), `Errors: ${res.errors.join(', ')}`);
  });

  test('accepts valid conffiles block with no indentation or space', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+define Package/foo/conffiles
+/etc/foo.json
+endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
    assert.ok(res.successes.some(s => s.includes('conffiles block contains no spaces or indentation')));
  });

  test('rejects conffiles block with space indentation', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+define Package/foo/conffiles
+    /etc/foo.json
+endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.ok(res.errors.some(e => e.includes("must not contain any spaces or indentation")));
  });

  test('rejects conffiles block with tab indentation', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+define Package/foo/conffiles
+\t/etc/foo.json
+endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.ok(res.errors.some(e => e.includes("must not contain any spaces or indentation")));
  });

  test('rejects conffiles block with spaces inside a line', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+define Package/foo/conffiles
+/etc/foo.json 
+endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.ok(res.errors.some(e => e.includes("must not contain any spaces or indentation")));
  });

  test('ignores files that are not Makefiles even if they contain conffiles block definitions', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/README.md b/package/utils/foo/README.md
--- a/package/utils/foo/README.md
+++ b/package/utils/foo/README.md
+define Package/foo/conffiles
+    /etc/foo.json
+endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
  });

  test('ignores deleted conffiles definitions when tracking state', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
-define Package/foo/conffiles
-/etc/foo.json
-endef
+define Package/foo/install
+	$(INSTALL_DIR) $(1)/usr/bin
+endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
  });

  test('rejects conffiles path that is not an absolute path', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+define Package/foo/conffiles
+etc/foo.json
+endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.ok(res.errors.some(e => e.includes("must be an absolute path starting with '/'")));
  });

  test('accepts a conffiles directory written without a trailing slash', () => {
    // `scripts/ipkg-build` and sysupgrade both hand the entry to `find`, which
    // walks a directory the same with or without the slash, and openwrt ships
    // `/etc/ipsec.d` next to `/etc/dnsmasq.d/`, so demanding one spelling
    // rejected valid Makefiles.
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+define Package/foo/conffiles
+/etc/config
+/etc/foo.conf
+/etc/foo.d
+endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
  });

  test('accepts conffiles .d directory with trailing slash', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+define Package/foo/conffiles
+/etc/foo.conf
+/etc/foo.d/
+endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
  });

  test('accepts an INSTALL_DIR directory written without a trailing slash', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+define Package/foo/conffiles
+/etc/foo.d
+endef
+define Package/foo/install
+	$(INSTALL_DIR) $(1)/etc/foo.d
+endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
  });

  test('accepts the make expansions openwrt writes in conffiles blocks', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+define Package/foo/conffiles
+$(CONF_DIR)/my.cnf
+$(config_directory)
+$(Package/busybox/conffiles/crond)
+$(call Package/tac_plus/Default/conffiles)
+$(if $(CONFIG_OPENSSL_ENGINE_BUILTIN_PADLOCK),/etc/ssl/modules.cnf.d/padlock.cnf)
+/etc/$(PKG_NAME).conf
+endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
  });

  test('still rejects an indented conffiles entry, expansion or not', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+define Package/foo/conffiles
+  $(CONF_DIR)/my.cnf
+endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.ok(res.errors.some(e => e.includes('must not contain any spaces or indentation')),
      `Errors: ${res.errors.join(', ')}`);
  });

  // What an entry may look like, judged by what the build does with it:
  // scripts/ipkg-build rewrites the first word of each line and hands the
  // list to find, and whatever package-pack.mk does not checksum as a regular
  // file goes to /lib/upgrade/keep.d, which sysupgrade expands with find.
  const conffilesErrorsFor = (lines) => {
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+define Package/foo/conffiles
${lines.map(l => '+' + l).join('\n')}
+endef
    `;
    const res = validateMakefileContext({ commit: { message: 'foo: test' } }, patch, CONFIG, { isNewPackage: false, isDroppedPackage: false });
    return res.errors;
  };

  test('rejects a relative path however many expansions follow it', () => {
    const errors = conffilesErrorsFor(['foo$(WHATEVER)']);
    assert.ok(errors.some(e => e.includes("must be an absolute path starting with '/'")), `Errors: ${errors.join(', ')}`);
  });

  test('rejects two words on a line even when the second is an expansion', () => {
    const errors = conffilesErrorsFor(['not/a/path $(FOO)']);
    assert.ok(errors.some(e => e.includes('must not contain any spaces or indentation')), `Errors: ${errors.join(', ')}`);
    assert.ok(errors.some(e => e.includes("must be an absolute path starting with '/'")), `Errors: ${errors.join(', ')}`);
  });

  test('accepts a literal path with an expansion in the middle or at the end', () => {
    // gkrellmd, openvpn-easy-rsa and prometheus-node-exporter-ucode write these
    assert.deepStrictEqual(conffilesErrorsFor(['/etc/$(PKG_NAME).conf', '/etc/profile.d/50-$(PKG_NAME).sh', '/etc/config/$(PKG_NAME)']), []);
  });

  test('accepts a path that begins with an expansion', () => {
    // mariadb and postfix: the leading slash, if any, is decided at build time
    assert.deepStrictEqual(conffilesErrorsFor(['$(CONF_DIR)/my.cnf', '$(config_directory)']), []);
  });

  test('accepts a whole-line make call, nested expansions and interior spaces included', () => {
    assert.deepStrictEqual(conffilesErrorsFor([
      '$(if $(CONFIG_OPENSSL_ENGINE_BUILTIN_PADLOCK),/etc/ssl/modules.cnf.d/padlock.cnf)',
      '$(call Package/tac_plus/Default/conffiles)',
      '$(call $(TARGET)/conffiles)',
      '$(Package/busybox/conffiles/crond)',
    ]), []);
  });

  test('rejects whitespace outside a call even when a call is present', () => {
    for (const line of ['$(call Package/x/Default/conffiles) ', '/etc/a /etc/b', '/etc/a.conf $(B)']) {
      const errors = conffilesErrorsFor([line]);
      assert.ok(errors.some(e => e.includes('must not contain any spaces or indentation')), `${JSON.stringify(line)}: ${errors.join(', ')}`);
    }
  });

  test('rejects indentation with either whitespace character, expansion or not', () => {
    // uboot-envtools indents with a tab, bluez-tools with two spaces
    for (const line of ['\t/etc/config/ubootenv', '  /etc/config/btagent', '  $(CONF_DIR)/my.cnf']) {
      const errors = conffilesErrorsFor([line]);
      assert.ok(errors.some(e => e.includes('must not contain any spaces or indentation')), `${JSON.stringify(line)}: ${errors.join(', ')}`);
    }
  });

  test('rejects a trailing slash on a file even with an expansion in the path', () => {
    const errors = conffilesErrorsFor(['/etc/config/$(PKG_NAME)/']);
    assert.ok(errors.some(e => e.includes('must not end with a trailing slash')), `Errors: ${errors.join(', ')}`);
    assert.deepStrictEqual(conffilesErrorsFor(['/etc/dnsmasq.d/', '/etc/ipsec.d']), []);
  });

  test('stays silent on an unterminated expansion, which make itself refuses', () => {
    // Anywhere on the line: one that begins with literal text would otherwise
    // be judged as a relative path.
    assert.deepStrictEqual(conffilesErrorsFor(['$(unclosed/foo', 'etc$(unclosed/foo']), []);
  });

  test('accepts whitespace only as the separator after a make function name', () => {
    assert.deepStrictEqual(conffilesErrorsFor([
      '$(if $(filter y,$(CONFIG_X)),/etc/a.conf)',
      '${call Package/tac_plus/Default/conffiles}',
    ]), []);
    // Each of these puts whitespace into what the line expands to.
    for (const line of ['$(if $(CONFIG_X),/etc/a /etc/b)', '$(foreach f,a b,/etc/$(f).conf)', '$(FOO BAR)/etc/x.conf', '$(if $(CONFIG_X), /etc/a)']) {
      const errors = conffilesErrorsFor([line]);
      assert.ok(errors.some(e => e.includes('must not contain any spaces or indentation')), `${JSON.stringify(line)}: ${errors.join(', ')}`);
    }
  });

  test('rejects a trailing slash on the file extensions the tree uses', () => {
    for (const line of ['/etc/mysql/my.cnf/', '/etc/fw_env.config/', '/etc/nftables.d/10-custom.nft/', '/etc/firewall.user/']) {
      const errors = conffilesErrorsFor([line]);
      assert.ok(errors.some(e => e.includes('must not end with a trailing slash')), `${JSON.stringify(line)}: ${errors.join(', ')}`);
    }
    assert.deepStrictEqual(conffilesErrorsFor(['/etc/nftables.d/', '/etc/luci-uploads/']), []);
  });

  test('still rejects a trailing slash on an individual config file', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+define Package/foo/conffiles
+/etc/config/foo/
+endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.ok(res.errors.some(e => e.includes('must not end with a trailing slash')),
      `Errors: ${res.errors.join(', ')}`);
  });

  test('does not leak conffiles block into install block when endef is in diff hunk header', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
@@ -50,6 +50,8 @@ endef
 define Package/foo/conffiles
 /etc/foo.conf
+/etc/foo.d/
 endef
 
 define Package/foo/install
+	$(INSTALL_DIR) $(1)/etc/foo.d
+	$(INSTALL_CONF) ./files/foo.conf $(1)/etc/foo.conf
 endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    // Should NOT flag INSTALL_DIR or INSTALL_CONF lines as conffiles errors
    assert.ok(!res.errors.some(e => e.includes("INSTALL_DIR")), `Should not flag INSTALL_DIR as conffiles error: ${res.errors.join(', ')}`);
    assert.ok(!res.errors.some(e => e.includes("INSTALL_CONF")), `Should not flag INSTALL_CONF as conffiles error: ${res.errors.join(', ')}`);
    assert.ok(!res.errors.some(e => e.includes("must not contain any spaces or indentation") && e.includes("INSTALL")), `Should not flag install lines as indentation errors: ${res.errors.join(', ')}`);
  });

  test('does not leak conffiles block into a later install hunk when endef is never shown in the diff (odhcp6c PR#22751 regression)', () => {
    const commit = { commit: { message: 'odhcp6c: test' } };
    const patch = `
diff --git a/package/network/ipv6/odhcp6c/Makefile b/package/network/ipv6/odhcp6c/Makefile
--- a/package/network/ipv6/odhcp6c/Makefile
+++ b/package/network/ipv6/odhcp6c/Makefile
@@ -28,7 +28,7 @@ define Package/odhcp6c
   SECTION:=net
   CATEGORY:=Network
   TITLE:=Embedded DHCPv6-client for OpenWrt
-  DEPENDS:=@IPV6 +libubox +libubus
+  DEPENDS:=@IPV6 +libubox +libubus +ucode
 endef

 define Package/odhcp6c/conffiles
@@ -40,7 +40,7 @@ define Package/odhcp6c/install
 	$(INSTALL_DIR) $(1)/usr/sbin/
 	$(INSTALL_BIN) $(PKG_BUILD_DIR)/odhcp6c $(1)/usr/sbin/
 	$(INSTALL_DIR) $(1)/lib/netifd/proto
-	$(INSTALL_BIN) ./files/dhcpv6.sh $(1)/lib/netifd/proto/dhcpv6.sh
+	$(INSTALL_BIN) ./files/dhcpv6.uc $(1)/lib/netifd/proto/dhcpv6.uc
 	$(INSTALL_BIN) ./files/dhcpv6.script $(1)/lib/netifd/
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.ok(!res.errors.some(e => e.includes('INSTALL_BIN')), `Should not flag install line as conffiles error: ${res.errors.join(', ')}`);
    assert.ok(!res.errors.some(e => e.includes('must not contain any spaces or indentation')), `Should not flag spaces error: ${res.errors.join(', ')}`);
    assert.ok(!res.errors.some(e => e.includes("must be an absolute path")), `Should not flag absolute path error: ${res.errors.join(', ')}`);
  });

  test('does not leak conffiles block into a later hunk whose context is not a define', () => {
    const commit = { commit: { message: 'foo: bump to 3.0.722, replace maintainer' } };
    const patch = `
diff --git a/net/foo/Makefile b/net/foo/Makefile
--- a/net/foo/Makefile
+++ b/net/foo/Makefile
@@ -33,7 +33,7 @@ endef
 define Package/foo/description
 foo is a packet sniffer that runs as a background process on a cable/DSL
 router, gathers all sorts of statistics about network usage, and serves them
-over HTTP.
+over HTTPS.
 endef

 define Package/foo/conffiles
@@ -49,6 +49,11 @@ CONFIGURE_VARS += \\
 	ac_cv_search_strlcpy=no \\
 	ac_cv_search_strlcat=no

+define Build/Configure
+	( cd $(PKG_BUILD_DIR) && autoreconf -fi )
+	$(call Build/Configure/Default)
+endef
+
 define Build/Compile
 	$(HOSTCC) $(PKG_BUILD_DIR)/static/c-ify.c \\
 		-o $(PKG_BUILD_DIR)/c-ify
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.ok(!res.errors.some(e => e.includes('Build/Configure')), `Should not flag Build/Configure block as conffiles error: ${res.errors.join(', ')}`);
    assert.ok(!res.errors.some(e => e.includes('autoreconf')), `Should not flag autoreconf line as conffiles error: ${res.errors.join(', ')}`);
    assert.ok(!res.errors.some(e => e.includes('must not contain any spaces or indentation')), `Should not flag spaces error: ${res.errors.join(', ')}`);
    assert.ok(!res.errors.some(e => e.includes('must be an absolute path')), `Should not flag absolute path error: ${res.errors.join(', ')}`);
  });

  test('closes conffiles block on a define that is not a conffiles block', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/net/foo/Makefile b/net/foo/Makefile
--- a/net/foo/Makefile
+++ b/net/foo/Makefile
@@ -41,0 +42,6 @@ define Package/foo/conffiles
+define Build/Configure
+	( cd $(PKG_BUILD_DIR) && autoreconf -fi )
+	$(call Build/Configure/Default)
+endef
+
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
  });

  test('rejects conffiles path for individual file ending with trailing slash', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+define Package/foo/conffiles
+/etc/config/foo/
+endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.ok(res.errors.some(e => e.includes("is an individual file and must not end with a trailing slash")));
  });

  test('rejects conffiles path for individual file with extension ending with trailing slash', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+define Package/foo/conffiles
+/etc/foo.conf/
+endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.ok(res.errors.some(e => e.includes("is an individual file and must not end with a trailing slash")));
  });

  test('rejects package that installs config files but is missing conffiles section', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
new file mode 100644
--- /dev/null
+++ b/package/utils/foo/Makefile
+define Package/foo/install
+	$(INSTALL_DIR) $(1)/etc/config
+	$(INSTALL_DATA) ./files/foo.config $(1)/etc/config/foo
+endef
    `;
    const state = { isNewPackage: true, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.ok(res.errors.some(e => e.includes("Makefile installs configuration files under /etc/, but is missing the required 'conffiles' section")));
  });

  test('accepts package that installs config files and has conffiles section', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+define Package/foo/conffiles
+/etc/config/foo
+endef
+define Package/foo/install
+	$(INSTALL_DIR) $(1)/etc/config
+	$(INSTALL_CONF) ./files/foo.config $(1)/etc/config/foo
+endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
  });

  test('accepts conffiles directory with trailing slash', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+define Package/foo/conffiles
+/etc/config/
+/etc/ssl/certs/
+endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
  });

  test('catches missing trailing newline on new/modified file additions as error by default', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- /dev/null
+++ b/package/utils/foo/Makefile
@@ -0,0 +1,1 @@
+PKG_NAME:=foo
\\ No newline at end of file
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const newlineTestConfig = {
      ...CONFIG,
      check_openwrt_meta: false,
      check_conffiles: false,
      check_crlf: false,
      check_pkg_version: false,
      check_trailing_newline: true
    };
    const res = validateMakefileContext(commit, patch, newlineTestConfig, state);
    assert.ok(res.errors.some(e => e.includes("missing a trailing newline")));
    assert.strictEqual(res.warnings.length, 0);
  });

  test('catches missing trailing newline as warning when check_trailing_newline is set to warning', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- /dev/null
+++ b/package/utils/foo/Makefile
@@ -0,0 +1,1 @@
+PKG_NAME:=foo
\\ No newline at end of file
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const newlineTestConfig = {
      ...CONFIG,
      check_openwrt_meta: false,
      check_conffiles: false,
      check_crlf: false,
      check_pkg_version: false,
      check_trailing_newline: 'warning'
    };
    const res = validateMakefileContext(commit, patch, newlineTestConfig, state);
    assert.ok(res.warnings.some(w => w.includes("missing a trailing newline")));
    assert.strictEqual(res.errors.length, 0);
  });

  test('does not report missing trailing newline when check_trailing_newline is disabled', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- /dev/null
+++ b/package/utils/foo/Makefile
@@ -0,0 +1,1 @@
+PKG_NAME:=foo
\\ No newline at end of file
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const newlineTestConfig = {
      ...CONFIG,
      check_openwrt_meta: false,
      check_conffiles: false,
      check_crlf: false,
      check_pkg_version: false,
      check_trailing_newline: false
    };
    const res = validateMakefileContext(commit, patch, newlineTestConfig, state);
    assert.strictEqual(res.errors.length, 0);
    assert.strictEqual(res.warnings.length, 0);
  });

  test('accepts files with trailing newline', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- /dev/null
+++ b/package/utils/foo/Makefile
@@ -0,0 +1,1 @@
+PKG_NAME:=foo
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const newlineTestConfig = {
      ...CONFIG,
      check_openwrt_meta: false,
      check_conffiles: false,
      check_crlf: false,
      check_pkg_version: false,
      check_trailing_newline: true
    };
    const res = validateMakefileContext(commit, patch, newlineTestConfig, state);
    assert.strictEqual(res.errors.length, 0);
    assert.strictEqual(res.warnings.length, 0);
    assert.ok(res.successes.some(s => s.includes("All modified files contain a trailing newline")));
  });

  test('ignores missing trailing newline in pre-image (old version) when not present in post-image', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
@@ -1,1 +1,2 @@
-PKG_NAME:=foo
\\ No newline at end of file
+PKG_NAME:=foo
+PKG_VERSION:=1.0
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const newlineTestConfig = {
      ...CONFIG,
      check_openwrt_meta: false,
      check_conffiles: false,
      check_crlf: false,
      check_pkg_version: false,
      check_trailing_newline: true
    };
    const res = validateMakefileContext(commit, patch, newlineTestConfig, state);
    assert.strictEqual(res.errors.length, 0);
    assert.strictEqual(res.warnings.length, 0);
  });

  test('flags spaces immediately after the := operator in Makefiles', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+PKG_LICENSE:= MIT
+PKG_SOURCE_URL:= https://github.com/foo/bar
+PKG_NAME :=  foo
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const testConfig = {
      ...CONFIG,
      check_openwrt_meta: false,
      check_conffiles: false,
      check_crlf: false,
      check_pkg_version: false,
      check_trailing_newline: false,
      check_space_after_assignment: true
    };
    const res = validateMakefileContext(commit, patch, testConfig, state);
    assert.strictEqual(res.errors.length, 3);
    assert.ok(res.errors[0].includes("Makefile line 'PKG_LICENSE:= MIT' has a space after ':='"));
    assert.ok(res.errors[1].includes("Makefile line 'PKG_SOURCE_URL:= https://github.com/foo/bar' has a space after ':='"));
    assert.ok(res.errors[2].includes("Makefile line 'PKG_NAME :=  foo' has a space after ':='"));
  });

  test('accepts clean assignments without space after :=', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+PKG_LICENSE:=MIT
+PKG_SOURCE_URL:=https://github.com/foo/bar
+PKG_NAME:=foo
+VAR:=
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const testConfig = {
      ...CONFIG,
      check_openwrt_meta: false,
      check_conffiles: false,
      check_crlf: false,
      check_pkg_version: false,
      check_trailing_newline: false,
      check_space_after_assignment: true
    };
    const res = validateMakefileContext(commit, patch, testConfig, state);
    assert.strictEqual(res.errors.length, 0);
    assert.ok(res.successes.some(s => s.includes("does not contain spaces after ':='")));
  });

  test('ignores comments and recipe lines containing spaces after :=', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+# TITLE:= Simple WireGuard proxy
+	$(SH) -c "var := value"
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const testConfig = {
      ...CONFIG,
      check_openwrt_meta: false,
      check_conffiles: false,
      check_crlf: false,
      check_pkg_version: false,
      check_trailing_newline: false,
      check_space_after_assignment: true
    };
    const res = validateMakefileContext(commit, patch, testConfig, state);
    assert.strictEqual(res.errors.length, 0);
  });

  test('respects check_space_after_assignment: false configuration option', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+PKG_LICENSE:= MIT
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const testConfig = {
      ...CONFIG,
      check_openwrt_meta: false,
      check_conffiles: false,
      check_crlf: false,
      check_pkg_version: false,
      check_trailing_newline: false,
      check_space_after_assignment: false
    };
    const res = validateMakefileContext(commit, patch, testConfig, state);
    assert.strictEqual(res.errors.length, 0);
  });

  test('flags `=` instead of `:=` for standard variables (missing colon)', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+PKG_SOURCE_URL= \\
+PKG_LICENSE = MIT
+PKG_VERSION= 1.0.0
+CUSTOM_VAR = helper
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const testConfig = {
      ...CONFIG,
      check_openwrt_meta: false,
      check_conffiles: false,
      check_crlf: false,
      check_pkg_version: false,
      check_trailing_newline: false,
      check_missing_colon: true
    };
    const res = validateMakefileContext(commit, patch, testConfig, state);
    assert.strictEqual(res.errors.length, 3);
    assert.ok(res.errors[0].includes("uses '=' instead of ':='"));
    assert.ok(res.errors[0].includes("PKG_SOURCE_URL"));
    assert.ok(res.errors[1].includes("uses '=' instead of ':='"));
    assert.ok(res.errors[1].includes("PKG_LICENSE"));
    assert.ok(res.errors[2].includes("uses '=' instead of ':='"));
    assert.ok(res.errors[2].includes("PKG_VERSION"));
  });

  test('respects check_missing_colon: false configuration option', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+PKG_SOURCE_URL= \\
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const testConfig = {
      ...CONFIG,
      check_openwrt_meta: false,
      check_conffiles: false,
      check_crlf: false,
      check_pkg_version: false,
      check_trailing_newline: false,
      check_missing_colon: false
    };
    const res = validateMakefileContext(commit, patch, testConfig, state);
    assert.strictEqual(res.errors.length, 0);
  });

  test('accepts space after := when followed by line continuation backslash', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+ DEPENDS:= \\
+	+libpcre2 \\
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const testConfig = {
      ...CONFIG,
      check_openwrt_meta: false,
      check_conffiles: false,
      check_crlf: false,
      check_pkg_version: false,
      check_trailing_newline: false,
      check_space_after_assignment: true
    };
    const res = validateMakefileContext(commit, patch, testConfig, state);
    assert.strictEqual(res.errors.length, 0);
  });

  test('formats assignment error suggestions as diff block preserving indentation', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+  PKG_SOURCE_URL=https://github.com/foo/bar
+  TITLE:= Simple WireGuard proxy
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const testConfig = {
      ...CONFIG,
      check_openwrt_meta: false,
      check_conffiles: false,
      check_crlf: false,
      check_pkg_version: false,
      check_trailing_newline: false,
      check_missing_colon: true,
      check_space_after_assignment: true
    };
    const res = validateMakefileContext(commit, patch, testConfig, state);
    assert.strictEqual(res.errors.length, 2);
    
    // Check that missing colon error includes diff block with correct indentation
    assert.ok(res.errors[0].includes("  -   PKG_SOURCE_URL=https://github.com/foo/bar"));
    assert.ok(res.errors[0].includes("  +   PKG_SOURCE_URL:=https://github.com/foo/bar"));
    
    // Check that space after assignment error includes diff block with correct indentation
    assert.ok(res.errors[1].includes("  -   TITLE:= Simple WireGuard proxy"));
    assert.ok(res.errors[1].includes("  +   TITLE:=Simple WireGuard proxy"));
  });

  test('passes valid Makefile block indentation', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+define Package/foo
+  SECTION:=utils
+  CATEGORY:=Utilities
+  TITLE:=Example package
+  DEPENDS:=+libstdcpp \\
+    +libpthread
+endef
+
+define Package/foo/description
+  This is a package description.
+    - bullet 1
+    - bullet 2
+endef
+
+define Package/foo/install
+	$(INSTALL_DIR) $(1)/usr/bin
+	$(INSTALL_BIN) $(PKG_BUILD_DIR)/foo $(1)/usr/bin/
+endef
+
+define Build/Compile
+	$(MAKE) -C $(PKG_BUILD_DIR)
+endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const testConfig = {
      ...CONFIG,
      check_openwrt_meta: false,
      check_conffiles: false,
      check_crlf: false,
      check_pkg_version: false,
      check_trailing_newline: false,
      check_makefile_indentation: true
    };
    const res = validateMakefileContext(commit, patch, testConfig, state);
    assert.strictEqual(res.errors.length, 0);
    assert.ok(res.successes.some(s => s.includes("Makefile blocks contain valid indentation")));
  });

  test('flags invalid indentation in Package metadata blocks', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+define Package/foo
+ SECTION:=utils
+	CATEGORY:=Utilities
+   TITLE:=Example package
+endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const testConfig = {
      ...CONFIG,
      check_openwrt_meta: false,
      check_conffiles: false,
      check_crlf: false,
      check_pkg_version: false,
      check_trailing_newline: false,
      check_makefile_indentation: true
    };
    const res = validateMakefileContext(commit, patch, testConfig, state);
    assert.strictEqual(res.errors.length, 3);
    assert.ok(res.errors[0].includes("line 'SECTION:=utils' inside 'Package/foo' must be indented with exactly 2 spaces"));
    assert.ok(res.errors[1].includes("line 'CATEGORY:=Utilities' inside 'Package/foo' must be indented with exactly 2 spaces"));
    assert.ok(res.errors[2].includes("line 'TITLE:=Example package' inside 'Package/foo' must be indented with exactly 2 spaces"));
  });

  test('flags invalid indentation in description blocks', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+define Package/foo/description
+ This description starts with 1 space
+	This line starts with a tab
+No spaces at all
+endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const testConfig = {
      ...CONFIG,
      check_openwrt_meta: false,
      check_conffiles: false,
      check_crlf: false,
      check_pkg_version: false,
      check_trailing_newline: false,
      check_makefile_indentation: true
    };
    const res = validateMakefileContext(commit, patch, testConfig, state);
    assert.strictEqual(res.errors.length, 3);
    assert.ok(res.errors[0].includes("line 'This description starts with 1 space' inside 'Package/foo/description' must be indented with at least 2 spaces"));
    assert.ok(res.errors[1].includes("line 'This line starts with a tab' inside 'Package/foo/description' must be indented with at least 2 spaces"));
    assert.ok(res.errors[2].includes("line 'No spaces at all' inside 'Package/foo/description' must be indented with at least 2 spaces"));
  });

  test('flags invalid indentation in recipe blocks', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+define Package/foo/install
+  $(INSTALL_DIR) $(1)/usr/bin
+	$(INSTALL_BIN) $(PKG_BUILD_DIR)/foo $(1)/usr/bin/
+endef
+
+define Build/Compile
+  $(MAKE) -C $(PKG_BUILD_DIR)
+endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const testConfig = {
      ...CONFIG,
      check_openwrt_meta: false,
      check_conffiles: false,
      check_crlf: false,
      check_pkg_version: false,
      check_trailing_newline: false,
      check_makefile_indentation: true
    };
    const res = validateMakefileContext(commit, patch, testConfig, state);
    assert.strictEqual(res.errors.length, 2);
    assert.ok(res.errors[0].includes("line '$(INSTALL_DIR) $(1)/usr/bin' inside 'Package/foo/install' must be indented with a tab"));
    assert.ok(res.errors[1].includes("line '$(MAKE) -C $(PKG_BUILD_DIR)' inside 'Build/Compile' must be indented with a tab"));
  });

  test('does not leak block state across diff hunks (issue #44)', () => {
    const commit = { commit: { message: 'prometheus-node-exporter-lua: add dhcp-leases exporter' } };
    const patch = `
diff --git a/utils/prometheus-node-exporter-lua/Makefile b/utils/prometheus-node-exporter-lua/Makefile
--- a/utils/prometheus-node-exporter-lua/Makefile
+++ b/utils/prometheus-node-exporter-lua/Makefile
@@ -81,6 +81,17 @@ define Package/prometheus-node-exporter-lua-dawn/install
 	$(INSTALL_DATA) ./files/dawn.lua $(1)/usr/lib/lua/prometheus-collectors/
 endef

+define Package/prometheus-node-exporter-lua-dhcp-leases
+  $(call Package/prometheus-node-exporter-lua/Default)
+  TITLE+= (dhcp-leases collector)
+  DEPENDS:=prometheus-node-exporter-lua
+endef
+
+define Package/prometheus-node-exporter-lua-dhcp-leases/install
+	$(INSTALL_DIR) $(1)/usr/lib/lua/prometheus-collectors
+	$(INSTALL_DATA) ./files/dhcp-leases.lua $(1)/usr/lib/lua/prometheus-collectors/
+endef
+
 define Package/prometheus-node-exporter-lua-filesystem
   $(call Package/prometheus-node-exporter-lua/Default)
   TITLE+= (filesystem collector)
@@ -320,6 +331,7 @@ endef
 $(eval $(call BuildPackage,prometheus-node-exporter-lua))
 $(eval $(call BuildPackage,prometheus-node-exporter-lua-dawn))
+$(eval $(call BuildPackage,prometheus-node-exporter-lua-dhcp-leases))
 $(eval $(call BuildPackage,prometheus-node-exporter-lua-filesystem))
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const testConfig = {
      ...CONFIG,
      check_openwrt_meta: false,
      check_conffiles: false,
      check_crlf: false,
      check_pkg_version: false,
      check_trailing_newline: false,
      check_makefile_indentation: true
    };
    const res = validateMakefileContext(commit, patch, testConfig, state);
    assert.strictEqual(res.errors.length, 0, `Expected no errors, got: ${res.errors.join(', ')}`);
    assert.ok(res.successes.some(s => s.includes("Makefile blocks contain valid indentation")));
  });

  test('re-enters block from hunk header context and validates added lines', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
@@ -10,3 +10,4 @@ define Package/foo
   SECTION:=utils
+ TITLE:=Badly indented
 endef
@@ -30,3 +31,4 @@ define Package/foo/install
 	$(INSTALL_DIR) $(1)/usr/bin
+  $(INSTALL_BIN) $(PKG_BUILD_DIR)/foo $(1)/usr/bin/
 endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const testConfig = {
      ...CONFIG,
      check_openwrt_meta: false,
      check_conffiles: false,
      check_crlf: false,
      check_pkg_version: false,
      check_trailing_newline: false,
      check_makefile_indentation: true
    };
    const res = validateMakefileContext(commit, patch, testConfig, state);
    assert.strictEqual(res.errors.length, 2, `Expected 2 errors, got: ${res.errors.join(', ')}`);
    assert.ok(res.errors[0].includes("line 'TITLE:=Badly indented' inside 'Package/foo' must be indented with exactly 2 spaces"));
    assert.ok(res.errors[1].includes("line '$(INSTALL_BIN) $(PKG_BUILD_DIR)/foo $(1)/usr/bin/' inside 'Package/foo/install' must be indented with a tab"));
  });

  test('ignores comments, empty lines, and conditionals in blocks', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+define Package/foo
+  SECTION:=utils
+
+  # This is a comment inside metadata
+ifeq ($(CONFIG_FOO),y)
+  TITLE:=Foo Enabled
+else
+  TITLE:=Foo Disabled
+endif
+endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const testConfig = {
      ...CONFIG,
      check_openwrt_meta: false,
      check_conffiles: false,
      check_crlf: false,
      check_pkg_version: false,
      check_trailing_newline: false,
      check_makefile_indentation: true
    };
    const res = validateMakefileContext(commit, patch, testConfig, state);
    assert.strictEqual(res.errors.length, 0);
  });

  test('respects check_makefile_indentation: false configuration option', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git a/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+define Package/foo
+ SECTION:=utils
+endef
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const testConfig = {
      ...CONFIG,
      check_openwrt_meta: false,
      check_conffiles: false,
      check_crlf: false,
      check_pkg_version: false,
      check_trailing_newline: false,
      check_makefile_indentation: false
    };
    const res = validateMakefileContext(commit, patch, testConfig, state);
    assert.strictEqual(res.errors.length, 0);
  });

  // Isolate the buildbot-default check so unrelated Makefile rules cannot
  // contribute errors/warnings and skew the assertions below.
  const buildbotConfig = (level) => ({
    ...CONFIG,
    check_openwrt_meta: false,
    check_conffiles: false,
    check_crlf: false,
    check_pkg_version: false,
    check_trailing_newline: false,
    check_makefile_indentation: false,
    check_pkg_name_reuse: false,
    check_missing_colon: false,
    check_space_after_assignment: false,
    check_buildbot_default: level
  });
  const freshState = () => ({ isNewPackage: false, isDroppedPackage: false });

  test('warns on DEFAULT conditioned on BUILDBOT in a feed package (issue #4)', () => {
    const commit = { commit: { message: 'openssh: add sftp-server DEFAULT' } };
    const patch = `
diff --git a/net/openssh/Makefile b/net/openssh/Makefile
--- a/net/openssh/Makefile
+++ b/net/openssh/Makefile
@@ -80,6 +80,13 @@ define Package/openssh-server
 endef
 
+define Package/openssh-sftp-server
+  $(call Package/openssh/Default)
+  TITLE+= SFTP server
+  DEFAULT:=y if (BUILDBOT && !SMALL_FLASH)
+endef
+
 define Package/openssh-client/description
    `;
    const res = validateMakefileContext(commit, patch, buildbotConfig('warning'), freshState(), 'openwrt/packages');
    assert.strictEqual(res.errors.length, 0);
    assert.strictEqual(res.warnings.length, 1);
    assert.ok(res.warnings[0].includes("DEFAULT:=y if (BUILDBOT && !SMALL_FLASH)"));
    assert.ok(res.warnings[0].includes("inside 'Package/openssh-sftp-server'"));
  });

  test('labels the package from the hunk header when the define is outside the diff', () => {
    const commit = { commit: { message: 'owut: default on buildbot' } };
    const patch = `
diff --git a/utils/owut/Makefile b/utils/owut/Makefile
--- a/utils/owut/Makefile
+++ b/utils/owut/Makefile
@@ -20,6 +20,7 @@ define Package/owut
   SECTION:=utils
   CATEGORY:=Base system
+  DEFAULT:=y if BUILDBOT
   TITLE:=owut
    `;
    const res = validateMakefileContext(commit, patch, buildbotConfig('warning'), freshState(), 'openwrt/packages');
    assert.strictEqual(res.warnings.length, 1);
    assert.ok(res.warnings[0].includes("inside 'Package/owut'"));
  });

  test('does not attribute a DEFAULT line to a package block closed in an earlier hunk', () => {
    const commit = { commit: { message: 'foo: default on buildbot' } };
    const patch = `
diff --git a/utils/foo/Makefile b/utils/foo/Makefile
--- a/utils/foo/Makefile
+++ b/utils/foo/Makefile
@@ -20,3 +20,4 @@ define Package/foo
   TITLE:=Foo
 endef
+DEFAULT:=y if BUILDBOT
    `;
    const res = validateMakefileContext(commit, patch, buildbotConfig('warning'), freshState(), 'openwrt/packages');
    assert.strictEqual(res.warnings.length, 1);
    assert.ok(!res.warnings[0].includes('inside'));
  });

  test('closes the package block on an indented endef', () => {
    const commit = { commit: { message: 'foo: default on buildbot' } };
    const patch = `
diff --git a/utils/foo/Makefile b/utils/foo/Makefile
--- a/utils/foo/Makefile
+++ b/utils/foo/Makefile
@@ -20,3 +20,4 @@ define Package/foo
   TITLE:=Foo
   endef
+DEFAULT:=y if BUILDBOT
    `;
    const res = validateMakefileContext(commit, patch, buildbotConfig('warning'), freshState(), 'openwrt/packages');
    assert.strictEqual(res.warnings.length, 1);
    assert.ok(!res.warnings[0].includes('inside'), 'indented endef must not leave Package/foo attributed');
  });

  test('attributes a DEFAULT line under an indented define', () => {
    const commit = { commit: { message: 'foo: default on buildbot' } };
    const patch = `
diff --git a/utils/foo/Makefile b/utils/foo/Makefile
--- a/utils/foo/Makefile
+++ b/utils/foo/Makefile
@@ -20,3 +20,5 @@ context
+  define Package/foo
+  DEFAULT:=y if BUILDBOT
    `;
    const res = validateMakefileContext(commit, patch, buildbotConfig('warning'), freshState(), 'openwrt/packages');
    assert.strictEqual(res.warnings.length, 1);
    assert.ok(res.warnings[0].includes("inside 'Package/foo'"));
  });

  test('detects DEFAULT assignments spread over backslash continuation lines', () => {
    const commit = { commit: { message: 'foo: default on buildbot' } };
    const patch = `
diff --git a/utils/foo/Makefile b/utils/foo/Makefile
--- a/utils/foo/Makefile
+++ b/utils/foo/Makefile
@@ -10,3 +10,5 @@ define Package/foo
   TITLE:=Foo
+  DEFAULT:=y if \\
+    (BUILDBOT && !SMALL_FLASH)
    `;
    const res = validateMakefileContext(commit, patch, buildbotConfig('warning'), freshState(), 'openwrt/packages');
    assert.strictEqual(res.warnings.length, 1);
    assert.ok(res.warnings[0].includes('BUILDBOT'));
  });

  test('detects every Makefile assignment flavour for DEFAULT', () => {
    for (const op of [':=', '=', '?=', '+=', '::=']) {
      const commit = { commit: { message: 'foo: default on buildbot' } };
      const patch = `
diff --git a/utils/foo/Makefile b/utils/foo/Makefile
--- a/utils/foo/Makefile
+++ b/utils/foo/Makefile
@@ -10,3 +10,4 @@ define Package/foo
   TITLE:=Foo
+  DEFAULT${op}y if BUILDBOT
    `;
      const res = validateMakefileContext(commit, patch, buildbotConfig('warning'), freshState(), 'openwrt/packages');
      assert.strictEqual(res.warnings.length, 1, `operator ${op} was not detected`);
    }
  });

  test('treats check_buildbot_default: true and "error" as a hard error', () => {
    for (const level of [true, 'error']) {
      const commit = { commit: { message: 'foo: add DEFAULT' } };
      const patch = `
diff --git a/utils/foo/Makefile b/utils/foo/Makefile
--- a/utils/foo/Makefile
+++ b/utils/foo/Makefile
@@ -1,2 +1,3 @@
 define Package/foo
+  DEFAULT:=y if BUILDBOT
 endef
    `;
      const res = validateMakefileContext(commit, patch, buildbotConfig(level), freshState(), 'openwrt/packages');
      assert.strictEqual(res.warnings.length, 0);
      assert.strictEqual(res.errors.length, 1);
      assert.ok(res.errors[0].includes("DEFAULT:=y if BUILDBOT"));
    }
  });

  test('does not flag DEFAULT without a BUILDBOT condition', () => {
    const commit = { commit: { message: 'foo: add DEFAULT' } };
    const patch = `
diff --git a/utils/foo/Makefile b/utils/foo/Makefile
--- a/utils/foo/Makefile
+++ b/utils/foo/Makefile
@@ -1,2 +1,3 @@
 define Package/foo
+  DEFAULT:=y if TARGET_x86
 endef
    `;
    const res = validateMakefileContext(commit, patch, buildbotConfig('warning'), freshState(), 'openwrt/packages');
    assert.strictEqual(res.errors.length, 0);
    assert.strictEqual(res.warnings.length, 0);
    assert.ok(res.successes.some(s => s.includes("No feed package forces its own inclusion")));
  });

  test('ignores DEFAULT+BUILDBOT inside an added comment line', () => {
    const commit = { commit: { message: 'foo: document DEFAULT' } };
    const patch = `
diff --git a/utils/foo/Makefile b/utils/foo/Makefile
--- a/utils/foo/Makefile
+++ b/utils/foo/Makefile
@@ -1,2 +1,3 @@
 define Package/foo
+#  DEFAULT:=y if BUILDBOT
 endef
    `;
    const res = validateMakefileContext(commit, patch, buildbotConfig('warning'), freshState(), 'openwrt/packages');
    assert.strictEqual(res.warnings.length, 0);
  });

  test('does not flag DEFAULT+BUILDBOT in the main openwrt/openwrt repo, whatever the casing', () => {
    for (const repo of ['openwrt/openwrt', 'OpenWrt/OpenWrt']) {
      const commit = { commit: { message: 'openssh: add sftp-server DEFAULT' } };
      const patch = `
diff --git a/net/openssh/Makefile b/net/openssh/Makefile
--- a/net/openssh/Makefile
+++ b/net/openssh/Makefile
@@ -1,2 +1,3 @@
 define Package/openssh-sftp-server
+  DEFAULT:=y if (BUILDBOT && !SMALL_FLASH)
 endef
    `;
      const res = validateMakefileContext(commit, patch, buildbotConfig('warning'), freshState(), repo);
      assert.strictEqual(res.errors.length, 0);
      assert.strictEqual(res.warnings.length, 0);
      assert.ok(!res.successes.some(s => s.includes('BUILDBOT')), `Successes: ${res.successes.join(', ')}`);
    }
  });

  test('does not flag pre-existing DEFAULT+BUILDBOT lines left untouched by the diff', () => {
    const commit = { commit: { message: 'foo: unrelated tweak' } };
    const patch = `
diff --git a/utils/owut/Makefile b/utils/owut/Makefile
--- a/utils/owut/Makefile
+++ b/utils/owut/Makefile
@@ -10,7 +10,7 @@ define Package/owut
   DEFAULT:=y if (BUILDBOT && !SMALL_FLASH)
-  TITLE:=owut - an OpenWrt Upgrade Tool
+  TITLE:=owut - an OpenWrt upgrade tool
 endef
    `;
    const res = validateMakefileContext(commit, patch, buildbotConfig('warning'), freshState(), 'openwrt/packages');
    assert.strictEqual(res.errors.length, 0);
    assert.strictEqual(res.warnings.length, 0);
  });

  test('flags a BUILDBOT continuation added under a pre-existing DEFAULT line', () => {
    const commit = { commit: { message: 'foo: enable on buildbot' } };
    const patch = `
diff --git a/net/foo/Makefile b/net/foo/Makefile
--- a/net/foo/Makefile
+++ b/net/foo/Makefile
@@ -10,3 +10,4 @@ define Package/foo
   TITLE:=Foo
   DEFAULT:=y \\
+\tif BUILDBOT
   DEPENDS:=+libc
    `;
    const res = validateMakefileContext(commit, patch, buildbotConfig('warning'), freshState(), 'openwrt/packages');
    assert.strictEqual(res.warnings.length, 1, 'adding the condition to an existing DEFAULT must be caught');
    assert.ok(res.warnings[0].includes('BUILDBOT'));
    assert.ok(res.warnings[0].includes("inside 'Package/foo'"));
  });

  test('does not flag a pre-existing backslash-continued DEFAULT+BUILDBOT left untouched', () => {
    const commit = { commit: { message: 'foo: unrelated tweak' } };
    const patch = `
diff --git a/net/foo/Makefile b/net/foo/Makefile
--- a/net/foo/Makefile
+++ b/net/foo/Makefile
@@ -10,4 +10,5 @@ define Package/foo
   TITLE:=Foo
   DEFAULT:=y \\
 \tif BUILDBOT
+  URL:=https://example.org
   DEPENDS:=+libc
    `;
    const res = validateMakefileContext(commit, patch, buildbotConfig('warning'), freshState(), 'openwrt/packages');
    assert.strictEqual(res.errors.length, 0);
    assert.strictEqual(res.warnings.length, 0);
  });

  test('does not re-report an untouched DEFAULT+BUILDBOT when an unrelated clause is appended', () => {
    const commit = { commit: { message: 'foo: extend default condition' } };
    const patch = `
diff --git a/net/foo/Makefile b/net/foo/Makefile
--- a/net/foo/Makefile
+++ b/net/foo/Makefile
@@ -10,4 +10,5 @@ define Package/foo
   TITLE:=Foo
   DEFAULT:=y if BUILDBOT \\
+\t|| ALL_KMODS
   DEPENDS:=+libc
    `;
    const res = validateMakefileContext(commit, patch, buildbotConfig('warning'), freshState(), 'openwrt/packages');
    assert.strictEqual(res.errors.length, 0);
    assert.strictEqual(res.warnings.length, 0, 'BUILDBOT was already there; the diff did not introduce it');
  });

  test('flags a changed DEFAULT value line above an untouched BUILDBOT continuation', () => {
    const commit = { commit: { message: 'foo: enable by default' } };
    const patch = `
diff --git a/net/foo/Makefile b/net/foo/Makefile
--- a/net/foo/Makefile
+++ b/net/foo/Makefile
@@ -10,4 +10,4 @@ define Package/foo
   TITLE:=Foo
-  DEFAULT:=n \\
+  DEFAULT:=y \\
 \tif BUILDBOT
   DEPENDS:=+libc
    `;
    const res = validateMakefileContext(commit, patch, buildbotConfig('warning'), freshState(), 'openwrt/packages');
    assert.strictEqual(res.warnings.length, 1, 'flipping the value re-arms the BUILDBOT default');
    assert.ok(res.warnings[0].includes('BUILDBOT'));
  });

  test('attributes the package from an indented define carried as hunk context', () => {
    const commit = { commit: { message: 'foo: default on buildbot' } };
    const patch = `
diff --git a/net/foo/Makefile b/net/foo/Makefile
--- a/net/foo/Makefile
+++ b/net/foo/Makefile
@@ -10,3 +10,4 @@   define Package/foo
   TITLE:=Foo
+  DEFAULT:=y if BUILDBOT
   DEPENDS:=+libc
    `;
    const res = validateMakefileContext(commit, patch, buildbotConfig('warning'), freshState(), 'openwrt/packages');
    assert.strictEqual(res.warnings.length, 1);
    assert.ok(res.warnings[0].includes("inside 'Package/foo'"), 'indented define in the hunk header must still attribute the package');
  });

  test('stays silent when the commit touches no Makefile at all', () => {
    const commit = { commit: { message: 'docs: tweak readme' } };
    const patch = `
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1,1 +1,2 @@
 hello
+world
    `;
    const res = validateMakefileContext(commit, patch, buildbotConfig('warning'), freshState(), 'openwrt/packages');
    assert.strictEqual(res.warnings.length, 0);
    assert.ok(!res.successes.some(s => s.includes("No feed package forces its own inclusion")));
  });

  test('reports an identical DEFAULT+BUILDBOT line only once per patch', () => {
    const commit = { commit: { message: 'foo: default on buildbot' } };
    const patch = `
diff --git a/utils/foo/Makefile b/utils/foo/Makefile
--- a/utils/foo/Makefile
+++ b/utils/foo/Makefile
@@ -1,2 +1,3 @@
 define Package/foo
+  DEFAULT:=y if BUILDBOT
 endef
diff --git a/utils/bar/Makefile b/utils/bar/Makefile
--- a/utils/bar/Makefile
+++ b/utils/bar/Makefile
@@ -1,2 +1,3 @@
 define Package/foo
+  DEFAULT:=y if BUILDBOT
 endef
    `;
    const res = validateMakefileContext(commit, patch, buildbotConfig('warning'), freshState(), 'openwrt/packages');
    assert.strictEqual(res.warnings.length, 1);
  });

  test('respects check_buildbot_default: false and "disabled" configuration options', () => {
    for (const level of [false, 'disabled']) {
      const commit = { commit: { message: 'foo: add DEFAULT' } };
      const patch = `
diff --git a/utils/foo/Makefile b/utils/foo/Makefile
--- a/utils/foo/Makefile
+++ b/utils/foo/Makefile
@@ -1,2 +1,3 @@
 define Package/foo
+  DEFAULT:=y if BUILDBOT
 endef
    `;
      const res = validateMakefileContext(commit, patch, buildbotConfig(level), freshState(), 'openwrt/packages');
      assert.strictEqual(res.errors.length, 0);
      assert.strictEqual(res.warnings.length, 0);
      assert.ok(!res.successes.some(s => s.includes('BUILDBOT')), `Successes: ${res.successes.join(', ')}`);
    }
  });

  test('rejects reuse of PKG_NAME in call, define, and eval lines', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git b/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+define Package/$(PKG_NAME)
+$(eval $(call BuildPackage,$(PKG_NAME)))
+define Package/\${PKG_NAME}/description
+\$(call BuildPackage,\${PKG_NAME})
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.strictEqual(res.errors.length, 4);
    assert.ok(res.errors[0].includes("reuses PKG_NAME in a call, define, or eval"));
    assert.ok(res.errors[1].includes("reuses PKG_NAME in a call, define, or eval"));
    assert.ok(res.errors[2].includes("reuses PKG_NAME in a call, define, or eval"));
    assert.ok(res.errors[3].includes("reuses PKG_NAME in a call, define, or eval"));
  });

  test('accepts literal package name in call, define, and eval lines', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git b/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+define Package/foo
+\$(eval \$(call BuildPackage,foo))
+define Package/foo/description
+\$(call BuildPackage,foo)
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const testConfig = {
      ...CONFIG,
      check_openwrt_meta: false,
      check_conffiles: false,
      check_crlf: false,
      check_pkg_version: false,
      check_trailing_newline: false
    };
    const resClean = validateMakefileContext(commit, patch, testConfig, state);
    assert.strictEqual(resClean.errors.length, 0);
    assert.ok(resClean.successes.some(s => s.includes("does not reuse PKG_NAME in call, define, or eval")));
  });

  test('allows PKG_NAME outside of call, define, and eval lines', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git b/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+PKG_BUILD_DIR:=\$(BUILD_DIR)/\$(PKG_NAME)-\$(PKG_VERSION)
+PKG_SOURCE_URL:=https://github.com/foo/\$(PKG_NAME)
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const testConfig = {
      ...CONFIG,
      check_openwrt_meta: false,
      check_conffiles: false,
      check_crlf: false,
      check_pkg_version: false,
      check_trailing_newline: false
    };
    const res = validateMakefileContext(commit, patch, testConfig, state);
    assert.strictEqual(res.errors.length, 0);
  });

  test('ignores comments containing PKG_NAME inside eval/call/define patterns', () => {
    const commit = { commit: { message: 'foo: test' } };
    const patch = `
diff --git b/package/utils/foo/Makefile b/package/utils/foo/Makefile
--- a/package/utils/foo/Makefile
+++ b/package/utils/foo/Makefile
+# \$(eval \$(call BuildPackage,\$(PKG_NAME)))
+# define Package/\$(PKG_NAME)
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const testConfig = {
      ...CONFIG,
      check_openwrt_meta: false,
      check_conffiles: false,
      check_crlf: false,
      check_pkg_version: false,
      check_trailing_newline: false
    };
    const res = validateMakefileContext(commit, patch, testConfig, state);
    assert.strictEqual(res.errors.length, 0);
  });

});

describe('validateMakefileContext dead package variables', () => {
  const DEAD_CONFIG = CONFIG;
  const state = () => ({ isNewPackage: false, isDroppedPackage: false });

  test('flags top-level PROVIDES in a LuCI Makefile and suggests PKG_PROVIDES', () => {
    const commit = { commit: { message: 'luci-app-qosify: provide luci-app-qos' } };
    const patch = `
diff --git a/applications/luci-app-qosify/Makefile b/applications/luci-app-qosify/Makefile
--- a/applications/luci-app-qosify/Makefile
+++ b/applications/luci-app-qosify/Makefile
@@ -7,6 +7,7 @@
 LUCI_TITLE:=LuCI interface for qosify
 LUCI_DEPENDS:=+qosify
 LUCI_PKGARCH:=all
+PROVIDES:=luci-app-qos
    `;
    const res = validateMakefileContext(commit, patch, DEAD_CONFIG, state());
    assert.ok(res.errors.some(e => e.includes("Use 'PKG_PROVIDES:=luci-app-qos'")), `Errors: ${res.errors.join(', ')}`);
  });

  test('flags top-level MAINTAINER in a regular package and suggests PKG_MAINTAINER', () => {
    const commit = { commit: { message: 'mypkg: fix maintainer' } };
    const patch = `
--- a/package/utils/mypkg/Makefile
+++ b/package/utils/mypkg/Makefile
+MAINTAINER:=Jane Doe <jane@doe.com>
    `;
    const res = validateMakefileContext(commit, patch, DEAD_CONFIG, state());
    assert.ok(res.errors.some(e => e.includes("Use 'PKG_MAINTAINER:=Jane Doe <jane@doe.com>'")), `Errors: ${res.errors.join(', ')}`);
  });

  test('flags top-level DEPENDS in a regular package and points to the Package block', () => {
    const commit = { commit: { message: 'mypkg: add dependency' } };
    const patch = `
--- a/package/utils/mypkg/Makefile
+++ b/package/utils/mypkg/Makefile
+DEPENDS:=+libfoo
    `;
    const res = validateMakefileContext(commit, patch, DEAD_CONFIG, state());
    assert.ok(res.errors.some(e => e.includes("Move 'DEPENDS:=+libfoo' into the 'define Package/<name>' block")), `Errors: ${res.errors.join(', ')}`);
  });

  test('does not flag variables inside a define block', () => {
    const commit = { commit: { message: 'mypkg: add package definition' } };
    const patch = `
--- a/package/utils/mypkg/Makefile
+++ b/package/utils/mypkg/Makefile
@@ -10,0 +11,6 @@
+define Package/mypkg
+  SECTION:=utils
+  CATEGORY:=Utilities
+TITLE:=Unindented but still inside the block
+  DEPENDS:=+libbar
+endef
    `;
    const res = validateMakefileContext(commit, patch, DEAD_CONFIG, state());
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
  });

  test('derives define state from the hunk header context', () => {
    const commit = { commit: { message: 'mypkg: extend package definition' } };
    const patch = `
--- a/package/utils/mypkg/Makefile
+++ b/package/utils/mypkg/Makefile
@@ -12,3 +12,4 @@ define Package/mypkg
   SECTION:=utils
   CATEGORY:=Utilities
+DEPENDS:=+libbar
    `;
    const res = validateMakefileContext(commit, patch, DEAD_CONFIG, state());
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
  });

  test('suppresses the missing-colon suggestion for a dead assignment', () => {
    const commit = { commit: { message: 'mypkg: provide virtual package' } };
    const patch = `
--- a/package/utils/mypkg/Makefile
+++ b/package/utils/mypkg/Makefile
+PROVIDES=mypkg-virtual
    `;
    const config = { ...DEAD_CONFIG, check_missing_colon: true, check_space_after_assignment: true };
    const res = validateMakefileContext(commit, patch, config, state());
    assert.ok(res.errors.some(e => e.includes('no effect') || e.includes("'define Package/<name>' block")), `Errors: ${res.errors.join(', ')}`);
    assert.ok(!res.errors.some(e => e.includes("uses '=' instead of ':='")), `Errors: ${res.errors.join(', ')}`);
  });

  test('skips build infrastructure Makefiles', () => {
    const commit = { commit: { message: 'ti-k3: add target' } };
    const patch = `
--- a/target/linux/ti-k3/Makefile
+++ b/target/linux/ti-k3/Makefile
+MAINTAINER:=Jane Doe <jane@doe.com>
    `;
    const res = validateMakefileContext(commit, patch, DEAD_CONFIG, state());
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
  });

  test('reports success when a package Makefile stays clean', () => {
    const commit = { commit: { message: 'mypkg: update to 1.2' } };
    const patch = `
--- a/package/utils/mypkg/Makefile
+++ b/package/utils/mypkg/Makefile
+PKG_VERSION:=1.2
    `;
    const res = validateMakefileContext(commit, patch, { ...DEAD_CONFIG, check_pkg_version: false }, state());
    assert.ok(res.successes.some(s => s.includes('per-package variables')), `Successes: ${res.successes.join(', ')}`);
  });
});

describe('isPackageMakefilePath', () => {
  test('accepts package and feed Makefiles', () => {
    assert.strictEqual(isPackageMakefilePath('package/utils/bash/Makefile'), true);
    assert.strictEqual(isPackageMakefilePath('package/lang/python/python3/Makefile'), true);
    assert.strictEqual(isPackageMakefilePath('net/mosdns/Makefile'), true);
    assert.strictEqual(isPackageMakefilePath('./package/utils/bash/Makefile'), true);
  });

  test('rejects build infrastructure Makefiles', () => {
    assert.strictEqual(isPackageMakefilePath('target/linux/ti-k3/Makefile'), false);
    assert.strictEqual(isPackageMakefilePath('target/linux/ti-k3/image/Makefile'), false);
    assert.strictEqual(isPackageMakefilePath('tools/newtool/Makefile'), false);
    assert.strictEqual(isPackageMakefilePath('toolchain/gcc/Makefile'), false);
    assert.strictEqual(isPackageMakefilePath('Makefile'), false);
  });

  test('rejects non-Makefile paths', () => {
    assert.strictEqual(isPackageMakefilePath('package/utils/bash/Makefile.in'), false);
    assert.strictEqual(isPackageMakefilePath('include/package.mk'), false);
    assert.strictEqual(isPackageMakefilePath(''), false);
    assert.strictEqual(isPackageMakefilePath(null), false);
  });
});

describe('PKG_MAINTAINER parsing', () => {
  test('answers promptly on a maintainer line full of angle brackets', async () => {
    // 80 000 of them cost the old pattern about 5.5 seconds, from one added
    // Makefile line - well inside what a pull request can carry.
    const patch = [
      'diff --git a/utils/mypkg/Makefile b/utils/mypkg/Makefile',
      '--- a/utils/mypkg/Makefile',
      '+++ b/utils/mypkg/Makefile',
      '@@ -1,2 +1,3 @@',
      ' PKG_NAME:=mypkg',
      '+PKG_MAINTAINER:=' + '<'.repeat(80000),
      ' PKG_LICENSE:=MIT'
    ].join('\n');
    const commit = { commit: { message: 'mypkg: set maintainer' } };
    const started = process.hrtime.bigint();
    const res = validateMakefileContext(commit, patch, { ...CONFIG, check_openwrt_meta: true }, { isNewPackage: false, isDroppedPackage: false }, 'openwrt/openwrt');
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 2500, `parsing took ${ms.toFixed(0)} ms, which no invocation can afford`);
    assert.ok(res.errors.some(e => e.includes('PKG_MAINTAINER')), `the malformed value is still reported: ${res.errors.join(', ')}`);
  });

  test('still reads the addresses out of a real maintainer line', () => {
    const patch = [
      'diff --git a/utils/mypkg/Makefile b/utils/mypkg/Makefile',
      '--- a/utils/mypkg/Makefile',
      '+++ b/utils/mypkg/Makefile',
      '@@ -1,2 +1,3 @@',
      ' PKG_NAME:=mypkg',
      '+PKG_MAINTAINER:=Jane Doe <jane@doe.com>, Bob <bob@example.org>',
      ' PKG_LICENSE:=MIT'
    ].join('\n');
    const commit = { commit: { message: 'mypkg: set maintainer' } };
    const res = validateMakefileContext(commit, patch, { ...CONFIG, check_openwrt_meta: true }, { isNewPackage: false, isDroppedPackage: false }, 'openwrt/openwrt');
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
  });
});

describe('Makefile metadata indentation', () => {
  const state = () => ({ isNewPackage: true, isDroppedPackage: false });
  const commit = { commit: { message: 'mypkg: add package' } };
  const asNewMakefile = (body) => [
    'diff --git a/utils/mypkg/Makefile b/utils/mypkg/Makefile',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/utils/mypkg/Makefile',
    '@@ -0,0 +1,9 @@',
    ...body.split('\n').map(l => '+' + l)
  ].join('\n');

  test('accepts the inheritance idiom at any indentation', () => {
    // openwrt/openwrt writes it at column 0 more often than not - see
    // package/devel/gdb and package/kernel/mwlwifi - and the packages feed
    // uses all three forms, so there is no convention to enforce.
    for (const call of ['$(call Package/mypkg/Default)', '  $(call Package/mypkg/Default)', '\t$(call Package/mypkg/Default)']) {
      const patch = asNewMakefile(`define Package/mypkg\n${call}\n  TITLE:=My package\nendef`);
      const res = validateMakefileContext(commit, patch, { ...CONFIG, check_makefile_indentation: true }, state(), 'openwrt/openwrt');
      assert.ok(!res.errors.some(e => e.includes('must be indented with exactly 2 spaces')),
        `${JSON.stringify(call)} -> ${res.errors.join(', ')}`);
    }
  });

  test('still asks for two spaces on an ordinary metadata line', () => {
    const patch = asNewMakefile('define Package/mypkg\n\tTITLE:=My package\nendef');
    const res = validateMakefileContext(commit, patch, { ...CONFIG, check_makefile_indentation: true }, state(), 'openwrt/openwrt');
    assert.ok(res.errors.some(e => e.includes("'TITLE:=My package'") && e.includes('exactly 2 spaces')),
      `Errors: ${res.errors.join(', ')}`);
  });
});

describe('validateMakefileContext init scripts', () => {
  const INIT_CONFIG = { ...CONFIG, check_init_scripts: true };
  const state = () => ({ isNewPackage: false, isDroppedPackage: false });
  const commit = { commit: { message: 'mypkg: add init script' } };
  const newInitPatch = (lines) => `
diff --git a/package/utils/mypkg/files/mypkg.init b/package/utils/mypkg/files/mypkg.init
--- /dev/null
+++ b/package/utils/mypkg/files/mypkg.init
@@ -0,0 +1,${lines.length} @@
${lines.map(l => '+' + l).join('\n')}
    `;

  test('warns when a new init script lacks the rc.common interpreter', () => {
    const patch = newInitPatch(['#!/bin/sh', 'START=95', 'start() { true; }']);
    const res = validateMakefileContext(commit, patch, INIT_CONFIG, state());
    assert.ok(res.warnings.some(w => w.includes("does not start with '#!/bin/sh /etc/rc.common'")), `Warnings: ${res.warnings.join(', ')}`);
  });

  test('warns when a new init script has no START= priority', () => {
    const patch = newInitPatch(['#!/bin/sh /etc/rc.common', 'start() { true; }']);
    const res = validateMakefileContext(commit, patch, INIT_CONFIG, state());
    assert.ok(res.warnings.some(w => w.includes("defines no 'START=' priority")), `Warnings: ${res.warnings.join(', ')}`);
  });

  test('accepts a proper rc.common init script', () => {
    const patch = newInitPatch(['#!/bin/sh /etc/rc.common', '', 'START=95', 'STOP=10', 'USE_PROCD=1', 'start_service() { true; }']);
    const res = validateMakefileContext(commit, patch, INIT_CONFIG, state());
    assert.strictEqual(res.warnings.length, 0, `Unexpected warnings: ${res.warnings.join(', ')}`);
    assert.ok(res.successes.some(s => s.includes('rc.common interpreter')), `Successes: ${res.successes.join(', ')}`);
  });

  test('ignores patches, templates and docs under init.d paths', () => {
    const patch = `
diff --git a/package/utils/mypkg/files/etc/init.d/README.txt b/package/utils/mypkg/files/etc/init.d/README.txt
--- /dev/null
+++ b/package/utils/mypkg/files/etc/init.d/README.txt
+How the init scripts here are organized.
diff --git a/package/utils/mypkg/patches/001-etc-init.d-fix.patch b/package/utils/mypkg/patches/001-etc-init.d-fix.patch
--- /dev/null
+++ b/package/utils/mypkg/patches/001-etc-init.d-fix.patch
+--- a/etc/init.d/foo
++++ b/etc/init.d/foo
+@@ -1 +1 @@
+-old
++new
    `;
    const res = validateMakefileContext(commit, patch, INIT_CONFIG, state());
    assert.strictEqual(res.warnings.length, 0, `Unexpected warnings: ${res.warnings.join(', ')}`);
  });

  test('ignores edits to existing init scripts', () => {
    const patch = `
diff --git a/package/utils/mypkg/files/mypkg.init b/package/utils/mypkg/files/mypkg.init
--- a/package/utils/mypkg/files/mypkg.init
+++ b/package/utils/mypkg/files/mypkg.init
+reload_service() { true; }
    `;
    const res = validateMakefileContext(commit, patch, INIT_CONFIG, state());
    assert.strictEqual(res.warnings.length, 0, `Unexpected warnings: ${res.warnings.join(', ')}`);
  });

  test('does nothing when disabled', () => {
    const patch = newInitPatch(['#!/bin/sh', 'start() { true; }']);
    const res = validateMakefileContext(commit, patch, { ...CONFIG, check_init_scripts: false }, state());
    assert.strictEqual(res.warnings.length, 0, `Unexpected warnings: ${res.warnings.join(', ')}`);
  });
});

describe('LuCI package handling', () => {
  const luciMakefile = 'include $(TOPDIR)/rules.mk\n\nPKG_LICENSE:=Apache-2.0\n\nLUCI_TITLE:=LuCI interface for qosify\nLUCI_DEPENDS:=+qosify\n\ninclude ../../luci.mk\n';

  test('findPkgRoot resolves a LuCI application from its root/ payload', async () => {
    const fetchFn = async (path) => {
      if (path === 'applications/luci-app-qosify/Makefile') return luciMakefile;
      return null;
    };
    assert.strictEqual(
      await findPkgRoot('applications/luci-app-qosify/root/etc/config/qosify', fetchFn, {}),
      'applications/luci-app-qosify'
    );
  });

  test('findPkgRoot resolves a LuCI application from an htdocs file', async () => {
    const fetchFn = async (path) => {
      if (path === 'applications/luci-app-qosify/Makefile') return luciMakefile;
      return null;
    };
    assert.strictEqual(
      await findPkgRoot('applications/luci-app-qosify/htdocs/luci-static/resources/view/qosify.js', fetchFn, {}),
      'applications/luci-app-qosify'
    );
  });

  test('new LuCI packages only need PKG_LICENSE, not maintainer or license files', () => {
    const commit = { commit: { message: 'luci-app-qosify: add new application' } };
    const patch = `
diff --git a/applications/luci-app-qosify/Makefile b/applications/luci-app-qosify/Makefile
--- /dev/null
+++ b/applications/luci-app-qosify/Makefile
@@ -0,0 +1,8 @@
+include $(TOPDIR)/rules.mk
+
+PKG_LICENSE:=Apache-2.0
+
+LUCI_TITLE:=LuCI interface for qosify
+LUCI_DEPENDS:=+qosify
+
+include ../../luci.mk
    `;
    const state = { isNewPackage: false, isDroppedPackage: false };
    const res = validateMakefileContext(commit, patch, CONFIG, state);
    assert.ok(!res.errors.some(e => e.includes('PKG_MAINTAINER')), `Errors: ${res.errors.join(', ')}`);
    assert.ok(!res.errors.some(e => e.includes('PKG_LICENSE_FILES')), `Errors: ${res.errors.join(', ')}`);
    assert.ok(res.successes.some(s => s.includes("'PKG_LICENSE'")), `Successes: ${res.successes.join(', ')}`);
  });

  test('release audit exempts LuCI packages changed without a PKG_RELEASE', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/applications/luci-app-qosify/htdocs/luci-static/resources/view/qosify.js b/applications/luci-app-qosify/htdocs/luci-static/resources/view/qosify.js
+++ b/applications/luci-app-qosify/htdocs/luci-static/resources/view/qosify.js
+return view.extend({});
`
    }];
    const headFetch = async (path) => {
      if (path === 'applications/luci-app-qosify/Makefile') return luciMakefile;
      return null;
    };
    const res = await validatePkgReleaseBumps(commitDetails, { check_pkg_release: 'error' }, headFetch, async () => null);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
    assert.ok(res.successes.some(s => s.includes('skipping release bump requirement')), `Successes: ${res.successes.join(', ')}`);
  });

  test('does not ask for a bump from a package that has nothing to bump', async () => {
    // package/kernel/linux is the kernel itself: PKG_NAME, PKG_FLAGS and
    // nothing else. There is no PKG_RELEASE and no version to move, so the
    // advice "increment PKG_RELEASE or bump the version" cannot be followed.
    const kernelMakefile = 'include $(TOPDIR)/rules.mk\ninclude $(INCLUDE_DIR)/kernel.mk\n\nPKG_NAME:=kernel\nPKG_FLAGS:=hold\n\ninclude $(INCLUDE_DIR)/package.mk\n';
    const commitDetails = [{
      commitPatch: `
diff --git a/package/kernel/linux/modules/video.mk b/package/kernel/linux/modules/video.mk
--- a/package/kernel/linux/modules/video.mk
+++ b/package/kernel/linux/modules/video.mk
+define KernelPackage/drm-something
`
    }];
    const headFetch = async (path) => path === 'package/kernel/linux/Makefile' ? kernelMakefile : null;
    const res = await validatePkgReleaseBumps(commitDetails, { check_pkg_release: 'error' }, headFetch, async () => null);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
    assert.ok(res.successes.some(s => s.includes('skipping release bump requirement')), `Successes: ${res.successes.join(', ')}`);
  });

  test('treats a version computed from something else as nothing to bump', async () => {
    // package/kernel/bpf-headers takes its PKG_VERSION from the kernel's, so
    // moving it is not something a contributor does either.
    const derivedMakefile = 'include $(INCLUDE_DIR)/kernel.mk\n\nPKG_NAME:=linux\nPKG_VERSION:=$(PKG_PATCHVER)$(strip $(LINUX_VERSION-$(PKG_PATCHVER)))\n';
    const commitDetails = [{
      commitPatch: `
diff --git a/package/kernel/bpf-headers/files/something.h b/package/kernel/bpf-headers/files/something.h
--- a/package/kernel/bpf-headers/files/something.h
+++ b/package/kernel/bpf-headers/files/something.h
+#define X 1
`
    }];
    const headFetch = async (path) => path === 'package/kernel/bpf-headers/Makefile' ? derivedMakefile : null;
    const res = await validatePkgReleaseBumps(commitDetails, { check_pkg_release: 'error' }, headFetch, async () => null);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
  });

  test('still asks a package whose source revision can be moved', async () => {
    // package/kernel/nat46 has no PKG_RELEASE either, but its PKG_SOURCE_DATE
    // and PKG_SOURCE_VERSION are literals a contributor can and should move.
    const nat46Makefile = 'include $(INCLUDE_DIR)/kernel.mk\n\nPKG_NAME:=nat46\nPKG_SOURCE_DATE:=2022-09-19\nPKG_SOURCE_VERSION:=4c5beee236841724219598fabb1edc93d4f08ce5\n';
    const commitDetails = [{
      commitPatch: `
diff --git a/package/kernel/nat46/patches/001-fix.patch b/package/kernel/nat46/patches/001-fix.patch
--- a/package/kernel/nat46/patches/001-fix.patch
+++ b/package/kernel/nat46/patches/001-fix.patch
+changed
`
    }];
    const headFetch = async (path) => path === 'package/kernel/nat46/Makefile' ? nat46Makefile : null;
    const res = await validatePkgReleaseBumps(commitDetails, { check_pkg_release: 'error' }, headFetch, async () => null);
    assert.ok(res.errors.some(e => e.includes('without a PKG_RELEASE or version bump')), `Errors: ${res.errors.join(', ')}`);
  });

  test('release audit accepts a new LuCI package without PKG_RELEASE', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/applications/luci-app-qosify/Makefile b/applications/luci-app-qosify/Makefile
--- /dev/null
+++ b/applications/luci-app-qosify/Makefile
+include ../../luci.mk
`
    }];
    const headFetch = async (path) => {
      if (path === 'applications/luci-app-qosify/Makefile') return luciMakefile;
      return null;
    };
    const res = await validatePkgReleaseBumps(commitDetails, { check_pkg_release: 'error' }, headFetch, async () => null);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
    assert.ok(res.successes.some(s => s.includes('no PKG_RELEASE to initialize')), `Successes: ${res.successes.join(', ')}`);
  });
});
