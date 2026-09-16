import { describe, test } from 'node:test';
import assert from 'node:assert';
import { validateMakefileContext, validatePkgReleaseBumps, findPkgRoot, isPackageMakefilePath } from '../../src/validators.js';
import {
  CONFIG, makeCommit, existingPackage, newPackage, diff, modified, added, removed, gitModified, gitAdded,
  assertSomeIncludes, assertNoneIncludes, assertNoErrors, assertErrorIncludes, assertNoErrorIncludes
} from './helpers.js';

// One commit through validateMakefileContext, in a pull request that has not
// added or dropped a package so far. Pass `state` to read back what it records.
const validate = (message, patch, { config = CONFIG, state = existingPackage(), repo } = {}) =>
  validateMakefileContext(makeCommit(message), patch, config, state, repo);

// CONFIG without the checks nearly any Makefile diff trips - metadata,
// conffiles, CRLF, version subject and trailing newline - so they cannot drown
// out the check a test is about.
const focused = (checks = {}) => ({
  ...CONFIG,
  check_openwrt_meta: false,
  check_conffiles: false,
  check_crlf: false,
  check_pkg_version: false,
  check_trailing_newline: false,
  ...checks
});

// Exactly these errors, in this order, each containing every text given for it.
const assertErrorsInOrder = (res, expected) => {
  assert.strictEqual(res.errors.length, expected.length, `Errors: ${res.errors.join(', ')}`);
  expected.forEach((texts, i) => {
    for (const text of [texts].flat()) {
      assert.ok(res.errors[i].includes(text), `error ${i} does not contain ${JSON.stringify(text)}: ${res.errors[i]}`);
    }
  });
};

describe('validateMakefileContext', () => {
  const BASH = 'package/utils/bash/Makefile';
  const FOO = 'package/utils/foo/Makefile';

  // An existing Makefile moved to a new PKG_VERSION.
  const bump = (makefile, version) => diff(modified(makefile), `+PKG_VERSION:=${version}`);

  for (const { title, message, makefile, version, note } of [
    {
      title: 'accepts version bump matching commit subject',
      message: 'bash: update to 5.3', makefile: BASH, version: '5.3'
    },
    {
      title: 'accepts version bump with leading zero difference (subject has zero, Makefile does not)',
      message: 'mypkg: update to 2026.07.04', makefile: 'package/utils/mypkg/Makefile', version: '2026.7.4'
    },
    {
      title: 'accepts version bump with leading zero difference (Makefile has zero, subject does not)',
      message: 'mypkg: update to 2026.7.4', makefile: 'package/utils/mypkg/Makefile', version: '2026.07.04'
    },
    {
      title: 'skips subject validation for a revert restoring the previous PKG_VERSION',
      message: 'sing-box: Revert "sing-box: update to 1.12.3"\n\nThis reverts commit 9fceb02d0ae598e95dc970b74767f19372d61af8.',
      makefile: 'package/net/sing-box/Makefile', version: '1.12.2', note: 'Commit reverts a previous change'
    },
    {
      title: 'skips subject validation for dynamic/templated PKG_VERSION',
      message: 'apk: update to 2.14.0', makefile: 'package/utils/apk/Makefile', version: '$(subst -,.,$(PKG_SOURCE_VERSION))'
    },
    {
      title: 'skips version subject validation for autosquash commits',
      message: 'fixup! bash: fix build on musl', makefile: BASH, version: '5.3', note: 'Autosquash commit'
    },
  ]) {
    test(title, () => {
      const res = validate(message, bump(makefile, version));
      assertNoErrors(res);
      if (note) assertSomeIncludes(res.successes, note, 'successes');
    });
  }

  for (const { title, message, makefile, version, config } of [
    {
      title: 'catches version mismatch with commit subject',
      message: 'bash: update to 5.3', makefile: BASH, version: '5.4'
    },
    {
      title: 'catches version mismatch on a revert when allow_revert is disabled',
      message: 'sing-box: Revert "sing-box: update to 1.12.3"', makefile: 'package/net/sing-box/Makefile', version: '1.12.2',
      config: { ...CONFIG, allow_revert: false }
    },
    {
      title: 'catches version mismatch on a revert that does not reference the reverted commit',
      message: 'sing-box: Revert "sing-box: update to 1.12.3"\n\nIt broke the build.', makefile: 'package/net/sing-box/Makefile', version: '1.12.2'
    },
  ]) {
    test(title, () => {
      assertErrorIncludes(validate(message, bump(makefile, version), { config }), 'PKG_VERSION');
    });
  }

  test('validates every Makefile version bump in a commit, not just the first', () => {
    const res = validate('bash: update to 5.3', diff(
      gitModified(BASH), '+PKG_VERSION:=5.3',
      gitModified('package/utils/sed/Makefile'), '+PKG_VERSION:=4.9'
    ));
    assertErrorIncludes(res, "'4.9'");
    assertSomeIncludes(res.successes, '(5.3)', 'successes');
  });

  test('still validates a version bump when the same commit adds a new package', () => {
    const state = existingPackage();
    const res = validate('newpkg: add package', diff(
      gitAdded('package/utils/newpkg/Makefile'),
      '+PKG_NAME:=newpkg',
      '+PKG_VERSION:=1.0',
      '+PKG_RELEASE:=1',
      '+PKG_MAINTAINER:=Jane Doe <jane@doe.com>',
      '+PKG_LICENSE:=MIT',
      '+PKG_LICENSE_FILES:=LICENSE',
      gitModified(BASH), '+PKG_VERSION:=5.3'
    ), { state });
    assert.strictEqual(state.isNewPackage, true);
    assertErrorIncludes(res, "'5.3'");
    assertNoErrorIncludes(res, "'1.0'");
  });

  test('requires metadata fields for new packages', () => {
    const state = existingPackage();
    const res = validate('newpkg: add package', diff(
      added('package/newpkg/Makefile'),
      '@@ -0,0 +1,10 @@',
      '+PKG_NAME:=newpkg',
      '+PKG_VERSION:=1.0',
      '+PKG_RELEASE:=1'
    ), { state });
    assert.strictEqual(state.isNewPackage, true);
    for (const field of ['PKG_MAINTAINER', 'PKG_LICENSE', 'PKG_LICENSE_FILES']) assertErrorIncludes(res, field);
    // PKG_VERSION is not checked for a new package.
    assertNoErrorIncludes(res, 'PKG_VERSION');
  });

  test('does not require package metadata for a new build target Makefile', () => {
    const target = 'target/linux/ti-k3/Makefile';
    const state = existingPackage();
    const res = validate('ti-k3: add new target for BeaglePlay', diff(
      `diff --git a/${target} b/${target}`,
      'new file mode 100644',
      added(target),
      '@@ -0,0 +1,12 @@',
      '+#',
      '+# Copyright (C) 2025 OpenWrt.org',
      '+#',
      '+include $(TOPDIR)/rules.mk',
      '+',
      '+ARCH:=aarch64',
      '+BOARD:=ti-k3',
      '+BOARDNAME:=Texas Instruments K3',
      '+FEATURES:=ext4 squashfs fpu usb gpio rtc pci',
      '+KERNEL_PATCHVER:=6.12',
      '+',
      '+include $(TOPDIR)/target/linux/Makefile'
    ), { state });
    assert.strictEqual(state.isNewPackage, false, 'a target definition is not a new package');
    for (const field of ['PKG_MAINTAINER', 'PKG_LICENSE', 'PKG_LICENSE_FILES']) assertNoErrorIncludes(res, field);
  });

  test('does not require package metadata for a new host tool Makefile', () => {
    const state = existingPackage();
    const res = validate('tools/newtool: add host build helper', diff(
      added('tools/newtool/Makefile'),
      '@@ -0,0 +1,5 @@',
      '+PKG_NAME:=newtool',
      '+PKG_VERSION:=1.0'
    ), { state });
    assert.strictEqual(state.isNewPackage, false);
    assertNoErrorIncludes(res, 'mandatory parameter');
  });

  test('still requires package metadata when a target commit also adds a package', () => {
    const state = existingPackage();
    const res = validate('ti-k3: add new target for BeaglePlay', diff(
      gitAdded('target/linux/ti-k3/Makefile'),
      '@@ -0,0 +1,3 @@',
      '+BOARD:=ti-k3',
      '+BOARDNAME:=Texas Instruments K3',
      gitAdded('package/boot/uboot-ti-k3/Makefile'),
      '@@ -0,0 +1,3 @@',
      '+PKG_NAME:=uboot-ti-k3',
      '+PKG_VERSION:=2025.01'
    ), { state });
    assert.strictEqual(state.isNewPackage, true);
    assertErrorIncludes(res, 'PKG_MAINTAINER');
  });

  test('does not flag a removed target Makefile as a dropped package', () => {
    const state = existingPackage();
    validate('ti-k3: drop target', diff(removed('target/linux/ti-k3/Makefile'), '@@ -1,3 +0,0 @@', '-BOARD:=ti-k3'), { state });
    assert.strictEqual(state.isDroppedPackage, false);
  });

  test('flags a removed package Makefile as a dropped package', () => {
    const state = existingPackage();
    validate('oldpkg: drop package', diff(removed('package/utils/oldpkg/Makefile'), '@@ -1,3 +0,0 @@', '-PKG_NAME:=oldpkg'), { state });
    assert.strictEqual(state.isDroppedPackage, true);
  });

  // The next four patches close on a line diff() does not write (five spaces
  // here, '+    ' below), so they stay the literals they were written as.
  test('supports custom metadata fields in check_openwrt_meta', () => {
    const state = existingPackage();
    const res = validate('newpkg: add package', `
--- /dev/null
+++ b/package/newpkg/Makefile
@@ -0,0 +1,10 @@
+PKG_NAME:=newpkg
+PKG_VERSION:=1.0
+PKG_RELEASE:=1
+PKG_MAINTAINER:=John Doe <john@doe.com>
     `, { config: { ...CONFIG, check_openwrt_meta: ['PKG_MAINTAINER', 'PKG_LICENSE'] }, state });
    assert.strictEqual(state.isNewPackage, true);
    // PKG_LICENSE is in the custom list but missing
    assertErrorIncludes(res, 'PKG_LICENSE');
    // PKG_LICENSE_FILES is not in the custom list
    assertNoErrorIncludes(res, 'PKG_LICENSE_FILES');
  });

  test('skips PKG_LICENSE/PKG_LICENSE_FILES when package includes trusted-firmware-a.mk', () => {
    const state = existingPackage();
    const res = validate('packages/boot: add arm-trusted-firmware-airoha', `
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
+    `, { state });
    assert.strictEqual(state.isNewPackage, true);
    // trusted-firmware-a.mk defines both, so neither is required here
    assertNoErrorIncludes(res, 'PKG_LICENSE');
    assertNoErrorIncludes(res, 'PKG_LICENSE_FILES');
    // PKG_MAINTAINER is still required, and this Makefile sets it
    assertNoErrorIncludes(res, 'PKG_MAINTAINER');
  });

  test('skips PKG_LICENSE/PKG_LICENSE_FILES when package includes u-boot.mk', () => {
    const state = existingPackage();
    const res = validate('uboot: add new board support', `
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
+    `, { state });
    assert.strictEqual(state.isNewPackage, true);
    // u-boot.mk defines both, so neither is required here
    assertNoErrorIncludes(res, 'PKG_LICENSE');
    assertNoErrorIncludes(res, 'PKG_LICENSE_FILES');
    // PKG_MAINTAINER is still required, and this Makefile sets it
    assertNoErrorIncludes(res, 'PKG_MAINTAINER');
  });

  test('still requires PKG_LICENSE/PKG_LICENSE_FILES when no known license include is present', () => {
    const state = existingPackage();
    const res = validate('newpkg: add package', `
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
+    `, { state });
    assert.strictEqual(state.isNewPackage, true);
    assertErrorIncludes(res, 'PKG_LICENSE');
    assertErrorIncludes(res, 'PKG_LICENSE_FILES');
  });

  test('detects CRLF line endings', () => {
    assertErrorIncludes(validate('bash: test', diff(modified(BASH), '+PKG_VERSION:=5.3\r')), 'CRLF');
  });

  test('does not enforce openwrt metadata on subsequent commits even if state.isNewPackage is true', () => {
    const state = existingPackage();
    validate('newpkg: add package', diff(added('package/newpkg/Makefile'), '+PKG_NAME:=newpkg'), { state });
    assert.strictEqual(state.isNewPackage, true);

    // A later commit of the same pull request is not asked for PKG_MAINTAINER and the rest.
    const res = validate('newpkg: update version to 1.0.0', diff(modified('package/newpkg/Makefile'), '+PKG_VERSION:=1.0.0'), { state });
    assertNoErrors(res);
  });

  for (const { title, maintainer, error } of [
    {
      title: 'accepts PKG_MAINTAINER with valid email format',
      maintainer: 'Jane Doe <jane.doe@example.com>'
    },
    {
      title: 'accepts multiple PKG_MAINTAINER names and emails',
      maintainer: 'Jane Doe <jane.doe@example.com>, John Doe <john.doe@example.com>'
    },
    {
      title: 'rejects PKG_MAINTAINER with URL/website inside angle brackets',
      maintainer: 'Jane Doe <https://example.com/janedoe>',
      error: 'must be a valid email address and not a website/URL'
    },
    {
      title: 'rejects PKG_MAINTAINER without angle brackets / email',
      maintainer: 'Jane Doe',
      error: "should contain an email address inside angle brackets '<>'"
    },
  ]) {
    test(title, () => {
      const res = validate('bash: test', diff(modified(BASH), `+PKG_MAINTAINER:=${maintainer}`));
      if (error) assertErrorIncludes(res, error);
      else assertNoErrors(res);
    });
  }

  const withoutNewline = diff(gitAdded(FOO), '@@ -0,0 +1,1 @@', '+PKG_NAME:=foo', '\\ No newline at end of file');

  for (const { title, level, reportedIn } of [
    {
      title: 'catches missing trailing newline on new/modified file additions as error by default',
      level: true, reportedIn: 'errors'
    },
    {
      title: 'catches missing trailing newline as warning when check_trailing_newline is set to warning',
      level: 'warning', reportedIn: 'warnings'
    },
    {
      title: 'does not report missing trailing newline when check_trailing_newline is disabled',
      level: false
    },
  ]) {
    test(title, () => {
      const res = validate('foo: test', withoutNewline, { config: focused({ check_trailing_newline: level }) });
      for (const list of ['errors', 'warnings']) {
        if (list === reportedIn) assertSomeIncludes(res[list], 'missing a trailing newline', list);
        else assert.deepStrictEqual(res[list], []);
      }
    });
  }

  test('accepts files with trailing newline', () => {
    const res = validate('foo: test', diff(gitAdded(FOO), '@@ -0,0 +1,1 @@', '+PKG_NAME:=foo'), {
      config: focused({ check_trailing_newline: true })
    });
    assertNoErrors(res);
    assert.deepStrictEqual(res.warnings, []);
    assertSomeIncludes(res.successes, 'All modified files contain a trailing newline', 'successes');
  });

  test('ignores missing trailing newline in pre-image (old version) when not present in post-image', () => {
    const res = validate('foo: test', diff(
      gitModified(FOO),
      '@@ -1,1 +1,2 @@',
      '-PKG_NAME:=foo',
      '\\ No newline at end of file',
      '+PKG_NAME:=foo',
      '+PKG_VERSION:=1.0'
    ), { config: focused({ check_trailing_newline: true }) });
    assertNoErrors(res);
    assert.deepStrictEqual(res.warnings, []);
  });

  for (const { title, checks, lines, errors, note } of [
    {
      title: 'flags spaces immediately after the := operator in Makefiles',
      checks: { check_space_after_assignment: true },
      lines: ['+PKG_LICENSE:= MIT', '+PKG_SOURCE_URL:= https://github.com/foo/bar', '+PKG_NAME :=  foo'],
      errors: [
        "Makefile line 'PKG_LICENSE:= MIT' has a space after ':='",
        "Makefile line 'PKG_SOURCE_URL:= https://github.com/foo/bar' has a space after ':='",
        "Makefile line 'PKG_NAME :=  foo' has a space after ':='"
      ]
    },
    {
      title: 'accepts clean assignments without space after :=',
      checks: { check_space_after_assignment: true },
      lines: ['+PKG_LICENSE:=MIT', '+PKG_SOURCE_URL:=https://github.com/foo/bar', '+PKG_NAME:=foo', '+VAR:='],
      errors: [],
      note: "does not contain spaces after ':='"
    },
    {
      title: 'ignores comments and recipe lines containing spaces after :=',
      checks: { check_space_after_assignment: true },
      lines: ['+# TITLE:= Simple WireGuard proxy', '+\t$(SH) -c "var := value"'],
      errors: []
    },
    {
      title: 'respects check_space_after_assignment: false configuration option',
      checks: { check_space_after_assignment: false },
      lines: ['+PKG_LICENSE:= MIT'],
      errors: []
    },
    {
      title: 'flags `=` instead of `:=` for standard variables (missing colon)',
      checks: { check_missing_colon: true },
      lines: ['+PKG_SOURCE_URL= \\', '+PKG_LICENSE = MIT', '+PKG_VERSION= 1.0.0', '+CUSTOM_VAR = helper'],
      errors: [
        ["uses '=' instead of ':='", 'PKG_SOURCE_URL'],
        ["uses '=' instead of ':='", 'PKG_LICENSE'],
        ["uses '=' instead of ':='", 'PKG_VERSION']
      ]
    },
    {
      title: 'respects check_missing_colon: false configuration option',
      checks: { check_missing_colon: false },
      lines: ['+PKG_SOURCE_URL= \\'],
      errors: []
    },
    {
      title: 'accepts space after := when followed by line continuation backslash',
      checks: { check_space_after_assignment: true },
      lines: ['+ DEPENDS:= \\', '+\t+libpcre2 \\'],
      errors: []
    },
    {
      // Each suggestion is a diff block that keeps the line's own indentation.
      title: 'formats assignment error suggestions as diff block preserving indentation',
      checks: { check_missing_colon: true, check_space_after_assignment: true },
      lines: ['+  PKG_SOURCE_URL=https://github.com/foo/bar', '+  TITLE:= Simple WireGuard proxy'],
      errors: [
        ['  -   PKG_SOURCE_URL=https://github.com/foo/bar', '  +   PKG_SOURCE_URL:=https://github.com/foo/bar'],
        ['  -   TITLE:= Simple WireGuard proxy', '  +   TITLE:=Simple WireGuard proxy']
      ]
    },
  ]) {
    test(title, () => {
      const res = validate('foo: test', diff(gitModified(FOO), lines), { config: focused(checks) });
      assertErrorsInOrder(res, errors);
      if (note) assertSomeIncludes(res.successes, note, 'successes');
    });
  }

  for (const { title, enabled = true, lines, errors, note } of [
    {
      title: 'passes valid Makefile block indentation',
      lines: [
        '+define Package/foo',
        '+  SECTION:=utils',
        '+  CATEGORY:=Utilities',
        '+  TITLE:=Example package',
        '+  DEPENDS:=+libstdcpp \\',
        '+    +libpthread',
        '+endef',
        '+',
        '+define Package/foo/description',
        '+  This is a package description.',
        '+    - bullet 1',
        '+    - bullet 2',
        '+endef',
        '+',
        '+define Package/foo/install',
        '+\t$(INSTALL_DIR) $(1)/usr/bin',
        '+\t$(INSTALL_BIN) $(PKG_BUILD_DIR)/foo $(1)/usr/bin/',
        '+endef',
        '+',
        '+define Build/Compile',
        '+\t$(MAKE) -C $(PKG_BUILD_DIR)',
        '+endef'
      ],
      errors: [],
      note: 'Makefile blocks contain valid indentation'
    },
    {
      title: 'flags invalid indentation in Package metadata blocks',
      lines: ['+define Package/foo', '+ SECTION:=utils', '+\tCATEGORY:=Utilities', '+   TITLE:=Example package', '+endef'],
      errors: [
        "line 'SECTION:=utils' inside 'Package/foo' must be indented with exactly 2 spaces",
        "line 'CATEGORY:=Utilities' inside 'Package/foo' must be indented with exactly 2 spaces",
        "line 'TITLE:=Example package' inside 'Package/foo' must be indented with exactly 2 spaces"
      ]
    },
    {
      title: 'flags invalid indentation in description blocks',
      lines: [
        '+define Package/foo/description',
        '+ This description starts with 1 space',
        '+\tThis line starts with a tab',
        '+No spaces at all',
        '+endef'
      ],
      errors: [
        "line 'This description starts with 1 space' inside 'Package/foo/description' must be indented with at least 2 spaces",
        "line 'This line starts with a tab' inside 'Package/foo/description' must be indented with at least 2 spaces",
        "line 'No spaces at all' inside 'Package/foo/description' must be indented with at least 2 spaces"
      ]
    },
    {
      title: 'flags invalid indentation in recipe blocks',
      lines: [
        '+define Package/foo/install',
        '+  $(INSTALL_DIR) $(1)/usr/bin',
        '+\t$(INSTALL_BIN) $(PKG_BUILD_DIR)/foo $(1)/usr/bin/',
        '+endef',
        '+',
        '+define Build/Compile',
        '+  $(MAKE) -C $(PKG_BUILD_DIR)',
        '+endef'
      ],
      errors: [
        "line '$(INSTALL_DIR) $(1)/usr/bin' inside 'Package/foo/install' must be indented with a tab",
        "line '$(MAKE) -C $(PKG_BUILD_DIR)' inside 'Build/Compile' must be indented with a tab"
      ]
    },
    {
      title: 're-enters block from hunk header context and validates added lines',
      lines: [
        '@@ -10,3 +10,4 @@ define Package/foo',
        '   SECTION:=utils',
        '+ TITLE:=Badly indented',
        ' endef',
        '@@ -30,3 +31,4 @@ define Package/foo/install',
        ' \t$(INSTALL_DIR) $(1)/usr/bin',
        '+  $(INSTALL_BIN) $(PKG_BUILD_DIR)/foo $(1)/usr/bin/',
        ' endef'
      ],
      errors: [
        "line 'TITLE:=Badly indented' inside 'Package/foo' must be indented with exactly 2 spaces",
        "line '$(INSTALL_BIN) $(PKG_BUILD_DIR)/foo $(1)/usr/bin/' inside 'Package/foo/install' must be indented with a tab"
      ]
    },
    {
      title: 'ignores comments, empty lines, and conditionals in blocks',
      lines: [
        '+define Package/foo',
        '+  SECTION:=utils',
        '+',
        '+  # This is a comment inside metadata',
        '+ifeq ($(CONFIG_FOO),y)',
        '+  TITLE:=Foo Enabled',
        '+else',
        '+  TITLE:=Foo Disabled',
        '+endif',
        '+endef'
      ],
      errors: []
    },
    {
      title: 'respects check_makefile_indentation: false configuration option',
      enabled: false,
      lines: ['+define Package/foo', '+ SECTION:=utils', '+endef'],
      errors: []
    },
  ]) {
    test(title, () => {
      const res = validate('foo: test', diff(gitModified(FOO), lines), { config: focused({ check_makefile_indentation: enabled }) });
      assertErrorsInOrder(res, errors);
      if (note) assertSomeIncludes(res.successes, note, 'successes');
    });
  }

  test('does not leak block state across diff hunks (issue #44)', () => {
    const res = validate('prometheus-node-exporter-lua: add dhcp-leases exporter', diff(
      gitModified('utils/prometheus-node-exporter-lua/Makefile'),
      '@@ -81,6 +81,17 @@ define Package/prometheus-node-exporter-lua-dawn/install',
      ' \t$(INSTALL_DATA) ./files/dawn.lua $(1)/usr/lib/lua/prometheus-collectors/',
      ' endef',
      '',
      '+define Package/prometheus-node-exporter-lua-dhcp-leases',
      '+  $(call Package/prometheus-node-exporter-lua/Default)',
      '+  TITLE+= (dhcp-leases collector)',
      '+  DEPENDS:=prometheus-node-exporter-lua',
      '+endef',
      '+',
      '+define Package/prometheus-node-exporter-lua-dhcp-leases/install',
      '+\t$(INSTALL_DIR) $(1)/usr/lib/lua/prometheus-collectors',
      '+\t$(INSTALL_DATA) ./files/dhcp-leases.lua $(1)/usr/lib/lua/prometheus-collectors/',
      '+endef',
      '+',
      ' define Package/prometheus-node-exporter-lua-filesystem',
      '   $(call Package/prometheus-node-exporter-lua/Default)',
      '   TITLE+= (filesystem collector)',
      '@@ -320,6 +331,7 @@ endef',
      ' $(eval $(call BuildPackage,prometheus-node-exporter-lua))',
      ' $(eval $(call BuildPackage,prometheus-node-exporter-lua-dawn))',
      '+$(eval $(call BuildPackage,prometheus-node-exporter-lua-dhcp-leases))',
      ' $(eval $(call BuildPackage,prometheus-node-exporter-lua-filesystem))'
    ), { config: focused({ check_makefile_indentation: true }) });
    assertNoErrors(res);
    assertSomeIncludes(res.successes, 'Makefile blocks contain valid indentation', 'successes');
  });

  // Isolate the buildbot-default check so unrelated Makefile rules cannot
  // contribute errors/warnings and skew the assertions below.
  const buildbotConfig = (level) => focused({
    check_makefile_indentation: false,
    check_pkg_name_reuse: false,
    check_missing_colon: false,
    check_space_after_assignment: false,
    check_buildbot_default: level
  });
  // The check only applies outside openwrt/openwrt, to the feeds.
  const validateFeed = (message, patch, level = 'warning') =>
    validate(message, patch, { config: buildbotConfig(level), repo: 'openwrt/packages' });
  // One added line inside Package/foo.
  const inPackageFoo = (line, makefile = 'utils/foo/Makefile') =>
    [gitModified(makefile), '@@ -1,2 +1,3 @@', ' define Package/foo', line, ' endef'];

  test('warns on DEFAULT conditioned on BUILDBOT in a feed package (issue #4)', () => {
    const res = validateFeed('openssh: add sftp-server DEFAULT', diff(
      gitModified('net/openssh/Makefile'),
      '@@ -80,6 +80,13 @@ define Package/openssh-server',
      ' endef',
      ' ',
      '+define Package/openssh-sftp-server',
      '+  $(call Package/openssh/Default)',
      '+  TITLE+= SFTP server',
      '+  DEFAULT:=y if (BUILDBOT && !SMALL_FLASH)',
      '+endef',
      '+',
      ' define Package/openssh-client/description'
    ));
    assertNoErrors(res);
    assert.strictEqual(res.warnings.length, 1);
    assert.ok(res.warnings[0].includes('DEFAULT:=y if (BUILDBOT && !SMALL_FLASH)'));
    assert.ok(res.warnings[0].includes("inside 'Package/openssh-sftp-server'"));
  });

  // Reported exactly once, as a warning that says (or does not say) these things.
  for (const { title, why, message, patch, says = [], saysNot = [] } of [
    {
      title: 'labels the package from the hunk header when the define is outside the diff',
      message: 'owut: default on buildbot',
      patch: diff(
        gitModified('utils/owut/Makefile'),
        '@@ -20,6 +20,7 @@ define Package/owut',
        '   SECTION:=utils',
        '   CATEGORY:=Base system',
        '+  DEFAULT:=y if BUILDBOT',
        '   TITLE:=owut'
      ),
      says: ["inside 'Package/owut'"]
    },
    {
      title: 'does not attribute a DEFAULT line to a package block closed in an earlier hunk',
      message: 'foo: default on buildbot',
      patch: diff(gitModified('utils/foo/Makefile'), '@@ -20,3 +20,4 @@ define Package/foo', '   TITLE:=Foo', ' endef', '+DEFAULT:=y if BUILDBOT'),
      saysNot: ['inside']
    },
    {
      title: 'closes the package block on an indented endef',
      why: 'indented endef must not leave Package/foo attributed',
      message: 'foo: default on buildbot',
      patch: diff(gitModified('utils/foo/Makefile'), '@@ -20,3 +20,4 @@ define Package/foo', '   TITLE:=Foo', '   endef', '+DEFAULT:=y if BUILDBOT'),
      saysNot: ['inside']
    },
    {
      title: 'attributes a DEFAULT line under an indented define',
      message: 'foo: default on buildbot',
      patch: diff(gitModified('utils/foo/Makefile'), '@@ -20,3 +20,5 @@ context', '+  define Package/foo', '+  DEFAULT:=y if BUILDBOT'),
      says: ["inside 'Package/foo'"]
    },
    {
      title: 'detects DEFAULT assignments spread over backslash continuation lines',
      message: 'foo: default on buildbot',
      patch: diff(
        gitModified('utils/foo/Makefile'),
        '@@ -10,3 +10,5 @@ define Package/foo',
        '   TITLE:=Foo',
        '+  DEFAULT:=y if \\',
        '+    (BUILDBOT && !SMALL_FLASH)'
      ),
      says: ['BUILDBOT']
    },
    {
      title: 'flags a BUILDBOT continuation added under a pre-existing DEFAULT line',
      why: 'adding the condition to an existing DEFAULT must be caught',
      message: 'foo: enable on buildbot',
      patch: diff(
        gitModified('net/foo/Makefile'),
        '@@ -10,3 +10,4 @@ define Package/foo',
        '   TITLE:=Foo',
        '   DEFAULT:=y \\',
        '+\tif BUILDBOT',
        '   DEPENDS:=+libc'
      ),
      says: ['BUILDBOT', "inside 'Package/foo'"]
    },
    {
      title: 'flags a changed DEFAULT value line above an untouched BUILDBOT continuation',
      why: 'flipping the value re-arms the BUILDBOT default',
      message: 'foo: enable by default',
      patch: diff(
        gitModified('net/foo/Makefile'),
        '@@ -10,4 +10,4 @@ define Package/foo',
        '   TITLE:=Foo',
        '-  DEFAULT:=n \\',
        '+  DEFAULT:=y \\',
        ' \tif BUILDBOT',
        '   DEPENDS:=+libc'
      ),
      says: ['BUILDBOT']
    },
    {
      title: 'attributes the package from an indented define carried as hunk context',
      why: 'indented define in the hunk header must still attribute the package',
      message: 'foo: default on buildbot',
      patch: diff(
        gitModified('net/foo/Makefile'),
        '@@ -10,3 +10,4 @@   define Package/foo',
        '   TITLE:=Foo',
        '+  DEFAULT:=y if BUILDBOT',
        '   DEPENDS:=+libc'
      ),
      says: ["inside 'Package/foo'"]
    },
    {
      title: 'reports an identical DEFAULT+BUILDBOT line only once per patch',
      message: 'foo: default on buildbot',
      patch: diff(inPackageFoo('+  DEFAULT:=y if BUILDBOT'), inPackageFoo('+  DEFAULT:=y if BUILDBOT', 'utils/bar/Makefile'))
    },
  ]) {
    test(title, () => {
      const res = validateFeed(message, patch);
      assert.strictEqual(res.warnings.length, 1, why ?? `Warnings: ${res.warnings.join(', ')}`);
      for (const text of says) assert.ok(res.warnings[0].includes(text), why ?? `Warning: ${res.warnings[0]}`);
      for (const text of saysNot) assert.ok(!res.warnings[0].includes(text), why ?? `Warning: ${res.warnings[0]}`);
    });
  }

  test('detects every Makefile assignment flavour for DEFAULT', () => {
    for (const op of [':=', '=', '?=', '+=', '::=']) {
      const res = validateFeed('foo: default on buildbot', diff(
        gitModified('utils/foo/Makefile'),
        '@@ -10,3 +10,4 @@ define Package/foo',
        '   TITLE:=Foo',
        `+  DEFAULT${op}y if BUILDBOT`
      ));
      assert.strictEqual(res.warnings.length, 1, `operator ${op} was not detected`);
    }
  });

  test('treats check_buildbot_default: true and "error" as a hard error', () => {
    for (const level of [true, 'error']) {
      const res = validateFeed('foo: add DEFAULT', diff(inPackageFoo('+  DEFAULT:=y if BUILDBOT')), level);
      assert.deepStrictEqual(res.warnings, []);
      assertErrorsInOrder(res, ['DEFAULT:=y if BUILDBOT']);
    }
  });

  // No error and no warning.
  for (const { title, why, message, patch, note } of [
    {
      title: 'does not flag DEFAULT without a BUILDBOT condition',
      message: 'foo: add DEFAULT',
      patch: diff(inPackageFoo('+  DEFAULT:=y if TARGET_x86')),
      note: 'No feed package forces its own inclusion'
    },
    {
      title: 'ignores DEFAULT+BUILDBOT inside an added comment line',
      message: 'foo: document DEFAULT',
      patch: diff(inPackageFoo('+#  DEFAULT:=y if BUILDBOT'))
    },
    {
      title: 'does not flag pre-existing DEFAULT+BUILDBOT lines left untouched by the diff',
      message: 'foo: unrelated tweak',
      patch: diff(
        gitModified('utils/owut/Makefile'),
        '@@ -10,7 +10,7 @@ define Package/owut',
        '   DEFAULT:=y if (BUILDBOT && !SMALL_FLASH)',
        '-  TITLE:=owut - an OpenWrt Upgrade Tool',
        '+  TITLE:=owut - an OpenWrt upgrade tool',
        ' endef'
      )
    },
    {
      title: 'does not flag a pre-existing backslash-continued DEFAULT+BUILDBOT left untouched',
      message: 'foo: unrelated tweak',
      patch: diff(
        gitModified('net/foo/Makefile'),
        '@@ -10,4 +10,5 @@ define Package/foo',
        '   TITLE:=Foo',
        '   DEFAULT:=y \\',
        ' \tif BUILDBOT',
        '+  URL:=https://example.org',
        '   DEPENDS:=+libc'
      )
    },
    {
      title: 'does not re-report an untouched DEFAULT+BUILDBOT when an unrelated clause is appended',
      why: 'BUILDBOT was already there; the diff did not introduce it',
      message: 'foo: extend default condition',
      patch: diff(
        gitModified('net/foo/Makefile'),
        '@@ -10,4 +10,5 @@ define Package/foo',
        '   TITLE:=Foo',
        '   DEFAULT:=y if BUILDBOT \\',
        '+\t|| ALL_KMODS',
        '   DEPENDS:=+libc'
      )
    },
  ]) {
    test(title, () => {
      const res = validateFeed(message, patch);
      assertNoErrors(res);
      assert.deepStrictEqual(res.warnings, [], why);
      if (note) assertSomeIncludes(res.successes, note, 'successes');
    });
  }

  test('does not flag DEFAULT+BUILDBOT in the main openwrt/openwrt repo, whatever the casing', () => {
    for (const repo of ['openwrt/openwrt', 'OpenWrt/OpenWrt']) {
      const res = validate('openssh: add sftp-server DEFAULT', diff(
        gitModified('net/openssh/Makefile'),
        '@@ -1,2 +1,3 @@',
        ' define Package/openssh-sftp-server',
        '+  DEFAULT:=y if (BUILDBOT && !SMALL_FLASH)',
        ' endef'
      ), { config: buildbotConfig('warning'), repo });
      assertNoErrors(res);
      assert.deepStrictEqual(res.warnings, []);
      assertNoneIncludes(res.successes, 'BUILDBOT', 'successes');
    }
  });

  test('stays silent when the commit touches no Makefile at all', () => {
    const res = validateFeed('docs: tweak readme', diff(gitModified('README.md'), '@@ -1,1 +1,2 @@', ' hello', '+world'));
    assert.deepStrictEqual(res.warnings, []);
    assertNoneIncludes(res.successes, 'No feed package forces its own inclusion', 'successes');
  });

  test('respects check_buildbot_default: false and "disabled" configuration options', () => {
    for (const level of [false, 'disabled']) {
      const res = validateFeed('foo: add DEFAULT', diff(inPackageFoo('+  DEFAULT:=y if BUILDBOT')), level);
      assertNoErrors(res);
      assert.deepStrictEqual(res.warnings, []);
      assertNoneIncludes(res.successes, 'BUILDBOT', 'successes');
    }
  });

  // Written with a `diff --git b/... b/...` line, and kept that way.
  const reuseHeader = ['diff --git b/package/utils/foo/Makefile b/package/utils/foo/Makefile', ...modified(FOO)];
  const REUSE = 'reuses PKG_NAME in a call, define, or eval';

  test('rejects reuse of PKG_NAME in call, define, and eval lines', () => {
    const res = validate('foo: test', diff(
      reuseHeader,
      '+define Package/$(PKG_NAME)',
      '+$(eval $(call BuildPackage,$(PKG_NAME)))',
      '+define Package/${PKG_NAME}/description',
      '+$(call BuildPackage,${PKG_NAME})'
    ));
    assertErrorsInOrder(res, [REUSE, REUSE, REUSE, REUSE]);
  });

  for (const { title, lines, note } of [
    {
      title: 'accepts literal package name in call, define, and eval lines',
      lines: ['+define Package/foo', '+$(eval $(call BuildPackage,foo))', '+define Package/foo/description', '+$(call BuildPackage,foo)'],
      note: 'does not reuse PKG_NAME in call, define, or eval'
    },
    {
      title: 'allows PKG_NAME outside of call, define, and eval lines',
      lines: ['+PKG_BUILD_DIR:=$(BUILD_DIR)/$(PKG_NAME)-$(PKG_VERSION)', '+PKG_SOURCE_URL:=https://github.com/foo/$(PKG_NAME)']
    },
    {
      title: 'ignores comments containing PKG_NAME inside eval/call/define patterns',
      lines: ['+# $(eval $(call BuildPackage,$(PKG_NAME)))', '+# define Package/$(PKG_NAME)']
    },
  ]) {
    test(title, () => {
      const res = validate('foo: test', diff(reuseHeader, lines), { config: focused() });
      assertNoErrors(res);
      if (note) assertSomeIncludes(res.successes, note, 'successes');
    });
  }
});

describe('validateMakefileContext dead package variables', () => {
  const MYPKG = 'package/utils/mypkg/Makefile';

  for (const { title, message, patch, error } of [
    {
      title: 'flags top-level PROVIDES in a LuCI Makefile and suggests PKG_PROVIDES',
      message: 'luci-app-qosify: provide luci-app-qos',
      patch: diff(
        gitModified('applications/luci-app-qosify/Makefile'),
        '@@ -7,6 +7,7 @@',
        ' LUCI_TITLE:=LuCI interface for qosify',
        ' LUCI_DEPENDS:=+qosify',
        ' LUCI_PKGARCH:=all',
        '+PROVIDES:=luci-app-qos'
      ),
      error: "Use 'PKG_PROVIDES:=luci-app-qos'"
    },
    {
      title: 'flags top-level MAINTAINER in a regular package and suggests PKG_MAINTAINER',
      message: 'mypkg: fix maintainer',
      patch: diff(modified(MYPKG), '+MAINTAINER:=Jane Doe <jane@doe.com>'),
      error: "Use 'PKG_MAINTAINER:=Jane Doe <jane@doe.com>'"
    },
    {
      title: 'flags top-level DEPENDS in a regular package and points to the Package block',
      message: 'mypkg: add dependency',
      patch: diff(modified(MYPKG), '+DEPENDS:=+libfoo'),
      error: "Move 'DEPENDS:=+libfoo' into the 'define Package/<name>' block"
    },
    {
      title: 'does not flag variables inside a define block',
      message: 'mypkg: add package definition',
      patch: diff(
        modified(MYPKG),
        '@@ -10,0 +11,6 @@',
        '+define Package/mypkg',
        '+  SECTION:=utils',
        '+  CATEGORY:=Utilities',
        '+TITLE:=Unindented but still inside the block',
        '+  DEPENDS:=+libbar',
        '+endef'
      )
    },
    {
      title: 'derives define state from the hunk header context',
      message: 'mypkg: extend package definition',
      patch: diff(modified(MYPKG), '@@ -12,3 +12,4 @@ define Package/mypkg', '   SECTION:=utils', '   CATEGORY:=Utilities', '+DEPENDS:=+libbar')
    },
    {
      title: 'skips build infrastructure Makefiles',
      message: 'ti-k3: add target',
      patch: diff(modified('target/linux/ti-k3/Makefile'), '+MAINTAINER:=Jane Doe <jane@doe.com>')
    },
  ]) {
    test(title, () => {
      const res = validate(message, patch);
      if (error) assertErrorIncludes(res, error);
      else assertNoErrors(res);
    });
  }

  test('suppresses the missing-colon suggestion for a dead assignment', () => {
    const res = validate('mypkg: provide virtual package', diff(modified(MYPKG), '+PROVIDES=mypkg-virtual'), {
      config: { ...CONFIG, check_missing_colon: true, check_space_after_assignment: true }
    });
    assert.ok(res.errors.some(e => e.includes('no effect') || e.includes("'define Package/<name>' block")), `Errors: ${res.errors.join(', ')}`);
    assertNoErrorIncludes(res, "uses '=' instead of ':='");
  });

  test('reports success when a package Makefile stays clean', () => {
    const res = validate('mypkg: update to 1.2', diff(modified(MYPKG), '+PKG_VERSION:=1.2'), { config: { ...CONFIG, check_pkg_version: false } });
    assertSomeIncludes(res.successes, 'per-package variables', 'successes');
  });
});

describe('isPackageMakefilePath', () => {
  for (const { title, expected, paths } of [
    {
      title: 'accepts package and feed Makefiles',
      expected: true,
      paths: ['package/utils/bash/Makefile', 'package/lang/python/python3/Makefile', 'net/mosdns/Makefile', './package/utils/bash/Makefile']
    },
    {
      title: 'rejects build infrastructure Makefiles',
      expected: false,
      paths: ['target/linux/ti-k3/Makefile', 'target/linux/ti-k3/image/Makefile', 'tools/newtool/Makefile', 'toolchain/gcc/Makefile', 'Makefile']
    },
    {
      title: 'rejects non-Makefile paths',
      expected: false,
      paths: ['package/utils/bash/Makefile.in', 'include/package.mk', '', null]
    },
  ]) {
    test(title, () => {
      for (const path of paths) assert.strictEqual(isPackageMakefilePath(path), expected, JSON.stringify(path));
    });
  }
});

describe('PKG_MAINTAINER parsing', () => {
  const settingMaintainer = (value) => [
    'diff --git a/utils/mypkg/Makefile b/utils/mypkg/Makefile',
    '--- a/utils/mypkg/Makefile',
    '+++ b/utils/mypkg/Makefile',
    '@@ -1,2 +1,3 @@',
    ' PKG_NAME:=mypkg',
    `+PKG_MAINTAINER:=${value}`,
    ' PKG_LICENSE:=MIT'
  ].join('\n');
  const options = { config: { ...CONFIG, check_openwrt_meta: true }, repo: 'openwrt/openwrt' };

  test('answers promptly on a maintainer line full of angle brackets', async () => {
    // 80 000 of them cost the old pattern about 5.5 seconds, from one added
    // Makefile line - well inside what a pull request can carry.
    const patch = settingMaintainer('<'.repeat(80000));
    const started = process.hrtime.bigint();
    const res = validate('mypkg: set maintainer', patch, options);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 2500, `parsing took ${ms.toFixed(0)} ms, which no invocation can afford`);
    // The malformed value is still reported.
    assertErrorIncludes(res, 'PKG_MAINTAINER');
  });

  test('still reads the addresses out of a real maintainer line', () => {
    assertNoErrors(validate('mypkg: set maintainer', settingMaintainer('Jane Doe <jane@doe.com>, Bob <bob@example.org>'), options));
  });
});

describe('Makefile metadata indentation', () => {
  const asNewMakefile = (body) => [
    'diff --git a/utils/mypkg/Makefile b/utils/mypkg/Makefile',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/utils/mypkg/Makefile',
    '@@ -0,0 +1,9 @@',
    ...body.split('\n').map(l => '+' + l)
  ].join('\n');
  const validateNewMakefile = (body) => validate('mypkg: add package', asNewMakefile(body), {
    config: { ...CONFIG, check_makefile_indentation: true },
    state: newPackage(),
    repo: 'openwrt/openwrt'
  });

  test('accepts the inheritance idiom at any indentation', () => {
    // openwrt/openwrt writes it at column 0 more often than not - see
    // package/devel/gdb and package/kernel/mwlwifi - and the packages feed
    // uses all three forms, so there is no convention to enforce.
    for (const call of ['$(call Package/mypkg/Default)', '  $(call Package/mypkg/Default)', '\t$(call Package/mypkg/Default)']) {
      const res = validateNewMakefile(`define Package/mypkg\n${call}\n  TITLE:=My package\nendef`);
      assert.ok(!res.errors.some(e => e.includes('must be indented with exactly 2 spaces')),
        `${JSON.stringify(call)} -> ${res.errors.join(', ')}`);
    }
  });

  test('still asks for two spaces on an ordinary metadata line', () => {
    const res = validateNewMakefile('define Package/mypkg\n\tTITLE:=My package\nendef');
    assert.ok(res.errors.some(e => e.includes("'TITLE:=My package'") && e.includes('exactly 2 spaces')),
      `Errors: ${res.errors.join(', ')}`);
  });
});

describe('validateMakefileContext init scripts', () => {
  const INIT_CONFIG = { ...CONFIG, check_init_scripts: true };
  const INIT_SCRIPT = 'package/utils/mypkg/files/mypkg.init';
  const newInitPatch = (lines) => diff(gitAdded(INIT_SCRIPT), `@@ -0,0 +1,${lines.length} @@`, lines.map(l => '+' + l));
  const validateInit = (patch, config = INIT_CONFIG) => validate('mypkg: add init script', patch, { config });

  test('warns when a new init script lacks the rc.common interpreter', () => {
    const res = validateInit(newInitPatch(['#!/bin/sh', 'START=95', 'start() { true; }']));
    assertSomeIncludes(res.warnings, "does not start with '#!/bin/sh /etc/rc.common'", 'warnings');
  });

  test('warns when a new init script has no START= priority', () => {
    const res = validateInit(newInitPatch(['#!/bin/sh /etc/rc.common', 'start() { true; }']));
    assertSomeIncludes(res.warnings, "defines no 'START=' priority", 'warnings');
  });

  test('accepts a proper rc.common init script', () => {
    const res = validateInit(newInitPatch(['#!/bin/sh /etc/rc.common', '', 'START=95', 'STOP=10', 'USE_PROCD=1', 'start_service() { true; }']));
    assert.deepStrictEqual(res.warnings, []);
    assertSomeIncludes(res.successes, 'rc.common interpreter', 'successes');
  });

  // Nothing here is a new init script to judge.
  for (const { title, patch, config } of [
    {
      title: 'ignores patches, templates and docs under init.d paths',
      patch: diff(
        gitAdded('package/utils/mypkg/files/etc/init.d/README.txt'),
        '+How the init scripts here are organized.',
        gitAdded('package/utils/mypkg/patches/001-etc-init.d-fix.patch'),
        '+--- a/etc/init.d/foo',
        '++++ b/etc/init.d/foo',
        '+@@ -1 +1 @@',
        '+-old',
        '++new'
      )
    },
    {
      title: 'ignores edits to existing init scripts',
      patch: diff(gitModified(INIT_SCRIPT), '+reload_service() { true; }')
    },
    {
      title: 'does nothing when disabled',
      patch: newInitPatch(['#!/bin/sh', 'start() { true; }']),
      config: { ...CONFIG, check_init_scripts: false }
    },
  ]) {
    test(title, () => {
      assert.deepStrictEqual(validateInit(patch, config).warnings, []);
    });
  }
});

describe('LuCI package handling', () => {
  const QOSIFY = 'applications/luci-app-qosify/Makefile';
  const luciMakefile = 'include $(TOPDIR)/rules.mk\n\nPKG_LICENSE:=Apache-2.0\n\nLUCI_TITLE:=LuCI interface for qosify\nLUCI_DEPENDS:=+qosify\n\ninclude ../../luci.mk\n';
  // A head revision holding one Makefile and nothing else.
  const headWith = (makefile, content) => async (path) => path === makefile ? content : null;
  const auditRelease = (commitPatch, makefile, content) =>
    validatePkgReleaseBumps([{ commitPatch }], { check_pkg_release: 'error' }, headWith(makefile, content), async () => null);

  test('findPkgRoot resolves a LuCI application from its root/ payload', async () => {
    assert.strictEqual(
      await findPkgRoot('applications/luci-app-qosify/root/etc/config/qosify', headWith(QOSIFY, luciMakefile), {}),
      'applications/luci-app-qosify'
    );
  });

  test('findPkgRoot resolves a LuCI application from an htdocs file', async () => {
    assert.strictEqual(
      await findPkgRoot('applications/luci-app-qosify/htdocs/luci-static/resources/view/qosify.js', headWith(QOSIFY, luciMakefile), {}),
      'applications/luci-app-qosify'
    );
  });

  test('new LuCI packages only need PKG_LICENSE, not maintainer or license files', () => {
    const res = validate('luci-app-qosify: add new application', diff(
      gitAdded(QOSIFY),
      '@@ -0,0 +1,8 @@',
      '+include $(TOPDIR)/rules.mk',
      '+',
      '+PKG_LICENSE:=Apache-2.0',
      '+',
      '+LUCI_TITLE:=LuCI interface for qosify',
      '+LUCI_DEPENDS:=+qosify',
      '+',
      '+include ../../luci.mk'
    ));
    assertNoErrorIncludes(res, 'PKG_MAINTAINER');
    assertNoErrorIncludes(res, 'PKG_LICENSE_FILES');
    assertSomeIncludes(res.successes, "'PKG_LICENSE'", 'successes');
  });

  // Changes the release audit must not ask a PKG_RELEASE bump for.
  for (const { title, commitPatch, makefile, content, note } of [
    {
      title: 'release audit exempts LuCI packages changed without a PKG_RELEASE',
      commitPatch: `
diff --git a/applications/luci-app-qosify/htdocs/luci-static/resources/view/qosify.js b/applications/luci-app-qosify/htdocs/luci-static/resources/view/qosify.js
+++ b/applications/luci-app-qosify/htdocs/luci-static/resources/view/qosify.js
+return view.extend({});
`,
      makefile: QOSIFY,
      content: luciMakefile,
      note: 'skipping release bump requirement'
    },
    {
      // package/kernel/linux is the kernel itself: PKG_NAME, PKG_FLAGS and
      // nothing else. There is no PKG_RELEASE and no version to move, so the
      // advice "increment PKG_RELEASE or bump the version" cannot be followed.
      title: 'does not ask for a bump from a package that has nothing to bump',
      commitPatch: `
diff --git a/package/kernel/linux/modules/video.mk b/package/kernel/linux/modules/video.mk
--- a/package/kernel/linux/modules/video.mk
+++ b/package/kernel/linux/modules/video.mk
+define KernelPackage/drm-something
`,
      makefile: 'package/kernel/linux/Makefile',
      content: 'include $(TOPDIR)/rules.mk\ninclude $(INCLUDE_DIR)/kernel.mk\n\nPKG_NAME:=kernel\nPKG_FLAGS:=hold\n\ninclude $(INCLUDE_DIR)/package.mk\n',
      note: 'skipping release bump requirement'
    },
    {
      // package/kernel/bpf-headers takes its PKG_VERSION from the kernel's, so
      // moving it is not something a contributor does either.
      title: 'treats a version computed from something else as nothing to bump',
      commitPatch: `
diff --git a/package/kernel/bpf-headers/files/something.h b/package/kernel/bpf-headers/files/something.h
--- a/package/kernel/bpf-headers/files/something.h
+++ b/package/kernel/bpf-headers/files/something.h
+#define X 1
`,
      makefile: 'package/kernel/bpf-headers/Makefile',
      content: 'include $(INCLUDE_DIR)/kernel.mk\n\nPKG_NAME:=linux\nPKG_VERSION:=$(PKG_PATCHVER)$(strip $(LINUX_VERSION-$(PKG_PATCHVER)))\n'
    },
    {
      title: 'release audit accepts a new LuCI package without PKG_RELEASE',
      commitPatch: `
diff --git a/applications/luci-app-qosify/Makefile b/applications/luci-app-qosify/Makefile
--- /dev/null
+++ b/applications/luci-app-qosify/Makefile
+include ../../luci.mk
`,
      makefile: QOSIFY,
      content: luciMakefile,
      note: 'no PKG_RELEASE to initialize'
    },
  ]) {
    test(title, async () => {
      const res = await auditRelease(commitPatch, makefile, content);
      assertNoErrors(res);
      if (note) assertSomeIncludes(res.successes, note, 'successes');
    });
  }

  test('still asks a package whose source revision can be moved', async () => {
    // package/kernel/nat46 has no PKG_RELEASE either, but its PKG_SOURCE_DATE
    // and PKG_SOURCE_VERSION are literals a contributor can and should move.
    const res = await auditRelease(`
diff --git a/package/kernel/nat46/patches/001-fix.patch b/package/kernel/nat46/patches/001-fix.patch
--- a/package/kernel/nat46/patches/001-fix.patch
+++ b/package/kernel/nat46/patches/001-fix.patch
+changed
`, 'package/kernel/nat46/Makefile', 'include $(INCLUDE_DIR)/kernel.mk\n\nPKG_NAME:=nat46\nPKG_SOURCE_DATE:=2022-09-19\nPKG_SOURCE_VERSION:=4c5beee236841724219598fabb1edc93d4f08ce5\n');
    assertErrorIncludes(res, 'without a PKG_RELEASE or version bump');
  });
});
