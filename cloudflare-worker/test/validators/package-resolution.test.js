import { describe, test } from 'node:test';
import assert from 'node:assert';
import { findPkgRoot } from '../../src/validators.js';

describe('findPkgRoot', () => {
  test('ignores category-level Makefiles and non-package paths but parses package paths correctly', async () => {
    const CASES = [
      // Category level Makefiles should be ignored (return null)
      ['package/utils/Makefile', null],
      ['utils/Makefile', null],
      ['package/Makefile', null],
      ['Makefile', null],

      // Standard package directories
      ['package/utils/bash/Makefile', 'package/utils/bash'],
      ['package/utils/bash/src/main.c', 'package/utils/bash'],
      ['package/utils/bash/patches/001-fix.patch', 'package/utils/bash'],

      // Category-less package layout
      ['package/iozone/Makefile', 'package/iozone'],
      ['package/iozone/files/iozone.init', 'package/iozone'],

      // Normal feed layout
      ['utils/bash/Makefile', 'utils/bash'],

      // Deeply nested feed layouts (luci/libs/<pkg>)
      ['luci/libs/luci-lib-uqr/Makefile', 'luci/libs/luci-lib-uqr'],
      ['luci/libs/luci-lib-uqr/patches/001-fix.patch', 'luci/libs/luci-lib-uqr'],

      // Nested python, perl, php, ruby packages under lang/
      ['lang/python/python-selinux/Makefile', 'lang/python/python-selinux'],
      ['lang/python/python-selinux/patches/001-fix.patch', 'lang/python/python-selinux'],
      ['lang/python/python-selinux/src/subfolder/file.c', 'lang/python/python-selinux'],
      ['package/lang/python/python-selinux/Makefile', 'package/lang/python/python-selinux'],
      ['lang/python/Makefile', 'lang/python'],

      ['lang/perl/perl-libxml/Makefile', 'lang/perl/perl-libxml'],
      ['lang/php/php8-pecl-redis/Makefile', 'lang/php/php8-pecl-redis'],
      ['lang/ruby/ruby-sass-listen/Makefile', 'lang/ruby/ruby-sass-listen'],
      ['lang/lua/lua-foo/Makefile', 'lang/lua/lua-foo'],
      ['lang/lua/lua-foo/patches/001-fix.patch', 'lang/lua/lua-foo'],
      ['package/lang/lua/lua-foo/Makefile', 'package/lang/lua/lua-foo'],

      // lang/golang is a group like lang/python: its packages sit one level
      // deeper (golang, golang-bootstrap, golang1.26), and there is no Makefile
      // in the group directory itself.
      ['lang/golang/golang1.26/Makefile', 'lang/golang/golang1.26'],
      ['lang/golang/golang/patches/001-fix.patch', 'lang/golang/golang'],

      // Hidden directories and special folders
      ['.github/workflows/check.yml', null],
    ];
    for (const [path, expected] of CASES) {
      assert.strictEqual(await findPkgRoot(path, null), expected, `findPkgRoot(${JSON.stringify(path)}, null)`);
    }
  });

  test('resolves uncommon package category layout via Makefile fallback', async () => {
    const fetchFn = async (path) => {
      if (path === 'package/security/openssl/Makefile') {
        return 'PKG_NAME:=openssl\n';
      }
      return null;
    };

    assert.strictEqual(
      await findPkgRoot('package/security/openssl/files/openssl.conf', fetchFn, {}),
      'package/security/openssl'
    );
  });
});

describe('findPkgRoot resolves every layout the bot meets', () => {
  // Every path below was taken from a real checkout of openwrt/openwrt or one
  // of its feeds. The fixture answers the Makefile probe the way the tree
  // would, because production always resolves through a fetch - the no-fetch
  // path is a unit-test convenience the handler never takes.
  const PKG_ROOTS = new Set([
    'package/base-files', 'package/utils/busybox', 'package/utils/ucode',
    'package/network/config/firewall4', 'package/libs/xcrypt/libxcrypt',
    'utils/htop', 'utils/ucode', 'net/aardvark-dns', 'lang/python/Flask',
    'applications/luci-app-firewall', 'modules/luci-base', 'themes/luci-theme-bootstrap',
    'protocols/luci-proto-wireguard', 'libs/luci-lib-uqr',
    'babeld', 'node-serialport', 'frameworks/gstreamer1', 'games/prboom',
    'gui/foris', 'hardware/turris-version',
    'libs/protobuf/protobuf-compat', 'utils/bigclown/bigclown-gateway',
    'lang/golang/golang1.26', 'lang/golang/golang',
  ]);
  const LUCI_ROOTS = new Set(['applications/luci-app-firewall', 'modules/luci-base',
    'themes/luci-theme-bootstrap', 'protocols/luci-proto-wireguard', 'libs/luci-lib-uqr']);
  // Packages whose Makefile has no PKG_NAME of its own: a shared helper
  // supplies it, or PKG_DISTNAME names the source instead.
  const HELPER_ROOTS = {
    'package/boot/uboot-mvebu': 'include $(TOPDIR)/rules.mk\ninclude $(INCLUDE_DIR)/kernel.mk\n\nPKG_VERSION:=2026.07\n\ninclude $(INCLUDE_DIR)/u-boot.mk\ninclude $(INCLUDE_DIR)/package.mk\n',
    'package/boot/arm-trusted-firmware-airoha': 'include $(TOPDIR)/rules.mk\n\nPKG_VERSION:=2025.07\n\ninclude $(INCLUDE_DIR)/trusted-firmware-a.mk\ninclude $(INCLUDE_DIR)/package.mk\n',
    'package/boot/optee-os-stm32': 'include $(TOPDIR)/rules.mk\ninclude $(INCLUDE_DIR)/kernel.mk\n\nPKG_VERSION:=4.7.0\n\ninclude $(INCLUDE_DIR)/optee-os.mk\ninclude $(INCLUDE_DIR)/package.mk\n',
    'package/boot/uboot-tools': 'include $(TOPDIR)/rules.mk\n\nPKG_DISTNAME:=u-boot\nPKG_VERSION:=2026.07\nPKG_RELEASE:=2\n\ninclude $(INCLUDE_DIR)/package.mk\n',
  };
  const fetchFileContent = async (path) => {
    if (!path.endsWith('/Makefile')) return null;
    const dir = path.slice(0, -'/Makefile'.length);
    if (HELPER_ROOTS[dir]) return HELPER_ROOTS[dir];
    if (!PKG_ROOTS.has(dir)) return null;
    return LUCI_ROOTS.has(dir)
      ? 'include $(TOPDIR)/rules.mk\nLUCI_TITLE:=x\ninclude ../../luci.mk\n'
      : `PKG_NAME:=${dir.split('/').pop()}\nPKG_RELEASE:=1\n`;
  };

  const CASES = [
    ['core 3-level',                  'package/utils/busybox/Makefile',                    'package/utils/busybox'],
    ['core 3-level patches/',         'package/utils/busybox/patches/001-fix.patch',       'package/utils/busybox'],
    ['core 3-level files/',           'package/utils/busybox/files/busybox.init',          'package/utils/busybox'],
    ['core 3-level src/',             'package/utils/busybox/src/main.c',                  'package/utils/busybox'],
    ['core 3-level nested src/',      'package/utils/busybox/src/a/b/c.c',                 'package/utils/busybox'],
    ['core 3-level unlisted subdir',  'package/utils/busybox/tests/custom/00.t',           'package/utils/busybox'],
    ['core versioned patches-X.Y',    'package/utils/busybox/patches-1.36/001.patch',      'package/utils/busybox'],
    ['core category-less',            'package/base-files/Makefile',                       'package/base-files'],
    ['core category-less files/',     'package/base-files/files/etc/banner',               'package/base-files'],
    ['core 4-level',                  'package/network/config/firewall4/Makefile',         'package/network/config/firewall4'],
    ['core 4-level patches/',         'package/libs/xcrypt/libxcrypt/patches/001.patch',   'package/libs/xcrypt/libxcrypt'],
    // `ucode` also names a LuCI payload directory; directly under a category
    // it is the ucode interpreter and used to resolve to nothing at all.
    ['payload-named package',         'package/utils/ucode/Makefile',                      'package/utils/ucode'],
    ['payload-named package patches/','package/utils/ucode/patches/100-pad.patch',         'package/utils/ucode'],
    ['payload-named package subdir',  'package/utils/ucode/tests/custom/00_lib.t',         'package/utils/ucode'],
    ['payload-named package in a feed','utils/ucode/Makefile',                             'utils/ucode'],
    ['feed 2-level',                  'utils/htop/Makefile',                               'utils/htop'],
    ['feed 2-level patches/',         'utils/htop/patches/010-fix.patch',                  'utils/htop'],
    ['feed 2-level files/',           'net/aardvark-dns/files/aardvark.init',              'net/aardvark-dns'],
    ['feed nested lang',              'lang/python/Flask/Makefile',                        'lang/python/Flask'],
    ['feed nested lang patches/',     'lang/python/Flask/patches/001.patch',               'lang/python/Flask'],
    ['feed lang/golang group',        'lang/golang/golang1.26/Makefile',                   'lang/golang/golang1.26'],
    ['feed lang/golang patches/',     'lang/golang/golang/patches/001.patch',              'lang/golang/golang'],
    // <category>/<group>/<pkgname>: the fast path used to answer the group,
    // a directory with no Makefile in it.
    ['feed 3-level group',            'libs/protobuf/protobuf-compat/Makefile',            'libs/protobuf/protobuf-compat'],
    ['feed 3-level group patches/',   'libs/protobuf/protobuf-compat/patches/010-rpath.patch', 'libs/protobuf/protobuf-compat'],
    ['feed 3-level group files/',     'utils/bigclown/bigclown-gateway/files/init',        'utils/bigclown/bigclown-gateway'],
    // PKG_NAME supplied by a shared helper, or PKG_DISTNAME in its place. Only
    // a path deep enough to need the probe exercises that.
    ['u-boot package subdir',         'package/boot/uboot-mvebu/scripts/x.sh',             'package/boot/uboot-mvebu'],
    ['ATF package subdir',            'package/boot/arm-trusted-firmware-airoha/scripts/airoha_pack_bl2.sh', 'package/boot/arm-trusted-firmware-airoha'],
    ['optee-os package subdir',       'package/boot/optee-os-stm32/scripts/x',             'package/boot/optee-os-stm32'],
    ['uboot-tools nested files/',     'package/boot/uboot-tools/uboot-envtools/files/mvebu_cortexa9', 'package/boot/uboot-tools'],
    ['luci application',              'applications/luci-app-firewall/Makefile',           'applications/luci-app-firewall'],
    ['luci root/ payload',            'applications/luci-app-firewall/root/etc/uci-defaults/x', 'applications/luci-app-firewall'],
    ['luci htdocs/ payload',          'applications/luci-app-firewall/htdocs/luci-static/resources/view/firewall/rules.js', 'applications/luci-app-firewall'],
    ['luci luasrc/ payload',          'applications/luci-app-firewall/luasrc/controller/firewall.lua', 'applications/luci-app-firewall'],
    ['luci po/ payload',              'applications/luci-app-firewall/po/cs/firewall.po',  'applications/luci-app-firewall'],
    ['luci ucode/ payload',           'modules/luci-base/ucode/dispatcher.uc',             'modules/luci-base'],
    ['luci module',                   'modules/luci-base/Makefile',                        'modules/luci-base'],
    ['luci theme',                    'themes/luci-theme-bootstrap/Makefile',              'themes/luci-theme-bootstrap'],
    ['luci protocol',                 'protocols/luci-proto-wireguard/Makefile',           'protocols/luci-proto-wireguard'],
    ['luci lib under a category name','libs/luci-lib-uqr/Makefile',                        'libs/luci-lib-uqr'],
    ['root feed Makefile',            'babeld/Makefile',                                   'babeld'],
    ['root feed patches/',            'babeld/patches/001.patch',                          'babeld'],
    ['root feed files/',              'node-serialport/files/etc/config/x',                'node-serialport'],
    ['video feed frameworks',         'frameworks/gstreamer1/Makefile',                    'frameworks/gstreamer1'],
    ['video feed games',              'games/prboom/patches/001.patch',                    'games/prboom'],
    ['unknown category',              'gui/foris/Makefile',                                'gui/foris'],
    ['unknown category files/',       'hardware/turris-version/files/x',                   'hardware/turris-version'],
    ['category Makefile',             'package/utils/Makefile',                            null],
    ['feed category Makefile',        'utils/Makefile',                                    null],
    ['top-level Makefile',            'package/Makefile',                                  null],
    ['repository root Makefile',      'Makefile',                                          null],
    ['hidden directory',              '.github/workflows/check.yml',                       null],
    ['build script',                  'scripts/dl_cleanup.py',                             null],
    ['kernel patch',                  'target/linux/mpc85xx/patches-6.12/001.patch',       null],
    ['include fragment',              'include/package.mk',                                null],
  ];
  for (const [layout, path, expected] of CASES) {
    test(`${layout}: ${path}`, async () => {
      assert.strictEqual(await findPkgRoot(path, fetchFileContent, {}), expected);
    });
  }

  test('answers the plain depths without a probe, and lang/golang with them', async () => {
    // Every probe is a subrequest on the Worker. The two-level feed layout
    // and the three-level core layout are answered from the path alone; so
    // is a lang/<group>/<pkg> layout, golang included.
    for (const path of ['utils/htop/Makefile', 'package/utils/busybox/patches/001-fix.patch',
                        'lang/python/Flask/Makefile', 'lang/golang/golang1.26/Makefile']) {
      let probes = 0;
      const counting = async (p) => { probes++; return fetchFileContent(p); };
      await findPkgRoot(path, counting, {});
      assert.strictEqual(probes, 0, `${path} probed ${probes} time(s)`);
    }
  });
});

describe('findPkgRoot for feeds without category directories', () => {
  const routingFetch = async (path) => {
    if (path === 'babeld/Makefile' || path === 'batman-adv/Makefile') {
      return 'PKG_NAME:=' + path.split('/')[0] + '\n';
    }
    return null;
  };

  test('resolves a routing feed package from its Makefile', async () => {
    assert.strictEqual(await findPkgRoot('babeld/Makefile', routingFetch, {}), 'babeld');
  });

  test('resolves a routing feed package from a nested file', async () => {
    assert.strictEqual(await findPkgRoot('batman-adv/files/etc/config/batman-adv', routingFetch, {}), 'batman-adv');
    assert.strictEqual(await findPkgRoot('babeld/patches/001-fix.patch', routingFetch, {}), 'babeld');
  });

  test('returns null for root directories that are not packages', async () => {
    assert.strictEqual(await findPkgRoot('scripts/dl_cleanup.py', async () => null, {}), null);
  });

  test('never guesses single-segment roots in dry mode (no fetch available)', async () => {
    assert.strictEqual(await findPkgRoot('scripts/dl_cleanup.py', null), null);
    assert.strictEqual(await findPkgRoot('babeld/Makefile', null), null);
    assert.strictEqual(await findPkgRoot('package/utils/bash/Makefile', null), 'package/utils/bash');
  });

  test('resolves video feed categories without probing', async () => {
    const noFetch = async () => { throw new Error('should not probe fast-path categories'); };
    assert.strictEqual(await findPkgRoot('frameworks/gstreamer1/Makefile', noFetch, {}), 'frameworks/gstreamer1');
    assert.strictEqual(await findPkgRoot('games/prboom/Makefile', noFetch, {}), 'games/prboom');
  });
});
