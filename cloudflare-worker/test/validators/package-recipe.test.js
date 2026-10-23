import { describe, test } from 'node:test';
import assert from 'node:assert';
import * as validators from '../../src/validators.js';
import { validateMakefileContext, collectPackageMakefiles } from '../../src/validators.js';
import {
  CONFIG, makeCommit, existingPackage, diff, modified, removed, gitAdded, gitModified,
  assertNoErrors, assertErrorIncludes, assertNoErrorIncludes
} from './helpers.js';

// Every check that reads a Makefile as a package recipe, switched on.
const ALL = { ...CONFIG, check_space_after_assignment: true, check_missing_colon: true, check_makefile_indentation: true };

const validate = (message, patch, state = existingPackage(), repo = 'openwrt/openwrt') =>
  validateMakefileContext(makeCommit(message), patch, ALL, state, repo);

const gitRemoved = (path) => [`diff --git a/${path} b/${path}`, 'deleted file mode 100644', ...removed(path)];

// A kernel package recipe, the way package/kernel/* writes one.
const kmodRecipe = (dir, { maintainer = true, release = '+PKG_RELEASE:=1' } = {}) => [
  gitAdded(`${dir}/Makefile`),
  '@@ -0,0 +1,18 @@',
  '+include $(TOPDIR)/rules.mk',
  '+include $(INCLUDE_DIR)/kernel.mk',
  '+',
  '+PKG_NAME:=tplink-ledbar',
  release,
  '+PKG_LICENSE:=GPL-2.0-only',
  '+PKG_LICENSE_FILES:=',
  ...(maintainer ? ['+PKG_MAINTAINER:=John Doe <john@doe.com>'] : []),
  '+',
  '+include $(INCLUDE_DIR)/package.mk',
  '+',
  '+define KernelPackage/leds-tplink-ledbar',
  '+  SUBMENU:=LED modules',
  '+  TITLE:=TP-Link Archer BE550 LED bar support',
  '+  FILES:=$(PKG_BUILD_DIR)/leds-tplink-ledbar.ko',
  '+endef',
  '+',
  '+$(eval $(call KernelPackage,leds-tplink-ledbar))'
];

// The one-line kbuild file the kernel builds the module from.
const kbuild = (path, line) => [gitAdded(path), '@@ -0,0 +1 @@', `+${line}`];

const LEDBAR = 'package/kernel/tplink-ledbar';

describe('a new kernel package with a kbuild src/Makefile', () => {
  test('reads only the package recipe as a new package', () => {
    const state = existingPackage();
    const patch = diff(kmodRecipe(LEDBAR), kbuild(`${LEDBAR}/src/Makefile`, 'obj-m := leds-tplink-ledbar.o'));
    const res = validate('tplink-ledbar: add LED bar driver', patch, state);
    assertNoErrors(res);
    assert.strictEqual(state.isNewPackage, true);
    assert.deepStrictEqual(collectPackageMakefiles(patch, 'added'), [`${LEDBAR}/Makefile`]);
  });

  // Guard: the recipe beside it is still checked in full.
  test('still reports the recipe\'s own missing metadata and spacing', () => {
    const patch = diff(
      kmodRecipe(LEDBAR, { maintainer: false, release: '+PKG_RELEASE:= 1' }),
      kbuild(`${LEDBAR}/src/Makefile`, 'obj-m := leds-tplink-ledbar.o')
    );
    const res = validate('tplink-ledbar: add LED bar driver', patch);
    assertErrorIncludes(res, "missing the mandatory parameter: 'PKG_MAINTAINER'");
    assertErrorIncludes(res, "'PKG_RELEASE:= 1' has a space after ':='");
    assertNoErrorIncludes(res, 'obj-m');
    assertNoErrorIncludes(res, 'src/Makefile');
  });
});

describe('gpio-button-hotplug\'s src/Makefile', () => {
  const SRC = 'package/kernel/gpio-button-hotplug/src/Makefile';

  test('adding it alone adds no package', () => {
    const state = existingPackage();
    const patch = diff(kbuild(SRC, 'obj-m += gpio-button-hotplug.o'));
    const res = validate('gpio-button-hotplug: build from src/', patch, state);
    assert.strictEqual(state.isNewPackage, false);
    assertNoErrorIncludes(res, 'mandatory parameter');
    assert.deepStrictEqual(collectPackageMakefiles(patch, 'added'), []);
  });

  test('removing it alone drops no package', () => {
    const state = existingPackage();
    const patch = diff(gitRemoved(SRC), '@@ -1 +0,0 @@', '-obj-m += gpio-button-hotplug.o');
    validate('gpio-button-hotplug: drop src/Makefile', patch, state);
    assert.strictEqual(state.isDroppedPackage, false);
    assert.deepStrictEqual(collectPackageMakefiles(patch, 'removed'), []);
  });

  test('a change to it is not held to OpenWrt\'s assignment style', () => {
    const res = validate('gpio-button-hotplug: use :=', diff(
      gitModified(SRC),
      '@@ -1 +1 @@',
      '-obj-m += gpio-button-hotplug.o',
      '+obj-m := gpio-button-hotplug.o'
    ));
    assertNoErrorIncludes(res, "space after ':='");
  });
});

// package/network/services/<name>/src/Makefile: the path alone does not say
// where the package root is, so an added file's content decides.
describe('a Makefile nested in a layout the path does not settle', () => {
  const EAD_SRC = 'package/network/services/ead/src/Makefile';

  test('added without rules.mk, it is not a package recipe', () => {
    const state = existingPackage();
    const patch = diff(
      gitAdded(EAD_SRC),
      '@@ -0,0 +1,4 @@',
      '+CC       = gcc',
      '+CPPFLAGS := -I. -Itinysrp',
      '+',
      '+all: ead ead-client'
    );
    const res = validate('ead: build with its own Makefile', patch, state);
    assert.strictEqual(state.isNewPackage, false);
    assertNoErrorIncludes(res, 'mandatory parameter');
    assertNoErrorIncludes(res, "space after ':='");
    assert.deepStrictEqual(collectPackageMakefiles(patch, 'added'), []);
  });

  // Guard: rules.mk makes it a recipe, wherever it sits.
  test('added with rules.mk, it is checked as a package recipe', () => {
    const state = existingPackage();
    const res = validate('ead: add helper package', diff(
      gitAdded(EAD_SRC),
      '@@ -0,0 +1,3 @@',
      '+include $(TOPDIR)/rules.mk',
      '+PKG_NAME:=ead-helper',
      '+include $(INCLUDE_DIR)/package.mk'
    ), state);
    assert.strictEqual(state.isNewPackage, true);
    assertErrorIncludes(res, "missing the mandatory parameter: 'PKG_MAINTAINER'");
  });

  test('does not borrow the rules.mk include of the recipe added beside it', () => {
    const dir = 'package/network/services/foo';
    const patch = diff(
      gitAdded(`${dir}/Makefile`),
      '@@ -0,0 +1,2 @@',
      '+include $(TOPDIR)/rules.mk',
      '+include $(INCLUDE_DIR)/package.mk',
      kbuild(`${dir}/src/Makefile`, 'obj-m := foo.o')
    );
    assert.deepStrictEqual(collectPackageMakefiles(patch, 'added'), [`${dir}/Makefile`]);
  });

  test('removed without rules.mk, it drops no package', () => {
    const state = existingPackage();
    const patch = diff(gitRemoved('modules/luci-base/src/Makefile'), '@@ -1,2 +0,0 @@', '-%.o: %.c', '-\t$(CC) -c -o $@ $<');
    validate('luci-base: drop src/Makefile', patch, state, 'openwrt/luci');
    assert.strictEqual(state.isDroppedPackage, false);
  });
});

// Guards: a recipe in each layout the path alone does not settle is still
// checked, added (content decides) and changed (content unknown).
describe('package recipes in layouts the path does not settle', () => {
  for (const { layout, path, repo, include } of [
    { layout: 'a luci application', path: 'applications/luci-app-foo/Makefile', repo: 'openwrt/luci', include: '+include ../../luci.mk' },
    { layout: 'a routing feed top-level package', path: 'newroute/Makefile', repo: 'openwrt/routing', include: '+include $(INCLUDE_DIR)/package.mk' },
    { layout: 'package/network/services/<name>', path: 'package/network/services/foo/Makefile', repo: 'openwrt/openwrt', include: '+include $(INCLUDE_DIR)/package.mk' }
  ]) {
    test(`${layout}: added, it is a new package and its metadata and style are checked`, () => {
      const state = existingPackage();
      const patch = diff(
        gitAdded(path),
        '@@ -0,0 +1,4 @@',
        '+include $(TOPDIR)/rules.mk',
        '+PKG_NAME:=foo',
        '+PKG_RELEASE:= 1',
        include
      );
      const res = validate('foo: add package', patch, state, repo);
      assert.strictEqual(state.isNewPackage, true);
      assertErrorIncludes(res, "missing the mandatory parameter: 'PKG_LICENSE'");
      assertErrorIncludes(res, "'PKG_RELEASE:= 1' has a space after ':='");
      assert.deepStrictEqual(collectPackageMakefiles(patch, 'added'), [path]);
    });

    test(`${layout}: changed, its style is still checked`, () => {
      const res = validate('foo: bump release', diff(
        gitModified(path),
        '@@ -3 +3 @@',
        '-PKG_RELEASE:=1',
        '+PKG_RELEASE:= 2'
      ), existingPackage(), repo);
      assertErrorIncludes(res, "'PKG_RELEASE:= 2' has a space after ':='");
    });

    test(`${layout}: removed, it is a dropped package`, () => {
      const state = existingPackage();
      const patch = diff(gitRemoved(path), '@@ -1,2 +0,0 @@', '-include $(TOPDIR)/rules.mk', `-${include.slice(1)}`);
      validate('foo: drop package', patch, state, repo);
      assert.strictEqual(state.isDroppedPackage, true);
    });
  }
});

describe('isPackageRecipeMakefile', () => {
  const isRecipe = (...args) => validators.isPackageRecipeMakefile(...args);
  const addedWith = (path, ...lines) => diff(gitAdded(path), '@@ -0,0 +1 @@', ...lines);

  test('a recipe at its own package root, also written ./', () => {
    assert.strictEqual(isRecipe('package/kernel/foo/Makefile', diff(modified('package/kernel/foo/Makefile'))), true);
    assert.strictEqual(isRecipe('./net/foo/Makefile', diff(modified('./net/foo/Makefile'))), true);
  });

  test('a Makefile below a known package root is not one, added or changed', () => {
    const path = 'utils/collectd/src/Makefile';
    assert.strictEqual(isRecipe(path, addedWith(path, '+include $(TOPDIR)/rules.mk')), false);
    assert.strictEqual(isRecipe(path, diff(modified(path))), false);
  });

  test('accepts -include and ${TOPDIR} for rules.mk', () => {
    const path = 'applications/luci-app-foo/Makefile';
    assert.strictEqual(isRecipe(path, addedWith(path, '+-include $(TOPDIR)/rules.mk')), true);
    assert.strictEqual(isRecipe(path, addedWith(path, '+include ${TOPDIR}/rules.mk')), true);
    assert.strictEqual(isRecipe(path, addedWith(path, '+include $(TOPDIR)/rules.mk.orig')), false);
  });

  test('takes added or removed from the diff header, not from a content line', () => {
    const path = 'modules/luci-base/src/Makefile';
    // A removed line '-- /dev/null' reads '--- /dev/null'; the file is changed,
    // not added, so it is kept as a recipe rather than judged on a fragment.
    assert.strictEqual(isRecipe(path, diff(modified(path), '@@ -1,2 +1 @@', '--- /dev/null', ' all:')), true);
  });

  test('a Makefile deeper than any package root is decided like an unknown layout', () => {
    const path = 'a/b/c/d/e/f/g/h/Makefile';
    assert.strictEqual(isRecipe(path, diff(modified(path))), true);
    assert.strictEqual(isRecipe(path, addedWith(path, '+obj-m := x.o')), false);
    assert.strictEqual(isRecipe(path, addedWith(path, '+include $(TOPDIR)/rules.mk')), true);
  });

  test('keeps the build infrastructure exclusions', () => {
    for (const path of ['Makefile', 'target/linux/foo/Makefile', 'tools/foo/Makefile', 'toolchain/foo/Makefile']) {
      assert.strictEqual(isRecipe(path, addedWith(path, '+include $(TOPDIR)/rules.mk')), false, path);
    }
  });
});

describe('isNestedMakefile', () => {
  const isNested = (...args) => validators.isNestedMakefile(...args);
  const addedWith = (path, ...lines) => diff(gitAdded(path), '@@ -0,0 +1 @@', ...lines);

  test('a Makefile below a known package root is nested, added or changed', () => {
    const path = 'package/kernel/foo/src/Makefile';
    assert.strictEqual(isNested(path, addedWith(path, '+obj-m := foo.o')), true);
    assert.strictEqual(isNested(path, diff(modified(path))), true);
  });

  test('the top-level Makefile and hidden paths are not nested, even added without rules.mk', () => {
    for (const path of ['Makefile', '.github/foo/Makefile']) {
      assert.strictEqual(isNested(path, addedWith(path, '+all:')), false, path);
    }
  });

  test('build infrastructure is not nested, added with or without rules.mk or changed', () => {
    for (const [path, include] of [
      ['tools/foo/Makefile', '+include $(INCLUDE_DIR)/host-build.mk'],
      ['toolchain/foo/Makefile', '+include ../common.mk'],
      ['target/linux/foo/Makefile', '+include $(INCLUDE_DIR)/target.mk'],
      ['target/linux/foo/image/Makefile', '+include $(INCLUDE_DIR)/image.mk'],
      ['tools/net/foo/src/Makefile', '+all:']
    ]) {
      assert.strictEqual(isNested(path, addedWith(path, '+include $(TOPDIR)/rules.mk')), false, path);
      assert.strictEqual(isNested(path, addedWith(path, include)), false, path);
      assert.strictEqual(isNested(path, diff(gitRemoved(path), '@@ -1 +0,0 @@', `-${include.slice(1)}`)), false, path);
      assert.strictEqual(isNested(path, diff(modified(path))), false, path);
    }
  });
});

// The style checks read every Makefile but the nested ones: build
// infrastructure follows OpenWrt's assignment style like a package does.
describe('build infrastructure Makefiles keep their style checks', () => {
  for (const path of ['tools/foo/Makefile', 'toolchain/foo/Makefile', 'target/linux/foo/Makefile', 'target/linux/foo/image/Makefile', 'Makefile']) {
    test(`a space after ':=' in a change to ${path} is reported`, () => {
      const res = validate('foo: bump release', diff(
        gitModified(path),
        '@@ -3 +3 @@',
        '-PKG_RELEASE:=1',
        '+PKG_RELEASE:= 2'
      ));
      assertErrorIncludes(res, "'PKG_RELEASE:= 2' has a space after ':='");
    });
  }

  test('an added tools/ recipe is style-checked but not a new package', () => {
    const state = existingPackage();
    const res = validate('tools/foo: add host tool', diff(
      gitAdded('tools/foo/Makefile'),
      '@@ -0,0 +1,6 @@',
      '+include $(TOPDIR)/rules.mk',
      '+PKG_NAME:=foo',
      '+PKG_RELEASE = 1',
      '+PKG_SOURCE_URL:= https://example.org/',
      '+include $(INCLUDE_DIR)/host-build.mk',
      '+$(eval $(call HostBuild,$(PKG_NAME)))'
    ), state);
    assert.strictEqual(state.isNewPackage, false);
    assertErrorIncludes(res, "'PKG_RELEASE = 1' uses '=' instead of ':='");
    assertErrorIncludes(res, "'PKG_SOURCE_URL:= https://example.org/' has a space after ':='");
    assertErrorIncludes(res, "'$(eval $(call HostBuild,$(PKG_NAME)))' reuses PKG_NAME");
    assertNoErrorIncludes(res, 'mandatory parameter');
  });

  // toolchain/ recipes include rules.mk through ../common.mk.
  test('an added toolchain/ Makefile without rules.mk is still style-checked', () => {
    const state = existingPackage();
    const res = validate('toolchain/foo: add', diff(
      gitAdded('toolchain/foo/Makefile'),
      '@@ -0,0 +1,2 @@',
      '+include ../common.mk',
      '+PKG_RELEASE:= 1'
    ), state);
    assert.strictEqual(state.isNewPackage, false);
    assertErrorIncludes(res, "'PKG_RELEASE:= 1' has a space after ':='");
  });

  test('an added top-level Makefile without rules.mk is still style-checked', () => {
    const res = validate('build: add a target', diff(gitAdded('Makefile'), '@@ -0,0 +1 @@', '+TOPDIR:= $(CURDIR)'));
    assertErrorIncludes(res, "'TOPDIR:= $(CURDIR)' has a space after ':='");
  });

  // The other side: a nested Makefile is still left out.
  test('a change to a package\'s src/Makefile is not', () => {
    const res = validate('foo: use :=', diff(
      gitModified('package/utils/foo/src/Makefile'),
      '@@ -1 +1,2 @@',
      '-CFLAGS = -O2',
      '+CFLAGS := -O2',
      '+PKG_NAME = foo'
    ));
    assertNoErrorIncludes(res, "space after ':='");
    assertNoErrorIncludes(res, "instead of ':='");
  });
});
