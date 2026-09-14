import { describe, test } from 'node:test';
import assert from 'node:assert';
import { validatePkgReleaseBumps, groupReleaseErrors } from '../../src/validators.js';
import { CONFIG } from './helpers.js';

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
    assert.strictEqual(res.errors.length, 0);
  });

  test('passes for new package with release 1', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/package/utils/newpkg/Makefile b/package/utils/newpkg/Makefile
new file mode 100644
--- /dev/null
+++ b/package/utils/newpkg/Makefile
`
    }];
    const headFetch = async (path) => {
      if (path === 'package/utils/newpkg/Makefile') {
        return 'PKG_NAME:=newpkg\nPKG_VERSION:=1.0\nPKG_RELEASE:=1\n';
      }
      return null;
    };
    const baseFetch = async () => null; // didn't exist

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.strictEqual(res.errors.length, 0);
    assert.ok(res.successes.some(s => s.includes('correctly initializes PKG_RELEASE to 1')));
  });

  test('fails for new package with release not 1', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/package/utils/newpkg/Makefile b/package/utils/newpkg/Makefile
new file mode 100644
--- /dev/null
+++ b/package/utils/newpkg/Makefile
`
    }];
    const headFetch = async (path) => {
      if (path === 'package/utils/newpkg/Makefile') {
        return 'PKG_NAME:=newpkg\nPKG_VERSION:=1.0\nPKG_RELEASE:=2\n';
      }
      return null;
    };
    const baseFetch = async () => null;

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.ok(res.errors.some(e => e.includes('must start with PKG_RELEASE set to 1')));
  });

  test('passes when existing package modified and PKG_RELEASE bumped', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/package/utils/bash/files/bash.init b/package/utils/bash/files/bash.init
+++ b/package/utils/bash/files/bash.init
+# tweak init
diff --git a/package/utils/bash/Makefile b/package/utils/bash/Makefile
+++ b/package/utils/bash/Makefile
-PKG_RELEASE:=1
+PKG_RELEASE:=2
`
    }];
    const headFetch = async (path) => {
      if (path === 'package/utils/bash/Makefile') {
        return 'PKG_NAME:=bash\nPKG_VERSION:=5.2\nPKG_RELEASE:=2\n';
      }
      return null;
    };
    const baseFetch = async (path) => {
      if (path === 'package/utils/bash/Makefile') {
        return 'PKG_NAME:=bash\nPKG_VERSION:=5.2\nPKG_RELEASE:=1\n';
      }
      return null;
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.strictEqual(res.errors.length, 0);
    assert.ok(res.successes.some(s => s.includes('PKG_RELEASE bumped')));
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
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
    assert.ok(!res.successes.some(s => s.includes('version updated')), `Successes: ${res.successes.join(', ')}`);
    assert.ok(res.successes.some(s => s.includes("PKG_RELEASE bumped from '1' to '2'")), `Successes: ${res.successes.join(', ')}`);
  });

  test('still reports a missing bump when only base.sha drifted and the PR bumped nothing', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/package/utils/bash/files/bash.init b/package/utils/bash/files/bash.init
+++ b/package/utils/bash/files/bash.init
+exec bash -l
`
    }];
    // Content changed, nothing bumped by the PR - the phantom version delta
    // from the drifted base must not silently satisfy the bump requirement.
    const headFetch = async (path) => path === 'package/utils/bash/Makefile'
      ? 'PKG_NAME:=bash\nPKG_VERSION:=5.2\nPKG_RELEASE:=1\n' : null;
    const baseFetch = async (path) => path === 'package/utils/bash/Makefile'
      ? 'PKG_NAME:=bash\nPKG_VERSION:=5.3\nPKG_RELEASE:=1\n' : null;

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.ok(res.errors.some(e => e.includes('content changed without a PKG_RELEASE or version bump')), `Errors: ${res.errors.join(', ')}`);
  });

  test('fails when existing package files modified but PKG_RELEASE or version is not bumped', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/package/utils/bash/files/bash.init b/package/utils/bash/files/bash.init
+++ b/package/utils/bash/files/bash.init
+exec bash
`
    }];
    const headFetch = async (path) => {
      if (path === 'package/utils/bash/Makefile') {
        return 'PKG_NAME:=bash\nPKG_VERSION:=5.2\nPKG_RELEASE:=1\n';
      }
      return null;
    };
    const baseFetch = async (path) => {
      if (path === 'package/utils/bash/Makefile') {
        return 'PKG_NAME:=bash\nPKG_VERSION:=5.2\nPKG_RELEASE:=1\n';
      }
      return null;
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.ok(res.errors.some(e => e.includes('content changed without a PKG_RELEASE or version bump')));
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
    assert.ok(!res.errors.some(e => e.includes('Do not increment release for minor changes')));
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
    assert.ok(tooMany.warnings.some(w => w.includes('audit skipped')));
    assert.deepStrictEqual(tooMany.notes, []);
  });

  test('groupReleaseErrors leaves unrelated errors untouched', () => {
    const { packages, others } = groupReleaseErrors(['Something else entirely']);
    assert.deepStrictEqual(packages, []);
    assert.deepStrictEqual(others, ['Something else entirely']);
  });

  test('passes when u-boot.mk based package Makefile changes non-cosmetically without PKG_RELEASE', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/package/boot/uboot-testboard/Makefile b/package/boot/uboot-testboard/Makefile
--- a/package/boot/uboot-testboard/Makefile
+++ b/package/boot/uboot-testboard/Makefile
+  HIDDEN:=1
`
    }];
    const headFetch = async (path) => {
      if (path === 'package/boot/uboot-testboard/Makefile') {
        return 'PKG_NAME:=uboot-testboard\nPKG_VERSION:=2026.07\ninclude $(INCLUDE_DIR)/u-boot.mk\n\ndefine U-Boot/Default\n  HIDDEN:=1\nendef\n';
      }
      return null;
    };
    const baseFetch = async (path) => {
      if (path === 'package/boot/uboot-testboard/Makefile') {
        return 'PKG_NAME:=uboot-testboard\nPKG_VERSION:=2026.07\ninclude $(INCLUDE_DIR)/u-boot.mk\n\ndefine U-Boot/Default\nendef\n';
      }
      return null;
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.strictEqual(res.errors.length, 0);
    assert.ok(res.successes.some(s => s.includes('shared build helper')));
  });

  test('still fails for non-u-boot package with no PKG_RELEASE and non-cosmetic changes', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/package/utils/bash/Makefile b/package/utils/bash/Makefile
--- a/package/utils/bash/Makefile
+++ b/package/utils/bash/Makefile
+SOME_NEW_BUILD_FLAG:=1
`
    }];
    const headFetch = async (path) => {
      if (path === 'package/utils/bash/Makefile') {
        return 'PKG_NAME:=bash\nPKG_VERSION:=5.2\nSOME_NEW_BUILD_FLAG:=1\n';
      }
      return null;
    };
    const baseFetch = async (path) => {
      if (path === 'package/utils/bash/Makefile') {
        return 'PKG_NAME:=bash\nPKG_VERSION:=5.2\n';
      }
      return null;
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.ok(res.errors.some(e => e.includes('content changed without a PKG_RELEASE or version bump')));
  });

  test('passes when tools/ package without PKG_RELEASE updates its version', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/tools/meson/Makefile b/tools/meson/Makefile
--- a/tools/meson/Makefile
+++ b/tools/meson/Makefile
-PKG_VERSION:=1.6.1
+PKG_VERSION:=1.11.2
`
    }];
    const headFetch = async (path) => {
      if (path === 'tools/meson/Makefile') {
        return 'PKG_NAME:=meson\nPKG_VERSION:=1.11.2\n';
      }
      return null;
    };
    const baseFetch = async (path) => {
      if (path === 'tools/meson/Makefile') {
        return 'PKG_NAME:=meson\nPKG_VERSION:=1.6.1\n';
      }
      return null;
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.strictEqual(res.errors.length, 0);
    assert.ok(res.successes.some(s => s.includes('host-side build tools without PKG_RELEASE')));
  });

  test('still fails when tools/ package that adopted PKG_RELEASE updates version without resetting it', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/tools/squashfs4/Makefile b/tools/squashfs4/Makefile
--- a/tools/squashfs4/Makefile
+++ b/tools/squashfs4/Makefile
-PKG_VERSION:=4.7.4
+PKG_VERSION:=4.7.5
`
    }];
    const headFetch = async (path) => {
      if (path === 'tools/squashfs4/Makefile') {
        return 'PKG_NAME:=squashfs4\nPKG_VERSION:=4.7.5\nPKG_RELEASE:=2\n';
      }
      return null;
    };
    const baseFetch = async (path) => {
      if (path === 'tools/squashfs4/Makefile') {
        return 'PKG_NAME:=squashfs4\nPKG_VERSION:=4.7.4\nPKG_RELEASE:=2\n';
      }
      return null;
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.ok(res.errors.some(e => e.includes('was not reset to 1')));
  });

  test('passes when tools/ package drops PKG_RELEASE while updating its version', async () => {
    // Accepted OpenWrt practice, see upstream cbf8c76d0a "tools/meson:
    // update to 1.2.1" - the exemption must not require base to lack
    // PKG_RELEASE too.
    const commitDetails = [{
      commitPatch: `
diff --git a/tools/meson/Makefile b/tools/meson/Makefile
--- a/tools/meson/Makefile
+++ b/tools/meson/Makefile
-PKG_VERSION:=1.1.1
-PKG_RELEASE:=2
+PKG_VERSION:=1.2.1
`
    }];
    const headFetch = async (path) => {
      if (path === 'tools/meson/Makefile') {
        return 'PKG_NAME:=meson\nPKG_VERSION:=1.2.1\n';
      }
      return null;
    };
    const baseFetch = async (path) => {
      if (path === 'tools/meson/Makefile') {
        return 'PKG_NAME:=meson\nPKG_VERSION:=1.1.1\nPKG_RELEASE:=2\n';
      }
      return null;
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.strictEqual(res.errors.length, 0);
    assert.ok(res.successes.some(s => s.includes('host-side build tools without PKG_RELEASE')));
  });

  test('passes when tools/ package without PKG_RELEASE changes patches only', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/toolchain/musl/patches/010-fix.patch b/toolchain/musl/patches/010-fix.patch
--- a/toolchain/musl/patches/010-fix.patch
+++ b/toolchain/musl/patches/010-fix.patch
+-void broken(void);
++void fixed(void);
`
    }];
    const fetchMakefile = async (path) => {
      if (path === 'toolchain/musl/Makefile') {
        return 'PKG_NAME:=musl\nPKG_VERSION:=1.2.5\n';
      }
      return null;
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, fetchMakefile, fetchMakefile);
    assert.strictEqual(res.errors.length, 0);
    assert.ok(res.successes.some(s => s.includes('host-side build tool')));
  });

  test('passes for new tools/ package without PKG_RELEASE', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/tools/newtool/Makefile b/tools/newtool/Makefile
new file mode 100644
--- /dev/null
+++ b/tools/newtool/Makefile
`
    }];
    const headFetch = async (path) => {
      if (path === 'tools/newtool/Makefile') {
        return 'PKG_NAME:=newtool\nPKG_VERSION:=1.0\n';
      }
      return null;
    };
    const baseFetch = async () => null;

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.strictEqual(res.errors.length, 0);
    assert.ok(res.successes.some(s => s.includes('host-side build tool')));
  });

  test('passes when existing package files modified with only cosmetic changes', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/package/utils/bash/files/bash.init b/package/utils/bash/files/bash.init
+++ b/package/utils/bash/files/bash.init
+# just a comment edit
+
`
    }];
    const headFetch = async (path) => {
      if (path === 'package/utils/bash/Makefile') {
        return 'PKG_NAME:=bash\nPKG_VERSION:=5.2\nPKG_RELEASE:=1\n';
      }
      return null;
    };
    const baseFetch = async (path) => {
      if (path === 'package/utils/bash/Makefile') {
        return 'PKG_NAME:=bash\nPKG_VERSION:=5.2\nPKG_RELEASE:=1\n';
      }
      return null;
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.strictEqual(res.errors.length, 0);
    assert.ok(res.successes.some(s => s.includes('only minor/cosmetic updates')));
  });

  test('passes when Makefile modified with only minor metadata and download updates', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/package/utils/bash/Makefile b/package/utils/bash/Makefile
--- a/package/utils/bash/Makefile
+++ b/package/utils/bash/Makefile
-PKG_MAINTAINER:=Old Maintainer
+PKG_MAINTAINER:=New Maintainer
-PKG_SOURCE_URL:=http://oldurl
+PKG_SOURCE_URL:=https://newurl
-PKG_HASH:=1234
+PKG_HASH:=5678
`
    }];
    const headFetch = async (path) => {
      if (path === 'package/utils/bash/Makefile') {
        return 'PKG_NAME:=bash\nPKG_VERSION:=5.2\nPKG_RELEASE:=1\n';
      }
      return null;
    };
    const baseFetch = async (path) => {
      if (path === 'package/utils/bash/Makefile') {
        return 'PKG_NAME:=bash\nPKG_VERSION:=5.2\nPKG_RELEASE:=1\n';
      }
      return null;
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.strictEqual(res.errors.length, 0);
    assert.ok(res.successes.some(s => s.includes('only minor/cosmetic updates')));
  });

  test('passes when version updated and PKG_RELEASE reset to 1', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/package/utils/bash/Makefile b/package/utils/bash/Makefile
+++ b/package/utils/bash/Makefile
-PKG_VERSION:=5.2
+PKG_VERSION:=5.3
`
    }];
    const headFetch = async (path) => {
      if (path === 'package/utils/bash/Makefile') {
        return 'PKG_NAME:=bash\nPKG_VERSION:=5.3\nPKG_RELEASE:=1\n';
      }
      return null;
    };
    const baseFetch = async (path) => {
      if (path === 'package/utils/bash/Makefile') {
        return 'PKG_NAME:=bash\nPKG_VERSION:=5.2\nPKG_RELEASE:=3\n';
      }
      return null;
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.strictEqual(res.errors.length, 0);
    assert.ok(res.successes.some(s => s.includes('version updated to \'5.3\' and PKG_RELEASE correctly reset to 1')));
  });

  test('fails when version updated but PKG_RELEASE is not reset to 1', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/package/utils/bash/Makefile b/package/utils/bash/Makefile
+++ b/package/utils/bash/Makefile
-PKG_VERSION:=5.2
+PKG_VERSION:=5.3
`
    }];
    const headFetch = async (path) => {
      if (path === 'package/utils/bash/Makefile') {
        return 'PKG_NAME:=bash\nPKG_VERSION:=5.3\nPKG_RELEASE:=2\n';
      }
      return null;
    };
    const baseFetch = async (path) => {
      if (path === 'package/utils/bash/Makefile') {
        return 'PKG_NAME:=bash\nPKG_VERSION:=5.2\nPKG_RELEASE:=3\n';
      }
      return null;
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.ok(res.errors.some(e => e.includes('but PKG_RELEASE was not reset to 1')));
  });

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
    const headFetch = async (path) => {
      if (path === 'package/utils/bash/Makefile') {
        return 'PKG_NAME:=bash\nPKG_VERSION:=5.2\nPKG_RELEASE:=1\n';
      }
      return null;
    };
    const baseFetch = async (path) => {
      if (path === 'package/utils/bash/Makefile') {
        return 'PKG_NAME:=bash\nPKG_VERSION:=5.2\nPKG_RELEASE:=1\n';
      }
      return null;
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
  });

  test('supports package/<pkg>/... layout directly without category prefix', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/package/iozone/files/iozone.init b/package/iozone/files/iozone.init
+++ b/package/iozone/files/iozone.init
+# modified config
diff --git a/package/iozone/Makefile b/package/iozone/Makefile
+++ b/package/iozone/Makefile
-PKG_RELEASE:=1
+PKG_RELEASE:=2
`
    }];
    const headFetch = async (path) => {
      if (path === 'package/iozone/Makefile') {
        return 'PKG_NAME:=iozone\nPKG_VERSION:=4.0\nPKG_RELEASE:=2\n';
      }
      return null;
    };
    const baseFetch = async (path) => {
      if (path === 'package/iozone/Makefile') {
        return 'PKG_NAME:=iozone\nPKG_VERSION:=4.0\nPKG_RELEASE:=1\n';
      }
      return null;
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
    assert.ok(res.successes.some(s => s.includes('version unchanged, but PKG_RELEASE bumped')));
  });

  test('supports deeply nested layouts like luci/libs/<pkg>/...', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/luci/libs/luci-lib-uqr/patches/001-fix.patch b/luci/libs/luci-lib-uqr/patches/001-fix.patch
+++ b/luci/libs/luci-lib-uqr/patches/001-fix.patch
+# patch file contents
diff --git a/luci/libs/luci-lib-uqr/Makefile b/luci/libs/luci-lib-uqr/Makefile
+++ b/luci/libs/luci-lib-uqr/Makefile
-PKG_RELEASE:=1
+PKG_RELEASE:=2
`
    }];
    const headFetch = async (path) => {
      if (path === 'luci/libs/luci-lib-uqr/Makefile') {
        return 'PKG_NAME:=luci-lib-uqr\nPKG_VERSION:=1.0\nPKG_RELEASE:=2\n';
      }
      return null;
    };
    const baseFetch = async (path) => {
      if (path === 'luci/libs/luci-lib-uqr/Makefile') {
        return 'PKG_NAME:=luci-lib-uqr\nPKG_VERSION:=1.0\nPKG_RELEASE:=1\n';
      }
      return null;
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
    assert.ok(res.successes.some(s => s.includes('version unchanged, but PKG_RELEASE bumped')));
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
    assert.strictEqual(res.errors.length, 0);
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
    const headFetch = async (path) => {
      if (path === 'package/utils/newpkg/Makefile') {
        return 'PKG_NAME:=newpkg\nPKG_VERSION:=1.0\nPKG_RELEASE:=1\n';
      }
      return null;
    };
    const baseFetch = async () => {
      throw new Error('baseFetch should not be called for new packages!');
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.strictEqual(res.errors.length, 0);
    assert.ok(res.successes.some(s => s.includes('correctly initializes PKG_RELEASE to 1')));
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
    const baseFetch = async () => {
      return 'PKG_NAME:=oldpkg\nPKG_VERSION:=1.0\nPKG_RELEASE:=1\n';
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    // Since it's deleted, it skips check, so no errors and no successes
    assert.strictEqual(res.errors.length, 0);
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

  test('passes when nested version variable (e.g. GO_VERSION_PATCH) is bumped', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/package/utils/golang/Makefile b/package/utils/golang/Makefile
+++ b/package/utils/golang/Makefile
-GO_VERSION_PATCH:=3
+GO_VERSION_PATCH:=4
`
    }];
    const headFetch = async (path) => {
      if (path === 'package/utils/golang/Makefile') {
        return 'PKG_NAME:=golang\nGO_VERSION_MAJOR_MINOR:=1.22\nGO_VERSION_PATCH:=4\nPKG_VERSION:=$(GO_VERSION_MAJOR_MINOR)$(if $(GO_VERSION_PATCH),.$(GO_VERSION_PATCH))\nPKG_RELEASE:=1\n';
      }
      return null;
    };
    const baseFetch = async (path) => {
      if (path === 'package/utils/golang/Makefile') {
        return 'PKG_NAME:=golang\nGO_VERSION_MAJOR_MINOR:=1.22\nGO_VERSION_PATCH:=3\nPKG_VERSION:=$(GO_VERSION_MAJOR_MINOR)$(if $(GO_VERSION_PATCH),.$(GO_VERSION_PATCH))\nPKG_RELEASE:=1\n';
      }
      return null;
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.strictEqual(res.errors.length, 0);
    assert.ok(res.successes.some(s => s.includes('version updated')));
  });

  test('resolves deeply nested variable references in PKG_VERSION', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/package/utils/nestedpkg/Makefile b/package/utils/nestedpkg/Makefile
+++ b/package/utils/nestedpkg/Makefile
-VAR3:=old
+VAR3:=new
`
    }];
    const headFetch = async (path) => {
      if (path === 'package/utils/nestedpkg/Makefile') {
        return 'PKG_NAME:=nestedpkg\nVAR3:=new\nVAR2:=$(VAR3)\nVAR1:=$(VAR2)\nPKG_VERSION:=$(VAR1)\nPKG_RELEASE:=1\n';
      }
      return null;
    };
    const baseFetch = async (path) => {
      if (path === 'package/utils/nestedpkg/Makefile') {
        return 'PKG_NAME:=nestedpkg\nVAR3:=old\nVAR2:=$(VAR3)\nVAR1:=$(VAR2)\nPKG_VERSION:=$(VAR1)\nPKG_RELEASE:=1\n';
      }
      return null;
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.strictEqual(res.errors.length, 0);
    assert.ok(res.successes.some(s => s.includes('version updated')));
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
    const headFetch = async (path) => {
      if (path === 'package/utils/circularpkg/Makefile') {
        return 'PKG_NAME:=circularpkg\nVAR1:=$(VAR2)\nVAR2:=$(VAR1)\nPKG_VERSION:=$(VAR1)\nPKG_RELEASE:=1\n';
      }
      return null;
    };
    const baseFetch = async (path) => {
      if (path === 'package/utils/circularpkg/Makefile') {
        return 'PKG_NAME:=circularpkg\nVAR1:=$(VAR2)\nVAR2:=$(VAR1)\nPKG_VERSION:=$(VAR1)\nPKG_RELEASE:=1\n';
      }
      return null;
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.ok(res);
  });

  test('passes when python micro version variable is bumped', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/package/lang/python/Makefile b/package/lang/python/Makefile
+++ b/package/lang/python/Makefile
-PYTHON3_VERSION_MICRO:=4
+PYTHON3_VERSION_MICRO:=5
`
    }];
    const headFetch = async (path) => {
      if (path === 'package/lang/python/Makefile') {
        return 'PKG_NAME:=python3\nPYTHON3_VERSION_MAJOR:=3\nPYTHON3_VERSION_MINOR:=14\nPYTHON3_VERSION_MICRO:=5\nPKG_VERSION:=$(PYTHON3_VERSION_MAJOR).$(PYTHON3_VERSION_MINOR).$(PYTHON3_VERSION_MICRO)\nPKG_RELEASE:=1\n';
      }
      return null;
    };
    const baseFetch = async (path) => {
      if (path === 'package/lang/python/Makefile') {
        return 'PKG_NAME:=python3\nPYTHON3_VERSION_MAJOR:=3\nPYTHON3_VERSION_MINOR:=14\nPYTHON3_VERSION_MICRO:=4\nPKG_VERSION:=$(PYTHON3_VERSION_MAJOR).$(PYTHON3_VERSION_MINOR).$(PYTHON3_VERSION_MICRO)\nPKG_RELEASE:=1\n';
      }
      return null;
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.strictEqual(res.errors.length, 0);
    assert.ok(res.successes.some(s => s.includes('version updated')));
  });

  test('passes when a new collector sub-package is registered via an established template macro', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/utils/prometheus-node-exporter-ucode/Makefile b/utils/prometheus-node-exporter-ucode/Makefile
--- a/utils/prometheus-node-exporter-ucode/Makefile
+++ b/utils/prometheus-node-exporter-ucode/Makefile
+$(eval $(call Collector,mdadm,RAID status via /proc/mdstat,))
diff --git a/utils/prometheus-node-exporter-ucode/files/extra/mdadm.uc b/utils/prometheus-node-exporter-ucode/files/extra/mdadm.uc
new file mode 100644
--- /dev/null
+++ b/utils/prometheus-node-exporter-ucode/files/extra/mdadm.uc
+// mdadm collector
`
    }];
    const headFetch = async (path) => {
      if (path === 'utils/prometheus-node-exporter-ucode/Makefile') {
        return 'PKG_NAME:=prometheus-node-exporter-ucode\nPKG_VERSION:=2024.02.07\nPKG_RELEASE:=3\n\n$(eval $(call Collector,dnsmasq,Dnsmasq collector,))\n$(eval $(call Collector,wifi,Wi-Fi collector,+ucode-mod-nl80211))\n$(eval $(call Collector,mdadm,RAID status via /proc/mdstat,))\n';
      }
      return null;
    };
    const baseFetch = async (path) => {
      if (path === 'utils/prometheus-node-exporter-ucode/Makefile') {
        return 'PKG_NAME:=prometheus-node-exporter-ucode\nPKG_VERSION:=2024.02.07\nPKG_RELEASE:=3\n\n$(eval $(call Collector,dnsmasq,Dnsmasq collector,))\n$(eval $(call Collector,wifi,Wi-Fi collector,+ucode-mod-nl80211))\n';
      }
      return null;
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
    assert.ok(res.successes.some(s => s.includes('new sub-package via an existing template')));
  });

  test('still fails when the only template invocation is the package\'s sole/primary definition', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/utils/singlepkg/Makefile b/utils/singlepkg/Makefile
--- a/utils/singlepkg/Makefile
+++ b/utils/singlepkg/Makefile
+$(eval $(call BuildPackage,singlepkg))
diff --git a/utils/singlepkg/files/extra.uc b/utils/singlepkg/files/extra.uc
new file mode 100644
--- /dev/null
+++ b/utils/singlepkg/files/extra.uc
+// extra file
`
    }];
    const headFetch = async (path) => {
      if (path === 'utils/singlepkg/Makefile') {
        return 'PKG_NAME:=singlepkg\nPKG_VERSION:=1.0\nPKG_RELEASE:=1\n\n$(eval $(call BuildPackage,singlepkg))\n';
      }
      return null;
    };
    const baseFetch = async (path) => {
      if (path === 'utils/singlepkg/Makefile') {
        return 'PKG_NAME:=singlepkg\nPKG_VERSION:=1.0\nPKG_RELEASE:=1\n';
      }
      return null;
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.ok(res.errors.some(e => e.includes('content changed without a PKG_RELEASE or version bump')));
  });

  test('still fails when an existing template invocation is modified rather than a new one added', async () => {
    const commitDetails = [{
      commitPatch: `
diff --git a/utils/prometheus-node-exporter-ucode/Makefile b/utils/prometheus-node-exporter-ucode/Makefile
--- a/utils/prometheus-node-exporter-ucode/Makefile
+++ b/utils/prometheus-node-exporter-ucode/Makefile
-$(eval $(call Collector,wifi,Wi-Fi collector,+ucode-mod-nl80211))
+$(eval $(call Collector,wifi,Wi-Fi collector,+ucode-mod-nl80211 +ucode-mod-uci))
`
    }];
    const headFetch = async (path) => {
      if (path === 'utils/prometheus-node-exporter-ucode/Makefile') {
        return 'PKG_NAME:=prometheus-node-exporter-ucode\nPKG_VERSION:=2024.02.07\nPKG_RELEASE:=3\n\n$(eval $(call Collector,dnsmasq,Dnsmasq collector,))\n$(eval $(call Collector,wifi,Wi-Fi collector,+ucode-mod-nl80211 +ucode-mod-uci))\n';
      }
      return null;
    };
    const baseFetch = async (path) => {
      if (path === 'utils/prometheus-node-exporter-ucode/Makefile') {
        return 'PKG_NAME:=prometheus-node-exporter-ucode\nPKG_VERSION:=2024.02.07\nPKG_RELEASE:=3\n\n$(eval $(call Collector,dnsmasq,Dnsmasq collector,))\n$(eval $(call Collector,wifi,Wi-Fi collector,+ucode-mod-nl80211))\n';
      }
      return null;
    };

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, baseFetch);
    assert.ok(res.errors.some(e => e.includes('content changed without a PKG_RELEASE or version bump')));
  });

  // ─── Reverts ───────────────────────────────────────────────────

  const commitWith = (subject) => ({ commit: { message: `${subject}\n\nThis reverts commit 9fceb02d0ae598e95dc970b74767f19372d61af8.` } });

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
  const versionRevertHead = async (path) =>
    path === 'package/utils/mypkg/Makefile' ? 'PKG_NAME:=mypkg\nPKG_VERSION:=1.2.2\nPKG_RELEASE:=3\n' : null;
  const versionRevertBase = async (path) =>
    path === 'package/utils/mypkg/Makefile' ? 'PKG_NAME:=mypkg\nPKG_VERSION:=1.2.3\nPKG_RELEASE:=1\n' : null;

  test('accepts a revert restoring an older version and its previous PKG_RELEASE', async () => {
    const commitDetails = [{ fullCommit: commitWith('mypkg: Revert "mypkg: update to 1.2.3"'), commitPatch: versionRevertPatch }];
    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, versionRevertHead, versionRevertBase);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
    assert.ok(res.successes.some(s => s.includes('matching its state before the reverted commit')));
  });

  test('still demands a PKG_RELEASE reset for the same downgrade in a regular commit', async () => {
    const commitDetails = [{ fullCommit: commitWith('mypkg: downgrade to 1.2.2'), commitPatch: versionRevertPatch }];
    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, versionRevertHead, versionRevertBase);
    assert.ok(res.errors.some(e => e.includes('PKG_RELEASE was not reset to 1')));
  });

  test('keeps the audit strict when no commit message is available (PR-wide patch fallback)', async () => {
    const commitDetails = [{ commitPatch: versionRevertPatch }];
    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, versionRevertHead, versionRevertBase);
    assert.ok(res.errors.some(e => e.includes('PKG_RELEASE was not reset to 1')));
  });

  test('keeps the audit strict when allow_revert is disabled', async () => {
    const commitDetails = [{ fullCommit: commitWith('mypkg: Revert "mypkg: update to 1.2.3"'), commitPatch: versionRevertPatch }];
    const res = await validatePkgReleaseBumps(commitDetails, { ...defaultConf, allow_revert: false }, versionRevertHead, versionRevertBase);
    assert.ok(res.errors.some(e => e.includes('PKG_RELEASE was not reset to 1')));
  });

  test('keeps the audit strict when the body does not reference the reverted commit', async () => {
    const commitDetails = [{
      fullCommit: { commit: { message: 'mypkg: Revert "mypkg: update to 1.2.3"\n\nIt broke the build.' } },
      commitPatch: versionRevertPatch
    }];
    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, versionRevertHead, versionRevertBase);
    assert.ok(res.errors.some(e => e.includes('PKG_RELEASE was not reset to 1')));
  });

  test('keeps the audit strict when a regular commit touches the same package', async () => {
    const commitDetails = [
      { fullCommit: commitWith('mypkg: Revert "mypkg: update to 1.2.3"'), commitPatch: versionRevertPatch },
      {
        fullCommit: { commit: { message: 'mypkg: refresh patches' } },
        commitPatch: `
diff --git a/package/utils/mypkg/patches/001-fix.patch b/package/utils/mypkg/patches/001-fix.patch
--- a/package/utils/mypkg/patches/001-fix.patch
+++ b/package/utils/mypkg/patches/001-fix.patch
+context
`
      }
    ];
    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, versionRevertHead, versionRevertBase);
    assert.ok(res.errors.some(e => e.includes('PKG_RELEASE was not reset to 1')));
  });

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
    const headFetch = async (path) =>
      path === 'package/utils/oldpkg/Makefile' ? 'PKG_NAME:=oldpkg\nPKG_VERSION:=2.0\nPKG_RELEASE:=5\n' : null;

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, async () => null);
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
    assert.ok(res.successes.some(s => s.includes('restored by a revert with its previous PKG_RELEASE')));
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
    const headFetch = async (path) =>
      path === 'package/utils/mypkg/Makefile' ? 'PKG_NAME:=mypkg\nPKG_VERSION:=1.2.2\nPKG_RELEASE:=3\n' : null;

    const res = await validatePkgReleaseBumps(commitDetails, defaultConf, headFetch, headFetch);
    assert.ok(res.errors.some(e => e.includes('content changed without a PKG_RELEASE or version bump')));
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
      [{ commitPatch: patch, fullCommit: { commit: { message: 'mypkg: bump release' } } }],
      CONFIG,
      lookup('head', 'PKG_NAME:=mypkg\nPKG_RELEASE:=2\nPKG_LICENSE:=MIT\n'),
      lookup('base', 'PKG_NAME:=mypkg\nPKG_RELEASE:=1\nPKG_LICENSE:=MIT\n')
    );
    assert.ok(overlapped, 'the base lookup must not wait for the head lookup to finish');
    assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join(', ')}`);
  });
});
