import { describe, test } from 'node:test';
import assert from 'node:assert';
import { validatePkgReleaseBumps, groupReleaseErrors } from '../../src/validators.js';
import {
  CONFIG, makeCommit, assertSomeIncludes, assertNoneIncludes,
  assertNoErrors, assertErrorIncludes, assertNoErrorIncludes
} from './helpers.js';

// A fetchFileContent stub for a commit in which the package at `root` has a
// Makefile holding `content` and no other file exists. null content stands for
// a commit without that Makefile.
const makefileAt = (root, content = null) => async (path) => (path === `${root}/Makefile` ? content : null);

const assertSuccessIncludes = (res, text) => assertSomeIncludes(res.successes, text, 'successes');

describe('validatePkgReleaseBumps', () => {
  const defaultConf = { ...CONFIG, check_pkg_release: 'warning' };

  test('skips checks when disabled', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/package/utils/bash/files/bash.init b/package/utils/bash/files/bash.init
+++ b/package/utils/bash/files/bash.init
+# modified init script
`
    }];
    const disabledConf = { ...defaultConf, check_pkg_release: false };
    const res = await validatePkgReleaseBumps(commitDetails, disabledConf, () => null, () => null);
    assertNoErrors(res);
  });

  // Regression: GitHub freezes pull_request.base.sha when the PR is opened.
  // A branch created before an in-main source bump then shows a PKG_SOURCE_VERSION
  // difference between base and head even though the PR never touched it, and
  // the audit used to report main's own bump - backwards - as this PR's doing,
  // demanding a PKG_RELEASE reset for a version change that does not exist.
  test('does not report a version change the PR diff never made (stale base.sha)', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/package/network/services/uhttpd/Makefile b/package/network/services/uhttpd/Makefile
+++ b/package/network/services/uhttpd/Makefile
-PKG_RELEASE:=1
+PKG_RELEASE:=2
+  USERID:=uhttpd=456:uhttpd=456
`
    }];
    // Head carries the older source (branched in June); base.sha resolves to a
    // main that bumped the source in August. The PR itself only bumps RELEASE.
    const headFetch = async () => 'PKG_NAME:=uhttpd\nPKG_SOURCE_DATE:=2026-06-16\nPKG_SOURCE_VERSION:=7b1bec45826bd78c8afc993435bdc0f1df2fe399\nPKG_RELEASE:=2\n';
    const baseFetch = async () => 'PKG_NAME:=uhttpd\nPKG_SOURCE_DATE:=2026-08-03\nPKG_SOURCE_VERSION:=60f64bec40c8113cf09815ec377761b1f4f95f22\nPKG_RELEASE:=1\n';

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assertNoErrors(res);
    assertNoneIncludes(res.successes, 'version updated', 'successes');
    assertSuccessIncludes(res, "PKG_RELEASE bumped from '1' to '2'");
  });

  // One commit changing one package. `head` and `base` are the package's
  // Makefile on either side of the PR, null where it does not exist. Each row
  // expects either a success and no errors, or an error.
  const audits = [
    {
      name: 'passes for new package with release 1',
      root: 'package/utils/newpkg',
      patch: `
diff --git a/package/utils/newpkg/Makefile b/package/utils/newpkg/Makefile
new file mode 100644
--- /dev/null
+++ b/package/utils/newpkg/Makefile
`,
      head: 'PKG_NAME:=newpkg\nPKG_VERSION:=1.0\nPKG_RELEASE:=1\n',
      base: null,
      success: 'correctly initializes PKG_RELEASE to 1'
    },
    {
      name: 'fails for new package with release not 1',
      root: 'package/utils/newpkg',
      patch: `
diff --git a/package/utils/newpkg/Makefile b/package/utils/newpkg/Makefile
new file mode 100644
--- /dev/null
+++ b/package/utils/newpkg/Makefile
`,
      head: 'PKG_NAME:=newpkg\nPKG_VERSION:=1.0\nPKG_RELEASE:=2\n',
      base: null,
      error: 'must start with PKG_RELEASE set to 1'
    },
    {
      name: 'passes when existing package modified and PKG_RELEASE bumped',
      root: 'package/utils/bash',
      patch: `
diff --git a/package/utils/bash/files/bash.init b/package/utils/bash/files/bash.init
+++ b/package/utils/bash/files/bash.init
+# tweak init
diff --git a/package/utils/bash/Makefile b/package/utils/bash/Makefile
+++ b/package/utils/bash/Makefile
-PKG_RELEASE:=1
+PKG_RELEASE:=2
`,
      head: 'PKG_NAME:=bash\nPKG_VERSION:=5.2\nPKG_RELEASE:=2\n',
      base: 'PKG_NAME:=bash\nPKG_VERSION:=5.2\nPKG_RELEASE:=1\n',
      success: 'PKG_RELEASE bumped'
    },
    // Content changed, nothing bumped by the PR - the phantom version delta
    // from the drifted base must not silently satisfy the bump requirement.
    {
      name: 'still reports a missing bump when only base.sha drifted and the PR bumped nothing',
      root: 'package/utils/bash',
      patch: `
diff --git a/package/utils/bash/files/bash.init b/package/utils/bash/files/bash.init
+++ b/package/utils/bash/files/bash.init
+exec bash -l
`,
      head: 'PKG_NAME:=bash\nPKG_VERSION:=5.2\nPKG_RELEASE:=1\n',
      base: 'PKG_NAME:=bash\nPKG_VERSION:=5.3\nPKG_RELEASE:=1\n',
      error: 'content changed without a PKG_RELEASE or version bump'
    },
    {
      name: 'fails when existing package files modified but PKG_RELEASE or version is not bumped',
      root: 'package/utils/bash',
      patch: `
diff --git a/package/utils/bash/files/bash.init b/package/utils/bash/files/bash.init
+++ b/package/utils/bash/files/bash.init
+exec bash
`,
      head: 'PKG_NAME:=bash\nPKG_VERSION:=5.2\nPKG_RELEASE:=1\n',
      base: 'PKG_NAME:=bash\nPKG_VERSION:=5.2\nPKG_RELEASE:=1\n',
      error: 'content changed without a PKG_RELEASE or version bump'
    },
    {
      name: 'passes when u-boot.mk based package Makefile changes non-cosmetically without PKG_RELEASE',
      root: 'package/boot/uboot-testboard',
      patch: `
diff --git a/package/boot/uboot-testboard/Makefile b/package/boot/uboot-testboard/Makefile
--- a/package/boot/uboot-testboard/Makefile
+++ b/package/boot/uboot-testboard/Makefile
+  HIDDEN:=1
`,
      head: 'PKG_NAME:=uboot-testboard\nPKG_VERSION:=2026.07\ninclude $(INCLUDE_DIR)/u-boot.mk\n\ndefine U-Boot/Default\n  HIDDEN:=1\nendef\n',
      base: 'PKG_NAME:=uboot-testboard\nPKG_VERSION:=2026.07\ninclude $(INCLUDE_DIR)/u-boot.mk\n\ndefine U-Boot/Default\nendef\n',
      success: 'shared build helper'
    },
    {
      name: 'still fails for non-u-boot package with no PKG_RELEASE and non-cosmetic changes',
      root: 'package/utils/bash',
      patch: `
diff --git a/package/utils/bash/Makefile b/package/utils/bash/Makefile
--- a/package/utils/bash/Makefile
+++ b/package/utils/bash/Makefile
+SOME_NEW_BUILD_FLAG:=1
`,
      head: 'PKG_NAME:=bash\nPKG_VERSION:=5.2\nSOME_NEW_BUILD_FLAG:=1\n',
      base: 'PKG_NAME:=bash\nPKG_VERSION:=5.2\n',
      error: 'content changed without a PKG_RELEASE or version bump'
    },
    {
      name: 'passes when tools/ package without PKG_RELEASE updates its version',
      root: 'tools/meson',
      patch: `
diff --git a/tools/meson/Makefile b/tools/meson/Makefile
--- a/tools/meson/Makefile
+++ b/tools/meson/Makefile
-PKG_VERSION:=1.6.1
+PKG_VERSION:=1.11.2
`,
      head: 'PKG_NAME:=meson\nPKG_VERSION:=1.11.2\n',
      base: 'PKG_NAME:=meson\nPKG_VERSION:=1.6.1\n',
      success: 'host-side build tools without PKG_RELEASE'
    },
    {
      name: 'still fails when tools/ package that adopted PKG_RELEASE updates version without resetting it',
      root: 'tools/squashfs4',
      patch: `
diff --git a/tools/squashfs4/Makefile b/tools/squashfs4/Makefile
--- a/tools/squashfs4/Makefile
+++ b/tools/squashfs4/Makefile
-PKG_VERSION:=4.7.4
+PKG_VERSION:=4.7.5
`,
      head: 'PKG_NAME:=squashfs4\nPKG_VERSION:=4.7.5\nPKG_RELEASE:=2\n',
      base: 'PKG_NAME:=squashfs4\nPKG_VERSION:=4.7.4\nPKG_RELEASE:=2\n',
      error: 'was not reset to 1'
    },
    // Accepted OpenWrt practice, see upstream cbf8c76d0a "tools/meson:
    // update to 1.2.1" - the exemption must not require base to lack
    // PKG_RELEASE too.
    {
      name: 'passes when tools/ package drops PKG_RELEASE while updating its version',
      root: 'tools/meson',
      patch: `
diff --git a/tools/meson/Makefile b/tools/meson/Makefile
--- a/tools/meson/Makefile
+++ b/tools/meson/Makefile
-PKG_VERSION:=1.1.1
-PKG_RELEASE:=2
+PKG_VERSION:=1.2.1
`,
      head: 'PKG_NAME:=meson\nPKG_VERSION:=1.2.1\n',
      base: 'PKG_NAME:=meson\nPKG_VERSION:=1.1.1\nPKG_RELEASE:=2\n',
      success: 'host-side build tools without PKG_RELEASE'
    },
    {
      name: 'passes when tools/ package without PKG_RELEASE changes patches only',
      root: 'toolchain/musl',
      patch: `
diff --git a/toolchain/musl/patches/010-fix.patch b/toolchain/musl/patches/010-fix.patch
--- a/toolchain/musl/patches/010-fix.patch
+++ b/toolchain/musl/patches/010-fix.patch
+-void broken(void);
++void fixed(void);
`,
      head: 'PKG_NAME:=musl\nPKG_VERSION:=1.2.5\n',
      base: 'PKG_NAME:=musl\nPKG_VERSION:=1.2.5\n',
      success: 'host-side build tool'
    },
    {
      name: 'passes for new tools/ package without PKG_RELEASE',
      root: 'tools/newtool',
      patch: `
diff --git a/tools/newtool/Makefile b/tools/newtool/Makefile
new file mode 100644
--- /dev/null
+++ b/tools/newtool/Makefile
`,
      head: 'PKG_NAME:=newtool\nPKG_VERSION:=1.0\n',
      base: null,
      success: 'host-side build tool'
    },
    {
      name: 'passes when existing package files modified with only cosmetic changes',
      root: 'package/utils/bash',
      patch: `
diff --git a/package/utils/bash/files/bash.init b/package/utils/bash/files/bash.init
+++ b/package/utils/bash/files/bash.init
+# just a comment edit
+
`,
      head: 'PKG_NAME:=bash\nPKG_VERSION:=5.2\nPKG_RELEASE:=1\n',
      base: 'PKG_NAME:=bash\nPKG_VERSION:=5.2\nPKG_RELEASE:=1\n',
      success: 'only minor/cosmetic updates'
    },
    {
      name: 'passes when Makefile modified with only minor metadata and download updates',
      root: 'package/utils/bash',
      patch: `
diff --git a/package/utils/bash/Makefile b/package/utils/bash/Makefile
--- a/package/utils/bash/Makefile
+++ b/package/utils/bash/Makefile
-PKG_MAINTAINER:=Old Maintainer
+PKG_MAINTAINER:=New Maintainer
-PKG_SOURCE_URL:=http://oldurl
+PKG_SOURCE_URL:=https://newurl
-PKG_HASH:=1234
+PKG_HASH:=5678
`,
      head: 'PKG_NAME:=bash\nPKG_VERSION:=5.2\nPKG_RELEASE:=1\n',
      base: 'PKG_NAME:=bash\nPKG_VERSION:=5.2\nPKG_RELEASE:=1\n',
      success: 'only minor/cosmetic updates'
    },
    {
      name: 'passes when version updated and PKG_RELEASE reset to 1',
      root: 'package/utils/bash',
      patch: `
diff --git a/package/utils/bash/Makefile b/package/utils/bash/Makefile
+++ b/package/utils/bash/Makefile
-PKG_VERSION:=5.2
+PKG_VERSION:=5.3
`,
      head: 'PKG_NAME:=bash\nPKG_VERSION:=5.3\nPKG_RELEASE:=1\n',
      base: 'PKG_NAME:=bash\nPKG_VERSION:=5.2\nPKG_RELEASE:=3\n',
      success: "version updated to '5.3' and PKG_RELEASE correctly reset to 1"
    },
    {
      name: 'fails when version updated but PKG_RELEASE is not reset to 1',
      root: 'package/utils/bash',
      patch: `
diff --git a/package/utils/bash/Makefile b/package/utils/bash/Makefile
+++ b/package/utils/bash/Makefile
-PKG_VERSION:=5.2
+PKG_VERSION:=5.3
`,
      head: 'PKG_NAME:=bash\nPKG_VERSION:=5.3\nPKG_RELEASE:=2\n',
      base: 'PKG_NAME:=bash\nPKG_VERSION:=5.2\nPKG_RELEASE:=3\n',
      error: 'but PKG_RELEASE was not reset to 1'
    },
    {
      name: 'supports package/<pkg>/... layout directly without category prefix',
      root: 'package/iozone',
      patch: `
diff --git a/package/iozone/files/iozone.init b/package/iozone/files/iozone.init
+++ b/package/iozone/files/iozone.init
+# modified config
diff --git a/package/iozone/Makefile b/package/iozone/Makefile
+++ b/package/iozone/Makefile
-PKG_RELEASE:=1
+PKG_RELEASE:=2
`,
      head: 'PKG_NAME:=iozone\nPKG_VERSION:=4.0\nPKG_RELEASE:=2\n',
      base: 'PKG_NAME:=iozone\nPKG_VERSION:=4.0\nPKG_RELEASE:=1\n',
      success: 'version unchanged, but PKG_RELEASE bumped'
    },
    {
      name: 'supports deeply nested layouts like luci/libs/<pkg>/...',
      root: 'luci/libs/luci-lib-uqr',
      patch: `
diff --git a/luci/libs/luci-lib-uqr/patches/001-fix.patch b/luci/libs/luci-lib-uqr/patches/001-fix.patch
+++ b/luci/libs/luci-lib-uqr/patches/001-fix.patch
+# patch file contents
diff --git a/luci/libs/luci-lib-uqr/Makefile b/luci/libs/luci-lib-uqr/Makefile
+++ b/luci/libs/luci-lib-uqr/Makefile
-PKG_RELEASE:=1
+PKG_RELEASE:=2
`,
      head: 'PKG_NAME:=luci-lib-uqr\nPKG_VERSION:=1.0\nPKG_RELEASE:=2\n',
      base: 'PKG_NAME:=luci-lib-uqr\nPKG_VERSION:=1.0\nPKG_RELEASE:=1\n',
      success: 'version unchanged, but PKG_RELEASE bumped'
    },
    {
      name: 'passes when nested version variable (e.g. GO_VERSION_PATCH) is bumped',
      root: 'package/utils/golang',
      patch: `
diff --git a/package/utils/golang/Makefile b/package/utils/golang/Makefile
+++ b/package/utils/golang/Makefile
-GO_VERSION_PATCH:=3
+GO_VERSION_PATCH:=4
`,
      head: 'PKG_NAME:=golang\nGO_VERSION_MAJOR_MINOR:=1.22\nGO_VERSION_PATCH:=4\nPKG_VERSION:=$(GO_VERSION_MAJOR_MINOR)$(if $(GO_VERSION_PATCH),.$(GO_VERSION_PATCH))\nPKG_RELEASE:=1\n',
      base: 'PKG_NAME:=golang\nGO_VERSION_MAJOR_MINOR:=1.22\nGO_VERSION_PATCH:=3\nPKG_VERSION:=$(GO_VERSION_MAJOR_MINOR)$(if $(GO_VERSION_PATCH),.$(GO_VERSION_PATCH))\nPKG_RELEASE:=1\n',
      success: 'version updated'
    },
    {
      name: 'resolves deeply nested variable references in PKG_VERSION',
      root: 'package/utils/nestedpkg',
      patch: `
diff --git a/package/utils/nestedpkg/Makefile b/package/utils/nestedpkg/Makefile
+++ b/package/utils/nestedpkg/Makefile
-VAR3:=old
+VAR3:=new
`,
      head: 'PKG_NAME:=nestedpkg\nVAR3:=new\nVAR2:=$(VAR3)\nVAR1:=$(VAR2)\nPKG_VERSION:=$(VAR1)\nPKG_RELEASE:=1\n',
      base: 'PKG_NAME:=nestedpkg\nVAR3:=old\nVAR2:=$(VAR3)\nVAR1:=$(VAR2)\nPKG_VERSION:=$(VAR1)\nPKG_RELEASE:=1\n',
      success: 'version updated'
    },
    {
      name: 'passes when python micro version variable is bumped',
      root: 'package/lang/python',
      patch: `
diff --git a/package/lang/python/Makefile b/package/lang/python/Makefile
+++ b/package/lang/python/Makefile
-PYTHON3_VERSION_MICRO:=4
+PYTHON3_VERSION_MICRO:=5
`,
      head: 'PKG_NAME:=python3\nPYTHON3_VERSION_MAJOR:=3\nPYTHON3_VERSION_MINOR:=14\nPYTHON3_VERSION_MICRO:=5\nPKG_VERSION:=$(PYTHON3_VERSION_MAJOR).$(PYTHON3_VERSION_MINOR).$(PYTHON3_VERSION_MICRO)\nPKG_RELEASE:=1\n',
      base: 'PKG_NAME:=python3\nPYTHON3_VERSION_MAJOR:=3\nPYTHON3_VERSION_MINOR:=14\nPYTHON3_VERSION_MICRO:=4\nPKG_VERSION:=$(PYTHON3_VERSION_MAJOR).$(PYTHON3_VERSION_MINOR).$(PYTHON3_VERSION_MICRO)\nPKG_RELEASE:=1\n',
      success: 'version updated'
    },
    {
      name: 'passes when a new collector sub-package is registered via an established template macro',
      root: 'utils/prometheus-node-exporter-ucode',
      patch: `
diff --git a/utils/prometheus-node-exporter-ucode/Makefile b/utils/prometheus-node-exporter-ucode/Makefile
--- a/utils/prometheus-node-exporter-ucode/Makefile
+++ b/utils/prometheus-node-exporter-ucode/Makefile
+$(eval $(call Collector,mdadm,RAID status via /proc/mdstat,))
diff --git a/utils/prometheus-node-exporter-ucode/files/extra/mdadm.uc b/utils/prometheus-node-exporter-ucode/files/extra/mdadm.uc
new file mode 100644
--- /dev/null
+++ b/utils/prometheus-node-exporter-ucode/files/extra/mdadm.uc
+// mdadm collector
`,
      head: 'PKG_NAME:=prometheus-node-exporter-ucode\nPKG_VERSION:=2024.02.07\nPKG_RELEASE:=3\n\n$(eval $(call Collector,dnsmasq,Dnsmasq collector,))\n$(eval $(call Collector,wifi,Wi-Fi collector,+ucode-mod-nl80211))\n$(eval $(call Collector,mdadm,RAID status via /proc/mdstat,))\n',
      base: 'PKG_NAME:=prometheus-node-exporter-ucode\nPKG_VERSION:=2024.02.07\nPKG_RELEASE:=3\n\n$(eval $(call Collector,dnsmasq,Dnsmasq collector,))\n$(eval $(call Collector,wifi,Wi-Fi collector,+ucode-mod-nl80211))\n',
      success: 'new sub-package via an existing template'
    },
    {
      name: 'still fails when the only template invocation is the package\'s sole/primary definition',
      root: 'utils/singlepkg',
      patch: `
diff --git a/utils/singlepkg/Makefile b/utils/singlepkg/Makefile
--- a/utils/singlepkg/Makefile
+++ b/utils/singlepkg/Makefile
+$(eval $(call BuildPackage,singlepkg))
diff --git a/utils/singlepkg/files/extra.uc b/utils/singlepkg/files/extra.uc
new file mode 100644
--- /dev/null
+++ b/utils/singlepkg/files/extra.uc
+// extra file
`,
      head: 'PKG_NAME:=singlepkg\nPKG_VERSION:=1.0\nPKG_RELEASE:=1\n\n$(eval $(call BuildPackage,singlepkg))\n',
      base: 'PKG_NAME:=singlepkg\nPKG_VERSION:=1.0\nPKG_RELEASE:=1\n',
      error: 'content changed without a PKG_RELEASE or version bump'
    },
    {
      name: 'still fails when an existing template invocation is modified rather than a new one added',
      root: 'utils/prometheus-node-exporter-ucode',
      patch: `
diff --git a/utils/prometheus-node-exporter-ucode/Makefile b/utils/prometheus-node-exporter-ucode/Makefile
--- a/utils/prometheus-node-exporter-ucode/Makefile
+++ b/utils/prometheus-node-exporter-ucode/Makefile
-$(eval $(call Collector,wifi,Wi-Fi collector,+ucode-mod-nl80211))
+$(eval $(call Collector,wifi,Wi-Fi collector,+ucode-mod-nl80211 +ucode-mod-uci))
`,
      head: 'PKG_NAME:=prometheus-node-exporter-ucode\nPKG_VERSION:=2024.02.07\nPKG_RELEASE:=3\n\n$(eval $(call Collector,dnsmasq,Dnsmasq collector,))\n$(eval $(call Collector,wifi,Wi-Fi collector,+ucode-mod-nl80211 +ucode-mod-uci))\n',
      base: 'PKG_NAME:=prometheus-node-exporter-ucode\nPKG_VERSION:=2024.02.07\nPKG_RELEASE:=3\n\n$(eval $(call Collector,dnsmasq,Dnsmasq collector,))\n$(eval $(call Collector,wifi,Wi-Fi collector,+ucode-mod-nl80211))\n',
      error: 'content changed without a PKG_RELEASE or version bump'
    }
  ];

  for (const { name, root, patch, head, base, success, error } of audits) {
    test(name, async () => {
      const res = await validatePkgReleaseBumps([{ commitPatch: patch }], defaultConf, makefileAt(root, head), makefileAt(root, base));
      if (error) {
        assertErrorIncludes(res, error);
      } else {
        assertNoErrors(res);
        assertSuccessIncludes(res, success);
      }
    });
  }

  test('skips checks when only test.sh or test-version.sh are modified', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/package/utils/bash/test.sh b/package/utils/bash/test.sh
+++ b/package/utils/bash/test.sh
+# add new tests
diff --git a/package/utils/bash/test-version.sh b/package/utils/bash/test-version.sh
+++ b/package/utils/bash/test-version.sh
+# test script updates
`
    }];
    const makefile = makefileAt('package/utils/bash', 'PKG_NAME:=bash\nPKG_VERSION:=5.2\nPKG_RELEASE:=1\n');

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, makefile, makefile);
    assertNoErrors(res);
  });

  test('states the minor-change advice once per report, not once per package', async () => {
    const pkgs = ['bash', 'dnsmasq', 'busybox'];
    const commitDetails = [{
      commitPatch: pkgs.map(p => `
diff --git a/package/utils/${p}/files/${p}.init b/package/utils/${p}/files/${p}.init
+++ b/package/utils/${p}/files/${p}.init
+exec ${p}
`).join('')
    }];
    const makefileFor = (path) => {
      const pkg = pkgs.find(p => path === `package/utils/${p}/Makefile`);
      return pkg ? `PKG_NAME:=${pkg}\nPKG_VERSION:=1.0\nPKG_RELEASE:=1\n` : null;
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, makefileFor, makefileFor);
    assert.strictEqual(res.errors.length, 3);
    assertNoErrorIncludes(res, 'Do not increment release for minor changes');
    assert.strictEqual(res.notes.length, 1);
    assert.ok(res.notes[0].includes('Do not increment release for minor changes'));
  });

  test('carries no minor-change advice when nothing tripped the bump rule', async () => {
    const res = await validatePkgReleaseBumps([{ commitPatch: '' }], defaultConf, async () => null, async () => null);
    assert.deepStrictEqual(res.notes, []);
  });

  test('groupReleaseErrors folds the missing-bump errors into one list of packages', () => {
    const { packages, others } = groupReleaseErrors([
      'Package `package/utils/bash` content changed without a PKG_RELEASE or version bump.',
      "Package `package/utils/dnsmasq` version updated from '1.0' to '1.1', but PKG_RELEASE was not reset to 1 (currently: '3')",
      'Package `package/utils/busybox` content changed without a PKG_RELEASE or version bump.'
    ]);
    assert.deepStrictEqual(packages, ['package/utils/bash', 'package/utils/busybox']);
    assert.strictEqual(others.length, 1);
    assert.ok(others[0].includes('was not reset to 1'));
  });

  test('always returns a notes array, including on the skipped paths', async () => {
    const off = await validatePkgReleaseBumps([{ commitPatch: '' }], { check_pkg_release: false }, async () => null, async () => null);
    assert.deepStrictEqual(off.notes, []);

    const many = Array.from({ length: 16 }, (_, i) => `
diff --git a/package/utils/p${i}/Makefile b/package/utils/p${i}/Makefile
+++ b/package/utils/p${i}/Makefile
+PKG_NAME:=p${i}
`).join('');
    const tooMany = await validatePkgReleaseBumps([{ commitPatch: many }], defaultConf, async () => null, async () => null);
    assertSomeIncludes(tooMany.warnings, 'audit skipped', 'warnings');
    assert.deepStrictEqual(tooMany.notes, []);
  });

  test('groupReleaseErrors leaves unrelated errors untouched', () => {
    const { packages, others } = groupReleaseErrors(['Something else entirely']);
    assert.deepStrictEqual(packages, []);
    assert.deepStrictEqual(others, ['Something else entirely']);
  });

  test('skips checks when more than 15 package roots are modified', async () => {
    let patch = '';
    for (let i = 1; i <= 16; i++) {
      patch += `
diff --git a/package/utils/pkg${i}/Makefile b/package/utils/pkg${i}/Makefile
index 123456..789012 100644
--- a/package/utils/pkg${i}/Makefile
+++ b/package/utils/pkg${i}/Makefile
`;
    }
    const commitDetails = [{ commitPatch: patch }];

    let fetchCalled = false;
    const fetchFn = async () => {
      fetchCalled = true;
      return null;
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, fetchFn, fetchFn);
    assertNoErrors(res);
    assert.strictEqual(res.successes.length, 0);
    assert.ok(res.warnings.some(w => w.includes('Package release bump audit skipped') && w.includes('16 packages')));
    assert.strictEqual(fetchCalled, false);
  });

  test('skips baseFetch call completely for new packages (avoiding unnecessary subrequests/404s)', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/package/utils/newpkg/Makefile b/package/utils/newpkg/Makefile
new file mode 100644
--- /dev/null
+++ b/package/utils/newpkg/Makefile
`
    }];
    const headFetch = makefileAt('package/utils/newpkg', 'PKG_NAME:=newpkg\nPKG_VERSION:=1.0\nPKG_RELEASE:=1\n');
    const baseFetch = async () => {
      throw new Error('baseFetch should not be called for new packages!');
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assertNoErrors(res);
    assertSuccessIncludes(res, 'correctly initializes PKG_RELEASE to 1');
  });

  test('skips headFetch call completely for deleted packages', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/package/utils/oldpkg/Makefile b/package/utils/oldpkg/Makefile
deleted file mode 100644
--- a/package/utils/oldpkg/Makefile
+++ /dev/null
`
    }];
    const headFetch = async () => {
      throw new Error('headFetch should not be called for deleted packages!');
    };
    const baseFetch = async () => 'PKG_NAME:=oldpkg\nPKG_VERSION:=1.0\nPKG_RELEASE:=1\n';

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    // Since it's deleted, it skips check, so no errors and no successes
    assertNoErrors(res);
  });

  test('handles null content for fetch base / head safely without crash', async () => {
    const commitDetails = [{
      commitPatch: `diff --git a/utils/mypkg/Makefile b/utils/mypkg/Makefile
--- a/utils/mypkg/Makefile
+++ b/utils/mypkg/Makefile
@@ -1,1 +1,2 @@
+PKG_VERSION:=2.0
+PKG_RELEASE:=2
`
    }];
    const headFetch = async () => 'PKG_VERSION:=2.0\nPKG_RELEASE:=2\n';
    const baseFetch = async () => null;

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.ok(res);
  });

  test('circular references do not cause infinite recursion', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/package/utils/circularpkg/Makefile b/package/utils/circularpkg/Makefile
+++ b/package/utils/circularpkg/Makefile
-VAR2:=val
+VAR2:=val2
`
    }];
    const makefile = makefileAt('package/utils/circularpkg', 'PKG_NAME:=circularpkg\nVAR1:=$(VAR2)\nVAR2:=$(VAR1)\nPKG_VERSION:=$(VAR1)\nPKG_RELEASE:=1\n');

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, makefile, makefile);
    assert.ok(res);
  });

  // ─── Reverts ───────────────────────────────────────────────────

  const commitWith = (subject) => makeCommit(`${subject}\n\nThis reverts commit 9fceb02d0ae598e95dc970b74767f19372d61af8.`);

  // Reverting `mypkg: update to 1.2.3` restores both the older version and the
  // PKG_RELEASE that preceded the bump.
  const versionRevertPatch = `
diff --git a/package/utils/mypkg/Makefile b/package/utils/mypkg/Makefile
--- a/package/utils/mypkg/Makefile
+++ b/package/utils/mypkg/Makefile
-PKG_VERSION:=1.2.3
+PKG_VERSION:=1.2.2
-PKG_RELEASE:=1
+PKG_RELEASE:=3
`;
  const versionRevertHead = makefileAt('package/utils/mypkg', 'PKG_NAME:=mypkg\nPKG_VERSION:=1.2.2\nPKG_RELEASE:=3\n');
  const versionRevertBase = makefileAt('package/utils/mypkg', 'PKG_NAME:=mypkg\nPKG_VERSION:=1.2.3\nPKG_RELEASE:=1\n');

  test('accepts a revert restoring an older version and its previous PKG_RELEASE', async () => {
    const commitDetails = [{ fullCommit: commitWith('mypkg: Revert "mypkg: update to 1.2.3"'), commitPatch: versionRevertPatch }];
    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, versionRevertHead, versionRevertBase);
    assertNoErrors(res);
    assertSuccessIncludes(res, 'matching its state before the reverted commit');
  });

  // The same downgrade must still demand a PKG_RELEASE reset whenever it cannot
  // be traced to a revert commit alone.
  const strictRevertAudits = [
    {
      name: 'still demands a PKG_RELEASE reset for the same downgrade in a regular commit',
      commitDetails: [{ fullCommit: commitWith('mypkg: downgrade to 1.2.2'), commitPatch: versionRevertPatch }]
    },
    {
      name: 'keeps the audit strict when no commit message is available (PR-wide patch fallback)',
      commitDetails: [{ commitPatch: versionRevertPatch }]
    },
    {
      name: 'keeps the audit strict when allow_revert is disabled',
      commitDetails: [{ fullCommit: commitWith('mypkg: Revert "mypkg: update to 1.2.3"'), commitPatch: versionRevertPatch }],
      conf: { ...defaultConf, allow_revert: false }
    },
    {
      name: 'keeps the audit strict when the body does not reference the reverted commit',
      commitDetails: [{
        fullCommit: makeCommit('mypkg: Revert "mypkg: update to 1.2.3"\n\nIt broke the build.'),
        commitPatch: versionRevertPatch
      }]
    },
    {
      name: 'keeps the audit strict when a regular commit touches the same package',
      commitDetails: [
        { fullCommit: commitWith('mypkg: Revert "mypkg: update to 1.2.3"'), commitPatch: versionRevertPatch },
        {
          fullCommit: makeCommit('mypkg: refresh patches'),
          commitPatch: `
diff --git a/package/utils/mypkg/patches/001-fix.patch b/package/utils/mypkg/patches/001-fix.patch
--- a/package/utils/mypkg/patches/001-fix.patch
+++ b/package/utils/mypkg/patches/001-fix.patch
+context
`
        }
      ]
    }
  ];

  for (const { name, commitDetails, conf = defaultConf } of strictRevertAudits) {
    test(name, async () => {
      const res = await validatePkgReleaseBumps(commitDetails, conf, versionRevertHead, versionRevertBase);
      assertErrorIncludes(res, 'PKG_RELEASE was not reset to 1');
    });
  }

  test('accepts a revert restoring a dropped package with its previous PKG_RELEASE', async () => {
    const commitDetails = [{
      fullCommit: commitWith('Revert "oldpkg: remove abandoned package"'),
      commitPatch: `
diff --git a/package/utils/oldpkg/Makefile b/package/utils/oldpkg/Makefile
new file mode 100644
--- /dev/null
+++ b/package/utils/oldpkg/Makefile
`
    }];
    const headFetch = makefileAt('package/utils/oldpkg', 'PKG_NAME:=oldpkg\nPKG_VERSION:=2.0\nPKG_RELEASE:=5\n');

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, async () => null);
    assertNoErrors(res);
    assertSuccessIncludes(res, 'restored by a revert with its previous PKG_RELEASE');
  });

  test('still requires a bump when a revert changes content without touching version or release', async () => {
    const commitDetails = [{
      fullCommit: commitWith('Revert "mypkg: tweak init script"'),
      commitPatch: `
diff --git a/package/utils/mypkg/files/mypkg.init b/package/utils/mypkg/files/mypkg.init
--- a/package/utils/mypkg/files/mypkg.init
+++ b/package/utils/mypkg/files/mypkg.init
+start_service() {
`
    }];
    const makefile = makefileAt('package/utils/mypkg', 'PKG_NAME:=mypkg\nPKG_VERSION:=1.2.2\nPKG_RELEASE:=3\n');

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, makefile, makefile);
    assertErrorIncludes(res, 'content changed without a PKG_RELEASE or version bump');
  });
});

describe('validatePkgReleaseBumps lookups', () => {
  test('asks for the head and base Makefile at the same time', async () => {
    const patch = `diff --git a/utils/mypkg/Makefile b/utils/mypkg/Makefile
--- a/utils/mypkg/Makefile
+++ b/utils/mypkg/Makefile
@@ -1,3 +1,3 @@
 PKG_NAME:=mypkg
-PKG_RELEASE:=1
+PKG_RELEASE:=2
 PKG_LICENSE:=MIT
`;
    const inFlight = new Set();
    let overlapped = false;
    const lookup = (kind, content) => async () => {
      inFlight.add(kind);
      if (inFlight.has('head') && inFlight.has('base')) overlapped = true;
      await new Promise(resolve => setTimeout(resolve, 1));
      inFlight.delete(kind);
      return content;
    };
    const res = await validatePkgReleaseBumps(
      [{ commitPatch: patch, fullCommit: makeCommit('mypkg: bump release') }],
      CONFIG,
      lookup('head', 'PKG_NAME:=mypkg\nPKG_RELEASE:=2\nPKG_LICENSE:=MIT\n'),
      lookup('base', 'PKG_NAME:=mypkg\nPKG_RELEASE:=1\nPKG_LICENSE:=MIT\n')
    );
    assert.ok(overlapped, 'the base lookup must not wait for the head lookup to finish');
    assertNoErrors(res);
  });
});
